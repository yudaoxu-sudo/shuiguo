const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  canonicalReportDate,
  createReportResumeFlow,
  extractManualCaptchaCode,
  isDeferredMonthlyReportError,
  isLoginSessionReply,
  reportResumeClaimIsActive,
  retryableZhimadiRepairError,
  runMonthlyReport,
  selectReportRunner,
} = require("../scripts/listen-dingtalk.cjs");
const {
  persistRequesterReportResumeOutcome,
  shouldRequestReportAfterLogin,
} = require("../scripts/daily-report.cjs");

test("scheduled resume dates fail closed when missing or invalid", async () => {
  assert.equal(canonicalReportDate("2026-08-11"), "2026-08-11");
  assert.equal(canonicalReportDate("2026-02-30"), null);
  assert.equal(canonicalReportDate(null), null);

  const now = Date.parse("2026-08-11T01:06:00.000Z");
  let state = {
    incidentId: "legacy-incident",
    status: "auto-ok",
    afterLoginReport: true,
    reportResumeMode: "scheduled",
    reportDate: null,
  };
  let runs = 0;
  const resume = createReportResumeFlow({
    loadState: () => structuredClone(state),
    persistState: (next) => { state = structuredClone(next); },
    runReport: async () => { runs += 1; },
    sendAlert: async () => {},
    now: () => now,
    currentDate: () => "2026-08-11",
    isRunning: () => false,
  });

  await resume(state);

  assert.equal(runs, 0);
  assert.equal(state.afterLoginReport, false);
  assert.equal(state.reportResumeBlockedReason, "missing-or-invalid-target-date");
});

test("scheduled repairs resume through the de-duplicating scheduled entry", () => {
  const scheduled = () => "scheduled";
  const monthly = () => "monthly";
  assert.equal(selectReportRunner("scheduled", { scheduled, monthly })(), "scheduled");
  assert.equal(selectReportRunner("listener", { scheduled, monthly })(), "monthly");
  assert.equal(selectReportRunner(null, { scheduled, monthly })(), "monthly");

  let receivedDate;
  selectReportRunner("scheduled", {
    scheduled: (date) => { receivedDate = date; },
    monthly,
    reportDate: "2026-08-10",
  })();
  assert.equal(receivedDate, "2026-08-10");

  selectReportRunner("listener", {
    scheduled,
    monthly: (date) => { receivedDate = date; },
    reportDate: "2026-08-11",
  })();
  assert.equal(receivedDate, "2026-08-11");
});

test("listener monthly reports capture and pass one target date before spawning", () => {
  let currentDateCalls = 0;
  let spawned;
  const result = runMonthlyReport(undefined, {
    currentDate: () => {
      currentDateCalls += 1;
      return "2026-08-11";
    },
    env: { EXISTING: "kept" },
    runChild: (args, options) => {
      spawned = { args, options };
      return "spawned";
    },
  });

  assert.equal(result, "spawned");
  assert.equal(currentDateCalls, 1);
  assert.deepEqual(spawned.args, ["scripts/daily-report.cjs"]);
  assert.equal(spawned.options.env.EXISTING, "kept");
  assert.equal(spawned.options.env.REPORT_MANAGED_BY_LISTENER, "1");
  assert.equal(spawned.options.env.REPORT_TARGET_DATE, "2026-08-11");

  currentDateCalls = 0;
  runMonthlyReport("2026-08-10", {
    currentDate: () => {
      currentDateCalls += 1;
      return "2026-08-11";
    },
    runChild: (args, options) => {
      spawned = { args, options };
    },
  });
  assert.equal(currentDateCalls, 0);
  assert.equal(spawned.options.env.REPORT_TARGET_DATE, "2026-08-10");
});

test("listener report-resume claims can be reclaimed after owner loss or lease expiry", () => {
  const now = Date.parse("2026-08-11T08:00:00.000Z");
  const liveClaim = {
    reportResumeClaimedAt: "2026-08-11T07:55:00.000Z",
    reportResumeOwner: "listener",
    reportResumeOwnerPid: 42,
    reportResumeLeaseUntil: "2026-08-11T08:15:00.000Z",
  };
  assert.equal(reportResumeClaimIsActive(liveClaim, {
    now,
    isRunning: (pid) => pid === 42,
  }), true);
  assert.equal(reportResumeClaimIsActive(liveClaim, {
    now,
    isRunning: () => false,
  }), false);
  assert.equal(reportResumeClaimIsActive({
    ...liveClaim,
    reportResumeLeaseUntil: "2026-08-11T07:59:59.000Z",
  }, {
    now,
    isRunning: () => true,
  }), false);
  assert.equal(reportResumeClaimIsActive({
    reportResumeClaimedAt: "2026-08-11T07:55:00.000Z",
    reportResumeOwner: "requester",
    reportResumeOwnerPid: 42,
    reportResumeLeaseUntil: "2026-08-11T08:15:00.000Z",
  }, { now, isRunning: (pid) => pid === 42 }), true);
});

