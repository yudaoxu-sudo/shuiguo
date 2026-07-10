const defaultZhimadiUrl = "https://aems.zhimadi.cn/index.php?s=/Index/index.html";

async function gotoZhimadi(page, options = {}) {
  const readiness = options.readiness || "app";
  const navigationTimeout = Number(process.env.ZHIMADI_NAVIGATION_TIMEOUT_MS || 60000);
  const readyTimeout = Number(process.env.ZHIMADI_APP_READY_TIMEOUT_MS || 90000);

  await page.goto(process.env.ZHIMADI_URL || defaultZhimadiUrl, {
    waitUntil: "commit",
    timeout: navigationTimeout,
  });

  try {
    await page.waitForFunction(({ expectedReadiness }) => {
      const loginForm = document.querySelector(
        'input[name="account"], #password, input[name="verify_code"]',
      );
      if (loginForm) return true;

      const reportFrame = document.querySelector("iframe#sellSummary_customSummary");
      if (reportFrame) return true;

      const bodyText = document.body?.innerText || "";
      if (expectedReadiness === "app") {
        return bodyText.includes("切换企业") || bodyText.includes("收银台");
      }

      return [...document.querySelectorAll("a, li, span, div")].some((element) => {
        const visible = Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
        return visible && element.textContent?.trim() === "销售";
      });
    }, { expectedReadiness: readiness }, { timeout: readyTimeout });
  } catch (error) {
    const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    throw new Error(`芝麻地主界面加载超时：${bodyText.slice(0, 200).replace(/\s+/g, " ")}`, { cause: error });
  }
}

async function isZhimadiAuthenticated(page) {
  const loginForm = page.locator('input[name="account"], #password, input[name="verify_code"]');
  if ((await loginForm.count()) > 0) return false;

  const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  return bodyText.includes("切换企业")
    || bodyText.includes("收银台")
    || (await page.locator("iframe#sellSummary_customSummary, iframe[name='iframepage']").count()) > 0;
}

module.exports = { gotoZhimadi, isZhimadiAuthenticated };
