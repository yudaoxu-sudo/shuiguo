async function readDouyin(monthThrough, context) {
  if (!context) {
    throw new Error("抖音后台汇总读取需要浏览器上下文");
  }

  const { readDouyinBrowser } = require("./read-current-douyin-browser.cjs");
  return readDouyinBrowser(context, monthThrough);
}

module.exports = { readDouyin };
