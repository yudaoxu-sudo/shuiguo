const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  checkReportHealth,
  runNodePreview,
} = require("../scripts/check-report-health.cjs");
const {
  shouldSendZhimadiRepairFailureAlert,
} = require("../scripts/listen-dingtalk.cjs");

const baseNow = Date.parse("2026-07-30T04:00:00.000Z");
const silent = () => {};

test("timeout waits for the process-group kill before retry can continue", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "preview-timeout-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixturePath = path.join(directory, "fixture.cjs");
  fs.writeFileSync(fixturePath, [
    'const { spawn } = require("child_process");',
    "spawn(process.execPath, [",
    '  "-e",',
    '  "process.on(\\\"SIGTERM\\\", () => {}); setInterval(() => {}, 1000)",',
    '], { stdio: "ignore" });',
    'process.on("SIGTERM", () => process.exit(0));',
    "setInterval(() => {}, 1000);",
  ].join("\n"));

  const startedAt = Date.now();
  await assert.rejects(
    runNodePreview(fixturePath, {
      timeoutMs: 20,
      label: "测试预检",
    }),
    /测试预检超时/,
  );
  assert.ok(Date.now() - startedAt >= 2900);
});

function createHarness(outcomes, initialState = null) {
  const harness = {
    now: baseNow,
    state: initialState,
    writes: [],
    sends: [],
    sleeps: [],
    previewOptions: [],
    attempts: 0,
    sendError: null,
  };

  harness.options = {
    now: () => harness.now,
    loadState: () => structuredClone(harness.state),
    persist(state) {
      harness.state = structuredClone(state);
      harness.writes.push(structuredClone(state));
    },
    async runPreview(options = {}) {
      harness.previewOptions.push(structuredClone(options));
      const outcome = outcomes[Math.min(harness.attempts, outcomes.length - 1)];
      harness.attempts += 1;
      if (outcome.hang) {
        harness.now += options.timeoutMs + (outcome.killGraceMs || 0);
        const error = new Error(
          outcome.error
            || `报表预检超时 ${Math.round(options.timeoutMs / 1000)} 秒`,
        );
        error.code = outcome.code || "PREVIEW_TIMEOUT";
        throw error;
      }
      if (outcome.advanceMs) harness.now += outcome.advanceMs;
      if (outcome.error) {
        const error = new Error(outcome.error);
        if (outcome.healthFailureMessage) {
          error.healthFailureMessage = outcome.healthFailureMessage;
        }
        throw error;
      }
      return "report-ok";
    },
    async sleep(ms) {
      harness.sleeps.push(ms);
      harness.now += ms;
    },
    async send(title, text, options) {
      harness.sends.push({ title, text, options });
      if (harness.sendError) throw harness.sendError;
    },
    log: silent,
  };

  return harness;
}

test("transient precheck failure recovers inside twenty minutes without an alert", async () => {
  const harness = createHarness([
    {
      advanceMs: 2 * 60 * 1000,
      error: "报表预检退出码 1：等待芝麻地自动登录修复超时",
    },
    { advanceMs: 20 * 1000 },
  ]);

  const result = await checkReportHealth({
    ...harness.options,
    recoveryWindowMs: 20 * 60 * 1000,
    retryIntervalMs: 60 * 1000,
    previewTimeoutMs: 10 * 60 * 1000,
  });

  assert.equal(result.status, "ok");
  assert.equal(harness.attempts, 2);
  assert.equal(harness.sends.length, 0);
  assert.equal(harness.writes[0].status, "recovering");
  assert.equal(harness.state.status, "ok");
  assert.deepEqual(harness.sleeps, [60 * 1000]);
});

test("persistent failure alerts once after the twenty minute recovery window", async () => {
  const harness = createHarness([
    { error: "报表预检退出码 1：芝麻地登录态失效" },
  ]);

  const result = await checkReportHealth({
    ...harness.options,
    recoveryWindowMs: 20 * 60 * 1000,
    retryIntervalMs: 5 * 60 * 1000,
    previewTimeoutMs: 10 * 60 * 1000,
  });

  assert.equal(result.status, "failed");
  assert.equal(harness.attempts, 5);
  assert.equal(harness.sends.length, 1);
  assert.equal(harness.sends[0].title, "水果店报表预检失败");
  assert.equal(harness.state.status, "failed");
  assert.equal(harness.state.incidentStartedAt, "2026-07-30T04:00:00.000Z");
  assert.equal(harness.state.lastAlertAt, "2026-07-30T04:20:00.000Z");
});

