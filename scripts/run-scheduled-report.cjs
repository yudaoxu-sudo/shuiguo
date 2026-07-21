const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { withLock } = require("./runtime-lock.cjs");
const { loadEnv, sendDingTalkMarkdown } = require("./send-dingtalk.cjs");

const statePath = path.resolve("output/scheduled-report-state.json");

function todayText() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
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

function appendTail(current, chunk, limit = 4000) {
  return `${current}${chunk}`.slice(-limit);
}

function runReport() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/daily-report.cjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        REPORT_FAILURE_ALERTS: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let outputTail = "";
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
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, outputTail }));
  });
}

async function main() {
  loadEnv();
  const date = todayText();

  await withLock("scheduled-report", {
    waitMs: 5000,
    staleMs: 20 * 60 * 1000,
  }, async () => {
    const previous = readJson(statePath);
    if (previous?.date === date && previous.status === "sent") {
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

    const result = await runReport();
    if (result.code === 0) {
      writeJson(statePath, {
        date,
        status: "sent",
        attempts,
        sentAt: new Date().toISOString(),
      });
      console.log(`scheduled-report-sent: ${date} attempt ${attempts}`);
      return;
    }

    const message = result.outputTail.trim().slice(-1200);
    writeJson(statePath, {
      date,
      status: "failed",
      attempts,
      lastFailedAt: new Date().toISOString(),
      exitCode: result.code,
      message,
    });

    if (process.env.SCHEDULED_REPORT_FINAL_ATTEMPT === "1") {
      await sendDingTalkMarkdown(
        "水果店月度报表最终失败",
        `### 水果店月度报表最终失败\n\n今晚已自动补跑 ${attempts} 次，仍未成功。\n\n${message}`,
        { alert: true },
      );
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
