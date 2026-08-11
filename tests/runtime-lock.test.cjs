const assert = require("node:assert/strict");
const test = require("node:test");

const {
  lockOwnerIsStale,
} = require("../scripts/runtime-lock.cjs");

const now = Date.parse("2026-08-11T06:00:00.000Z");

test("a live lock owner is never evicted only because the lock is old", () => {
  assert.equal(lockOwnerIsStale({
    pid: 42,
    startedAt: "2026-08-11T01:00:00.000Z",
  }, {
    now,
    staleMs: 30 * 60 * 1000,
    isRunning: (pid) => pid === 42,
  }), false);
});

test("a dead lock owner is reclaimed and incomplete metadata gets a grace period", () => {
  assert.equal(lockOwnerIsStale({
    pid: 42,
    startedAt: "2026-08-11T05:59:00.000Z",
  }, {
    now,
    staleMs: 30 * 60 * 1000,
    isRunning: () => false,
  }), true);

  assert.equal(lockOwnerIsStale(null, {
    now,
    staleMs: 30 * 60 * 1000,
    lockMtimeMs: now - 1000,
    isRunning: () => false,
  }), false);
  assert.equal(lockOwnerIsStale(null, {
    now,
    staleMs: 30 * 60 * 1000,
    lockMtimeMs: now - 31 * 60 * 1000,
    isRunning: () => false,
  }), true);
});
