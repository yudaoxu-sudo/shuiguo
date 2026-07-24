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

async function readDouyinApi(monthThrough) {
  const args = [path.resolve("scripts/douyin_client.py")];
  if (monthThrough) args.push("--month-through", monthThrough);

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

async function readDouyin(monthThrough, context) {
  const source = String(process.env.DOUYIN_SOURCE || "browser").toLowerCase();
  if (source === "api") return readDouyinApi(monthThrough);
  if (source !== "browser") {
    throw new Error(`不支持的抖音数据源：${source}`);
  }
  if (!context) {
    throw new Error("抖音后台汇总读取需要浏览器上下文");
  }

  const { readDouyinBrowser } = require("./read-current-douyin-browser.cjs");
  return readDouyinBrowser(context, monthThrough);
}

module.exports = { readDouyin, readDouyinApi };
