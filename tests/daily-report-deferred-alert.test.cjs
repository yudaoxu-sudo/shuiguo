const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isZhimadiRepairAlertOwnedError,
  isZhimadiRepairDeferredError,
  repairCanResumeInProcess,
} = require("../scripts/daily-report.cjs");

test("suppresses immediate report alerts for every unresolved Zhimadi repair phase", () => {
  for (const code of [
    "ZHIMADI_AUTO_RETRYING",
    "ZHIMADI_CAPTCHA_SENT",
    "ZHIMADI_REPAIR_DEFERRED",
  ]) {
    assert.equal(isZhimadiRepairDeferredError({ code }), true);
  }
  assert.equal(isZhimadiRepairDeferredError({ code: "FATAL" }), false);
  assert.equal(isZhimadiRepairDeferredError(new TypeError("broken")), false);
});

test("a fatal repair alert claimed by the listener is not duplicated by the direct report", () => {
  assert.equal(isZhimadiRepairAlertOwnedError({
    code: "ZHIMADI_REPAIR_FATAL_ALERTED",
  }), true);
  assert.equal(isZhimadiRepairDeferredError({
    code: "ZHIMADI_REPAIR_FATAL_ALERTED",
  }), false);
  assert.equal(isZhimadiRepairAlertOwnedError(new TypeError("broken")), false);
});

test("a direct requester cannot bypass an existing scheduled report resume", () => {
  assert.equal(repairCanResumeInProcess({
    reportResumeMode: "scheduled",
  }, "direct"), false);
  assert.equal(repairCanResumeInProcess({
    reportResumeMode: "scheduled",
  }, "scheduled"), true);
});
