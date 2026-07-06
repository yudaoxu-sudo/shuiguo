const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { chromium } = require("playwright");
const { loadEnv } = require("./send-dingtalk.cjs");

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

async function main() {
  loadEnv();

  const userDataDir = path.resolve(process.env.USER_DATA_DIR || "output/browser-profile");
  const outputDir = path.resolve("output/login-repair");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

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
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`验证码截图：${screenshotPath}`);

    const code = await ask("请输入芝麻地图形验证码：");
    await page.locator('input[name="verify_code"]').fill(code);
    await page.evaluate(() => {
      const candidates = [...document.querySelectorAll("button,a,input[type=button],input[type=submit]")];
      const button = candidates.find((element) => /登\s*录/.test(element.innerText || element.value || ""));
      if (!button) throw new Error("找不到芝麻地登录按钮");
      button.click();
    });

    await page.waitForSelector("iframe#sellSummary_customSummary, iframe[name='iframepage']", { timeout: 60000 });
    await page.screenshot({ path: path.join(outputDir, "zhimadi-login-success.png"), fullPage: true });
    console.log("ZHIMADI_LOGIN_OK");
  } finally {
    await context.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
