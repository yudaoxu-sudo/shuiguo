const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { parseZhimadiText, buildMarkdown } = require("./read-current-zhimadi.cjs");
const { buildLemengCollectionReport } = require("./read-current-lemeng.cjs");
const { readDouyin } = require("./read-current-douyin.cjs");
const { withLock } = require("./runtime-lock.cjs");
const { gotoZhimadi } = require("./zhimadi-navigation.cjs");

const repairRequestPath = path.resolve("output/zhimadi-login-repair-request.json");
const repairStatePath = path.resolve("output/zhimadi-login-repair-state.json");

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

function incompleteDouyinResult(error) {
  const reportDate = todayText();
  const rawMessage = String(error?.message || error);
  const sourceError = isDouyinLoginError(error)
    ? "抖音来客登录态失效"
    : rawMessage.split("；调试文件")[0].slice(0, 180);
  return {
    report_month: reportDate.slice(0, 7),
    through_date: reportDate,
    generated_at: new Date().toISOString(),
    monthly: {
      report_month: reportDate.slice(0, 7),
      through_date: reportDate,
      generated_at: new Date().toISOString(),
      complete: false,
      source: process.env.DOUYIN_SOURCE || "browser",
      source_error: sourceError,
      cached_day_count: 0,
      missing_dates: [],
      settlement: null,
      stores: [],
    },
  };
}

function isZhimadiLoginError(error) {
  return String(error?.message || error).includes("芝麻地登录态失效");
}

function isDouyinLoginError(error) {
  return String(error?.message || error).includes("抖音来客登录态失效");
}

function isZhimadiPageLoadError(error) {
  const message = String(error?.message || error);
  return message.includes("芝麻地主界面加载超时")
    || message.includes("芝麻地销售汇总加载超时")
    || message.includes("芝麻地报表刷新按钮未加载");
}

async function waitForZhimadiRepair(requestedAt) {
  const timeoutMs = Number(process.env.ZHIMADI_AUTO_REPAIR_TIMEOUT_MS || 3 * 60 * 1000);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = readJson(repairStatePath);
    if (state?.handledRequestAt === requestedAt) {
      if (["auto-ok", "already-ok"].includes(state.status)) return state;
      if (state.status === "captcha-sent") {
        const error = new Error("芝麻地验证码已发送到钉钉，请回复：验证码ABCD");
        error.code = "ZHIMADI_CAPTCHA_SENT";
        throw error;
      }
      if (state.status === "failed") {
        throw new Error(`芝麻地自动登录修复失败：${state.error || "未知错误"}`);
      }
    }
    await delay(2000);
  }

  throw new Error(`等待芝麻地自动登录修复超时 ${Math.round(timeoutMs / 1000)} 秒`);
}

async function repairZhimadiLogin() {
  const requestedAt = new Date().toISOString();
  const previewOnly = process.env.NO_DINGTALK === "1" || process.env.NO_DINGTALK === "true";
  writeJson(repairRequestPath, {
    requestedAt,
    reason: "report-login-expired",
    afterLoginReport: !previewOnly,
  });
  console.warn("检测到芝麻地登录态失效，正在触发自动登录修复");
  return waitForZhimadiRepair(requestedAt);
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
      if (isZhimadiLoginError(error) || isDouyinLoginError(error)) throw error;
      if (attempt < attempts) await delay(5000);
    }
  }

  throw new Error(`${name}连续 ${attempts} 次失败：${lastError?.message || "未知错误"}`);
}

async function readZhimadi(page) {
  let lastError;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await readZhimadiOnce(page);
    } catch (error) {
      lastError = error;
      if (attempt === 2 || !isZhimadiPageLoadError(error)) throw error;

      console.warn(`芝麻地页面半加载，执行浏览器整页刷新：${error.message}`);
      await page.reload({ waitUntil: "commit", timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(5000);
    }
  }

  throw lastError;
}

