const fs = require("fs");
const path = require("path");
const readline = require("readline/promises");
const { chromium } = require("playwright");
const { withLock } = require("./runtime-lock.cjs");
const { loadEnv } = require("./send-dingtalk.cjs");

const financeUrl = "https://life.douyin.com/p/finance/v2/home";
const safeDiagnosticKeys = new Set([
  "captcha",
  "code",
  "description",
  "error_code",
  "message",
  "msg",
  "status",
  "status_code",
  "verify_method",
  "verify_type",
]);

function collectSafeDiagnosticFields(value, prefix = "", depth = 0, output = {}) {
  if (!value || typeof value !== "object" || depth > 5) return output;
  for (const [key, child] of Object.entries(value)) {
    const childPath = prefix ? `${prefix}.${key}` : key;
    if (
      safeDiagnosticKeys.has(key.toLowerCase())
      && ["string", "number", "boolean"].includes(typeof child)
    ) {
      output[childPath] = String(child).slice(0, 300);
    }
    if (child && typeof child === "object") {
      collectSafeDiagnosticFields(child, childPath, depth + 1, output);
    }
  }
  return output;
}

async function readSafeResponseDetails(response) {
  try {
    return collectSafeDiagnosticFields(await response.json());
  } catch {
    return {};
  }
}

async function firstVisible(locator) {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible()) return candidate;
  }
  return null;
}

async function waitForLogin(page) {
  const networkTrace = [];
  page.on("response", async (response) => {
    const resourceType = response.request().resourceType();
    if (!["xhr", "fetch"].includes(resourceType)) return;
    let requestPath = response.url();
    try {
      const url = new URL(requestPath);
      requestPath = `${url.origin}${url.pathname}`;
    } catch {
      // Keep the original URL when parsing fails.
    }
    const traceItem = {
      method: response.request().method(),
      status: response.status(),
      url: requestPath,
    };
    networkTrace.push(traceItem);
    if (networkTrace.length > 80) networkTrace.shift();
    if (requestPath.includes("/account_login/")) {
      traceItem.details = await readSafeResponseDetails(response);
    }
  });

  await page.goto(process.env.DOUYIN_FINANCE_URL || financeUrl, {
    waitUntil: "commit",
    timeout: 60000,
  });
  await page.waitForFunction(() => (
    location.pathname.includes("/p/login")
      || (document.body?.innerText || "").includes("账单统计")
  ), null, { timeout: 60000 });

  if (!page.url().includes("/p/login")) {
    console.log("DOUYIN_LOGIN_OK");
    return;
  }
  await page.waitForFunction(() => {
    const text = document.body?.innerText || "";
    return text.includes("立即登录") || text.includes("登录抖音来客");
  }, null, { timeout: 60000 });

  const existingLogin = await firstVisible(
    page.getByText("立即登录", { exact: true }),
  );
  if (existingLogin) {
    await existingLogin.click();
    await page.getByText("密码登录", { exact: true }).waitFor({
      state: "visible",
      timeout: 10000,
    });
  }

  const configuredPassword = process.env.DOUYIN_PASSWORD || "";
  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const phone = process.env.DOUYIN_PHONE
      || (await terminal.question("抖音来客手机号：")).trim();
    if (!/^\d{11}$/.test(phone)) throw new Error("抖音来客手机号格式不正确");

    if (configuredPassword) {
      const passwordLogin = await firstVisible(
        page.getByText("密码登录", { exact: true }),
      );
      if (passwordLogin) await passwordLogin.click();
      await page.locator('input[placeholder="密码"]:visible').waitFor({
        state: "visible",
        timeout: 10000,
      });

      const phoneInput = await firstVisible(page.getByPlaceholder("手机号码"));
      const passwordInput = await firstVisible(page.getByPlaceholder("密码"));
      if (!phoneInput || !passwordInput) {
        throw new Error("抖音来客密码登录表单没有加载");
      }
      await phoneInput.fill(phone);
      await passwordInput.fill(configuredPassword);
      await submitLogin(page);
      try {
        await waitForFinanceDashboard(page);
      } catch (error) {
        await addLoginDebug(page, error, networkTrace);
        throw error;
      }
      console.log("DOUYIN_LOGIN_OK");
      return;
    }

    const phoneInput = await firstVisible(page.getByPlaceholder("手机号码"));
    const codeInput = await firstVisible(page.getByPlaceholder("验证码"));
    if (!phoneInput || !codeInput) {
      throw new Error("抖音来客登录表单没有加载");
    }
    await phoneInput.fill(phone);
    await acceptAgreement(page);

    const sendCode = await firstVisible(
      page.getByText("发送验证码", { exact: true }),
    );
    if (!sendCode) throw new Error("抖音来客没有找到发送验证码按钮");
    await sendCode.click();
    console.log("DOUYIN_SMS_SENT");

    const code = (await terminal.question("短信验证码：")).trim();
    if (!/^\d{4,8}$/.test(code)) throw new Error("短信验证码格式不正确");
    await codeInput.fill(code);

    await submitLogin(page);
    try {
      await waitForFinanceDashboard(page);
    } catch (error) {
      await addLoginDebug(page, error, networkTrace);
      throw error;
    }
    console.log("DOUYIN_LOGIN_OK");
  } finally {
    terminal.close();
  }
}

