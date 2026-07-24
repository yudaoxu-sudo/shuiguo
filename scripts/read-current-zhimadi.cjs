const fs = require("fs");
const path = require("path");

function parseZhimadiText(text) {
  const parts = text.split(/\n|\t/).map((value) => value.trim()).filter(Boolean);
  const titleIndex = parts.indexOf("销售汇总表(按客户)");
  const headerStart = parts.indexOf("客户分类", titleIndex + 1);
  const totalIndex = parts.indexOf("合计：");

  if (titleIndex === -1 || headerStart === -1 || totalIndex === -1) {
    throw new Error("没有找到芝麻地报表标题、表头或合计行");
  }

  const headers = parts.slice(headerStart, headerStart + 11);
  const data = parts.slice(headerStart + 11, totalIndex);
  const rows = [];

  for (let index = 0; index < data.length; index += headers.length) {
    const chunk = data.slice(index, index + headers.length);
    if (chunk.length !== headers.length) break;
    const row = Object.fromEntries(headers.map((header, i) => [header, chunk[i]]));
    rows.push({
      category: row["客户分类"],
      code: row["客户编号"],
      store: row["客户名称"],
      quantity: Number(row["数量"]),
      weight: Number(row["重量(斤)"]),
      orders: Number(row["笔数"]),
      discount: Number(row["抹零金额"]),
      sales: Number(row["销售金额"]),
      cost: Number(row["销售成本"]),
      profit: Number(row["销售利润"]),
      grossMargin: row["毛利率"],
    });
  }

  const totalValues = parts.slice(totalIndex + 1, totalIndex + 9);
  return {
    rows,
    totals: {
      quantity: Number(totalValues[0]),
      weight: Number(totalValues[1]),
      orders: Number(totalValues[2]),
      discount: Number(totalValues[3]),
      sales: Number(totalValues[4]),
      cost: Number(totalValues[5]),
      profit: Number(totalValues[6]),
      grossMargin: totalValues[7],
    },
  };
}