test("a direct requester records success or releases a failed resume for the listener", () => {
  const now = Date.parse("2026-08-11T08:00:00.000Z");
  const repair = {
    incidentId: "incident-1",
    reportRequestedAt: "2026-08-11T07:55:00.000Z",
  };
  let state = {
    ...repair,
    afterLoginReport: true,
    requesterPid: 42,
    reportResumeClaimId: "claim-1",
    reportResumeClaimedAt: "2026-08-11T07:59:00.000Z",
    reportResumeOwner: "requester",
    reportResumeOwnerPid: 42,
  };
  persistRequesterReportResumeOutcome(repair, "failed", new Error("transient"), {
    loadState: () => structuredClone(state),
    persistState: (next) => { state = structuredClone(next); },
    now: () => now,
    requesterPid: 42,
  });
  assert.equal(state.reportResumeClaimedAt, undefined);
  assert.equal(state.requesterPid, null);
  assert.equal(state.afterLoginReport, true);
  assert.equal(state.reportResumeNextAttemptAt, "2026-08-11T08:15:00.000Z");

  state = {
    ...state,
    requesterPid: 42,
    reportResumeClaimId: "claim-2",
    reportResumeClaimedAt: "2026-08-11T08:15:00.000Z",
  };
  persistRequesterReportResumeOutcome(repair, "success", null, {
    loadState: () => structuredClone(state),
    persistState: (next) => { state = structuredClone(next); },
    now: () => now + 20 * 60 * 1000,
    requesterPid: 42,
  });
  assert.equal(state.afterLoginReport, false);
  assert.equal(state.reportResumeCompletedAt, "2026-08-11T08:20:00.000Z");
  assert.equal(state.reportResumeClaimedAt, undefined);
});

test("a listener-owned report resume releases a failed claim and completes on retry", async () => {
  let now = Date.parse("2026-08-11T08:00:00.000Z");
  let state = {
    incidentId: "incident-1",
    status: "auto-ok",
    afterLoginReport: true,
    reportResumeMode: "listener",
    reportDate: "2026-08-11",
    requesterPid: null,
  };
  let runs = 0;
  const resume = createReportResumeFlow({
    loadState: () => structuredClone(state),
    persistState: (next) => { state = structuredClone(next); },
    runReport: async () => {
      runs += 1;
      if (runs === 1) throw new Error("transient report failure");
    },
    sendAlert: async () => {},
    now: () => now,
    isRunning: () => false,
    processId: 99,
  });

  await assert.rejects(resume(state), /transient report failure/);
  assert.equal(runs, 1);
  assert.equal(state.reportResumeClaimedAt, undefined);
  assert.equal(state.reportResumeNextAttemptAt, "2026-08-11T08:15:00.000Z");
  assert.equal(state.afterLoginReport, true);

  now += 14 * 60 * 1000;
  await resume(state);
  assert.equal(runs, 1);

  now += 60 * 1000;
  await resume(state);
  assert.equal(runs, 2);
  assert.equal(state.afterLoginReport, false);
  assert.equal(state.reportResumeCompletedAt, "2026-08-11T08:15:00.000Z");
  assert.equal(state.reportResumeClaimedAt, undefined);
});

test("a scheduled repair crossing midnight fails closed after the incident deadline", async () => {
  let now = Date.parse("2026-08-11T00:30:00.000Z");
  let state = {
    incidentId: "incident-1",
    status: "auto-ok",
    incidentStartedAt: "2026-08-10T22:05:00.000Z",
    deadlineAt: "2026-08-11T01:05:00.000Z",
    afterLoginReport: true,
    reportResumeMode: "scheduled",
    reportDate: "2026-08-10",
    requesterPid: null,
  };
  let runs = 0;
  let alerts = 0;
  const resume = createReportResumeFlow({
    loadState: () => structuredClone(state),
    persistState: (next) => { state = structuredClone(next); },
    runReport: async () => { runs += 1; },
    sendAlert: async () => { alerts += 1; },
    now: () => now,
    currentDate: () => "2026-08-11",
    isRunning: () => false,
  });

  await resume(state);
  assert.equal(runs, 0);
  assert.equal(alerts, 0);
  assert.equal(state.afterLoginReport, true);

  now = Date.parse("2026-08-11T01:05:00.000Z");
  await resume(state);
  assert.equal(runs, 0);
  assert.equal(alerts, 1);
  assert.equal(state.afterLoginReport, false);
  assert.equal(state.reportResumeBlockedReason, "date-rollover-unverified-sources");

  await resume(state);
  assert.equal(alerts, 1);
});

