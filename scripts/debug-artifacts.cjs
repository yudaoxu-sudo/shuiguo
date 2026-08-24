const fs = require("fs");
const path = require("path");

const defaultRetentionDays = 7;
// 只清理调试截图和文本，其余 output/ 内容（浏览器登录态、状态文件、历史归档）一律不动。
const artifactPattern = /\.(png|txt)$/i;

function debugDir(outputDir = path.resolve("output")) {
  return path.join(path.resolve(outputDir), "debug");
}

function retentionMs(env = process.env) {
  const days = Number(env.DEBUG_ARTIFACT_RETENTION_DAYS);
  const safeDays = Number.isFinite(days) && days >= 0
    ? days
    : defaultRetentionDays;
  return safeDays * 24 * 60 * 60 * 1000;
}

function pruneDebugArtifacts({
  outputDir = path.resolve("output"),
  now = Date.now(),
  maxAgeMs = retentionMs(),
} = {}) {
  const directory = debugDir(outputDir);
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return { removed: 0, kept: 0 };
  }

  let removed = 0;
  let kept = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !artifactPattern.test(entry.name)) {
      kept += 1;
      continue;
    }

    const filePath = path.join(directory, entry.name);
    let stat;
    try {
      stat = fs.lstatSync(filePath);
    } catch {
      kept += 1;
      continue;
    }
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || now - stat.mtimeMs <= maxAgeMs
    ) {
      kept += 1;
      continue;
    }

    try {
      fs.rmSync(filePath, { force: true });
      removed += 1;
    } catch {
      kept += 1;
    }
  }

  return { removed, kept };
}

function pruneDebugArtifactsQuietly(options = {}) {
  try {
    return pruneDebugArtifacts(options);
  } catch {
    return { removed: 0, kept: 0 };
  }
}

module.exports = {
  debugDir,
  defaultRetentionDays,
  pruneDebugArtifacts,
  pruneDebugArtifactsQuietly,
  retentionMs,
};
