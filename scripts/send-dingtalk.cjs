const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

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

function signedWebhookUrl() {
  const webhook = process.env.DINGTALK_WEBHOOK;
  if (!webhook) throw new Error("缺少 DINGTALK_WEBHOOK");

  if (!process.env.DINGTALK_SECRET) return webhook;

  const timestamp = Date.now();
  const stringToSign = `${timestamp}\n${process.env.DINGTALK_SECRET}`;
  const sign = encodeURIComponent(
    crypto.createHmac("sha256", process.env.DINGTALK_SECRET).update(stringToSign).digest("base64"),
  );

  return `${webhook}${webhook.includes("?") ? "&" : "?"}timestamp=${timestamp}&sign=${sign}`;
}

function dingTalkAtConfig(alert) {
  if (!alert) return undefined;

  const atMobiles = String(process.env.DINGTALK_ALERT_MOBILES || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return {
    atMobiles,
    isAtAll: process.env.DINGTALK_ALERT_ALL === "true",
  };
}

async function sendDingTalkMarkdown(title, text, options = {}) {
  const payload = {
    msgtype: "markdown",
    markdown: { title, text },
  };
  const at = dingTalkAtConfig(options.alert);
  if (at) payload.at = at;

  const response = await fetch(signedWebhookUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const result = await response.text();
  if (!response.ok) {
    throw new Error(`钉钉推送失败: ${response.status} ${result}`);
  }

  return result;
}

async function main() {
  loadEnv();
  const text = process.argv.slice(2).join(" ") || "钉钉通知测试";
  const result = await sendDingTalkMarkdown("水果店通知", text);
  console.log(result);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = { loadEnv, sendDingTalkMarkdown };
