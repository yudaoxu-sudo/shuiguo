const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const {
  checkReportHealth,
  deferZhimadiHealthFailure,
  isZhimadiRepairIncidentResolved,
  readJson,
  runNodePreview,
  writeJson,
} = require("./check-report-health.cjs");
const {
  claimHealthAlert,
  getHealthAlertState,
  isSharedHealthProblem,
  resolveHealthAlert,
} = require("./health-alert-claim.cjs");
const {
  finalHealthFailureMessage,
  writeHealthFailure,
} = require("./healthcheck-error.cjs");
const { loadEnv } = require("./send-dingtalk.cjs");
const { withLock } = require("./runtime-lock.cjs");
const { gotoZhimadi, isZhimadiAuthenticated } = require("./zhimadi-navigation.cjs");
const {
  isLemengLoginUrl,
  isLemengSessionExpiredText,
} = require("./lemeng-login.cjs");
const {
  markObservedZhimadiRecovery,
} = require("./zhimadi-repair-coordinator.cjs");
const {
  persistMergedRepairRequest,
} = require("./zhimadi-repair-request.cjs");

const statePath = path.resolve("output/login-health-state.json");
const repairStatePath = path.resolve("output/zhimadi-login-repair-state.json");
const defaultRecoveryWindowMs = 20 * 60 * 1000;
const defaultRetryIntervalMs = 60 * 1000;
const defaultPreviewTimeoutMs = 10 * 60 * 1000;
const defaultRepairRetryMs = 3 * 60 * 1000;

function configuredDuration(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function chromeExecutablePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  return undefined;
}

function persistObservedZhimadiRecovery(
  now = Date.now(),
  loadState = () => readJson(repairStatePath),
  persist = (state) => writeJson(repairStatePath, state),
) {
  const currentState = loadState();
  const nextState = markObservedZhimadiRecovery(currentState, now);
  if (nextState !== currentState) persist(nextState);
  return nextState;
}

async function zhimadiOk(page) {
  await gotoZhimadi(page);
  return isZhimadiAuthenticated(page);
}

async function lemengOk(page) {
  await page.goto("https://sharec.lemengcloud.com/report/home/data-index", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(3000);
  if ((await page.locator("input[type='password']").count()) > 0) return false;

  // 会话过期时乐檬返回 500 错误页，上面同样没有密码框。只看密码框会把它当成已登录。
  if (isLemengLoginUrl(page.url())) return false;
  const text = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  return !isLemengSessionExpiredText(text);
}

async function inspectLogins(timeoutMs) {
  const userDataDir = path.resolve(process.env.USER_DATA_DIR || "output/browser-profile");
  fs.mkdirSync(userDataDir, { recursive: true });
  const problems = [];
  const configuredWaitMs = configuredDuration(
    "BROWSER_LOCK_WAIT_MS",
    10 * 60 * 1000,
  );
  const lockWaitMs = Number.isFinite(timeoutMs)
    ? Math.max(1, Math.min(configuredWaitMs, timeoutMs))
    : configuredWaitMs;

  await withLock("browser-profile", {
    waitMs: lockWaitMs,
    staleMs: configuredDuration(
      "BROWSER_LOCK_STALE_MS",
      30 * 60 * 1000,
    ),
  }, async () => {
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: process.env.HEADLESS === "true",
      executablePath: chromeExecutablePath(),
    });

    const page = context.pages()[0] || await context.newPage();
    try {
      try {
        if (!(await zhimadiOk(page))) problems.push("芝麻地登录态失效");
        else persistObservedZhimadiRecovery();
      } catch (error) {
        problems.push(`芝麻地登录检查失败：${error.message || error}`);
      }
      try {
        if (!(await lemengOk(page))) problems.push("乐檬登录态失效");
      } catch (error) {
        problems.push(`乐檬登录检查失败：${error.message || error}`);
      }
    } finally {
      await context.close();
    }
  });

  return problems;
}

function classifyLoginFailure(message) {
  const text = String(message || "");
  if (text.includes("芝麻地")) {
    return { problemKey: "zhimadi-login", retryable: true };
  }
  if (text.includes("乐檬")) {
    return { problemKey: "lemeng-login", retryable: true };
  }
  return { problemKey: "login-transient", retryable: true };
}

function verifiedLoginProbeKeys(failure, message) {
  if (
    failure.problemKey === "zhimadi-login"
    && !String(message).includes("乐檬")
  ) {
    return ["lemeng-login"];
  }
  if (failure.problemKey === "lemeng-login") {
    return ["zhimadi-login"];
  }
  return [];
}

async function runLoginInspection(timeoutMs) {
  await runNodePreview(__filename, {
    args: ["--probe-only"],
    timeoutMs,
    label: "登录预检",
    env: {
      HEALTHCHECK_PREVIEW: "1",
      LOGIN_PROBE_TIMEOUT_MS: String(timeoutMs),
    },
  });
  return [];
}

