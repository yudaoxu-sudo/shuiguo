const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { loadEnv, sendDingTalkMarkdown } = require("./send-dingtalk.cjs");
const {
  claimHealthAlert,
  getHealthAlertState,
  isSharedHealthProblem,
  resolveHealthAlert,
} = require("./health-alert-claim.cjs");
const {
  extractHealthFailure,
  finalHealthFailureMessage,
} = require("./healthcheck-error.cjs");
const { withLock } = require("./runtime-lock.cjs");

const statePath = path.resolve("output/report-health-state.json");
const defaultPreviewTimeoutMs = 10 * 60 * 1000;
const defaultFinalVerificationTimeoutMs = 2 * 60 * 1000;
const defaultRecoveryWindowMs = 20 * 60 * 1000;
const defaultRetryIntervalMs = 60 * 1000;
const activeIncidentStatuses = new Set([
  "recovering",
  "waiting-login-captcha",
  "alerting",
  "alert-unknown",
  "failed",
]);

function configuredDuration(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function todayText() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function activeIncidentStartedAt(state, now) {
  if (!activeIncidentStatuses.has(state?.status)) return null;
  const startedAt = Date.parse(state?.incidentStartedAt || "");
  if (!Number.isFinite(startedAt) || startedAt > now) return null;
  return startedAt;
}

function stableFailureKey(message) {
  return String(message)
    .replace(/\/\S*output\/debug\/\S+/g, "[debug]")
    .replace(/\b\d{13}\b/g, "[timestamp]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function classifyReportFailure(message) {
  const text = String(message || "");
  if (text.includes("芝麻地验证码已发送到钉钉")) {
    return {
      problemKey: "zhimadi-login",
      retryable: true,
      captchaPromptSent: true,
    };
  }
  if (
    text.includes("芝麻地登录态失效")
    || text.includes("等待芝麻地自动登录修复")
    || text.includes("芝麻地自动登录修复失败")
  ) {
    return { problemKey: "zhimadi-login", retryable: true };
  }
  if (text.includes("芝麻地")) {
    return { problemKey: "zhimadi-report", retryable: true };
  }
  if (text.includes("乐檬登录态失效")) {
    return { problemKey: "lemeng-login", retryable: true };
  }
  if (text.includes("乐檬")) {
    return { problemKey: "lemeng-report", retryable: true };
  }
  if (text.includes("抖音")) {
    return { problemKey: "douyin-report", retryable: true };
  }
  if (
    text.includes("browser-profile")
    || text.includes("报表预检超时")
    || /(?:Timeout|超时|net::|ERR_)/i.test(text)
  ) {
    return { problemKey: "report-transient", retryable: true };
  }
  return {
    problemKey: `report-fatal:${stableFailureKey(text)}`,
    retryable: false,
  };
}

function incidentFromState(state, problemKey, now, recoveryWindowMs) {
  const startedAt = activeIncidentStartedAt(state, now);
  if (startedAt === null || state?.problemKey !== problemKey) return null;
  const persistedDeadline = Date.parse(state?.recoveryDeadlineAt || "");
  const deadline = Number.isFinite(persistedDeadline)
    && persistedDeadline >= startedAt
    ? persistedDeadline
    : startedAt + recoveryWindowMs;
  return {
    id: state.incidentId || new Date(startedAt).toISOString(),
    problemKey,
    startedAt,
    deadline,
  };
}

function incidentState(status, incident, checkedAt, attempt, message, extra = {}) {
  return {
    status,
    incidentId: incident.id,
    problemKey: incident.problemKey,
    incidentStartedAt: new Date(incident.startedAt).toISOString(),
    recoveryDeadlineAt: new Date(incident.deadline).toISOString(),
    lastCheckAt: checkedAt,
    attempts: attempt,
    ...extra,
    message,
  };
}

function existingAlert(state, incidentId) {
  if (state?.incidentId !== incidentId) return {};
  return {
    ...(state.lastAlertAttemptAt
      ? { lastAlertAttemptAt: state.lastAlertAttemptAt }
      : {}),
    ...(state.lastAlertAt ? { lastAlertAt: state.lastAlertAt } : {}),
  };
}

function terminateChildTree(child, signal) {
  if (!child?.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when the process group is already gone.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process already exited.
  }
}

function runNodePreview(scriptPath, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? configuredDuration(
      "REPORT_HEALTHCHECK_TIMEOUT_MS",
      defaultPreviewTimeoutMs,
    );
    const label = options.label || "任务";
    const child = spawn(process.execPath, [scriptPath, ...(options.args || [])], {
      cwd: options.cwd || process.cwd(),
      env: {
        ...process.env,
        ...(options.env || {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let output = "";
    let settled = false;
    let timedOut = false;
    let killTimer;
    const timeoutError = new Error(
      `${label}超时 ${Math.round(timeoutMs / 1000)} 秒`,
    );
    timeoutError.code = "PREVIEW_TIMEOUT";
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      handler(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChildTree(child, "SIGTERM");
      killTimer = setTimeout(() => {
        terminateChildTree(child, "SIGKILL");
        finish(reject, timeoutError);
      }, 3000);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      if (timedOut) return;
      finish(reject, error);
    });
    child.on("close", (code) => {
      if (timedOut) return;
      if (code === 0) {
        finish(resolve, output);
      }
      else {
        const tail = output.split(/\r?\n/).slice(-20).join("\n");
        const error = new Error(`${label}退出码 ${code}\n${tail}`);
        const healthFailureMessage = extractHealthFailure(output);
        if (healthFailureMessage) {
          error.healthFailureMessage = healthFailureMessage;
        }
        finish(reject, error);
      }
    });
  });
}

function runReportPreview(options = {}) {
  const scriptPath = process.env.DUAL_DOUYIN_REPORT_DATE === todayText()
    ? "scripts/send-dual-douyin-report.cjs"
    : "scripts/daily-report.cjs";
  return runNodePreview(scriptPath, {
    timeoutMs: options.timeoutMs,
    label: "报表预检",
    env: {
      NO_DINGTALK: "1",
      REPORT_FAILURE_ALERTS: "false",
      HEALTHCHECK_PREVIEW: "1",
      ZHIMADI_REPAIR_FAILURE_ALERT_OWNER: "report-healthcheck",
      ...(options.verifyOnly ? { REPORT_MANAGED_BY_LISTENER: "1" } : {}),
    },
  });
}

function verifiedLoginKeys(failure) {
  if (failure.problemKey === "douyin-report") {
    return ["zhimadi-login", "lemeng-login"];
  }
  if (["lemeng-login", "lemeng-report"].includes(failure.problemKey)) {
    return ["zhimadi-login"];
  }
  return [];
}

async function resolveClaims(
  problemKeys,
  resolvedAt,
  probeStartedAt,
  resolveAlert,
  log,
) {
  for (const problemKey of problemKeys) {
    try {
      await resolveAlert(problemKey, resolvedAt, probeStartedAt);
    } catch (error) {
      log(`health-alert-resolve-failed: ${error.message || error}`);
    }
  }
}

async function checkReportHealth(options = {}) {
  const {
    now = () => Date.now(),
    loadState = () => readJson(statePath),
    persist = (state) => writeJson(statePath, state),
    runPreview = runReportPreview,
    sleep = delay,
    send = sendDingTalkMarkdown,
    log = console.log,
    classify = classifyReportFailure,
    alertTitle = "水果店报表预检失败",
    formatAlertText = ({ message, recoveryText }) =>
      `### 水果店报表预检失败\n\n${recoveryText}\n\n${message}`,
    logPrefix = "report",
    alertSource = `${logPrefix}-healthcheck`,
    claimAlert = async () => true,
    getSharedAlertState = async () => null,
    isSharedProblem = () => false,
    resolveAlert = async () => {},
    verifiedProblemKeys = verifiedLoginKeys,
    recoveryWindowMs = configuredDuration(
      "HEALTH_RECOVERY_WINDOW_MS",
      defaultRecoveryWindowMs,
    ),
    retryIntervalMs = configuredDuration(
      "HEALTH_RETRY_INTERVAL_MS",
      defaultRetryIntervalMs,
    ),
    previewTimeoutMs = configuredDuration(
      "REPORT_HEALTHCHECK_TIMEOUT_MS",
      defaultPreviewTimeoutMs,
    ),
    finalVerificationTimeoutMs = defaultFinalVerificationTimeoutMs,
  } = options;

  const initialNow = now();
  const initialState = loadState();
  let incident = initialState?.problemKey
    ? incidentFromState(
      initialState,
      initialState.problemKey,
      initialNow,
      recoveryWindowMs,
    )
    : null;
  let recoveryCeiling = incident
    && incident.deadline > initialNow
    && !initialState?.lastAlertAttemptAt
    ? incident.deadline
    : null;
  let attempt = 0;

  while (true) {
    attempt += 1;
    const attemptStartedAt = now();
    const remainingMs = incident ? incident.deadline - attemptStartedAt : null;
    const finalVerification = remainingMs !== null && remainingMs <= 0;
    const timeoutMs = finalVerification
      ? Math.max(1, Math.min(previewTimeoutMs, finalVerificationTimeoutMs))
      : remainingMs === null
        ? previewTimeoutMs
        : Math.max(1, Math.min(previewTimeoutMs, remainingMs));
    const deadlineBounded = remainingMs !== null
      && remainingMs > 0
      && timeoutMs < previewTimeoutMs;

    try {
      await runPreview({ timeoutMs, verifyOnly: finalVerification });
      const checkedAt = new Date(now()).toISOString();
      persist({
        status: "ok",
        lastCheckAt: checkedAt,
      });
      await resolveClaims(
        ["zhimadi-login", "lemeng-login"],
        checkedAt,
        attemptStartedAt,
        resolveAlert,
        log,
      );
      log(`${logPrefix}-ok`);
      return { status: "ok", attempts: attempt };
    } catch (error) {
      const failedAt = now();
      const checkedAt = new Date(failedAt).toISOString();
      const state = loadState();
      const latestMessage = finalHealthFailureMessage(error).slice(0, 1200);
      let message = latestMessage;
      let failure = classify(message);
      if (
        error?.code === "PREVIEW_TIMEOUT"
        && (finalVerification || (deadlineBounded && failedAt >= incident?.deadline))
        && incident
        && state?.incidentId === incident.id
        && state?.problemKey === incident.problemKey
        && state?.message
      ) {
        const previousMessage = String(state.message).slice(0, 1200);
        const previousFailure = classify(previousMessage);
        if (previousFailure.problemKey === incident.problemKey) {
          const suffix = `\n最终复验：${latestMessage}`.slice(0, 1200);
          const prefixLength = Math.max(0, 1200 - suffix.length);
          message = `${previousMessage.slice(0, prefixLength)}${suffix}`;
          failure = previousFailure;
        }
      }
      const sharedAlertState = await getSharedAlertState(failure.problemKey);
      const sharedResolvedAt = Date.parse(
        sharedAlertState?.resolvedAt || "",
      );
      const sharedRecovered = incident
        && incident.problemKey === failure.problemKey
        && sharedAlertState?.status === "resolved"
        && Number.isFinite(sharedResolvedAt)
        && sharedResolvedAt > incident.startedAt;
      if (sharedRecovered) {
        incident = null;
        recoveryCeiling = null;
      }
      await resolveClaims(
        verifiedProblemKeys(failure, message),
        checkedAt,
        attemptStartedAt,
        resolveAlert,
        log,
      );

      if (!incident || incident.problemKey !== failure.problemKey) {
        const persistedIncident = sharedRecovered
          ? null
          : incidentFromState(
            state,
            failure.problemKey,
            failedAt,
            recoveryWindowMs,
          );
        if (persistedIncident) {
          incident = persistedIncident;
          recoveryCeiling ??= incident.deadline;
        } else {
          const proposedDeadline = failedAt
            + (failure.retryable ? recoveryWindowMs : 0);
          const deadline = failure.retryable && recoveryCeiling !== null
            ? Math.max(failedAt, Math.min(proposedDeadline, recoveryCeiling))
            : proposedDeadline;
          incident = {
            id: new Date(failedAt).toISOString(),
            problemKey: failure.problemKey,
            startedAt: failedAt,
            deadline,
          };
          if (failure.retryable) recoveryCeiling ??= deadline;
        }
      }

      if (failure.captchaPromptSent && failedAt < incident.deadline) {
        const waitMs = incident.deadline - failedAt;
        persist(incidentState(
          "waiting-login-captcha",
          incident,
          checkedAt,
          attempt,
          message,
          {
            captchaPromptSentAt: state?.incidentId === incident.id
              ? state.captchaPromptSentAt || checkedAt
              : checkedAt,
            nextRetryAt: new Date(incident.deadline).toISOString(),
          },
        ));
        log(`${logPrefix}-waiting-login-captcha`);
        await sleep(waitMs);
        continue;
      }

      if (failure.retryable && failedAt < incident.deadline) {
        const nextRetryMs = Math.max(
          1000,
          Math.min(retryIntervalMs, incident.deadline - failedAt),
        );
        persist(incidentState(
          "recovering",
          incident,
          checkedAt,
          attempt,
          message,
          {
            nextRetryAt: new Date(failedAt + nextRetryMs).toISOString(),
            ...(state?.incidentId === incident.id && state.captchaPromptSentAt
              ? { captchaPromptSentAt: state.captchaPromptSentAt }
              : {}),
            ...existingAlert(state, incident.id),
          },
        ));
        log(`${logPrefix}-recovering: attempt ${attempt}`);
        await sleep(nextRetryMs);
        continue;
      }

      const latestState = loadState();
      const latestAlert = existingAlert(latestState, incident.id);
      const localAlertAvailable = isSharedProblem(incident.problemKey)
        || (
          !latestAlert.lastAlertAttemptAt
          && !latestAlert.lastAlertAt
        );
      let alertSent = false;

      if (localAlertAvailable) {
        const claimed = await claimAlert(
          incident.problemKey,
          checkedAt,
          alertSource,
        ).catch((error) => {
          persist(incidentState(
            "failed",
            incident,
            checkedAt,
            attempt,
            message,
            {
              sharedClaimErrorAt: checkedAt,
              sharedClaimError: String(error.message || error).slice(0, 300),
            },
          ));
          throw error;
        });
        if (!claimed) {
          persist(incidentState(
            "failed",
            incident,
            checkedAt,
            attempt,
            message,
            {
              ...latestAlert,
              sharedAlertSuppressedAt: checkedAt,
            },
          ));
        } else {
          persist(incidentState(
            "alerting",
            incident,
            checkedAt,
            attempt,
            message,
            { lastAlertAttemptAt: checkedAt },
          ));
          try {
            const recoveryText = failure.retryable
              ? `系统已静默自动复验至少 ${Math.round(recoveryWindowMs / 60000)} 分钟，仍未恢复。`
              : "检测到无法自动修复的预检错误。";
            await send(
              alertTitle,
              formatAlertText({ message, recoveryText, failure }),
              { alert: true },
            );
          } catch (sendError) {
            persist(incidentState(
              "alert-unknown",
              incident,
              checkedAt,
              attempt,
              message,
              { lastAlertAttemptAt: checkedAt },
            ));
            throw sendError;
          }

          alertSent = true;
          persist(incidentState(
            "failed",
            incident,
            checkedAt,
            attempt,
            message,
            {
              lastAlertAttemptAt: checkedAt,
              lastAlertAt: checkedAt,
            },
          ));
        }
      } else {
        persist(incidentState(
          "failed",
          incident,
          checkedAt,
          attempt,
          message,
          latestAlert,
        ));
      }

      log(alertSent
        ? `${logPrefix}-failed-alert-sent`
        : `${logPrefix}-failed-alert-suppressed`);
      return {
        status: "failed",
        attempts: attempt,
        alerted: alertSent,
      };
    }
  }
}

async function main() {
  loadEnv();
  try {
    await withLock("report-healthcheck", {
      waitMs: 5000,
      staleMs: 45 * 60 * 1000,
    }, async () => {
      const result = await checkReportHealth({
        claimAlert: claimHealthAlert,
        getSharedAlertState: getHealthAlertState,
        isSharedProblem: isSharedHealthProblem,
        resolveAlert: resolveHealthAlert,
      });
      if (result.status === "failed") process.exitCode = 1;
    });
  } catch (error) {
    if (String(error.message || error).includes("等待 report-healthcheck 锁超时")) {
      console.log("report-healthcheck-already-running");
      return;
    }
    throw error;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = {
  activeIncidentStartedAt,
  checkReportHealth,
  classifyReportFailure,
  readJson,
  runNodePreview,
  runReportPreview,
  terminateChildTree,
  writeJson,
};
