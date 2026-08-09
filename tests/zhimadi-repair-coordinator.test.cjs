const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createZhimadiRepairCoordinator,
  markObservedZhimadiRecovery,
  markManualRepair,
  requesterCanResumeReport,
  runSingleCaptchaAttempt,
  zhimadiRepairDeferral,
} = require("../scripts/zhimadi-repair-coordinator.cjs");

const minute = 60 * 1000;
const baseNow = Date.parse("2026-08-09T01:00:00.000Z");

function requestAt(timestamp, extra = {}) {
  return {
    requestedAt: new Date(timestamp).toISOString(),
    reason: "login-healthcheck",
    ...extra,
  };
}

function createHarness(outcomes) {
  const harness = {
    now: baseNow,
    state: null,
    attempts: [],
    escalations: [],
  };
  harness.coordinator = createZhimadiRepairCoordinator({
    loadState: () => structuredClone(harness.state),
    persistState: (state) => {
      harness.state = structuredClone(state);
    },
    runAttempt: async (details) => {
      harness.attempts.push(structuredClone(details));
      return outcomes[Math.min(harness.attempts.length - 1, outcomes.length - 1)];
    },
    escalate: async (details) => {
      harness.escalations.push(structuredClone(details));
      return { outcome: "captcha-sent" };
    },
    now: () => harness.now,
    silentWindowMs: 3 * 60 * minute,
    lockBusyDelayMs: minute,
  });
  return harness;
}

test("coalesces producer requests into one silent incident with bounded backoff", async () => {
  const harness = createHarness([
    { outcome: "failed", reason: "empty-code" },
    { outcome: "failed", reason: "rejected-code" },
    { outcome: "lock-busy" },
    { outcome: "failed", reason: "page-error" },
  ]);

  await harness.coordinator.tick(requestAt(baseNow, { afterLoginReport: false }));
  assert.equal(harness.state.status, "auto-retrying");
  assert.equal(harness.state.incidentStartedAt, "2026-08-09T01:00:00.000Z");
  assert.equal(harness.state.deadlineAt, "2026-08-09T04:00:00.000Z");
  assert.equal(harness.state.nextAttemptAt, "2026-08-09T01:05:00.000Z");
  assert.equal(harness.state.promptSentAt, null);
  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.escalations.length, 0);

  harness.now += 4 * minute;
  await harness.coordinator.tick(requestAt(baseNow + minute, { afterLoginReport: true }));
  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.state.handledRequestAt, "2026-08-09T01:01:00.000Z");
  assert.equal(harness.state.afterLoginReport, true);

  harness.now += minute;
  await harness.coordinator.tick(requestAt(baseNow + minute));
  assert.equal(harness.attempts.length, 2);
  assert.equal(harness.state.nextAttemptAt, "2026-08-09T01:15:00.000Z");

  harness.now += 10 * minute;
  await harness.coordinator.tick(requestAt(baseNow + 2 * minute));
  assert.equal(harness.attempts.length, 3);
  assert.equal(harness.state.attemptCount, 2);
  assert.equal(harness.state.nextAttemptAt, "2026-08-09T01:16:00.000Z");

  harness.now += minute;
  await harness.coordinator.tick(requestAt(baseNow + 2 * minute));
  assert.equal(harness.attempts.length, 4);
  assert.equal(harness.state.nextAttemptAt, "2026-08-09T01:30:00.000Z");
  assert.equal(harness.escalations.length, 0);
});

