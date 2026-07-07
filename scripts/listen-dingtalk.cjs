const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { DWClient, TOPIC_ROBOT } = require("dingtalk-stream");

const heartbeatPath = path.resolve("output/listener-heartbeat.json");
const commandStatePath = path.resolve("output/listener-command-state.json");
const duplicateWindowMs = 3 * 60 * 1000;
const loginSessionTtlMs = 5 * 60 * 1000;
const captchaSelector = "#verifyCode";

function loadEnv() {
  const envPath = path.resolve(".env");
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function writeHeartbeat(status = "running") {
  fs.mkdirSync(path.dirname(heartbeatPath), { recursive: true });
  fs.writeFileSync(heartbeatPath, JSON.stringify({
    status,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

function chromeExecutablePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  return undefined;
}

function messageText(message) {
  return String(message?.text?.content || "").replace(/\s+/g, "").trim();
}

function commandKey(message, text) {
  const messageId = message?.msgId || message?.messageId || message?.msgid;
  if (messageId) return `message:${messageId}`;

  return [
    "fallback",
    message?.conversationId || message?.conversationTitle || "",
    message?.senderStaffId || message?.senderId || "",
    text,
  ].join(":");
}

function errorSummary(error) {
  return String(error?.output || error?.message || error)
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-8)
    .join("\n")
    .slice(0, 900);
}

function loadCommandState() {
  try {
    return JSON.parse(fs.readFileSync(commandStatePath, "utf8"));
  } catch {
    return { commands: [] };
  }
}

function rememberCommand(key) {
  const now = Date.now();
  const cutoff = now - duplicateWindowMs;
  const state = loadCommandState();
  const commands = Array.isArray(state.commands)
    ? state.commands.filter((item) => item && item.at >= cutoff)
    : [];

  if (commands.some((item) => item.key === key)) {
    return false;
  }

  commands.push({ key, at: now });
  fs.mkdirSync(path.dirname(commandStatePath), { recursive: true });
  fs.writeFileSync(commandStatePath, JSON.stringify({ commands }, null, 2));
  return true;
}

async function sendSessionText(client, sessionWebhook, senderStaffId, content) {
  if (!sessionWebhook) return;

  const accessToken = await client.getAccessToken();
  await fetch(sessionWebhook, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-acs-dingtalk-access-token": accessToken,
    },
    body: JSON.stringify({
      msgtype: "text",
      text: { content },
      at: {
        atUserIds: senderStaffId ? [senderStaffId] : [],
        isAtAll: false,
      },
    }),
  });
}

function runMonthlyReport() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/daily-report.cjs"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(output);
      else {
        const error = new Error(`月报脚本退出码 ${code}`);
        error.output = output;
        reject(error);
      }
    });
  });
}

async function uploadDingTalkImage(client, filePath) {
  const accessToken = await client.getAccessToken();
  const endpoints = [
    "https://oapi.dingtalk.io/media/upload",
    "https://oapi.dingtalk.com/media/upload",
  ];

  let lastError;
  for (const endpoint of endpoints) {
    const form = new FormData();
    const buffer = fs.readFileSync(filePath);
    form.append("access_token", accessToken);
    form.append("type", "image");
    form.append("media", new Blob([buffer], { type: "image/png" }), path.basename(filePath));

    try {
      const response = await fetch(endpoint, { method: "POST", body: form });
      const text = await response.text();
      if (!response.ok) throw new Error(`${response.status} ${text}`);

      const result = JSON.parse(text);
      if (result.errcode && result.errcode !== 0) throw new Error(text);
      return result.media_id;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`上传验证码图片失败: ${lastError?.message || "未知错误"}`);
}

async function sendGroupImage(client, message, mediaId) {
  const accessToken = await client.getAccessToken();
  const body = {
    msgParam: JSON.stringify({ photoURL: mediaId }),
    msgKey: "sampleImageMsg",
    openConversationId: message.conversationId,
    robotCode: message.robotCode,
  };

  const endpoints = [
    "https://api.dingtalk.com/v1.0/robot/groupMessages/send",
    "https://api.dingtalk.io/v1.0/robot/groupMessages/send",
  ];

  let lastError;
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-acs-dingtalk-access-token": accessToken,
        },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${response.status} ${text}`);
      const result = text ? JSON.parse(text) : {};
      if (result.code || result.errcode) throw new Error(text);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`发送验证码图片失败: ${lastError?.message || "未知错误"}`);
}

async function captureZhimadiCaptcha(session) {
  const outputDir = path.resolve("output/login-repair");
  fs.mkdirSync(outputDir, { recursive: true });

  const screenshotPath = path.join(outputDir, "zhimadi-login-current.png");
  const captchaPath = path.join(outputDir, "zhimadi-captcha-current.png");
  await session.page.screenshot({ path: screenshotPath, fullPage: true });

  const captcha = session.page.locator(captchaSelector);
  if (await captcha.count()) {
    await captcha.screenshot({ path: captchaPath });
    return { screenshotPath, captchaPath };
  }

  return { screenshotPath, captchaPath: screenshotPath };
}

function extractCaptchaCode(text) {
  const compact = String(text || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^[A-Z0-9]{4,6}$/.test(compact) ? compact : "";
}

function extractManualCaptchaCode(text) {
  const normalized = String(text || "").toUpperCase();
  const labeled = normalized.match(/(?:验证码|登录)[:：]?([A-Z0-9]{4,6})/);
  if (labeled) return labeled[1];

  const tokens = normalized.match(/[A-Z0-9]{4,6}/g) || [];
  return tokens.length === 1 ? tokens[0] : "";
}

async function recognizeCaptchaWithOpenAI(filePath) {
  if (!process.env.OPENAI_API_KEY) return "";

  const image = fs.readFileSync(filePath).toString("base64");
  const model = process.env.OPENAI_CAPTCHA_MODEL || "gpt-4o-mini";
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{
        role: "user",
        content: [
          {
            type: "text",
            text: "Read the verification code in this image. Return only the code, 4 to 6 uppercase letters or digits. No spaces.",
          },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${image}` },
          },
        ],
      }],
      max_tokens: 16,
      temperature: 0,
    }),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`验证码视觉识别失败: ${response.status} ${bodyText}`);
  }

  const body = JSON.parse(bodyText);
  return extractCaptchaCode(body.choices?.[0]?.message?.content);
}

