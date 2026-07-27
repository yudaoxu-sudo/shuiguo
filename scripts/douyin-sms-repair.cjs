const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const smsCodePattern = /^\d{4,8}$/;
const defaultSessionTtlMs = 5 * 60 * 1000;
const defaultDuplicateWindowMs = 3 * 60 * 1000;
const defaultDeliveryClaimTtlMs = 30 * 1000;
const defaultSmsCodeFile = "output/login-repair/douyin-sms-code.txt";
const defaultSmsRequestFile = "output/douyin-sms-repair-request.json";
const defaultSmsWaitMs = 5 * 60 * 1000;
const defaultSmsPollMs = 1000;

function extractSmsCode(text) {
  const normalized = String(text || "").replace(/\s+/g, "");

  const labeled = normalized.match(/(?:短信验证码|短信码|验证码)[:：]?(\d{4,8})(?!\d)/);
  if (labeled) return labeled[1];

  // 裸的全6数字串（6666…）在群里是口令/彩虹屁，不当验证码；带“短信码/验证码”前缀仍接受。
  const digitRuns = normalized.match(/\d+/g) || [];
  if (
    digitRuns.length === 1 &&
    smsCodePattern.test(digitRuns[0]) &&
    !/^6+$/.test(digitRuns[0])
  ) return digitRuns[0];
  return "";
}

