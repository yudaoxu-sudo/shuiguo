const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isLemengLoginCommand,
  isLemengLoginUrl,
  isLemengSessionExpiredText,
  lemengCredentials,
} = require("../scripts/lemeng-login.cjs");
const { isGroupConversation } = require("../scripts/listen-dingtalk.cjs");

// 2026-08-27 生产实际抓到的过期页面正文：没有密码框，只有一个重新登录按钮。
const realExpiredPage = [
  "500",
  "用户信息已过期，请重新登录",
  "错误码: 426e1e3689180e6d322b8d4e35dbc2f6",
  "重新登录",
].join("\n");

test("recognises the expiry page that carries no password box", () => {
  assert.equal(isLemengSessionExpiredText(realExpiredPage), true);
});

test("does not mistake a working report page for an expired session", () => {
  assert.equal(
    isLemengSessionExpiredText("营业收款报表 开始日期 门店汇总 营业额(不含券)"),
    false,
  );
  assert.equal(isLemengSessionExpiredText("欢迎使用乐檬，点击登录"), false);
  assert.equal(isLemengSessionExpiredText(""), false);
});

test("tells the account host apart from the report host", () => {
  assert.equal(isLemengLoginUrl("https://account.lemengcloud.com/user/login"), true);
  assert.equal(
    isLemengLoginUrl("https://sharec.lemengcloud.com/report/business/business-collection-report"),
    false,
  );
});

// listener 的 messageText 会删掉全部空白，@机器人 和正文会连成一串。
test("hears the request even when the mention is glued to the word", () => {
  assert.equal(isLemengLoginCommand("乐檬"), true);
  assert.equal(isLemengLoginCommand("@水果店月报乐檬"), true);
  assert.equal(isLemengLoginCommand("乐檬登录"), true);
});

test("never answers the report command or a stray number", () => {
  assert.equal(isLemengLoginCommand("666"), false);
  assert.equal(isLemengLoginCommand("@水果店月报666"), false);
  assert.equal(isLemengLoginCommand("乐檬123456"), false);
  assert.equal(isLemengLoginCommand(""), false);
});

test("still refuses to guess credentials it was not given", () => {
  assert.throws(() => lemengCredentials({}), /LEMENG_USERNAME/);
  assert.deepEqual(
    lemengCredentials({ LEMENG_USERNAME: " 13800000000 ", LEMENG_PASSWORD: " x " }),
    { username: "13800000000", password: "x" },
  );
});

// 单聊不能覆盖群上下文，否则芝麻地验证码图会从群里跑到私聊。
test("keeps a one-to-one chat from taking over the group context", () => {
  assert.equal(isGroupConversation({ conversationType: "2" }), true);
  assert.equal(isGroupConversation({ conversationType: "1" }), false);
  assert.equal(isGroupConversation({}), true);
});

// 预览指令只在单聊生效，群里必须维持原样：只有 @机器人 666 出正式月报。
test("keeps the preview out of the group", () => {
  const { isReportPreviewCommand } = require("../scripts/zhimadi-purchase-detail.cjs");
  const groupMessage = { conversationType: "2" };
  const privateMessage = { conversationType: "1" };

  const wouldPreview = (message, text) => !isGroupConversation(message) && isReportPreviewCommand(text);

  assert.equal(wouldPreview(privateMessage, "月报"), true);
  assert.equal(wouldPreview(groupMessage, "@水果店月报月报"), false, "群里不能触发预览");
  assert.equal(wouldPreview(groupMessage, "@水果店月报666"), false);
});