async function tryAutoZhimadiLogin(session) {
  if (!process.env.OPENAI_API_KEY) return { ok: false, reason: "missing_openai_key" };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const { captchaPath } = await captureZhimadiCaptcha(session);
    const code = await recognizeCaptchaWithOpenAI(captchaPath);
    if (!code) return { ok: false, reason: "empty_code" };

    try {
      await submitZhimadiLoginCode(session, code);
      return { ok: true };
    } catch (error) {
      console.warn(`验证码自动识别第 ${attempt} 次失败: ${error.message}`);
      if (attempt === 2) return { ok: false, reason: "submit_failed" };
      await session.page.locator('input[name="verify_code"]').fill("").catch(() => {});
      await session.page.locator(captchaSelector).click().catch(() => {});
      await session.page.waitForTimeout(1000);
    }
  }

  return { ok: false, reason: "unknown" };
}

async function startZhimadiLoginSession() {
  const userDataDir = path.resolve(process.env.USER_DATA_DIR || "output/browser-profile");
  const outputDir = path.resolve("output/login-repair");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: process.env.HEADLESS === "true",
    executablePath: chromeExecutablePath(),
    viewport: { width: 1440, height: 900 },
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto(process.env.ZHIMADI_URL || "https://aems.zhimadi.cn/index.php?s=/Index/index.html", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(1500);

  if ((await page.locator("iframe#sellSummary_customSummary, iframe[name='iframepage']").count()) > 0) {
    await context.close();
    return { alreadyLoggedIn: true };
  }

  if ((await page.locator('input[name="account"]').count()) > 0 && process.env.ZHIMADI_USERNAME) {
    await page.locator('input[name="account"]').fill(process.env.ZHIMADI_USERNAME);
  }
  if ((await page.locator("#password").count()) > 0 && process.env.ZHIMADI_PASSWORD) {
    await page.locator("#password").fill(process.env.ZHIMADI_PASSWORD);
  }

  const session = {
    context,
    page,
    expiresAt: Date.now() + loginSessionTtlMs,
  };
  const screenshots = await captureZhimadiCaptcha(session);

  return {
    ...session,
    ...screenshots,
  };
}

async function submitZhimadiLoginCode(session, code) {
  await session.page.locator('input[name="verify_code"]').fill(code);
  await session.page.evaluate(() => {
    const candidates = [...document.querySelectorAll("button,a,input[type=button],input[type=submit]")];
    const button = candidates.find((element) => /登\s*录/.test(element.innerText || element.value || ""));
    if (!button) throw new Error("找不到芝麻地登录按钮");
    button.click();
  });
  await session.page.waitForSelector("iframe#sellSummary_customSummary, iframe[name='iframepage']", { timeout: 60000 });
  await session.context.close();
}

async function closeLoginSession(session) {
  await session?.context?.close().catch(() => {});
}

async function main() {
  loadEnv();

  if (!process.env.DINGTALK_CLIENT_ID || !process.env.DINGTALK_CLIENT_SECRET) {
    throw new Error("缺少 DINGTALK_CLIENT_ID 或 DINGTALK_CLIENT_SECRET");
  }

  let running = false;
  let loginSession = null;
  writeHeartbeat("starting");
  setInterval(() => writeHeartbeat("running"), 30000).unref();

  const client = new DWClient({
    clientId: process.env.DINGTALK_CLIENT_ID,
    clientSecret: process.env.DINGTALK_CLIENT_SECRET,
  });

  async function startZhimadiCaptchaFlow(message, afterLoginReport) {
    loginSession = await startZhimadiLoginSession();
    if (loginSession.alreadyLoggedIn) {
      loginSession = null;
      await sendSessionText(client, message.sessionWebhook, message.senderStaffId, "芝麻地当前登录正常。");
      return "already-ok";
    }
    loginSession.afterLoginReport = afterLoginReport;

    const autoLogin = await tryAutoZhimadiLogin(loginSession);
    if (autoLogin.ok) {
      loginSession = null;
      await sendSessionText(client, message.sessionWebhook, message.senderStaffId, "芝麻地已自动重新登录。");
      if (afterLoginReport) {
        await sendSessionText(client, message.sessionWebhook, message.senderStaffId, "正在重新生成月报。");
        await runMonthlyReport();
      }
      return "auto-ok";
    }

    const screenshots = await captureZhimadiCaptcha(loginSession);
    loginSession.screenshotPath = screenshots.screenshotPath;
    loginSession.captchaPath = screenshots.captchaPath;

    const mediaId = await uploadDingTalkImage(client, loginSession.captchaPath);
    await sendGroupImage(client, message, mediaId);
    await sendSessionText(client, message.sessionWebhook, message.senderStaffId, "芝麻地需要验证码。请看上面的验证码图，回复固定格式：验证码ABCD");
    return "captcha-sent";
  }

  client.registerCallbackListener(TOPIC_ROBOT, async (res) => {
    writeHeartbeat("message");
    const message = JSON.parse(res.data);
    const text = messageText(message);

    if (loginSession && Date.now() > loginSession.expiresAt) {
      await closeLoginSession(loginSession);
      loginSession = null;
      running = false;
    }

    const manualCaptchaCode = extractManualCaptchaCode(text);
    if (loginSession && manualCaptchaCode) {
      const code = manualCaptchaCode;
      try {
        await sendSessionText(client, message.sessionWebhook, message.senderStaffId, "收到验证码，正在恢复芝麻地登录。");
        await submitZhimadiLoginCode(loginSession, code);
        const afterLoginReport = loginSession.afterLoginReport;
        loginSession = null;
        if (afterLoginReport) {
          await sendSessionText(client, message.sessionWebhook, message.senderStaffId, "芝麻地登录已恢复，正在重新生成月报。");
          running = true;
          runMonthlyReport()
            .catch((error) => {
              console.error(error.stack || error.message);
            })
            .finally(() => {
              running = false;
            });
        } else {
          running = false;
          await sendSessionText(client, message.sessionWebhook, message.senderStaffId, "芝麻地登录已恢复。");
        }
      } catch (error) {
        await closeLoginSession(loginSession);
        loginSession = null;
        running = false;
        await sendSessionText(client, message.sessionWebhook, message.senderStaffId, `验证码登录失败：${error.message}。请重新发送 666 获取新验证码。`);
        console.error(error.stack || error.message);
      }
      return;
    }

    if (text.includes("登录")) {
      if (running) {
        await sendSessionText(client, message.sessionWebhook, message.senderStaffId, "当前有任务正在运行，稍等后再发 登录。");
        return;
      }

      running = true;
      try {
        await sendSessionText(client, message.sessionWebhook, message.senderStaffId, "正在检查芝麻地登录态。");
        const result = await startZhimadiCaptchaFlow(message, false);
        if (result !== "captcha-sent") running = false;
      } catch (error) {
        await closeLoginSession(loginSession);
        loginSession = null;
        running = false;
        console.error(error.stack || error.message);
        await sendSessionText(client, message.sessionWebhook, message.senderStaffId, `芝麻地登录修复启动失败：${error.message}`);
      }
      return;
    }

    if (!text.includes("666")) {
      return;
    }

    const key = commandKey(message, text);
    if (!rememberCommand(key)) {
      console.log(`[${new Date().toISOString()}] duplicate command ignored`);
      return;
    }

    if (running) {
      await sendSessionText(client, message.sessionWebhook, message.senderStaffId, "月报正在生成中，稍等。");
      return;
    }

    running = true;
    console.log(`[${new Date().toISOString()}] monthly report command accepted`);
    await sendSessionText(client, message.sessionWebhook, message.senderStaffId, "收到 666，正在生成本月报表。");

    runMonthlyReport()
      .catch(async (error) => {
        if (String(error.output || error.message).includes("芝麻地登录态失效")) {
          try {
            await startZhimadiCaptchaFlow(message, true);
            return;
          } catch (loginError) {
            await closeLoginSession(loginSession);
            loginSession = null;
            running = false;
            console.error(loginError.stack || loginError.message);
            await sendSessionText(client, message.sessionWebhook, message.senderStaffId, `自动登录流程启动失败：${loginError.message}`);
          }
        }
        console.error(error.stack || error.message);
        await sendSessionText(
          client,
          message.sessionWebhook,
          message.senderStaffId,
          `本月报表生成失败，已触发失败通知。\n${errorSummary(error)}`,
        );
      })
      .finally(() => {
        if (!loginSession) running = false;
      });
  }).connect();

  writeHeartbeat("connected");
  console.log("DingTalk listener started. Send @机器人 666 in the group.");
}

if (require.main === module) {
  process.on("SIGINT", () => {
    writeHeartbeat("stopped");
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    writeHeartbeat("stopped");
    process.exit(143);
  });

  main().catch((error) => {
    writeHeartbeat("failed");
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
