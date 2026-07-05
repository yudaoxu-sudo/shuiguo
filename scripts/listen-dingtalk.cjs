const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { DWClient, TOPIC_ROBOT } = require("dingtalk-stream");

const heartbeatPath = path.resolve("output/listener-heartbeat.json");
const commandStatePath = path.resolve("output/listener-command-state.json");
const duplicateWindowMs = 3 * 60 * 1000;

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
      else reject(new Error(`月报脚本退出码 ${code}`));
    });
  });
}

async function main() {
  loadEnv();

  if (!process.env.DINGTALK_CLIENT_ID || !process.env.DINGTALK_CLIENT_SECRET) {
    throw new Error("缺少 DINGTALK_CLIENT_ID 或 DINGTALK_CLIENT_SECRET");
  }

  let running = false;
  writeHeartbeat("starting");
  setInterval(() => writeHeartbeat("running"), 30000).unref();

  const client = new DWClient({
    clientId: process.env.DINGTALK_CLIENT_ID,
    clientSecret: process.env.DINGTALK_CLIENT_SECRET,
  });

  client.registerCallbackListener(TOPIC_ROBOT, async (res) => {
    writeHeartbeat("message");
    const message = JSON.parse(res.data);
    const text = messageText(message);

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
        await sendSessionText(client, message.sessionWebhook, message.senderStaffId, `本月报表生成失败：${error.message}`);
        console.error(error.stack || error.message);
      })
      .finally(() => {
        running = false;
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
