const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildMarkdown,
  calculateSalesFees,
  buildStoreFinancialRows,
  storeKey,
} = require("../scripts/read-current-zhimadi.cjs");

test("splits coupon and non-coupon fees", () => {
  const result = calculateSalesFees(10000, 2000, {
    douyinFeeRate: 0.025,
    lemengFeeRate: 0.003,
  });

  assert.equal(result.nonCouponSales, 8000);
  assert.equal(result.douyinFee, 50);
  assert.equal(result.lemengFee, 24);
  assert.equal(result.totalFee, 74);
  assert.equal(result.netSales, 9926);
});

test("matches Douyin POI aliases to Lemeng stores", () => {
  assert.equal(storeKey("有花头(水木店)"), storeKey("水木花都店"));
  assert.equal(storeKey("有花头(长中店)"), storeKey("有花头金陵北路店"));
  assert.equal(storeKey("有花头(西门店)"), storeKey("有花头解放西路直营店"));

  const result = buildStoreFinancialRows(
    [{ store: "长中店", sales: 7000 }],
    [{ rank: 1, store: "有花头金陵北路店", sales: 10000, rate: "100%" }],
    [{
      store: "有花头(长中店)",
      verified_amount_cents: 200000,
    }],
  );

  assert.equal(result.rows[0].couponAmount, 2000);
  assert.equal(result.rows[0].nonCouponSales, 8000);
  assert.equal(result.rows[0].purchase, 7000);
  assert.equal(result.rows[0].profit, 2926);
  assert.deepEqual(result.unmatchedDouyinStores, []);
  assert.deepEqual(result.unmatchedPurchaseRows, []);
});

test("keeps unmatched purchases visible for reconciliation", () => {
  const result = buildStoreFinancialRows(
    [
      { store: "有花头古城街店", sales: 7000 },
      { store: "张献铖", sales: 115.46 },
    ],
    [{ rank: 1, store: "有花头古城街店", sales: 10000, rate: "100%" }],
    [],
  );

  assert.deepEqual(result.unmatchedPurchaseRows, [{
    store: "张献铖",
    purchase: 115.46,
  }]);
});

test("does not calculate fees from an incomplete monthly cache", () => {
  const markdown = buildMarkdown(
    "2026-07-24",
    {
      totals: { sales: 7000 },
      rows: [{ store: "长中店", sales: 7000 }],
    },
    {
      monthly: { salesWithCoupon: 10000 },
      ranking: [{
        rank: 1,
        store: "有花头金陵北路店",
        sales: 10000,
        rate: "100.00%",
      }],
    },
    {
      report_date: "2026-07-23",
      orders: {
        submitted_order_count: 0,
        paid_order_count: 0,
        paid_coupon_count: 0,
        sales_amount_cents: 0,
      },
      verification: {
        verified_count: 0,
        verified_amount_cents: 0,
        verification_rate_percent: null,
      },
      settlement: { estimated_income_cents: 0 },
      live: {
        paid_order_count: 0,
        paid_coupon_count: 0,
        sales_amount_cents: 0,
        ledger_deduplicated: true,
        verified_count: 0,
        verified_amount_cents: 0,
        estimated_income_cents: 0,
      },
      monthly: {
        report_month: "2026-07",
        complete: false,
        cached_day_count: 11,
        missing_dates: Array.from({ length: 13 }, (_, index) => `2026-07-${index + 11}`),
      },
    },
  );

  assert.match(markdown, /本月数据正在分批拉取：已完成 11\/24 天/);
  assert.match(markdown, /数据拉取进度：11\/24 天；完整前不展示本月券额/);
  assert.doesNotMatch(markdown, /抖音本月到店核销券额/);
  assert.doesNotMatch(markdown, /扣手续费后销售额/);
});

test("renders complete store financials with forced mobile line breaks", () => {
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
      monthly: { salesWithCoupon: 10000 },
      ranking: [{
        rank: 1,
        store: "有花头古城街店",
        sales: 10000,
        rate: "100.00%",
      }],
    },
    {
      report_date: "2026-07-23",
      orders: {
        submitted_order_count: 0,
        paid_order_count: 0,
        paid_coupon_count: 0,
        sales_amount_cents: 0,
      },
      verification: {
        verified_count: 0,
        verified_amount_cents: 0,
        verification_rate_percent: null,
      },
      settlement: { estimated_income_cents: 0 },
      live: {
        paid_order_count: 0,
        paid_coupon_count: 0,
        sales_amount_cents: 0,
        ledger_deduplicated: true,
        verified_count: 0,
        verified_amount_cents: 0,
        estimated_income_cents: 0,
      },
      monthly: {
        report_month: "2026-07",
        complete: true,
        cached_day_count: 24,
        missing_dates: [],
        verification: {
          verified_count: 1,
          verified_amount_cents: 200000,
        },
        settlement: { estimated_income_cents: 195000 },
        stores: [{
          store: "有花头(古城街店)",
          verified_amount_cents: 200000,
        }],
      },
    },
  );

  assert.match(markdown, /\*\*1\. 有花头古城街店\*\*  \n含券销售：10,000\.00  \n抖音券：2,000\.00  \n不含券销售：8,000\.00/);
  assert.match(markdown, /#### 其他进货（未匹配门店）\n\n\*\*张献铖\*\*：115\.46/);
  assert.match(markdown, /券扣费后（按 2\.50%）：¥0\.00/);
});

test("hides non-deduplicated live verification cache", () => {
  const markdown = buildMarkdown(
    "2026-07-24",
    {
      totals: { sales: 7000 },
      rows: [{ store: "有花头古城街店", sales: 7000 }],
    },
    {
      monthly: { salesWithCoupon: 10000 },
      ranking: [{
        rank: 1,
        store: "有花头古城街店",
        sales: 10000,
        rate: "100.00%",
      }],
    },
    {
      report_date: "2026-07-23",
      orders: {
        submitted_order_count: 0,
        paid_order_count: 0,
        paid_coupon_count: 0,
        sales_amount_cents: 0,
      },
      verification: {
        verified_count: 0,
        verified_amount_cents: 0,
        verification_rate_percent: null,
      },
      settlement: { estimated_income_cents: 0 },
      live: {
        paid_order_count: 1,
        paid_coupon_count: 2,
        sales_amount_cents: 1200,
        verified_count: 2,
        verified_amount_cents: 1200,
        estimated_income_cents: 1000,
      },
    },
  );

  assert.match(markdown, /直播核销：本次旧缓存未按券去重，暂不展示/);
  assert.doesNotMatch(markdown, /核销券额：¥12\.00/);
});

test("rejects totals that do not reconcile with detail rows", () => {
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
