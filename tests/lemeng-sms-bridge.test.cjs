const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  deliverLemengSmsCode,
  extractLemengSmsCode,
  isLemengLoginCommand,
  extractPendingSmsCode,
  readLemengLoginStatus,
} = require("../scripts/lemeng-sms-bridge.cjs");

test("takes a prefixed Lemeng code the way the shop owner would type it", () => {
  assert.equal(extractLemengSmsCode("乐檬码123456"), "123456");
  assert.equal(extractLemengSmsCode("乐檬验证码：8842"), "8842");
  assert.equal(extractLemengSmsCode("乐檬短信码 4417"), "4417");
  assert.equal(extractLemengSmsCode("@水果店月报 乐檬码 998877"), "998877");
});

test("never mistakes the 666 report command for a verification code", () => {
  assert.equal(extractLemengSmsCode("@水果店月报 666"), null);
  assert.equal(extractLemengSmsCode("666666"), null);
  assert.equal(extractLemengSmsCode("报表 2026-07"), null);
  assert.equal(extractLemengSmsCode(""), null);
});

test("tells a login request apart from a code reply", () => {
  assert.equal(isLemengLoginCommand("乐檬登录"), true);
  assert.equal(isLemengLoginCommand("乐檬重新登录"), true);
  assert.equal(isLemengLoginCommand("乐檬码123456"), false);
  assert.equal(isLemengLoginCommand("666"), false);
});

test("writes only the digits, owner-readable, and rejects junk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lemeng-bridge-"));
  const codePath = path.join(dir, "code.txt");

  assert.equal(deliverLemengSmsCode("123456", { codePath }), "123456");
  assert.equal(fs.readFileSync(codePath, "utf8").trim(), "123456");
  assert.equal(fs.statSync(codePath).mode & 0o777, 0o600);

  assert.throws(() => deliverLemengSmsCode("abc", { codePath }), /验证码格式/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reads the login outcome back out of the log", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lemeng-bridge-"));
  const logPath = path.join(dir, "login.log");

  assert.equal(readLemengLoginStatus(logPath).state, "missing");

  fs.writeFileSync(logPath, "已请求乐檬发送短信验证码\n等待验证码，请把收到的验证码写入 ...\n");
  assert.equal(readLemengLoginStatus(logPath).state, "waiting-code");

  fs.writeFileSync(logPath, "lemeng-login: ok\n乐檬登录完成：ok\n");
  assert.equal(readLemengLoginStatus(logPath).state, "ok");

  fs.writeFileSync(logPath, "乐檬登录失败：乐檬登录未通过，仍停留在登录页\n");
  const failed = readLemengLoginStatus(logPath);
  assert.equal(failed.state, "failed");
  assert.match(failed.message, /仍停留在登录页/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("accepts a bare code right after the owner asks to sign in", () => {
  const now = Date.now();
  assert.equal(extractPendingSmsCode("123456", now, { now }), "123456");
  assert.equal(extractPendingSmsCode("@水果店月报 8842", now, { now }), "8842");
});

test("never swallows the 666 report command as a verification code", () => {
  const now = Date.now();
  assert.equal(extractPendingSmsCode("666", now, { now }), null);
  assert.equal(extractPendingSmsCode("666666", now, { now }), null);
  assert.equal(extractPendingSmsCode("@水果店月报 666", now, { now }), null);
});

test("stops accepting bare digits once the sign-in window closes", () => {
  const now = Date.now();
  assert.equal(extractPendingSmsCode("123456", now - 11 * 60 * 1000, { now }), null);
  assert.equal(extractPendingSmsCode("123456", null, { now }), null);
});

test("ignores an ambiguous message carrying several numbers", () => {
  const now = Date.now();
  assert.equal(extractPendingSmsCode("报表 2026 1234", now, { now }), null);
});

// listener 的 messageText 会删掉全部空白，@机器人 和正文会连成一串。
test("still sees the request when the mention is glued to the word", () => {
  assert.equal(isLemengLoginCommand("@水果店月报乐檬"), true);
  assert.equal(isLemengLoginCommand("乐檬"), true);
  assert.equal(isLemengLoginCommand("@水果店月报乐檬登录"), true);
});

test("still finds a bare code when the mention is glued to the digits", () => {
  const now = Date.now();
  assert.equal(extractPendingSmsCode("@水果店月报123456", now, { now }), "123456");
  assert.equal(extractLemengSmsCode("@水果店月报乐檬码123456"), "123456");
});
