const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildMarkdown,
  calculateOperatingTotals,
  buildStoreFinancialRows,
  storeKey,
} = require("../scripts/read-current-zhimadi.cjs");
const {
  buildLemengCollectionReport,
} = require("../scripts/read-current-lemeng.cjs");
const {
  assertCompleteTablePage,
  buildDouyinBrowserSummary,
} = require("../scripts/read-current-douyin-browser.cjs");
const {
  buildAggregateUrls,
  buildDouyinAggregateApiSummary,
} = require("../scripts/read-current-douyin-aggregate-api.cjs");
const {
  reconcileDouyinStoreRows,
} = require("../scripts/douyin-store-reconciliation.cjs");
const {
  compareDouyinSources,
  comparisonText,
  recordDualReportArtifactState,
} = require("../scripts/send-dual-douyin-report.cjs");

test("uses Douyin received amounts directly and charges only Lemeng 0.3%", () => {
  const result = calculateOperatingTotals(10000, 1500, 500, 7000, {
    lemengFeeRate: 0.003,
  });

  assert.equal(result.douyinTotal, 2000);
  assert.equal(result.businessRevenue, 12000);
  assert.equal(result.lemengFee, 30);
  assert.equal(result.netRevenue, 11970);
  assert.equal(result.profit, 4970);
});

test("reads the exact Lemeng non-coupon collection total and sorts stores", () => {
  const rows = [
    ["有花头华府锦苑店", "88,182.09"],
    ["有花头解放西路店", "119,867.63"],
    ["有花头天逸湾直营店", "143,575.85"],
    ["有花头金陵北路店", "182,076.98"],
    ["有花头通宝城店", "260,295.74"],
    ["水木花都店", "316,255.21"],
    ["有花头白溪店", "319,234.51"],
    ["有花头古城街店", "345,977.15"],
  ].map(([store, sales]) => ({ store, sales }));

  const report = buildLemengCollectionReport(rows, "1,775,465.16");

  assert.equal(report.monthly.salesWithoutCoupon, 1775465.16);
  assert.equal(report.ranking[0].store, "有花头古城街店");
  assert.equal(report.ranking[0].sales, 345977.15);
});

test("matches Douyin POI aliases to Lemeng stores", () => {
  assert.equal(storeKey("有花头(水木店)"), storeKey("水木花都店"));
  assert.equal(storeKey("有花头(长中店)"), storeKey("有花头金陵北路店"));
  assert.equal(storeKey("有花头(西门店)"), storeKey("有花头解放西路直营店"));

  const result = buildStoreFinancialRows(
    [{ store: "长中店", sales: 7000 }],
    [{ store: "有花头金陵北路店", sales: 10000 }],
    [{
      store: "有花头(长中店)",
      actual_received_cents: 150000,
      expected_received_cents: 50000,
    }],
  );

  assert.equal(result.rows[0].douyinActualReceived, 1500);
  assert.equal(result.rows[0].douyinExpectedReceived, 500);
  assert.equal(result.rows[0].businessRevenue, 12000);
  assert.equal(result.rows[0].purchase, 7000);
  assert.equal(result.rows[0].profit, 4970);
  assert.deepEqual(result.unmatchedDouyinStores, []);
});

test("sorts store financial rows by profit from highest to lowest", () => {
  const result = buildStoreFinancialRows(
    [
      { store: "有花头古城街店", sales: 9000 },
      { store: "有花头白溪店", sales: 3000 },
    ],
    [
      { store: "有花头古城街店", sales: 10000 },
      { store: "有花头白溪店", sales: 8000 },
    ],
  );

  assert.equal(result.rows[0].store, "有花头白溪店");
  assert.equal(result.rows[0].rank, 1);
  assert.equal(result.rows[0].profit, 4976);
  assert.equal(result.rows[1].store, "有花头古城街店");
  assert.equal(result.rows[1].profit, 970);
});

