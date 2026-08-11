const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  deliverBoundCaptchaImage,
  hasBoundLoginContext,
  notifyLockStalled,
  promptDeliveryDefinitelyNotSent,
  runReportChild,
  runWithTaskWatchdog,
  sendBestEffort,
  sendGroupImage,
  sendSessionText,
  scheduledResumeTimeoutMs,
  uploadDingTalkImage,
} = require("../scripts/listen-dingtalk.cjs");
const {
  requestTimeoutMs,
} = require("../scripts/send-dingtalk.cjs");

test("DingTalk access-token calls have the shared 30 second default bound", async (t) => {
  assert.equal(requestTimeoutMs("UNSET_FRUIT_TIMEOUT", 30 * 1000), 30 * 1000);

  const previous = process.env.DINGTALK_HTTP_TIMEOUT_MS;
  process.env.DINGTALK_HTTP_TIMEOUT_MS = "5";
  t.after(() => {
    if (previous === undefined) delete process.env.DINGTALK_HTTP_TIMEOUT_MS;
    else process.env.DINGTALK_HTTP_TIMEOUT_MS = previous;
  });

  const client = { getAccessToken: () => new Promise(() => {}) };
  const expected = (error) => (
    error?.code === "PROMISE_TIMEOUT"
    && /钉钉访问令牌超时/.test(error.message)
  );

  await assert.rejects(
    sendSessionText(client, "https://example.invalid/session", "user-1", "ok"),
    expected,
  );
  await assert.rejects(
    uploadDingTalkImage(client, "/file-is-not-read-before-token-timeout.png"),
    expected,
  );
  await assert.rejects(
    sendGroupImage(client, {
      conversationId: "conversation-1",
      robotCode: "robot-1",
    }, "media-1"),
    expected,
  );
});

test("automatic captcha prompting requires a reply-bound group context", () => {
  const complete = {
    conversationId: "conversation-1",
    senderStaffId: "user-1",
    robotCode: "robot-1",
  };
  assert.equal(hasBoundLoginContext(complete), true);
  assert.equal(hasBoundLoginContext({ ...complete, conversationId: "" }), false);
  assert.equal(hasBoundLoginContext({ ...complete, senderStaffId: "" }), false);
  assert.equal(hasBoundLoginContext({ ...complete, robotCode: "" }), false);

  const tokenTimeout = new Error("钉钉访问令牌超时");
  tokenTimeout.code = "PROMISE_TIMEOUT";
  assert.equal(promptDeliveryDefinitelyNotSent(tokenTimeout), true);
  assert.equal(
    promptDeliveryDefinitelyNotSent(new Error("发送验证码图片失败: 400 invalid robotCode")),
    true,
  );
  assert.equal(
    promptDeliveryDefinitelyNotSent(new Error("发送验证码图片失败: request timeout")),
    false,
  );
});

test("an upload failure is definitely unsent while a group-send timeout is uncertain", async () => {
  const uploadTimeout = new Error("media upload timeout");
  await assert.rejects(
    deliverBoundCaptchaImage({
      upload: async () => { throw uploadTimeout; },
      send: async () => {},
    }),
    (error) => error === uploadTimeout && error.promptDefinitelyNotSent === true,
  );

  const groupTimeout = new Error("group send timeout");
  await assert.rejects(
    deliverBoundCaptchaImage({
      upload: async () => "media-1",
      send: async () => { throw groupTimeout; },
    }),
    (error) => error === groupTimeout && error.promptDefinitelyNotSent !== true,
  );
});

test("lock-stalled requests one delayed alert while lock-busy stays silent", async () => {
  const sends = [];
  const send = async (...args) => sends.push(args);

  assert.equal(await notifyLockStalled({ outcome: "lock-busy" }, { send }), false);
  assert.equal(sends.length, 0);
  assert.equal(await notifyLockStalled({ outcome: "lock-stalled" }, { send }), true);
  assert.equal(sends.length, 1);
  assert.equal(sends[0][0], "水果店登录修复延迟");
  assert.deepEqual(sends[0][2], { alert: true });
});

test("task watchdog triggers injected timeout handling without exiting tests", async () => {
  const timeouts = [];
  await assert.rejects(
    runWithTaskWatchdog(
      () => new Promise(() => {}),
      {
        timeoutMs: 5,
        label: "never-settles",
        onTimeout: (details) => timeouts.push(details),
      },
    ),
    (error) => error?.code === "TASK_WATCHDOG_TIMEOUT",
  );
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].label, "never-settles");
});

test("task watchdog observes a late task rejection after its timeout", async () => {
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);

  let rejectTask;
  const task = new Promise((resolve, reject) => {
    rejectTask = reject;
  });
  try {
    await assert.rejects(
      runWithTaskWatchdog(() => task, { timeoutMs: 5, label: "late-reject" }),
      (error) => error?.code === "TASK_WATCHDOG_TIMEOUT",
    );
    rejectTask(new Error("late task failure"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("a hung report-resume child is terminated by its process-group watchdog", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "report-resume-timeout-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = path.join(directory, "hang.cjs");
  fs.writeFileSync(fixture, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n");

  await assert.rejects(
    runReportChild([fixture], {
      env: process.env,
      label: "测试报表续跑",
      timeoutMs: 20,
      killGraceMs: 20,
    }),
    /测试报表续跑超时/,
  );
});

test("the scheduled resume watchdog always outlives its nested report watchdog", () => {
  assert.equal(scheduledResumeTimeoutMs({}), 16 * 60 * 1000);
  assert.equal(scheduledResumeTimeoutMs({
    SCHEDULED_REPORT_TIMEOUT_MS: "100",
    SCHEDULED_REPORT_RESUME_TIMEOUT_MS: "110",
  }), 30 * 1000 + 100);
  assert.equal(scheduledResumeTimeoutMs({
    SCHEDULED_REPORT_TIMEOUT_MS: "100",
    SCHEDULED_REPORT_RESUME_TIMEOUT_MS: "60000",
  }), 60000);
});

test("best-effort acknowledgements cannot replace a completed repair outcome", async () => {
  const state = { status: "manual-ok" };
  const warnings = [];
  const sent = await sendBestEffort(
    "登录恢复回复",
    async () => {
      throw new Error("session webhook unavailable");
    },
    (warning) => warnings.push(warning),
  );

  assert.equal(sent, false);
  assert.equal(state.status, "manual-ok");
  assert.equal(warnings.length, 1);
});