function createSmsSession({
  now = Date.now(),
  ttlMs = Number(process.env.DOUYIN_SMS_SESSION_TTL_MS || defaultSessionTtlMs),
  reason = "",
  conversationId = "",
  senderStaffId = "",
} = {}) {
  return {
    status: "pending",
    reason,
    conversationId: String(conversationId || ""),
    senderStaffId: String(senderStaffId || ""),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
}

function isSmsSessionExpired(session, now = Date.now()) {
  if (!session?.expiresAt) return true;
  const expiresAt = Date.parse(session.expiresAt);
  return !Number.isFinite(expiresAt) || now > expiresAt;
}

function replyKey(message, text) {
  const messageId = message?.msgId || message?.messageId || message?.msgid;
  if (messageId) return `message:${messageId}`;

  return [
    "fallback",
    message?.conversationId || message?.conversationTitle || "",
    message?.senderStaffId || message?.senderId || "",
    text,
  ].join(":");
}

function pruneSeenReplies(seenReplies, now, windowMs) {
  return (Array.isArray(seenReplies) ? seenReplies : [])
    .filter((item) => (
      item
      && Number.isFinite(Number(item.at))
      && Number(item.at) >= now - windowMs
      && Number(item.at) <= now + windowMs
    ));
}

function messageSource(message) {
  return {
    conversationId: String(message?.conversationId || ""),
    senderStaffId: String(message?.senderStaffId || message?.senderId || ""),
  };
}

function isExpectedSmsSource(session, message) {
  const source = messageSource(message);
  return Boolean(
    session?.conversationId
    && session?.senderStaffId
    && source.conversationId === session.conversationId
    && source.senderStaffId === session.senderStaffId,
  );
}

async function handleSmsCodeReply({
  session,
  message,
  text,
  now = Date.now(),
  seenReplies = [],
  duplicateWindowMs = defaultDuplicateWindowMs,
  deliveryClaimTtlMs = defaultDeliveryClaimTtlMs,
  persist = () => {},
  deliver = async () => {},
  notify = async () => {},
} = {}) {
  if (!session || !["pending", "delivering", "used"].includes(session.status)) {
    return { handled: false, outcome: "no-session", session, seenReplies };
  }

  const code = extractSmsCode(text);
  if (!code) {
    return { handled: false, outcome: "not-a-code", session, seenReplies };
  }

  if (!isExpectedSmsSource(session, message)) {
    return { handled: true, outcome: "wrong-source", session, seenReplies };
  }

  const key = replyKey(message, text);
  const pruned = pruneSeenReplies(seenReplies, now, duplicateWindowMs);
  if (pruned.some((item) => item.key === key)) {
    if (session.status === "used" && session.notificationPending) {
      try {
        await notify("短信码已提交，正在完成抖音来客登录。");
        const acknowledged = { ...session, notificationPending: false };
        await persist({ session: acknowledged, seenReplies: pruned });
        return {
          handled: true,
          outcome: "notification-retried",
          session: acknowledged,
          seenReplies: pruned,
        };
      } catch (error) {
        return {
          handled: true,
          outcome: "notification-failed",
          error: error.message,
          session,
          seenReplies: pruned,
        };
      }
    }
    return { handled: true, outcome: "duplicate", session, seenReplies: pruned };
  }

  if (session.status === "used") {
    const nextSeen = [...pruned, { key, at: now }];
    try {
      await notify("本次短信码已提交过，无需重复发送。");
      const acknowledged = { ...session, notificationPending: false };
      await persist({ session: acknowledged, seenReplies: nextSeen });
      return {
        handled: true,
        outcome: "already-used",
        session: acknowledged,
        seenReplies: nextSeen,
      };
    } catch (error) {
      const pendingNotice = { ...session, notificationPending: true };
      await persist({ session: pendingNotice, seenReplies: nextSeen });
      return {
        handled: true,
        outcome: "notification-failed",
        error: error.message,
        session: pendingNotice,
        seenReplies: nextSeen,
      };
    }
  }

  if (session.status === "delivering") {
    const attemptAt = Date.parse(session.deliveryAttemptAt || "");
    const claimIsLive = Number.isFinite(attemptAt)
      && attemptAt <= now + deliveryClaimTtlMs
      && now - attemptAt <= deliveryClaimTtlMs;
    if (claimIsLive) {
      return {
        handled: true,
        outcome: "delivery-in-progress",
        session,
        seenReplies: pruned,
      };
    }
    session = {
      ...session,
      status: "pending",
      deliveryKey: null,
      deliveryAttemptAt: null,
    };
  }

  if (isSmsSessionExpired(session, now)) {
    const nextSeen = [...pruned, { key, at: now }];
    const expired = { ...session, status: "expired" };
    await persist({ session: expired, seenReplies: nextSeen });
    try {
      await notify("短信码已过期，请重新发起抖音来客登录修复。");
      return { handled: true, outcome: "expired", session: expired, seenReplies: nextSeen };
    } catch (error) {
      return {
        handled: true,
        outcome: "notification-failed",
        error: error.message,
        session: expired,
        seenReplies: nextSeen,
      };
    }
  }

  const delivering = {
    ...session,
    status: "delivering",
    deliveryKey: key,
    deliveryAttemptAt: new Date(now).toISOString(),
  };
  await persist({ session: delivering, seenReplies: pruned });

  try {
    await deliver(code);
  } catch (error) {
    const retryable = {
      ...session,
      status: "pending",
      lastDeliveryError: String(error.message || error).slice(0, 300),
    };
    await persist({ session: retryable, seenReplies: pruned });
    try {
      await notify("短信码提交失败，可重新回复同一短信码重试。");
    } catch {
      // 状态已经恢复为 pending；下次原消息重投递或人工重发都可安全重试。
    }
    return {
      handled: true,
      outcome: "delivery-failed",
      error: error.message,
      session: retryable,
      seenReplies: pruned,
    };
  }

  const nextSeen = [...pruned, { key, at: now }];
  const used = {
    ...session,
    status: "used",
    usedAt: new Date(now).toISOString(),
    notificationPending: true,
  };
  await persist({ session: used, seenReplies: nextSeen });
  try {
    await notify("短信码已提交，正在完成抖音来客登录。");
  } catch (error) {
    return {
      handled: true,
      outcome: "notification-failed",
      error: error.message,
      session: used,
      seenReplies: nextSeen,
    };
  }

  const acknowledged = { ...used, notificationPending: false };
  await persist({ session: acknowledged, seenReplies: nextSeen });
  return {
    handled: true,
    outcome: "delivered",
    session: acknowledged,
    seenReplies: nextSeen,
  };
}

function resolveSmsNoticeTarget(message, groupContext) {
  const sessionWebhook = message?.sessionWebhook || groupContext?.sessionWebhook || "";
  const senderStaffId = message?.senderStaffId || groupContext?.senderStaffId || "";
  if (sessionWebhook) return { channel: "session", sessionWebhook, senderStaffId };
  return { channel: "webhook", sessionWebhook: "", senderStaffId: "" };
}

async function sendSmsRepairNotice({
  message,
  groupContext,
  content,
  sessionSend,
  webhookSend,
} = {}) {
  const target = resolveSmsNoticeTarget(message, groupContext);
  if (target.channel === "session") {
    await sessionSend(target.sessionWebhook, target.senderStaffId, content);
  } else {
    await webhookSend(content);
  }
  return target.channel;
}

function smsCodeFilePath(env = process.env) {
  return path.resolve(env.DOUYIN_SMS_CODE_FILE || defaultSmsCodeFile);
}

function smsRequestFilePath(env = process.env) {
  return path.resolve(env.DOUYIN_SMS_REQUEST_FILE || defaultSmsRequestFile);
}

function writeJsonAtomic(filePath, data, mode = 0o600) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tempPath = path.join(
    directory,
    `${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), { mode });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function createSmsRepairRequest({
  now = Date.now(),
  reason = "douyin-login",
  requestId = crypto.randomUUID(),
  conversationId = "",
  senderStaffId = "",
  filePath = smsRequestFilePath(),
} = {}) {
  const request = {
    requestId,
    requestedAt: new Date(now).toISOString(),
    reason,
  };
  if (conversationId) request.conversationId = String(conversationId);
  if (senderStaffId) request.senderStaffId = String(senderStaffId);
  writeJsonAtomic(path.resolve(filePath), request);
  return request;
}

function writeSmsCode(code, filePath = smsCodeFilePath()) {
  if (!smsCodePattern.test(String(code || ""))) {
    throw new Error("短信码格式不正确，需要4-8位数字");
  }
  // douyin-login 按秒轮询这个文件：先写临时文件再重命名，避免读到半写内容；0600 防止同机其他账号读到验证码。
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tempPath = path.join(directory, `${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tempPath, String(code), { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
  return filePath;
}

function clearSmsCode(filePath = smsCodeFilePath()) {
  fs.rmSync(filePath, { force: true });
  return filePath;
}

function claimSmsCode(filePath = smsCodeFilePath()) {
  const resolved = path.resolve(filePath);
  // 先重命名再读：listener 开新会话时会删这个文件，直接读会撞上 ENOENT；
  // 读后再删则可能把刚写入的新码一起删掉。rename 把认领做成原子操作。
  const claimPath = `${resolved}.${process.pid}.claimed`;
  try {
    fs.renameSync(resolved, claimPath);
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
  try {
    return fs.readFileSync(claimPath, "utf8").replace(/\s+/g, "");
  } finally {
    fs.rmSync(claimPath, { force: true });
  }
}

function normalizeSmsWaitMs(value) {
  const ms = Number(value);
  // 配错的等待预算不能变成“立刻超时”，否则整条人工补码链路直接作废。
  return Number.isFinite(ms) && ms >= 0 ? ms : defaultSmsWaitMs;
}

async function waitForSmsCode({
  filePath = smsCodeFilePath(),
  timeoutMs = process.env.DOUYIN_SMS_WAIT_MS,
  pollMs = defaultSmsPollMs,
  discardExisting = true,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const resolved = path.resolve(filePath);
  if (discardExisting) {
    // 默认调用者没有提前清理；此时已存在的文件只能是上一轮遗留的旧码。
    claimSmsCode(resolved);
  }
  const deadline = now() + normalizeSmsWaitMs(timeoutMs);
  while (now() < deadline) {
    await sleep(pollMs);
    const code = claimSmsCode(resolved);
    if (smsCodePattern.test(code)) return code;
  }
  throw new Error("等待抖音短信验证码超时");
}

module.exports = {
  claimSmsCode,
  clearSmsCode,
  createSmsRepairRequest,
  createSmsSession,
  extractSmsCode,
  handleSmsCodeReply,
  isExpectedSmsSource,
  isSmsSessionExpired,
  messageSource,
  replyKey,
  resolveSmsNoticeTarget,
  sendSmsRepairNotice,
  smsCodeFilePath,
  smsRequestFilePath,
  waitForSmsCode,
  writeSmsCode,
  writeJsonAtomic,
};