function formatMoney(value) {
  return Number(value).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatPercent(value) {
  return `${Number(value).toFixed(2)}%`;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function hardBreak(value) {
  return `${value}  `;
}

function assertMoneyTotal(label, total, rows, field) {
  const detailTotal = roundMoney(
    rows.reduce((sum, row) => sum + Number(row[field] || 0), 0),
  );
  if (Math.abs(roundMoney(total) - detailTotal) > 0.01) {
    throw new Error(
      `${label}汇总不一致：总额 ${formatMoney(total)}，明细合计 ${formatMoney(detailTotal)}`,
    );
  }
}

function calculateOperatingTotals(
  lemengSalesWithoutCoupon,
  douyinActualReceived,
  douyinExpectedReceived,
  purchaseAmount,
  options = {},
) {
  const lemengFeeRate = Number(
    options.lemengFeeRate ?? process.env.LEMENG_FEE_RATE ?? 0.003,
  );
  const lemengSales = roundMoney(lemengSalesWithoutCoupon || 0);
  const douyinActual = roundMoney(douyinActualReceived || 0);
  const douyinExpected = roundMoney(douyinExpectedReceived || 0);
  const purchase = roundMoney(purchaseAmount || 0);
  const douyinTotal = roundMoney(douyinActual + douyinExpected);
  const businessRevenue = roundMoney(lemengSales + douyinTotal);
  const lemengFee = roundMoney(lemengSales * lemengFeeRate);
  const netRevenue = roundMoney(businessRevenue - lemengFee);
  const profit = roundMoney(netRevenue - purchase);

  return {
    lemengSalesWithoutCoupon: lemengSales,
    douyinActualReceived: douyinActual,
    douyinExpectedReceived: douyinExpected,
    douyinTotal,
    businessRevenue,
    lemengFee,
    lemengFeeRate,
    netRevenue,
    purchase,
    profit,
    grossMargin: netRevenue === 0 ? 0 : profit / netRevenue * 100,
  };
}

function storeKey(store) {
  const value = String(store || "")
    .replace(/\s+/g, "")
    .replace(/[()（）]/g, "")
    .replace(/^有花头/, "")
    .replace(/直营/g, "")
    .replace(/店$/g, "");

  if (value.includes("华府")) return "华府";
  if (value.includes("西门") || value.includes("解放西路")) return "解放西路";
  if (value.includes("水木")) return "水木花都";
  if (value.includes("长中") || value.includes("金陵北路")) return "金陵北路";

  for (const key of ["天逸湾", "古城街", "通宝城", "白溪"]) {
    if (value.includes(key)) return key;
  }

  return value;
}

function looksLikeStore(store) {
  return /店|花都|湾|城|苑|路/.test(String(store || ""));
}

function buildStoreFinancialRows(purchaseRows, salesRows, douyinStores = []) {
  const purchaseByKey = new Map();
  for (const row of purchaseRows) {
    const key = storeKey(row.store);
    const current = purchaseByKey.get(key) || {
      store: row.store,
      purchase: 0,
    };
    current.purchase = roundMoney(current.purchase + Number(row.sales || 0));
    purchaseByKey.set(key, current);
  }

  const douyinByKey = new Map();
  for (const row of douyinStores) {
    const key = storeKey(row.store);
    const current = douyinByKey.get(key) || {
      store: row.store,
      actual: 0,
      expected: 0,
    };
    current.actual += Number(row.actual_received_cents || 0) / 100;
    current.expected += Number(row.expected_received_cents || 0) / 100;
    douyinByKey.set(key, current);
  }

  const usedDouyinKeys = new Set();
  const rows = salesRows.map((row) => {
    const key = storeKey(row.store);
    const douyin = douyinByKey.get(key);
    usedDouyinKeys.add(key);
    return {
      store: row.store,
      ...calculateOperatingTotals(
        row.sales,
        douyin?.actual || 0,
        douyin?.expected || 0,
        purchaseByKey.get(key)?.purchase || 0,
      ),
    };
  }).sort((a, b) => b.businessRevenue - a.businessRevenue);

  const revenueTotal = rows.reduce((sum, row) => sum + row.businessRevenue, 0);
  rows.forEach((row, index) => {
    row.rank = index + 1;
    row.rate = revenueTotal === 0
      ? "0.00%"
      : `${(row.businessRevenue / revenueTotal * 100).toFixed(2)}%`;
  });

  const unmatchedDouyinStores = [...douyinByKey.entries()]
    .filter(([key, row]) => (
      !usedDouyinKeys.has(key)
      && Math.abs(row.actual + row.expected) > 0.001
    ))
    .map(([, row]) => ({
      store: row.store,
      actual: roundMoney(row.actual),
      expected: roundMoney(row.expected),
      total: roundMoney(row.actual + row.expected),
    }))
    .sort((a, b) => b.total - a.total);

  const salesKeys = new Set(salesRows.map((row) => storeKey(row.store)));
  const unmatchedPurchaseRows = [...purchaseByKey.entries()]
    .filter(([key, row]) => !salesKeys.has(key) && row.purchase !== 0)
    .map(([, row]) => row)
    .sort((a, b) => b.purchase - a.purchase);

  return { rows, unmatchedDouyinStores, unmatchedPurchaseRows };
}

function assertDouyinMonthlyTotals(monthly) {
  const stores = monthly.stores || [];
  const actual = stores.reduce(
    (sum, row) => sum + Number(row.actual_received_cents || 0),
    0,
  );
  const expected = stores.reduce(
    (sum, row) => sum + Number(row.expected_received_cents || 0),
    0,
  );
  const settlement = monthly.settlement || {};
  if (actual !== Number(settlement.actual_received_cents || 0)) {
    throw new Error("抖音本月实际到账总额与门店明细不一致");
  }
  if (expected !== Number(settlement.expected_received_cents || 0)) {
    throw new Error("抖音本月预计到账总额与门店明细不一致");
  }
  if (
    actual + expected
    !== Number(settlement.merchant_due_cents || 0)
  ) {
    throw new Error("抖音本月到账合计与实际、预计到账不一致");
  }
}

function buildMarkdown(dateText, report, lemeng = null, douyin = null) {
  assertMoneyTotal("芝麻地进货", report.totals.sales, report.rows, "sales");
  if (lemeng) {
    assertMoneyTotal(
      "乐檬不含券营业额",
      lemeng.monthly.salesWithoutCoupon,
      lemeng.ranking,
      "sales",
    );
  }

  const monthly = douyin?.monthly;
  const douyinComplete = monthly?.complete === true;
  if (douyinComplete) assertDouyinMonthlyTotals(monthly);

  const lines = [
    `### 水果店月报 ${dateText}`,
    "",
    "#### 本月总览",
    hardBreak(
      `线下营业额（乐檬不含券）：${
        lemeng ? formatMoney(lemeng.monthly.salesWithoutCoupon) : "-"
      }`,
    ),
  ];

  if (lemeng && douyinComplete) {
    const settlement = monthly.settlement;
    const totals = calculateOperatingTotals(
      lemeng.monthly.salesWithoutCoupon,
      Number(settlement.actual_received_cents || 0) / 100,
      Number(settlement.expected_received_cents || 0) / 100,
      report.totals.sales,
    );
    lines.push(
      hardBreak(`线上已到账（抖音已结算）：${formatMoney(totals.douyinActualReceived)}`),
      hardBreak(`线上预计到账（抖音待结算）：${formatMoney(totals.douyinExpectedReceived)}`),
      hardBreak(`线上营业额（抖音平台费已扣）：${formatMoney(totals.douyinTotal)}`),
      hardBreak(`本月总营业额（线上+线下）：${formatMoney(totals.businessRevenue)}`),
      hardBreak(
        `线下手续费（乐檬 ${formatPercent(totals.lemengFeeRate * 100)}）：${
          formatMoney(totals.lemengFee)
        }`,
      ),
      hardBreak(`本月扣费后营业额：${formatMoney(totals.netRevenue)}`),
      hardBreak(`芝麻地进货额：${formatMoney(totals.purchase)}`),
      hardBreak(`本月毛利：${formatMoney(totals.profit)}`),
      hardBreak(`本月毛利率：${formatPercent(totals.grossMargin)}`),
    );
  } else {
    lines.push(hardBreak(`芝麻地进货额：${formatMoney(report.totals.sales)}`));
    if (monthly) {
      const completed = Number(monthly.cached_day_count || 0);
      const total = completed + (monthly.missing_dates || []).length;
      lines.push(
        hardBreak(`抖音本月数据不完整：已获取 ${completed}/${total} 天`),
        hardBreak("综合营业额和毛利暂不计算"),
      );
    } else {
      lines.push(hardBreak("抖音数据未启用，综合营业额和毛利暂不计算"));
    }
  }

  if (monthly) {
    lines.push("", `#### 抖音本月经营 ${monthly.report_month}`);
    if (douyinComplete) {
      const settlement = monthly.settlement;
      lines.push(
        hardBreak(
          `实际到账（已结算）：${
            formatMoney(Number(settlement.actual_received_cents || 0) / 100)
          }`,
        ),
        hardBreak(
          `商家预计到账（待结算）：${
            formatMoney(Number(settlement.expected_received_cents || 0) / 100)
          }`,
        ),
        hardBreak(
          `到账合计：${
            formatMoney(Number(settlement.merchant_due_cents || 0) / 100)
          }`,
        ),
        "抖音金额均为平台已扣点金额，不再重复扣费。",
      );
    } else {
      const completed = Number(monthly.cached_day_count || 0);
      const total = completed + (monthly.missing_dates || []).length;
      lines.push(`数据完整度：${completed}/${total} 天，完整前不参与经营计算。`);
    }
  }

  lines.push("", "#### 芝麻地门店进货额");
  const sortedPurchaseRows = [...report.rows].sort((a, b) => b.sales - a.sales);
  const purchaseRows = sortedPurchaseRows.filter((row) => looksLikeStore(row.store));
  const otherPurchaseRows = sortedPurchaseRows.filter((row) => !looksLikeStore(row.store));
  for (const [index, row] of purchaseRows.entries()) {
    lines.push("", `**${index + 1}. ${row.store}**：${formatMoney(row.sales)}`);
  }

  if (otherPurchaseRows.length > 0) {
    lines.push("", "#### 其他进货（未匹配门店）");
    for (const row of otherPurchaseRows) {
      lines.push("", `**${row.store}**：${formatMoney(row.sales)}`);
    }
  }

  if (!lemeng) return lines.join("\n");

  if (!douyinComplete) {
    lines.push("", "#### 乐檬门店营业额（不含券）");
    for (const row of lemeng.ranking) {
      lines.push(
        "",
        hardBreak(`**${row.rank}. ${row.store}**`),
        hardBreak(`营业额：${formatMoney(row.sales)}`),
        `占比：${row.rate}`,
      );
    }
    return lines.join("\n");
  }

  const storeFinancials = buildStoreFinancialRows(
    report.rows,
    lemeng.ranking,
    monthly.stores || [],
  );
  lines.push("", "#### 门店营业与毛利（按本月营业额排名）");
  for (const row of storeFinancials.rows) {
    lines.push(
      "",
      hardBreak(`**${row.rank}. ${row.store}**`),
      hardBreak(`线下营业额：${formatMoney(row.lemengSalesWithoutCoupon)}`),
      hardBreak(`线上已到账：${formatMoney(row.douyinActualReceived)}`),
      hardBreak(`线上预计到账：${formatMoney(row.douyinExpectedReceived)}`),
      hardBreak(`线上营业额：${formatMoney(row.douyinTotal)}`),
      hardBreak(`门店总营业额：${formatMoney(row.businessRevenue)}`),
      hardBreak(`线下手续费：${formatMoney(row.lemengFee)}`),
      hardBreak(`扣费后营业额：${formatMoney(row.netRevenue)}`),
      hardBreak(`进货：${formatMoney(row.purchase)}`),
      hardBreak(`毛利：${formatMoney(row.profit)}`),
      hardBreak(`毛利率：${formatPercent(row.grossMargin)}`),
      `营业额占比：${row.rate}`,
    );
  }

  if (storeFinancials.unmatchedDouyinStores.length > 0) {
    lines.push("", "#### 未匹配抖音门店");
    for (const row of storeFinancials.unmatchedDouyinStores) {
      lines.push(
        "",
        hardBreak(`**${row.store}**`),
        hardBreak(`实际到账：${formatMoney(row.actual)}`),
        hardBreak(`预计到账：${formatMoney(row.expected)}`),
        `合计：${formatMoney(row.total)}`,
      );
    }
  }

  return lines.join("\n");
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error("用法: node scripts/read-current-zhimadi.cjs output/zhimadi-frame-text.txt");
  }

  const text = fs.readFileSync(inputPath, "utf8");
  const report = parseZhimadiText(text);
  const outputDir = path.resolve("output");
  fs.mkdirSync(outputDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(outputDir, `zhimadi-${today}.json`), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outputDir, `zhimadi-${today}.md`), buildMarkdown(today, report));
  console.log(JSON.stringify(report.totals, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  parseZhimadiText,
  buildMarkdown,
  storeKey,
  calculateOperatingTotals,
  buildStoreFinancialRows,
};
