const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { DWClient, TOPIC_ROBOT } = require("dingtalk-stream");
const { acquireLock } = require("./runtime-lock.cjs");
const { gotoZhimadi, isZhimadiAuthenticated } = require("./zhimadi-navigation.cjs");
const {
  activeIncidentId,
  createZhimadiRepairCoordinator,
  markManualRepair,
  requesterCanResumeReport,
  runSingleCaptchaAttempt,
} = require("./zhimadi-repair-coordinator.cjs");
const {
  requestTimeoutMs,
  requestTimeoutSignal,
  sendDingTalkImage,
  sendDingTalkMarkdown,
  withPromiseTimeout,
} = require("./send-dingtalk.cjs");
const {
  handleHistoryCommand,
  parseHistoryCommand,
} = require("./report-history.cjs");
const {
  clearSmsCode,
  createSmsSession,
  handleSmsCodeReply,
  sendSmsRepairNotice,
  smsRequestFilePath,
  writeJsonAtomic,
  writeSmsCode,
} = require("./douyin-sms-repair.cjs");
const {
  deliverLemengSmsCode,
  extractLemengSmsCode,
  extractPendingSmsCode,
  isLemengLoginCommand,
  readLemengLoginStatus,
  startLemengLogin,
} = require("./lemeng-sms-bridge.cjs");

const heartbeatPath = path.resolve("output/listener-heartbeat.json");
const commandStatePath = path.resolve("output/listener-command-state.json");
const groupContextPath = path.resolve("output/listener-group-context.json");
const repairRequestPath = path.resolve("output/zhimadi-login-repair-request.json");
const repairStatePath = path.resolve("output/zhimadi-login-repair-state.json");
const douyinSmsStatePath = path.resolve("output/douyin-sms-repair-state.json");
const douyinSmsTargetPath = path.resolve("output/douyin-sms-repair-target.json");
const duplicateWindowMs = 3 * 60 * 1000;
const loginSessionTtlMs = 5 * 60 * 1000;
const captchaSelector = "#verifyCode";

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

