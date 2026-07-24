const fs = require("fs");

function parseAmount(value) {
  const amount = Number(String(value ?? "").replace(/[,\s]/g, ""));
  if (!Number.isFinite(amount)) {
    throw new Error(`乐檬金额无效: ${value}`);
  }
  return amount;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function buildLemengCollectionReport(rawRows, rawTotal) {
  const grouped = new Map();
  for (const rawRow of rawRows || []) {
    const store = String(rawRow.store || "").trim();
    if (!store) continue;
    grouped.set(
      store,
      roundMoney((grouped.get(store) || 0) + parseAmount(rawRow.sales)),
    );
  }

  const rows = [...grouped.entries()].map(([store, sales]) => ({ store, sales }));
  if (rows.length === 0) {
    throw new Error("没有读取到乐檬营业收款报表门店数据");
  }

  const total = roundMoney(parseAmount(rawTotal));
  const detailTotal = roundMoney(rows.reduce((sum, row) => sum + row.sales, 0));
  if (Math.abs(total - detailTotal) > 0.01) {
    throw new Error(
      `乐檬营业额汇总不一致：总额 ${total.toFixed(2)}，门店合计 ${detailTotal.toFixed(2)}`,
    );
  }

  const ranking = rows
    .sort((a, b) => b.sales - a.sales)
    .map((row, index) => ({
      rank: index + 1,
      store: row.store,
      sales: row.sales,
      rate: total === 0 ? "0.00%" : `${(row.sales / total * 100).toFixed(2)}%`,
    }));

  return {
    monthly: {
      salesWithoutCoupon: total,
    },
    ranking,
  };
}

function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error("用法: node scripts/read-current-lemeng.cjs <营业收款报表JSON>");
  }

  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const report = buildLemengCollectionReport(input.rows, input.total);
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = {
  parseAmount,
  buildLemengCollectionReport,
};
