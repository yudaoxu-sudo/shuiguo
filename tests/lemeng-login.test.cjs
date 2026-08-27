const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  isLemengLoginUrl,
  isLemengSessionExpiredText,
  isLemengSmsStepText,
  lemengCredentials,
  parseSmsCode,
  waitForSmsCode,
} = require("../scripts/lemeng-login.cjs");

// 2026-08-27 生产实际抓到的过期页面正文。
const realExpiredPage = [
  "500",
  "用户信息已过期，请重新登录",
  "错误码: 426e1e3689180e6d322b8d4e35dbc2f6",
  "重新登录",
].join("\n");

test("recognises the real Lemeng session-expiry page that has no password box", () => {
  assert.equal(isLemengSessionExpiredText(realExpiredPage), true);
});

test("does not mistake a working collection report for an expired session", () => {
  const workingPage = [
    "营业收款报表",
    "开始日期",
    "门店汇总",
    "营业额(不含券)",
    "合计 1,234.56",
  ].join("\n");
  assert.equal(isLemengSessionExpiredText(workingPage), false);
  assert.equal(isLemengSessionExpiredText(""), false);
  assert.equal(isLemengSessionExpiredText(null), false);
});

test("does not fire on an unrelated page that merely offers a login link", () => {
  assert.equal(isLemengSessionExpiredText("欢迎使用乐檬，点击登录"), false);
});

test("tells the account login host apart from the report host", () => {
  assert.equal(
    isLemengLoginUrl("https://account.lemengcloud.com/user/login"),
    true,
  );
  assert.equal(
    isLemengLoginUrl("https://sharec.lemengcloud.com/report/business/business-collection-report"),
    false,
  );
  assert.equal(isLemengLoginUrl(""), false);
});

test("refuses to run without credentials instead of prompting for them", () => {
  assert.throws(
    () => lemengCredentials({ LEMENG_USERNAME: "", LEMENG_PASSWORD: "" }),
    /LEMENG_USERNAME/,
  );
  assert.throws(
    () => lemengCredentials({ LEMENG_USERNAME: "13800000000" }),
    /LEMENG_PASSWORD/,
  );
  assert.deepEqual(
    lemengCredentials({
      LEMENG_USERNAME: " 13800000000 ",
      LEMENG_PASSWORD: " secret ",
    }),
    { username: "13800000000", password: "secret" },
  );
});

// 2026-08-27 生产实测：密码正确后乐檬进入短信验证步骤。
const realSmsStepPage = "请验证手机号187****2906 验证码 发送验证码 登 录 5天内自动登录 联系客服";

test("recognises the SMS step that follows a correct password", () => {
  assert.equal(isLemengSmsStepText(realSmsStepPage), true);
  assert.equal(isLemengSmsStepText("营业收款报表 开始日期 门店汇总"), false);
  assert.equal(isLemengSmsStepText(""), false);
});

test("pulls a verification code out of whatever the shop owner types", () => {
  assert.equal(parseSmsCode(" 123456 \n"), "123456");
  assert.equal(parseSmsCode("验证码是 8842"), "8842");
  assert.equal(parseSmsCode("没有数字"), null);
  assert.equal(parseSmsCode(""), null);
});

test("takes the code from a dropped file and removes it after one use", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lemeng-sms-"));
  const codePath = path.join(dir, "code.txt");
  fs.writeFileSync(codePath, "654321\n");

  const code = await waitForSmsCode({ codePath, env: {}, timeoutMs: 5000, log: () => {} });
  assert.equal(code, "654321");
  assert.equal(fs.existsSync(codePath), false, "用过的验证码文件必须删掉");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("gives up instead of hanging when no code ever arrives", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lemeng-sms-"));
  await assert.rejects(
    () => waitForSmsCode({
      codePath: path.join(dir, "missing.txt"),
      env: {},
      timeoutMs: 100,
      log: () => {},
    }),
    /超时/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