function writeHeartbeat(status = "running") {
  fs.mkdirSync(path.dirname(heartbeatPath), { recursive: true });
  fs.writeFileSync(heartbeatPath, JSON.stringify({
    status,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

function chromeExecutablePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  return undefined;
}

function messageText(message) {
  return String(message?.text?.content || "").replace(/\s+/g, "").trim();
}

function commandKey(message, text) {
  const messageId = message?.msgId || message?.messageId || message?.msgid;
  if (messageId) return `message:${messageId}`;

  return [
    "fallback",
    message?.conversationId || message?.conversationTitle || "",
    message?.senderStaffId || message?.senderId || "",
    text,
  ].join(":");
}

function errorSummary(error) {
  return String(error?.output || error?.message || error)
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-8)
    .join("\n")
    .slice(0, 900);
}

function localDateText(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function hasBoundLoginContext(message) {
  return Boolean(
    message?.conversationId
    && message?.senderStaffId
    && message?.robotCode,
  );
}

function promptDeliveryDefinitelyNotSent(error) {
  if (error?.code === "PROMISE_TIMEOUT") return true;
  const text = errorSummary(error).toLowerCase();
  return !/timeout|timed out|abort|fetch failed|network/.test(text);
}

async function sendBestEffort(label, send, warn = console.warn) {
  try {
    await send();
    return true;
  } catch (error) {
    warn(`${label}发送失败：${errorSummary(error)}`);
    return false;
  }
}

function runWithTaskWatchdog(task, {
  timeoutMs,
  label = "后台任务",
  onTimeout = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`${label}看门狗超时配置无效`);
  }

  let timer;
  const timeout = new Promise((unused, reject) => {
    timer = setTimer(() => {
      const error = new Error(`${label}超过 ${timeoutMs}ms 未完成`);
      error.code = "TASK_WATCHDOG_TIMEOUT";
      try {
        onTimeout({ error, label, timeoutMs });
      } catch (timeoutError) {
        error.cause = timeoutError;
      }
      reject(error);
    }, timeoutMs);
  });
  const pending = Promise.resolve().then(task);

  return Promise.race([pending, timeout]).finally(() => {
    if (timer !== undefined) clearTimer(timer);
  });
}

async function notifyLockStalled(result, {
  send = sendDingTalkMarkdown,
  warn = console.warn,
} = {}) {
  if (result?.outcome !== "lock-stalled") return false;

  return sendBestEffort(
    "自动修复延迟通知",
    () => send(
      "水果店登录修复延迟",
      "### 水果店登录修复延迟\n\n自动修复已持续超过三小时，浏览器任务仍占用登录资源。后台会继续重试；若数小时后仍未恢复，再需要人工处理。",
      { alert: true },
    ),
    warn,
  );
  return true;
}

function loadCommandState() {
  try {
    return JSON.parse(fs.readFileSync(commandStatePath, "utf8"));
  } catch {
    return { commands: [] };
  }
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

// 钉钉 conversationType："1" 是单聊，"2" 是群聊。
// 单聊不能覆盖群上下文，否则芝麻地验证码图会跑到私聊里去，
// 那就等于改了群里原有的行为。
function isGroupConversation(message) {
  return String(message?.conversationType ?? "2") === "2";
}

function saveGroupContext(message) {
  if (!message?.conversationId || !message?.robotCode) return;
  if (!isGroupConversation(message)) return;
  writeJson(groupContextPath, {
    conversationId: message.conversationId,
    robotCode: message.robotCode,
    sessionWebhook: message.sessionWebhook || "",
    senderStaffId: message.senderStaffId || "",
    savedAt: new Date().toISOString(),
  });
}

function loadGroupContext() {
  const context = readJson(groupContextPath);
  if (!context?.conversationId || !context?.robotCode) return null;
  return context;
}

function saveDouyinSmsTarget(
  message,
  text,
  {
    filePath = douyinSmsTargetPath,
    now = Date.now(),
  } = {},
) {
  if (String(text || "").trim() !== "准备抖音短信") return false;
  if (!message?.conversationId || !message?.senderStaffId) return false;
  writeJsonAtomic(filePath, {
    conversationId: String(message.conversationId),
    senderStaffId: String(message.senderStaffId),
    sessionWebhook: String(message.sessionWebhook || ""),
    savedAt: new Date(now).toISOString(),
  });
  return true;
}

function loadDouyinSmsTarget(filePath = douyinSmsTargetPath) {
  const target = readJson(filePath);
  if (!target?.conversationId || !target?.senderStaffId || !target?.savedAt) {
    return null;
  }
  return target;
}

function createDouyinSmsFlow({
  loadState = () => readJson(douyinSmsStatePath) || {},
  persistState = (state) => writeJsonAtomic(douyinSmsStatePath, state),
  loadRequest = () => readJson(smsRequestFilePath()),
  loadContext = loadDouyinSmsTarget,
  deliver = (code) => writeSmsCode(code),
  clearDelivery = () => clearSmsCode(),
  sessionSend,
  webhookSend,
  now = Date.now,
  requestTtlMs = 5 * 60 * 1000,
  contextTtlMs = 5 * 60 * 1000,
  promptClaimTtlMs = 60 * 1000,
} = {}) {
  async function handleRepairRequest() {
    const request = loadRequest();
    if (!request?.requestedAt) return { outcome: "no-request" };

    const currentNow = now();
    const requestedAt = Date.parse(request.requestedAt);
    if (
      !Number.isFinite(requestedAt)
      || requestedAt > currentNow
      || currentNow - requestedAt > requestTtlMs
    ) {
      return { outcome: "stale-request" };
    }

    const state = loadState();
    const requestId = request.requestId || request.requestedAt;
    if (
      state.handledRequestId === requestId
      || (
        !request.requestId
        && state.handledRequestAt === request.requestedAt
      )
    ) {
      return { outcome: "already-handled" };
    }
    const promptingStartedAt = Date.parse(
      state.promptingStartedAt || state.promptingRequestAt || "",
    );
    const promptClaimIsLive = Number.isFinite(promptingStartedAt)
      && promptingStartedAt <= currentNow + promptClaimTtlMs
      && currentNow - promptingStartedAt <= promptClaimTtlMs;
    if (
      state.promptingRequestId === requestId
      && state.promptStatus !== "failed"
      && promptClaimIsLive
    ) {
      return { outcome: "prompt-in-progress" };
    }

    const context = loadContext() || {};
    const requestConversationId = String(request.conversationId || "");
    const requestSenderStaffId = String(request.senderStaffId || "");
    const requestHasConversation = Boolean(requestConversationId);
    const requestHasSender = Boolean(requestSenderStaffId);
    if (requestHasConversation !== requestHasSender) {
      return { outcome: "invalid-binding" };
    }

    const requestIsBound = requestHasConversation && requestHasSender;
    const contextConversationId = String(context.conversationId || "");
    const contextSenderStaffId = String(context.senderStaffId || "");
    const contextSavedAt = Date.parse(context.savedAt || "");
    const contextIsFresh = Number.isFinite(contextSavedAt)
      && contextSavedAt <= currentNow
      && currentNow - contextSavedAt <= contextTtlMs;

    if (
      !requestIsBound
      && (
        !contextConversationId
        || !contextSenderStaffId
        || !contextIsFresh
      )
    ) {
      return { outcome: "missing-context" };
    }
    const conversationId = requestIsBound
      ? requestConversationId
      : contextConversationId;
    const senderStaffId = requestIsBound
      ? requestSenderStaffId
      : contextSenderStaffId;
    const contextMatchesBinding = contextConversationId === conversationId
      && contextSenderStaffId === senderStaffId;
    const noticeContext = contextMatchesBinding
      ? context
      : { conversationId, senderStaffId };

    // 上一轮没被 douyin-login 消费的旧码要先清掉，否则新一轮登录会立刻吞掉旧码。
    clearDelivery();
    const session = createSmsSession({
      now: currentNow,
      reason: request.reason || "",
      conversationId,
      senderStaffId,
    });
    const promptingState = {
      promptingRequestId: requestId,
      promptingRequestAt: request.requestedAt,
      promptingStartedAt: new Date(currentNow).toISOString(),
      session,
      // 去重记录跨会话保留：紧接着的新会话不能把钉钉重投递的旧回复当成新码。
      seenReplies: state.seenReplies || [],
    };
    persistState(promptingState);

    try {
      const channel = await sendSmsRepairNotice({
        message: null,
        groupContext: noticeContext,
        content: "抖音来客登录需要手机短信验证码，回复：短信码123456",
        sessionSend,
        webhookSend,
      });
      persistState({
        ...promptingState,
        handledRequestId: requestId,
        handledRequestAt: request.requestedAt,
        promptingRequestId: null,
        promptingRequestAt: null,
        promptingStartedAt: null,
      });
      return { outcome: "prompted", channel, session };
    } catch (error) {
      persistState({
        ...promptingState,
        promptStatus: "failed",
        lastPromptError: String(error.message || error).slice(0, 300),
      });
      return {
        outcome: "prompt-failed",
        error: error.message,
        session,
      };
    }
  }

  async function handleMessage(message, text) {
    const state = loadState();
    return handleSmsCodeReply({
      session: state.session,
      message,
      text,
      now: now(),
      seenReplies: state.seenReplies,
      persist: ({ session, seenReplies }) => persistState({ ...state, session, seenReplies }),
      deliver,
      notify: (content) => sendSmsRepairNotice({
        message,
        groupContext: loadContext(),
        content,
        sessionSend,
        webhookSend,
      }),
    });
  }

  return { handleRepairRequest, handleMessage };
}

function rememberCommand(key) {
  const now = Date.now();
  const cutoff = now - duplicateWindowMs;
  const state = loadCommandState();
  const commands = Array.isArray(state.commands)
    ? state.commands.filter((item) => item && item.at >= cutoff)
    : [];

  if (commands.some((item) => item.key === key)) {
    return false;
  }

  commands.push({ key, at: now });
  fs.mkdirSync(path.dirname(commandStatePath), { recursive: true });
  fs.writeFileSync(commandStatePath, JSON.stringify({ commands }, null, 2));
  return true;
}

async function sendSessionText(client, sessionWebhook, senderStaffId, content) {
  if (!sessionWebhook) return;

  const accessToken = await withPromiseTimeout(
    () => client.getAccessToken(),
    { label: "钉钉访问令牌" },
  );
  const response = await fetch(sessionWebhook, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-acs-dingtalk-access-token": accessToken,
    },
    body: JSON.stringify({
      msgtype: "text",
      text: { content },
      at: {
        atUserIds: senderStaffId ? [senderStaffId] : [],
        isAtAll: false,
      },
    }),
    signal: requestTimeoutSignal(),
  });
  const result = await response.text();
  if (!response.ok) {
    throw new Error(`钉钉会话回复失败: ${response.status} ${result}`);
  }
  if (result) {
    try {
      const parsed = JSON.parse(result);
      if (Number(parsed.errcode || 0) !== 0) {
        throw new Error(`钉钉会话回复失败: ${result}`);
      }
    } catch (error) {
      if (error.message.startsWith("钉钉会话回复失败:")) throw error;
    }
  }
}

function stopChildProcessGroup(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The child already exited.
    }
  }
}

function runReportChild(args, {
  env,
  label,
  timeoutMs = requestTimeoutMs("REPORT_RESUME_TIMEOUT_MS", 15 * 60 * 1000),
  killGraceMs = 5000,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let output = "";
    let timedOut = false;
    let settled = false;
    let killTimer;
    const timeout = setTimeout(() => {
      timedOut = true;
      stopChildProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(() => {
        stopChildProcessGroup(child, "SIGKILL");
      }, killGraceMs);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
      process.stderr.write(chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) {
        const error = new Error(`${label}超时 ${Math.round(timeoutMs / 1000)} 秒`);
        error.exitCode = 1;
        error.output = output;
        reject(error);
      } else if (code === 0) resolve(output);
      else {
        const error = new Error(`${label}退出码 ${code}`);
        error.exitCode = code;
        error.output = output;
        reject(error);
      }
    });
  });
}

function runMonthlyReport(reportDate, {
  currentDate = localDateText,
  runChild = runReportChild,
  env = process.env,
} = {}) {
  const targetDate = reportDate || currentDate();
  return runChild(["scripts/daily-report.cjs"], {
    label: "月报脚本",
    env: {
      ...env,
      REPORT_MANAGED_BY_LISTENER: "1",
      REPORT_FAILURE_ALERTS: "false",
      REPORT_TARGET_DATE: targetDate,
    },
  });
}

function scheduledResumeTimeoutMs(env = process.env) {
  const configuredInner = Number(env.SCHEDULED_REPORT_TIMEOUT_MS);
  const innerTimeoutMs = Number.isFinite(configuredInner) && configuredInner > 0
    ? configuredInner
    : 15 * 60 * 1000;
  const configuredOuter = Number(env.SCHEDULED_REPORT_RESUME_TIMEOUT_MS);
  const requestedOuter = Number.isFinite(configuredOuter) && configuredOuter > 0
    ? configuredOuter
    : innerTimeoutMs + 60 * 1000;
  return Math.max(requestedOuter, innerTimeoutMs + 30 * 1000);
}

