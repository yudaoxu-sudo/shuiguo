const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { loadEnv } = require("./send-dingtalk.cjs");
const { withLock } = require("./runtime-lock.cjs");

const loginHost = "account.lemengcloud.com";
const loginPageUrl = `https://${loginHost}/user/login`;
const reportUrl = "https://sharec.lemengcloud.com/report/business/business-collection-report";
const smsCodePath = path.resolve("output/lemeng-sms-code.txt");

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

function isLemengLoginUrl(url) {
  return String(url || "").includes(loginHost);
}

// 密码正确之后乐檬还要一步短信验证，页面会变成“请验证手机号 187****2906”。
function isLemengSmsStepText(text) {
  const value = String(text || "");
  return value.includes("请验证手机号")
    || (value.includes("发送验证码") && value.includes("验证码"));
}

function parseSmsCode(raw) {
  const match = String(raw || "").match(/\d{4,8}/);
  return match ? match[0] : null;
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

async function clickLoginButton(page) {
  const button = page.locator("button").filter({ hasText: /^登\s*录$/ }).first();
  await button.waitFor({ state: "visible", timeout: 20000 });
  await button.click();
}

async function submitPasswordStep(page, { username, password }) {
  const passwordTab = page.getByText("密码登录", { exact: true }).first();
  if (await passwordTab.isVisible().catch(() => false)) {
    await passwordTab.click().catch(() => {});
    await page.waitForTimeout(800);
  }

  const phone = page.locator('input[placeholder="请输入手机号"]').first();
  await phone.waitFor({ state: "visible", timeout: 30000 });
  await phone.fill(username);
  await page
    .locator('input[placeholder="请输入密码"], input#password')
    .first()
    .fill(password);

  // 勾上“5天内自动登录”，减少会话过期频率。
  await page.locator('input[type="checkbox"]').first().check().catch(() => {});
  await clickLoginButton(page);
}

function readCodeFileSafely(codePath) {
  try {
    return fs.readFileSync(codePath, "utf8");
  } catch {
    return "";
  }
}

// 验证码只会发到店主手机上，所以这里等一个外部投递的文件，
// 脚本自己不接触、不保存任何验证码内容。
async function waitForSmsCode({
  timeoutMs = Number(process.env.LEMENG_SMS_WAIT_MS || 5 * 60 * 1000),
  codePath = smsCodePath,
  env = process.env,
  log = console.log,
} = {}) {
  const direct = parseSmsCode(env.LEMENG_SMS_CODE);
  if (direct) return direct;

  const deadline = Date.now() + timeoutMs;
  log(`等待验证码，请把收到的验证码写入 ${codePath}（最多等 ${Math.round(timeoutMs / 60000)} 分钟）`);
  log(`例如：echo 123456 > ${codePath}`);
  while (Date.now() < deadline) {
    const code = parseSmsCode(readCodeFileSafely(codePath));
    if (code) {
      fs.rmSync(codePath, { force: true });
      return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error("等待乐檬短信验证码超时");
}

async function completeSmsStep(page, options = {}) {
  const send = page.getByText("发送验证码", { exact: false }).first();
  if (await send.isVisible().catch(() => false)) {
    await send.click().catch(() => {});
    console.log("已请求乐檬发送短信验证码");
  }

  const code = await waitForSmsCode(options);
  const codeInput = page
    .locator('input[placeholder*="验证码"], input[placeholder="验证码"]')
    .first();
  await codeInput.waitFor({ state: "visible", timeout: 20000 });
  await codeInput.fill(code);
  await page.locator('input[type="checkbox"]').first().check().catch(() => {});
  await clickLoginButton(page);
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
  const credentials = lemengCredentials();
  const userDataDir = path.resolve(process.env.USER_DATA_DIR || "output/browser-profile");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(path.dirname(smsCodePath), { recursive: true });

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
      await submitPasswordStep(page, credentials);
      await page.waitForTimeout(4000);

      if (isLemengLoginUrl(page.url())) {
        const text = await pageText(page);
        if (isLemengSmsStepText(text)) {
          await completeSmsStep(page, options);
        }
        if (!(await waitUntilLeftLoginPage(page))) {
          const tail = (await pageText(page)).replace(/\s+/g, " ").slice(0, 160);
          throw new Error(`乐檬登录未通过，仍停留在登录页：${tail}`);
        }
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
  isLemengLoginUrl,
  isLemengSessionExpiredText,
  isLemengSmsStepText,
  lemengCredentials,
  loginLemeng,
  parseSmsCode,
  smsCodePath,
  waitForSmsCode,
};
