const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const defaultCodePath = path.resolve("output/lemeng-sms-code.txt");
const defaultLogPath = path.resolve("output/lemeng-login.log");

// 群里“666”是月报口令，纯数字容易撞车，所以乐檬验证码必须带前缀。
const codePattern = /(?:乐檬码|乐檬验证码|乐檬短信码)[:：]?\s*(\d{4,8})(?!\d)/;
const commandPattern = /乐檬(?:重新)?(?:登录)?$|乐檬(?:重新)?登录/;
const pendingTtlMs = 10 * 60 * 1000;

function extractLemengSmsCode(text) {
  const match = String(text || "").replace(/\s+/g, " ").match(codePattern);
  return match ? match[1] : null;
}

// listener 会把消息里的空白全部删掉，@机器人 和正文会连成一串，
// 所以这里只看有没有“乐檬”两个字，不做分词。
function isLemengLoginCommand(text) {
  const value = String(text || "");
  if (!value.includes("乐檬")) return false;
  if (extractLemengSmsCode(value)) return false;
  return !/\d/.test(value);
}

// 触发登录之后的十分钟内，店主直接发一串数字就当验证码，不用再打前缀。
// “666” 永远是月报口令，不会被当成验证码。
function extractPendingSmsCode(text, pendingSince, { now = Date.now(), ttlMs = pendingTtlMs } = {}) {
  if (!pendingSince || now - pendingSince > ttlMs) return null;
  const runs = String(text || "").match(/\d{4,8}/g) || [];
  if (runs.length !== 1) return null;
  if (/^6+$/.test(runs[0])) return null;
  return runs[0];
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
  extractPendingSmsCode,
  pendingTtlMs,
  defaultCodePath,
  defaultLogPath,
  deliverLemengSmsCode,
  extractLemengSmsCode,
  isLemengLoginCommand,
  readLemengLoginStatus,
  startLemengLogin,
};
