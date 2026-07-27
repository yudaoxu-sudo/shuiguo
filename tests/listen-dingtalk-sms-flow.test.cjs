const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createDouyinSmsFlow,
  loadDouyinSmsTarget,
  saveDouyinSmsTarget,
} = require("../scripts/listen-dingtalk.cjs");

const baseNow = Date.parse("2026-07-26T12:00:00.000Z");
const source = { conversationId: "cid-1", senderStaffId: "user-1" };
const boundRequest = (requestedAt, extra = {}) => ({
  requestedAt,
  ...source,
  ...extra,
});
const boundMessage = (msgId, extra = {}) => ({ msgId, ...source, ...extra });

function createHarness({ request = null, context = null } = {}) {
  const harness = {
    request,
    context,
    now: baseNow,
    state: {},
    delivered: [],
    cleared: 0,
    sessionSends: [],
    webhookSends: [],
    sessionSendError: null,
    sessionSendGate: null,
    deliverError: null,
  };
  harness.flow = createDouyinSmsFlow({
    loadState: () => structuredClone(harness.state),
    persistState: (state) => {
      harness.state = structuredClone(state);
    },
    loadRequest: () => harness.request,
    loadContext: () => harness.context,
    deliver: (code) => {
      if (harness.deliverError) throw harness.deliverError;
      harness.delivered.push(code);
    },
    clearDelivery: () => {
      harness.cleared += 1;
    },
    sessionSend: async (webhook, staffId, content) => {
      harness.sessionSends.push({ webhook, staffId, content });
      if (harness.sessionSendGate) await harness.sessionSendGate;
      if (harness.sessionSendError) throw harness.sessionSendError;
    },
    webhookSend: async (content) => {
      harness.webhookSends.push(content);
    },
    now: () => harness.now,
  });
  return harness;
}

