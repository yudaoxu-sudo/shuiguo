const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { loadEnv, sendDingTalkMarkdown } = require("./send-dingtalk.cjs");

const statePath = path.resolve("output/report-health-state.json");
const alertCooldownMs = Number(process.env.REPORT_ALERT_COOLDOWN_MS || 60 * 60 * 1000);
const reportTimeoutMs = Number(process.env.REPORT_HEALTHCHECK_TIMEOUT_MS || 10 * 60 * 1000);

function todayText() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

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

function shouldAlert(now, problemKey) {
  const state = readJson(statePath);
  if (state?.lastProblemKey !== problemKey) return true;
  if (!state?.lastAlertAt) return true;
  return now - Date.parse(state.lastAlertAt) > alertCooldownMs;
}

function runReportPreview() {
  return new Promise((resolve, reject) => {
    const scriptPath = process.env.DUAL_DOUYIN_REPORT_DATE === todayText()
      ? "scripts/send-dual-douyin-report.cjs"
      : "scripts/daily-report.cjs";
    const child = spawn(process.execPath, [scriptPath], {
      cwd: process.cwd(),
      env: { ...process.env, NO_DINGTALK: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`报表预检超时 ${Math.round(reportTimeoutMs / 1000)} 秒`));
    }, reportTimeoutMs);

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else {
        const tail = output.split(/\r?\n/).slice(-20).join("\n");
        reject(new Error(`报表预检退出码 ${code}\n${tail}`));
      }
    });
  });
}

async function main() {
  loadEnv();
  const now = Date.now();

  try {
    await runReportPreview();
    writeJson(statePath, {
      status: "ok",
      lastCheckAt: new Date(now).toISOString(),
    });
    console.log("report-ok");
  } catch (error) {
    const message = String(error.message || error).slice(0, 1200);
    const problemKey = message.slice(0, 200);

    if (message.includes("芝麻地验证码已发送到钉钉")) {
      writeJson(statePath, {
        status: "waiting-login-captcha",
        lastCheckAt: new Date(now).toISOString(),
        message,
      });
      console.log("report-waiting-login-captcha");
      return;
    }

    if (shouldAlert(now, problemKey)) {
      await sendDingTalkMarkdown(
        "水果店报表预检失败",
        `### 水果店报表预检失败\n\n${message}`,
        { alert: true },
      );
    }

    writeJson(statePath, {
      status: "failed",
      lastCheckAt: new Date(now).toISOString(),
      lastAlertAt: new Date(now).toISOString(),
      lastProblemKey: problemKey,
      message,
    });
    console.log("report-failed");
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
