const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

function pythonExecutable() {
  if (process.env.DOUYIN_PYTHON) return process.env.DOUYIN_PYTHON;

  const venvPython = path.resolve(".venv/bin/python");
  if (fs.existsSync(venvPython)) return venvPython;

  return "python3";
}

async function readDouyin(targetDate) {
  const args = [path.resolve("scripts/douyin_client.py")];
  if (targetDate) args.push("--date", targetDate);

  const { stdout } = await execFileAsync(pythonExecutable(), args, {
    cwd: path.resolve("."),
    env: process.env,
    timeout: Number(process.env.DOUYIN_PROCESS_TIMEOUT_MS || 15 * 60 * 1000),
    maxBuffer: 10 * 1024 * 1024,
  });

  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`抖音日报返回了无效 JSON：${stdout.slice(0, 200)}`);
  }
}

module.exports = { readDouyin };
