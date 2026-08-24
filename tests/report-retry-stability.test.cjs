const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  reportBudgetMs,
  retryBackoffFor,
  retryBackoffsMs,
  retryStep,
} = require("../scripts/daily-report.cjs");
const { pruneDebugArtifacts } = require("../scripts/debug-artifacts.cjs");
const {
  isDouyinPageLoadError,
  navigationTimeoutMs,
  pageReadyTimeoutMs,
  reloadCutoffMs,
  shouldReloadDouyinPage,
  tableTimeoutMs,
} = require("../scripts/read-current-douyin-browser.cjs");

const unlimited = {
  deadlineAt: Number.MAX_SAFE_INTEGER,
  now: () => 0,
};

test("spaces retries with a widening backoff instead of a flat five seconds", async () => {
  const slept = [];
  let calls = 0;

  await assert.rejects(
    () => retryStep("抖音报表", () => {
      calls += 1;
      throw new Error("Timeout 60000ms exceeded");
    }, 3, {
      ...unlimited,
      backoffs: [5000, 30000, 120000],
      sleep: async (ms) => { slept.push(ms); },
    }),
    /抖音报表连续 3 次失败：Timeout 60000ms exceeded/,
  );

  assert.equal(calls, 3);
  assert.deepEqual(slept, [5000, 30000]);
});

test("stops retrying rather than sleeping past the report budget", async () => {
  const slept = [];
  let calls = 0;

  await assert.rejects(
    () => retryStep("芝麻地报表", () => {
      calls += 1;
      throw new Error("芝麻地销售汇总加载超时");
    }, 3, {
      backoffs: [5000, 30000, 120000],
      deadlineAt: 4000,
      now: () => 0,
      sleep: async (ms) => { slept.push(ms); },
    }),
    /芝麻地报表连续 1 次失败：芝麻地销售汇总加载超时/,
  );

  assert.equal(calls, 1);
  assert.deepEqual(slept, []);
});

test("a login failure still skips the remaining retries", async () => {
  const slept = [];
  let calls = 0;

  await assert.rejects(
    () => retryStep("抖音报表", () => {
      calls += 1;
      throw new Error("抖音来客登录态失效，需要运行 pnpm douyin:login 完成短信验证码登录");
    }, 3, {
      ...unlimited,
      sleep: async (ms) => { slept.push(ms); },
    }),
    /抖音来客登录态失效/,
  );

  assert.equal(calls, 1);
  assert.deepEqual(slept, []);
});

test("reads the retry backoff and total budget from the environment", () => {
  assert.deepEqual(retryBackoffsMs({}), [5000, 30000, 120000]);
  assert.deepEqual(
    retryBackoffsMs({ REPORT_RETRY_BACKOFF_MS: "1000, 2000" }),
    [1000, 2000],
  );
  assert.deepEqual(
    retryBackoffsMs({ REPORT_RETRY_BACKOFF_MS: "不是数字" }),
    [5000, 30000, 120000],
  );

  const backoffs = retryBackoffsMs({});
  assert.equal(retryBackoffFor(1, backoffs), 5000);
  assert.equal(retryBackoffFor(2, backoffs), 30000);
  assert.equal(retryBackoffFor(9, backoffs), 120000);

  assert.equal(reportBudgetMs({}), 13 * 60 * 1000);
  assert.equal(reportBudgetMs({ REPORT_TOTAL_BUDGET_MS: "60000" }), 60000);
  assert.equal(reportBudgetMs({ REPORT_TOTAL_BUDGET_MS: "-1" }), 13 * 60 * 1000);
});

test("treats only douyin page load timeouts as worth a full page reload", () => {
  assert.equal(
    isDouyinPageLoadError(new Error("抖音账单统计主界面加载超时：空白页")),
    true,
  );
  assert.equal(
    isDouyinPageLoadError(new Error("抖音门店汇总加载超时：空白页")),
    true,
  );
  assert.equal(
    isDouyinPageLoadError(
      new Error("抖音来客登录态失效，需要运行 pnpm douyin:login 完成短信验证码登录"),
    ),
    false,
  );
  assert.equal(
    isDouyinPageLoadError(new Error("芝麻地主界面加载超时：空白页")),
    false,
  );
});

test("keeps douyin waits configurable and aligned with the Zhimadi readiness budget", () => {
  const saved = process.env.DOUYIN_PAGE_READY_TIMEOUT_MS;
  delete process.env.DOUYIN_PAGE_READY_TIMEOUT_MS;

  assert.equal(pageReadyTimeoutMs(), 90000);
  assert.equal(navigationTimeoutMs(), 60000);
  assert.equal(tableTimeoutMs(), 60000);

  process.env.DOUYIN_PAGE_READY_TIMEOUT_MS = "120000";
  assert.equal(pageReadyTimeoutMs(), 120000);

  if (saved === undefined) delete process.env.DOUYIN_PAGE_READY_TIMEOUT_MS;
  else process.env.DOUYIN_PAGE_READY_TIMEOUT_MS = saved;
});