function runScheduledReport(reportDate) {
  return runReportChild(["scripts/run-scheduled-report.cjs"], {
    label: "定时报表续跑",
    timeoutMs: scheduledResumeTimeoutMs(),
    env: {
      ...process.env,
      ...(reportDate ? { REPORT_TARGET_DATE: reportDate } : {}),
    },
  });
}

function selectReportRunner(reportResumeMode, {
  scheduled = runScheduledReport,
  monthly = runMonthlyReport,
  reportDate,
} = {}) {
  return reportResumeMode === "scheduled"
    ? () => scheduled(reportDate)
    : () => monthly(reportDate);
}

function isDeferredMonthlyReportError(error) {
  return error?.exitCode === 2;
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function reportResumeClaimIsActive(state, {
  now = Date.now(),
  isRunning = isProcessRunning,
} = {}) {
  if (!state?.reportResumeClaimedAt) return false;
  if (state.reportResumeOwner === "requester") {
    const leaseUntil = Date.parse(state.reportResumeLeaseUntil || "");
    return Number.isFinite(leaseUntil)
      && leaseUntil > now
      && isRunning(Number(state.reportResumeOwnerPid));
  }

  const leaseUntil = Date.parse(state.reportResumeLeaseUntil || "");
  return Number.isFinite(leaseUntil)
    && leaseUntil > now
    && isRunning(Number(state.reportResumeOwnerPid));
}

function clearReportResumeClaim(state) {
  const nextState = { ...state };
  delete nextState.reportResumeClaimId;
  delete nextState.reportResumeClaimedAt;
  delete nextState.reportResumeOwner;
  delete nextState.reportResumeOwnerPid;
  delete nextState.reportResumeLeaseUntil;
  return nextState;
}

function promoteLatestListenerResumeIntent(state, blockedAt, currentReportDate) {
  const intent = state?.latestListenerResumeIntent;
  if (
    intent?.reportResumeMode !== "listener"
    || !intent.requestedAt
    || !intent.reportDate
    || intent.reportDate !== currentReportDate
  ) return null;

  const nextState = clearReportResumeClaim(state);
  nextState.blockedScheduledResumeIntent = {
    requestedAt: state.reportRequestedAt || state.incidentStartedAt || null,
    reportResumeMode: "scheduled",
    reportDate: state.reportDate || null,
    blockedAt,
    reason: "date-rollover-unverified-sources",
  };
  nextState.afterLoginReport = true;
  nextState.reportResumeMode = "listener";
  nextState.reportDate = intent.reportDate;
  nextState.requesterPid = Number.isInteger(intent.requesterPid)
    ? intent.requesterPid
    : null;
  nextState.requesterResumeMode = "listener";
  nextState.reportRequestedAt = intent.requestedAt;
  nextState.handledListenerResumeRequestAt = intent.requestedAt;
  nextState.updatedAt = blockedAt;
  delete nextState.latestListenerResumeIntent;
  delete nextState.reportResumeCompletedAt;
  delete nextState.reportResumeDateBlockedAt;
  delete nextState.reportResumeBlockedReason;
  delete nextState.reportResumeStartedAt;
  delete nextState.reportResumeAttemptCount;
  delete nextState.reportResumeLastFailedAt;
  delete nextState.reportResumeLastFailure;
  delete nextState.reportResumeNextAttemptAt;
  delete nextState.reportResumeAlertAttemptedAt;
  return nextState;
}

function canonicalReportDate(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text
    ? text
    : null;
}

function createReportResumeFlow({
  loadState,
  persistState,
  runReport,
  sendAlert = sendDingTalkMarkdown,
  now = Date.now,
  isRunning = isProcessRunning,
  processId = process.pid,
  requesterGraceMs = Number(
    process.env.ZHIMADI_REQUESTER_GRACE_MS || 4 * 60 * 1000,
  ),
  retryDelayMs = 15 * 60 * 1000,
  alertDelayMs = 3 * 60 * 60 * 1000,
  currentDate = localDateText,
} = {}) {
  if (
    typeof loadState !== "function"
    || typeof persistState !== "function"
    || typeof runReport !== "function"
  ) {
    throw new Error("报表续跑流程缺少依赖");
  }

  return async function resumeReportAfterRepair(state) {
    if (state?.afterLoginReport !== true || state.reportResumeCompletedAt) return;
    const currentTime = now();
    const currentReportDate = currentDate(currentTime);
    if (
      state.reportResumeMode === "listener"
      && canonicalReportDate(state.reportDate) !== currentReportDate
    ) {
      const blockedAt = new Date(currentTime).toISOString();
      const blockedState = clearReportResumeClaim(state);
      blockedState.afterLoginReport = false;
      blockedState.blockedListenerResumeIntent = {
        requestedAt: state.reportRequestedAt || null,
        reportResumeMode: "listener",
        reportDate: state.reportDate || null,
        blockedAt,
        reason: "date-rollover-unverified-sources",
      };
      blockedState.reportResumeDateBlockedAt = blockedAt;
      blockedState.reportResumeBlockedReason = "date-rollover-unverified-sources";
      blockedState.updatedAt = blockedAt;
      persistState(blockedState);
      await sendAlert(
        "水果店跨日手动报表未自动补发",
        "### 水果店跨日手动报表未自动补发\n\n手动报表的目标日期已经变化，本次未自动推送，避免把新一天的数据回应到旧请求。",
        { alert: true },
      ).catch((error) => {
        console.warn(`跨日手动报表提示发送失败：${errorSummary(error)}`);
      });
      return;
    }
    if (
      state.reportResumeMode === "scheduled"
      && !canonicalReportDate(state.reportDate)
    ) {
      const blockedAt = new Date(currentTime).toISOString();
      const blockedState = clearReportResumeClaim(state);
      blockedState.reportResumeDateBlockedAt = blockedAt;
      blockedState.reportResumeBlockedReason = "missing-or-invalid-target-date";
      blockedState.updatedAt = blockedAt;
      const promotedState = promoteLatestListenerResumeIntent(
        blockedState,
        blockedAt,
        currentReportDate,
      );
      if (promotedState) {
        state = promotedState;
      } else {
        if (blockedState.latestListenerResumeIntent) {
          blockedState.blockedListenerResumeIntent = {
            ...blockedState.latestListenerResumeIntent,
            blockedAt,
            reason: "date-rollover-unverified-sources",
          };
          delete blockedState.latestListenerResumeIntent;
        }
        blockedState.afterLoginReport = false;
        state = blockedState;
      }
      persistState(state);
      await sendAlert(
        "水果店报表目标日期缺失",
        "### 水果店报表目标日期缺失\n\n旧定时报表没有可信目标日期，本次未自动推送，避免把当前数据误记到未知日期。",
        { alert: true },
      ).catch((error) => {
        console.warn(`报表目标日期提示发送失败：${errorSummary(error)}`);
      });
      if (!promotedState) return;
    }
    if (
      state.reportResumeMode === "scheduled"
      && state.reportDate
      && state.reportDate !== currentReportDate
    ) {
      const incidentDeadline = Date.parse(state.deadlineAt || "");
      if (Number.isFinite(incidentDeadline) && currentTime < incidentDeadline) return;
      if (state.reportResumeDateBlockedAt && !state.latestListenerResumeIntent) return;

      const blockedAt = new Date(currentTime).toISOString();
      const blockedState = clearReportResumeClaim(state);
      blockedState.reportResumeDateBlockedAt = blockedAt;
      blockedState.reportResumeBlockedReason = "date-rollover-unverified-sources";
      blockedState.updatedAt = blockedAt;
      const promotedState = promoteLatestListenerResumeIntent(
        blockedState,
        blockedAt,
        currentReportDate,
      );
      if (promotedState) {
        state = promotedState;
      } else {
        if (blockedState.latestListenerResumeIntent) {
          blockedState.blockedListenerResumeIntent = {
            ...blockedState.latestListenerResumeIntent,
            blockedAt,
            reason: "date-rollover-unverified-sources",
          };
          delete blockedState.latestListenerResumeIntent;
        }
        blockedState.afterLoginReport = false;
        state = blockedState;
      }
      persistState(state);
      await sendAlert(
        "水果店跨日报表未自动补发",
        `### 水果店跨日报表未自动补发\n\n${blockedState.reportDate} 的报表登录已恢复，但已经跨日。为避免把新一天或新月份的数据记入旧报表，本次未自动推送；下一次正常定时报表不受影响。`,
        { alert: true },
      ).catch((error) => {
        console.warn(`跨日报表提示发送失败：${errorSummary(error)}`);
      });
      if (!promotedState) return;
    }
    const retryAt = Date.parse(state.reportResumeNextAttemptAt || "");
    if (Number.isFinite(retryAt) && retryAt > currentTime) return;
    if (reportResumeClaimIsActive(state, { now: currentTime, isRunning })) return;

    const requesterOwnsResume = requesterCanResumeReport(state, {
      now: currentTime,
      isProcessRunning: isRunning,
      graceMs: requesterGraceMs,
    });
    const claimId = crypto.randomUUID();
    const claimedAt = new Date(currentTime).toISOString();
    const claimedState = {
      ...clearReportResumeClaim(state),
      reportResumeClaimId: claimId,
      reportResumeClaimedAt: claimedAt,
      reportResumeOwner: requesterOwnsResume ? "requester" : "listener",
      reportResumeOwnerPid: requesterOwnsResume
        ? Number(state.requesterPid)
        : processId,
      reportResumeLeaseUntil: new Date(
        currentTime + (requesterOwnsResume ? 60 : 20) * 60 * 1000,
      ).toISOString(),
      reportResumeStartedAt: state.reportResumeStartedAt || claimedAt,
      reportResumeAttemptCount: Number(state.reportResumeAttemptCount || 0) + 1,
    };
    delete claimedState.reportResumeNextAttemptAt;
    persistState(claimedState);
    if (requesterOwnsResume) return;

    try {
      await runReport(claimedState);
      const currentState = loadState();
      if (currentState?.reportResumeClaimId === claimId) {
        const completedState = clearReportResumeClaim(currentState);
        completedState.afterLoginReport = false;
        completedState.reportResumeCompletedAt = new Date(now()).toISOString();
        completedState.updatedAt = completedState.reportResumeCompletedAt;
        delete completedState.reportResumeLastFailure;
        delete completedState.reportResumeNextAttemptAt;
        persistState(completedState);
      }
    } catch (error) {
      const failedAt = now();
      const currentState = loadState();
      if (currentState?.reportResumeClaimId === claimId) {
        const failedState = clearReportResumeClaim(currentState);
        failedState.reportResumeLastFailedAt = new Date(failedAt).toISOString();
        failedState.reportResumeLastFailure = errorSummary(error);
        failedState.reportResumeNextAttemptAt = new Date(
          failedAt + retryDelayMs,
        ).toISOString();
        failedState.updatedAt = failedState.reportResumeLastFailedAt;
        const resumeStartedAt = Date.parse(failedState.reportResumeStartedAt || "");
        const shouldAlert = Number.isFinite(resumeStartedAt)
          && failedAt - resumeStartedAt >= alertDelayMs
          && !failedState.reportResumeAlertAttemptedAt;
        if (shouldAlert) {
          failedState.reportResumeAlertAttemptedAt = failedState.reportResumeLastFailedAt;
        }
        persistState(failedState);
        if (shouldAlert) {
          await sendAlert(
            "水果店报表续跑失败",
            `### 水果店报表续跑失败\n\n登录已恢复，但报表自动续跑超过 3 小时仍未成功。后台会继续每 15 分钟重试。\n\n${failedState.reportResumeLastFailure}`,
            { alert: true },
          ).catch((alertError) => {
            console.warn(`报表续跑失败通知发送失败：${errorSummary(alertError)}`);
          });
        }
      }
      throw error;
    }
  };
}

async function uploadDingTalkImage(client, filePath) {
  const accessToken = await withPromiseTimeout(
    () => client.getAccessToken(),
    { label: "钉钉访问令牌" },
  );
  const endpoints = [
    "https://oapi.dingtalk.io/media/upload",
    "https://oapi.dingtalk.com/media/upload",
  ];

  let lastError;
  for (const endpoint of endpoints) {
    const form = new FormData();
    const buffer = fs.readFileSync(filePath);
    form.append("access_token", accessToken);
    form.append("type", "image");
    form.append("media", new Blob([buffer], { type: "image/png" }), path.basename(filePath));

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        body: form,
        signal: requestTimeoutSignal(),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${response.status} ${text}`);

      const result = JSON.parse(text);
      if (result.errcode && result.errcode !== 0) throw new Error(text);
      return result.media_id;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`上传验证码图片失败: ${lastError?.message || "未知错误"}`);
}

async function sendGroupImage(client, message, mediaId) {
  const accessToken = await withPromiseTimeout(
    () => client.getAccessToken(),
    { label: "钉钉访问令牌" },
  );
  const body = {
    msgParam: JSON.stringify({ photoURL: mediaId }),
    msgKey: "sampleImageMsg",
    openConversationId: message.conversationId,
    robotCode: message.robotCode,
  };

  const endpoints = [
    "https://api.dingtalk.com/v1.0/robot/groupMessages/send",
    "https://api.dingtalk.io/v1.0/robot/groupMessages/send",
  ];

  let lastError;
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-acs-dingtalk-access-token": accessToken,
        },
        body: JSON.stringify(body),
        signal: requestTimeoutSignal(),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${response.status} ${text}`);
      const result = text ? JSON.parse(text) : {};
      if (result.code || result.errcode) throw new Error(text);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`发送验证码图片失败: ${lastError?.message || "未知错误"}`);
}

