const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  mergeRepairRequests,
  persistMergedRepairRequest,
} = require("../scripts/zhimadi-repair-request.cjs");

const baseNow = Date.parse("2026-08-11T06:00:00.000Z");

function reportRequest(overrides = {}) {
  return {
    requestedAt: new Date(baseNow).toISOString(),
    reason: "report-login-expired",
    afterLoginReport: true,
    reportResumeMode: "listener",
    requesterPid: 42,
    requesterMessageId: "report-message",
    failureAlertOwner: "report-healthcheck",
    ...overrides,
  };
}

function healthRequest(overrides = {}) {
  return {
    requestedAt: new Date(baseNow + 1000).toISOString(),
    reason: "login-healthcheck",
    failureAlertOwner: "login-healthcheck",
    ...overrides,
  };
}

test("a fresh unhandled report request survives a later health request", () => {
  const current = reportRequest({
    reportResumeMode: "scheduled",
    requesterPid: 88,
  });
  const merged = mergeRepairRequests(current, healthRequest(), {
    state: { handledRequestAt: "an-older-request" },
    now: baseNow + 1000,
  });

  assert.deepEqual(merged, current);
});

test("a report request still survives health checks after a thirty-minute listener outage", () => {
  const current = reportRequest({
    reportResumeMode: "listener",
    requesterPid: null,
  });
  const incoming = healthRequest({
    requestedAt: new Date(baseNow + 30 * 60 * 1000).toISOString(),
  });
  const merged = mergeRepairRequests(current, incoming, {
    state: null,
    now: baseNow + 30 * 60 * 1000,
  });

  assert.equal(merged.requestedAt, current.requestedAt);
  assert.equal(merged.afterLoginReport, true);
  assert.equal(merged.reportResumeMode, "listener");
  assert.equal(merged.requesterPid, null);
});

test("a missing report resume mode is treated as direct without losing report intent", () => {
  const current = reportRequest({
    reportResumeMode: null,
    requesterPid: 55,
  });
  const merged = mergeRepairRequests(current, healthRequest(), {
    now: baseNow + 1000,
  });

  assert.equal(merged.afterLoginReport, true);
  assert.equal(merged.reportResumeMode, "direct");
  assert.equal(merged.requesterPid, 55);
});

test("listener report intent takes priority over direct report intent", () => {
  const direct = reportRequest({
    requestedAt: new Date(baseNow + 2000).toISOString(),
    reportResumeMode: "direct",
    requesterPid: 66,
  });
  const listener = reportRequest({
    reportResumeMode: "listener",
    requesterPid: null,
  });
  const merged = mergeRepairRequests(direct, listener, {
    now: baseNow + 2000,
  });

  assert.equal(merged.requestedAt, listener.requestedAt);
  assert.equal(merged.reportResumeMode, "listener");
  assert.equal(merged.requesterPid, null);
});

test("scheduled report intent wins and keeps its own requester fields", () => {
  const listener = reportRequest({
    requestedAt: new Date(baseNow + 2000).toISOString(),
    reportResumeMode: "listener",
    requesterPid: 22,
    requesterMessageId: "listener-message",
  });
  const scheduled = reportRequest({
    reportResumeMode: "scheduled",
    requesterPid: 11,
    requesterMessageId: "scheduled-message",
  });
  const merged = mergeRepairRequests(listener, scheduled, {
    now: baseNow + 2000,
  });

  assert.equal(merged.afterLoginReport, true);
  assert.equal(merged.reportResumeMode, "scheduled");
  assert.equal(merged.requesterPid, 11);
  assert.equal(merged.requesterMessageId, "scheduled-message");
  assert.equal(merged.requestedAt, scheduled.requestedAt);
});

test("an overlapping scheduled repair retains the latest listener intent separately", () => {
  const scheduled = reportRequest({
    requestedAt: "2026-08-10T14:05:00.000Z",
    reportResumeMode: "scheduled",
    reportDate: "2026-08-10",
    requesterPid: null,
  });
  const listener = reportRequest({
    requestedAt: "2026-08-10T16:30:00.000Z",
    reportResumeMode: "listener",
    reportDate: "2026-08-11",
    requesterPid: null,
  });
  const merged = mergeRepairRequests(scheduled, listener, {
    state: { handledRequestAt: "an-older-request" },
    now: Date.parse("2026-08-10T16:30:00.000Z"),
  });

  assert.equal(merged.reportResumeMode, "scheduled");
  assert.equal(merged.reportDate, "2026-08-10");
  assert.deepEqual(merged.latestListenerResumeIntent, {
    requestedAt: listener.requestedAt,
    reportResumeMode: "listener",
    reportDate: "2026-08-11",
    requesterPid: null,
  });

  const afterHealth = mergeRepairRequests(merged, healthRequest({
    requestedAt: "2026-08-10T16:31:00.000Z",
  }), {
    state: { handledRequestAt: scheduled.requestedAt },
    now: Date.parse("2026-08-10T16:31:00.000Z"),
  });
  assert.equal(afterHealth.reportResumeMode, "scheduled");
  assert.equal(afterHealth.latestListenerResumeIntent.requestedAt, listener.requestedAt);
  assert.equal(afterHealth.latestListenerResumeIntent.reportDate, "2026-08-11");

  const newerListener = reportRequest({
    requestedAt: "2026-08-10T16:45:00.000Z",
    reportResumeMode: "listener",
    reportDate: "2026-08-11",
    requesterPid: null,
  });
  const afterCompletedListener = mergeRepairRequests(merged, newerListener, {
    state: {
      handledRequestAt: scheduled.requestedAt,
      handledListenerResumeRequestAt: listener.requestedAt,
    },
    now: Date.parse("2026-08-10T16:45:00.000Z"),
  });
  assert.equal(afterCompletedListener.reportResumeMode, "listener");
  assert.equal(afterCompletedListener.requestedAt, newerListener.requestedAt);
  assert.equal(afterCompletedListener.reportDate, "2026-08-11");
  assert.equal(afterCompletedListener.latestListenerResumeIntent, undefined);
});

