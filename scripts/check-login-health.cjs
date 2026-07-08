const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { loadEnv, sendDingTalkMarkdown } = require("./send-dingtalk.cjs");
const { withLock } = require("./runtime-lock.cjs");

const statePath = path.resolve("output/login-health-state.json");
const repairRequestPath = path.resolve("output/zhimadi-login-repair-request.json");
const alertCooldownMs = Number(process.env.LOGIN_ALERT_COOLDOWN_MS || 6 * 60 * 60 * 1000);

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

function chromeExecutablePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  return undefined;
}

async function zhimadiOk(page) {
  await page.goto(process.env.ZHIMADI_URL || "https://aems.zhimadi.cn/index.php?s=/Index/index.html", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(1500);
  return (await page.locator("input[type='password']").count()) === 0;
}

async function lemengOk(page) {
  await page.goto("https://sharec.lemengcloud.com/report/home/data-index", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(3000);
  return (await page.locator("input[type='password']").count()) === 0;
}

async function main() {
  loadEnv();

  const now = Date.now();
  const userDataDir = path.resolve(process.env.USER_DATA_DIR || "output/browser-profile");
  fs.mkdirSync(userDataDir, { recursive: true });

  const problems = [];
  await withLock("browser-profile", {
    waitMs: Number(process.env.BROWSER_LOCK_WAIT_MS || 10 * 60 * 1000),
    staleMs: Number(process.env.BROWSER_LOCK_STALE_MS || 30 * 60 * 1000),
  }, async () => {
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: process.env.HEADLESS === "true",
      executablePath: chromeExecutablePath(),
    });

    const page = context.pages()[0] || await context.newPage();
    try {
      if (!(await zhimadiOk(page))) problems.push("芝麻地登录态失效");
      if (!(await lemengOk(page))) problems.push("乐檬登录态失效");
    } finally {
      await context.close();
    }
  });

  if (problems.length === 0) {
    writeJson(statePath, {
      status: "ok",
      lastCheckAt: new Date(now).toISOString(),
    });
    console.log("login-ok");
    return;
  }

  const problemKey = problems.join(",");
  const zhimadiFailed = problems.some((problem) => problem.includes("芝麻地"));
  const alertProblems = problems.filter((problem) => !problem.includes("芝麻地"));

  if (zhimadiFailed) {
    writeJson(repairRequestPath, {
      requestedAt: new Date(now).toISOString(),
      reason: "login-healthcheck",
    });
  }

  let alerted = false;
  if (alertProblems.length > 0 && shouldAlert(now, alertProblems.join(","))) {
    await sendDingTalkMarkdown(
      "水果店登录态异常",
      `### 水果店登录态异常\n\n${alertProblems.map((problem) => `- ${problem}`).join("\n")}`,
      { alert: true },
    );
    alerted = true;
  }

  writeJson(statePath, {
    status: "failed",
    lastCheckAt: new Date(now).toISOString(),
    lastAlertAt: alerted ? new Date(now).toISOString() : readJson(statePath)?.lastAlertAt || null,
    lastProblemKey: problemKey,
    problems,
  });
  console.log(`login-failed: ${problemKey}`);
  process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
