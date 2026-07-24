const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { loadEnv, sendDingTalkMarkdown } = require("./send-dingtalk.cjs");

const statePath = path.resolve("output/douyin-dual-report-state.json");

function todayText() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function runPreview(source, suffix, reuseBaseSuffix = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/daily-report.cjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NO_DINGTALK: "1",
        REPORT_FAILURE_ALERTS: "false",
        DOUYIN_SOURCE: source,
        REPORT_OUTPUT_SUFFIX: suffix,
        REPORT_REUSE_BASE_SUFFIX: reuseBaseSuffix,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let outputTail = "";
    const append = (chunk, stream) => {
      const text = chunk.toString();
      stream.write(text);
      outputTail = `${outputTail}${text}`.slice(-4000);
    };
    child.stdout.on("data", (chunk) => append(chunk, process.stdout));
    child.stderr.on("data", (chunk) => append(chunk, process.stderr));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const label = source === "aggregate-api" ? "聚合接口" : "网页";
        reject(new Error(
          `抖音${label}版月报生成失败，退出码 ${code}：${outputTail.trim()}`,
        ));
      }
    });
  });
}

function storeMap(monthly) {
  return new Map((monthly?.stores || []).map((row) => [
    String(row.store).replace(/\s+/g, ""),
    Number(row.merchant_due_cents || 0),
  ]));
}

function compareDouyinSources(apiReport, browserReport) {
  const apiMonthly = apiReport?.monthly;
  const browserMonthly = browserReport?.monthly;
  if (!apiMonthly?.complete || !browserMonthly?.complete) {
    throw new Error("抖音双来源核对缺少完整月度数据");
  }

  const apiSettlement = apiMonthly.settlement;
  const browserSettlement = browserMonthly.settlement;
  const actualDiff = Number(apiSettlement.actual_received_cents || 0)
    - Number(browserSettlement.actual_received_cents || 0);
  const expectedDiff = Number(apiSettlement.expected_received_cents || 0)
    - Number(browserSettlement.expected_received_cents || 0);
  const totalDiff = Number(apiSettlement.merchant_due_cents || 0)
    - Number(browserSettlement.merchant_due_cents || 0);

  const apiStores = storeMap(apiMonthly);
  const browserStores = storeMap(browserMonthly);
  const storeNames = new Set([...apiStores.keys(), ...browserStores.keys()]);
  const storeDifferences = [...storeNames]
    .map((store) => ({
      store,
      difference_cents: (apiStores.get(store) || 0)
        - (browserStores.get(store) || 0),
    }))
    .filter((row) => row.difference_cents !== 0);

  return {
    exact: actualDiff === 0
      && expectedDiff === 0
      && totalDiff === 0
      && storeDifferences.length === 0,
    actual_difference_cents: actualDiff,
    expected_difference_cents: expectedDiff,
    total_difference_cents: totalDiff,
    store_differences: storeDifferences,
  };
}

function formatCents(cents) {
  return (Number(cents || 0) / 100).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function comparisonText(comparison) {
  if (comparison.exact) {
    return "双来源核对：本月总额、已到账、预计到账和门店汇总全部一致。";
  }
  return [
    "双来源核对存在差异（聚合接口 - 网页）：",
    `已到账 ${formatCents(comparison.actual_difference_cents)}，`,
    `预计到账 ${formatCents(comparison.expected_difference_cents)}，`,
    `到账合计 ${formatCents(comparison.total_difference_cents)}，`,
    `门店差异 ${comparison.store_differences.length} 家。`,
  ].join("");
}

function labelMarkdown(markdown, date, sourceLabel, sourceDescription, comparison) {
  const body = markdown.replace(
    /^### 水果店月报 [^\n]+/,
    `### 水果店月报（${sourceLabel}） ${date}`,
  );
  const lines = body.split("\n");
  return [
    lines[0],
    "",
    `> 抖音来源：${sourceDescription}`,
    `> ${comparisonText(comparison)}`,
    ...lines.slice(1),
  ].join("\n");
}

function fileHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function main() {
  loadEnv();
  const date = todayText();
  const previewOnly = ["1", "true"].includes(
    String(process.env.NO_DINGTALK || "").toLowerCase(),
  );
  const previous = readJson(statePath);
  if (
    !previewOnly
    && previous?.date === date
    && previous?.api?.sentAt
    && previous?.browser?.sentAt
  ) {
    console.log(`douyin-dual-report-skip: ${date} already sent`);
    return;
  }

  await runPreview("aggregate-api", "douyin-api");
  await runPreview("browser", "douyin-browser", "douyin-api");

  const outputDir = path.resolve("output");
  const apiMarkdownPath = path.join(
    outputDir,
    `monthly-report-${date}-douyin-api.md`,
  );
  const browserMarkdownPath = path.join(
    outputDir,
    `monthly-report-${date}-douyin-browser.md`,
  );
  const apiJsonPath = path.join(
    outputDir,
    `douyin-monthly-${date}-douyin-api.json`,
  );
  const browserJsonPath = path.join(
    outputDir,
    `douyin-monthly-${date}-douyin-browser.json`,
  );
  const apiReport = readJson(apiJsonPath);
  const browserReport = readJson(browserJsonPath);
  const comparison = compareDouyinSources(apiReport, browserReport);
  const apiMarkdown = labelMarkdown(
    fs.readFileSync(apiMarkdownPath, "utf8"),
    date,
    "聚合接口版",
    "抖音来客账单页月度聚合接口（2 次汇总请求）",
    comparison,
  );
  const browserMarkdown = labelMarkdown(
    fs.readFileSync(browserMarkdownPath, "utf8"),
    date,
    "网页版",
    "抖音来客账单页可见汇总表",
    comparison,
  );

  fs.writeFileSync(
    path.join(outputDir, `dual-report-${date}-api.md`),
    apiMarkdown,
  );
  fs.writeFileSync(
    path.join(outputDir, `dual-report-${date}-browser.md`),
    browserMarkdown,
  );
  if (previewOnly) {
    console.log(`douyin-dual-report-preview: ${date}; exact=${comparison.exact}`);
    return;
  }

  const state = previous?.date === date
    ? previous
    : { date, createdAt: new Date().toISOString() };
  state.comparison = comparison;

  if (!state.api?.sentAt) {
    const result = await sendDingTalkMarkdown(
      `水果店月报（聚合接口版）${date}`,
      apiMarkdown,
    );
    state.api = {
      sentAt: new Date().toISOString(),
      sha256: fileHash(apiMarkdown),
      dingTalkResult: result,
    };
    writeJson(statePath, state);
  }

  if (!state.browser?.sentAt) {
    const result = await sendDingTalkMarkdown(
      `水果店月报（网页版）${date}`,
      browserMarkdown,
    );
    state.browser = {
      sentAt: new Date().toISOString(),
      sha256: fileHash(browserMarkdown),
      dingTalkResult: result,
    };
    writeJson(statePath, state);
  }

  console.log(`douyin-dual-report-sent: ${date}; exact=${comparison.exact}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = {
  compareDouyinSources,
  comparisonText,
  labelMarkdown,
};