test("prepares a dedicated owner-only SMS target from the exact chat marker", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-sms-target-test-"));
  const filePath = path.join(dir, "target.json");
  try {
    assert.equal(
      saveDouyinSmsTarget(
        {
          ...source,
          sessionWebhook: "https://example.invalid/session",
        },
        "准备抖音短信",
        {
          filePath,
          now: baseNow,
        },
      ),
      true,
    );
    assert.deepEqual(loadDouyinSmsTarget(filePath), {
      ...source,
      sessionWebhook: "https://example.invalid/session",
      savedAt: "2026-07-26T12:00:00.000Z",
    });
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.equal(
      saveDouyinSmsTarget(source, "普通消息", { filePath, now: baseNow + 1000 }),
      false,
    );
    assert.equal(
      loadDouyinSmsTarget(filePath).savedAt,
      "2026-07-26T12:00:00.000Z",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("creates a pending session from a repair request and delivers one reply through it", async () => {
  const idle = createHarness();
  assert.equal((await idle.flow.handleRepairRequest()).outcome, "no-request");

  const harness = createHarness({
    request: boundRequest("2026-07-26T11:59:00.000Z", { reason: "douyin-login" }),
    context: { ...source, sessionWebhook: "https://example.invalid/saved" },
  });

  const prompted = await harness.flow.handleRepairRequest();
  assert.equal(prompted.outcome, "prompted");
  assert.equal(prompted.channel, "session");
  assert.equal(harness.state.session.status, "pending");
  assert.equal(harness.state.handledRequestAt, "2026-07-26T11:59:00.000Z");
  assert.match(harness.sessionSends[0].content, /短信码/);

  const repeated = await harness.flow.handleRepairRequest();
  assert.equal(repeated.outcome, "already-handled");
  assert.equal(harness.sessionSends.length, 1);

  harness.now = baseNow + 1000;
  const reply = await harness.flow.handleMessage(
    boundMessage("sms-1", { sessionWebhook: "https://example.invalid/msg" }),
    "短信码246810",
  );
  assert.equal(reply.handled, true);
  assert.equal(reply.outcome, "delivered");
  assert.deepEqual(harness.delivered, ["246810"]);
  assert.equal(harness.state.session.status, "used");
  assert.equal(harness.sessionSends.at(-1).webhook, "https://example.invalid/msg");
  assert.match(harness.sessionSends.at(-1).content, /已提交/);

  const again = await harness.flow.handleMessage(
    boundMessage("sms-2", { sessionWebhook: "https://example.invalid/msg" }),
    "短信码0421",
  );
  assert.equal(again.outcome, "already-used");
  assert.deepEqual(harness.delivered, ["246810"]);
});

test("coalesces overlapping request polls while the prompt is still in flight", async () => {
  const harness = createHarness({
    request: boundRequest("2026-07-26T11:59:00.000Z"),
    context: {
      ...source,
      sessionWebhook: "https://example.invalid/saved",
      savedAt: "2026-07-26T11:59:30.000Z",
    },
  });
  let releasePrompt;
  harness.sessionSendGate = new Promise((resolve) => {
    releasePrompt = resolve;
  });

  const firstPoll = harness.flow.handleRepairRequest();
  await new Promise((resolve) => setImmediate(resolve));
  const overlappingPoll = await harness.flow.handleRepairRequest();

  assert.equal(overlappingPoll.outcome, "prompt-in-progress");
  assert.equal(harness.sessionSends.length, 1);

  releasePrompt();
  assert.equal((await firstPoll).outcome, "prompted");
  assert.equal((await harness.flow.handleRepairRequest()).outcome, "already-handled");
  assert.equal(harness.sessionSends.length, 1);
});

test("recovers a stale prompt claim left by a crashed listener", async () => {
  const request = boundRequest("2026-07-26T11:59:00.000Z");
  const harness = createHarness({
    request,
    context: {
      ...source,
      sessionWebhook: "https://example.invalid/saved",
      savedAt: "2026-07-26T11:59:30.000Z",
    },
  });
  harness.state = {
    promptingRequestId: request.requestedAt,
    promptingRequestAt: request.requestedAt,
    promptingStartedAt: new Date(baseNow - 61_000).toISOString(),
    session: {
      status: "pending",
      ...source,
      expiresAt: new Date(baseNow + 5 * 60 * 1000).toISOString(),
    },
    seenReplies: [],
  };

  const recovered = await harness.flow.handleRepairRequest();

  assert.equal(recovered.outcome, "prompted");
  assert.equal(harness.sessionSends.length, 1);
  assert.equal(harness.state.promptingRequestId, null);
  assert.equal(harness.state.promptingStartedAt, null);
});

test("resolves the configured request path when the listener runs, after env loading", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-sms-request-path-test-"));
  const requestPath = path.join(dir, "request.json");
  const previousPath = process.env.DOUYIN_SMS_REQUEST_FILE;
  let state = {};
  try {
    process.env.DOUYIN_SMS_REQUEST_FILE = requestPath;
    fs.writeFileSync(requestPath, JSON.stringify(
      boundRequest("2026-07-26T11:59:00.000Z"),
    ));
    const flow = createDouyinSmsFlow({
      loadState: () => structuredClone(state),
      persistState: (next) => {
        state = structuredClone(next);
      },
      loadContext: () => ({
        ...source,
        sessionWebhook: "https://example.invalid/saved",
        savedAt: "2026-07-26T11:59:30.000Z",
      }),
      clearDelivery: () => {},
      sessionSend: async () => {},
      webhookSend: async () => {},
      now: () => baseNow,
    });

    assert.equal((await flow.handleRepairRequest()).outcome, "prompted");
  } finally {
    if (previousPath === undefined) delete process.env.DOUYIN_SMS_REQUEST_FILE;
    else process.env.DOUYIN_SMS_REQUEST_FILE = previousPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prompts and replies through the default webhook when no group context exists", async () => {
  const harness = createHarness({
    request: boundRequest("2026-07-26T11:59:00.000Z"),
  });

  const prompted = await harness.flow.handleRepairRequest();
  assert.equal(prompted.channel, "webhook");
  assert.equal(harness.webhookSends.length, 1);
  assert.match(harness.webhookSends[0], /短信码/);
  assert.deepEqual(harness.sessionSends, []);

  harness.now = baseNow + 1000;
  const reply = await harness.flow.handleMessage(boundMessage("sms-1"), "246810");
  assert.equal(reply.outcome, "delivered");
  assert.deepEqual(harness.delivered, ["246810"]);
  assert.equal(harness.webhookSends.length, 2);
  assert.match(harness.webhookSends.at(-1), /已提交/);
  assert.deepEqual(harness.sessionSends, []);
});

test("leaves an unbound request pending until a source context exists", async () => {
  const harness = createHarness({
    request: { requestedAt: "2026-07-26T11:59:00.000Z" },
  });

  const missing = await harness.flow.handleRepairRequest();
  assert.equal(missing.outcome, "missing-context");
  assert.deepEqual(harness.state, {});
  assert.equal(harness.cleared, 0);
  assert.deepEqual(harness.sessionSends, []);
  assert.deepEqual(harness.webhookSends, []);

  harness.context = {
    ...source,
    sessionWebhook: "https://example.invalid/saved",
    savedAt: "2026-07-26T11:59:30.000Z",
  };
  const prompted = await harness.flow.handleRepairRequest();
  assert.equal(prompted.outcome, "prompted");
  assert.equal(harness.state.session.conversationId, source.conversationId);
  assert.equal(harness.state.session.senderStaffId, source.senderStaffId);
});

test("rejects stale repair requests, stale contexts, and partial bindings", async () => {
  const staleRequest = createHarness({
    request: boundRequest("2026-07-26T11:50:00.000Z"),
  });
  assert.equal(
    (await staleRequest.flow.handleRepairRequest()).outcome,
    "stale-request",
  );

  const staleContext = createHarness({
    request: { requestedAt: "2026-07-26T11:59:00.000Z" },
    context: {
      ...source,
      sessionWebhook: "https://example.invalid/stale",
      savedAt: "2026-07-26T11:50:00.000Z",
    },
  });
  assert.equal(
    (await staleContext.flow.handleRepairRequest()).outcome,
    "missing-context",
  );

  const partialBinding = createHarness({
    request: {
      requestedAt: "2026-07-26T11:59:00.000Z",
      conversationId: source.conversationId,
    },
    context: {
      ...source,
      savedAt: "2026-07-26T11:59:30.000Z",
    },
  });
  assert.equal(
    (await partialBinding.flow.handleRepairRequest()).outcome,
    "invalid-binding",
  );
});

test("does not send a bound request through a mismatched saved session", async () => {
  const harness = createHarness({
    request: boundRequest("2026-07-26T11:59:00.000Z"),
    context: {
      conversationId: "other-conversation",
      senderStaffId: "other-user",
      sessionWebhook: "https://example.invalid/wrong-session",
      savedAt: "2026-07-26T11:59:30.000Z",
    },
  });

  const prompted = await harness.flow.handleRepairRequest();
  assert.equal(prompted.outcome, "prompted");
  assert.equal(prompted.channel, "webhook");
  assert.equal(harness.sessionSends.length, 0);
  assert.equal(harness.webhookSends.length, 1);
  assert.equal(harness.state.session.conversationId, source.conversationId);
  assert.equal(harness.state.session.senderStaffId, source.senderStaffId);
});

test("retries a repair prompt after notification failure without marking the request handled", async () => {
  const harness = createHarness({
    request: boundRequest("2026-07-26T11:59:00.000Z", { requestId: "request-1" }),
    context: { ...source, sessionWebhook: "https://example.invalid/saved" },
  });
  harness.sessionSendError = new Error("temporary webhook failure");

  const failed = await harness.flow.handleRepairRequest();
  assert.equal(failed.outcome, "prompt-failed");
  assert.equal(harness.state.handledRequestId, undefined);
  assert.equal(harness.state.promptStatus, "failed");

  harness.sessionSendError = null;
  const retried = await harness.flow.handleRepairRequest();
  assert.equal(retried.outcome, "prompted");
  assert.equal(harness.state.handledRequestId, "request-1");
  assert.equal(harness.sessionSends.length, 2);
});

test("rejects SMS codes from another conversation or sender through the listener flow", async () => {
  const harness = createHarness({
    request: boundRequest("2026-07-26T11:59:00.000Z"),
  });
  await harness.flow.handleRepairRequest();

  const otherConversation = await harness.flow.handleMessage(
    boundMessage("wrong-conversation", { conversationId: "cid-2" }),
    "短信码246810",
  );
  assert.equal(otherConversation.outcome, "wrong-source");

  const otherSender = await harness.flow.handleMessage(
    boundMessage("wrong-sender", { senderStaffId: "user-2" }),
    "短信码246810",
  );
  assert.equal(otherSender.outcome, "wrong-source");
  assert.deepEqual(harness.delivered, []);
  assert.equal(harness.state.session.status, "pending");
});

test("keeps 666 and ordinary numbers out of the SMS flow", async () => {
  const idle = createHarness();
  const noSession = await idle.flow.handleMessage({ msgId: "m-1" }, "246810");
  assert.equal(noSession.handled, false);
  assert.equal(noSession.outcome, "no-session");

  const harness = createHarness({
    request: boundRequest("2026-07-26T11:59:00.000Z"),
  });
  await harness.flow.handleRepairRequest();

  const command = await harness.flow.handleMessage({ msgId: "m-2" }, "666");
  assert.equal(command.handled, false);
  assert.equal(command.outcome, "not-a-code");

  const praise = await harness.flow.handleMessage({ msgId: "m-5" }, "6666");
  assert.equal(praise.handled, false);
  assert.equal(praise.outcome, "not-a-code");

  const chatter = await harness.flow.handleMessage({ msgId: "m-3" }, "今天卖了1200斤，收入25000");
  assert.equal(chatter.handled, false);

  const phoneLength = await harness.flow.handleMessage({ msgId: "m-4" }, "10000000000");
  assert.equal(phoneLength.handled, false);

  assert.deepEqual(harness.delivered, []);
  assert.equal(harness.webhookSends.length, 1);
  assert.equal(harness.state.session.status, "pending");
});

test("expires a stale session through the listener flow", async () => {
  const harness = createHarness({
    request: boundRequest("2026-07-26T11:59:00.000Z"),
    context: { ...source, sessionWebhook: "https://example.invalid/saved" },
  });
  await harness.flow.handleRepairRequest();

  harness.now = Date.parse(harness.state.session.expiresAt) + 1;
  const expired = await harness.flow.handleMessage(
    boundMessage("late-1", { sessionWebhook: "https://example.invalid/msg" }),
    "短信码246810",
  );
  assert.equal(expired.handled, true);
  assert.equal(expired.outcome, "expired");
  assert.equal(harness.state.session.status, "expired");
  assert.deepEqual(harness.delivered, []);
  assert.match(harness.sessionSends.at(-1).content, /过期/);

  const afterwards = await harness.flow.handleMessage({ msgId: "late-2" }, "短信码246810");
  assert.equal(afterwards.handled, false);
  assert.equal(afterwards.outcome, "no-session");
});

test("clears any leftover code file when opening a new session, not on repeats", async () => {
  const harness = createHarness({
    request: boundRequest("2026-07-26T11:59:00.000Z"),
  });

  await harness.flow.handleRepairRequest();
  assert.equal(harness.cleared, 1);

  const repeated = await harness.flow.handleRepairRequest();
  assert.equal(repeated.outcome, "already-handled");
  assert.equal(harness.cleared, 1);

  harness.request = boundRequest("2026-07-26T12:09:00.000Z");
  harness.now = baseNow + 10 * 60 * 1000;
  const second = await harness.flow.handleRepairRequest();
  assert.equal(second.outcome, "prompted");
  assert.equal(harness.cleared, 2);
});

test("suppresses a redelivered reply across back-to-back repair sessions", async () => {
  const harness = createHarness({
    request: boundRequest("2026-07-26T11:59:00.000Z"),
  });
  await harness.flow.handleRepairRequest();

  harness.now = baseNow + 1000;
  const first = await harness.flow.handleMessage(boundMessage("dup-1"), "短信码246810");
  assert.equal(first.outcome, "delivered");

  harness.request = boundRequest("2026-07-26T12:00:30.000Z");
  harness.now = baseNow + 30 * 1000;
  const reopened = await harness.flow.handleRepairRequest();
  assert.equal(reopened.outcome, "prompted");
  assert.equal(harness.state.session.status, "pending");

  harness.now = baseNow + 60 * 1000;
  const replayed = await harness.flow.handleMessage(boundMessage("dup-1"), "短信码246810");
  assert.equal(replayed.handled, true);
  assert.equal(replayed.outcome, "duplicate");
  assert.deepEqual(harness.delivered, ["246810"]);
  assert.equal(harness.state.session.status, "pending");
});

test("suppresses a redelivered SMS reply through the listener flow", async () => {
  const harness = createHarness({
    request: boundRequest("2026-07-26T11:59:00.000Z"),
  });
  await harness.flow.handleRepairRequest();

  harness.now = baseNow + 1000;
  const first = await harness.flow.handleMessage(boundMessage("dup-1"), "短信码246810");
  assert.equal(first.outcome, "delivered");

  harness.now = baseNow + 2000;
  const redelivered = await harness.flow.handleMessage(boundMessage("dup-1"), "短信码246810");
  assert.equal(redelivered.handled, true);
  assert.equal(redelivered.outcome, "duplicate");
  assert.deepEqual(harness.delivered, ["246810"]);
  assert.equal(harness.webhookSends.length, 2);
});