test("continues a persisted incident after restart and escalates exactly once after the final attempt", async () => {
  const first = createHarness([{ outcome: "failed", reason: "empty-code" }]);
  await first.coordinator.tick(requestAt(baseNow));

  const resumed = createHarness([{ outcome: "failed", reason: "rejected-code" }]);
  resumed.state = structuredClone(first.state);
  resumed.now = baseNow + 3 * 60 * minute;

  await resumed.coordinator.tick(requestAt(baseNow + 2 * 60 * minute));
  assert.equal(resumed.attempts.length, 1);
  assert.equal(resumed.attempts[0].finalAttempt, true);
  assert.equal(resumed.escalations.length, 1);
  assert.equal(resumed.state.status, "captcha-sent");
  assert.equal(resumed.state.promptSentAt, "2026-08-09T04:00:00.000Z");

  resumed.now += 2 * 60 * minute;
  await resumed.coordinator.tick(requestAt(baseNow + 4 * 60 * minute));
  assert.equal(resumed.attempts.length, 1);
  assert.equal(resumed.escalations.length, 1);
  assert.equal(resumed.state.handledRequestAt, "2026-08-09T05:00:00.000Z");
});

test("records automatic success and permits a later verified outage to start a new incident", async () => {
  const harness = createHarness([{ outcome: "success" }, { outcome: "failed" }]);

  await harness.coordinator.tick(requestAt(baseNow));
  assert.equal(harness.state.status, "auto-ok");
  assert.equal(harness.state.completedAt, "2026-08-09T01:00:00.000Z");

  harness.now += 60 * minute;
  await harness.coordinator.tick(requestAt(harness.now));
  assert.equal(harness.attempts.length, 2);
  assert.equal(harness.state.status, "auto-retrying");
  assert.equal(harness.state.incidentStartedAt, "2026-08-09T02:00:00.000Z");
});

test("a request created during the successful round joins that recovery", async () => {
  const harness = createHarness([]);
  harness.coordinator = createZhimadiRepairCoordinator({
    loadState: () => structuredClone(harness.state),
    persistState: (state) => {
      harness.state = structuredClone(state);
    },
    runAttempt: async (details) => {
      harness.attempts.push(structuredClone(details));
      harness.now += 10 * minute;
      return { outcome: "success" };
    },
    escalate: async () => {
      throw new Error("must not escalate");
    },
    now: () => harness.now,
  });
  await harness.coordinator.tick(requestAt(baseNow));

  const joinedRequest = requestAt(baseNow + 5 * minute, {
    afterLoginReport: true,
    reportResumeMode: "scheduled",
    requesterPid: 42,
  });
  const result = await harness.coordinator.tick(joinedRequest);

  assert.equal(result.outcome, "inactive");
  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.state.handledRequestAt, joinedRequest.requestedAt);
  assert.equal(harness.state.afterLoginReport, true);
  assert.equal(harness.state.reportResumeMode, "scheduled");
  assert.equal(harness.state.requesterPid, 42);
});

test("submits no code for an empty OCR result and at most one valid code per round", async () => {
  const submitted = [];
  let confirmations = 0;
  const empty = await runSingleCaptchaAttempt({
    capture: async () => ({ captchaPath: "/tmp/unused.png" }),
    recognize: async () => ({ code: "", source: "none" }),
    submit: async (code) => submitted.push(code),
    confirmAuthenticated: async () => {
      confirmations += 1;
      return true;
    },
  });
  assert.deepEqual(empty, {
    outcome: "failed",
    reason: "empty-code",
    source: "none",
  });
  assert.deepEqual(submitted, []);
  assert.equal(confirmations, 0);

  const recognized = await runSingleCaptchaAttempt({
    capture: async () => ({ captchaPath: "/tmp/unused.png" }),
    recognize: async () => ({ code: "Ab12", source: "ddddocr" }),
    submit: async (code) => submitted.push(code),
    confirmAuthenticated: async () => {
      confirmations += 1;
      return false;
    },
  });
  assert.equal(recognized.outcome, "failed");
  assert.equal(recognized.reason, "authentication-not-confirmed");
  assert.deepEqual(submitted, ["Ab12"]);
  assert.equal(confirmations, 1);
});