test("a blocked old scheduled resume promotes the same-day listener intent once", async () => {
  const now = Date.parse("2026-08-11T01:06:00.000Z");
  let state = {
    incidentId: "incident-1",
    status: "auto-ok",
    incidentStartedAt: "2026-08-10T22:05:00.000Z",
    deadlineAt: "2026-08-11T01:05:00.000Z",
    afterLoginReport: true,
    reportResumeMode: "scheduled",
    reportDate: "2026-08-10",
    reportRequestedAt: "2026-08-10T22:05:00.000Z",
    requesterPid: null,
    latestListenerResumeIntent: {
      requestedAt: "2026-08-11T00:30:00.000+00:00",
      reportResumeMode: "listener",
      reportDate: "2026-08-11",
      requesterPid: null,
    },
  };
  const runs = [];
  let alerts = 0;
  const resume = createReportResumeFlow({
    loadState: () => structuredClone(state),
    persistState: (next) => { state = structuredClone(next); },
    runReport: async (claimed) => {
      runs.push({
        mode: claimed.reportResumeMode,
        date: claimed.reportDate,
      });
    },
    sendAlert: async () => { alerts += 1; },
    now: () => now,
    currentDate: () => "2026-08-11",
    isRunning: () => false,
    processId: 99,
  });

  await resume(state);
  await resume(state);

  assert.deepEqual(runs, [{ mode: "listener", date: "2026-08-11" }]);
  assert.equal(alerts, 1);
  assert.equal(state.afterLoginReport, false);
  assert.equal(state.reportResumeCompletedAt, "2026-08-11T01:06:00.000Z");
  assert.equal(state.blockedScheduledResumeIntent.reportDate, "2026-08-10");
  assert.equal(state.latestListenerResumeIntent, undefined);
});

test("a listener intent that is also stale is traced and never runs on day three", async () => {
  const now = Date.parse("2026-08-12T01:06:00.000Z");
  let state = {
    incidentId: "incident-1",
    status: "auto-ok",
    incidentStartedAt: "2026-08-10T22:05:00.000Z",
    deadlineAt: "2026-08-11T01:05:00.000Z",
    afterLoginReport: true,
    reportResumeMode: "scheduled",
    reportDate: "2026-08-10",
    reportRequestedAt: "2026-08-10T22:05:00.000Z",
    requesterPid: null,
    latestListenerResumeIntent: {
      requestedAt: "2026-08-11T00:30:00.000Z",
      reportResumeMode: "listener",
      reportDate: "2026-08-11",
      requesterPid: null,
    },
  };
  let runs = 0;
  const resume = createReportResumeFlow({
    loadState: () => structuredClone(state),
    persistState: (next) => { state = structuredClone(next); },
    runReport: async () => { runs += 1; },
    sendAlert: async () => {},
    now: () => now,
    currentDate: () => "2026-08-12",
    isRunning: () => false,
  });

  await resume(state);

  assert.equal(runs, 0);
  assert.equal(state.afterLoginReport, false);
  assert.equal(state.blockedListenerResumeIntent.reportDate, "2026-08-11");
  assert.equal(state.blockedListenerResumeIntent.reason, "date-rollover-unverified-sources");
});

test("a promoted listener resume cannot retry after its target date rolls over", async () => {
  const now = Date.parse("2026-08-12T00:01:00.000Z");
  let state = {
    incidentId: "incident-1",
    status: "auto-ok",
    afterLoginReport: true,
    reportResumeMode: "listener",
    reportDate: "2026-08-11",
    reportRequestedAt: "2026-08-11T00:30:00.000Z",
    reportResumeNextAttemptAt: "2026-08-11T23:45:00.000Z",
  };
  let runs = 0;
  const resume = createReportResumeFlow({
    loadState: () => structuredClone(state),
    persistState: (next) => { state = structuredClone(next); },
    runReport: async () => { runs += 1; },
    sendAlert: async () => {},
    now: () => now,
    currentDate: () => "2026-08-12",
    isRunning: () => false,
  });

  await resume(state);

  assert.equal(runs, 0);
  assert.equal(state.afterLoginReport, false);
  assert.equal(state.blockedListenerResumeIntent.reportDate, "2026-08-11");
});

