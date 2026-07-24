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

function calculateSalesFees(salesWithCoupon, couponAmount, options = {}) {
  const douyinFeeRate = Number(options.douyinFeeRate ?? process.env.DOUYIN_FEE_RATE ?? 0.025);
  const lemengFeeRate = Number(options.lemengFeeRate ?? process.env.LEMENG_FEE_RATE ?? 0.003);
  const sales = Number(salesWithCoupon || 0);
  const coupon = Number(couponAmount || 0);
  if (coupon < 0 || coupon > sales + 0.01) {
    throw new Error(
      `抖音券额 ${formatMoney(coupon)} 超出含券销售额 ${formatMoney(sales)}`,
    );
  }
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
    const current = purchaseByKey.get(key) || {
      store: row.store,
      purchase: 0,
    };
    current.purchase += Number(row.sales || 0);
    purchaseByKey.set(key, current);
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
    const purchase = purchaseByKey.get(key)?.purchase || 0;
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

  const salesKeys = new Set(salesRows.map((row) => storeKey(row.store)));
  const unmatchedPurchaseRows = [...purchaseByKey.entries()]
    .filter(([key, row]) => !salesKeys.has(key) && row.purchase !== 0)
    .map(([, row]) => row)
    .sort((a, b) => b.purchase - a.purchase);

  return { rows, unmatchedDouyinStores, unmatchedPurchaseRows };
}

