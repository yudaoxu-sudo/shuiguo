const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { withLock } = require("./runtime-lock.cjs");
const { loadEnv, sendDingTalkMarkdown } = require("./send-dingtalk.cjs");
const {
  classifyReportFailure,
  deferZhimadiHealthFailure,
  markReportHealthOk,
} = require("./check-report-health.cjs");
const { extractHealthFailure } = require("./healthcheck-error.cjs");
const {
  assertCurrentReportTargetDate,
  createReportTargetDateGuard,
  resolveReportTargetDate,
  runGuardedAction,
  todayText,
} = require("./report-target-date.cjs");

const statePath = path.resolve("output/scheduled-report-state.json");

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function appendTail(current, chunk, limit = 4000) {
  return `${current}${chunk}`.slice(-limit);
}

function stopChildProcessGroup(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The child already exited.
    }
  }
}

function runReport(
  scriptPath = "scripts/daily-report.cjs",
  reportDate = todayText(),
  {
    timeoutMs = Number(process.env.SCHEDULED_REPORT_TIMEOUT_MS || 15 * 60 * 1000),
    killGraceMs = 5000,
  } = {},
) {
  const boundedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : 15 * 60 * 1000;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HEALTHCHECK_PREVIEW: "1",
        REPORT_FAILURE_ALERTS: "false",
        REPORT_MANAGED_BY_SCHEDULED: "1",
        REPORT_TARGET_DATE: reportDate,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let outputTail = "";
    let timedOut = false;
    let killTimer;
    const timeout = setTimeout(() => {
      timedOut = true;
      stopChildProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(() => {
        stopChildProcessGroup(child, "SIGKILL");
      }, killGraceMs);
    }, boundedTimeoutMs);
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      outputTail = appendTail(outputTail, text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      process.stderr.write(text);
      outputTail = appendTail(outputTail, text);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) {
        resolve({
          code: 1,
          outputTail: appendTail(
            outputTail,
            `\n定时报表子进程超时 ${Math.round(boundedTimeoutMs / 1000)} 秒`,
          ),
        });
      } else {
        resolve({ code: code ?? 1, outputTail });
      }
    });
  });
}

function scheduledZhimadiDeferral(message, loadRepairState) {
  const failure = classifyReportFailure(message);
  return deferZhimadiHealthFailure(
    { failure, message },
    loadRepairState,
  );
}

function scheduledLoginDeferral(result, message, loadRepairState) {
  if (Number(result?.code) === 2) {
    return { phase: "child-deferred-login-repair" };
  }
  return scheduledZhimadiDeferral(message, loadRepairState);
}

async function main() {
  loadEnv();
  const date = resolveReportTargetDate(process.env.REPORT_TARGET_DATE);
  const guardReportDate = createReportTargetDateGuard(date, {
    label: "正式定时报表",
  });

  await withLock("scheduled-report", {
    waitMs: 5000,
    staleMs: 20 * 60 * 1000,
  }, async () => {
    const previous = readJson(statePath);
    if (previous?.date === date && previous.status === "sent") {
      markReportHealthOk(previous.sentAt || new Date().toISOString());
      console.log(`scheduled-report-skip: ${date} already sent`);
      return;
    }

    const attempts = previous?.date === date ? Number(previous.attempts || 0) + 1 : 1;
    writeJson(statePath, {
      date,
      status: "running",
      attempts,
      startedAt: new Date().toISOString(),
    });

    const dualReportDate = String(process.env.DUAL_DOUYIN_REPORT_DATE || "");
    const scriptPath = dualReportDate === date
      ? "scripts/send-dual-douyin-report.cjs"
      : "scripts/daily-report.cjs";
    const result = await runGuardedAction(
      guardReportDate,
      "抓取前",
      () => runReport(scriptPath, date),
    );
    if (result.code === 0) {
      guardReportDate("成功状态写入前");
      const sentAt = new Date().toISOString();
      writeJson(statePath, {
        date,
        status: "sent",
        attempts,
        sentAt,
      });
      markReportHealthOk(sentAt);
      console.log(`scheduled-report-sent: ${date} attempt ${attempts}`);
      return;
    }

    const message = (
      extractHealthFailure(result.outputTail)
      || result.outputTail.trim()
    ).slice(-1200);
    const loginDeferral = scheduledLoginDeferral(result, message);
    writeJson(statePath, {
      date,
      status: loginDeferral ? "deferred-login-repair" : "failed",
      attempts,
      lastFailedAt: new Date().toISOString(),
      exitCode: result.code,
      message,
    });

    if (
      process.env.SCHEDULED_REPORT_FINAL_ATTEMPT === "1"
      && !loginDeferral
    ) {
      await sendDingTalkMarkdown(
        "水果店月度报表最终失败",
        `### 水果店月度报表最终失败\n\n今晚已自动补跑 ${attempts} 次，仍未成功。\n\n${message}`,
        { alert: true },
      );
    } else if (loginDeferral) {
      console.log("scheduled-report-login-repair-deferred");
    }

    process.exitCode = result.code;
  });
}

if (require.main === module) {
  main().catch(async (error) => {
    loadEnv();
    if (process.env.SCHEDULED_REPORT_FINAL_ATTEMPT === "1") {
      await sendDingTalkMarkdown(
        "水果店月度报表最终失败",
        `### 水果店月度报表最终失败\n\n${error.message || error}`,
        { alert: true },
      ).catch(() => {});
    }
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = {
  assertCurrentReportTargetDate,
  resolveReportTargetDate,
  runReport,
  scheduledLoginDeferral,
  scheduledZhimadiDeferral,
};
