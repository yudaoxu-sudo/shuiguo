const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  clearSmsCode,
  createSmsRepairRequest,
  createSmsSession,
  extractSmsCode,
  handleSmsCodeReply,
  isExpectedSmsSource,
  isSmsSessionExpired,
  sendSmsRepairNotice,
  smsCodeFilePath,
  smsRequestFilePath,
  writeSmsCode,
} = require("../scripts/douyin-sms-repair.cjs");

const baseNow = Date.parse("2026-07-26T12:00:00.000Z");
const expectedSource = {
  conversationId: "cid-1",
  senderStaffId: "user-1",
};

function createBoundSmsSession(options = {}) {
  return createSmsSession({ ...expectedSource, ...options });
}

test("parses SMS code replies and rejects phone-length digits", () => {
  assert.equal(extractSmsCode("短信码246810"), "246810");
  assert.equal(extractSmsCode("短信码：246810"), "246810");
  assert.equal(extractSmsCode("短信验证码 0421"), "0421");
  assert.equal(extractSmsCode("验证码:246810"), "246810");
  assert.equal(extractSmsCode("短信码246810，尾号0421"), "246810");
  assert.equal(extractSmsCode("246810"), "246810");

  assert.equal(extractSmsCode("10000000000"), "");
  assert.equal(extractSmsCode("短信码10000000000"), "");
  assert.equal(extractSmsCode("666"), "");
  assert.equal(extractSmsCode("246810和0421"), "");
  assert.equal(extractSmsCode("今晚8点的销量涨了20"), "");
  assert.equal(extractSmsCode(""), "");
});

test("keeps bare all-six praise out of the code fallback but honors the labeled form", () => {
  assert.equal(extractSmsCode("6666"), "");
  assert.equal(extractSmsCode("66666"), "");
  assert.equal(extractSmsCode("66666666"), "");
  assert.equal(extractSmsCode("短信码666666"), "666666");
  assert.equal(extractSmsCode("验证码:6666"), "6666");
});

test("passes through replies without a pending session and non-code chatter", async () => {
  const calls = [];
  const effects = {
    deliver: async () => calls.push("deliver"),
    notify: async () => calls.push("notify"),
  };

  const noSession = await handleSmsCodeReply({
    ...effects,
    session: null,
    message: { msgId: "sms-0" },
    text: "短信码246810",
    now: baseNow,
  });
  assert.equal(noSession.handled, false);
  assert.equal(noSession.outcome, "no-session");

  const chatter = await handleSmsCodeReply({
    ...effects,
    session: createBoundSmsSession({ now: baseNow }),
    message: { msgId: "sms-666" },
    text: "666",
    now: baseNow,
  });
  assert.equal(chatter.handled, false);
  assert.equal(chatter.outcome, "not-a-code");
  assert.deepEqual(calls, []);
});

test("delivers a pending SMS code exactly once and reserves state before side effects", async () => {
  const events = [];
  const delivered = [];
  const notices = [];

  const first = await handleSmsCodeReply({
    session: createBoundSmsSession({ now: baseNow, reason: "login-healthcheck" }),
    message: { ...expectedSource, msgId: "sms-1" },
    text: "短信码246810",
    now: baseNow + 1000,
    persist: (state) => events.push(`persist:${state.session.status}`),
    deliver: async (code) => {
      events.push("deliver");
      delivered.push(code);
    },
    notify: async (content) => {
      events.push("notify");
      notices.push(content);
    },
  });

  assert.equal(first.handled, true);
  assert.equal(first.outcome, "delivered");
  assert.equal(first.session.status, "used");
  assert.deepEqual(delivered, ["246810"]);
  assert.deepEqual(events, [
    "persist:delivering",
    "deliver",
    "persist:used",
    "notify",
    "persist:used",
  ]);
  assert.match(notices[0], /已提交/);

  const second = await handleSmsCodeReply({
    session: first.session,
    seenReplies: first.seenReplies,
    message: { ...expectedSource, msgId: "sms-2" },
    text: "短信码0421",
    now: baseNow + 2000,
    deliver: async (code) => delivered.push(code),
    notify: async (content) => notices.push(content),
  });

  assert.equal(second.handled, true);
  assert.equal(second.outcome, "already-used");
  assert.deepEqual(delivered, ["246810"]);
  assert.equal(notices.length, 2);
  assert.match(notices[1], /已提交过/);
});

