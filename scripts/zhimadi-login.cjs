const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { chromium } = require("playwright");
const { loadEnv } = require("./send-dingtalk.cjs");
const { withLock } = require("./runtime-lock.cjs");

const captchaSelector = "#verifyCode";

function chromeExecutablePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (fs.existsSync(macChrome)) return macChrome;

  return undefined;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer.trim());
  }));
}

async function isZhimadiLoginFormVisible(page) {
  const selectors = [
    'input[name="account"]',
    "#password",
    'input[name="verify_code"]',
  ];

  for (const selector of selectors) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) {
      return true;
    }
  }
  return false;
}

async function waitForZhimadiLoggedIn(page, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await page.locator("iframe#sellSummary_customSummary, iframe[name='iframepage']").count()) > 0) return;
    if (!(await isZhimadiLoginFormVisible(page))) return;
    await page.waitForTimeout(1000);
  }

  const bodyText = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
  throw new Error(`芝麻地登录提交后仍停留在登录页：${bodyText.replace(/\s+/g, " ").slice(0, 160)}`);
}

async function waitForCaptchaReady(page) {
  const captcha = page.locator(captchaSelector).first();
  await captcha.waitFor({ state: "visible", timeout: 15000 });
  await page.waitForFunction((selector) => {
    const element = document.querySelector(selector);
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 20) return false;
    if (element.tagName.toLowerCase() === "img") {
      return element.complete && element.naturalWidth > 0 && element.naturalHeight > 0;
    }
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }, captchaSelector, { timeout: 15000 });
  await page.waitForTimeout(800);
  return captcha;
}

async function main() {
  loadEnv();

  const userDataDir = path.resolve(process.env.USER_DATA_DIR || "output/browser-profile");
  const outputDir = path.resolve("output/login-repair");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  await withLock("browser-profile", {
    waitMs: Number(process.env.BROWSER_LOCK_WAIT_MS || 10 * 60 * 1000),
    staleMs: Number(process.env.BROWSER_LOCK_STALE_MS || 30 * 60 * 1000),
  }, async () => {
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: process.env.HEADLESS !== "false",
      executablePath: chromeExecutablePath(),
      viewport: { width: 1440, height: 900 },
    });

    const page = context.pages()[0] || await context.newPage();
    try {
      await page.goto(process.env.ZHIMADI_URL || "https://aems.zhimadi.cn/index.php?s=/Index/index.html", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await page.waitForTimeout(1500);

      if ((await page.locator("iframe#sellSummary_customSummary, iframe[name='iframepage']").count()) > 0) {
        console.log("ZHIMADI_LOGIN_OK");
        return;
      }

      if ((await page.locator('input[name="account"]').count()) > 0 && process.env.ZHIMADI_USERNAME) {
        await page.locator('input[name="account"]').fill(process.env.ZHIMADI_USERNAME);
      }
      if ((await page.locator("#password").count()) > 0 && process.env.ZHIMADI_PASSWORD) {
        await page.locator("#password").fill(process.env.ZHIMADI_PASSWORD);
      }

      const screenshotPath = path.join(outputDir, "zhimadi-login-current.png");
      const captchaPath = path.join(outputDir, "zhimadi-captcha-current.png");
      const captcha = await waitForCaptchaReady(page);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      await captcha.screenshot({ path: captchaPath });
      console.log(`验证码截图：${screenshotPath}`);
      console.log(`验证码小图：${captchaPath}`);

      const code = await ask("请输入芝麻地图形验证码：");
      await page.locator('input[name="verify_code"]').fill(code);
      await page.evaluate(() => {
        const candidates = [...document.querySelectorAll("button,a,input[type=button],input[type=submit]")];
        const button = candidates.find((element) => /登\s*录/.test(element.innerText || element.value || ""));
        if (!button) throw new Error("找不到芝麻地登录按钮");
        button.click();
      });

      try {
        await waitForZhimadiLoggedIn(page);
      } catch (error) {
        const failurePath = path.join(outputDir, "zhimadi-login-after-submit.png");
        await page.screenshot({ path: failurePath, fullPage: true }).catch(() => {});
        error.message = `${error.message}；失败截图：${failurePath}`;
        throw error;
      }
      await page.screenshot({ path: path.join(outputDir, "zhimadi-login-success.png"), fullPage: true });
      console.log("ZHIMADI_LOGIN_OK");
    } finally {
      await context.close();
    }
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
