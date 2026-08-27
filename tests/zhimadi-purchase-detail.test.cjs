const test = require("node:test");
const assert = require("node:assert/strict");

const {
  aggregatePurchaseRows,
  chunkText,
  formatMoney,
  formatQty,
  isPurchaseDetailCommand,
  renderPurchaseDetail,
} = require("../scripts/zhimadi-purchase-detail.cjs");

const rows = [
  { day: "2026-08-27", store: "水木花都店", product: "西梅小箱", unit: "件", qty: "200", amount: "12000" },
  { day: "2026-08-20", store: "水木花都店", product: "西梅小箱", unit: "件", qty: "1207", amount: "70000" },
  { day: "2026-08-27", store: "水木花都店", product: "阳光玫瑰", unit: "件", qty: "144", amount: "8000" },
  { day: "2026-08-27", store: "白溪店", product: "西梅小箱", unit: "件", qty: "80", amount: "4800" },
  { day: "2026-08-15", store: "白溪店", product: "只在本月进过", unit: "件", qty: "9", amount: "500" },
];

test("keeps today's rows and their month-to-date figure together", () => {
  const s = aggregatePurchaseRows(rows, "2026-08-27");
  const shuimu = s.stores.find((x) => x.store === "水木花都店");
  const plum = shuimu.items.find((i) => i.product === "西梅小箱");
  assert.equal(plum.day, 200);
  assert.equal(plum.month, 1407);
});

test("leaves out a product that was not restocked today", () => {
  const s = aggregatePurchaseRows(rows, "2026-08-27");
  const baixi = s.stores.find((x) => x.store === "白溪店");
  assert.equal(baixi.items.some((i) => i.product === "只在本月进过"), false);
  // 但它的金额仍计入本月合计。
  assert.equal(baixi.monthMoney, 5300);
});

test("ranks stores by today's spend and products by today's quantity", () => {
  const s = aggregatePurchaseRows(rows, "2026-08-27");
  assert.deepEqual(s.stores.map((x) => x.store), ["水木花都店", "白溪店"]);
  assert.deepEqual(s.stores[0].items.map((i) => i.product), ["西梅小箱", "阳光玫瑰"]);
});

test("rolls every store up into one warehouse ranking", () => {
  const s = aggregatePurchaseRows(rows, "2026-08-27");
  assert.deepEqual(
    s.warehouse.map((i) => [i.product, i.day, i.month]),
    [["西梅小箱", 280, 1487], ["阳光玫瑰", 144, 144]],
  );
  assert.equal(s.dayMoney, 24800);
  assert.equal(s.monthMoney, 95300);
});

test("writes money short enough for a phone line", () => {
  assert.equal(formatMoney(12000), "1.2万");
  assert.equal(formatMoney(4800), "4800元");
  assert.equal(formatQty(200), "200");
  assert.equal(formatQty(12.5), "12.5");
  assert.equal(formatQty("50.00"), "50");
});

test("drops markdown marks for a plain-text chat", () => {
  const s = aggregatePurchaseRows(rows, "2026-08-27");
  const plain = renderPurchaseDetail(s, "2026-08-27", { plain: true });
  assert.equal(plain.includes("**"), false);
  assert.equal(plain.includes("####"), false);
  assert.match(plain, /门店进货明细 08-27/);
  const md = renderPurchaseDetail(s, "2026-08-27");
  assert.match(md, /\*\*水木花都店\*\*/);
});

test("only answers to 进货 without digits, never to the report command", () => {
  assert.equal(isPurchaseDetailCommand("进货"), true);
  assert.equal(isPurchaseDetailCommand("@水果店月报进货明细"), true);
  assert.equal(isPurchaseDetailCommand("666"), false);
  assert.equal(isPurchaseDetailCommand("进货123456"), false);
});

test("splits a long report between stores, never mid-line", () => {
  const s = aggregatePurchaseRows(rows, "2026-08-27");
  const text = renderPurchaseDetail(s, "2026-08-27", { plain: true });
  const chunks = chunkText(text, 60);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join("\n\n"), text);
  chunks.forEach((c) => assert.equal(c.startsWith("\n"), false));
});

test("lists every product by default and never silently drops one", () => {
  const many = [];
  for (let i = 0; i < 9; i += 1) {
    many.push({
      day: "2026-08-27", store: "水木花都店", product: `商品${i}`,
      unit: "件", qty: String(10 - i), amount: "100",
    });
  }
  const s = aggregatePurchaseRows(many, "2026-08-27");
  const text = renderPurchaseDetail(s, "2026-08-27", { plain: true });
  for (let i = 0; i < 9; i += 1) assert.match(text, new RegExp(`商品${i} `));
  assert.equal(text.includes("其余"), false, "默认不折叠，一项都不能省");
});

test("can still fold the tail when a caller asks for it", () => {
  const many = [];
  for (let i = 0; i < 9; i += 1) {
    many.push({
      day: "2026-08-27", store: "水木花都店", product: `商品${i}`,
      unit: "件", qty: String(10 - i), amount: "100",
    });
  }
  const s = aggregatePurchaseRows(many, "2026-08-27");
  const text = renderPurchaseDetail(s, "2026-08-27", { plain: true, storeTop: 5, warehouseTop: 3 });
  assert.match(text, /商品0 10｜10/);
  assert.equal(text.includes("商品5 5｜5"), false, "第 6 个商品不该单独列出");
  assert.match(text, /其余 4 项 14 件/);
  assert.match(text, /其余 6 项 27 件/);
});

test("says nothing about a tail that does not exist", () => {
  const s = aggregatePurchaseRows(
    [{ day: "2026-08-27", store: "白溪店", product: "西梅", unit: "件", qty: "5", amount: "100" }],
    "2026-08-27",
  );
  const text = renderPurchaseDetail(s, "2026-08-27", { plain: true });
  assert.equal(text.includes("其余"), false);
});
