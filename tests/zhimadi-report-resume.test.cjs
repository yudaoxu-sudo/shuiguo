const assert = require("node:assert/strict");
const test = require("node:test");

const {
  retryableZhimadiRepairError,
  selectReportRunner,
} = require("../scripts/listen-dingtalk.cjs");

test("scheduled repairs resume through the de-duplicating scheduled entry", () => {
  const scheduled = () => "scheduled";
  const monthly = () => "monthly";
  assert.equal(selectReportRunner("scheduled", { scheduled, monthly })(), "scheduled");
  assert.equal(selectReportRunner("listener", { scheduled, monthly })(), "monthly");
  assert.equal(selectReportRunner(null, { scheduled, monthly })(), "monthly");
});

test("temporary OCR service failures stay inside the silent repair loop", () => {
  assert.equal(retryableZhimadiRepairError(new Error("fetch failed")), true);
  assert.equal(retryableZhimadiRepairError(new Error("验证码视觉识别失败: 429 rate limit")), true);
  assert.equal(retryableZhimadiRepairError(new Error("验证码视觉识别失败: 503 service unavailable")), true);
  const fatal = new Error("缺少芝麻地自动登录账号配置");
  fatal.repairFatal = true;
  assert.equal(retryableZhimadiRepairError(fatal), false);
});
