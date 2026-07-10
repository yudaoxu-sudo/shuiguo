const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { gotoZhimadi } = require("./zhimadi-navigation.cjs");

function loadEnv() {
  const envPath = path.resolve(".env");
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function chromeExecutablePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (fs.existsSync(macChrome)) return macChrome;

  return undefined;
}

async function waitForZhimadiLogin(page) {
  await gotoZhimadi(page);

  if ((await page.locator('input[name="account"]').count()) === 1 && process.env.ZHIMADI_USERNAME) {
    await page.locator('input[name="account"]').fill(process.env.ZHIMADI_USERNAME);
  }
  if ((await page.locator("#password").count()) === 1 && process.env.ZHIMADI_PASSWORD) {
    await page.locator("#password").fill(process.env.ZHIMADI_PASSWORD);
  }

  await page.waitForSelector("iframe#sellSummary_customSummary, iframe[name='iframepage']", { timeout: 300000 });
}

async function waitForLemengLogin(page) {
  await page.goto(process.env.LEMENG_URL || "https://sharec.lemengcloud.com/pos/home", { waitUntil: "domcontentloaded" });

  if ((await page.getByPlaceholder("请输入手机号").count()) === 1 && process.env.LEMENG_USERNAME) {
    await page.getByPlaceholder("请输入手机号").fill(process.env.LEMENG_USERNAME);
  }
  if ((await page.locator("#password").count()) === 1 && process.env.LEMENG_PASSWORD) {
    await page.locator("#password").fill(process.env.LEMENG_PASSWORD);
  }
  if ((await page.getByRole("button", { name: "登 录" }).count()) === 1) {
    await page.getByRole("button", { name: "登 录" }).click();
  }

  await page.getByText("经营数据", { exact: true }).waitFor({ timeout: 300000 });
}

async function main() {
  loadEnv();

  const userDataDir = path.resolve(process.env.USER_DATA_DIR || "output/browser-profile");
  fs.mkdirSync(userDataDir, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: chromeExecutablePath(),
  });

  const page = context.pages()[0] || await context.newPage();

  console.log("请在浏览器里完成芝麻地登录，脚本会自动等待。");
  await waitForZhimadiLogin(page);
  console.log("芝麻地登录态已保存。");

  console.log("请在浏览器里完成乐檬登录，脚本会自动等待。");
  await waitForLemengLogin(page);
  console.log("乐檬登录态已保存。");

  await context.close();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
