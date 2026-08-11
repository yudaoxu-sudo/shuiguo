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
  assert.equal(resumed.attempts.length, 2);
  assert.equal(resumed.escalations.length, 1);
  assert.equal(resumed.state.status, "auto-retrying");
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
    reportDate: "2026-08-09",
    requesterPid: 42,
  });
  const result = await harness.coordinator.tick(joinedRequest);

  assert.equal(result.outcome, "inactive");
  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.state.handledRequestAt, joinedRequest.requestedAt);
  assert.equal(harness.state.afterLoginReport, true);
  assert.equal(harness.state.reportResumeMode, "scheduled");
  assert.equal(harness.state.reportDate, "2026-08-09");
  assert.equal(harness.state.requesterPid, 42);
});

test("an active old scheduled incident retains a newer listener resume intent", async () => {
  const harness = createHarness([{ outcome: "success" }]);
  harness.now = Date.parse("2026-08-11T00:30:00.000Z");
  harness.state = {
    schema: "zhimadi_login_repair.v2",
    status: "auto-retrying",
    incidentId: "2026-08-10T22:05:00.000Z",
    incidentStartedAt: "2026-08-10T22:05:00.000Z",
    deadlineAt: "2026-08-11T01:05:00.000Z",
    nextAttemptAt: "2026-08-11T01:05:00.000Z",
    handledRequestAt: "2026-08-10T22:05:00.000Z",
    latestRequestAt: "2026-08-10T22:05:00.000Z",
    afterLoginReport: true,
    reportResumeMode: "scheduled",
    reportDate: "2026-08-10",
    reportRequestedAt: "2026-08-10T22:05:00.000Z",
    requesterPid: null,
    requesterResumeMode: "scheduled",
    attemptCount: 4,
    updatedAt: "2026-08-10T23:35:00.000Z",
  };
  const listenerRequest = requestAt(harness.now, {
    afterLoginReport: true,
    reportResumeMode: "listener",
    reportDate: "2026-08-11",
    requesterPid: null,
  });

  const result = await harness.coordinator.tick(listenerRequest);

  assert.equal(result.outcome, "waiting");
  assert.equal(harness.state.reportResumeMode, "scheduled");
  assert.equal(harness.state.reportDate, "2026-08-10");
  assert.deepEqual(harness.state.latestListenerResumeIntent, {
    requestedAt: listenerRequest.requestedAt,
    reportResumeMode: "listener",
    reportDate: "2026-08-11",
    requesterPid: null,
  });
});

test("a newer scheduled intent replaces the active old date and preserves one trace", async () => {
  const harness = createHarness([{ outcome: "success" }]);
  harness.now = Date.parse("2026-08-11T02:00:00.000Z");
  harness.state = {
    schema: "zhimadi_login_repair.v2",
    status: "auto-retrying",
    incidentId: "2026-08-10T01:00:00.000Z",
    incidentStartedAt: "2026-08-10T01:00:00.000Z",
    deadlineAt: "2026-08-10T04:00:00.000Z",
    nextAttemptAt: "2026-08-11T02:30:00.000Z",
    handledRequestAt: "2026-08-10T01:00:00.000Z",
    latestRequestAt: "2026-08-10T01:00:00.000Z",
    afterLoginReport: true,
    reportResumeMode: "scheduled",
    reportDate: "2026-08-10",
    reportRequestedAt: "2026-08-10T01:00:00.000Z",
    requesterPid: null,
    requesterResumeMode: "scheduled",
    attemptCount: 8,
    updatedAt: "2026-08-11T01:30:00.000Z",
  };
  const nextScheduled = requestAt(harness.now, {
    afterLoginReport: true,
    reportResumeMode: "scheduled",
    reportDate: "2026-08-11",
    requesterPid: null,
  });

  const result = await harness.coordinator.tick(nextScheduled);

  assert.equal(result.outcome, "success");
  assert.equal(harness.state.reportDate, "2026-08-11");
  assert.equal(harness.state.reportRequestedAt, nextScheduled.requestedAt);
  assert.deepEqual(harness.state.supersededScheduledResumeIntent, {
    requestedAt: "2026-08-10T01:00:00.000Z",
    reportResumeMode: "scheduled",
    reportDate: "2026-08-10",
  });
});

