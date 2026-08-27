const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { parseZhimadiText, buildMarkdown } = require("./read-current-zhimadi.cjs");
const { buildLemengCollectionReport } = require("./read-current-lemeng.cjs");
const { readDouyin } = require("./read-current-douyin.cjs");
const { archiveMonthlyReport } = require("./report-history.cjs");
const { withLock } = require("./runtime-lock.cjs");
const { gotoZhimadi } = require("./zhimadi-navigation.cjs");
const { writeHealthFailure } = require("./healthcheck-error.cjs");
const {
  isLemengLoginUrl,
  isLemengSessionExpiredText,
} = require("./lemeng-login.cjs");
const {
  aggregatePurchaseRows,
  fetchPurchaseRows,
  renderPurchaseDetail,
} = require("./zhimadi-purchase-detail.cjs");
const { pruneDebugArtifactsQuietly } = require("./debug-artifacts.cjs");
const { requestTimeoutSignal } = require("./send-dingtalk.cjs");
const {
  persistMergedRepairRequest,
} = require("./zhimadi-repair-request.cjs");
const {
  createReportTargetDateGuard,
  resolveReportTargetDate,
  runGuardedAction,
  shouldGuardFormalReportTarget,
} = require("./report-target-date.cjs");

const processStartedAt = Date.now();
const defaultRetryBackoffsMs = [5000, 30000, 120000];
const defaultReportBudgetMs = 13 * 60 * 1000;

const repairStatePath = path.resolve("output/zhimadi-login-repair-state.json");
const deferredZhimadiRepairCodes = new Set([
  "ZHIMADI_AUTO_RETRYING",
  "ZHIMADI_CAPTCHA_SENT",
  "ZHIMADI_REPAIR_DEFERRED",
]);

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

function todayText(now = new Date()) {
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

function reportBudgetMs(env = process.env) {
  const value = Number(env.REPORT_TOTAL_BUDGET_MS);
  return Number.isFinite(value) && value > 0 ? value : defaultReportBudgetMs;
}

function retryBackoffsMs(env = process.env) {
  const configured = String(env.REPORT_RETRY_BACKOFF_MS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0);
  return configured.length > 0 ? configured : defaultRetryBackoffsMs;
}

function retryBackoffFor(attempt, backoffs = retryBackoffsMs()) {
  if (backoffs.length === 0) return 0;
  return backoffs[Math.min(attempt, backoffs.length) - 1];
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, data) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
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

function isZhimadiRepairDeferredError(error) {
  return deferredZhimadiRepairCodes.has(error?.code);
}

function isZhimadiRepairAlertOwnedError(error) {
  return error?.code === "ZHIMADI_REPAIR_FATAL_ALERTED";
}

function currentReportResumeMode() {
  if (process.env.REPORT_MANAGED_BY_SCHEDULED === "1") return "scheduled";
  if (process.env.REPORT_MANAGED_BY_LISTENER === "1") return "listener";
  return "direct";
}

function repairCanResumeInProcess(state, resumeMode = currentReportResumeMode()) {
  return !state?.reportResumeMode || state.reportResumeMode === resumeMode;
}

function shouldRequestReportAfterLogin(env = process.env) {
  const noDingTalk = env.NO_DINGTALK === "1" || env.NO_DINGTALK === "true";
  return !noDingTalk || env.REPORT_FORMAL_WRAPPER === "1";
}

async function waitForZhimadiRepair(requestedAt) {
  const timeoutMs = Number(process.env.ZHIMADI_AUTO_REPAIR_TIMEOUT_MS || 3 * 60 * 1000);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = readJson(repairStatePath);
    if (state?.handledRequestAt === requestedAt) {
      if (["auto-ok", "already-ok", "manual-ok", "observed-ok"].includes(state.status)) {
        if (repairCanResumeInProcess(state)) return state;
        const error = new Error("芝麻地登录已恢复，报表将由原定时入口继续生成");
        error.code = "ZHIMADI_REPAIR_DEFERRED";
        throw error;
      }
      if (state.status === "auto-retrying") {
        const error = new Error("芝麻地登录态失效，自动修复正在后台重试");
        error.code = "ZHIMADI_AUTO_RETRYING";
        throw error;
      }
      if (state.status === "captcha-sent") {
        const error = new Error("芝麻地验证码已发送到钉钉，请回复：验证码ABCD");
        error.code = "ZHIMADI_CAPTCHA_SENT";
        throw error;
      }
      if (["escalating", "escalation-failed", "manual-failed", "manual-expired"].includes(state.status)) {
        const error = new Error("芝麻地登录态失效，自动修复已等待人工处理");
        error.code = "ZHIMADI_REPAIR_DEFERRED";
        throw error;
      }
      if (["failed", "fatal"].includes(state.status)) {
        const error = new Error(`芝麻地自动登录修复失败：${state.lastFailure || state.error || "未知错误"}`);
        if (state.status === "fatal" && state.fatalAlertAttemptedAt) {
          error.code = "ZHIMADI_REPAIR_FATAL_ALERTED";
        }
        throw error;
      }
    }
    await delay(2000);
  }

  const error = new Error(`等待芝麻地自动登录修复超时 ${Math.round(timeoutMs / 1000)} 秒`);
  error.code = "ZHIMADI_REPAIR_DEFERRED";
  throw error;
}

