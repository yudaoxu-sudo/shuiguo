const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { parseZhimadiText, buildMarkdown } = require("./read-current-zhimadi.cjs");
const { parseLemengMonthlyText } = require("./read-current-lemeng.cjs");
const { withLock } = require("./runtime-lock.cjs");

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

async function gotoWithRetry(page, url, options, attempts = 3) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await page.goto(url, options);
    } catch (error) {
      lastError = error;
      if (index < attempts - 1) {
        await page.waitForTimeout(3000);
      }
    }
  }

  throw lastError;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, "-");
}

async function saveDebugArtifacts(page, label, error) {
  const outputDir = path.resolve("output/debug");
  fs.mkdirSync(outputDir, { recursive: true });

  const baseName = `${safeName(label)}-${todayText()}-${Date.now()}`;
  const screenshotPath = path.join(outputDir, `${baseName}.png`);
  const textPath = path.join(outputDir, `${baseName}.txt`);

  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  const pageText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  fs.writeFileSync(textPath, [
    `error=${error?.stack || error?.message || error}`,
    "",
    pageText,
  ].join("\n"));

  return { screenshotPath, textPath };
}

async function withFreshPage(context, label, action) {
  const page = await context.newPage();
  try {
    return await action(page);
  } catch (error) {
    const artifacts = await saveDebugArtifacts(page, label, error);
    error.message = `${error.message}；调试文件 ${artifacts.screenshotPath}`;
    throw error;
  } finally {
    await page.close().catch(() => {});
  }
}

async function retryStep(name, action, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (attempt > 1) console.log(`${name}第 ${attempt} 次重试`);
      return await action();
    } catch (error) {
      lastError = error;
      console.warn(`${name}第 ${attempt} 次失败：${error.message}`);
      if (attempt < attempts) await delay(5000);
    }
  }

  throw new Error(`${name}连续 ${attempts} 次失败：${lastError?.message || "未知错误"}`);
}

async function readZhimadi(page) {
  await page.goto(process.env.ZHIMADI_URL || "https://aems.zhimadi.cn/index.php?s=/Index/index.html", { waitUntil: "domcontentloaded" });

  if (await isLoginPage(page)) {
    throw new Error("芝麻地登录态失效，需要运行 pnpm zhimadi:login 并按提示输入图形验证码");
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

  await waitForZhimadiSummary(frame);
  const text = await frame.locator("body").innerText({ timeout: 15000 });
  return parseZhimadiText(text);
}

async function waitForZhimadiSummary(frame) {
  const startedAt = Date.now();
  const deadline = startedAt + 60000;
  let queriedAgain = false;
  let refreshed = false;
  let lastText = "";

  while (Date.now() < deadline) {
    lastText = await frame.locator("body").innerText({ timeout: 15000 }).catch(() => "");
    if (lastText.includes("合计：")) {
      return;
    }

    if (!queriedAgain && Date.now() - startedAt > 20000) {
      await clickByText(frame, "查询").catch(() => {});
      queriedAgain = true;
    }

    if (!refreshed && Date.now() - startedAt > 40000) {
      await clickByText(frame, "刷新").catch(() => {});
      await frame.waitForTimeout(2000);
      await clickByText(frame, "查询").catch(() => {});
      refreshed = true;
    }

    await frame.waitForTimeout(1000);
  }

  throw new Error(`芝麻地销售汇总加载超时：${lastText.slice(0, 200).replace(/\s+/g, " ")}`);
}

async function readLemeng(page) {
  await gotoWithRetry(page, "https://sharec.lemengcloud.com/report/home/data-index", { waitUntil: "domcontentloaded", timeout: 60000 });

  if (await isLoginPage(page)) {
    throw new Error("乐檬登录态失效，需要先运行 setup-login 并手动完成验证码登录");
  }

  await waitForLemengDashboard(page);
  let monthly;
  const deadline = Date.now() + 60000;
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

async function waitForLemengDashboard(page) {
  const startedAt = Date.now();
  const deadline = startedAt + 60000;
  let refreshed = false;
  let lastText = "";

  while (Date.now() < deadline) {
    lastText = await page.locator("body").innerText({ timeout: 15000 }).catch(() => "");
    if (lastText.includes("本月累计销售") && lastText.includes("月销售额排名")) {
      return;
    }

    if (!refreshed && Date.now() - startedAt > 20000) {
      const refreshButton = page.getByText("全局刷新", { exact: true });
      if ((await refreshButton.count()) > 0) {
        await refreshButton.first().click().catch(() => {});
      }
      refreshed = true;
    }

    await page.waitForTimeout(1000);
  }

  throw new Error(`乐檬数据指标加载超时：${lastText.slice(0, 200).replace(/\s+/g, " ")}`);
}

async function isLoginPage(page) {
  const passwordInputs = page.locator("input[type='password']");
  return (await passwordInputs.count()) > 0;
}

function dingTalkAtConfig(alert) {
  if (!alert) return undefined;

  const atMobiles = String(process.env.DINGTALK_ALERT_MOBILES || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return {
    atMobiles,
    isAtAll: process.env.DINGTALK_ALERT_ALL === "true",
  };
}

async function sendDingTalk(markdown, options = {}) {
  if (process.env.NO_DINGTALK === "1" || process.env.NO_DINGTALK === "true") {
    console.log(markdown);
    return;
  }

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

  const payload = {
    msgtype: "markdown",
    markdown: {
      title: "水果店月度报表",
      text: markdown,
    },
  };
  const at = dingTalkAtConfig(options.alert);
  if (at) payload.at = at;
  const body = JSON.stringify(payload);

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

  await withLock("browser-profile", {
    waitMs: Number(process.env.BROWSER_LOCK_WAIT_MS || 10 * 60 * 1000),
    staleMs: Number(process.env.BROWSER_LOCK_STALE_MS || 30 * 60 * 1000),
  }, async () => {
    const context = await launchContext();

    try {
      const attempts = Number(process.env.REPORT_STEP_ATTEMPTS || 3);
      const zhimadi = await retryStep("芝麻地报表", () => withFreshPage(context, "zhimadi", readZhimadi), attempts);
      const lemeng = await retryStep("乐檬报表", () => withFreshPage(context, "lemeng", readLemeng), attempts);
      const dateText = todayText();
      fs.writeFileSync(path.join(outputDir, `zhimadi-monthly-${dateText}.json`), JSON.stringify(zhimadi, null, 2));
      fs.writeFileSync(path.join(outputDir, `lemeng-monthly-${dateText}.json`), JSON.stringify(lemeng, null, 2));
      const markdown = buildMarkdown(dateText, zhimadi, lemeng);
      fs.writeFileSync(path.join(outputDir, `monthly-report-${dateText}.md`), markdown);
      await sendDingTalk(markdown);
    } finally {
      await context.close();
    }
  });
}

if (require.main === module) {
  main().catch(async (error) => {
    loadEnv();
    const message = `### 水果店月度报表失败\n\n${error.message || error}`;
    await sendDingTalk(message, { alert: true }).catch(() => {});
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