function buildMarkdown(dateText, report, lemeng = null, douyin = null) {
  assertMoneyTotal("芝麻地进货", report.totals.sales, report.rows, "sales");
  if (lemeng) {
    assertMoneyTotal(
      "乐檬销售",
      lemeng.monthly.salesWithCoupon,
      lemeng.ranking,
      "sales",
    );
  }
  if (douyin?.monthly?.complete) {
    const storeCouponTotal = (douyin.monthly.stores || []).reduce(
      (sum, row) => sum + Number(row.verified_amount_cents || 0),
      0,
    );
    const monthlyCouponTotal = Number(
      douyin.monthly.verification.verified_amount_cents || 0,
    );
    if (Math.abs(storeCouponTotal - monthlyCouponTotal) > 1) {
      throw new Error(
        `抖音本月券额汇总不一致：总额 ${formatCents(monthlyCouponTotal)}，逐店合计 ${formatCents(storeCouponTotal)}`,
      );
    }
  }

  const lines = [
    `### 水果店月报 ${dateText}`,
    "",
    "#### 总览",
    hardBreak(`乐檬含券销售额：${lemeng ? formatMoney(lemeng.monthly.salesWithCoupon) : "-"}`),
    hardBreak(`芝麻地进货额：${formatMoney(report.totals.sales)}`),
  ];

  if (lemeng) {
    const lemengSales = lemeng.monthly.salesWithCoupon;
    const purchaseAmount = report.totals.sales;
    const grossProfit = roundMoney(lemengSales - purchaseAmount);
    const monthlyDouyinComplete = douyin?.monthly?.complete !== false;

    if (douyin?.monthly && monthlyDouyinComplete) {
      const couponAmount = Number(douyin.monthly.verification.verified_amount_cents || 0) / 100;
      const fees = calculateSalesFees(lemengSales, couponAmount);
      const netGrossProfit = roundMoney(fees.netSales - purchaseAmount);
      const netGrossMargin = fees.netSales === 0 ? 0 : (netGrossProfit / fees.netSales) * 100;

      lines.push(
        hardBreak(`抖音本月到店核销券额：${formatMoney(couponAmount)}`),
        hardBreak(`到店销售（不含抖音券）：${formatMoney(fees.nonCouponSales)}`),
        hardBreak(`抖音券手续费（2.5%）：${formatMoney(fees.douyinFee)}`),
        hardBreak(`到店销售手续费（0.3%）：${formatMoney(fees.lemengFee)}`),
        hardBreak(`扣手续费后销售额：${formatMoney(fees.netSales)}`),
        hardBreak(`账面毛利（含券销售-进货）：${formatMoney(grossProfit)}`),
        hardBreak(`手续费后毛利：${formatMoney(netGrossProfit)}`),
        hardBreak(`手续费后毛利率：${formatPercent(netGrossMargin)}`),
      );
    } else {
      const grossMargin = lemengSales === 0 ? 0 : (grossProfit / lemengSales) * 100;
      lines.push(
        hardBreak(`本月总毛利（销售-进货）：${formatMoney(grossProfit)}`),
        hardBreak(`本月总毛利率：${formatPercent(grossMargin)}`),
      );
      if (douyin?.monthly) {
        const completed = douyin.monthly.cached_day_count;
        const total = completed + douyin.monthly.missing_dates.length;
        lines.push(hardBreak(`抖音本月数据正在分批拉取：已完成 ${completed}/${total} 天；完整前暂不计算本月手续费`));
      }
    }
  }

  if (douyin) {
    const rate = douyin.verification.verification_rate_percent;
    const douyinFeeRate = Number(process.env.DOUYIN_FEE_RATE ?? 0.025);
    const netCouponAmount = Math.round(
      Number(douyin.verification.verified_amount_cents || 0) * (1 - douyinFeeRate),
    );
    const liveNetCouponAmount = Math.round(
      Number(douyin.live.verified_amount_cents || 0) * (1 - douyinFeeRate),
    );
    lines.push(
      "",
      `#### 抖音昨日经营 ${douyin.report_date}`,
      hardBreak(`下单：${douyin.orders.submitted_order_count} 单`),
      hardBreak(`成交：${douyin.orders.paid_order_count} 单 / ${douyin.orders.paid_coupon_count} 张券`),
      hardBreak(`成交额：${formatCents(douyin.orders.sales_amount_cents)}`),
      hardBreak(`核销：${douyin.verification.verified_count} 张`),
      hardBreak(`核销券额：${formatCents(douyin.verification.verified_amount_cents)}`),
      hardBreak(`券扣费后（按 ${formatPercent(douyinFeeRate * 100)}）：${formatCents(netCouponAmount)}`),
      hardBreak(`核销率（核销券/成交券）：${rate === null ? "-" : formatPercent(rate)}`),
      "",
      "#### 抖音直播来源",
      hardBreak(`成交：${douyin.live.paid_order_count} 单 / ${douyin.live.paid_coupon_count} 张券`),
      hardBreak(`成交额：${formatCents(douyin.live.sales_amount_cents)}`),
    );
    if (douyin.live.ledger_deduplicated === true) {
      lines.push(
        hardBreak(`核销：${douyin.live.verified_count} 张`),
        hardBreak(`核销券额：${formatCents(douyin.live.verified_amount_cents)}`),
        hardBreak(`券扣费后（按 ${formatPercent(douyinFeeRate * 100)}）：${formatCents(liveNetCouponAmount)}`),
      );
    } else {
      lines.push(hardBreak("直播核销：本次旧缓存未按券去重，暂不展示"));
    }

    if (douyin.monthly) {
      if (douyin.monthly.complete) {
        const monthlyNetCouponAmount = Math.round(
          Number(douyin.monthly.verification.verified_amount_cents || 0)
            * (1 - douyinFeeRate),
        );
        lines.push(
          "",
          `#### 抖音本月核销 ${douyin.monthly.report_month}`,
          hardBreak(`核销：${douyin.monthly.verification.verified_count} 张`),
          hardBreak(`核销券额：${formatCents(douyin.monthly.verification.verified_amount_cents)}`),
          hardBreak(`券扣费后（按 ${formatPercent(douyinFeeRate * 100)}）：${formatCents(monthlyNetCouponAmount)}`),
        );
      } else {
        const completed = douyin.monthly.cached_day_count;
        const total = completed + douyin.monthly.missing_dates.length;
        lines.push(
          "",
          `#### 抖音本月核销 ${douyin.monthly.report_month}`,
          hardBreak(`数据拉取进度：${completed}/${total} 天；完整前不展示本月券额`),
        );
      }
    }
  }

  lines.push(
    "",
    "#### 芝麻地门店进货额",
  );

  const sortedPurchaseRows = [...report.rows].sort((a, b) => b.sales - a.sales);
  const purchaseRows = sortedPurchaseRows.filter((row) => looksLikeStore(row.store));
  const unmatchedPurchaseRows = sortedPurchaseRows.filter((row) => !looksLikeStore(row.store));
  for (const [index, row] of purchaseRows.entries()) {
    lines.push("", `**${index + 1}. ${row.store}**：${formatMoney(row.sales)}`);
  }

  if (unmatchedPurchaseRows.length > 0) {
    lines.push("", "#### 其他进货（未匹配门店）");
    for (const row of unmatchedPurchaseRows) {
      lines.push("", `**${row.store}**：${formatMoney(row.sales)}`);
    }
  }

  if (lemeng) {
    const monthlyDouyinComplete = douyin?.monthly?.complete !== false;
    if (!douyin?.monthly || !monthlyDouyinComplete) {
      lines.push(
        "",
        "#### 乐檬门店销售排名",
      );
      for (const row of lemeng.ranking) {
        lines.push(
          "",
          hardBreak(`**${row.rank}. ${row.store}**`),
          hardBreak(`销售：${formatMoney(row.sales)}`),
          `销售占比：${row.rate}`,
        );
      }

      const profitRows = buildStoreProfitRows(report.rows, lemeng.ranking);
      lines.push("", "#### 门店毛利排名");
      for (const [index, row] of profitRows.entries()) {
        lines.push(
          "",
          hardBreak(`**${index + 1}. ${row.store}**`),
          hardBreak(`销售：${formatMoney(row.sales)}`),
          hardBreak(`进货：${formatMoney(row.purchase)}`),
          hardBreak(`毛利：${formatMoney(row.profit)}`),
          `毛利率：${formatPercent(row.grossMargin)}`,
        );
      }
      return lines.join("\n");
    }

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
        hardBreak(`**${row.rank}. ${row.store}**`),
        hardBreak(`含券销售：${formatMoney(row.salesWithCoupon)}`),
        hardBreak(`抖音券：${formatMoney(row.couponAmount)}`),
        hardBreak(`不含券销售：${formatMoney(row.nonCouponSales)}`),
        hardBreak(`扣费后销售：${formatMoney(row.netSales)}`),
        hardBreak(`进货：${formatMoney(row.purchase)}`),
        hardBreak(`毛利：${formatMoney(row.profit)}`),
        hardBreak(`毛利率：${formatPercent(row.grossMargin)}`),
        `销售占比：${row.rate}`,
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