test("builds monthly Douyin totals from the finance summary without ledger pagination", () => {
  const result = buildDouyinBrowserSummary({
    reportDate: "2026-07-24",
    merchantDue: "219,891.94",
    dateRows: [
      { date: "2026-07-24", status: "待结算", merchantDue: "10,008.88" },
      { date: "2026-07-23", status: "待结算", merchantDue: "7,541.35" },
      { date: "2026-07-22", status: "待结算", merchantDue: "6,466.17" },
      { date: "2026-07-21", status: "待结算", merchantDue: "5,207.02" },
      { date: "2026-07-20", status: "待结算", merchantDue: "6,405.45" },
      { date: "2026-07-19", status: "已结算", merchantDue: "9,000.00" },
    ],
    storeRows: [
      { store: "有花头(华府锦苑店)", merchantDue: "20,104.82" },
      { store: "有花头(白溪店)", merchantDue: "22,996.63" },
      { store: "有花头(水木店)", merchantDue: "25,452.72" },
      { store: "有花头(长中店)", merchantDue: "18,808.51" },
      { store: "有花头(西门店)", merchantDue: "19,647.40" },
      { store: "有花头(通宝城店)", merchantDue: "45,464.46" },
      { store: "有花头(古城街店)", merchantDue: "41,386.18" },
      { store: "有花头(天逸湾店)", merchantDue: "26,011.83" },
    ],
  });

  assert.equal(result.monthly.settlement.expected_received_cents, 3562887);
  assert.equal(result.monthly.settlement.actual_received_cents, 18426307);
  assert.equal(result.monthly.settlement.merchant_due_cents, 21989194);
  assert.deepEqual(result.monthly.stores.at(-1), {
    store: "未归属门店",
    merchant_due_cents: 1939,
  });
});

test("requires affirmative evidence that the webpage store table is fully read", () => {
  assert.doesNotThrow(() => assertCompleteTablePage({
    rowCount: 8,
    paginationDetected: true,
    totalCount: 8,
    currentPage: 1,
    pageCount: 1,
    hasEnabledNext: false,
  }, "抖音门店汇总"));

  assert.doesNotThrow(() => assertCompleteTablePage({
    rowCount: 8,
    paginationDetected: true,
    currentPage: 1,
    pageCount: 1,
    hasEnabledNext: false,
  }, "抖音门店汇总"));

  assert.throws(
    () => assertCompleteTablePage({
      rowCount: 8,
      paginationDetected: false,
    }, "抖音门店汇总"),
    /没有读取到分页完整性信息/,
  );
  assert.throws(
    () => assertCompleteTablePage({
      rowCount: 8,
      paginationDetected: true,
      totalCount: 9,
      currentPage: 1,
      pageCount: 1,
      hasEnabledNext: false,
    }, "抖音门店汇总"),
    /存在未读取分页/,
  );
  assert.throws(
    () => assertCompleteTablePage({
      rowCount: 8,
      paginationDetected: true,
      totalCount: 7,
      currentPage: 1,
      pageCount: 1,
      hasEnabledNext: false,
    }, "抖音门店汇总"),
    /存在未读取分页/,
  );
  assert.throws(
    () => assertCompleteTablePage({
      rowCount: 8,
      paginationDetected: true,
      currentPage: 1,
      pageCount: 2,
      hasEnabledNext: true,
    }, "抖音门店汇总"),
    /存在未读取分页/,
  );
  assert.throws(
    () => assertCompleteTablePage({
      rowCount: 8,
      paginationDetected: true,
    }, "抖音门店汇总"),
    /分页完整性信息不充分/,
  );
});

test("keeps the production Byted pager selectors and disabled-next fallback", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../scripts/read-current-douyin-browser.cjs"),
    "utf8",
  );
  assert.match(source, /\[class\*="pager"\]/);
  assert.match(source, /\[class\*="pager-item-checked"\]/);
  assert.match(source, /paginationControlsRoot/);
  assert.match(source, /navigationItems\[navigationItems\.length - 1\]/);
});

