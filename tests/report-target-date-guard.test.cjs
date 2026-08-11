const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createReportTargetDateGuard,
  runGuardedAction,
  shouldGuardFormalReportTarget,
} = require("../scripts/report-target-date.cjs");
const {
  createDualReportDateGuard,
  runDualPreviewsWithDateGuard,
} = require("../scripts/send-dual-douyin-report.cjs");

test("a formal report crossing midnight is rejected before its send action", async () => {
  let currentDate = "2026-08-11";
  let fetched = 0;
  let sent = 0;
  const guard = createReportTargetDateGuard("2026-08-11", {
    currentDate: () => currentDate,
  });

  await runGuardedAction(guard, "抓取前", async () => {
    fetched += 1;
  });
  currentDate = "2026-08-12";

  await assert.rejects(
    runGuardedAction(guard, "正式发送前", async () => {
      sent += 1;
    }),
    (error) => (
      error.code === "REPORT_TARGET_DATE_ROLLOVER"
      && error.reportDate === "2026-08-11"
      && error.currentDate === "2026-08-12"
      && error.stage === "正式发送前"
    ),
  );
  assert.equal(fetched, 1);
  assert.equal(sent, 0);
});

test("a dual report rechecks its date after both previews", async () => {
  let currentDate = "2026-08-11";
  const previews = [];
  const guard = createReportTargetDateGuard("2026-08-11", {
    currentDate: () => currentDate,
    label: "正式双来源报表",
  });

  await assert.rejects(
    runDualPreviewsWithDateGuard(guard, async (source) => {
      previews.push(source);
      if (source === "browser") currentDate = "2026-08-12";
    }),
    (error) => (
      error.code === "REPORT_TARGET_DATE_ROLLOVER"
      && error.stage === "双来源预览后"
    ),
  );
  assert.deepEqual(previews, ["aggregate-api", "browser"]);
});

test("each dual formal send has an independent date check", async () => {
  let currentDate = "2026-08-11";
  const sent = [];
  const guard = createReportTargetDateGuard("2026-08-11", {
    currentDate: () => currentDate,
  });

  await runGuardedAction(guard, "聚合接口版正式发送前", async () => {
    sent.push("api");
  });
  currentDate = "2026-08-12";
  await assert.rejects(
    runGuardedAction(guard, "网页版正式发送前", async () => {
      sent.push("browser");
    }),
    (error) => (
      error.code === "REPORT_TARGET_DATE_ROLLOVER"
      && error.stage === "网页版正式发送前"
    ),
  );
  assert.deepEqual(sent, ["api"]);
});

test("manual and ordinary no-send reports do not enable the formal wrapper guard", () => {
  assert.equal(shouldGuardFormalReportTarget({}), false);
  assert.equal(shouldGuardFormalReportTarget({ NO_DINGTALK: "1" }), false);
  assert.equal(shouldGuardFormalReportTarget({
    REPORT_MANAGED_BY_SCHEDULED: "1",
  }), true);
  assert.equal(shouldGuardFormalReportTarget({
    REPORT_MANAGED_BY_LISTENER: "1",
  }), true);
  assert.equal(shouldGuardFormalReportTarget({
    NO_DINGTALK: "1",
    REPORT_FORMAL_WRAPPER: "1",
  }), true);
});

test("a listener target captured before midnight fails closed after rollover", async () => {
  let currentDate = "2026-08-11";
  const guard = createReportTargetDateGuard("2026-08-11", {
    currentDate: () => currentDate,
    label: "listener 正式报表",
  });

  await runGuardedAction(guard, "抓取前", async () => {});
  currentDate = "2026-08-12";
  await assert.rejects(
    runGuardedAction(guard, "报表产物写入前", async () => {}),
    (error) => (
      error.code === "REPORT_TARGET_DATE_ROLLOVER"
      && error.reportDate === "2026-08-11"
      && error.currentDate === "2026-08-12"
    ),
  );
});

test("a dual no-send wrapper still rejects an explicit historical target", () => {
  const guard = createDualReportDateGuard("2026-08-11", {
    previewOnly: true,
    currentDate: () => "2026-08-12",
  });
  assert.throws(
    () => guard("抓取前"),
    (error) => (
      error.code === "REPORT_TARGET_DATE_ROLLOVER"
      && error.stage === "抓取前"
    ),
  );
});
