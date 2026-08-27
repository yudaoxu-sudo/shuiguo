const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { loadEnv } = require("./send-dingtalk.cjs");
const { withLock } = require("./runtime-lock.cjs");
const { gotoZhimadi } = require("./zhimadi-navigation.cjs");
const {
  aggregatePurchaseRows,
  fetchPurchaseRows,
  renderPurchaseDetail,
} = require("./zhimadi-purchase-detail.cjs");

const outputPath = path.resolve("output/purchase-detail.txt");

function pad(n) {
  return String(n).padStart(2, "0");
}

function dateRange(now = new Date()) {
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const monthStart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
  return { today, monthStart };
}

function chromeExecutablePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (fs.existsSync(macChrome)) return macChrome;
  return undefined;
}

async function buildPurchaseDetail({ plain = true, now = new Date() } = {}) {
  const { today, monthStart } = dateRange(now);
  const userDataDir = path.resolve(process.env.USER_DATA_DIR || "output/browser-profile");

  return withLock("browser-profile", {
    waitMs: Number(process.env.BROWSER_LOCK_WAIT_MS || 10 * 60 * 1000),
    staleMs: Number(process.env.BROWSER_LOCK_STALE_MS || 30 * 60 * 1000),
  }, async () => {
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: process.env.HEADLESS === "true",
      executablePath: chromeExecutablePath(),
    });
    const page = await context.newPage();
    try {
      const rows = await fetchPurchaseRows(page, { monthStart, today, gotoZhimadi });
      const summary = aggregatePurchaseRows(rows, today);
      return renderPurchaseDetail(summary, today, { plain });
    } finally {
      await context.close().catch(() => {});
    }
  });
}

if (require.main === module) {
  loadEnv();
  buildPurchaseDetail({ plain: process.argv.includes("--markdown") ? false : true })
    .then((text) => {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, text);
      console.log(text);
      console.log(`\npurchase-detail-ok ${text.length} 字符`);
      process.exit(0);
    })
    .catch((error) => {
      console.error(`purchase-detail-failed: ${error.message || error}`);
      process.exit(1);
    });
}

module.exports = { buildPurchaseDetail, dateRange, outputPath };
