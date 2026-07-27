const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  acquireHealthClaim,
  checkListenerHealth,
  readJson,
  shouldAlert,
  writeJson,
} = require("../scripts/check-listener-health.cjs");

const silent = () => {};
const staleHeartbeat = { updatedAt: "2026-07-26T00:00:00.000Z" };

test("accepted alert followed by crash is suppressed during cooldown", async () => {
  let state = null;
  let restarts = 0;
  let sends = 0;

  const common = {
    heartbeat: staleHeartbeat,
    staleThresholdMs: 1,
    cooldownMs: 60_000,
    persist(data) {
      state = structuredClone(data);
    },
    async restart() {
      restarts += 1;
      return { ok: true, message: "" };
    },
    async send() {
      sends += 1;
      throw new Error("simulated crash after remote acceptance");
    },
    log: silent,
  };

  await assert.rejects(
    checkListenerHealth({ ...common, now: Date.parse("2026-07-26T01:00:00.000Z"), state }),
    /simulated crash/,
  );
  assert.equal(state.status, "stale-alerting");
  assert.ok(state.lastAlertAttemptAt);

  await checkListenerHealth({
    ...common,
    now: Date.parse("2026-07-26T01:00:01.000Z"),
    state,
  });
  assert.equal(restarts, 1);
  assert.equal(sends, 1);
});

test("reservation failure prevents restart and send", async () => {
  let restarts = 0;
  let sends = 0;

  await assert.rejects(
    checkListenerHealth({
      now: Date.parse("2026-07-26T01:00:00.000Z"),
      heartbeat: staleHeartbeat,
      state: null,
      staleThresholdMs: 1,
      cooldownMs: 60_000,
      persist() {
        throw new Error("disk unavailable");
      },
      async restart() {
        restarts += 1;
        return { ok: true, message: "" };
      },
      async send() {
        sends += 1;
      },
      log: silent,
    }),
    /disk unavailable/,
  );

  assert.equal(restarts, 0);
  assert.equal(sends, 0);
});

test("successful alert stores reservation and completion timestamps", async () => {
  const writes = [];
  let restarts = 0;
  let sends = 0;

  await checkListenerHealth({
    now: Date.parse("2026-07-26T01:00:00.000Z"),
    heartbeat: staleHeartbeat,
    state: null,
    staleThresholdMs: 1,
    cooldownMs: 60_000,
    persist(data) {
      writes.push(structuredClone(data));
    },
    async restart() {
      restarts += 1;
      return { ok: true, message: "" };
    },
    async send() {
      sends += 1;
    },
    log: silent,
  });

  assert.equal(restarts, 1);
  assert.equal(sends, 1);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].status, "stale-alerting");
  assert.ok(writes[0].lastAlertAttemptAt);
  assert.equal(writes[1].status, "stale");
  assert.equal(writes[1].lastAlertAttemptAt, writes[1].lastAlertAt);
});

test("corrupt alert timestamps never suppress alerts permanently", async () => {
  const writes = [];
  let restarts = 0;
  let sends = 0;

  await checkListenerHealth({
    now: Date.parse("2026-07-26T01:00:00.000Z"),
    heartbeat: staleHeartbeat,
    state: { status: "stale-alerting", lastAlertAttemptAt: "not-a-timestamp", lastAlertAt: null },
    staleThresholdMs: 1,
    cooldownMs: 60_000,
    persist(data) {
      writes.push(structuredClone(data));
    },
    async restart() {
      restarts += 1;
      return { ok: true, message: "" };
    },
    async send() {
      sends += 1;
    },
    log: silent,
  });

  assert.equal(restarts, 1);
  assert.equal(sends, 1);
  assert.equal(writes.at(-1).lastAlertAttemptAt, "2026-07-26T01:00:00.000Z");
});

test("future reservation timestamp after clock rollback still alerts", async () => {
  const writes = [];
  let restarts = 0;
  let sends = 0;

  await checkListenerHealth({
    now: Date.parse("2026-07-26T01:00:00.000Z"),
    heartbeat: staleHeartbeat,
    state: {
      status: "stale-alerting",
      lastAlertAttemptAt: "2026-07-26T01:30:00.000Z",
      lastAlertAt: null,
    },
    staleThresholdMs: 1,
    cooldownMs: 60_000,
    persist(data) {
      writes.push(structuredClone(data));
    },
    async restart() {
      restarts += 1;
      return { ok: true, message: "" };
    },
    async send() {
      sends += 1;
    },
    log: silent,
  });

  assert.equal(restarts, 1);
  assert.equal(sends, 1);
  assert.equal(writes.at(-1).lastAlertAttemptAt, "2026-07-26T01:00:00.000Z");
});

