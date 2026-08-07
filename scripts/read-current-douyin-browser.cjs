const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const {
  reconcileDouyinStoreRows,
} = require("./douyin-store-reconciliation.cjs");

const DEFAULT_FINANCE_URL = "https://life.douyin.com/p/finance/v2/home";

function formatDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function moneyToCents(value) {
  const normalized = String(value || "")
    .replace(/[¥￥,\s]/g, "")
    .replace(/[^\d.-]/g, "");
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) {
    throw new Error(`无法识别抖音金额：${value}`);
  }
  return Math.round(amount * 100);
}

function assertCompleteTablePage({
  rowCount,
  paginationDetected,
  totalCount = null,
  currentPage = null,
  pageCount = null,
  hasEnabledNext = null,
}, label = "抖音汇总表") {
  if (!paginationDetected) {
    throw new Error(`${label}没有读取到分页完整性信息`);
  }

  const rows = Number(rowCount);
  const total = Number(totalCount);
  const current = Number(currentPage);
  const pages = Number(pageCount);
  const totalKnown = totalCount !== null
    && totalCount !== ""
    && Number.isInteger(total)
    && total >= 0;
  const pageKnown = pageCount !== null
    && pageCount !== ""
    && Number.isInteger(pages)
    && pages > 0;
  const currentKnown = currentPage !== null
    && currentPage !== ""
    && Number.isInteger(current)
    && current > 0;

  if (
    hasEnabledNext === true
    || (pageKnown && pages > 1)
    || (currentKnown && current !== 1)
    || (totalKnown && total !== rows)
  ) {
    throw new Error(`${label}存在未读取分页`);
  }

  const totalProvesComplete = totalKnown && total === rows;
  const pageProvesComplete = pageKnown
    && pages === 1
    && (!currentKnown || current === 1)
    && hasEnabledNext === false;
  if (!totalProvesComplete && !pageProvesComplete) {
    throw new Error(`${label}分页完整性信息不充分`);
  }
}

function buildDouyinBrowserSummary({
  reportDate,
  merchantDue,
  dateRows,
  storeRows,
  allowSyncAdjustment = false,
}) {
  const merchantDueCents = moneyToCents(merchantDue);
  const pendingRows = dateRows.filter((row) => row.status.includes("待结算"));
  const settledRows = dateRows.filter((row) => row.status.includes("已结算"));
  if (pendingRows.length === 0 && settledRows.length === 0) {
    throw new Error("抖音按日期汇总没有可识别的结算状态");
  }

  const expectedReceivedCents = pendingRows.reduce(
    (sum, row) => sum + moneyToCents(row.merchantDue),
    0,
  );
  const actualReceivedCents = merchantDueCents - expectedReceivedCents;
  const sourceStores = storeRows.map((row) => ({
    store: row.store,
    merchant_due_cents: moneyToCents(row.merchantDue),
  }));
  const reconciliation = reconcileDouyinStoreRows(
    sourceStores,
    merchantDueCents,
    { allowSyncAdjustment },
  );

  const reportMonth = reportDate.slice(0, 7);
  return {
    report_month: reportMonth,
    through_date: reportDate,
    generated_at: new Date().toISOString(),
    monthly: {
      report_month: reportMonth,
      through_date: reportDate,
      generated_at: new Date().toISOString(),
      complete: true,
      source: "douyin_life_finance_summary",
      settlement: {
        actual_received_cents: actualReceivedCents,
        expected_received_cents: expectedReceivedCents,
        merchant_due_cents: merchantDueCents,
      },
      stores: reconciliation.stores,
      ...(reconciliation.syncAdjustmentCents
        ? { store_sync_adjustment_cents: reconciliation.syncAdjustmentCents }
        : {}),
      cached_day_count: Number(reportDate.slice(8, 10)),
      missing_dates: [],
    },
  };
}

async function firstVisible(locator) {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible()) return candidate;
  }
  return null;
}

async function selectCurrentMonth(page) {
  const selectedMonth = await firstVisible(page.getByText("本月", { exact: true }));
  if (selectedMonth) return;

  let periodControl = await firstVisible(page.getByText("今天", { exact: true }));
  if (!periodControl) {
    const dateRange = page.locator("span, div, button").filter({
      hasText: /^\d{4}-\d{2}-\d{2}\s*[~-]\s*\d{4}-\d{2}-\d{2}$/,
    });
    periodControl = await firstVisible(dateRange);
  }
  if (!periodControl) {
    throw new Error("抖音账单统计没有找到日期筛选控件");
  }

  await periodControl.click();
  const monthOption = await firstVisible(page.getByText("本月", { exact: true }));
  if (!monthOption) {
    throw new Error("抖音账单统计没有找到“本月”选项");
  }
  await monthOption.click();
}

