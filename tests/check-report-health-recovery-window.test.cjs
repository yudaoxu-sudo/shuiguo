const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  checkReportHealth,
  deferZhimadiHealthFailure,
  isZhimadiRepairIncidentResolved,
  markReportHealthOk,
  runNodePreview,
} = require("../scripts/check-report-health.cjs");
const {
  assertCurrentReportTargetDate,
  resolveReportTargetDate,
  runReport,
  scheduledLoginDeferral,
  scheduledZhimadiDeferral,
} = require("../scripts/run-scheduled-report.cjs");

const baseNow = Date.parse("2026-07-30T04:00:00.000Z");
const silent = () => {};

test("scheduled report target dates are explicit and validated", () => {
  assert.equal(resolveReportTargetDate("2026-08-10"), "2026-08-10");
  assert.equal(resolveReportTargetDate("", "2026-08-11"), "2026-08-11");
  assert.throws(() => resolveReportTargetDate("2026-02-30"), /日期无效/);
  assert.throws(() => resolveReportTargetDate("../../etc/passwd"), /日期无效/);
  assert.equal(
    assertCurrentReportTargetDate("2026-08-11", "2026-08-11"),
    "2026-08-11",
  );
  assert.throws(
    () => assertCurrentReportTargetDate("2026-08-10", "2026-08-11"),
    /拒绝自动生成/,
  );
});

test("the scheduled wrapper terminates a hung report child", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-timeout-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = path.join(directory, "hang.cjs");
  fs.writeFileSync(fixture, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n");

  const result = await runReport(fixture, "2026-08-11", {
    timeoutMs: 20,
    killGraceMs: 20,
  });
  assert.equal(result.code, 1);
  assert.match(result.outputTail, /子进程超时/);
});

test("Zhimadi repair deferral excludes combined Lemeng login failures", () => {
  const repairState = {
    status: "auto-retrying",
    incidentId: "repair-1",
    incidentStartedAt: "2026-07-30T03:00:00.000Z",
    deadlineAt: "2026-07-30T06:00:00.000Z",
  };
  const loadRepairState = () => repairState;

  assert.equal(deferZhimadiHealthFailure({
    failure: { problemKey: "zhimadi-login" },
    message: "登录态异常：芝麻地登录态失效；乐檬登录态失效",
  }, loadRepairState), null);
  assert.equal(deferZhimadiHealthFailure({
    failure: { problemKey: "zhimadi-login" },
    message: "芝麻地登录态失效；抖音报表加载失败",
  }, loadRepairState), null);

  assert.deepEqual(deferZhimadiHealthFailure({
    failure: { problemKey: "zhimadi-login" },
    message: "登录态异常：芝麻地登录态失效",
  }, loadRepairState), {
    active: true,
    waitingForHuman: false,
    reason: "zhimadi-auto-repair",
    incidentId: "repair-1",
    startedAt: "2026-07-30T03:00:00.000Z",
    until: "2026-07-30T06:00:00.000Z",
    promptSentAt: null,
  });
});

test("scheduled final alerts defer only the matching active Zhimadi login incident", () => {
  const repairState = {
    status: "auto-retrying",
    incidentId: "repair-1",
    incidentStartedAt: "2026-07-30T03:00:00.000Z",
    deadlineAt: "2026-07-30T06:00:00.000Z",
  };
  const loadRepairState = () => repairState;

  assert.ok(scheduledZhimadiDeferral(
    "芝麻地自动登录正在后台重试",
    loadRepairState,
  ));
  assert.equal(scheduledZhimadiDeferral(
    "抖音报表加载超时",
    loadRepairState,
  ), null);
  assert.equal(scheduledZhimadiDeferral(
    "TypeError: report builder invariant failed",
    loadRepairState,
  ), null);

  assert.deepEqual(scheduledLoginDeferral(
    { code: 2 },
    "芝麻地登录态失效，自动修复已交由后台继续",
    () => ({ status: "auto-ok" }),
  ), { phase: "child-deferred-login-repair" });
});

