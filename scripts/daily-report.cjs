const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { parseZhimadiText, buildMarkdown } = require("./read-current-zhimadi.cjs");
const { parseLemengMonthlyText } = require("./read-current-lemeng.cjs");

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

function todayText() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function monthStartText() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}-01`;
}

function chromeExecutablePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (fs.existsSync(macChrome)) return macChrome;

  return undefined;
}

async function launchContext() {
  const userDataDir = path.resolve(process.env.USER_DATA_DIR || "output/browser-profile");
  fs.mkdirSync(userDataDir, { recursive: true });

  return chromium.launchPersistentContext(userDataDir, {
    headless: process.env.HEADLESS === "true",
    executablePath: chromeExecutablePath(),
  });
}

async function clickByText(frameOrPage, text) {
  const locator = frameOrPage.getByText(text, { exact: true });
  const count = await locator.count();
  if (count !== 1) {
    throw new Error(`找不到唯一按钮/文本: ${text}，匹配数 ${count}`);
  }
  await locator.click();
}

async function readZhimadi(page) {
  await page.goto(process.env.ZHIMADI_URL || "https://aems.zhimadi.cn/index.php?s=/Index/index.html", { waitUntil: "domcontentloaded" });

  if (await isLoginPage(page)) {
    throw new Error("芝麻地登录态失效，需要先运行 setup-login 并手动完成验证码登录");
  }

  await page.waitForSelector("iframe#sellSummary_customSummary", { timeout: 15000 }).catch(async () => {
    await clickByText(page, "销售");
    await clickByText(page, "销售汇总表(按客户)");
    await page.waitForSelector("iframe#sellSummary_customSummary", { timeout: 15000 });
  });

  const frameElement = await page.waitForSelector("iframe#sellSummary_customSummary", { timeout: 15000 });
  const frame = await frameElement.contentFrame();
  if (!frame) throw new Error("没有找到芝麻地报表 iframe");

  await frame.waitForSelector("#choose_date, #start_date", { state: "attached", timeout: 15000 });
  await frame.evaluate(({ startDate, endDate }) => {
    const setValue = (selector, value) => {
      const element = document.querySelector(selector);
      if (!element) return;
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    };

    setValue("#start_date", startDate);
    setValue("#end_date", endDate);
    setValue("#choose_date", `${startDate} - ${endDate}`);
  }, { startDate: monthStartText(), endDate: todayText() });
  await clickByText(frame, "查询");

  await frame.getByText("合计：", { exact: true }).waitFor({ timeout: 30000 });
  const text = await frame.locator("body").innerText({ timeout: 15000 });
  return parseZhimadiText(text);
}

async function readLemeng(page) {
  await page.goto("https://sharec.lemengcloud.com/report/home/data-index", { waitUntil: "domcontentloaded" });

  if (await isLoginPage(page)) {
    throw new Error("乐檬登录态失效，需要先运行 setup-login 并手动完成验证码登录");
  }

  await page.getByText("本月累计销售", { exact: true }).waitFor({ timeout: 20000 });
  await page.getByText("月销售额排名", { exact: true }).waitFor({ timeout: 20000 });
  let monthly;
  const deadline = Date.now() + 20000;
  while (!monthly) {
    const text = await page.locator("body").innerText({ timeout: 15000 });
    try {
      monthly = parseLemengMonthlyText(text);
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await page.waitForTimeout(1000);
    }
  }

  const ranking = await page.evaluate(() => {
    const parseAmount = (value) => Number(String(value).replace(/,/g, ""));
    const storeGrid = [...document.querySelectorAll(".ag-theme-lemon")].find((grid) => grid.innerText.includes("门店Top"));
    if (!storeGrid) return [];

    return [...storeGrid.querySelectorAll(".ag-row")]
      .map((row) => {
        const cells = [...row.querySelectorAll(".ag-cell")];
        const get = (colId) => cells.find((cell) => cell.getAttribute("col-id") === colId)?.innerText.trim();
        const store = get("name");
        const sales = get("saleMoney");
        const rate = get("rate");
        return { store, sales, rate };
      })
      .filter((row) => row.store && row.sales && row.rate)
      .map((row, index) => ({
        rank: index + 1,
        store: row.store,
        sales: parseAmount(row.sales),
        rate: row.rate,
      }));
  });

  if (ranking.length === 0) {
    throw new Error("没有读取到乐檬月销售排名");
  }

  return { monthly, ranking };
}

async function isLoginPage(page) {
  const passwordInputs = page.locator("input[type='password']");
  return (await passwordInputs.count()) > 0;
}

async function sendDingTalk(markdown) {
  const webhook = process.env.DINGTALK_WEBHOOK;
  if (!webhook) {
    console.log(markdown);
    return;
  }

  let url = webhook;
  if (process.env.DINGTALK_SECRET) {
    const timestamp = Date.now();
    const stringToSign = `${timestamp}\n${process.env.DINGTALK_SECRET}`;
    const sign = encodeURIComponent(crypto.createHmac("sha256", process.env.DINGTALK_SECRET).update(stringToSign).digest("base64"));
    url += `${url.includes("?") ? "&" : "?"}timestamp=${timestamp}&sign=${sign}`;
  }

  const body = JSON.stringify({
    msgtype: "markdown",
    markdown: {
      title: "水果店月度报表",
      text: markdown,
    },
  });

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const result = await response.text();
  if (!response.ok) {
    throw new Error(`钉钉推送失败: ${response.status} ${result}`);
  }
  console.log(result);
}

async function main() {
  loadEnv();
  const outputDir = path.resolve("output");
  fs.mkdirSync(outputDir, { recursive: true });

  const context = await launchContext();
  const page = context.pages()[0] || await context.newPage();

  try {
    const zhimadi = await readZhimadi(page);
    const lemeng = await readLemeng(page);
    const dateText = todayText();
    fs.writeFileSync(path.join(outputDir, `zhimadi-monthly-${dateText}.json`), JSON.stringify(zhimadi, null, 2));
    fs.writeFileSync(path.join(outputDir, `lemeng-monthly-${dateText}.json`), JSON.stringify(lemeng, null, 2));
    const markdown = buildMarkdown(dateText, zhimadi, lemeng);
    fs.writeFileSync(path.join(outputDir, `monthly-report-${dateText}.md`), markdown);
    await sendDingTalk(markdown);
  } finally {
    await context.close();
  }
}

if (require.main === module) {
  main().catch(async (error) => {
    loadEnv();
    const message = `### 水果店月度报表失败\n\n${error.message || error}`;
    await sendDingTalk(message).catch(() => {});
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