async function deliverBoundCaptchaImage({ upload, send }) {
  let mediaId;
  try {
    mediaId = await upload();
  } catch (error) {
    error.promptDefinitelyNotSent = true;
    throw error;
  }
  return send(mediaId);
}

async function sendCaptchaImage(client, message, filePath) {
  if (message?.conversationId && message?.robotCode) {
    await deliverBoundCaptchaImage({
      upload: () => uploadDingTalkImage(client, filePath),
      send: (mediaId) => sendGroupImage(client, message, mediaId),
    });
    return;
  }

  await sendDingTalkImage(filePath);
}

async function captureZhimadiCaptcha(session) {
  const outputDir = path.resolve("output/login-repair");
  fs.mkdirSync(outputDir, { recursive: true });

  const screenshotPath = path.join(outputDir, "zhimadi-login-current.png");
  const captchaPath = path.join(outputDir, "zhimadi-captcha-current.png");
  fs.rmSync(captchaPath, { force: true });

  const captcha = await waitForCaptchaReady(session.page);
  await session.page.screenshot({ path: screenshotPath, fullPage: true });
  await captcha.screenshot({ path: captchaPath });
  return { screenshotPath, captchaPath };
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

function extractCaptchaCode(text) {
  const compact = String(text || "").replace(/[^A-Za-z0-9]/g, "");
  return /^[A-Za-z0-9]{4,6}$/.test(compact) ? compact : "";
}

function extractManualCaptchaCode(text) {
  const normalized = String(text || "");
  const labeled = normalized.match(
    /(?:验证码|登录)[:：]?([A-Za-z0-9]{4,6})(?![A-Za-z0-9])/i,
  );
  return labeled ? labeled[1] : "";
}

function isLoginSessionReply(session, message) {
  return Boolean(
    session?.conversationId
    && session?.senderStaffId
    && session.conversationId === message?.conversationId
    && session.senderStaffId === message?.senderStaffId,
  );
}

async function recognizeCaptchaWithOpenAI(filePath) {
  if (!process.env.OPENAI_API_KEY) return "";

  const image = fs.readFileSync(filePath).toString("base64");
  const model = process.env.OPENAI_CAPTCHA_MODEL || "gpt-4o-mini";
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{
        role: "user",
        content: [
          {
            type: "text",
            text: "Read the verification code in this image. Return only the exact code, 4 to 6 letters or digits, preserving letter case. No spaces.",
          },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${image}` },
          },
        ],
      }],
      max_tokens: 16,
      temperature: 0,
    }),
    signal: requestTimeoutSignal("OCR_HTTP_TIMEOUT_MS"),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`验证码视觉识别失败: ${response.status} ${bodyText}`);
  }

  const body = JSON.parse(bodyText);
  return extractCaptchaCode(body.choices?.[0]?.message?.content);
}

function ddddocrPythonCommand() {
  if (process.env.DDDDOCR_PYTHON) return process.env.DDDDOCR_PYTHON;

  const venvPython = path.resolve(".venv/bin/python");
  if (fs.existsSync(venvPython)) return venvPython;

  return "python3";
}

function recognizeCaptchaWithDdddocr(filePath) {
  if (process.env.DDDDOCR_ENABLED === "false") return "";

  const scriptPath = path.resolve("scripts/recognize-captcha-ddddocr.py");
  const result = spawnSync(ddddocrPythonCommand(), [scriptPath, filePath], {
    encoding: "utf8",
    timeout: Number(process.env.DDDDOCR_TIMEOUT_MS || 15000),
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
    },
  });

  if (result.status !== 0) {
    const reason = String(result.stderr || result.error?.message || "").trim();
    if (reason) console.warn(`ddddocr识别不可用: ${reason}`);
    return "";
  }

  return extractCaptchaCode(result.stdout);
}

async function recognizeCaptcha(filePath) {
  const ddddocrCode = recognizeCaptchaWithDdddocr(filePath);
  if (ddddocrCode) return { code: ddddocrCode, source: "ddddocr" };

  const openaiCode = await recognizeCaptchaWithOpenAI(filePath);
  if (openaiCode) return { code: openaiCode, source: "openai" };

  return { code: "", source: "none" };
}

async function refreshZhimadiCaptcha(session) {
  await session.page.locator('input[name="verify_code"]').fill("").catch(() => {});
  await session.page.locator(captchaSelector).click().catch(() => {});
  await session.page.waitForTimeout(1000);
}

function retryableZhimadiRepairError(error) {
  if (error?.repairFatal === true) return false;
  return /(?:Timeout|超时|net::|ERR_|Target closed|browser has been closed|ECONN|socket|temporar|fetch failed|\b429\b|\b5\d\d\b|rate.?limit|service unavailable|overloaded)/i
    .test(String(error?.message || error));
}

function fatalZhimadiRepairError(message) {
  const error = new Error(message);
  error.repairFatal = true;
  return error;
}

async function tryAutoZhimadiLogin(
  session,
  maxAttempts = Number(process.env.ZHIMADI_CAPTCHA_AUTO_ATTEMPTS || 2),
) {

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runSingleCaptchaAttempt({
      capture: async () => {
        if (session.captchaPath) {
          const captchaPath = session.captchaPath;
          session.captchaPath = null;
          return { captchaPath };
        }
        return captureZhimadiCaptcha(session);
      },
      recognize: recognizeCaptcha,
      submit: (code) => clickZhimadiLogin(session, code),
      confirmAuthenticated: () => waitForZhimadiAuthenticated(session.page),
      isRetryableError: retryableZhimadiRepairError,
    });
    if (result.reason === "empty-code") {
      console.warn(`验证码自动识别第 ${attempt} 次无有效结果`);
      if (attempt === maxAttempts) return result;
      await refreshZhimadiCaptcha(session);
      continue;
    }
    if (result.outcome === "success") return result;
    if (result.outcome === "fatal") return result;

    console.warn(`验证码自动识别第 ${attempt} 次失败(${result.source || "unknown"}): ${result.error || result.reason}`);
    if (attempt === maxAttempts) return result;
    await refreshZhimadiCaptcha(session);
  }

  return { outcome: "failed", reason: "unknown" };
}

async function startZhimadiLoginSession() {
  const userDataDir = path.resolve(process.env.USER_DATA_DIR || "output/browser-profile");
  const outputDir = path.resolve("output/login-repair");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: process.env.HEADLESS === "true",
    executablePath: chromeExecutablePath(),
    viewport: { width: 1440, height: 900 },
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    await gotoZhimadi(page);

    if (await isZhimadiAuthenticated(page)) {
      await context.close();
      return { alreadyLoggedIn: true };
    }

    if ((await page.locator('input[name="account"]').count()) > 0) {
      if (!process.env.ZHIMADI_USERNAME) {
        throw fatalZhimadiRepairError("缺少芝麻地自动登录账号配置");
      }
      await page.locator('input[name="account"]').fill(process.env.ZHIMADI_USERNAME);
    }
    if ((await page.locator("#password").count()) > 0) {
      if (!process.env.ZHIMADI_PASSWORD) {
        throw fatalZhimadiRepairError("缺少芝麻地自动登录密码配置");
      }
      await page.locator("#password").fill(process.env.ZHIMADI_PASSWORD);
    }

    const session = {
      context,
      page,
      expiresAt: Date.now() + loginSessionTtlMs,
    };
    const screenshots = await captureZhimadiCaptcha(session);

    return {
      ...session,
      ...screenshots,
    };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

async function waitForZhimadiAuthenticated(page, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isZhimadiAuthenticated(page)) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

async function clickZhimadiLogin(session, code) {
  await session.page.locator('input[name="verify_code"]').fill(code);
  try {
    await session.page.evaluate(() => {
      const candidates = [...document.querySelectorAll("button,a,input[type=button],input[type=submit]")];
      const button = candidates.find((element) => /登\s*录/.test(element.innerText || element.value || ""));
      if (!button) throw new Error("找不到芝麻地登录按钮");
      button.click();
    });
  } catch (error) {
    if (String(error?.message || error).includes("找不到芝麻地登录按钮")) {
      throw fatalZhimadiRepairError("找不到芝麻地登录按钮");
    }
    throw error;
  }
}

async function submitZhimadiLoginCode(session, code) {
  await clickZhimadiLogin(session, code);
  if (!(await waitForZhimadiAuthenticated(session.page))) {
    throw new Error("芝麻地登录提交后未确认进入已登录页面");
  }
}

async function closeLoginSession(session) {
  await session?.context?.close().catch(() => {});
  if (session?.expireTimer) clearTimeout(session.expireTimer);
  session?.profileLock?.release();
}

async function runSilentZhimadiRepairAttempt() {
  let profileLock;
  try {
    profileLock = await acquireLock("browser-profile", {
      waitMs: Number(process.env.ZHIMADI_SILENT_LOCK_WAIT_MS || 1000),
      staleMs: Number(process.env.BROWSER_LOCK_STALE_MS || 30 * 60 * 1000),
    });
  } catch (error) {
    if (String(error?.message || error).includes("等待 browser-profile 锁超时")) {
      return { outcome: "lock-busy" };
    }
    return {
      outcome: "fatal",
      error: String(error?.message || error).slice(0, 240),
    };
  }

  let session;
  try {
    session = await startZhimadiLoginSession();
    session.profileLock = profileLock;
    profileLock = null;
    if (session.alreadyLoggedIn) return { outcome: "success" };
    return await tryAutoZhimadiLogin(session, 1);
  } catch (error) {
    return {
      outcome: retryableZhimadiRepairError(error) ? "failed" : "fatal",
      error: String(error?.message || error).slice(0, 240),
    };
  } finally {
    await closeLoginSession(session);
    profileLock?.release();
  }
}

async function main() {
  loadEnv();

  if (!process.env.DINGTALK_CLIENT_ID || !process.env.DINGTALK_CLIENT_SECRET) {
    throw new Error("缺少 DINGTALK_CLIENT_ID 或 DINGTALK_CLIENT_SECRET");
  }

  let running = false;
  let lemengPendingSince = null;
  let loginSession = null;
  let shuttingDown = false;

  async function shutdown(status, code) {
    if (shuttingDown) return;
    shuttingDown = true;
    writeHeartbeat(status);
    await closeLoginSession(loginSession);
    process.exit(code);
  }

  process.once("SIGINT", () => {
    void shutdown("stopped", 130);
  });
  process.once("SIGTERM", () => {
    void shutdown("stopped", 143);
  });

  writeHeartbeat("starting");
  setInterval(() => writeHeartbeat("running"), 30000).unref();

  const client = new DWClient({
    clientId: process.env.DINGTALK_CLIENT_ID,
    clientSecret: process.env.DINGTALK_CLIENT_SECRET,
  });

  const douyinSmsFlow = createDouyinSmsFlow({
    sessionSend: (sessionWebhook, senderStaffId, content) => (
      sendSessionText(client, sessionWebhook, senderStaffId, content)
    ),
    webhookSend: (content) => sendDingTalkMarkdown(
      "抖音来客登录修复",
      `### 抖音来客登录修复\n\n${content}`,
      { alert: true },
    ),
  });

  async function startZhimadiCaptchaFlow(message, options = {}) {
    const afterLoginReport = options.afterLoginReport === true;
    const autoReport = options.autoReport ?? afterLoginReport;
    const notifyAutoSuccess = options.notifyAutoSuccess !== false;
    const tryAutomatic = options.tryAutomatic !== false;
    const repairIncidentId = options.repairIncidentId || null;
    const reportResumeMode = options.reportResumeMode || "listener";
    const profileLock = await acquireLock("browser-profile", {
      waitMs: Number(process.env.BROWSER_LOCK_WAIT_MS || 10 * 60 * 1000),
      staleMs: Number(process.env.BROWSER_LOCK_STALE_MS || 30 * 60 * 1000),
    });
    try {
      loginSession = await startZhimadiLoginSession();
      loginSession.profileLock = profileLock;
      if (loginSession.alreadyLoggedIn) {
        await closeLoginSession(loginSession);
        loginSession = null;
        if (notifyAutoSuccess) {
          await sendBestEffort(
            "芝麻地登录状态回复",
            () => sendSessionText(
              client,
              message.sessionWebhook,
              message.senderStaffId,
              "芝麻地当前登录正常。",
            ),
          );
        }
        if (autoReport) {
          await selectReportRunner(reportResumeMode, {
            reportDate: options.reportDate,
          })();
        }
        return "already-ok";
      }
      loginSession.afterLoginReport = afterLoginReport;
      loginSession.repairIncidentId = repairIncidentId;
      loginSession.reportResumeMode = reportResumeMode;
      loginSession.reportDate = options.reportDate || null;
      loginSession.conversationId = message?.conversationId || null;
      loginSession.senderStaffId = message?.senderStaffId || null;

      const autoLogin = tryAutomatic
        ? await tryAutoZhimadiLogin(loginSession)
        : { outcome: "failed", reason: "manual-required" };
      if (autoLogin.outcome === "success") {
        await closeLoginSession(loginSession);
        loginSession = null;
        if (notifyAutoSuccess) {
          await sendBestEffort(
            "芝麻地自动登录回复",
            () => sendSessionText(
              client,
              message.sessionWebhook,
              message.senderStaffId,
              "芝麻地已自动重新登录。",
            ),
          );
        }
        if (autoReport) {
          await sendBestEffort(
            "月报续跑回复",
            () => sendSessionText(
              client,
              message.sessionWebhook,
              message.senderStaffId,
              "正在重新生成月报。",
            ),
          );
          await selectReportRunner(reportResumeMode, {
            reportDate: options.reportDate,
          })();
        }
        return "auto-ok";
      }
      if (autoLogin.outcome === "fatal") {
        throw new Error(autoLogin.error || autoLogin.reason || "芝麻地自动登录配置错误");
      }

      const screenshots = loginSession.captchaPath
        ? {
          screenshotPath: loginSession.screenshotPath,
          captchaPath: loginSession.captchaPath,
        }
        : await captureZhimadiCaptcha(loginSession);
      loginSession.screenshotPath = screenshots.screenshotPath;
      loginSession.captchaPath = screenshots.captchaPath;

      try {
        await sendCaptchaImage(client, message, loginSession.captchaPath);
      } catch (error) {
        if (promptDeliveryDefinitelyNotSent(error)) {
          error.promptDefinitelyNotSent = true;
        }
        throw error;
      }
      loginSession.expireTimer = setTimeout(async () => {
        if (!loginSession) return;
        const expiredIncidentId = loginSession.repairIncidentId;
        await closeLoginSession(loginSession);
        loginSession = null;
        running = false;
        if (expiredIncidentId) {
          const currentState = readJson(repairStatePath);
          const nextState = markManualRepair(currentState, {
            incidentId: expiredIncidentId,
            outcome: "expired",
          });
          if (nextState !== currentState) writeJsonAtomic(repairStatePath, nextState);
        }
      }, loginSessionTtlMs).unref();
      const instruction = "回复：验证码ABCD";
      if (message.sessionWebhook) {
        const sessionSent = await sendBestEffort(
          "验证码回复说明",
          () => sendSessionText(
            client,
            message.sessionWebhook,
            message.senderStaffId,
            instruction,
          ),
        );
        if (!sessionSent) {
          await sendBestEffort(
            "验证码回复说明备用通知",
            () => sendDingTalkMarkdown(
              "水果店登录验证码",
              `### 水果店登录验证码\n\n自动修复持续 3 小时仍未恢复，请${instruction}`,
              { alert: true },
            ),
          );
        }
      } else {
        await sendBestEffort(
          "验证码回复说明",
          () => sendDingTalkMarkdown(
            "水果店登录验证码",
            `### 水果店登录验证码\n\n自动修复持续 3 小时仍未恢复，请${instruction}`,
            { alert: true },
          ),
        );
      }
      return "captcha-sent";
    } catch (error) {
      if (loginSession) await closeLoginSession(loginSession);
      else profileLock.release();
      loginSession = null;
      throw error;
    }
  }

  const autoRepairCoordinator = createZhimadiRepairCoordinator({
    loadState: () => readJson(repairStatePath),
    persistState: (state) => writeJsonAtomic(repairStatePath, state),
    runAttempt: async () => {
      running = true;
      try {
        return await runWithTaskWatchdog(
          () => runSilentZhimadiRepairAttempt(),
          {
            timeoutMs: requestTimeoutMs(
              "ZHIMADI_SILENT_TASK_WATCHDOG_MS",
              5 * 60 * 1000,
            ),
            label: "芝麻地静默修复",
            onTimeout: ({ error }) => {
              writeHeartbeat("task-timeout");
              console.error(error.message);
              process.exit(1);
            },
          },
        );
      } finally {
        running = false;
      }
    },
    escalate: async ({ incidentId, afterLoginReport, reportResumeMode, reportDate }) => {
      const context = loadGroupContext();
      if (!hasBoundLoginContext(context)) {
        return {
          outcome: "unavailable",
          error: "缺少可绑定的人工验证码群会话，继续后台自动修复",
        };
      }
      running = true;
      try {
        const result = await runWithTaskWatchdog(
          () => startZhimadiCaptchaFlow(context, {
            afterLoginReport,
            autoReport: false,
            notifyAutoSuccess: false,
            tryAutomatic: false,
            repairIncidentId: incidentId,
            reportResumeMode,
            reportDate,
          }),
          {
            timeoutMs: requestTimeoutMs(
              "ZHIMADI_ESCALATION_TASK_WATCHDOG_MS",
              12 * 60 * 1000,
            ),
            label: "芝麻地人工提示准备",
            onTimeout: ({ error }) => {
              writeHeartbeat("task-timeout");
              console.error(error.message);
              process.exit(1);
            },
          },
        );
        if (result === "captcha-sent") return { outcome: "captcha-sent" };
        running = false;
        return { outcome: "success" };
      } catch (error) {
        running = false;
        if (error?.promptDefinitelyNotSent) {
          return {
            outcome: "unavailable",
            error: errorSummary(error),
          };
        }
        throw error;
      }
    },
  });
  let autoRepairTickRunning = false;
  const resumeReportAfterRepair = createReportResumeFlow({
    loadState: () => readJson(repairStatePath),
    persistState: (state) => writeJsonAtomic(repairStatePath, state),
    runReport: async (state) => {
      running = true;
      try {
        await selectReportRunner(state.reportResumeMode, {
          reportDate: state.reportDate,
        })();
      } finally {
        running = false;
      }
    },
  });

  async function handleAutoRepairRequest() {
    if (running || loginSession || autoRepairTickRunning) return;
    const request = readJson(repairRequestPath);
    if (!request?.requestedAt) return;

    autoRepairTickRunning = true;
    try {
      const result = await autoRepairCoordinator.tick(request);
      if (
        result.outcome === "success"
        || (
          result.outcome === "inactive"
          && ["already-ok", "auto-ok", "manual-ok", "observed-ok"].includes(result.status)
        )
      ) {
        await resumeReportAfterRepair(result.state).catch((error) => {
          console.error(`芝麻地恢复后续跑报表失败：${errorSummary(error)}`);
        });
      } else if (result.outcome === "fatal") {
        await sendDingTalkMarkdown(
          "水果店登录修复失败",
          `### 水果店登录修复失败\n\n${result.state.lastFailure}`,
          { alert: true },
        ).catch((error) => {
          console.warn(`自动修复失败通知发送失败：${error.message}`);
        });
      } else if (result.outcome === "lock-stalled") {
        if (await notifyLockStalled(result)) {
          const currentState = readJson(repairStatePath);
          if (
            currentState?.incidentId === result.state?.incidentId
            && !currentState.lockBusyAlertSentAt
          ) {
            writeJsonAtomic(repairStatePath, {
              ...currentState,
              lockBusyAlertSentAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
        }
      }
    } finally {
      autoRepairTickRunning = false;
    }
  }

  function persistManualRepairOutcome(incidentId, outcome, error) {
    if (!incidentId) return null;
    const currentState = readJson(repairStatePath);
    const nextState = markManualRepair(currentState, {
      incidentId,
      outcome,
      error,
    });
    if (nextState !== currentState) writeJsonAtomic(repairStatePath, nextState);
    return nextState;
  }

  setInterval(() => {
    handleAutoRepairRequest().catch((error) => {
      console.error(error.stack || error.message);
    });
    douyinSmsFlow.handleRepairRequest()
      .then((result) => {
        if (result.outcome === "prompt-failed") {
          console.warn(`抖音短信修复提示发送失败：${result.error}`);
        }
      })
      .catch((error) => {
        console.error(error.stack || error.message);
      });
  }, Number(process.env.AUTO_REPAIR_POLL_MS || 15000)).unref();

  client.registerCallbackListener(TOPIC_ROBOT, async (res) => {
    writeHeartbeat("message");
    const message = JSON.parse(res.data);
    saveGroupContext(message);
    const text = messageText(message);
    // 数字一律打码，验证码不进日志。
    console.log(
      `[${new Date().toISOString()}] inbound `
      + `type=${message?.conversationType ?? "?"} `
      + `text=${text.replace(/\d/g, "#").slice(0, 30)}`,
    );

    if (loginSession && Date.now() > loginSession.expiresAt) {
      await closeLoginSession(loginSession);
      loginSession = null;
      running = false;
    }

    const manualCaptchaCode = extractManualCaptchaCode(text);
    if (
      loginSession
      && manualCaptchaCode
      && isLoginSessionReply(loginSession, message)
    ) {
      const code = manualCaptchaCode;
      const repairIncidentId = loginSession.repairIncidentId;
      const afterLoginReport = loginSession.afterLoginReport;
      const reportResumeMode = loginSession.reportResumeMode;
      const reportDate = loginSession.reportDate;
      try {
        await submitZhimadiLoginCode(loginSession, code);
      } catch (error) {
        await closeLoginSession(loginSession);
        loginSession = null;
        running = false;
        persistManualRepairOutcome(repairIncidentId, "failed", error.message);
        await sendBestEffort(
          "芝麻地验证码失败回复",
          () => sendSessionText(
            client,
            message.sessionWebhook,
            message.senderStaffId,
            `验证码失败：${error.message}`,
          ),
        );
        console.error(error.stack || error.message);
        return;
      }

      await closeLoginSession(loginSession);
      loginSession = null;
      try {
        const repairedState = persistManualRepairOutcome(repairIncidentId, "ok");
        if (afterLoginReport) {
          await sendBestEffort(
            "芝麻地登录恢复回复",
            () => sendSessionText(
              client,
              message.sessionWebhook,
              message.senderStaffId,
              "登录已恢复，继续生成月报。",
            ),
          );
          const resumeReport = repairedState
            ? () => resumeReportAfterRepair(repairedState)
            : selectReportRunner(reportResumeMode, { reportDate });
          Promise.resolve()
            .then(resumeReport)
            .catch((error) => {
              console.error(error.stack || error.message);
            })
            .finally(() => {
              running = false;
            });
        } else {
          running = false;
          await sendBestEffort(
            "芝麻地登录恢复回复",
            () => sendSessionText(
              client,
              message.sessionWebhook,
              message.senderStaffId,
              "登录已恢复。",
            ),
          );
        }
      } catch (error) {
        running = false;
        console.error(`芝麻地已认证，后续处理失败：${errorSummary(error)}`);
      }
      return;
    }

    if (saveDouyinSmsTarget(message, text)) {
      await sendSessionText(
        client,
        message.sessionWebhook,
        message.senderStaffId,
        "抖音短信接收上下文已准备，请在 5 分钟内运行修复入口。",
      );
      return;
    }

    const smsReply = await douyinSmsFlow.handleMessage(message, text);
    if (smsReply.handled) {
      if (smsReply.outcome.endsWith("-failed")) {
        console.warn(`抖音短信修复回复处理失败：${smsReply.error || smsReply.outcome}`);
      }
      return;
    }

    let historyMonth = null;
    try {
      historyMonth = parseHistoryCommand(text);
    } catch {
      await sendSessionText(
        client,
        message.sessionWebhook,
        message.senderStaffId,
        "历史报表命令格式：报表 YYYY-MM",
      );
      return;
    }
    if (historyMonth) {
      const key = commandKey(message, text);
      if (!rememberCommand(key)) {
        console.log(`[${new Date().toISOString()}] duplicate history command ignored`);
        return;
      }
      const result = await handleHistoryCommand({
        text,
        outputDir: path.resolve("output"),
        reply: (content) => sendSessionText(
          client,
          message.sessionWebhook,
          message.senderStaffId,
          content,
        ),
      });
      if (result.error) {
        console.warn(`历史报表读取失败：${result.error.message}`);
      }
      return;
    }

    if (text.includes("登录")) {
      if (running) {
        await sendSessionText(client, message.sessionWebhook, message.senderStaffId, "当前有任务正在运行。");
        return;
      }

      running = true;
      const repairState = readJson(repairStatePath);
      const repairIncidentId = activeIncidentId(repairState);
      try {
        const result = await startZhimadiCaptchaFlow(message, {
          repairIncidentId,
          afterLoginReport: repairState?.afterLoginReport === true,
          reportResumeMode: repairState?.reportResumeMode,
          reportDate: repairState?.reportDate,
          autoReport: repairIncidentId ? false : undefined,
        });
        if (result !== "captcha-sent") {
          const repairedState = persistManualRepairOutcome(repairIncidentId, "ok");
          if (repairedState?.afterLoginReport === true) {
            await resumeReportAfterRepair(repairedState);
          }
        }
        if (result !== "captcha-sent") running = false;
      } catch (error) {
        await closeLoginSession(loginSession);
        loginSession = null;
        running = false;
        persistManualRepairOutcome(repairIncidentId, "failed", error.message);
        console.error(error.stack || error.message);
        await sendSessionText(client, message.sessionWebhook, message.senderStaffId, `芝麻地登录修复启动失败：${error.message}`);
      }
      return;
    }

    // 乐檬是唯一没有自助登录入口的来源，验证码只会发到店主手机上。
    // 单聊里回一句“乐檬码123456”就能完成登录，不必进群、也不必开终端。
    if (isLemengLoginCommand(text)) {
      lemengPendingSince = Date.now();
      console.log(`[${new Date().toISOString()}] lemeng login command accepted`);
      // 先回执再干活：店主要先确认机器人听见了。
      await sendBestEffort("乐檬收到回执", () => sendSessionText(
        client,
        message.sessionWebhook,
        message.senderStaffId,
        "收到，正在让乐檬发送短信验证码，请稍等十几秒。",
      ));
      startLemengLogin({ cwd: process.cwd() });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const status = readLemengLoginStatus();
        if (status.state === "waiting-code") {
          await sendBestEffort("乐檬短信已发", () => sendSessionText(
            client,
            message.sessionWebhook,
            message.senderStaffId,
            "短信已发出，收到后直接把数字发过来。",
          ));
          return;
        }
        if (status.state === "ok") {
          lemengPendingSince = null;
          await sendBestEffort("乐檬无需登录", () => sendSessionText(
            client,
            message.sessionWebhook,
            message.senderStaffId,
            "乐檬本来就是登录着的，不用验证码。",
          ));
          return;
        }
        if (status.state === "failed") {
          lemengPendingSince = null;
          await sendBestEffort("乐檬登录启动失败", () => sendSessionText(
            client,
            message.sessionWebhook,
            message.senderStaffId,
            `乐檬登录没能开始：${status.message}`,
          ));
          return;
        }
      }
      await sendBestEffort("乐檬短信超时", () => sendSessionText(
        client,
        message.sessionWebhook,
        message.senderStaffId,
        "乐檬那边响应有点慢，收到短信直接发数字，或者再发一次“乐檬”。",
      ));
      return;
    }

    const lemengSmsCode = extractLemengSmsCode(text)
      || extractPendingSmsCode(text, lemengPendingSince);
    if (lemengSmsCode) {
      lemengPendingSince = null;
      console.log(`[${new Date().toISOString()}] lemeng sms code accepted`);
      try {
        deliverLemengSmsCode(lemengSmsCode);
      } catch (error) {
        await sendBestEffort("乐檬验证码格式回复", () => sendSessionText(
          client,
          message.sessionWebhook,
          message.senderStaffId,
          `这个验证码我没收下：${error.message}`,
        ));
        return;
      }
      await sendBestEffort("乐檬验证码回执", () => sendSessionText(
        client,
        message.sessionWebhook,
        message.senderStaffId,
        "收到验证码，正在完成乐檬登录。",
      ));
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const status = readLemengLoginStatus();
        if (status.state === "ok" || status.state === "failed") {
          await sendBestEffort("乐檬登录结果", () => sendSessionText(
            client,
            message.sessionWebhook,
            message.senderStaffId,
            status.state === "ok"
              ? "乐檬登录成功，报表已经可以正常读取了。"
              : `乐檬登录失败：${status.message}`,
          ));
          return;
        }
      }
      await sendBestEffort("乐檬登录仍在进行", () => sendSessionText(
        client,
        message.sessionWebhook,
        message.senderStaffId,
        "乐檬登录还在进行，稍后回复“乐檬登录”可以重来一次。",
      ));
      return;
    }

    if (!text.includes("666")) {
      return;
    }

    const key = commandKey(message, text);
    if (!rememberCommand(key)) {
      console.log(`[${new Date().toISOString()}] duplicate command ignored`);
      return;
    }

    if (running) {
      await sendSessionText(client, message.sessionWebhook, message.senderStaffId, "月报正在生成中，稍等。");
      return;
    }

    running = true;
    console.log(`[${new Date().toISOString()}] monthly report command accepted`);
    await sendBestEffort(
      "月报开始回复",
      () => sendSessionText(
        client,
        message.sessionWebhook,
        message.senderStaffId,
        "收到 666，正在生成本月报表。",
      ),
    );

    runMonthlyReport()
      .catch(async (error) => {
        if (isDeferredMonthlyReportError(error)) {
          console.log("monthly-report-deferred-to-login-repair");
          return;
        }
        console.error(error.stack || error.message);
        await sendBestEffort(
          "月报失败回复",
          () => sendSessionText(
            client,
            message.sessionWebhook,
            message.senderStaffId,
            `本月报表生成失败，已触发失败通知。\n${errorSummary(error)}`,
          ),
        );
      })
      .finally(() => {
        if (!loginSession) running = false;
      });
  }).connect();

  writeHeartbeat("connected");
  console.log("DingTalk listener started. Send @机器人 666 in the group.");
}

if (require.main === module) {
  main().catch((error) => {
    writeHeartbeat("failed");
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = {
  isGroupConversation,
  canonicalReportDate,
  createReportResumeFlow,
  createDouyinSmsFlow,
  deliverBoundCaptchaImage,
  extractManualCaptchaCode,
  hasBoundLoginContext,
  isDeferredMonthlyReportError,
  isLoginSessionReply,
  loadDouyinSmsTarget,
  notifyLockStalled,
  promptDeliveryDefinitelyNotSent,
  reportResumeClaimIsActive,
  promoteLatestListenerResumeIntent,
  retryableZhimadiRepairError,
  runMonthlyReport,
  runReportChild,
  runWithTaskWatchdog,
  saveDouyinSmsTarget,
  scheduledResumeTimeoutMs,
  sendBestEffort,
  sendGroupImage,
  sendSessionText,
  selectReportRunner,
  uploadDingTalkImage,
};