test("reconciles only a bounded negative Douyin store residual", () => {
  const oneCentOver = reconcileDouyinStoreRows(
    [{ store: "古城街店", merchant_due_cents: 10001 }],
    10000,
  );
  assert.equal(oneCentOver.stores.at(-1).merchant_due_cents, -1);
  const oneCentUnder = reconcileDouyinStoreRows(
    [{ store: "古城街店", merchant_due_cents: 9999 }],
    10000,
  );
  assert.equal(oneCentUnder.stores.at(-1).merchant_due_cents, 1);

  const accepted = reconcileDouyinStoreRows(
    [{ store: "古城街店", merchant_due_cents: 10050000 }],
    10000000,
    { allowSyncAdjustment: true },
  );
  assert.deepEqual(accepted.stores.at(-1), {
    store: "平台同步差额",
    merchant_due_cents: -50000,
    kind: "platform_sync_adjustment",
  });
  assert.equal(
    accepted.stores.reduce((sum, row) => sum + row.merchant_due_cents, 0),
    10000000,
  );

  assert.throws(() => reconcileDouyinStoreRows(
    [{ store: "古城街店", merchant_due_cents: 20050001 }],
    20000000,
    { allowSyncAdjustment: true },
  ), /超过本月总额/);
  assert.throws(() => reconcileDouyinStoreRows(
    [{ store: "古城街店", merchant_due_cents: 1005001 }],
    1000000,
    { allowSyncAdjustment: true },
  ), /超过本月总额/);
  assert.throws(() => reconcileDouyinStoreRows(
    [{ store: "古城街店", merchant_due_cents: 2 }],
    0,
    { allowSyncAdjustment: true },
  ), /超过本月总额/);
});

test("browser and aggregate builders use sync adjustment only when allowed", () => {
  const browserInput = {
    reportDate: "2026-08-07",
    merchantDue: "1,000.00",
    dateRows: [{ date: "2026-08-07", status: "待结算", merchantDue: "100.00" }],
    storeRows: [{ store: "古城街店", merchantDue: "1,004.00" }],
  };
  assert.throws(() => buildDouyinBrowserSummary(browserInput), /超过本月总额/);
  const browser = buildDouyinBrowserSummary({
    ...browserInput,
    allowSyncAdjustment: true,
  });
  assert.equal(browser.monthly.store_sync_adjustment_cents, -400);

  const aggregateInput = {
    reportDate: "2026-08-07",
    datePayload: {
      status_code: 0,
      data: { bill_date_statistics_list: [{ income: 100000, settled_income: 90000 }] },
    },
    storePayload: {
      status_code: 0,
      data: {
        bill_statistics_list: [{ classify_name: "古城街店", income: 100400 }],
        page_info: { total_count: 1, page_count: 1 },
      },
    },
  };
  assert.throws(() => buildDouyinAggregateApiSummary(aggregateInput), /超过本月总额/);
  const aggregate = buildDouyinAggregateApiSummary({
    ...aggregateInput,
    allowSyncAdjustment: true,
  });
  assert.equal(aggregate.monthly.store_sync_adjustment_cents, -400);
});

test("documents the bounded Douyin store sync adjustment", () => {
  const decision = fs.readFileSync(
    path.resolve(__dirname, "../docs/douyin-source-decision-2026-07.md"),
    "utf8",
  );
  assert.match(decision, /同时不超过 500 元和总额 0\.5%/);
  assert.match(decision, /负向"平台同步差额"/);
  assert.match(decision, /provisional，不计入双来源严格一致观察日/);

  const dailyReport = fs.readFileSync(
    path.resolve(__dirname, "../scripts/daily-report.cjs"),
    "utf8",
  );
  assert.match(dailyReport, /allowSyncAdjustment:\s*attempt === totalAttempts/);
});

test("builds monthly Douyin totals with two aggregate API responses", () => {
  const result = buildDouyinAggregateApiSummary({
    reportDate: "2026-07-24",
    datePayload: {
      status_code: 0,
      data: {
        bill_date_statistics_list: [{
          income: 22712482,
          settled_income: 18426307,
        }],
      },
    },
    storePayload: {
      status_code: 0,
      data: {
        bill_statistics_list: [
          { classify_name: "有花头(古城街店)", income: 12000000 },
          { classify_name: "有花头(水木店)", income: 10708448 },
        ],
        page_info: { total_count: 2, page_count: 1 },
      },
    },
  });

  assert.deepEqual(result.monthly.settlement, {
    actual_received_cents: 18426307,
    expected_received_cents: 4286175,
    merchant_due_cents: 22712482,
  });
  assert.deepEqual(result.monthly.stores.at(-1), {
    store: "未归属门店",
    merchant_due_cents: 4034,
  });
  assert.equal(result.monthly.source, "douyin_life_finance_aggregate_api");
});