test("skips the extra reload once one douyin read has spent its budget", () => {
  const loadTimeout = new Error("抖音账单统计主界面加载超时：空白页");
  const cutoffMs = 5 * 60 * 1000;

  assert.equal(shouldReloadDouyinPage(loadTimeout, 1000, { cutoffMs }), true);
  // 第一遍已经烧掉预算：再刷新一次会让本次读取翻倍，可能撞上父进程 watchdog。
  assert.equal(shouldReloadDouyinPage(loadTimeout, cutoffMs, { cutoffMs }), false);
  assert.equal(
    shouldReloadDouyinPage(loadTimeout, cutoffMs + 1, { cutoffMs }),
    false,
  );
  assert.equal(
    shouldReloadDouyinPage(
      new Error("抖音来客登录态失效，需要运行 pnpm douyin:login 完成短信验证码登录"),
      1000,
      { cutoffMs },
    ),
    false,
  );
  assert.equal(shouldReloadDouyinPage(loadTimeout, Number.NaN, { cutoffMs }), false);
  assert.equal(reloadCutoffMs(), cutoffMs);
});

test("keeps the douyin navigation retry and half-loaded page reload", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../scripts/read-current-douyin-browser.cjs"),
    "utf8",
  );
  assert.match(source, /readDouyinBrowserOnce\(page, reportDate, options\)/);
  assert.match(source, /抖音页面半加载，执行浏览器整页刷新/);
  assert.match(source, /shouldReloadDouyinPage\(error, Date\.now\(\) - startedAt\)/);
  assert.match(source, /gotoWithRetry\(\n\s+page,/);
});

function makeOutputTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fruit-store-debug-"));
  const outputDir = path.join(root, "output");
  fs.mkdirSync(path.join(outputDir, "debug", "keep-me"), { recursive: true });
  fs.mkdirSync(path.join(outputDir, "browser-profile", "Default"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(outputDir, "report-history", "2026-08"), {
    recursive: true,
  });
  return { root, outputDir };
}

test("prunes aged debug artifacts and never touches the browser login state", () => {
  const { root, outputDir } = makeOutputTree();
  const debugDir = path.join(outputDir, "debug");
  const aged = new Date("2026-08-01T00:00:00.000Z");
  const now = new Date("2026-08-24T00:00:00.000Z").getTime();

  const agedShot = path.join(debugDir, "douyin-2026-08-01-1787000000000.png");
  const agedText = path.join(debugDir, "douyin-2026-08-01-1787000000000.txt");
  const freshShot = path.join(debugDir, "douyin-2026-08-24-1787484734748.png");
  // 登录态、当晚去重状态和历史归档都必须原样留下。
  const cookies = path.join(outputDir, "browser-profile", "Default", "Cookies");
  const scheduledState = path.join(outputDir, "scheduled-report-state.json");
  const archive = path.join(outputDir, "report-history", "2026-08", "manifest.json");

  for (const file of [agedShot, agedText, freshShot, cookies, scheduledState, archive]) {
    fs.writeFileSync(file, "content");
  }
  for (const file of [agedShot, agedText, cookies, scheduledState, archive]) {
    fs.utimesSync(file, aged, aged);
  }

  const result = pruneDebugArtifacts({
    outputDir,
    now,
    maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  });

  assert.equal(result.removed, 2);
  assert.equal(fs.existsSync(agedShot), false);
  assert.equal(fs.existsSync(agedText), false);
  assert.equal(fs.existsSync(freshShot), true);
  assert.equal(fs.existsSync(cookies), true);
  assert.equal(fs.existsSync(scheduledState), true);
  assert.equal(fs.existsSync(archive), true);
  assert.equal(fs.existsSync(path.join(outputDir, "browser-profile")), true);

  fs.rmSync(root, { recursive: true, force: true });
});

test("leaves directories and non-artifact files inside output/debug alone", () => {
  const { root, outputDir } = makeOutputTree();
  const debugDir = path.join(outputDir, "debug");
  const aged = new Date("2026-08-01T00:00:00.000Z");
  const now = new Date("2026-08-24T00:00:00.000Z").getTime();

  const nestedFile = path.join(debugDir, "keep-me", "old.png");
  const notes = path.join(debugDir, "notes.md");
  fs.writeFileSync(nestedFile, "content");
  fs.writeFileSync(notes, "content");
  fs.utimesSync(nestedFile, aged, aged);
  fs.utimesSync(notes, aged, aged);
  fs.utimesSync(path.join(debugDir, "keep-me"), aged, aged);

  const result = pruneDebugArtifacts({
    outputDir,
    now,
    maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  });

  assert.equal(result.removed, 0);
  assert.equal(fs.existsSync(nestedFile), true);
  assert.equal(fs.existsSync(notes), true);

  fs.rmSync(root, { recursive: true, force: true });
});

test("stays quiet when output/debug does not exist yet", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fruit-store-debug-"));
  const result = pruneDebugArtifacts({
    outputDir: path.join(root, "output"),
    now: Date.now(),
  });
  assert.deepEqual(result, { removed: 0, kept: 0 });
  fs.rmSync(root, { recursive: true, force: true });
});