async function readZhimadiOnce(page) {
  await gotoZhimadi(page, { readiness: "report" });

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
      const refreshButton = frame.getByText("刷新", { exact: true });
      if ((await refreshButton.count()) !== 1) {
        throw new Error(`芝麻地报表刷新按钮未加载：${lastText.slice(0, 200).replace(/\s+/g, " ")}`);
      }
      await refreshButton.click();
      await frame.waitForTimeout(2000);
      await clickByText(frame, "查询").catch(() => {});
      refreshed = true;
    }

    await frame.waitForTimeout(1000);
  }

  throw new Error(`芝麻地销售汇总加载超时：${lastText.slice(0, 200).replace(/\s+/g, " ")}`);
}

async function readLemeng(page) {
  await gotoWithRetry(
    page,
    "https://sharec.lemengcloud.com/report/business/business-collection-report",
    { waitUntil: "domcontentloaded", timeout: 60000 },
  );

  if (await isLoginPage(page)) {
    throw new Error("乐檬登录态失效，需要先运行 setup-login 并手动完成验证码登录");
  }

  await page.waitForSelector('input[placeholder="开始日期"]:visible', {
    timeout: 60000,
  });

  const periodSelector = page.locator(
    ".earth-select-selection-item:visible",
  ).filter({ hasText: /^(今天|本月|上月)$/ });
  if ((await periodSelector.count()) !== 1) {
    throw new Error(
      `乐檬营业收款报表日期周期控件匹配数 ${await periodSelector.count()}`,
    );
  }
  let monthOption;
  for (let attempt = 0; attempt < 3 && !monthOption; attempt += 1) {
    await periodSelector.click();
    await page.waitForTimeout(500);
    const candidates = page.getByText("本月", { exact: true });
    for (let index = 0; index < await candidates.count(); index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible()) {
        monthOption = candidate;
        break;
      }
    }
  }
  if (!monthOption) {
    throw new Error("乐檬营业收款报表没有找到“本月”选项");
  }
  await monthOption.click();

  const queryButton = page.locator("button:visible").filter({
    hasText: /^查\s*询$/,
  });
  if ((await queryButton.count()) !== 1) {
    throw new Error(`乐檬营业收款报表查询按钮匹配数 ${await queryButton.count()}`);
  }
  await queryButton.click();

  await page.waitForFunction(() => {
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.visibility !== "hidden"
        && style.display !== "none";
    };
    return [...document.querySelectorAll(".ag-root-wrapper")]
      .filter(isVisible)
      .some((root) => (
        root.querySelector('[col-id="branchName"]')
        && root.querySelector('[col-id="paymentReceiptMoney"]')
        && root.querySelector('.ag-row-pinned [col-id="paymentReceiptMoney"]')
        && root.querySelectorAll(
          '.ag-center-cols-container .ag-row:not(.ag-row-pinned) [col-id="branchName"]',
        ).length > 0
      ));
  }, { timeout: 60000 });

  const extracted = await page.evaluate(() => {
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.visibility !== "hidden"
        && style.display !== "none";
    };
    const root = [...document.querySelectorAll(".ag-root-wrapper")]
      .filter(isVisible)
      .find((candidate) => (
        candidate.querySelector('[col-id="branchName"]')
        && candidate.querySelector('[col-id="paymentReceiptMoney"]')
        && candidate.querySelector('.ag-row-pinned [col-id="paymentReceiptMoney"]')
      ));
    if (!root) return null;

    const rows = [...root.querySelectorAll(
      ".ag-center-cols-container .ag-row:not(.ag-row-pinned)",
    )]
      .map((row) => ({
        store: row.querySelector('[col-id="branchName"]')?.innerText.trim(),
        sales: row.querySelector('[col-id="paymentReceiptMoney"]')?.innerText.trim(),
      }))
      .filter((row) => row.store && row.sales);
    const total = root
      .querySelector('.ag-row-pinned [col-id="paymentReceiptMoney"]')
      ?.innerText.trim();
    return { rows, total };
  });

  if (!extracted) {
    throw new Error("没有读取到乐檬营业收款报表");
  }
  const report = buildLemengCollectionReport(extracted.rows, extracted.total);
  const expectedMonth = monthStartText().slice(0, 7);
  const selectedStart = await page
    .locator('input[placeholder="开始日期"]:visible')
    .inputValue();
  if (!selectedStart.startsWith(expectedMonth)) {
    throw new Error(`乐檬营业收款报表日期不是本月：${selectedStart}`);
  }

  return report;
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
  try {
    const parsed = JSON.parse(result);
    if (Number(parsed.errcode) !== 0) {
      throw new Error(`钉钉推送失败: ${result}`);
    }
  } catch (error) {
    if (error.message.startsWith("钉钉推送失败:")) throw error;
  }
  console.log(result);
}

