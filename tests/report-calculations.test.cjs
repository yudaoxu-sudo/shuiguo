const test = require("node:test");
const assert = require("node:assert/strict");

const {
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