test("same-day scheduled retries preserve the earlier cross-day trace", async () => {
  const harness = createHarness([{ outcome: "success" }]);
  harness.now = Date.parse("2026-08-11T22:35:00.000Z");
  harness.state = {
    schema: "zhimadi_login_repair.v2",
    status: "auto-retrying",
    incidentId: "2026-08-10T01:00:00.000Z",
    incidentStartedAt: "2026-08-10T01:00:00.000Z",
    deadlineAt: "2026-08-11T23:00:00.000Z",
    nextAttemptAt: "2026-08-11T23:00:00.000Z",
    handledRequestAt: "2026-08-11T22:20:00.000Z",
    latestRequestAt: "2026-08-11T22:20:00.000Z",
    afterLoginReport: true,
    reportResumeMode: "scheduled",
    reportDate: "2026-08-11",
    reportRequestedAt: "2026-08-11T22:20:00.000Z",
    requesterPid: null,
    requesterResumeMode: "scheduled",
    attemptCount: 8,
    supersededScheduledResumeIntent: {
      requestedAt: "2026-08-10T01:00:00.000Z",
      reportResumeMode: "scheduled",
      reportDate: "2026-08-10",
    },
    updatedAt: "2026-08-11T22:20:00.000Z",
  };
  const retry = requestAt(harness.now, {
    afterLoginReport: true,
    reportResumeMode: "scheduled",
    reportDate: "2026-08-11",
    requesterPid: null,
  });

  const result = await harness.coordinator.tick(retry);

  assert.equal(result.outcome, "success");
  assert.equal(harness.state.reportRequestedAt, retry.requestedAt);
  assert.deepEqual(harness.state.supersededScheduledResumeIntent, {
    requestedAt: "2026-08-10T01:00:00.000Z",
    reportResumeMode: "scheduled",
    reportDate: "2026-08-10",
  });
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
  assert.equal(harness.state.status, "auto-retrying");
  assert.equal(harness.state.escalationAttemptedAt, "2026-08-09T04:00:00.000Z");
  assert.equal(harness.state.nextAttemptAt, "2026-08-09T04:30:00.000Z");
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

test("a definitely unavailable prompt can retry after context becomes available", async () => {
  const harness = createHarness([{ outcome: "failed", reason: "rejected-code" }]);
  let prompts = 0;
  harness.coordinator = createZhimadiRepairCoordinator({
    loadState: () => structuredClone(harness.state),
    persistState: (state) => {
      harness.state = structuredClone(state);
    },
    runAttempt: async (details) => {
      harness.attempts.push(details);
      return { outcome: "failed", reason: "rejected-code" };
    },
    escalate: async () => {
      prompts += 1;
      return prompts === 1
        ? { outcome: "unavailable", error: "missing-bound-context" }
        : { outcome: "captcha-sent" };
    },
    now: () => harness.now,
  });
  harness.now = baseNow + 3 * 60 * minute;

  const unavailable = await harness.coordinator.tick(requestAt(baseNow));
  assert.equal(unavailable.outcome, "prompt-unavailable");
  assert.equal(harness.state.escalationAttemptedAt, undefined);
  assert.equal(harness.state.nextAttemptAt, "2026-08-09T04:30:00.000Z");

  harness.now += 30 * minute;
  const prompted = await harness.coordinator.tick(requestAt(baseNow));
  assert.equal(prompted.outcome, "captcha-sent");
  assert.equal(prompts, 2);
});

test("an orphaned escalating claim resumes silently on its anchored retry time", async () => {
  const harness = createHarness([{ outcome: "failed", reason: "rejected-code" }]);
  harness.state = {
    schema: "zhimadi_login_repair.v2",
    status: "escalating",
    incidentId: "2026-08-09T01:00:00.000Z",
    incidentStartedAt: "2026-08-09T01:00:00.000Z",
    deadlineAt: "2026-08-09T04:00:00.000Z",
    nextAttemptAt: null,
    handledRequestAt: "2026-08-09T01:00:00.000Z",
    latestRequestAt: "2026-08-09T01:00:00.000Z",
    attemptCount: 4,
    escalationAttemptedAt: "2026-08-09T04:00:00.000Z",
    updatedAt: "2026-08-09T04:00:00.000Z",
  };
  harness.now = Date.parse("2026-08-09T04:15:00.000Z");

  const waiting = await harness.coordinator.tick(requestAt(baseNow));
  assert.equal(waiting.outcome, "waiting");
  assert.equal(harness.state.status, "auto-retrying");
  assert.equal(harness.state.nextAttemptAt, "2026-08-09T04:30:00.000Z");
  assert.equal(harness.state.escalationAttemptedAt, "2026-08-09T04:00:00.000Z");
  assert.equal(harness.escalations.length, 0);

  harness.now = Date.parse("2026-08-09T04:30:00.000Z");
  const retried = await harness.coordinator.tick(requestAt(baseNow));
  assert.equal(retried.outcome, "post-prompt-retrying");
  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.escalations.length, 0);
  assert.equal(harness.state.escalationAttemptedAt, "2026-08-09T04:00:00.000Z");
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
  assert.equal(expired.status, "auto-retrying");
  assert.equal(expired.nextAttemptAt, "2026-08-09T05:35:00.000Z");
  assert.equal(expired.lastManualOutcome, "expired");
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

test("a prompt timeout keeps repairing silently without a second escalation", async () => {
  const harness = createHarness([{ outcome: "failed", reason: "rejected-code" }]);
  harness.now = baseNow + 3 * 60 * minute;
  await harness.coordinator.tick(requestAt(baseNow));
  assert.equal(harness.state.status, "captcha-sent");
  assert.equal(harness.escalations.length, 1);

  harness.state = markManualRepair(harness.state, {
    incidentId: harness.state.incidentId,
    outcome: "expired",
    now: harness.now + 5 * minute,
  });
  harness.now += 35 * minute;

  const restarted = createZhimadiRepairCoordinator({
    loadState: () => structuredClone(harness.state),
    persistState: (state) => {
      harness.state = structuredClone(state);
    },
    runAttempt: async () => {
      harness.attempts.push({ restarted: true });
      return { outcome: "failed", reason: "rejected-code" };
    },
    escalate: async () => {
      harness.escalations.push({ repeated: true });
      return { outcome: "captcha-sent" };
    },
    now: () => harness.now,
  });

  const result = await restarted.tick(requestAt(baseNow + 4 * 60 * minute));
  assert.equal(result.outcome, "post-prompt-retrying");
  assert.equal(harness.state.status, "auto-retrying");
  assert.equal(harness.escalations.length, 1);
  assert.equal(harness.state.promptSentAt, "2026-08-09T04:00:00.000Z");
});

test("listener restart expires an orphaned captcha session into silent retry", async () => {
  const harness = createHarness([{ outcome: "failed", reason: "rejected-code" }]);
  harness.now = baseNow + 3 * 60 * minute;
  await harness.coordinator.tick(requestAt(baseNow));
  assert.equal(harness.state.status, "captcha-sent");
  assert.equal(harness.escalations.length, 1);

  harness.now += 6 * minute;
  const restarted = createZhimadiRepairCoordinator({
    loadState: () => structuredClone(harness.state),
    persistState: (state) => {
      harness.state = structuredClone(state);
    },
    runAttempt: async () => {
      harness.attempts.push({ restarted: true });
      return { outcome: "failed", reason: "rejected-code" };
    },
    escalate: async () => {
      harness.escalations.push({ repeated: true });
      return { outcome: "captcha-sent" };
    },
    now: () => harness.now,
  });

  const waiting = await restarted.tick(requestAt(harness.now));
  assert.equal(waiting.outcome, "waiting");
  assert.equal(harness.state.status, "auto-retrying");
  assert.equal(harness.state.nextAttemptAt, "2026-08-09T04:35:00.000Z");
  assert.equal(harness.state.lastManualOutcome, "expired");
  assert.equal(harness.escalations.length, 1);

  harness.now = Date.parse("2026-08-09T04:35:00.000Z");
  const retried = await restarted.tick(requestAt(harness.now));
  assert.equal(retried.outcome, "post-prompt-retrying");
  assert.equal(harness.escalations.length, 1);
});

test("an overdue orphaned captcha session retries on the restart tick", async () => {
  const harness = createHarness([{ outcome: "failed", reason: "rejected-code" }]);
  harness.now = baseNow + 3 * 60 * minute;
  await harness.coordinator.tick(requestAt(baseNow));
  assert.equal(harness.state.promptSentAt, "2026-08-09T04:00:00.000Z");

  harness.now = Date.parse("2026-08-09T04:36:00.000Z");
  const restarted = createZhimadiRepairCoordinator({
    loadState: () => structuredClone(harness.state),
    persistState: (state) => {
      harness.state = structuredClone(state);
    },
    runAttempt: async () => {
      harness.attempts.push({ restarted: true });
      return { outcome: "failed", reason: "rejected-code" };
    },
    escalate: async () => {
      harness.escalations.push({ repeated: true });
      return { outcome: "captcha-sent" };
    },
    now: () => harness.now,
  });

  const retried = await restarted.tick(requestAt(baseNow));
  assert.equal(retried.outcome, "post-prompt-retrying");
  assert.equal(harness.attempts.length, 2);
  assert.equal(harness.escalations.length, 1);
  assert.equal(harness.state.lastManualOutcome, "expired");
});

test("normalizes a corrupt persisted deadline from the original incident start", async () => {
  const harness = createHarness([{ outcome: "failed", reason: "rejected-code" }]);
  harness.state = {
    schema: "zhimadi_login_repair.v2",
    status: "auto-retrying",
    incidentId: "2026-08-09T01:00:00.000Z",
    incidentStartedAt: "2026-08-09T01:00:00.000Z",
    deadlineAt: "corrupt",
    nextAttemptAt: "2026-08-09T01:00:00.000Z",
    handledRequestAt: "2026-08-09T01:00:00.000Z",
    latestRequestAt: "2026-08-09T01:00:00.000Z",
    attemptCount: 3,
    updatedAt: "2026-08-09T01:30:00.000Z",
  };
  harness.now = Date.parse("2026-08-09T05:00:00.000Z");

  const result = await harness.coordinator.tick(requestAt(baseNow));
  assert.equal(result.outcome, "captcha-sent");
  assert.equal(harness.state.deadlineAt, "2026-08-09T04:00:00.000Z");
  assert.equal(harness.attempts[0].finalAttempt, true);
  assert.equal(harness.escalations.length, 1);
});

test("a far-future retry timestamp cannot defer an expired incident", async () => {
  const harness = createHarness([{ outcome: "failed", reason: "rejected-code" }]);
  harness.state = {
    schema: "zhimadi_login_repair.v2",
    status: "auto-retrying",
    incidentId: "2026-08-09T01:00:00.000Z",
    incidentStartedAt: "2026-08-09T01:00:00.000Z",
    deadlineAt: "2026-08-09T04:00:00.000Z",
    nextAttemptAt: "2099-01-01T00:00:00.000Z",
    handledRequestAt: "2026-08-09T01:00:00.000Z",
    latestRequestAt: "2026-08-09T01:00:00.000Z",
    attemptCount: 3,
    updatedAt: "2026-08-09T01:30:00.000Z",
  };
  harness.now = Date.parse("2026-08-09T07:00:00.000Z");

  const result = await harness.coordinator.tick(requestAt(baseNow));
  assert.equal(result.outcome, "captcha-sent");
  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.attempts[0].finalAttempt, true);
});

test("future incident timestamps fall back to the valid request time", async () => {
  const harness = createHarness([{ outcome: "failed", reason: "rejected-code" }]);
  harness.state = {
    schema: "zhimadi_login_repair.v2",
    status: "auto-retrying",
    incidentId: "2099-01-01T00:00:00.000Z",
    incidentStartedAt: "2099-01-01T00:00:00.000Z",
    deadlineAt: "2099-01-01T03:00:00.000Z",
    nextAttemptAt: "2026-08-09T07:00:00.000Z",
    handledRequestAt: "2026-08-09T01:00:00.000Z",
    latestRequestAt: "2026-08-09T01:00:00.000Z",
    attemptCount: 3,
    updatedAt: "2026-08-09T01:30:00.000Z",
  };
  harness.now = Date.parse("2026-08-09T07:00:00.000Z");

  const result = await harness.coordinator.tick(requestAt(baseNow));
  assert.equal(result.outcome, "captcha-sent");
  assert.equal(harness.state.incidentStartedAt, "2026-08-09T01:00:00.000Z");
  assert.equal(harness.state.deadlineAt, "2026-08-09T04:00:00.000Z");
  assert.equal(harness.attempts[0].finalAttempt, true);
});

test("retries a lock-stall alert only after cooldown and stops after delivery", async () => {
  const harness = createHarness([{ outcome: "lock-busy" }]);
  harness.now = Date.parse("2026-08-09T04:29:00.000Z");

  const beforeThreshold = await harness.coordinator.tick(requestAt(baseNow));
  assert.equal(beforeThreshold.outcome, "lock-busy");
  assert.equal(harness.state.lockBusySince, "2026-08-09T04:29:00.000Z");
  assert.equal(harness.state.lockBusyAlertAttemptedAt, undefined);

  harness.now = Date.parse("2026-08-09T04:30:00.000Z");
  const claimed = await harness.coordinator.tick(requestAt(baseNow));
  assert.equal(claimed.outcome, "lock-stalled");
  assert.equal(harness.state.lockBusyAlertAttemptedAt, "2026-08-09T04:30:00.000Z");

  harness.now = Date.parse("2026-08-09T04:31:00.000Z");
  const afterClaim = await harness.coordinator.tick(requestAt(baseNow));
  assert.equal(afterClaim.outcome, "lock-busy");
  assert.equal(harness.state.lockBusyAlertAttemptedAt, "2026-08-09T04:30:00.000Z");
  assert.equal(harness.state.attemptCount, 0);
  assert.equal(harness.escalations.length, 0);

  harness.now = Date.parse("2026-08-09T10:30:00.000Z");
  const retriedAlert = await harness.coordinator.tick(requestAt(baseNow));
  assert.equal(retriedAlert.outcome, "lock-stalled");
  assert.equal(harness.state.lockBusyAlertAttemptedAt, "2026-08-09T10:30:00.000Z");

  harness.state.lockBusyAlertSentAt = "2026-08-09T10:30:01.000Z";
  harness.now = Date.parse("2026-08-09T16:30:00.000Z");
  const delivered = await harness.coordinator.tick(requestAt(baseNow));
  assert.equal(delivered.outcome, "lock-busy");
  assert.equal(harness.state.lockBusyAlertAttemptedAt, "2026-08-09T10:30:00.000Z");
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