async function waitForFinancePage(page) {
  await page.waitForFunction(() => {
    const text = document.body?.innerText || "";
    return text.includes("账单统计") || location.pathname.includes("/p/login");
  }, null, { timeout: 60000 });

  if (page.url().includes("/p/login")) {
    throw new Error("抖音来客登录态失效，需要运行 pnpm douyin:login 完成短信验证码登录");
  }
  await page.getByText("账单统计", { exact: true }).waitFor({
    state: "visible",
    timeout: 60000,
  });
}

async function extractMerchantDue(page) {
  const value = await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== "none"
        && style.visibility !== "hidden";
    };
    const labels = [...document.querySelectorAll("*")]
      .filter((element) => (
        element.children.length === 0
        && element.textContent.trim() === "商家应得"
        && visible(element)
      ));

    for (const label of labels) {
      let current = label.parentElement;
      for (let depth = 0; current && depth < 6; depth += 1) {
        const text = current.innerText?.replace(/\s+/g, " ").trim() || "";
        const matches = text.match(/[¥￥]?\s*-?[\d,]+\.\d{2}/g) || [];
        if (matches.length === 1 && text.length < 180) return matches[0];
        current = current.parentElement;
      }
    }
    return "";
  });

  if (!value) throw new Error("抖音账单统计没有读取到“商家应得”总额");
  return value;
}

async function extractTable(
  page,
  requiredHeaders,
  { requireCompletePage = false, label = "抖音汇总表" } = {},
) {
  await page.waitForFunction((headers) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, "");
    const headerTables = [...document.querySelectorAll("table")].filter(
      (table) => table.querySelector("thead th"),
    );
    return headerTables.some((headerTable) => {
      const headerTexts = [...headerTable.querySelectorAll("thead th")]
        .map((cell) => normalize(cell.innerText));
      if (headers.some((header) => (
        !headerTexts.some((text) => text.includes(normalize(header)))
      ))) return false;

      let wrapper = headerTable;
      while (wrapper && wrapper.querySelectorAll("tbody tr").length === 0) {
        wrapper = wrapper.parentElement;
      }
      return Boolean(wrapper?.querySelector("tbody tr"));
    });
  }, requiredHeaders, { timeout: 60000 });

  const result = await page.evaluate((headers) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, "");
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== "none"
        && style.visibility !== "hidden";
    };
    const headerTables = [...document.querySelectorAll("table")]
      .filter((table) => visible(table) && table.querySelector("thead th"));
    for (const headerTable of headerTables) {
      const headerCells = [...headerTable.querySelectorAll("thead th")];
      const headerTexts = headerCells.map((cell) => normalize(cell.innerText));
      const indexes = headers.map((header) => (
        headerTexts.findIndex((text) => text.includes(normalize(header)))
      ));
      if (indexes.some((index) => index < 0)) continue;

      let wrapper = headerTable;
      while (wrapper && wrapper.querySelectorAll("tbody tr").length === 0) {
        wrapper = wrapper.parentElement;
      }
      if (!wrapper) continue;

      const rows = [...wrapper.querySelectorAll("tbody tr")]
        .filter(visible)
        .map((row) => {
          const cells = [...row.querySelectorAll("td")];
          return indexes.map((index) => cells[index]?.innerText.trim() || "");
        })
        .filter((row) => row.every(Boolean));

      let paginationRoot = null;
      let scope = wrapper;
      for (let depth = 0; scope && depth < 7; depth += 1) {
        const candidates = [...scope.querySelectorAll(
          '[class*="pagination"], [class*="Pagination"], [class*="pager"], [class*="Pager"], [aria-label*="分页"]',
        )].filter(visible);
        if (candidates.length > 0) {
          paginationRoot = candidates[0];
          break;
        }
        scope = scope.parentElement;
      }

      if (!paginationRoot) {
        return {
          rows,
          pagination: {
            paginationDetected: false,
            rowCount: rows.length,
          },
        };
      }

      const paginationText = paginationRoot.innerText?.replace(/\s+/g, " ").trim() || "";
      const totalMatch = paginationText.match(/共\s*(\d+)\s*条/);
      const fractionMatch = paginationText.match(/(\d+)\s*\/\s*(\d+)(?:\s*页)?/);
      const paginationControlsRoot = paginationRoot.matches(
        '[class*="pager"], [class*="Pager"]',
      )
        ? paginationRoot
        : paginationRoot.querySelector('[class*="pager"], [class*="Pager"]')
          || paginationRoot;
      const activePage = paginationControlsRoot.querySelector(
        '[aria-current="page"], [class*="pagination-item-active"], [class*="pager-item-active"], [class*="pager-item-checked"]',
      );
      const numericPages = [...paginationControlsRoot.querySelectorAll("li, button, a")]
        .filter(visible)
        .map((element) => Number(element.textContent.trim()))
        .filter((value) => Number.isInteger(value) && value > 0);
      let nextControl = [...paginationControlsRoot.querySelectorAll(
        '[class*="pagination-next"], [aria-label*="下一页"], [title*="下一页"]',
      )].find(visible);
      if (
        !nextControl
        && /pager/i.test(String(paginationControlsRoot.className || ""))
      ) {
        const navigationItems = [...paginationControlsRoot.querySelectorAll("li, button, a")]
          .filter(visible)
          .filter((element) => !/^\d+$/.test(element.textContent.trim()));
        nextControl = navigationItems[navigationItems.length - 1] || null;
      }
      const nextDisabled = nextControl
        ? nextControl.disabled
          || nextControl.getAttribute("aria-disabled") === "true"
          || /disabled/i.test(String(nextControl.className || ""))
        : null;

      return {
        rows,
        pagination: {
          paginationDetected: true,
          rowCount: rows.length,
          totalCount: totalMatch ? Number(totalMatch[1]) : null,
          currentPage: fractionMatch
            ? Number(fractionMatch[1])
            : Number(activePage?.textContent.trim()) || null,
          pageCount: fractionMatch
            ? Number(fractionMatch[2])
            : numericPages.length > 0
              ? Math.max(...numericPages)
              : null,
          hasEnabledNext: nextControl ? !nextDisabled : null,
        },
      };
    }
    return null;
  }, requiredHeaders);

  if (!result || result.rows.length === 0) {
    throw new Error(`抖音汇总表没有读取到列：${requiredHeaders.join("、")}`);
  }
  if (requireCompletePage) {
    assertCompleteTablePage(result.pagination, label);
  }
  return result.rows;
}