test("rejects an incomplete aggregate API store page", () => {
  assert.throws(
    () => buildDouyinAggregateApiSummary({
      reportDate: "2026-07-24",
      datePayload: {
        status_code: 0,
        data: {
          bill_date_statistics_list: [{
            income: 10000,
            settled_income: 8000,
          }],
        },
      },
      storePayload: {
        status_code: 0,
        data: {
          bill_statistics_list: [
            { classify_name: "有花头(古城街店)", income: 10000 },
          ],
          page_info: { total_count: 51, page_count: 2 },
        },
      },
    }),
    /存在未读取分页/,
  );
});

test("builds aggregate URLs for one month without a detail-ledger request", () => {
  const { dateUrl, storeUrl } = buildAggregateUrls(
    "https://life.douyin.com/life/settle/v1/bill/query_date_statistics/?account_id_list=abc&page=2&size=10",
    "2026-07-24",
  );
  const date = new URL(dateUrl);
  const store = new URL(storeUrl);

  assert.equal(date.pathname, "/life/settle/v1/bill/query_date_statistics/");
  assert.equal(date.searchParams.get("start_date"), "2026-07-01");
  assert.equal(date.searchParams.get("end_date"), "2026-07-24");
  assert.equal(store.pathname, "/life/settle/v1/bill/query_statistics/");
  assert.equal(store.searchParams.get("statistics_type"), "1");
  assert.equal(store.searchParams.get("size"), "50");
  assert.doesNotMatch(dateUrl + storeUrl, /composite_query|ledger/);
});

test("compares the aggregate API and webpage Douyin summaries", () => {
  const apiReport = {
    monthly: {
      complete: true,
      generated_at: "2026-07-24T11:00:00.000Z",
      settlement: {
        actual_received_cents: 8000,
        expected_received_cents: 2000,
        merchant_due_cents: 10000,
      },
      stores: [{ store: "古城街店", merchant_due_cents: 10000 }],
    },
  };
  const browserReport = structuredClone(apiReport);
  const exact = compareDouyinSources(apiReport, browserReport);
  assert.equal(exact.exact, true);
  assert.match(comparisonText(exact), /全部一致/);

  browserReport.monthly.settlement.expected_received_cents = 1999;
  browserReport.monthly.settlement.merchant_due_cents = 9999;
  browserReport.monthly.stores[0].merchant_due_cents = 9999;
  browserReport.monthly.generated_at = "2026-07-24T11:00:19.000Z";
  const different = compareDouyinSources(apiReport, browserReport);
  assert.equal(different.exact, false);
  assert.equal(different.total_difference_cents, 1);
  assert.equal(different.store_differences.length, 1);
  assert.equal(different.read_gap_seconds, 19);
  assert.match(comparisonText(different), /相隔 19 秒/);

  const adjustedApi = structuredClone(apiReport);
  const adjustedBrowser = structuredClone(apiReport);
  adjustedApi.monthly.store_sync_adjustment_cents = -100;
  adjustedBrowser.monthly.store_sync_adjustment_cents = -100;
  const provisional = compareDouyinSources(adjustedApi, adjustedBrowser);
  assert.equal(provisional.exact, false);
  assert.equal(provisional.provisional, true);
  assert.match(comparisonText(provisional), /不计严格一致/);
});

