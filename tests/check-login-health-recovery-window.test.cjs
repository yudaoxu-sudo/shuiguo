const assert = require("node:assert/strict");
const test = require("node:test");

const {
  checkLoginHealth,
  createLoginProbe,
} = require("../scripts/check-login-health.cjs");
const {
  checkReportHealth,
} = require("../scripts/check-report-health.cjs");

const baseNow = Date.parse("2026-07-30T04:00:00.000Z");

function createHarness(outcomes, initialState = null) {
  const harness = {
    now: baseNow,
    state: initialState,
    sends: [],
    logs: [],
    attempts: 0,
  };
  harness.options = {
    now: () => harness.now,
    loadState: () => structuredClone(harness.state),
    persist(state) {
      harness.state = structuredClone(state);
    },
    async runPreview() {
      const outcome = outcomes[Math.min(harness.attempts, outcomes.length - 1)];
      harness.attempts += 1;
      if (outcome.error) throw new Error(outcome.error);
      return "login-ok";
    },
    async sleep(ms) {
      harness.now += ms;
    },
    async send(title, text, options) {
      harness.sends.push({ title, text, options });
    },
    claimAlert: async () => true,
    isSharedProblem: () => false,
    resolveAlert: async () => {},
    log: (message) => harness.logs.push(message),
  };
  return harness;
}

test("login failure recovered inside twenty minutes stays silent", async () => {
  const harness = createHarness([
    { error: "登录态异常：乐檬登录态失效" },
    {},
  ]);

  const result = await checkLoginHealth({
    ...harness.options,
    recoveryWindowMs: 20 * 60 * 1000,
    retryIntervalMs: 60 * 1000,
  });

  assert.equal(result.status, "ok");
  assert.equal(harness.sends.length, 0);
  assert.equal(harness.state.status, "ok");
  assert.ok(harness.logs.includes("login-ok"));
});

test("persistent login failure alerts once after the recovery window", async () => {
  const harness = createHarness([
    { error: "登录态异常：芝麻地登录态失效" },
  ]);

  const result = await checkLoginHealth({
    ...harness.options,
    recoveryWindowMs: 1000,
    retryIntervalMs: 500,
    finalVerificationTimeoutMs: 100,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.alerted, true);
  assert.equal(harness.sends.length, 1);
  assert.equal(harness.sends[0].title, "水果店登录态异常");
  assert.equal(harness.state.incidentStartedAt, "2026-07-30T04:00:00.000Z");
  assert.equal(harness.state.lastAlertAt, "2026-07-30T04:00:01.000Z");

  harness.now += 2 * 60 * 60 * 1000;
  const repeated = await checkLoginHealth({
    ...harness.options,
    recoveryWindowMs: 1000,
    retryIntervalMs: 500,
    finalVerificationTimeoutMs: 100,
  });
  assert.equal(repeated.alerted, false);
  assert.equal(harness.sends.length, 1);
});

test("login probe requests one silent Zhimadi repair per run", async () => {
  const requests = [];
  const probe = createLoginProbe({
    inspect: async () => ["芝麻地登录态失效"],
    persistRepairRequest: (request) => requests.push(request),
    now: () => baseNow,
  });

  await assert.rejects(probe(), /芝麻地登录态失效/);
  await assert.rejects(probe(), /芝麻地登录态失效/);
  await assert.rejects(probe({ verifyOnly: true }), /芝麻地登录态失效/);

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    requestedAt: "2026-07-30T04:00:00.000Z",
    reason: "login-healthcheck",
    failureAlertOwner: "login-healthcheck",
  });
});

test("login probe retries a failed automatic repair after backoff", async () => {
  const requests = [];
  let now = baseNow;
  let repairState = null;
  const probe = createLoginProbe({
    inspect: async () => ["芝麻地登录态失效"],
    persistRepairRequest(request) {
      requests.push(request);
    },
    loadRepairState: () => repairState,
    now: () => now,
    repairRetryMs: 3 * 60 * 1000,
  });

  await assert.rejects(probe(), /芝麻地登录态失效/);
  repairState = {
    handledRequestAt: requests[0].requestedAt,
    status: "failed",
  };
  now += 2 * 60 * 1000;
  await assert.rejects(probe(), /芝麻地登录态失效/);
  assert.equal(requests.length, 1);

  now += 60 * 1000;
  await assert.rejects(probe(), /芝麻地登录态失效/);
  assert.equal(requests.length, 2);

  repairState = {
    handledRequestAt: requests[1].requestedAt,
    status: "captcha-sent",
  };
  now += 10 * 60 * 1000;
  await assert.rejects(probe(), /芝麻地登录态失效/);
  assert.equal(requests.length, 2);
});

test("login and report checks share one Lemeng login alert claim", async () => {
  const claimed = new Set();
  const claimAlert = async (problemKey) => {
    if (claimed.has(problemKey)) return false;
    claimed.add(problemKey);
    return true;
  };
  const login = createHarness([
    { error: "登录态异常：乐檬登录态失效" },
  ]);
  const report = createHarness([
    { error: "报表预检退出码 1：乐檬登录态失效" },
  ]);

  const loginResult = await checkLoginHealth({
    ...login.options,
    recoveryWindowMs: 0,
    claimAlert,
  });
  const reportResult = await checkReportHealth({
    ...report.options,
    recoveryWindowMs: 0,
    claimAlert,
  });

  assert.equal(loginResult.alerted, true);
  assert.equal(reportResult.alerted, false);
  assert.equal(login.sends.length + report.sends.length, 1);
  assert.deepEqual([...claimed], ["lemeng-login"]);
});

test("login probe resolves the other source it explicitly verified", async () => {
  const harness = createHarness([
    { error: "登录态异常：芝麻地登录态失效" },
  ]);
  const resolved = [];

  await checkLoginHealth({
    ...harness.options,
    recoveryWindowMs: 0,
    claimAlert: async () => false,
    resolveAlert: async (...args) => resolved.push(args),
  });

  assert.deepEqual(resolved, [
    ["lemeng-login", "2026-07-30T04:00:00.000Z", baseNow],
  ]);
});
