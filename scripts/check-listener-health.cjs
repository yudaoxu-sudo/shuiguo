const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { loadEnv, sendDingTalkMarkdown } = require("./send-dingtalk.cjs");

const heartbeatPath = path.resolve("output/listener-heartbeat.json");
const statePath = path.resolve("output/listener-health-state.json");
const staleMs = Number(process.env.LISTENER_STALE_MS || 180000);
const alertCooldownMs = Number(process.env.LISTENER_ALERT_COOLDOWN_MS || 1800000);

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function shouldAlert(now) {
  const state = readJson(statePath);
  if (!state?.lastAlertAt) return true;
  return now - Date.parse(state.lastAlertAt) > alertCooldownMs;
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

async function main() {
  loadEnv();

  const now = Date.now();
  const heartbeat = readJson(heartbeatPath);
  const lastSeen = heartbeat?.updatedAt ? Date.parse(heartbeat.updatedAt) : 0;
  const ageMs = lastSeen ? now - lastSeen : Infinity;

  if (ageMs <= staleMs) {
    writeJson(statePath, {
      status: "ok",
      lastCheckAt: new Date(now).toISOString(),
      lastHeartbeatAt: heartbeat.updatedAt,
    });
    console.log("listener-ok");
    return;
  }

  if (!shouldAlert(now)) {
    console.log("listener-stale-alert-suppressed");
    return;
  }

  const lastHeartbeatText = heartbeat?.updatedAt || "从未写入";
  const repair = await restartListenerService();
  const repairText = repair.ok ? "已自动重启监听服务。" : `自动重启失败：${repair.message || "未知错误"}`;

  await sendDingTalkMarkdown(
    "水果店监听异常",
    `### 水果店监听异常\n\n监听心跳超时。\n\n最后心跳：${lastHeartbeatText}\n\n${repairText}`,
    { alert: true },
  );

  writeJson(statePath, {
    status: "stale",
    lastCheckAt: new Date(now).toISOString(),
    lastAlertAt: new Date(now).toISOString(),
    lastHeartbeatAt: heartbeat?.updatedAt || null,
    autoRestartOk: repair.ok,
  });
  console.log(repair.ok ? "listener-stale-restarted-alert-sent" : "listener-stale-restart-failed-alert-sent");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
