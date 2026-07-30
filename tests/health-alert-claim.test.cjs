const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createHealthAlertStore,
} = require("../scripts/health-alert-claim.cjs");

test("a stale probe cannot resolve a newer shared alert generation", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "health-alert-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "claims.json");
  const store = createHealthAlertStore({
    statePath: filePath,
    withLock: async (_name, _options, action) => action(),
  });

  assert.equal(
    await store.claimHealthAlert(
      "zhimadi-login",
      "2026-07-30T04:00:10.000Z",
      "report-healthcheck",
    ),
    true,
  );
  assert.equal(
    await store.claimHealthAlert(
      "zhimadi-login",
      "2026-07-30T04:00:20.000Z",
      "login-healthcheck",
    ),
    false,
  );
  assert.equal(
    (await store.getHealthAlertState("zhimadi-login")).status,
    "claimed",
  );
  assert.equal(
    await store.resolveHealthAlert(
      "zhimadi-login",
      "2026-07-30T04:00:30.000Z",
      Date.parse("2026-07-30T04:00:05.000Z"),
    ),
    false,
  );
  assert.equal(
    await store.resolveHealthAlert(
      "zhimadi-login",
      "2026-07-30T04:00:40.000Z",
      Date.parse("2026-07-30T04:00:20.000Z"),
    ),
    true,
  );

  assert.equal(
    await store.claimHealthAlert(
      "zhimadi-login",
      "2026-07-30T04:01:00.000Z",
      "login-healthcheck",
    ),
    true,
  );
  assert.equal(
    await store.resolveHealthAlert(
      "zhimadi-login",
      "2026-07-30T04:01:10.000Z",
      Date.parse("2026-07-30T04:00:50.000Z"),
    ),
    false,
  );

  const state = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(state.claims["zhimadi-login"].status, "claimed");
  assert.ok(state.claims["zhimadi-login"].claimId);
});
