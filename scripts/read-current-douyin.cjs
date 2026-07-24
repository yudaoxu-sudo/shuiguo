async function readDouyin(monthThrough, context) {
  if (!context) {
    throw new Error("抖音后台汇总读取需要浏览器上下文");
  }

  const source = process.env.DOUYIN_SOURCE || "browser";
  if (source === "aggregate-api") {
    const {
      readDouyinAggregateApi,
    } = require("./read-current-douyin-aggregate-api.cjs");
    return readDouyinAggregateApi(context, monthThrough);
  }
  if (source !== "browser") {
    throw new Error(`不支持的抖音数据来源：${source}`);
  }

  const { readDouyinBrowser } = require("./read-current-douyin-browser.cjs");
  return readDouyinBrowser(context, monthThrough);
}

module.exports = { readDouyin };
