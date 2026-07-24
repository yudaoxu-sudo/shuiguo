const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildMarkdown,
  calculateOperatingTotals,
  buildStoreFinancialRows,
  storeKey,
} = require("../scripts/read-current-zhimadi.cjs");
const {
  buildLemengCollectionReport,
} = require("../scripts/read-current-lemeng.cjs");

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
          actual_received_cents: 150000,
          expected_received_cents: 50000,
          merchant_due_cents: 200000,
        }],
      },
    },
  );

  assert.match(markdown, /#### 抖音本月经营 2026-07/);
  assert.match(markdown, /线上营业额（抖音平台费已扣）：2,000\.00/);
  assert.match(markdown, /本月总营业额（线上\+线下）：12,000\.00/);
  assert.match(markdown, /本月扣费后营业额：11,970\.00/);
  assert.match(
    markdown,
    /\*\*1\. 有花头古城街店\*\*  \n线下营业额：10,000\.00  \n线上已到账：1,500\.00  \n线上预计到账：500\.00  \n线上营业额：2,000\.00  \n门店总营业额：12,000\.00/,
  );
  assert.match(markdown, /#### 其他进货（未匹配门店）\n\n\*\*张献铖\*\*：115\.46/);
  assert.doesNotMatch(markdown, /2\.5%|抖音券手续费|昨日经营|账单回补/);
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
    /实际到账总额与门店明细不一致/,
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
