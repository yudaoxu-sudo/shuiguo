const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const defaultCodePath = path.resolve("output/lemeng-sms-code.txt");
const defaultLogPath = path.resolve("output/lemeng-login.log");

// 群里“666”是月报口令，纯数字容易撞车，所以乐檬验证码必须带前缀。
const codePattern = /(?:乐檬码|乐檬验证码|乐檬短信码)[:：]?\s*(\d{4,8})(?!\d)/;
const commandPattern = /乐檬(?:重新)?登录/;

function extractLemengSmsCode(text) {
  const match = String(text || "").replace(/\s+/g, " ").match(codePattern);
  return match ? match[1] : null;
}

function isLemengLoginCommand(text) {
  const value = String(text || "");
  if (extractLemengSmsCode(value)) return false;
  return commandPattern.test(value);
}

function deliverLemengSmsCode(code, { codePath = defaultCodePath } = {}) {
  const digits = String(code || "").match(/\d{4,8}/);
  if (!digits) throw new Error("验证码格式不对，应为 4 到 8 位数字");
  fs.mkdirSync(path.dirname(codePath), { recursive: true });
  fs.writeFileSync(codePath, `${digits[0]}\n`, { mode: 0o600 });
  return digits[0];
}

function readLemengLoginStatus(logPath = defaultLogPath) {
  let log = "";
  try {
    log = fs.readFileSync(logPath, "utf8");
  } catch {
    return { state: "missing", message: "还没有登录记录" };
  }
  if (/lemeng-login: (ok|already-ok)|乐檬登录完成/.test(log)) {
    return { state: "ok", message: "乐檬登录成功" };
  }
  const failed = log.match(/乐檬登录失败：(.+)/);
  if (failed) return { state: "failed", message: failed[1].trim().slice(0, 200) };
  if (/等待验证码/.test(log)) {
    return { state: "waiting-code", message: "已发送短信，等待验证码" };
  }
  return { state: "running", message: "登录进行中" };
}

function startLemengLogin({
  logPath = defaultLogPath,
  cwd = process.cwd(),
  waitMs = 15 * 60 * 1000,
  spawnProcess = spawn,
} = {}) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, "");
  const out = fs.openSync(logPath, "a");
  const child = spawnProcess(process.execPath, ["scripts/lemeng-login.cjs"], {
    cwd,
    env: { ...process.env, LEMENG_SMS_WAIT_MS: String(waitMs) },
    stdio: ["ignore", out, out],
    detached: true,
  });
  child.unref?.();
  return child;
}

module.exports = {
  defaultCodePath,
  defaultLogPath,
  deliverLemengSmsCode,
  extractLemengSmsCode,
  isLemengLoginCommand,
  readLemengLoginStatus,
  startLemengLogin,
};