async function runReportOnce(outputDir) {
  await withLock("browser-profile", {
    waitMs: Number(process.env.BROWSER_LOCK_WAIT_MS || 10 * 60 * 1000),
    staleMs: Number(process.env.BROWSER_LOCK_STALE_MS || 30 * 60 * 1000),
  }, async () => {
    const context = await launchContext();

    try {
      const attempts = Number(process.env.REPORT_STEP_ATTEMPTS || 3);
      const zhimadi = await retryStep("芝麻地报表", () => withFreshPage(context, "zhimadi", readZhimadi), attempts);
      const lemeng = await retryStep("乐檬报表", () => withFreshPage(context, "lemeng", readLemeng), attempts);
      let douyin = null;
      if (process.env.DOUYIN_ENABLED === "true") {
        try {
          douyin = await retryStep(
            "抖音报表",
            () => readDouyin(undefined, context),
            attempts,
          );
        } catch (error) {
          console.warn(`抖音汇总暂不可用，继续生成芝麻地和乐檬月报：${error.message}`);
          douyin = incompleteDouyinResult(error);
        }
      }
      const dateText = todayText();
      fs.writeFileSync(path.join(outputDir, `zhimadi-monthly-${dateText}.json`), JSON.stringify(zhimadi, null, 2));
      fs.writeFileSync(path.join(outputDir, `lemeng-monthly-${dateText}.json`), JSON.stringify(lemeng, null, 2));
      if (douyin) {
        fs.writeFileSync(
          path.join(outputDir, `douyin-monthly-${dateText}.json`),
          JSON.stringify(douyin, null, 2),
        );
      }
      const markdown = buildMarkdown(dateText, zhimadi, lemeng, douyin);
      fs.writeFileSync(path.join(outputDir, `monthly-report-${dateText}.md`), markdown);
      await sendDingTalk(markdown);
    } finally {
      await context.close();
    }
  });
}

async function main() {
  loadEnv();
  const outputDir = path.resolve("output");
  fs.mkdirSync(outputDir, { recursive: true });

  try {
    await runReportOnce(outputDir);
  } catch (error) {
    const listenerManaged = process.env.REPORT_MANAGED_BY_LISTENER === "1";
    if (!isZhimadiLoginError(error) || listenerManaged) throw error;

    const repair = await repairZhimadiLogin();
    console.log(`芝麻地自动登录修复完成：${repair.status}，重新生成报表`);
    await runReportOnce(outputDir);
  }
}

if (require.main === module) {
  main().catch(async (error) => {
    loadEnv();
    const failureAlertsEnabled = process.env.REPORT_FAILURE_ALERTS !== "false";
    if (error.code !== "ZHIMADI_CAPTCHA_SENT" && failureAlertsEnabled) {
      const message = `### 水果店月度报表失败\n\n${error.message || error}`;
      await sendDingTalk(message, { alert: true }).catch(() => {});
    }
    console.error(error.stack || error.message);
    process.exit(error.code === "ZHIMADI_CAPTCHA_SENT" ? 2 : 1);
  });
}