async function readDouyinBrowser(context, monthThrough, options = {}) {
  const reportDate = monthThrough || formatDate();
  const page = await context.newPage();
  try {
    await page.goto(
      process.env.DOUYIN_FINANCE_URL || DEFAULT_FINANCE_URL,
      { waitUntil: "commit", timeout: 60000 },
    );
    await waitForFinancePage(page);
    await selectCurrentMonth(page);
    await page.waitForTimeout(1500);

    const dateTab = await firstVisible(page.getByText("按日期", { exact: true }));
    if (dateTab) {
      await dateTab.click();
      await page.waitForTimeout(800);
    }
    const merchantDue = await extractMerchantDue(page);
    const rawDateRows = await extractTable(
      page,
      ["日期", "结算状态", "商家应得(元)"],
    );
    const dateRows = rawDateRows.map(([date, status, merchantAmount]) => ({
      date,
      status,
      merchantDue: merchantAmount,
    }));
    const lastDateRow = dateRows[dateRows.length - 1];
    const dayOfMonth = Number(reportDate.slice(8, 10));
    if (
      lastDateRow.status.includes("待结算")
      && dateRows.length < dayOfMonth
    ) {
      throw new Error("抖音待结算日期超过当前页，无法完整计算预计到账");
    }

    const storeTab = await firstVisible(page.getByText("按门店", { exact: true }));
    if (!storeTab) throw new Error("抖音账单统计没有找到“按门店”");
    await storeTab.click();
    await page.getByText("按履约核销的门店进行汇总", { exact: true }).waitFor({
      state: "visible",
      timeout: 30000,
    });
    const rawStoreRows = await extractTable(
      page,
      ["门店", "商家应得(元)"],
      { requireCompletePage: true, label: "抖音门店汇总" },
    );
    const storeRows = rawStoreRows.map(([store, merchantAmount]) => ({
      store,
      merchantDue: merchantAmount,
    }));

    return buildDouyinBrowserSummary({
      reportDate,
      merchantDue,
      dateRows,
      storeRows,
      allowSyncAdjustment: options.allowSyncAdjustment === true,
    });
  } catch (error) {
    const outputDir = path.resolve("output/debug");
    fs.mkdirSync(outputDir, { recursive: true });
    const baseName = `douyin-${reportDate}-${Date.now()}`;
    const screenshotPath = path.join(outputDir, `${baseName}.png`);
    const textPath = path.join(outputDir, `${baseName}.txt`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    const bodyText = await page.locator("body").innerText({
      timeout: 5000,
    }).catch(() => "");
    fs.writeFileSync(
      textPath,
      `error=${error.stack || error.message || error}\n\n${bodyText.slice(0, 10000)}`,
    );
    error.message = `${error.message}；调试文件 ${screenshotPath}`;
    throw error;
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const { loadEnv } = require("./send-dingtalk.cjs");
  loadEnv();
  const context = await chromium.launchPersistentContext(
    path.resolve(process.env.USER_DATA_DIR || "output/browser-profile"),
    { headless: process.env.HEADLESS === "true" },
  );
  try {
    console.log(JSON.stringify(
      await readDouyinBrowser(context, process.argv[2]),
      null,
      2,
    ));
  } finally {
    await context.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = {
  assertCompleteTablePage,
  buildDouyinBrowserSummary,
  moneyToCents,
  readDouyinBrowser,
};