function createLoginProbe(options = {}) {
  const {
    inspect = runLoginInspection,
    persistRepairRequest = persistMergedRepairRequest,
    loadRepairState = () => readJson(repairStatePath),
    now = () => Date.now(),
    repairRetryMs = configuredDuration(
      "ZHIMADI_REPAIR_RETRY_MS",
      defaultRepairRetryMs,
    ),
  } = options;
  let lastRequestAt = null;
  let lastRequestMs = null;

  async function maybeRequestRepair(message, verifyOnly) {
    if (verifyOnly || !String(message).includes("芝麻地")) return;
    const currentTime = now();
    if (lastRequestAt) {
      if (currentTime - lastRequestMs < repairRetryMs) return;
      const repairState = loadRepairState();
      const matchingState = repairState?.handledRequestAt === lastRequestAt;
      if (
        matchingState
        && !["failed", "starting"].includes(repairState.status)
      ) {
        return;
      }
    }

    const requestedAt = new Date(currentTime).toISOString();
    const persistedRequest = await persistRepairRequest({
      requestedAt,
      reason: "login-healthcheck",
      failureAlertOwner: "login-healthcheck",
    });
    lastRequestAt = persistedRequest?.requestedAt || requestedAt;
    lastRequestMs = currentTime;
  }

  return async ({ timeoutMs, verifyOnly = false } = {}) => {
    let problems;
    try {
      problems = await inspect(timeoutMs);
    } catch (error) {
      await maybeRequestRepair(finalHealthFailureMessage(error), verifyOnly);
      throw error;
    }
    if (problems.length === 0) return "login-ok";

    const message = `登录态异常：${problems.join("；")}`;
    await maybeRequestRepair(message, verifyOnly);
    throw new Error(message);
  };
}

async function checkLoginHealth(options = {}) {
  return checkReportHealth({
    ...options,
    loadState: options.loadState || (() => readJson(statePath)),
    persist: options.persist || ((state) => writeJson(statePath, state)),
    runPreview: options.runPreview || createLoginProbe({
      now: options.now,
    }),
    classify: options.classify || classifyLoginFailure,
    alertTitle: "水果店登录态异常",
    formatAlertText: ({ message, recoveryText }) =>
      `### 水果店登录态异常\n\n${recoveryText}\n\n${message}`,
    logPrefix: "login",
    alertSource: "login-healthcheck",
    claimAlert: options.claimAlert || (async () => true),
    getSharedAlertState: options.getSharedAlertState || (async () => null),
    isSharedProblem: options.isSharedProblem || (() => false),
    resolveAlert: options.resolveAlert || (async () => {}),
    verifiedProblemKeys: options.verifiedProblemKeys || verifiedLoginProbeKeys,
    deferFailure: options.deferFailure || (async () => null),
    recoveryWindowMs: options.recoveryWindowMs ?? configuredDuration(
      "HEALTH_RECOVERY_WINDOW_MS",
      defaultRecoveryWindowMs,
    ),
    retryIntervalMs: options.retryIntervalMs ?? configuredDuration(
      "HEALTH_RETRY_INTERVAL_MS",
      defaultRetryIntervalMs,
    ),
    previewTimeoutMs: options.previewTimeoutMs ?? configuredDuration(
      "LOGIN_HEALTHCHECK_TIMEOUT_MS",
      defaultPreviewTimeoutMs,
    ),
  });
}

async function probeMain() {
  loadEnv();
  const timeoutMs = configuredDuration(
    "LOGIN_PROBE_TIMEOUT_MS",
    defaultPreviewTimeoutMs,
  );
  const problems = await inspectLogins(timeoutMs);
  if (problems.length > 0) {
    throw new Error(`登录态异常：${problems.join("；")}`);
  }
  console.log("login-ok");
}

async function main() {
  loadEnv();
  try {
    await withLock("login-healthcheck", {
      waitMs: 5000,
      staleMs: 45 * 60 * 1000,
    }, async () => {
      const result = await checkLoginHealth({
        claimAlert: claimHealthAlert,
        getSharedAlertState: getHealthAlertState,
        isSharedProblem: isSharedHealthProblem,
        resolveAlert: resolveHealthAlert,
        deferFailure: deferZhimadiHealthFailure,
        isIncidentResolved: isZhimadiRepairIncidentResolved,
      });
      if (result.status === "failed") process.exitCode = 1;
    });
  } catch (error) {
    if (String(error.message || error).includes("等待 login-healthcheck 锁超时")) {
      console.log("login-healthcheck-already-running");
      return;
    }
    throw error;
  }
}

if (require.main === module) {
  const action = process.argv.includes("--probe-only") ? probeMain : main;
  action().catch((error) => {
    console.error(error.stack || error.message);
    writeHealthFailure(error);
    process.exit(1);
  });
}

module.exports = {
  checkLoginHealth,
  classifyLoginFailure,
  createLoginProbe,
  inspectLogins,
  persistObservedZhimadiRecovery,
  runLoginInspection,
};