test("rejects an SMS code after the repair session expires", async () => {
  const delivered = [];
  const notices = [];
  const session = createBoundSmsSession({ now: baseNow, ttlMs: 5 * 60 * 1000 });

  assert.equal(isSmsSessionExpired(session, baseNow + 5 * 60 * 1000), false);
  assert.equal(isSmsSessionExpired(session, baseNow + 5 * 60 * 1000 + 1), true);

  const result = await handleSmsCodeReply({
    session,
    message: { ...expectedSource, msgId: "sms-late" },
    text: "短信码246810",
    now: baseNow + 5 * 60 * 1000 + 1,
    deliver: async (code) => delivered.push(code),
    notify: async (content) => notices.push(content),
  });

  assert.equal(result.handled, true);
  assert.equal(result.outcome, "expired");
  assert.equal(result.session.status, "expired");
  assert.deepEqual(delivered, []);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /过期/);
});

test("fails closed when the persisted session expiry is corrupt", async () => {
  const delivered = [];
  const session = {
    ...createBoundSmsSession({ now: baseNow }),
    expiresAt: "not-a-timestamp",
  };

  assert.equal(isSmsSessionExpired(session, baseNow + 1000), true);
  const result = await handleSmsCodeReply({
    session,
    message: { ...expectedSource, msgId: "sms-corrupt-expiry" },
    text: "短信码246810",
    now: baseNow + 1000,
    deliver: async (code) => delivered.push(code),
    notify: async () => {},
  });

  assert.equal(result.outcome, "expired");
  assert.deepEqual(delivered, []);
});

test("binds an SMS session to the expected conversation and sender", async () => {
  const session = createBoundSmsSession({ now: baseNow });
  assert.equal(isExpectedSmsSource(session, expectedSource), true);
  assert.equal(
    isExpectedSmsSource(session, { ...expectedSource, conversationId: "cid-2" }),
    false,
  );
  assert.equal(
    isExpectedSmsSource(session, { ...expectedSource, senderStaffId: "user-2" }),
    false,
  );

  const delivered = [];
  const wrongConversation = await handleSmsCodeReply({
    session,
    message: { ...expectedSource, conversationId: "cid-2", msgId: "wrong-conversation" },
    text: "短信码246810",
    now: baseNow + 1000,
    deliver: async (code) => delivered.push(code),
  });
  assert.equal(wrongConversation.handled, true);
  assert.equal(wrongConversation.outcome, "wrong-source");

  const wrongSender = await handleSmsCodeReply({
    session,
    message: { ...expectedSource, senderStaffId: "user-2", msgId: "wrong-sender" },
    text: "短信码246810",
    now: baseNow + 1000,
    deliver: async (code) => delivered.push(code),
  });
  assert.equal(wrongSender.outcome, "wrong-source");
  assert.deepEqual(delivered, []);
});

test("returns a failed delivery to pending so the same reply can retry safely", async () => {
  let state = {
    session: createBoundSmsSession({ now: baseNow }),
    seenReplies: [],
  };
  let deliveryAttempts = 0;
  const persist = ({ session, seenReplies }) => {
    state = { session: structuredClone(session), seenReplies: structuredClone(seenReplies) };
  };

  const failed = await handleSmsCodeReply({
    ...state,
    message: { ...expectedSource, msgId: "retry-code" },
    text: "短信码246810",
    now: baseNow + 1000,
    persist,
    deliver: async () => {
      deliveryAttempts += 1;
      throw new Error("disk busy");
    },
    notify: async () => {},
  });
  assert.equal(failed.outcome, "delivery-failed");
  assert.equal(state.session.status, "pending");
  assert.deepEqual(state.seenReplies, []);

  const retried = await handleSmsCodeReply({
    ...state,
    message: { ...expectedSource, msgId: "retry-code" },
    text: "短信码246810",
    now: baseNow + 2000,
    persist,
    deliver: async () => {
      deliveryAttempts += 1;
    },
    notify: async () => {},
  });
  assert.equal(retried.outcome, "delivered");
  assert.equal(state.session.status, "used");
  assert.equal(deliveryAttempts, 2);
});

