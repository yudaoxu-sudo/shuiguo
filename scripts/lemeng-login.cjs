const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { loadEnv } = require("./send-dingtalk.cjs");
const { withLock } = require("./runtime-lock.cjs");

const loginHost = "account.lemengcloud.com";
const loginPageUrl = `https://${loginHost}/user/login`;
const reportUrl = "https://sharec.lemengcloud.com/report/business/business-collection-report";
const qrImagePath = path.resolve("output/lemeng-login-qr.png");

// 乐檬会话过期时不跳登录页，而是返回一个 500 错误页：上面既没有密码框，
// 也没有日期控件。只看密码框会把它误判成“已登录”。
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

// listener 会把消息里的空白全部删掉，@机器人 和正文会连成一串，
// 所以只看有没有“乐檬”两个字，不做分词。
function isLemengLoginCommand(text) {
  const value = String(text || "");
  if (!value.includes("乐檬")) return false;
  return !/\d/.test(value);
}

function isLemengLoginUrl(url) {
  return String(url || "").includes(loginHost);
}

function lemengCredentials(env = process.env) {
  const username = String(env.LEMENG_USERNAME || "").trim();
  const password = String(env.LEMENG_PASSWORD || "").trim();
  if (!username || !password) {
    throw new Error(
      "乐檬登录需要 .env 里的 LEMENG_USERNAME 和 LEMENG_PASSWORD",
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

function pageText(page) {
  return page.locator("body").innerText({ timeout: 6000 }).catch(() => "");
}

async function gotoSlow(page, url) {
  await page.goto(url, { waitUntil: "commit", timeout: 90000 });
  await page.waitForTimeout(8000);
}

async function lemengReportReachable(page) {
  await gotoSlow(page, reportUrl);
  if (isLemengLoginUrl(page.url())) return false;
  if (isLemengSessionExpiredText(await pageText(page))) return false;
  return page
    .locator('input[placeholder="开始日期"]:visible')
    .first()
    .waitFor({ state: "visible", timeout: 45000 })
    .then(() => true)
    .catch(() => false);
}

function readCodeFileSafely(codePath) {
  try {
    return fs.readFileSync(codePath, "utf8");
  } catch {
    return "";
  }
}

// 乐檬在发短信之前要过滑块验证码，那是专门挡自动化的，绕不过去也不该绕。
// 扫码是店主本人用手机完成的正当登录方式，所以这里走扫码。
async function captureLemengQr(context, page) {
  const appQr = page.getByText("乐檬零售APP扫码登录", { exact: false }).first();
  if (await appQr.isVisible().catch(() => false)) {
    await appQr.click().catch(() => {});
    await page.waitForTimeout(7000);
  }
  // CDP 截图不等字体加载，避开 2 核机器上 page.screenshot 的超时。
  const cdp = await context.newCDPSession(page);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.mkdirSync(path.dirname(qrImagePath), { recursive: true });
  fs.writeFileSync(qrImagePath, Buffer.from(shot.data, "base64"));
  return qrImagePath;
}

async function waitUntilLeftLoginPage(page, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isLemengLoginUrl(page.url())) return true;
    await page.waitForTimeout(1500);
  }
  return false;
}

async function loginLemeng(options = {}) {
  loadEnv();
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

      await gotoSlow(page, loginPageUrl);
      const qrPath = await captureLemengQr(context, page);
      if (typeof options.onQr === "function") await options.onQr(qrPath);

      const waitMs = Number(options.qrWaitMs || process.env.LEMENG_QR_WAIT_MS || 3 * 60 * 1000);
      if (!(await waitUntilLeftLoginPage(page, waitMs))) {
        throw new Error("二维码没有被扫描，登录未完成");
      }

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
  isLemengLoginCommand,
  isLemengLoginUrl,
  isLemengSessionExpiredText,
  lemengCredentials,
  loginLemeng,
  qrImagePath,
};
