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
  const totals = {
    quantity: Number(totalValues[0]),
    weight: Number(totalValues[1]),
    orders: Number(totalValues[2]),
    discount: Number(totalValues[3]),
    sales: Number(totalValues[4]),
    cost: Number(totalValues[5]),
    profit: Number(totalValues[6]),
    grossMargin: totalValues[7],
  };

  return { rows, totals };
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

function formatCents(value) {
  return `¥${formatMoney(Number(value || 0) / 100)}`;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function calculateSalesFees(salesWithCoupon, couponAmount, options = {}) {
  const douyinFeeRate = Number(options.douyinFeeRate ?? process.env.DOUYIN_FEE_RATE ?? 0.025);
  const lemengFeeRate = Number(options.lemengFeeRate ?? process.env.LEMENG_FEE_RATE ?? 0.003);
  const sales = Number(salesWithCoupon || 0);
  const coupon = Number(couponAmount || 0);
  const nonCouponSales = roundMoney(sales - coupon);
  const douyinFee = roundMoney(coupon * douyinFeeRate);
  const lemengFee = roundMoney(nonCouponSales * lemengFeeRate);
  const netSales = roundMoney(sales - douyinFee - lemengFee);

  return {
    salesWithCoupon: sales,
    couponAmount: coupon,
    nonCouponSales,
    douyinFee,
    lemengFee,
    totalFee: roundMoney(douyinFee + lemengFee),
    netSales,
    douyinFeeRate,
    lemengFeeRate,
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

function buildStoreProfitRows(purchaseRows, salesRows) {
  const purchaseByKey = new Map();
  for (const row of purchaseRows) {
    const key = storeKey(row.store);
    const current = purchaseByKey.get(key) || { store: row.store, purchase: 0 };
    current.purchase += row.sales;
    purchaseByKey.set(key, current);
  }

  const usedPurchaseKeys = new Set();
  const rows = [];

  for (const row of salesRows) {
    const key = storeKey(row.store);
    const purchase = purchaseByKey.get(key);
    const purchaseAmount = purchase?.purchase || 0;
    usedPurchaseKeys.add(key);
    rows.push({
      store: row.store,
      sales: row.sales,
      purchase: purchaseAmount,
      profit: row.sales - purchaseAmount,
      grossMargin: row.sales === 0 ? 0 : ((row.sales - purchaseAmount) / row.sales) * 100,
    });
  }

  for (const [key, row] of purchaseByKey) {
    if (usedPurchaseKeys.has(key) || !looksLikeStore(row.store)) continue;
    rows.push({
      store: row.store,
      sales: 0,
      purchase: row.purchase,
      profit: -row.purchase,
      grossMargin: 0,
    });
  }

  return rows.sort((a, b) => b.profit - a.profit);
}

function buildStoreFinancialRows(purchaseRows, salesRows, douyinStores = []) {
  const purchaseByKey = new Map();
  for (const row of purchaseRows) {
    const key = storeKey(row.store);
    const current = purchaseByKey.get(key) || 0;
    purchaseByKey.set(key, current + Number(row.sales || 0));
  }

  const couponByKey = new Map();
  for (const row of douyinStores) {
    const key = storeKey(row.store);
    const current = couponByKey.get(key) || 0;
    couponByKey.set(
      key,
      current + Number(row.verified_amount_cents || 0) / 100,
    );
  }

  const usedCouponKeys = new Set();
  const rows = salesRows.map((row) => {
    const key = storeKey(row.store);
    usedCouponKeys.add(key);
    const fees = calculateSalesFees(row.sales, couponByKey.get(key) || 0);
    const purchase = purchaseByKey.get(key) || 0;
    const profit = roundMoney(fees.netSales - purchase);
    return {
      ...fees,
      store: row.store,
      rank: row.rank,
      rate: row.rate,
      purchase,
      profit,
      grossMargin: fees.netSales === 0 ? 0 : (profit / fees.netSales) * 100,
    };
  });

  const unmatchedDouyinStores = douyinStores
    .filter((row) => {
      const key = storeKey(row.store);
      return !usedCouponKeys.has(key) && Number(row.verified_amount_cents || 0) !== 0;
    })
    .map((row) => ({
      store: row.store,
      couponAmount: Number(row.verified_amount_cents || 0) / 100,
    }));

  return { rows, unmatchedDouyinStores };
}

function buildMarkdown(dateText, report, lemeng = null, douyin = null) {
  const lines = [
    `### 水果店月报 ${dateText}`,
    "",
    "#### 总览",
    `乐檬含券销售额：${lemeng ? formatMoney(lemeng.monthly.salesWithCoupon) : "-"}`,
    `芝麻地进货额：${formatMoney(report.totals.sales)}`,
  ];

  if (lemeng) {
    const lemengSales = lemeng.monthly.salesWithCoupon;
    const purchaseAmount = report.totals.sales;
    const couponAmount = Number(douyin?.monthly?.verification?.verified_amount_cents || 0) / 100;
    const fees = calculateSalesFees(lemengSales, couponAmount);
    const grossProfit = roundMoney(lemengSales - purchaseAmount);
    const netGrossProfit = roundMoney(fees.netSales - purchaseAmount);
    const netGrossMargin = fees.netSales === 0 ? 0 : (netGrossProfit / fees.netSales) * 100;

    lines.push(
      `抖音本月到店核销券额：${formatMoney(couponAmount)}`,
      `到店销售（不含抖音券）：${formatMoney(fees.nonCouponSales)}`,
      `抖音券手续费（2.5%）：${formatMoney(fees.douyinFee)}`,
      `到店销售手续费（0.3%）：${formatMoney(fees.lemengFee)}`,
      `扣手续费后销售额：${formatMoney(fees.netSales)}`,
      `账面毛利（含券销售-进货）：${formatMoney(grossProfit)}`,
      `手续费后毛利：${formatMoney(netGrossProfit)} | 毛利率 ${formatPercent(netGrossMargin)}`,
    );
  }

  if (douyin) {
    const rate = douyin.verification.verification_rate_percent;
    lines.push(
      "",
      `#### 抖音昨日经营 ${douyin.report_date}`,
      `下单 ${douyin.orders.submitted_order_count} 单 | 成交 ${douyin.orders.paid_order_count} 单`,
      `成交券 ${douyin.orders.paid_coupon_count} 张 | 销售额 ${formatCents(douyin.orders.sales_amount_cents)}`,
      `核销 ${douyin.verification.verified_count} 张 | 核销金额 ${formatCents(douyin.verification.verified_amount_cents)}`,
      `核销率（核销券/成交券）：${rate === null ? "-" : formatPercent(rate)}`,
      `预计分账收入：${formatCents(douyin.settlement.estimated_income_cents)}`,
      "",
      "#### 抖音直播来源",
      `成交 ${douyin.live.paid_order_count} 单 / ${douyin.live.paid_coupon_count} 张 | 销售额 ${formatCents(douyin.live.sales_amount_cents)}`,
      `核销 ${douyin.live.verified_count} 张 | 核销金额 ${formatCents(douyin.live.verified_amount_cents)}`,
      `预计分账收入：${formatCents(douyin.live.estimated_income_cents)}`,
    );

    if (douyin.monthly) {
      lines.push(
        "",
        `#### 抖音本月核销 ${douyin.monthly.report_month}`,
        `核销 ${douyin.monthly.verification.verified_count} 张 | 券额 ${formatCents(douyin.monthly.verification.verified_amount_cents)}`,
        `预计分账收入：${formatCents(douyin.monthly.settlement.estimated_income_cents)}`,
      );
    }
  }

  lines.push(
    "",
    "#### 芝麻地门店进货额",
  );

  const purchaseRows = [...report.rows].sort((a, b) => b.sales - a.sales);
  for (const [index, row] of purchaseRows.entries()) {
    lines.push(
      "",
      `${index + 1}. ${row.store}`,
      `进货额 ${formatMoney(row.sales)}`,
    );
  }

  if (lemeng) {
    const storeFinancials = buildStoreFinancialRows(
      report.rows,
      lemeng.ranking,
      douyin?.monthly?.stores || [],
    );
    lines.push(
      "",
      "#### 门店销售与毛利（按含券销售排名）",
    );

    for (const row of storeFinancials.rows) {
      lines.push(
        "",
        `${row.rank}. ${row.store}`,
        `含券 ${formatMoney(row.salesWithCoupon)} | 抖音券 ${formatMoney(row.couponAmount)}`,
        `不含券 ${formatMoney(row.nonCouponSales)} | 扣费后 ${formatMoney(row.netSales)}`,
        `进货 ${formatMoney(row.purchase)} | 毛利 ${formatMoney(row.profit)}`,
        `毛利率 ${formatPercent(row.grossMargin)} | 销售占比 ${row.rate}`,
      );
    }

    if (storeFinancials.unmatchedDouyinStores.length > 0) {
      lines.push("", "#### 未匹配抖音门店");
      for (const row of storeFinancials.unmatchedDouyinStores) {
        lines.push(`${row.store} | 核销券额 ${formatMoney(row.couponAmount)}`);
      }
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
  buildStoreProfitRows,
  calculateSalesFees,
  buildStoreFinancialRows,
};
