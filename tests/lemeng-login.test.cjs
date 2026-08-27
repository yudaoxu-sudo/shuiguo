const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isLemengLoginUrl,
  isLemengSessionExpiredText,
  lemengCredentials,
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
