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

  assert.match(markdown, /已完成 11\/24 天/);
  assert.doesNotMatch(markdown, /抖音本月到店核销券额/);
  assert.doesNotMatch(markdown, /扣手续费后销售额/);
});