test("recovers a stale delivery claim while suppressing a live concurrent claim", async () => {
  const delivered = [];
  const liveClaim = {
    ...createBoundSmsSession({ now: baseNow }),
    status: "delivering",
    deliveryAttemptAt: new Date(baseNow + 1000).toISOString(),
  };
  const inProgress = await handleSmsCodeReply({
    session: liveClaim,
    message: { ...expectedSource, msgId: "live-claim" },
    text: "短信码246810",
    now: baseNow + 2000,
    deliveryClaimTtlMs: 30_000,
    deliver: async (code) => delivered.push(code),
  });
  assert.equal(inProgress.outcome, "delivery-in-progress");
  assert.deepEqual(delivered, []);

  let state;
  const recovered = await handleSmsCodeReply({
    session: {
      ...liveClaim,
      deliveryAttemptAt: new Date(baseNow + 1000).toISOString(),
    },
    message: { ...expectedSource, msgId: "stale-claim" },
    text: "短信码246810",
    now: baseNow + 32_000,
    deliveryClaimTtlMs: 30_000,
    persist: ({ session, seenReplies }) => {
      state = { session, seenReplies };
    },
    deliver: async (code) => delivered.push(code),
    notify: async () => {},
  });
  assert.equal(recovered.outcome, "delivered");
  assert.deepEqual(delivered, ["246810"]);
  assert.equal(state.session.status, "used");

  const recoveredFutureClaim = await handleSmsCodeReply({
    session: {
      ...liveClaim,
      deliveryAttemptAt: new Date(baseNow + 5 * 60 * 1000).toISOString(),
    },
    message: { ...expectedSource, msgId: "far-future-claim" },
    text: "短信码135790",
    now: baseNow + 2000,
    deliveryClaimTtlMs: 30_000,
    persist: () => {},
    deliver: async (code) => delivered.push(code),
    notify: async () => {},
  });
  assert.equal(recoveredFutureClaim.outcome, "delivered");
  assert.deepEqual(delivered, ["246810", "135790"]);
});

test("drops far-future duplicate records instead of suppressing a valid reply forever", async () => {
  const delivered = [];
  const result = await handleSmsCodeReply({
    session: createBoundSmsSession({ now: baseNow }),
    seenReplies: [{
      key: "message:future-duplicate",
      at: baseNow + 60 * 60 * 1000,
    }],
    message: { ...expectedSource, msgId: "future-duplicate" },
    text: "短信码246810",
    now: baseNow + 1000,
    duplicateWindowMs: 3 * 60 * 1000,
    persist: () => {},
    deliver: async (code) => delivered.push(code),
    notify: async () => {},
  });

  assert.equal(result.outcome, "delivered");
  assert.deepEqual(delivered, ["246810"]);
});

test("retries a failed acknowledgement without delivering the SMS code twice", async () => {
  let state = {
    session: createBoundSmsSession({ now: baseNow }),
    seenReplies: [],
  };
  let deliveries = 0;
  let notices = 0;
  const persist = ({ session, seenReplies }) => {
    state = { session: structuredClone(session), seenReplies: structuredClone(seenReplies) };
  };

  const failedNotice = await handleSmsCodeReply({
    ...state,
    message: { ...expectedSource, msgId: "notice-retry" },
    text: "短信码246810",
    now: baseNow + 1000,
    persist,
    deliver: async () => {
      deliveries += 1;
    },
    notify: async () => {
      notices += 1;
      throw new Error("webhook unavailable");
    },
  });
  assert.equal(failedNotice.outcome, "notification-failed");
  assert.equal(state.session.status, "used");
  assert.equal(state.session.notificationPending, true);

  const retriedNotice = await handleSmsCodeReply({
    ...state,
    message: { ...expectedSource, msgId: "notice-retry" },
    text: "短信码246810",
    now: baseNow + 2000,
    persist,
    deliver: async () => {
      deliveries += 1;
    },
    notify: async () => {
      notices += 1;
    },
  });
  assert.equal(retriedNotice.outcome, "notification-retried");
  assert.equal(state.session.notificationPending, false);
  assert.equal(deliveries, 1);
  assert.equal(notices, 2);
});

test("suppresses duplicate SMS replies inside the duplicate window", async () => {
  const delivered = [];
  const notices = [];
  const effects = {
    text: "短信码246810",
    deliver: async (code) => delivered.push(code),
    notify: async (content) => notices.push(content),
  };

  const first = await handleSmsCodeReply({
    ...effects,
    session: createBoundSmsSession({ now: baseNow }),
    message: { ...expectedSource, msgId: "sms-dup" },
    now: baseNow + 1000,
  });
  assert.equal(first.outcome, "delivered");

  const redelivered = await handleSmsCodeReply({
    ...effects,
    session: first.session,
    seenReplies: first.seenReplies,
    message: { ...expectedSource, msgId: "sms-dup" },
    now: baseNow + 2000,
  });
  assert.equal(redelivered.handled, true);
  assert.equal(redelivered.outcome, "duplicate");
  assert.deepEqual(delivered, ["246810"]);
  assert.equal(notices.length, 1);

  const anonymous = { ...expectedSource };
  const fallbackFirst = await handleSmsCodeReply({
    ...effects,
    session: createBoundSmsSession({ now: baseNow }),
    message: anonymous,
    now: baseNow + 1000,
  });
  assert.equal(fallbackFirst.outcome, "delivered");

  const fallbackSecond = await handleSmsCodeReply({
    ...effects,
    session: fallbackFirst.session,
    seenReplies: fallbackFirst.seenReplies,
    message: anonymous,
    now: baseNow + 2000,
  });
  assert.equal(fallbackSecond.outcome, "duplicate");
  assert.deepEqual(delivered, ["246810", "246810"]);
  assert.equal(notices.length, 2);
});

