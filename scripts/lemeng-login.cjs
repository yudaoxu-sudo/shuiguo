const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { loadEnv } = require("./send-dingtalk.cjs");
const { withLock } = require("./runtime-lock.cjs");

const defaultLemengUrl = "https://sharec.lemengcloud.com/pos/home";
const reportUrl = "https://sharec.lemengcloud.com/report/business/business-collection-report";
const loginHost = "account.lemengcloud.com";

// 乐檬会话过期时不会跳登录页，而是返回一个 500 错误页，上面既没有密码框
// 也没有日期控件。只看密码框会把这个页面误判成“已登录”。
const expiredMarkers = [
  "用户信息已过期",
  "请重新登录",
  "登录已失效",
  "登录状态已失效",
];

function isLemengSessionExpiredText(text) {
  const value = String(text || "");
  return expiredMarkers.some((marker) => value.includes(marker));
}

function isLemengLoginUrl(url) {
  return String(url || "").includes(loginHost);
}

function lemengCredentials(env = process.env) {
  const username = String(env.LEMENG_USERNAME || "").trim();
  const password = String(env.LEMENG_PASSWORD || "").trim();
  if (!username || !password) {
    throw new Error(
      "乐檬登录需要 .env 里的 LEMENG_USERNAME 和 LEMENG_PASSWORD，请先在服务器上填好再运行",
    );
  }
  return { username, password };
}

function chromeExecutablePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (fs.existsSync(macChrome)) return macChrome;
  return undefined;
}

async function pageText(page) {
  return page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
}

async function lemengReportReachable(page) {
  await page.goto(reportUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2000);
  if (isLemengLoginUrl(page.url())) return false;
  if (isLemengSessionExpiredText(await pageText(page))) return false;
  return page
    .locator('input[placeholder="开始日期"]:visible')
    .first()
    .waitFor({ state: "visible", timeout: 45000 })
    .then(() => true)
    .catch(() => false);
}

async function submitLemengLogin(page, { username, password }) {
  const passwordTab = page.getByText("密码登录", { exact: true }).first();
  if (await passwordTab.isVisible().catch(() => false)) {
    await passwordTab.click().catch(() => {});
    await page.waitForTimeout(500);
  }

  const phone = page.locator('input[placeholder="请输入手机号"]').first();
  await phone.waitFor({ state: "visible", timeout: 20000 });
  await phone.fill(username);

  const secret = page.locator('input[placeholder="请输入密码"], input#password').first();
  await secret.waitFor({ state: "visible", timeout: 20000 });
  await secret.fill(password);

  // 勾上“5天内自动登录”，减少会话过期频率。
  const keepSignedIn = page.locator('input[type="checkbox"]').first();
  if (await keepSignedIn.isVisible().catch(() => false)) {
    await keepSignedIn.check().catch(() => {});
  }

  const submit = page.locator("button").filter({ hasText: /^登\s*录$/ }).first();
  await submit.waitFor({ state: "visible", timeout: 20000 });
  await submit.click();
}

async function waitForLemengLoggedIn(page, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isLemengLoginUrl(page.url())) return;
    const text = await pageText(page);
    const failure = text.match(/(密码错误|账号|验证码|图形|滑块|frequency|频繁)[^\n]{0,40}/);
    if (failure && /密码错误|频繁|验证码|滑块/.test(failure[0])) {
      throw new Error(`乐檬登录被拒绝：${failure[0].replace(/\s+/g, " ").slice(0, 80)}`);
    }
    await page.waitForTimeout(1000);
  }
  throw new Error("乐檬提交登录后仍停留在登录页，可能需要人工处理（验证码或风控）");
}

async function loginLemeng() {
  loadEnv();
  const credentials = lemengCredentials();
  const userDataDir = path.resolve(process.env.USER_DATA_DIR || "output/browser-profile");
  fs.mkdirSync(userDataDir, { recursive: true });

  return withLock("browser-profile", {
    waitMs: Number(process.env.BROWSER_LOCK_WAIT_MS || 10 * 60 * 1000),
    staleMs: Number(process.env.BROWSER_LOCK_STALE_MS || 30 * 60 * 1000),
  }, async () => {
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: process.env.HEADLESS === "true",
      executablePath: chromeExecutablePath(),
    });
    const page = await context.newPage();
    try {
      if (await lemengReportReachable(page)) {
        console.log("lemeng-login: already-ok");
        return "already-ok";
      }

      await page.goto(process.env.LEMENG_URL || defaultLemengUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await page.waitForTimeout(3000);
      if (!isLemengLoginUrl(page.url())) {
        const expired = isLemengSessionExpiredText(await pageText(page));
        if (expired) {
          await page.goto(`https://${loginHost}/user/login`, {
            waitUntil: "domcontentloaded",
            timeout: 60000,
          });
          await page.waitForTimeout(2000);
        }
      }

      await submitLemengLogin(page, credentials);
      await waitForLemengLoggedIn(page);

      if (!(await lemengReportReachable(page))) {
        throw new Error("乐檬登录后仍读不到营业收款报表页面");
      }
      console.log("lemeng-login: ok");
      return "ok";
    } finally {
      await context.close().catch(() => {});
    }
  });
}

if (require.main === module) {
  loginLemeng()
    .then((status) => {
      console.log(`乐檬登录完成：${status}`);
      process.exit(0);
    })
    .catch((error) => {
      console.error(`乐檬登录失败：${error.message || error}`);
      process.exit(1);
    });
}

module.exports = {
  isLemengLoginUrl,
  isLemengSessionExpiredText,
  lemengCredentials,
  loginLemeng,
};
