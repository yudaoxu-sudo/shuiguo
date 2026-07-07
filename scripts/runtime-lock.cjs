const fs = require("fs");
const path = require("path");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withLock(name, options, action) {
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
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;

      const ownerPath = path.join(lockDir, "owner.json");
      let owner;
      try {
        owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
      } catch {
        owner = null;
      }

      const ownerStartedAt = owner?.startedAt ? Date.parse(owner.startedAt) : 0;
      const stale = !ownerStartedAt || Date.now() - ownerStartedAt > staleMs;
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

  try {
    return await action();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

module.exports = { withLock };
