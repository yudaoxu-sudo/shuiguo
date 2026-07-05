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

function buildMarkdown(dateText, report, lemeng = null) {
  const lines = [
    `### 水果店月报 ${dateText}`,
    "",
    "#### 总览",
    `乐檬销售额：${lemeng ? formatMoney(lemeng.monthly.salesWithCoupon) : "-"}`,
    `芝麻地进货额：${formatMoney(report.totals.sales)}`,
    `仓库成本：${formatMoney(report.totals.cost)}`,
    `芝麻地利润：${formatMoney(report.totals.profit)}`,
    `芝麻地毛利率：${report.totals.grossMargin}`,
  ];

  if (lemeng) {
    const lemengSales = lemeng.monthly.salesWithCoupon;
    const purchaseAmount = report.totals.sales;
    const grossProfit = lemengSales - purchaseAmount;
    const grossMargin = lemengSales === 0 ? 0 : (grossProfit / lemengSales) * 100;
    const salesPurchaseRatio = purchaseAmount === 0 ? 0 : (lemengSales / purchaseAmount) * 100;

    lines.push(
      `本月总毛利：${formatMoney(grossProfit)}`,
      `本月总毛利率：${formatPercent(grossMargin)}`,
      `销售/进货比：${formatPercent(salesPurchaseRatio)}`,
    );
  }

  lines.push(
    "",
    "#### 芝麻地门店进货数据",
  );

  for (const [index, row] of report.rows.entries()) {
    lines.push(
      "",
      `${index + 1}. ${row.store}`,
      `进货 ${formatMoney(row.sales)} | 成本 ${formatMoney(row.cost)}`,
      `利润 ${formatMoney(row.profit)} | 毛利 ${row.grossMargin}`,
    );
  }

  if (lemeng) {
    lines.push(
      "",
      "#### 乐檬门店销售排名",
    );

    for (const row of lemeng.ranking) {
      lines.push(
        "",
        `${row.rank}. ${row.store}`,
        `销售 ${formatMoney(row.sales)} | 占比 ${row.rate}`,
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

module.exports = { parseZhimadiText, buildMarkdown };