test("temporary OCR service failures stay inside the silent repair loop", () => {
  assert.equal(retryableZhimadiRepairError(new Error("fetch failed")), true);
  assert.equal(retryableZhimadiRepairError(new Error("验证码视觉识别失败: 429 rate limit")), true);
  assert.equal(retryableZhimadiRepairError(new Error("验证码视觉识别失败: 503 service unavailable")), true);
  const fatal = new Error("缺少芝麻地自动登录账号配置");
  fatal.repairFatal = true;
  assert.equal(retryableZhimadiRepairError(fatal), false);
});

test("listener-managed reports defer login repair without opening an immediate captcha", () => {
  assert.equal(isDeferredMonthlyReportError({ exitCode: 2 }), true);
  assert.equal(isDeferredMonthlyReportError({ exitCode: 1 }), false);

  const listenerSource = fs.readFileSync(
    path.resolve(__dirname, "../scripts/listen-dingtalk.cjs"),
    "utf8",
  );
  const reportCatch = listenerSource.slice(
    listenerSource.indexOf("runMonthlyReport()\n      .catch"),
    listenerSource.indexOf("      .finally", listenerSource.indexOf("runMonthlyReport()\n      .catch")),
  );
  assert.match(reportCatch, /isDeferredMonthlyReportError/);
  assert.doesNotMatch(reportCatch, /startZhimadiCaptchaFlow/);
  assert.match(
    listenerSource,
    /reportResumeMode:\s*repairState\?\.reportResumeMode,\s*reportDate:\s*repairState\?\.reportDate,/,
  );

  const dailySource = fs.readFileSync(
    path.resolve(__dirname, "../scripts/daily-report.cjs"),
    "utf8",
  );
  assert.match(
    dailySource,
    /deferToListener:\s*listenerManaged\s*\|\|\s*scheduledManaged/,
  );
  assert.match(dailySource, /requesterPid:\s*deferToListener\s*\?\s*null\s*:\s*process\.pid/);

  assert.equal(shouldRequestReportAfterLogin({ NO_DINGTALK: "1" }), false);
  assert.equal(shouldRequestReportAfterLogin({
    NO_DINGTALK: "1",
    REPORT_FORMAL_WRAPPER: "1",
  }), true);
  assert.equal(shouldRequestReportAfterLogin({}), true);

  const dualSource = fs.readFileSync(
    path.resolve(__dirname, "../scripts/send-dual-douyin-report.cjs"),
    "utf8",
  );
  assert.match(dualSource, /REPORT_FORMAL_WRAPPER:\s*formalWrapper\s*\?\s*"1"\s*:\s*"0"/);
  assert.match(dualSource, /error\.exitCode\s*=\s*code/);
  assert.match(dualSource, /process\.exit\(error\?\.exitCode\s*===\s*2\s*\?\s*2\s*:\s*1\)/);
});

test("manual captcha replies require a label and the bound sender context", () => {
  assert.equal(extractManualCaptchaCode("验证码Ab12"), "Ab12");
  assert.equal(extractManualCaptchaCode("Ab12"), "");
  assert.equal(extractManualCaptchaCode("6666"), "");
  assert.equal(extractManualCaptchaCode("验证码123456789"), "");
  assert.equal(extractManualCaptchaCode("登录18705822906"), "");

  const session = {
    conversationId: "conversation-1",
    senderStaffId: "user-1",
  };
  assert.equal(isLoginSessionReply(session, {
    conversationId: "conversation-1",
    senderStaffId: "user-1",
  }), true);
  assert.equal(isLoginSessionReply(session, {
    conversationId: "conversation-2",
    senderStaffId: "user-1",
  }), false);
  assert.equal(isLoginSessionReply(session, {
    conversationId: "conversation-1",
    senderStaffId: "user-2",
  }), false);
  assert.equal(isLoginSessionReply({
    conversationId: null,
    senderStaffId: null,
  }, {
    conversationId: "conversation-1",
    senderStaffId: "user-1",
  }), false);
});
