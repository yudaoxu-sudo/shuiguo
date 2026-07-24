const fs = require("fs");
const path = require("path");
const readline = require("readline/promises");
const { chromium } = require("playwright");
const { withLock } = require("./runtime-lock.cjs");
const { loadEnv } = require("./send-dingtalk.cjs");

const financeUrl = "https://life.douyin.com/p/finance/v2/home";

async function firstVisible(locator) {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible()) return candidate;
  }
  return null;
}

async function waitForLogin(page) {
  await page.goto(process.env.DOUYIN_FINANCE_URL || financeUrl, {
    waitUntil: "commit",
    timeout: 60000,
  });
  await page.waitForFunction(() => (
    location.pathname.includes("/p/login")
      || (document.body?.innerText || "").includes("账单统计")
  ), { timeout: 60000 });

  if (!page.url().includes("/p/login")) {
    console.log("DOUYIN_LOGIN_OK");
    return;
  }

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
      await waitForFinanceDashboard(page);
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
    await waitForFinanceDashboard(page);
    console.log("DOUYIN_LOGIN_OK");
  } finally {
    terminal.close();
  }
}

async function acceptAgreement(page) {
  const agreement = page.locator('input[type="checkbox"]');
  if ((await agreement.count()) === 1 && !(await agreement.isChecked())) {
    await agreement.check({ force: true });
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
  await page.waitForFunction(() => !location.pathname.includes("/p/login"), {
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