async function addLoginDebug(page, error, networkTrace) {
  const outputDir = path.resolve("output/debug");
  fs.mkdirSync(outputDir, { recursive: true });
  const screenshotPath = path.join(outputDir, "douyin-login-failed.png");
  const detailsPath = path.join(outputDir, "douyin-login-failed.json");
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  const pageText = await page.locator("body").innerText({
    timeout: 5000,
  }).catch(() => "");
  const visibleErrors = await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== "none"
        && style.visibility !== "hidden";
    };
    return [...document.querySelectorAll(
      '[role="alert"], [class*="error"], [class*="message"], [class*="toast"]',
    )]
      .filter(visible)
      .map((element) => element.innerText.trim())
      .filter(Boolean)
      .slice(0, 20);
  }).catch(() => []);
  const loginSection = pageText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 45)
    .join(" | ");
  fs.writeFileSync(detailsPath, JSON.stringify({
    capturedAt: new Date().toISOString(),
    url: page.url(),
    visibleErrors,
    networkTrace,
  }, null, 2));
  error.message = `${error.message}；页面提示 ${loginSection.slice(0, 600)}；截图 ${screenshotPath}`;
}

async function acceptAgreement(page) {
  const agreement = page.locator('input[type="checkbox"]');
  if ((await agreement.count()) === 1 && !(await agreement.isChecked())) {
    const visibleControl = await firstVisible(
      page.locator("label.life-core-checkbox"),
    );
    if (!visibleControl) throw new Error("抖音来客登录协议控件没有加载");
    await visibleControl.click();
    if (!(await agreement.isChecked())) {
      throw new Error("抖音来客登录协议未勾选");
    }
  }
}

async function submitLogin(page) {
  await acceptAgreement(page);
  const loginButton = await firstVisible(
    page.getByRole("button", { name: "登录", exact: true }),
  );
  if (!loginButton) throw new Error("抖音来客没有找到登录按钮");
  await loginButton.click();
}

async function waitForFinanceDashboard(page) {
  await page.waitForFunction(() => !location.pathname.includes("/p/login"), null, {
    polling: 500,
    timeout: 60000,
  });
  await page.goto(process.env.DOUYIN_FINANCE_URL || financeUrl, {
    waitUntil: "commit",
    timeout: 60000,
  });
  await page.getByText("账单统计", { exact: true }).waitFor({
    state: "visible",
    timeout: 60000,
  });
}

async function main() {
  loadEnv();
  const userDataDir = path.resolve(
    process.env.USER_DATA_DIR || "output/browser-profile",
  );
  fs.mkdirSync(userDataDir, { recursive: true });

  await withLock("browser-profile", {
    waitMs: Number(process.env.BROWSER_LOCK_WAIT_MS || 10 * 60 * 1000),
    staleMs: Number(process.env.BROWSER_LOCK_STALE_MS || 30 * 60 * 1000),
  }, async () => {
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: process.env.HEADLESS === "true",
    });
    try {
      const page = context.pages()[0] || await context.newPage();
      await waitForLogin(page);
    } finally {
      await context.close();
    }
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