test("a fatal invariant failure stops the incident without retrying or escalating", async () => {
  const harness = createHarness([{ outcome: "fatal", error: "missing account config" }]);

  await harness.coordinator.tick(requestAt(baseNow));
  assert.equal(harness.state.status, "fatal");
  assert.equal(harness.state.fatalAlertAttemptedAt, "2026-08-09T01:00:00.000Z");
  assert.equal(harness.state.nextAttemptAt, null);
  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.escalations.length, 0);

  harness.now += minute;
  await harness.coordinator.tick(requestAt(baseNow));
  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.escalations.length, 0);

  await harness.coordinator.tick(requestAt(baseNow + minute));
  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.escalations.length, 0);
});

test("a verified recovery clears a terminal incident and permits a later outage", async () => {
  const terminal = {
    schema: "zhimadi_login_repair.v2",
    status: "manual-expired",
    incidentId: "2026-08-09T01:00:00.000Z",
    incidentStartedAt: "2026-08-09T01:00:00.000Z",
    deadlineAt: "2026-08-09T04:00:00.000Z",
    handledRequestAt: "2026-08-09T01:00:00.000Z",
    nextAttemptAt: null,
  };
  const observedAt = baseNow + 4 * 60 * minute;
  const observed = markObservedZhimadiRecovery(terminal, observedAt);
  assert.equal(observed.status, "observed-ok");
  assert.equal(observed.completedAt, "2026-08-09T05:00:00.000Z");

  const harness = createHarness([{ outcome: "failed", reason: "empty-code" }]);
  harness.state = observed;
  harness.now = observedAt + 60 * minute;
  await harness.coordinator.tick(requestAt(harness.now));
  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.state.status, "auto-retrying");
  assert.equal(harness.state.incidentStartedAt, "2026-08-09T06:00:00.000Z");
});

test("an unexpected runner exception is fatal instead of entering the silent loop", async () => {
  const harness = createHarness([]);
  harness.coordinator = createZhimadiRepairCoordinator({
    loadState: () => structuredClone(harness.state),
    persistState: (state) => {
      harness.state = structuredClone(state);
    },
    runAttempt: async () => {
      throw new TypeError("unexpected invariant");
    },
    escalate: async () => {
      harness.escalations.push({ unexpected: true });
    },
    now: () => harness.now,
  });

  const result = await harness.coordinator.tick(requestAt(baseNow));
  assert.equal(result.outcome, "fatal");
  assert.equal(harness.state.status, "fatal");
  assert.equal(harness.escalations.length, 0);
});

test("an uncertain escalation is claimed once and never repeated after restart", async () => {
  const harness = createHarness([{ outcome: "failed", reason: "rejected-code" }]);
  harness.coordinator = createZhimadiRepairCoordinator({
    loadState: () => structuredClone(harness.state),
    persistState: (state) => {
      harness.state = structuredClone(state);
    },
    runAttempt: async (details) => {
      harness.attempts.push(structuredClone(details));
      return { outcome: "failed", reason: "rejected-code" };
    },
    escalate: async (details) => {
      harness.escalations.push(structuredClone(details));
      throw new Error("delivery result unknown");
    },
    now: () => harness.now,
    silentWindowMs: 3 * 60 * minute,
  });
  harness.now = baseNow + 3 * 60 * minute;

  await harness.coordinator.tick(requestAt(baseNow));
  assert.equal(harness.state.status, "escalation-failed");
  assert.equal(harness.state.escalationAttemptedAt, "2026-08-09T04:00:00.000Z");
  assert.equal(harness.escalations.length, 1);

  const restarted = createZhimadiRepairCoordinator({
    loadState: () => structuredClone(harness.state),
    persistState: (state) => {
      harness.state = structuredClone(state);
    },
    runAttempt: async () => {
      throw new Error("must not retry");
    },
    escalate: async () => {
      harness.escalations.push({ repeated: true });
    },
    now: () => harness.now,
  });
  await restarted.tick(requestAt(baseNow + 4 * 60 * minute));
  assert.equal(harness.escalations.length, 1);
});

