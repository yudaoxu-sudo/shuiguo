const DETAIL_IFRAME = "iframe#sellSummary_sellSummary";
const DETAIL_PATH = "/index.php?s=/sellSummary/getSellSummaryData.html";

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// 件数多为整数，去掉没有意义的小数尾巴。
function formatQty(value) {
  const n = toNumber(value);
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "");
}

// 手机窄屏上金额写全会撑破一行，过万折成“万”。
function formatMoney(value) {
  const n = toNumber(value);
  if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return `${Math.round(n)}元`;
}

function aggregatePurchaseRows(rows, today) {
  const items = new Map();
  const storeMoney = new Map();
  const productTotals = new Map();
  let dayMoney = 0;
  let monthMoney = 0;

  for (const row of rows || []) {
    const store = String(row.store || "").trim();
    const product = String(row.product || "").trim();
    if (!store || !product) continue;
    const isToday = row.day === today;
    const qty = toNumber(row.qty);
    const amount = toNumber(row.amount);

    const key = `${store}||${product}`;
    const item = items.get(key)
      || { store, product, unit: row.unit || "件", day: 0, month: 0 };
    item.month += qty;
    if (isToday) item.day += qty;
    items.set(key, item);

    const money = storeMoney.get(store) || { day: 0, month: 0 };
    money.month += amount;
    if (isToday) money.day += amount;
    storeMoney.set(store, money);

    const total = productTotals.get(product) || { product, day: 0, month: 0 };
    total.month += qty;
    if (isToday) total.day += qty;
    productTotals.set(product, total);

    monthMoney += amount;
    if (isToday) dayMoney += amount;
  }

  const byStore = new Map();
  for (const item of items.values()) {
    if (item.day <= 0) continue;
    if (!byStore.has(item.store)) byStore.set(item.store, []);
    byStore.get(item.store).push(item);
  }

  const stores = [...byStore.entries()]
    .map(([store, list]) => ({
      store,
      items: list.sort((a, b) => b.day - a.day || a.product.localeCompare(b.product)),
      dayMoney: storeMoney.get(store)?.day || 0,
      monthMoney: storeMoney.get(store)?.month || 0,
      dayQty: list.reduce((sum, i) => sum + i.day, 0),
    }))
    .sort((a, b) => b.dayMoney - a.dayMoney);

  const warehouse = [...productTotals.values()]
    .filter((p) => p.day > 0)
    .sort((a, b) => b.day - a.day || a.product.localeCompare(b.product));

  return { stores, warehouse, dayMoney, monthMoney };
}

// 钉钉单聊只能发纯文本，markdown 记号会原样显示出来，所以要能关掉。
// 钉钉 markdown 里单个换行不成行，行尾要留两个空格才是硬换行。
// 纯文本（单聊）反而不能带这两个空格。
function renderPurchaseDetail(summary, dateText, {
  plain = false,
  storeTop = Infinity,
  warehouseTop = Infinity,
} = {}) {
  const short = String(dateText || "").slice(5);
  const h = (text) => (plain ? text : `#### ${text}`);
  const b = (text) => (plain ? text : `**${text}**`);
  const br = (text) => (plain ? text : `${text}  `);
  const lines = [
    h(`门店进货明细 ${short}`),
    br("今日｜本月（件）"),
    "",
  ];

  for (const store of summary.stores) {
    lines.push(br(b(store.store)));
    const shown = store.items.slice(0, storeTop);
    for (const item of shown) {
      lines.push(br(`${item.product} ${formatQty(item.day)}｜${formatQty(item.month)}`));
    }
    const rest = store.items.slice(storeTop);
    if (rest.length) {
      const restQty = rest.reduce((sum, i) => sum + i.day, 0);
      lines.push(br(`其余 ${rest.length} 项 ${formatQty(restQty)} 件`));
    }
    lines.push(
      br(`小计 当日 ${formatMoney(store.dayMoney)}｜本月 ${formatMoney(store.monthMoney)}`),
      "",
    );
  }

  lines.push(h(`仓库出货汇总 ${short}`), br("按今日出货量排名，今日｜本月（件）"), "");
  const top = summary.warehouse.slice(0, warehouseTop);
  top.forEach((item, index) => {
    lines.push(br(`${index + 1}. ${item.product} ${formatQty(item.day)}｜${formatQty(item.month)}`));
  });
  const restWarehouse = summary.warehouse.slice(warehouseTop);
  if (restWarehouse.length) {
    const restQty = restWarehouse.reduce((sum, i) => sum + i.day, 0);
    lines.push(br(`其余 ${restWarehouse.length} 项 ${formatQty(restQty)} 件`));
  }
  lines.push(
    "",
    br(`合计 当日 ${formatMoney(summary.dayMoney)}｜本月 ${formatMoney(summary.monthMoney)}`),
  );

  return lines.join("\n");
}

async function fetchPurchaseRows(page, { monthStart, today, gotoZhimadi }) {
  await gotoZhimadi(page, { readiness: "report" });
  const sale = page.getByText("销售", { exact: true }).first();
  if (await sale.isVisible().catch(() => false)) {
    await sale.click();
    await page.waitForTimeout(1200);
  }
  await page.getByText("销售明细表", { exact: true }).first().click();
  const handle = await page.waitForSelector(DETAIL_IFRAME, { timeout: 20000 });
  const frame = await handle.contentFrame();
  if (!frame) throw new Error("芝麻地销售明细表 iframe 没有加载");
  await page.waitForTimeout(7000);

  const rows = await frame.evaluate(async ({ path, start, end }) => {
    const url = `${path}&page=1&limit=8000&start_date=${start}&end_date=${end}`
      + "&date_type=1&examine_status=+&order_by=tdate&order_type=desc";
    // 少了这个头，后台会返回整页 HTML 而不是 JSON。
    const res = await fetch(url, {
      credentials: "include",
      headers: { "X-Requested-With": "XMLHttpRequest" },
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("芝麻地销售明细接口没有返回 JSON，登录态可能已失效");
    }
    return (parsed.data || []).map((x) => ({
      day: x.natural_day,
      store: x.custom_name,
      product: x.product_define_name,
      unit: x.package_unit_name,
      qty: x.total_package_name,
      amount: x.product_amount,
    }));
  }, { path: DETAIL_PATH, start: monthStart, end: today });

  if (!rows.length) throw new Error("芝麻地销售明细没有读到任何数据");
  return rows;
}

// 群里“666”是月报口令，这里只认“进货”，且不能带数字，避免和验证码、月报撞车。
function isPurchaseDetailCommand(text) {
  const value = String(text || "");
  if (!/进货/.test(value)) return false;
  return !/\d/.test(value);
}

// 钉钉单条文本发不下整份报表，按门店段落切开，不在半行处断。
function chunkText(text, maxChars = 3000) {
  const paragraphs = String(text || "").split("\n\n");
  const chunks = [];
  let current = "";
  for (const part of paragraphs) {
    const candidate = current ? `${current}\n\n${part}` : part;
    if (candidate.length > maxChars && current) {
      chunks.push(current);
      current = part;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

module.exports = {
  chunkText,
  isPurchaseDetailCommand,
  aggregatePurchaseRows,
  fetchPurchaseRows,
  formatMoney,
  formatQty,
  renderPurchaseDetail,
};