test("no-send dual preview refreshes artifact evidence without rewriting send proof", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fruit-dual-state-"));
  const stateFile = path.join(tempDir, "douyin-dual-report-state.json");
  const previous = {
    date: "2026-07-25",
    comparison: { exact: false },
    api: {
      sentAt: "2026-07-25T01:00:00.000Z",
      sha256: "sent-api-hash",
    },
    browser: {
      sentAt: "2026-07-25T01:00:01.000Z",
      sha256: "sent-browser-hash",
    },
  };
  const comparison = {
    exact: true,
    actual_difference_cents: 0,
    expected_difference_cents: 0,
    total_difference_cents: 0,
    store_differences: [],
    read_gap_seconds: 23,
  };
  const apiMarkdown = "current api report";
  const browserMarkdown = "current browser report";

  try {
    const state = recordDualReportArtifactState({
      previous,
      date: "2026-07-29",
      comparison,
      apiMarkdown,
      browserMarkdown,
      previewOnly: true,
      recordedAt: new Date("2026-07-29T04:21:24.000Z"),
      filePath: stateFile,
    });
    const persisted = JSON.parse(fs.readFileSync(stateFile, "utf8"));

    assert.deepEqual(persisted, state);
    assert.equal(state.date, "2026-07-29");
    assert.deepEqual(state.comparison, comparison);
    assert.equal(state.artifacts.mode, "preview");
    assert.equal(state.artifacts.recordedAt, "2026-07-29T04:21:24.000Z");
    assert.equal(
      state.artifacts.api.sha256,
      crypto.createHash("sha256").update(apiMarkdown).digest("hex"),
    );
    assert.equal(
      state.artifacts.browser.sha256,
      crypto.createHash("sha256").update(browserMarkdown).digest("hex"),
    );
    assert.equal(state.api, undefined);
    assert.equal(state.browser, undefined);

    const sentProof = {
      ...state,
      api: previous.api,
      browser: previous.browser,
    };
    const refreshed = recordDualReportArtifactState({
      previous: sentProof,
      date: "2026-07-29",
      comparison,
      apiMarkdown: `${apiMarkdown} refreshed`,
      browserMarkdown: `${browserMarkdown} refreshed`,
      previewOnly: true,
      recordedAt: new Date("2026-07-29T05:21:24.000Z"),
      filePath: stateFile,
    });
    assert.deepEqual(refreshed.api, sentProof.api);
    assert.deepEqual(refreshed.browser, sentProof.browser);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("withholds combined revenue and profit when the Douyin month is incomplete", () => {
  const markdown = buildMarkdown(
    "2026-07-24",
    {
      totals: { sales: 7000 },
      rows: [{ store: "长中店", sales: 7000 }],
    },
    {
      monthly: { salesWithoutCoupon: 10000 },
      ranking: [{
        rank: 1,
        store: "有花头金陵北路店",
        sales: 10000,
        rate: "100.00%",
      }],
    },
    {
      monthly: {
        report_month: "2026-07",
        complete: false,
        cached_day_count: 11,
        missing_dates: Array.from(
          { length: 13 },
          (_, index) => `2026-07-${index + 12}`,
        ),
      },
    },
  );

  assert.match(markdown, /抖音本月数据不完整：已获取 11\/24 天/);
  assert.match(markdown, /综合营业额和毛利暂不计算/);
  assert.doesNotMatch(markdown, /本月扣费后营业额/);
  assert.doesNotMatch(markdown, /账单回补|昨日经营/);
});

test("keeps the monthly report usable when the Douyin summary page fails", () => {
  const markdown = buildMarkdown(
    "2026-07-24",
    {
      totals: { sales: 7000 },
      rows: [{ store: "长中店", sales: 7000 }],
    },
    {
      monthly: { salesWithoutCoupon: 10000 },
      ranking: [{
        rank: 1,
        store: "有花头金陵北路店",
        sales: 10000,
        rate: "100.00%",
      }],
    },
    {
      monthly: {
        report_month: "2026-07",
        complete: false,
        source_error: "抖音来客登录态失效",
        cached_day_count: 0,
        missing_dates: [],
      },
    },
  );

  assert.match(markdown, /抖音本月汇总暂不可用：抖音来客登录态失效/);
  assert.match(markdown, /线上营业额和综合毛利暂不计算/);
  assert.match(markdown, /乐檬门店营业额（不含券）/);
  assert.doesNotMatch(markdown, /0\/0 天/);
});

test("renders one metric per mobile line with the unified monthly formula", () => {
  const markdown = buildMarkdown(
    "2026-07-24",
    {
      totals: { sales: 7115.46 },
      rows: [
        { store: "有花头古城街店", sales: 7000 },
        { store: "张献铖", sales: 115.46 },
      ],
    },
    {
      monthly: { salesWithoutCoupon: 10000 },
      ranking: [{
        rank: 1,
        store: "有花头古城街店",
        sales: 10000,
        rate: "100.00%",
      }],
    },
    {
      monthly: {
        report_month: "2026-07",
        complete: true,
        cached_day_count: 24,
        missing_dates: [],
        settlement: {
          actual_received_cents: 150000,
          expected_received_cents: 50000,
          merchant_due_cents: 200000,
        },
        stores: [{
          store: "有花头(古城街店)",
          merchant_due_cents: 200000,
        }],
      },
    },
  );

  assert.match(markdown, /#### 抖音本月经营 2026-07/);
  assert.match(markdown, /#### 门店营业与毛利（按本月毛利金额排名）/);
  assert.match(markdown, /线上营业额（抖音平台费已扣）：2,000\.00/);
  assert.match(markdown, /本月总营业额（线上\+线下）：12,000\.00/);
  assert.match(markdown, /本月扣费后营业额：11,970\.00/);
  assert.match(
    markdown,
    /\*\*1\. 有花头古城街店\*\*  \n线下营业额：10,000\.00  \n线上营业额：2,000\.00  \n门店总营业额：12,000\.00/,
  );
  assert.match(markdown, /#### 其他进货（未匹配门店）\n\n\*\*张献铖\*\*：115\.46/);
  assert.doesNotMatch(markdown, /2\.5%|抖音券手续费|昨日经营|账单回补/);
});

test("renders a visible warning for a Douyin platform sync adjustment", () => {
  const markdown = buildMarkdown(
    "2026-08-07",
    {
      totals: { sales: 7000 },
      rows: [{ store: "有花头古城街店", sales: 7000 }],
    },
    {
      monthly: { salesWithoutCoupon: 10000 },
      ranking: [{
        rank: 1,
        store: "有花头古城街店",
        sales: 10000,
        rate: "100.00%",
      }],
    },
    {
      monthly: {
        report_month: "2026-08",
        complete: true,
        cached_day_count: 7,
        missing_dates: [],
        store_sync_adjustment_cents: -400,
        settlement: {
          actual_received_cents: 90000,
          expected_received_cents: 10000,
          merchant_due_cents: 100000,
        },
        stores: [
          { store: "有花头(古城街店)", merchant_due_cents: 100400 },
          {
            store: "平台同步差额",
            merchant_due_cents: -400,
            kind: "platform_sync_adjustment",
          },
        ],
      },
    },
  );

  assert.match(markdown, /门店分项暂未同步/);
  assert.match(markdown, /同步差额 -4\.00/);
  assert.match(markdown, /未匹配抖音门店[\s\S]*平台同步差额[\s\S]*-4\.00/);
});

test("rejects Douyin totals that do not reconcile with store details", () => {
  assert.throws(
    () => buildMarkdown(
      "2026-07-24",
      {
        totals: { sales: 7000 },
        rows: [{ store: "有花头古城街店", sales: 7000 }],
      },
      {
        monthly: { salesWithoutCoupon: 10000 },
        ranking: [{
          rank: 1,
          store: "有花头古城街店",
          sales: 10000,
          rate: "100.00%",
        }],
      },
      {
        monthly: {
          report_month: "2026-07",
          complete: true,
          settlement: {
            actual_received_cents: 100,
            expected_received_cents: 0,
            merchant_due_cents: 100,
          },
          stores: [{
            store: "有花头(古城街店)",
            actual_received_cents: 99,
            expected_received_cents: 0,
          }],
        },
      },
    ),
    /到账总额与门店汇总不一致/,
  );
});

test("rejects source totals that do not reconcile with detail rows", () => {
  assert.throws(
    () => buildMarkdown(
      "2026-07-24",
      {
        totals: { sales: 100 },
        rows: [{ store: "有花头古城街店", sales: 99 }],
      },
    ),
    /芝麻地进货汇总不一致/,
  );
});