test("far-future heartbeat is treated as corrupt and triggers recovery", async () => {
  const now = Date.parse("2026-07-26T01:00:00.000Z");
  let restarts = 0;
  let sends = 0;

  await checkListenerHealth({
    now,
    heartbeat: { updatedAt: "2026-07-26T02:00:00.000Z" },
    state: null,
    staleThresholdMs: 60_000,
    cooldownMs: 60_000,
    persist() {},
    async restart() {
      restarts += 1;
      return { ok: true, message: "" };
    },
    async send() {
      sends += 1;
    },
    log: silent,
  });

  assert.equal(restarts, 1);
  assert.equal(sends, 1);
});

test("uses health thresholds loaded into the environment after module import", async () => {
  const now = Date.parse("2026-07-26T01:00:00.000Z");
  const previousStale = process.env.LISTENER_STALE_MS;
  const previousCooldown = process.env.LISTENER_ALERT_COOLDOWN_MS;
  let restarts = 0;
  let sends = 0;
  try {
    process.env.LISTENER_STALE_MS = "1000";
    process.env.LISTENER_ALERT_COOLDOWN_MS = "1000";

    await checkListenerHealth({
      now,
      heartbeat: { updatedAt: new Date(now - 2000).toISOString() },
      state: {
        lastAlertAttemptAt: new Date(now - 2000).toISOString(),
      },
      persist() {},
      async restart() {
        restarts += 1;
        return { ok: true, message: "" };
      },
      async send() {
        sends += 1;
      },
      log: silent,
    });
  } finally {
    if (previousStale === undefined) delete process.env.LISTENER_STALE_MS;
    else process.env.LISTENER_STALE_MS = previousStale;
    if (previousCooldown === undefined) delete process.env.LISTENER_ALERT_COOLDOWN_MS;
    else process.env.LISTENER_ALERT_COOLDOWN_MS = previousCooldown;
  }

  assert.equal(restarts, 1);
  assert.equal(sends, 1);
});

test("shouldAlert treats unparseable and future timestamps as alertable", () => {
  const now = Date.parse("2026-07-26T01:00:00.000Z");
  assert.equal(shouldAlert(now, { lastAlertAttemptAt: "not-a-timestamp" }, 60_000), true);
  assert.equal(shouldAlert(now, { lastAlertAt: "0000-99-99T99:99:99Z" }, 60_000), true);
  assert.equal(shouldAlert(now, { lastAlertAttemptAt: "2026-07-26T01:10:00.000Z" }, 60_000), true);
});

test("shouldAlert treats missing or null state fields as alertable", () => {
  const now = Date.parse("2026-07-26T01:00:00.000Z");
  assert.equal(shouldAlert(now, null, 60_000), true);
  assert.equal(shouldAlert(now, {}, 60_000), true);
  assert.equal(shouldAlert(now, { status: "ok", lastCheckAt: "2026-07-26T00:59:00.000Z" }, 60_000), true);
  assert.equal(shouldAlert(now, { lastAlertAttemptAt: null, lastAlertAt: null }, 60_000), true);
});

test("cooldown boundary exactly equal stays suppressed", () => {
  const t0 = Date.parse("2026-07-26T01:00:00.000Z");
  const state = { lastAlertAttemptAt: "2026-07-26T01:00:00.000Z" };
  assert.equal(shouldAlert(t0 + 60_000, state, 60_000), false);
  assert.equal(shouldAlert(t0 + 60_000 + 1, state, 60_000), true);
});

test("legacy state with only lastAlertAt still honors cooldown", async () => {
  const legacy = { status: "stale", lastAlertAt: "2026-07-26T01:00:00.000Z" };
  const writes = [];
  let restarts = 0;
  let sends = 0;

  const common = {
    heartbeat: staleHeartbeat,
    staleThresholdMs: 1,
    cooldownMs: 60_000,
    persist(data) {
      writes.push(structuredClone(data));
    },
    async restart() {
      restarts += 1;
      return { ok: true, message: "" };
    },
    async send() {
      sends += 1;
    },
    log: silent,
  };

  await checkListenerHealth({ ...common, now: Date.parse("2026-07-26T01:00:30.000Z"), state: legacy });
  assert.equal(restarts, 0);
  assert.equal(sends, 0);
  assert.equal(writes.length, 0);

  await checkListenerHealth({ ...common, now: Date.parse("2026-07-26T01:01:00.001Z"), state: legacy });
  assert.equal(restarts, 1);
  assert.equal(sends, 1);
  assert.equal(writes[0].status, "stale-alerting");
  assert.equal(writes[0].lastAlertAt, "2026-07-26T01:00:00.000Z");
});