test("a scheduled report can mark report health healthy at its proof time", () => {
  let state;
  markReportHealthOk("2026-08-07T14:12:00.000Z", (next) => {
    state = next;
  });
  assert.deepEqual(state, {
    status: "ok",
    lastCheckAt: "2026-08-07T14:12:00.000Z",
  });

  const scheduledSource = fs.readFileSync(
    path.resolve(__dirname, "../scripts/run-scheduled-report.cjs"),
    "utf8",
  );
  assert.match(scheduledSource, /markReportHealthOk\(sentAt\)/);
  assert.match(scheduledSource, /markReportHealthOk\(previous\.sentAt/);
});

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

test("an external Zhimadi repair incident defers the health alert without a long-lived sleep", async () => {
  const harness = createHarness([
    { error: "报表预检退出码 1：芝麻地自动登录正在后台重试" },
  ]);
  const startedAt = new Date(baseNow - 60 * 60 * 1000).toISOString();
  const deadlineAt = new Date(baseNow + 2 * 60 * 60 * 1000).toISOString();

  const result = await checkReportHealth({
    ...harness.options,
    deferFailure: async ({ failure }) => ({
      active: failure.problemKey === "zhimadi-login",
      reason: "zhimadi-auto-repair",
      incidentId: startedAt,
      startedAt,
      until: deadlineAt,
    }),
  });

  assert.equal(result.status, "recovering");
  assert.equal(result.deferred, true);
  assert.equal(harness.attempts, 1);
  assert.equal(harness.sends.length, 0);
  assert.deepEqual(harness.sleeps, []);
  assert.equal(harness.state.status, "recovering");
  assert.equal(harness.state.incidentStartedAt, startedAt);
  assert.equal(harness.state.recoveryDeadlineAt, deadlineAt);
  assert.equal(harness.state.deferredBy, "zhimadi-auto-repair");
});

test("a completed Zhimadi repair clears the stale health incident before preview", async () => {
  const incidentStartedAt = "2026-07-30T01:00:00.000Z";
  const harness = createHarness([
    { error: "报表预检退出码 1：芝麻地登录态失效" },
    {},
  ], {
    status: "recovering",
    problemKey: "zhimadi-login",
    incidentId: incidentStartedAt,
    incidentStartedAt,
    recoveryDeadlineAt: "2026-07-30T04:00:05.000Z",
  });
  const repairState = {
    status: "auto-ok",
    completedAt: "2026-07-30T01:15:00.000Z",
  };

  const result = await checkReportHealth({
    ...harness.options,
    recoveryWindowMs: 20 * 60 * 1000,
    retryIntervalMs: 60 * 1000,
    previewTimeoutMs: 10 * 60 * 1000,
    isIncidentResolved: (details) => isZhimadiRepairIncidentResolved(
      details,
      () => repairState,
    ),
  });

  assert.equal(result.status, "ok");
  assert.equal(harness.previewOptions[0].verifyOnly, false);
  assert.equal(harness.previewOptions[0].timeoutMs, 10 * 60 * 1000);
  assert.equal(harness.writes[0].incidentStartedAt, "2026-07-30T04:00:00.000Z");
  assert.equal(harness.writes[0].recoveryDeadlineAt, "2026-07-30T04:20:00.000Z");
  assert.equal(harness.sends.length, 0);
});

test("a delivered Zhimadi captcha prompt suppresses duplicate health alerts", async () => {
  const harness = createHarness([
    { error: "报表预检退出码 1：芝麻地验证码已发送到钉钉" },
  ]);
  const promptSentAt = new Date(baseNow - 1000).toISOString();

  const result = await checkReportHealth({
    ...harness.options,
    recoveryWindowMs: 0,
    deferFailure: async () => ({
      active: true,
      waitingForHuman: true,
      reason: "zhimadi-human-prompt",
      promptSentAt,
    }),
  });

  assert.equal(result.status, "recovering");
  assert.equal(harness.sends.length, 0);
  assert.equal(harness.state.status, "waiting-login-captcha");
  assert.equal(harness.state.captchaPromptSentAt, promptSentAt);
});

test("a new external repair incident does not inherit an older Zhimadi incident id", async () => {
  const oldIncidentAt = new Date(baseNow - 4 * 60 * 60 * 1000).toISOString();
  const newIncidentAt = new Date(baseNow - 60 * 1000).toISOString();
  const harness = createHarness([
    { error: "报表预检退出码 1：芝麻地自动登录正在后台重试" },
  ], {
    status: "recovering",
    incidentId: oldIncidentAt,
    problemKey: "zhimadi-login",
    incidentStartedAt: oldIncidentAt,
    recoveryDeadlineAt: new Date(baseNow + 10 * 60 * 1000).toISOString(),
  });

  await checkReportHealth({
    ...harness.options,
    deferFailure: async () => ({
      active: true,
      reason: "zhimadi-auto-repair",
      incidentId: newIncidentAt,
      startedAt: newIncidentAt,
      until: new Date(baseNow + 3 * 60 * 60 * 1000).toISOString(),
    }),
  });

  assert.equal(harness.state.incidentId, newIncidentAt);
  assert.equal(harness.state.incidentStartedAt, newIncidentAt);
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

test("a near-deadline timeout gets a real final verification and preserves the source", async () => {
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
  assert.equal(harness.previewOptions[1].timeoutMs, 2 * 60 * 1000);
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

test("report health requests identify their alert owner", () => {
  const dailyReportSource = fs.readFileSync(
    path.resolve(__dirname, "../scripts/daily-report.cjs"),
    "utf8",
  );
  assert.match(
    dailyReportSource,
    /failureAlertOwner:\s*process\.env\.ZHIMADI_REPAIR_FAILURE_ALERT_OWNER/,
  );
});
