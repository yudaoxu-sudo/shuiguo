const fs = require("fs");
const path = require("path");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function lockOwnerIsStale(owner, {
  now = Date.now(),
  staleMs = 30 * 60 * 1000,
  lockMtimeMs = 0,
  isRunning = isProcessRunning,
} = {}) {
  const ownerPid = Number(owner?.pid);
  if (isRunning(ownerPid)) return false;
  if (Number.isInteger(ownerPid) && ownerPid > 0) return true;

  const ownerStartedAt = Date.parse(owner?.startedAt || "");
  const orphanedAt = Number.isFinite(ownerStartedAt)
    ? ownerStartedAt
    : lockMtimeMs;
  return Number.isFinite(orphanedAt)
    && orphanedAt > 0
    && now - orphanedAt > staleMs;
}

async function acquireLock(name, options = {}) {
  const outputDir = path.resolve("output");
  const lockDir = path.join(outputDir, `${name}.lock`);
  const waitMs = options?.waitMs ?? 10 * 60 * 1000;
  const staleMs = options?.staleMs ?? 30 * 60 * 1000;
  const startedAt = Date.now();

  fs.mkdirSync(outputDir, { recursive: true });

  while (true) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }, null, 2));
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          fs.rmSync(lockDir, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;

      const ownerPath = path.join(lockDir, "owner.json");
      let owner;
      try {
        owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
      } catch {
        owner = null;
      }

      let lockMtimeMs;
      try {
        lockMtimeMs = fs.statSync(lockDir).mtimeMs;
      } catch (statError) {
        if (statError.code === "ENOENT") continue;
        throw statError;
      }
      const stale = lockOwnerIsStale(owner, { staleMs, lockMtimeMs });
      if (stale) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }

      if (Date.now() - startedAt > waitMs) {
        throw new Error(`等待 ${name} 锁超时，可能已有报表或登录检查正在运行`);
      }

      await sleep(2000);
    }
  }
}

async function withLock(name, options, action) {
  const lock = await acquireLock(name, options);
  try {
    return await action();
  } finally {
    lock.release();
  }
}

module.exports = { acquireLock, lockOwnerIsStale, withLock };