async function repairZhimadiLogin({ deferToListener = false } = {}) {
  const requestedAt = new Date().toISOString();
  const reportResumeMode = currentReportResumeMode();
  const afterLoginReport = shouldRequestReportAfterLogin();
  const persistedRequest = await persistMergedRepairRequest({
    requestedAt,
    reason: "report-login-expired",
    afterLoginReport,
    requesterPid: deferToListener ? null : process.pid,
    reportResumeMode,
    ...(afterLoginReport
      ? { reportDate: process.env.REPORT_TARGET_DATE || todayText(new Date(requestedAt)) }
      : {}),
    ...(process.env.ZHIMADI_REPAIR_FAILURE_ALERT_OWNER
      ? { failureAlertOwner: process.env.ZHIMADI_REPAIR_FAILURE_ALERT_OWNER }
      : {}),
  });
  console.warn("检测到芝麻地登录态失效，正在触发自动登录修复");
  if (deferToListener) {
    const error = new Error("芝麻地登录态失效，自动修复已交由后台继续");
    error.code = "ZHIMADI_REPAIR_DEFERRED";
    throw error;
  }
  return waitForZhimadiRepair(persistedRequest.requestedAt);
}

function persistRequesterReportResumeOutcome(repairState, outcome, error, {
  loadState = () => readJson(repairStatePath),
  persistState = (state) => writeJson(repairStatePath, state),
  now = Date.now,
  requesterPid = process.pid,
} = {}) {
  const currentState = loadState();
  if (
    !repairState?.incidentId
    || currentState?.incidentId !== repairState.incidentId
    || currentState?.reportRequestedAt !== repairState.reportRequestedAt
    || Number(currentState?.requesterPid) !== requesterPid
  ) {
    return;
  }

  const currentTime = now();
  const updatedAt = new Date(currentTime).toISOString();
  const nextState = { ...currentState, updatedAt };
  for (const key of [
    "reportResumeClaimId",
    "reportResumeClaimedAt",
    "reportResumeOwner",
    "reportResumeOwnerPid",
    "reportResumeLeaseUntil",
  ]) {
    delete nextState[key];
  }
  if (outcome === "success") {
    nextState.afterLoginReport = false;
    nextState.reportResumeCompletedAt = updatedAt;
    delete nextState.reportResumeLastFailure;
    delete nextState.reportResumeNextAttemptAt;
  } else {
    nextState.requesterPid = null;
    nextState.reportResumeLastFailedAt = updatedAt;
    nextState.reportResumeLastFailure = String(error?.message || error).slice(0, 900);
    nextState.reportResumeNextAttemptAt = new Date(
      currentTime + 15 * 60 * 1000,
    ).toISOString();
  }
  persistState(nextState);
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

  pruneDebugArtifactsQuietly({ outputDir: path.resolve("output") });
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

async function retryStep(name, action, attempts = 3, {
  backoffs = retryBackoffsMs(),
  deadlineAt = processStartedAt + reportBudgetMs(),
  now = Date.now,
  sleep = delay,
} = {}) {
  let lastError;
  let used = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    used = attempt;
    try {
      if (attempt > 1) console.log(`${name}第 ${attempt} 次重试`);
      return await action(attempt, attempts);
    } catch (error) {
      lastError = error;
      console.warn(`${name}第 ${attempt} 次失败：${error.message}`);
      if (isZhimadiLoginError(error) || isDouyinLoginError(error)) throw error;
      if (attempt >= attempts) break;

      // 退避重试，但绝不睡过本次报表的总预算，避免被父进程 watchdog 直接杀掉。
      const backoffMs = retryBackoffFor(attempt, backoffs);
      const remainingMs = deadlineAt - now();
      if (remainingMs <= backoffMs) {
        console.warn(`${name}剩余时间不足，停止重试`);
        break;
      }
      await sleep(backoffMs);
    }
  }

  throw new Error(`${name}连续 ${used} 次失败：${lastError?.message || "未知错误"}`);
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
    throw new Error("乐檬登录态失效，需要运行 pnpm lemeng:login 重新登录");
  }

  // 会话过期时乐檬返回 500 错误页，日期控件永远不会出现。及早识别，
  // 避免白等 60 秒再重试三轮。
  const lemengBodyText = await page.locator("body")
    .innerText({ timeout: 5000 })
    .catch(() => "");
  if (isLemengLoginUrl(page.url()) || isLemengSessionExpiredText(lemengBodyText)) {
    throw new Error("乐檬登录态失效，需要运行 pnpm lemeng:login 重新登录");
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
    signal: requestTimeoutSignal(),
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


// 门店进货明细是月报后面的附加板块。它读的是另一张报表，
// 读不到时只跳过这一段，绝不能让正式月报发不出去。
async function buildPurchaseSection(context, dateText) {
  const monthStart = monthStartText();
  return withFreshPage(context, "zhimadi-purchase", async (page) => {
    const rows = await fetchPurchaseRows(page, {
      monthStart,
      today: dateText,
      gotoZhimadi,
    });
    return renderPurchaseDetail(aggregatePurchaseRows(rows, dateText), dateText);
  });
}

async function runReportOnce(outputDir) {
  const guardReportDate = shouldGuardFormalReportTarget()
    ? createReportTargetDateGuard(
      resolveReportTargetDate(process.env.REPORT_TARGET_DATE),
      { label: "正式报表" },
    )
    : () => {};
  await withLock("browser-profile", {
    waitMs: Number(process.env.BROWSER_LOCK_WAIT_MS || 10 * 60 * 1000),
    staleMs: Number(process.env.BROWSER_LOCK_STALE_MS || 30 * 60 * 1000),
  }, async () => {
    guardReportDate("抓取前");
    const context = await launchContext();

    try {
      const attempts = Number(process.env.REPORT_STEP_ATTEMPTS || 3);
      const dateText = todayText();
      const reuseBaseSuffix = String(process.env.REPORT_REUSE_BASE_SUFFIX || "")
        .replace(/[^A-Za-z0-9_-]/g, "");
      let zhimadi;
      let lemeng;
      if (reuseBaseSuffix) {
        zhimadi = readJson(path.join(
          outputDir,
          `zhimadi-monthly-${dateText}-${reuseBaseSuffix}.json`,
        ));
        lemeng = readJson(path.join(
          outputDir,
          `lemeng-monthly-${dateText}-${reuseBaseSuffix}.json`,
        ));
        if (!zhimadi || !lemeng) {
          throw new Error(`没有找到可复用的基础报表快照：${reuseBaseSuffix}`);
        }
      } else {
        zhimadi = await retryStep("芝麻地报表", () => withFreshPage(context, "zhimadi", readZhimadi), attempts);
        lemeng = await retryStep("乐檬报表", () => withFreshPage(context, "lemeng", readLemeng), attempts);
      }
      const douyin = process.env.DOUYIN_ENABLED === "true"
        ? await retryStep(
          "抖音报表",
          (attempt, totalAttempts) => readDouyin(undefined, context, {
            allowSyncAdjustment: attempt === totalAttempts,
          }),
          attempts,
        )
        : null;
      guardReportDate("报表产物写入前");
      const outputSuffix = String(process.env.REPORT_OUTPUT_SUFFIX || "")
        .replace(/[^A-Za-z0-9_-]/g, "");
      const suffix = outputSuffix ? `-${outputSuffix}` : "";
      fs.writeFileSync(path.join(outputDir, `zhimadi-monthly-${dateText}${suffix}.json`), JSON.stringify(zhimadi, null, 2));
      fs.writeFileSync(path.join(outputDir, `lemeng-monthly-${dateText}${suffix}.json`), JSON.stringify(lemeng, null, 2));
      if (douyin) {
        fs.writeFileSync(
          path.join(outputDir, `douyin-monthly-${dateText}${suffix}.json`),
          JSON.stringify(douyin, null, 2),
        );
      }
      const markdown = buildMarkdown(dateText, zhimadi, lemeng, douyin);
      // 只有夜间自动任务带进货明细：@666 是人工临时要月报，不该多这一大段。
      // 私聊预览要看完整的一晚长什么样，所以留一个显式开关。
      const isScheduledRun = process.env.REPORT_MANAGED_BY_SCHEDULED === "1";
      const includePurchase = isScheduledRun
        || process.env.REPORT_INCLUDE_PURCHASE === "1";
      const purchaseSection = includePurchase
        ? await buildPurchaseSection(context, dateText).catch((error) => {
          console.warn(`门店进货明细读取失败，本次月报不带该板块：${error.message}`);
          return "";
        })
        : "";
      const reportPath = path.join(outputDir, `monthly-report-${dateText}${suffix}.md`);
      fs.writeFileSync(
        reportPath,
        purchaseSection ? `${markdown}\n\n${purchaseSection}` : markdown,
      );
      archiveMonthlyReport({
        outputDir,
        dateText,
        suffix: outputSuffix,
      });
      await runGuardedAction(
        guardReportDate,
        "正式发送前",
        () => sendDingTalk(markdown, { alert: isScheduledRun }),
      );
      // 进货明细单独发一条，跟月报分开。这条发失败不能回头影响已经发出去的月报。
      if (purchaseSection) {
        await sendDingTalk(purchaseSection).catch((error) => {
          console.warn(`门店进货明细推送失败：${error.message || error}`);
        });
      }
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
    const scheduledManaged = process.env.REPORT_MANAGED_BY_SCHEDULED === "1";
    if (!isZhimadiLoginError(error)) throw error;

    const repair = await repairZhimadiLogin({
      deferToListener: listenerManaged || scheduledManaged,
    });
    console.log(`芝麻地自动登录修复完成：${repair.status}，重新生成报表`);
    try {
      await runReportOnce(outputDir);
      persistRequesterReportResumeOutcome(repair, "success");
    } catch (resumeError) {
      persistRequesterReportResumeOutcome(repair, "failed", resumeError);
      throw resumeError;
    }
  }
}

if (require.main === module) {
  main().catch(async (error) => {
    loadEnv();
    const failureAlertsEnabled = process.env.REPORT_FAILURE_ALERTS !== "false";
    const repairDeferred = isZhimadiRepairDeferredError(error);
    const repairAlertAlreadyOwned = isZhimadiRepairAlertOwnedError(error);
    if (!repairDeferred && !repairAlertAlreadyOwned && failureAlertsEnabled) {
      const message = `### 水果店月度报表失败\n\n${error.message || error}`;
      await sendDingTalk(message, { alert: true }).catch(() => {});
    }
    console.error(error.stack || error.message);
    writeHealthFailure(error);
    process.exit(repairDeferred ? 2 : 1);
  });
}

module.exports = {
  isZhimadiRepairAlertOwnedError,
  isZhimadiRepairDeferredError,
  persistRequesterReportResumeOutcome,
  repairCanResumeInProcess,
  reportBudgetMs,
  retryBackoffFor,
  retryBackoffsMs,
  retryStep,
  shouldRequestReportAfterLogin,
};
