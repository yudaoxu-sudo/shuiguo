const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { withLock } = require("./runtime-lock.cjs");

const statePath = path.resolve("output/health-alert-claims.json");
const sharedProblemKeys = new Set([
  "zhimadi-login",
  "lemeng-login",
]);

function isSharedHealthProblem(problemKey) {
  return sharedProblemKeys.has(problemKey);
}

function readState(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeState(filePath, state) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function createHealthAlertStore(options = {}) {
  const filePath = options.statePath || statePath;
  const lock = options.withLock || withLock;

  async function getHealthAlertState(problemKey) {
    if (!isSharedHealthProblem(problemKey)) return null;
    return readState(filePath)?.claims?.[problemKey] || null;
  }

  async function claimHealthAlert(problemKey, claimedAt, source) {
    if (!isSharedHealthProblem(problemKey)) return true;
    return lock("health-alert-claim", {
      waitMs: 5000,
      staleMs: 60 * 1000,
    }, async () => {
      const state = readState(filePath);
      const claims = state?.claims || {};
      if (claims[problemKey]?.status === "claimed") return false;
      writeState(filePath, {
        claims: {
          ...claims,
          [problemKey]: {
            status: "claimed",
            claimId: crypto.randomUUID(),
            claimedAt,
            source,
          },
        },
      });
      return true;
    });
  }

  async function resolveHealthAlert(problemKey, resolvedAt, probeStartedAt) {
    if (!isSharedHealthProblem(problemKey)) return false;
    return lock("health-alert-claim", {
      waitMs: 5000,
      staleMs: 60 * 1000,
    }, async () => {
      const state = readState(filePath);
      const claims = state?.claims || {};
      const claim = claims[problemKey];
      if (claim?.status !== "claimed") return false;
      const claimedAt = Date.parse(claim.claimedAt || "");
      const probeStart = typeof probeStartedAt === "number"
        ? probeStartedAt
        : Date.parse(probeStartedAt || "");
      if (
        !Number.isFinite(claimedAt)
        || !Number.isFinite(probeStart)
        || claimedAt >= probeStart
      ) {
        return false;
      }
      writeState(filePath, {
        claims: {
          ...claims,
          [problemKey]: {
            ...claim,
            status: "resolved",
            resolvedAt,
          },
        },
      });
      return true;
    });
  }

  return {
    claimHealthAlert,
    getHealthAlertState,
    resolveHealthAlert,
  };
}

const defaultStore = createHealthAlertStore();

module.exports = {
  claimHealthAlert: defaultStore.claimHealthAlert,
  createHealthAlertStore,
  getHealthAlertState: defaultStore.getHealthAlertState,
  isSharedHealthProblem,
  resolveHealthAlert: defaultStore.resolveHealthAlert,
};
