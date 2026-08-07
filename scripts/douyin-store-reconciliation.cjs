const MAX_SYNC_ADJUSTMENT_CENTS = 50000;
const SYNC_ADJUSTMENT_RATIO_DENOMINATOR = 200;

function reconcileDouyinStoreRows(
  sourceRows,
  merchantDueCents,
  { label = "抖音", allowSyncAdjustment = false } = {},
) {
  const stores = sourceRows.map((row) => ({ ...row }));
  const rawStoreTotalCents = stores.reduce(
    (sum, row) => sum + Number(row.merchant_due_cents || 0),
    0,
  );
  const residualCents = merchantDueCents - rawStoreTotalCents;

  if (residualCents < -1) {
    const excessCents = -residualCents;
    const withinAbsoluteLimit = excessCents <= MAX_SYNC_ADJUSTMENT_CENTS;
    const withinRelativeLimit = merchantDueCents > 0
      && excessCents * SYNC_ADJUSTMENT_RATIO_DENOMINATOR <= merchantDueCents;
    if (!allowSyncAdjustment || !withinAbsoluteLimit || !withinRelativeLimit) {
      throw new Error(
        `${label}门店汇总超过本月总额：门店 ${rawStoreTotalCents} 分，总额 ${merchantDueCents} 分`,
      );
    }
  }

  if (residualCents > 0) {
    stores.push({
      store: "未归属门店",
      merchant_due_cents: residualCents,
    });
  } else if (residualCents < 0) {
    stores.push({
      store: "平台同步差额",
      merchant_due_cents: residualCents,
      kind: "platform_sync_adjustment",
    });
  }

  return {
    stores,
    rawStoreTotalCents,
    syncAdjustmentCents: residualCents < 0 ? residualCents : 0,
  };
}

module.exports = {
  MAX_SYNC_ADJUSTMENT_CENTS,
  SYNC_ADJUSTMENT_RATIO_DENOMINATOR,
  reconcileDouyinStoreRows,
};
