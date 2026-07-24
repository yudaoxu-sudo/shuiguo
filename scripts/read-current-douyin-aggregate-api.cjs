const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const DEFAULT_FINANCE_URL = "https://life.douyin.com/p/finance/v2/home";
const DATE_STATISTICS_PATH = "/life/settle/v1/bill/query_date_statistics/";
const STORE_STATISTICS_PATH = "/life/settle/v1/bill/query_statistics/";

function formatDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function integerCents(value, label) {
  const cents = Number(value);
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`抖音聚合接口 ${label} 不是整数分`);
  }
  return cents;
}

function assertApiSuccess(payload, label) {
  const statusCode = payload?.status_code
    ?? payload?.BaseResp?.StatusCode
    ?? payload?.base_resp?.status_code
    ?? 0;
  if (Number(statusCode) !== 0) {
    const message = payload?.status_msg
      || payload?.BaseResp?.StatusMessage
      || payload?.base_resp?.status_message
      || "未知错误";
    throw new Error(`抖音聚合接口 ${label} 失败：${statusCode} ${message}`);
  }
  if (!payload?.data) {
    throw new Error(`抖音聚合接口 ${label} 缺少 data`);
  }
}

function paginationInfo(data) {
  const pageInfo = data?.page_info || data?.pagination || {};
  return {
    totalCount: Number(
      pageInfo.total_count
      ?? pageInfo.total
      ?? data?.total_count
      ?? data?.total
      ?? 0,
    ),
    pageCount: Number(
      pageInfo.page_count
      ?? pageInfo.total_page
      ?? pageInfo.total_pages
      ?? data?.page_count
      ?? data?.total_page
      ?? 0,
    ),
  };
}