test("the same unresolved incident never sends a second alert", async () => {
  const incidentStartedAt = "2026-07-30T04:00:00.000Z";
  const harness = createHarness(
    [{ error: "报表预检退出码 1：芝麻地登录态失效" }],
    {
      status: "failed",
      problemKey: "zhimadi-login",
      incidentStartedAt,
      incidentId: incidentStartedAt,
      recoveryDeadlineAt: "2026-07-30T04:20:00.000Z",
      lastAlertAttemptAt: "2026-07-30T04:20:00.000Z",
      lastAlertAt: "2026-07-30T04:20:00.000Z",
    },
  );
  harness.now = baseNow + 3 * 60 * 60 * 1000;

  const result = await checkReportHealth({
    ...harness.options,
    recoveryWindowMs: 20 * 60 * 1000,
    retryIntervalMs: 60 * 1000,
    previewTimeoutMs: 10 * 60 * 1000,
  });

  assert.equal(result.status, "failed");
  assert.equal(harness.attempts, 1);
  assert.equal(harness.sends.length, 0);
  assert.equal(harness.state.lastAlertAt, "2026-07-30T04:20:00.000Z");
});

test("a successful precheck resolves the old incident and permits a future incident", async () => {
  const incidentStartedAt = "2026-07-30T04:00:00.000Z";
  const harness = createHarness(
    [{}],
    {
      status: "failed",
      problemKey: "zhimadi-login",
      incidentStartedAt,
      incidentId: incidentStartedAt,
      recoveryDeadlineAt: "2026-07-30T04:20:00.000Z",
      lastAlertAttemptAt: "2026-07-30T04:20:00.000Z",
      lastAlertAt: "2026-07-30T04:20:00.000Z",
    },
  );
  harness.now = baseNow + 3 * 60 * 60 * 1000;

  const result = await checkReportHealth({
    ...harness.options,
    recoveryWindowMs: 20 * 60 * 1000,
    retryIntervalMs: 60 * 1000,
    previewTimeoutMs: 10 * 60 * 1000,
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(harness.state, {
    status: "ok",
    lastCheckAt: "2026-07-30T07:00:00.000Z",
  });

  const future = createHarness(
    [{ error: "报表预检退出码 1：芝麻地登录态失效" }],
    harness.state,
  );
  future.now = harness.now;
  const futureResult = await checkReportHealth({
    ...future.options,
    recoveryWindowMs: 20 * 60 * 1000,
    retryIntervalMs: 10 * 60 * 1000,
    previewTimeoutMs: 10 * 60 * 1000,
  });
  assert.equal(futureResult.status, "failed");
  assert.equal(future.sends.length, 1);
  assert.equal(future.state.incidentStartedAt, "2026-07-30T07:00:00.000Z");
});

test("a captcha prompt waits until the deadline and a successful final check stays silent", async () => {
  const harness = createHarness([
    { error: "芝麻地验证码已发送到钉钉，请回复：验证码ABCD" },
    {},
  ]);

  const result = await checkReportHealth({
    ...harness.options,
    recoveryWindowMs: 20 * 60 * 1000,
    retryIntervalMs: 60 * 1000,
    previewTimeoutMs: 10 * 60 * 1000,
  });

  assert.equal(result.status, "ok");
  assert.equal(harness.sends.length, 0);
  assert.equal(harness.attempts, 2);
  assert.equal(harness.writes[0].status, "waiting-login-captcha");
  assert.equal(
    harness.writes[0].captchaPromptSentAt,
    "2026-07-30T04:00:00.000Z",
  );
  assert.equal(harness.previewOptions[1].verifyOnly, true);
});

test("an unanswered captcha prompt produces one failure alert after twenty minutes", async () => {
  const harness = createHarness([
    { error: "芝麻地验证码已发送到钉钉，请回复：验证码ABCD" },
    { error: "报表预检退出码 1：芝麻地登录态失效" },
  ]);

  const result = await checkReportHealth({
    ...harness.options,
    recoveryWindowMs: 20 * 60 * 1000,
    retryIntervalMs: 60 * 1000,
    previewTimeoutMs: 10 * 60 * 1000,
  });

  assert.equal(result.status, "failed");
  assert.equal(harness.sends.length, 1);
  assert.equal(harness.state.lastAlertAt, "2026-07-30T04:20:00.000Z");
});

test("a different source starts a new incident instead of inheriting an old alert", async () => {
  const incidentStartedAt = "2026-07-30T04:00:00.000Z";
  const harness = createHarness(
    [{ error: "报表预检退出码 1：乐檬报表加载超时" }],
    {
      status: "failed",
      problemKey: "zhimadi-login",
      incidentStartedAt,
      incidentId: incidentStartedAt,
      recoveryDeadlineAt: "2026-07-30T04:20:00.000Z",
      lastAlertAttemptAt: "2026-07-30T04:20:00.000Z",
      lastAlertAt: "2026-07-30T04:20:00.000Z",
    },
  );
  harness.now = baseNow + 3 * 60 * 60 * 1000;

  const result = await checkReportHealth({
    ...harness.options,
    recoveryWindowMs: 20 * 60 * 1000,
    retryIntervalMs: 10 * 60 * 1000,
    previewTimeoutMs: 10 * 60 * 1000,
  });

  assert.equal(result.status, "failed");
  assert.equal(harness.sends.length, 1);
  assert.equal(harness.state.problemKey, "lemeng-report");
  assert.equal(harness.state.incidentStartedAt, "2026-07-30T07:00:00.000Z");
});

test("an expired recovery from another source cannot shorten a new window", async () => {
  const incidentStartedAt = "2026-07-30T04:00:00.000Z";
  const harness = createHarness(
    [{ error: "报表预检退出码 1：乐檬报表加载超时" }],
    {
      status: "recovering",
      problemKey: "zhimadi-login",
      incidentStartedAt,
      incidentId: incidentStartedAt,
      recoveryDeadlineAt: "2026-07-30T04:20:00.000Z",
    },
  );
  harness.now = baseNow + 30 * 60 * 1000;

  const result = await checkReportHealth({
    ...harness.options,
    recoveryWindowMs: 20 * 60 * 1000,
    retryIntervalMs: 10 * 60 * 1000,
    previewTimeoutMs: 10 * 60 * 1000,
  });

  assert.equal(result.status, "failed");
  assert.equal(harness.sends.length, 1);
  assert.equal(harness.state.incidentStartedAt, "2026-07-30T04:30:00.000Z");
  assert.equal(harness.state.recoveryDeadlineAt, "2026-07-30T04:50:00.000Z");
});

test("alternating transient sources cannot extend the recovery window forever", async () => {
  const outcomes = Array.from({ length: 8 }, (_, index) => ({
    error: index % 2 === 0
      ? "报表预检退出码 1：芝麻地登录态失效"
      : "报表预检退出码 1：乐檬报表加载超时",
  }));
  const harness = createHarness(outcomes);

  const result = await checkReportHealth({
    ...harness.options,
    recoveryWindowMs: 1000,
    retryIntervalMs: 250,
    previewTimeoutMs: 1000,
    finalVerificationTimeoutMs: 100,
  });

  assert.equal(result.status, "failed");
  assert.equal(harness.sends.length, 1);
  assert.ok(harness.now <= baseNow + 1100);
});

test("a non-retryable code error alerts immediately", async () => {
  const harness = createHarness([
    { error: "TypeError: buildReport is not a function" },
  ]);

  const result = await checkReportHealth({
    ...harness.options,
    recoveryWindowMs: 20 * 60 * 1000,
    retryIntervalMs: 60 * 1000,
    previewTimeoutMs: 10 * 60 * 1000,
  });

  assert.equal(result.status, "failed");
  assert.equal(harness.attempts, 1);
  assert.equal(harness.sends.length, 1);
  assert.match(harness.sends[0].text, /无法自动修复/);
});

test("classification uses the final structured error instead of retry logs", async () => {
  const harness = createHarness([
    {
      error: `${"芝麻地报表第 1 次失败：临时错误\n".repeat(80)}Error: 乐檬登录态失效`,
      healthFailureMessage: "乐檬登录态失效",
    },
  ]);

  const result = await checkReportHealth({
    ...harness.options,
    recoveryWindowMs: 0,
  });

  assert.equal(result.status, "failed");
  assert.equal(harness.state.problemKey, "lemeng-login");
});

test("an expired incident uses only the bounded final verification timeout", async () => {
  const incidentStartedAt = "2026-07-30T04:00:00.000Z";
  const harness = createHarness(
    [{ hang: true, error: "等待芝麻地自动登录修复超时" }],
    {
      status: "recovering",
      problemKey: "zhimadi-login",
      incidentStartedAt,
      incidentId: incidentStartedAt,
      recoveryDeadlineAt: "2026-07-30T04:20:00.000Z",
    },
  );
  harness.now = baseNow + 20 * 60 * 1000;

  const result = await checkReportHealth({
    ...harness.options,
    recoveryWindowMs: 20 * 60 * 1000,
    retryIntervalMs: 60 * 1000,
    previewTimeoutMs: 10 * 60 * 1000,
    finalVerificationTimeoutMs: 2 * 60 * 1000,
  });

  assert.equal(result.status, "failed");
  assert.equal(harness.previewOptions[0].timeoutMs, 2 * 60 * 1000);
  assert.equal(harness.state.lastAlertAt, "2026-07-30T04:22:00.000Z");
});

test("a deadline-bounded timeout preserves the previous source incident", async () => {
  const harness = createHarness([
    { error: "报表预检退出码 1：抖音门店汇总超过本月总额" },
    { hang: true, killGraceMs: 3000 },
  ]);
  const claimed = [];

  const result = await checkReportHealth({
    ...harness.options,
    recoveryWindowMs: 20 * 60 * 1000,
    retryIntervalMs: 19 * 60 * 1000 + 10 * 1000,
    previewTimeoutMs: 10 * 60 * 1000,
    finalVerificationTimeoutMs: 2 * 60 * 1000,
    claimAlert: async (problemKey) => {
      claimed.push(problemKey);
      return true;
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(harness.previewOptions[1].timeoutMs, 50 * 1000);
  assert.equal(harness.state.problemKey, "douyin-report");
  assert.equal(harness.state.incidentStartedAt, "2026-07-30T04:00:00.000Z");
  assert.equal(harness.state.recoveryDeadlineAt, "2026-07-30T04:20:00.000Z");
  assert.match(harness.state.message, /抖音门店汇总超过本月总额/);
  assert.match(harness.state.message, /最终复验：报表预检超时/);
  assert.equal(harness.sends.length, 1);
  assert.deepEqual(claimed, ["douyin-report"]);

  const repeated = createHarness([
    { error: "报表预检退出码 1：抖音门店汇总超过本月总额" },
  ], harness.state);
  repeated.now = harness.now + 1000;
  const repeatedResult = await checkReportHealth({
    ...repeated.options,
    recoveryWindowMs: 20 * 60 * 1000,
  });
  assert.equal(repeatedResult.alerted, false);
  assert.equal(repeated.sends.length, 0);
});

test("an uncertain alert delivery is reserved and never repeated", async () => {
  const harness = createHarness([
    { error: "报表预检退出码 1：芝麻地登录态失效" },
  ]);
  harness.sendError = new Error("webhook unavailable");

  await assert.rejects(
    checkReportHealth({
      ...harness.options,
      recoveryWindowMs: 0,
      retryIntervalMs: 1000,
      previewTimeoutMs: 1000,
      finalVerificationTimeoutMs: 1000,
    }),
    /webhook unavailable/,
  );
  assert.equal(harness.state.status, "alert-unknown");
  assert.ok(harness.state.lastAlertAttemptAt);

  harness.sendError = null;
  harness.now += 61 * 60 * 1000;
  const result = await checkReportHealth({
    ...harness.options,
    recoveryWindowMs: 0,
    retryIntervalMs: 1000,
    previewTimeoutMs: 1000,
    finalVerificationTimeoutMs: 1000,
  });

  assert.equal(result.status, "failed");
  assert.equal(harness.sends.length, 1);
  assert.equal(result.alerted, false);
  assert.equal(harness.state.lastAlertAt, undefined);
});

test("two health chains share one Zhimadi alert claim", async () => {
  let claimed = false;
  const claimAlert = async (problemKey) => {
    assert.equal(problemKey, "zhimadi-login");
    if (claimed) return false;
    claimed = true;
    return true;
  };
  const first = createHarness([
    { error: "报表预检退出码 1：芝麻地登录态失效" },
  ]);
  const second = createHarness([
    { error: "登录态异常：芝麻地登录态失效" },
  ]);

  const firstResult = await checkReportHealth({
    ...first.options,
    recoveryWindowMs: 0,
    claimAlert,
  });
  const secondResult = await checkReportHealth({
    ...second.options,
    recoveryWindowMs: 0,
    claimAlert,
  });

  assert.equal(firstResult.alerted, true);
  assert.equal(secondResult.alerted, false);
  assert.equal(first.sends.length + second.sends.length, 1);
});

test("a shared suppression does not consume the local alert opportunity", async () => {
  const harness = createHarness([
    { error: "报表预检退出码 1：芝麻地登录态失效" },
  ]);
  let sharedAvailable = false;
  let claimCalls = 0;
  const claimAlert = async () => {
    claimCalls += 1;
    return sharedAvailable;
  };

  const suppressed = await checkReportHealth({
    ...harness.options,
    recoveryWindowMs: 0,
    claimAlert,
  });
  assert.equal(suppressed.alerted, false);
  assert.equal(harness.state.lastAlertAttemptAt, undefined);

  sharedAvailable = true;
  harness.now += 1000;
  const sent = await checkReportHealth({
    ...harness.options,
    recoveryWindowMs: 0,
    claimAlert,
  });
  assert.equal(sent.alerted, true);
  assert.equal(claimCalls, 2);
  assert.equal(harness.sends.length, 1);
});

test("shared recovery starts a fresh local twenty minute incident", async () => {
  const incidentStartedAt = "2026-07-30T04:00:00.000Z";
  const harness = createHarness(
    [{ error: "报表预检退出码 1：芝麻地登录态失效" }],
    {
      status: "failed",
      problemKey: "zhimadi-login",
      incidentStartedAt,
      incidentId: incidentStartedAt,
      recoveryDeadlineAt: "2026-07-30T04:20:00.000Z",
      lastAlertAttemptAt: "2026-07-30T04:20:00.000Z",
      lastAlertAt: "2026-07-30T04:20:00.000Z",
    },
  );
  harness.now = baseNow + 61 * 60 * 1000;

  const result = await checkReportHealth({
    ...harness.options,
    recoveryWindowMs: 20 * 60 * 1000,
    retryIntervalMs: 10 * 60 * 1000,
    isSharedProblem: (problemKey) => problemKey === "zhimadi-login",
    getSharedAlertState: async () => ({
      status: "resolved",
      resolvedAt: "2026-07-30T05:00:00.000Z",
    }),
    claimAlert: async () => true,
  });

  assert.equal(result.alerted, true);
  assert.equal(harness.state.incidentStartedAt, "2026-07-30T05:01:00.000Z");
  assert.equal(harness.state.recoveryDeadlineAt, "2026-07-30T05:21:00.000Z");
});

test("another source history cannot extend the current recovery ceiling", async () => {
  const harness = createHarness([
    { error: "报表预检退出码 1：芝麻地登录态失效" },
    { error: "报表预检退出码 1：乐檬登录态失效" },
  ]);

  const result = await checkReportHealth({
    ...harness.options,
    recoveryWindowMs: 1000,
    retryIntervalMs: 1000,
    finalVerificationTimeoutMs: 100,
    isSharedProblem: () => true,
    getSharedAlertState: async (problemKey) => problemKey === "lemeng-login"
      ? {
          status: "resolved",
          resolvedAt: new Date(baseNow + 100).toISOString(),
        }
      : null,
    claimAlert: async () => true,
  });

  assert.equal(result.status, "failed");
  assert.equal(harness.now, baseNow + 1000);
  assert.equal(harness.state.recoveryDeadlineAt, new Date(baseNow + 1000).toISOString());
});

test("a downstream failure resolves login claims verified by that probe", async () => {
  const harness = createHarness([
    { error: "报表预检退出码 1：抖音报表加载超时" },
  ]);
  const resolved = [];

  await checkReportHealth({
    ...harness.options,
    recoveryWindowMs: 0,
    claimAlert: async () => false,
    resolveAlert: async (...args) => resolved.push(args),
  });

  assert.deepEqual(resolved, [
    ["zhimadi-login", "2026-07-30T04:00:00.000Z", baseNow],
    ["lemeng-login", "2026-07-30T04:00:00.000Z", baseNow],
  ]);
});

test("report-healthcheck owned repair failures do not trigger a listener alert", () => {
  assert.equal(
    shouldSendZhimadiRepairFailureAlert({
      failureAlertOwner: "report-healthcheck",
    }),
    false,
  );
  assert.equal(
    shouldSendZhimadiRepairFailureAlert({
      failureAlertOwner: "login-healthcheck",
    }),
    false,
  );
  assert.equal(shouldSendZhimadiRepairFailureAlert({}), true);

  const dailyReportSource = fs.readFileSync(
    path.resolve(__dirname, "../scripts/daily-report.cjs"),
    "utf8",
  );
  assert.match(
    dailyReportSource,
    /failureAlertOwner:\s*process\.env\.ZHIMADI_REPAIR_FAILURE_ALERT_OWNER/,
  );
});
