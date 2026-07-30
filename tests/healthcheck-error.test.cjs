const assert = require("node:assert/strict");
const test = require("node:test");

const {
  extractHealthFailure,
  finalHealthFailureMessage,
} = require("../scripts/healthcheck-error.cjs");

test("extracts the final structured error from mixed retry output", () => {
  const output = [
    "芝麻地报表第 1 次失败：临时错误",
    "乐檬报表第 1 次失败：临时错误",
    'HEALTHCHECK_FAILURE_JSON={"message":"抖音来客登录态失效"}',
  ].join("\n");
  assert.equal(extractHealthFailure(output), "抖音来客登录态失效");
});

test("prefers a structured child error over its combined output tail", () => {
  const error = new Error("芝麻地旧日志\n乐檬旧日志");
  error.healthFailureMessage = "抖音最终失败";
  assert.equal(finalHealthFailureMessage(error), "抖音最终失败");
});