function buildDouyinAggregateApiSummary({
  reportDate,
  datePayload,
  storePayload,
  storePageSize = 50,
}) {
  assertApiSuccess(datePayload, "本月到账汇总");
  assertApiSuccess(storePayload, "本月门店汇总");

  const dateRows = datePayload.data.bill_date_statistics_list;
  if (!Array.isArray(dateRows) || dateRows.length !== 1) {
    throw new Error(
      `抖音聚合接口本月到账汇总行数异常：${Array.isArray(dateRows) ? dateRows.length : 0}`,
    );
  }

  const merchantDueCents = integerCents(dateRows[0].income, "商家应得");
  const actualReceivedCents = integerCents(
    dateRows[0].settled_income,
    "实际到账",
  );
  const expectedReceivedCents = merchantDueCents - actualReceivedCents;
  if (merchantDueCents < 0 || actualReceivedCents < 0 || expectedReceivedCents < 0) {
    throw new Error("抖音聚合接口本月到账金额出现负数或结算额超过商家应得");
  }

  const rawStores = storePayload.data.bill_statistics_list;
  if (!Array.isArray(rawStores) || rawStores.length === 0) {
    throw new Error("抖音聚合接口没有返回本月门店汇总");
  }

  const { totalCount, pageCount } = paginationInfo(storePayload.data);
  if (
    pageCount > 1
    || totalCount > rawStores.length
    || (rawStores.length >= storePageSize && totalCount === 0 && pageCount === 0)
  ) {
    throw new Error(
      `抖音聚合接口门店汇总存在未读取分页：已读 ${rawStores.length}，总数 ${totalCount || "未知"}`,
    );
  }

  const stores = rawStores.map((row) => {
    const store = String(row.classify_name || "").trim();
    if (!store) throw new Error("抖音聚合接口门店汇总缺少门店名称");
    return {
      store,
      merchant_due_cents: integerCents(row.income, `${store}商家应得`),
    };
  });

  const storeTotalCents = stores.reduce(
    (sum, row) => sum + row.merchant_due_cents,
    0,
  );
  const residualCents = merchantDueCents - storeTotalCents;
  if (residualCents < -1) {
    throw new Error(
      `抖音聚合接口门店汇总超过本月总额：门店 ${storeTotalCents} 分，总额 ${merchantDueCents} 分`,
    );
  }
  if (Math.abs(residualCents) > 1) {
    stores.push({
      store: "未归属门店",
      merchant_due_cents: residualCents,
    });
  }

  const reportMonth = reportDate.slice(0, 7);
  const generatedAt = new Date().toISOString();
  return {
    report_month: reportMonth,
    through_date: reportDate,
    generated_at: generatedAt,
    monthly: {
      report_month: reportMonth,
      through_date: reportDate,
      generated_at: generatedAt,
      complete: true,
      source: "douyin_life_finance_aggregate_api",
      settlement: {
        actual_received_cents: actualReceivedCents,
        expected_received_cents: expectedReceivedCents,
        merchant_due_cents: merchantDueCents,
      },
      stores,
      cached_day_count: Number(reportDate.slice(8, 10)),
      missing_dates: [],
    },
  };
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

function buildAggregateUrls(templateUrl, reportDate) {
  const monthStart = `${reportDate.slice(0, 7)}-01`;
  const dateUrl = new URL(templateUrl);
  dateUrl.pathname = DATE_STATISTICS_PATH;
  dateUrl.searchParams.set("date_statistics_mode", "3");
  dateUrl.searchParams.set("start_date", monthStart);
  dateUrl.searchParams.set("end_date", reportDate);
  dateUrl.searchParams.set("biz_type", "1");
  dateUrl.searchParams.set("need_zero_bill", "true");
  dateUrl.searchParams.set("page", "1");
  dateUrl.searchParams.set("size", "10");
  dateUrl.searchParams.delete("statistics_type");

  const storeUrl = new URL(dateUrl);
  storeUrl.pathname = STORE_STATISTICS_PATH;
  storeUrl.searchParams.delete("date_statistics_mode");
  storeUrl.searchParams.delete("need_zero_bill");
  storeUrl.searchParams.set("statistics_type", "1");
  storeUrl.searchParams.set("page", "1");
  storeUrl.searchParams.set("size", "50");

  return {
    dateUrl: dateUrl.toString(),
    storeUrl: storeUrl.toString(),
  };
}

async function fetchJsonInPage(page, url, label) {
  const result = await page.evaluate(async ({ requestUrl }) => {
    const response = await fetch(requestUrl, {
      method: "GET",
      credentials: "include",
      headers: { accept: "application/json, text/plain, */*" },
    });
    return {
      ok: response.ok,
      status: response.status,
      text: await response.text(),
    };
  }, { requestUrl: url });

  if (!result.ok) {
    throw new Error(`抖音聚合接口 ${label} HTTP ${result.status}`);
  }
  try {
    return JSON.parse(result.text);
  } catch {
    throw new Error(`抖音聚合接口 ${label} 返回内容不是 JSON`);
  }
}

async function readDouyinAggregateApi(context, monthThrough) {
  const reportDate = monthThrough || formatDate();
  const page = await context.newPage();
  try {
    let templateRequest = null;
    page.on("request", (request) => {
      if (
        request.method() === "GET"
        && request.url().includes(DATE_STATISTICS_PATH)
      ) {
        templateRequest = request;
      }
    });
    await page.goto(
      process.env.DOUYIN_FINANCE_URL || DEFAULT_FINANCE_URL,
      { waitUntil: "commit", timeout: 60000 },
    );
    await waitForFinancePage(page);

    if (!templateRequest) {
      const templateRequestPromise = page.waitForRequest(
        (request) => (
          request.method() === "GET"
          && request.url().includes(DATE_STATISTICS_PATH)
        ),
        { timeout: 30000 },
      );
      [templateRequest] = await Promise.all([
        templateRequestPromise,
        page.reload({ waitUntil: "commit", timeout: 60000 }),
      ]);
      await waitForFinancePage(page);
    }
    const { dateUrl, storeUrl } = buildAggregateUrls(
      templateRequest.url(),
      reportDate,
    );
    const [datePayload, storePayload] = await Promise.all([
      fetchJsonInPage(page, dateUrl, "本月到账汇总"),
      fetchJsonInPage(page, storeUrl, "本月门店汇总"),
    ]);

    return buildDouyinAggregateApiSummary({
      reportDate,
      datePayload,
      storePayload,
    });
  } catch (error) {
    const outputDir = path.resolve("output/debug");
    fs.mkdirSync(outputDir, { recursive: true });
    const screenshotPath = path.join(
      outputDir,
      `douyin-aggregate-api-${reportDate}-${Date.now()}.png`,
    );
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
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
      await readDouyinAggregateApi(context, process.argv[2]),
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
  assertApiSuccess,
  buildAggregateUrls,
  buildDouyinAggregateApiSummary,
  readDouyinAggregateApi,
};
