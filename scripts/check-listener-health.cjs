const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { loadEnv, sendDingTalkMarkdown } = require("./send-dingtalk.cjs");

const heartbeatPath = path.resolve("output/listener-heartbeat.json");
const statePath = path.resolve("output/listener-health-state.json");
const defaultStaleMs = 180000;
const defaultAlertCooldownMs = 1800000;

function configuredDuration(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, data) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function acquireHealthClaim(
  filePath = statePath,
  {
    now = Date.now(),
    ttlMs = 5 * 60 * 1000,
    token = crypto.randomUUID(),
  } = {},
) {
  const claimPath = `${filePath}.claim`;
  fs.mkdirSync(path.dirname(claimPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = fs.openSync(claimPath, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({
        token,
        claimedAt: new Date(now).toISOString(),
        pid: process.pid,
      }));
      fs.closeSync(fd);
      fd = undefined;
      return {
        acquired: true,
        release() {
          const current = readJson(claimPath);
          if (current?.token === token) fs.rmSync(claimPath, { force: true });
        },
      };
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      if (error.code !== "EEXIST") throw error;

      const existing = readJson(claimPath);
      const claimedAt = Date.parse(existing?.claimedAt || "");
      const stale = !Number.isFinite(claimedAt)
        || (claimedAt <= now && now - claimedAt > ttlMs)
        || (claimedAt > now && claimedAt - now > ttlMs);
      if (!stale) {
        return { acquired: false, release() {} };
      }
      try {
        fs.rmSync(claimPath);
      } catch (removeError) {
        if (removeError.code !== "ENOENT") {
          return { acquired: false, release() {} };
        }
      }
    }
  }

  return { acquired: false, release() {} };
}

function shouldAlert(
  now,
  state = readJson(statePath),
  cooldownMs = configuredDuration(
    "LISTENER_ALERT_COOLDOWN_MS",
    defaultAlertCooldownMs,
  ),
) {
  const lastAttemptAt = state?.lastAlertAttemptAt || state?.lastAlertAt;
  if (!lastAttemptAt) return true;
  const attemptTs = Date.parse(lastAttemptAt);
  // 损坏或晚于当前时钟的时间戳不可信：宁可多发一次告警，也不能让压制永不解除
  if (!Number.isFinite(attemptTs) || attemptTs > now) return true;
  return now - attemptTs > cooldownMs;
}

function restartListenerService() {
  return new Promise((resolve) => {
    execFile("sudo", ["-n", "systemctl", "restart", "fruit-store-listener.service"], (error, stdout, stderr) => {
      resolve({
        ok: !error,
        message: (stderr || stdout || error?.message || "").trim(),
      });
    });
  });
}

async function checkListenerHealth(options = {}) {
  const {
    now = Date.now(),
    heartbeat = readJson(heartbeatPath),
    staleThresholdMs = configuredDuration("LISTENER_STALE_MS", defaultStaleMs),
    cooldownMs = configuredDuration(
      "LISTENER_ALERT_COOLDOWN_MS",
      defaultAlertCooldownMs,
    ),
    persist = (data) => writeJson(statePath, data),
    loadState = () => readJson(statePath),
    restart = restartListenerService,
    send = sendDingTalkMarkdown,
    log = console.log,
  } = options;
  const stateProvided = Object.prototype.hasOwnProperty.call(options, "state");
  const providedState = options.state;
  const lastSeen = heartbeat?.updatedAt ? Date.parse(heartbeat.updatedAt) : 0;
  const heartbeatIsPlausible = Number.isFinite(lastSeen)
    && lastSeen > 0
    && lastSeen <= now + staleThresholdMs;
  const ageMs = heartbeatIsPlausible ? Math.max(0, now - lastSeen) : Infinity;

  if (ageMs <= staleThresholdMs) {
    persist({
      status: "ok",
      lastCheckAt: new Date(now).toISOString(),
      lastHeartbeatAt: heartbeat.updatedAt,
    });
    log("listener-ok");
    return;
  }

  const claim = options.claim
    ? await options.claim()
    : stateProvided
      ? { acquired: true, release() {} }
      : acquireHealthClaim(statePath, { now });
  if (!claim.acquired) {
    log("listener-stale-claim-held");
    return;
  }

  try {
    const state = stateProvided ? providedState : loadState();
    if (!shouldAlert(now, state, cooldownMs)) {
      log("listener-stale-alert-suppressed");
      return;
    }

    const alertAttemptAt = new Date(now).toISOString();
    persist({
      status: "stale-alerting",
      lastCheckAt: alertAttemptAt,
      lastAlertAttemptAt: alertAttemptAt,
      lastAlertAt: state?.lastAlertAt || null,
      lastHeartbeatAt: heartbeat?.updatedAt || null,
    });

    const lastHeartbeatText = heartbeat?.updatedAt || "从未写入";
    const repair = await restart();
    const repairText = repair.ok ? "已自动重启监听服务。" : `自动重启失败：${repair.message || "未知错误"}`;

    await send(
      "水果店监听异常",
      `### 水果店监听异常\n\n监听心跳超时。\n\n最后心跳：${lastHeartbeatText}\n\n${repairText}`,
      { alert: true },
    );

    persist({
      status: "stale",
      lastCheckAt: alertAttemptAt,
      lastAlertAttemptAt: alertAttemptAt,
      lastAlertAt: alertAttemptAt,
      lastHeartbeatAt: heartbeat?.updatedAt || null,
      autoRestartOk: repair.ok,
    });
    log(repair.ok ? "listener-stale-restarted-alert-sent" : "listener-stale-restart-failed-alert-sent");
  } finally {
    claim.release();
  }
}

async function main() {
  loadEnv();
  await checkListenerHealth();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = {
  acquireHealthClaim,
  checkListenerHealth,
  readJson,
  shouldAlert,
  writeJson,
};