test("a newer scheduled request replaces a day-old slot with a bounded trace", () => {
  const oldScheduled = reportRequest({
    requestedAt: "2026-08-10T01:00:00.000Z",
    reportResumeMode: "scheduled",
    reportDate: "2026-08-10",
    requesterPid: null,
  });
  const newScheduled = reportRequest({
    requestedAt: "2026-08-11T02:00:00.000Z",
    reportResumeMode: "scheduled",
    reportDate: "2026-08-11",
    requesterPid: null,
  });
  const merged = mergeRepairRequests(oldScheduled, newScheduled, {
    state: { handledRequestAt: oldScheduled.requestedAt },
    now: Date.parse("2026-08-11T02:00:00.000Z"),
  });

  assert.equal(merged.requestedAt, newScheduled.requestedAt);
  assert.equal(merged.reportDate, "2026-08-11");
  assert.deepEqual(merged.supersededScheduledResumeIntent, {
    requestedAt: oldScheduled.requestedAt,
    reportResumeMode: "scheduled",
    reportDate: "2026-08-10",
    requesterPid: null,
  });

  const sameDayRetry = reportRequest({
    requestedAt: "2026-08-11T02:15:00.000Z",
    reportResumeMode: "scheduled",
    reportDate: "2026-08-11",
    requesterPid: null,
  });
  const retried = mergeRepairRequests(merged, sameDayRetry, {
    state: { handledRequestAt: newScheduled.requestedAt },
    now: Date.parse("2026-08-11T02:15:00.000Z"),
  });
  assert.equal(retried.requestedAt, sameDayRetry.requestedAt);
  assert.deepEqual(
    retried.supersededScheduledResumeIntent,
    merged.supersededScheduledResumeIntent,
  );
});

test("a handled report request does not turn a later health repair into a report rerun", () => {
  const current = reportRequest();
  const incoming = healthRequest();
  const merged = mergeRepairRequests(current, incoming, {
    state: { handledRequestAt: current.requestedAt },
    now: baseNow + 1000,
  });

  assert.deepEqual(merged, incoming);
});

test("plain health requests are written normally", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zhimadi-request-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const requestPath = path.join(tempDir, "request.json");
  const statePath = path.join(tempDir, "state.json");
  const incoming = healthRequest();

  const persisted = await persistMergedRepairRequest(incoming, {
    requestPath,
    statePath,
    lockName: `zhimadi-request-test-${crypto.randomUUID()}`,
    now: baseNow + 1000,
  });

  assert.deepEqual(persisted, incoming);
  assert.deepEqual(JSON.parse(fs.readFileSync(requestPath, "utf8")), incoming);
  assert.equal(fs.statSync(requestPath).mode & 0o777, 0o600);
});

test("concurrent report and health producers retain the report resume intent", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zhimadi-request-race-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const requestPath = path.join(tempDir, "request.json");
  const statePath = path.join(tempDir, "state.json");
  const lockName = `zhimadi-request-race-${crypto.randomUUID()}`;
  const formal = reportRequest({
    reportResumeMode: "scheduled",
    requesterPid: 77,
    requesterMessageId: "scheduled-report",
  });

  await Promise.all([
    persistMergedRepairRequest(formal, {
      requestPath,
      statePath,
      lockName,
      now: baseNow + 1000,
    }),
    persistMergedRepairRequest(healthRequest(), {
      requestPath,
      statePath,
      lockName,
      now: baseNow + 1000,
    }),
  ]);

  const persisted = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  assert.equal(persisted.afterLoginReport, true);
  assert.equal(persisted.reportResumeMode, "scheduled");
  assert.equal(persisted.requesterPid, 77);
  assert.equal(persisted.requesterMessageId, "scheduled-report");
  assert.equal(persisted.requestedAt, formal.requestedAt);
});
