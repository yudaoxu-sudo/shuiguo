const fs = require("fs");
const path = require("path");

function parseAmount(value) {
  return Number(String(value).replace(/,/g, ""));
}

function parseLemengMonthlyText(text) {
  const lines = text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const monthIndex = lines.indexOf("本月累计销售");
  const rankingIndex = lines.indexOf("月销售额排名");

  if (monthIndex === -1) {
    throw new Error("没有找到乐檬本月累计销售");
  }

  const endIndex = rankingIndex === -1 ? lines.length : rankingIndex;
  const section = lines.slice(monthIndex, endIndex);
  const metric = (label) => {
    const index = section.indexOf(label);
    if (index === -1) throw new Error(`没有找到乐檬指标: ${label}`);
    return {
      value: parseAmount(section[index + 1]),
      compareLabel: section[index + 2],
      compareAmount: parseAmount(section[index + 3] || "0"),
      compareRate: section[index + 5] || section[index + 4],
    };
  };

  const sales = metric("营业额(券售价)");
  const grossProfit = metric("毛利额");
  const grossMargin = metric("毛利率");

  return {
    salesWithCoupon: sales.value,
    salesCompareAmount: sales.compareAmount,
    salesCompareRate: sales.compareRate,
    grossProfit: grossProfit.value,
    grossProfitCompareAmount: grossProfit.compareAmount,
    grossProfitCompareRate: grossProfit.compareRate,
    grossMargin: grossMargin.value,
    grossMarginCompareAmount: grossMargin.compareAmount,
    grossMarginCompareRate: grossMargin.compareRate,
  };
}

function parseRankingGridText(text) {
  const parts = text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const headerIndex = parts.indexOf("门店Top");
  const amountHeaderIndex = parts.indexOf("销售额", headerIndex);
  const rateHeaderIndex = parts.indexOf("占比", amountHeaderIndex);

  if (headerIndex === -1 || amountHeaderIndex === -1 || rateHeaderIndex === -1) {
    throw new Error("没有找到乐檬月销售排名表头");
  }

  const data = parts.slice(rateHeaderIndex + 1);
  const firstStoreIndex = data.findIndex((part) => !/^\d+$/.test(part));
  if (firstStoreIndex === -1) return [];

  const stores = data.slice(firstStoreIndex);
  const rows = [];
  for (let index = 0; index < stores.length; index += 3) {
    const chunk = stores.slice(index, index + 3);
    if (chunk.length !== 3) break;
    rows.push({
      rank: rows.length + 1,
      store: chunk[0],
      sales: parseAmount(chunk[1]),
      rate: chunk[2],
    });
  }

  return rows;
}

function parseLemengText(text) {
  return {
    monthly: parseLemengMonthlyText(text),
    ranking: parseRankingGridText(text),
  };
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error("用法: node scripts/read-current-lemeng.cjs output/lemeng-page-text.txt");
  }

  const text = fs.readFileSync(inputPath, "utf8");
  const report = parseLemengMonthlyText(text);
  const outputDir = path.resolve("output");
  fs.mkdirSync(outputDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(outputDir, `lemeng-${today}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { parseLemengMonthlyText, parseRankingGridText, parseLemengText };
