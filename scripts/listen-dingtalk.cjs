const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { DWClient, TOPIC_ROBOT } = require("dingtalk-stream");

const heartbeatPath = path.resolve("output/listener-heartbeat.json");

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

    if (running) {
      await sendSessionText(client, message.sessionWebhook, message.senderStaffId, "月报正在生成中，稍等。");
      return;
    }

    running = true;
    try {
      await sendSessionText(client, message.sessionWebhook, message.senderStaffId, "收到 666，正在生成本月报表。");
      await runMonthlyReport();
      await sendSessionText(client, message.sessionWebhook, message.senderStaffId, "本月报表已推送到群里。");
    } catch (error) {
      await sendSessionText(client, message.sessionWebhook, message.senderStaffId, `本月报表生成失败：${error.message}`);
      throw error;
    } finally {
      running = false;
    }
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
