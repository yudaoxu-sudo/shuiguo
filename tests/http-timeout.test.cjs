const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  requestTimeoutSignal,
} = require("../scripts/send-dingtalk.cjs");

test("external HTTP requests receive a bounded abort signal", async (t) => {
  const name = "TEST_FRUIT_HTTP_TIMEOUT_MS";
  const previous = process.env[name];
  process.env[name] = "5";
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });

  const signal = requestTimeoutSignal(name, 1000);
  assert.equal(signal.aborted, false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(signal.aborted, true);
});

test("the monthly report webhook uses the shared HTTP timeout", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../scripts/daily-report.cjs"),
    "utf8",
  );
  const start = source.indexOf("async function sendDingTalk(");
  const end = source.indexOf("async function runReportOnce", start);
  const sendSource = source.slice(start, end);

  assert.match(sendSource, /signal:\s*requestTimeoutSignal\(\)/);
});