test("exports a narrow health deferral selector for active and prompted incidents", () => {
  const active = {
    status: "auto-retrying",
    incidentId: "incident-1",
    incidentStartedAt: "2026-08-09T01:00:00.000Z",
    deadlineAt: "2026-08-09T04:00:00.000Z",
    promptSentAt: null,
  };
  assert.deepEqual(zhimadiRepairDeferral(active, {
    problemKey: "zhimadi-login",
    message: "芝麻地登录态失效",
  }), {
    incidentId: "incident-1",
    incidentStartedAt: active.incidentStartedAt,
    deadlineAt: active.deadlineAt,
    promptSentAt: null,
    phase: "auto-retrying",
  });
  assert.equal(zhimadiRepairDeferral(active, {
    problemKey: "zhimadi-login",
    message: "芝麻地和乐檬登录态失效",
  }), null);
  assert.equal(zhimadiRepairDeferral(active, {
    problemKey: "zhimadi-login",
    message: "芝麻地登录态失效；抖音报表加载失败",
  }), null);

  const prompted = {
    ...active,
    status: "manual-expired",
    escalationAttemptedAt: "2026-08-09T04:00:00.000Z",
  };
  assert.equal(
    zhimadiRepairDeferral(prompted, {
      problemKey: "zhimadi-login",
      message: "芝麻地登录态失效",
    }).phase,
    "prompted",
  );
  assert.equal(zhimadiRepairDeferral({ ...active, status: "auto-ok" }, {
    problemKey: "zhimadi-login",
    message: "芝麻地登录态失效",
  }), null);
});

test("manual completion updates the same incident without losing its escalation claim", () => {
  const initial = {
    schema: "zhimadi_login_repair.v2",
    status: "captcha-sent",
    incidentId: "incident-1",
    incidentStartedAt: "2026-08-09T01:00:00.000Z",
    deadlineAt: "2026-08-09T04:00:00.000Z",
    nextAttemptAt: null,
    promptSentAt: "2026-08-09T04:00:00.000Z",
    handledRequestAt: "2026-08-09T01:00:00.000Z",
  };
  const expired = markManualRepair(initial, {
    incidentId: "incident-1",
    outcome: "expired",
    now: baseNow + 4 * 60 * minute + 5 * minute,
  });
  assert.equal(expired.status, "manual-expired");
  assert.equal(expired.promptSentAt, initial.promptSentAt);

  const recovered = markManualRepair(expired, {
    incidentId: "incident-1",
    outcome: "ok",
    now: baseNow + 5 * 60 * minute,
  });
  assert.equal(recovered.status, "manual-ok");
  assert.equal(recovered.completedAt, "2026-08-09T06:00:00.000Z");

  assert.equal(markManualRepair(recovered, {
    incidentId: "another-incident",
    outcome: "failed",
    now: baseNow,
  }), recovered);
});

test("only a recent live requester owns report continuation", () => {
  const state = {
    requesterPid: 42,
    reportRequestedAt: new Date(baseNow).toISOString(),
    reportResumeMode: "scheduled",
    requesterResumeMode: "scheduled",
  };
  assert.equal(requesterCanResumeReport(state, {
    now: baseNow + minute,
    isProcessRunning: (pid) => pid === 42,
    graceMs: 4 * minute,
  }), true);
  assert.equal(requesterCanResumeReport(state, {
    now: baseNow + 5 * minute,
    isProcessRunning: () => true,
    graceMs: 4 * minute,
  }), false);
  assert.equal(requesterCanResumeReport(state, {
    now: baseNow + minute,
    isProcessRunning: () => false,
    graceMs: 4 * minute,
  }), false);
  assert.equal(requesterCanResumeReport({
    ...state,
    requesterResumeMode: "direct",
  }, {
    now: baseNow + minute,
    isProcessRunning: () => true,
    graceMs: 4 * minute,
  }), false);
});