test("persistent send failures retry once per cooldown window", async () => {
  let state = null;
  let restarts = 0;
  let sends = 0;

  const common = {
    heartbeat: staleHeartbeat,
    staleThresholdMs: 1,
    cooldownMs: 60_000,
    persist(data) {
      state = structuredClone(data);
    },
    async restart() {
      restarts += 1;
      return { ok: true, message: "" };
    },
    async send() {
      sends += 1;
      throw new Error("webhook down");
    },
    log: silent,
  };

  const run = (now) => checkListenerHealth({ ...common, now, state });

  await assert.rejects(run(Date.parse("2026-07-26T01:00:00.000Z")), /webhook down/);
  assert.equal(sends, 1);
  assert.equal(state.status, "stale-alerting");

  await run(Date.parse("2026-07-26T01:01:00.000Z"));
  assert.equal(sends, 1);

  await assert.rejects(run(Date.parse("2026-07-26T01:01:00.001Z")), /webhook down/);
  assert.equal(sends, 2);
  assert.equal(restarts, 2);
  assert.equal(state.lastAlertAttemptAt, "2026-07-26T01:01:00.001Z");

  await run(Date.parse("2026-07-26T01:01:30.001Z"));
  assert.equal(sends, 2);
});

test("writes listener health state atomically and treats corrupt JSON as empty state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listener-health-state-test-"));
  const filePath = path.join(dir, "state.json");
  try {
    writeJson(filePath, { status: "ok" });
    assert.deepEqual(readJson(filePath), { status: "ok" });
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ["state.json"]);

    fs.writeFileSync(filePath, "{broken");
    assert.equal(readJson(filePath), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("allows only one live listener health claim and recovers corrupt claims", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listener-health-claim-test-"));
  const filePath = path.join(dir, "state.json");
  const now = Date.parse("2026-07-26T01:00:00.000Z");
  try {
    const first = acquireHealthClaim(filePath, { now, token: "claim-1" });
    assert.equal(first.acquired, true);
    const second = acquireHealthClaim(filePath, { now, token: "claim-2" });
    assert.equal(second.acquired, false);

    first.release();
    const third = acquireHealthClaim(filePath, { now, token: "claim-3" });
    assert.equal(third.acquired, true);
    third.release();

    fs.writeFileSync(`${filePath}.claim`, "{broken");
    const recovered = acquireHealthClaim(filePath, { now, token: "claim-4" });
    assert.equal(recovered.acquired, true);
    recovered.release();

    fs.writeFileSync(`${filePath}.claim`, JSON.stringify({
      token: "future-claim",
      claimedAt: "2026-07-26T01:01:00.000Z",
    }));
    const afterClockRollback = acquireHealthClaim(filePath, {
      now,
      token: "claim-5",
    });
    assert.equal(afterClockRollback.acquired, false);
    fs.rmSync(`${filePath}.claim`);

    fs.writeFileSync(`${filePath}.claim`, JSON.stringify({
      token: "corrupt-future-claim",
      claimedAt: "2026-07-26T02:00:00.000Z",
    }));
    const recoveredFutureClaim = acquireHealthClaim(filePath, {
      now,
      token: "claim-6",
    });
    assert.equal(recoveredFutureClaim.acquired, true);
    recoveredFutureClaim.release();
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent health checks perform one restart and one send", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listener-health-concurrency-test-"));
  const filePath = path.join(dir, "state.json");
  const now = Date.parse("2026-07-26T01:00:00.000Z");
  let releaseRestart;
  const restartGate = new Promise((resolve) => {
    releaseRestart = resolve;
  });
  let restarts = 0;
  let sends = 0;

  const options = {
    now,
    heartbeat: staleHeartbeat,
    staleThresholdMs: 1,
    cooldownMs: 60_000,
    loadState: () => readJson(filePath),
    persist: (data) => writeJson(filePath, data),
    claim: () => acquireHealthClaim(filePath, { now }),
    async restart() {
      restarts += 1;
      await restartGate;
      return { ok: true, message: "" };
    },
    async send() {
      sends += 1;
    },
    log: silent,
  };

  try {
    const first = checkListenerHealth(options);
    const second = checkListenerHealth(options);
    await new Promise((resolve) => setImmediate(resolve));
    releaseRestart();
    await Promise.all([first, second]);

    assert.equal(restarts, 1);
    assert.equal(sends, 1);
    assert.equal(readJson(filePath).status, "stale");
    assert.equal(fs.existsSync(`${filePath}.claim`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt persisted state does not suppress a stale listener repair", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listener-health-corrupt-test-"));
  const filePath = path.join(dir, "state.json");
  const now = Date.parse("2026-07-26T01:00:00.000Z");
  let restarts = 0;
  let sends = 0;
  try {
    fs.writeFileSync(filePath, "{broken");
    await checkListenerHealth({
      now,
      heartbeat: staleHeartbeat,
      staleThresholdMs: 1,
      cooldownMs: 60_000,
      loadState: () => readJson(filePath),
      persist: (data) => writeJson(filePath, data),
      claim: () => acquireHealthClaim(filePath, { now }),
      async restart() {
        restarts += 1;
        return { ok: true, message: "" };
      },
      async send() {
        sends += 1;
      },
      log: silent,
    });
    assert.equal(restarts, 1);
    assert.equal(sends, 1);
    assert.equal(readJson(filePath).status, "stale");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