test("falls back to the default webhook when no group context exists", async () => {
  const sessionSends = [];
  const webhookSends = [];
  const sessionSend = async (webhook, staffId, content) => {
    sessionSends.push({ webhook, staffId, content });
  };
  const webhookSend = async (content) => webhookSends.push(content);

  const fromMessage = await sendSmsRepairNotice({
    message: { sessionWebhook: "https://example.invalid/msg", senderStaffId: "user-1" },
    groupContext: { sessionWebhook: "https://example.invalid/saved", senderStaffId: "user-2" },
    content: "请回复短信码",
    sessionSend,
    webhookSend,
  });
  assert.equal(fromMessage, "session");
  assert.deepEqual(sessionSends.at(-1), {
    webhook: "https://example.invalid/msg",
    staffId: "user-1",
    content: "请回复短信码",
  });

  const fromSavedContext = await sendSmsRepairNotice({
    message: null,
    groupContext: { sessionWebhook: "https://example.invalid/saved", senderStaffId: "user-2" },
    content: "请回复短信码",
    sessionSend,
    webhookSend,
  });
  assert.equal(fromSavedContext, "session");
  assert.equal(sessionSends.at(-1).webhook, "https://example.invalid/saved");
  assert.deepEqual(webhookSends, []);

  const fallback = await sendSmsRepairNotice({
    message: null,
    groupContext: null,
    content: "请回复短信码",
    sessionSend,
    webhookSend,
  });
  assert.equal(fallback, "webhook");
  assert.deepEqual(webhookSends, ["请回复短信码"]);
  assert.equal(sessionSends.length, 2);
});

test("writes the SMS code file that douyin-login polls", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-sms-repair-test-"));
  const filePath = path.join(dir, "code.txt");
  try {
    assert.equal(writeSmsCode("246810", filePath), filePath);
    assert.equal(fs.readFileSync(filePath, "utf8"), "246810");
    assert.throws(() => writeSmsCode("10000000000", filePath), /短信码格式不正确/);
    assert.throws(() => writeSmsCode("24ab", filePath), /短信码格式不正确/);
    assert.equal(
      smsCodeFilePath({}),
      path.resolve("output/login-repair/douyin-sms-code.txt"),
    );
    assert.equal(smsCodeFilePath({ DOUYIN_SMS_CODE_FILE: filePath }), filePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writes the SMS code file atomically with owner-only permissions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-sms-repair-test-"));
  const filePath = path.join(dir, "code.txt");
  try {
    writeSmsCode("246810", filePath);
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ["code.txt"]);

    fs.chmodSync(filePath, 0o644);
    writeSmsCode("0421", filePath);
    assert.equal(fs.readFileSync(filePath, "utf8"), "0421");
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ["code.txt"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("clears a leftover SMS code file and tolerates a missing one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-sms-repair-test-"));
  const filePath = path.join(dir, "code.txt");
  try {
    writeSmsCode("246810", filePath);
    assert.equal(clearSmsCode(filePath), filePath);
    assert.equal(fs.existsSync(filePath), false);
    assert.equal(clearSmsCode(filePath), filePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("creates an atomic owner-only repair request for the explicit login entry", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-sms-request-test-"));
  const filePath = path.join(dir, "request.json");
  try {
    const request = createSmsRepairRequest({
      now: baseNow,
      reason: "douyin-login",
      requestId: "request-1",
      filePath,
    });
    assert.deepEqual(request, {
      requestId: "request-1",
      requestedAt: "2026-07-26T12:00:00.000Z",
      reason: "douyin-login",
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), request);
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ["request.json"]);
    assert.equal(
      smsRequestFilePath({ DOUYIN_SMS_REQUEST_FILE: filePath }),
      filePath,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
