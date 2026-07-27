const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  claimSmsCode,
  waitForSmsCode,
  writeSmsCode,
} = require("../scripts/douyin-sms-repair.cjs");
const {
  loadFreshSmsRepairTarget,
  listenerSmsRepairRequested,
} = require("../scripts/douyin-login.cjs");

const baseNow = Date.parse("2026-07-26T12:00:00.000Z");

function createConsumerHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-sms-consumer-test-"));
  const harness = {
    dir,
    filePath: path.join(dir, "code.txt"),
    nowMs: baseNow,
    sleeps: [],
    onTick: () => {},
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
  harness.now = () => harness.nowMs;
  harness.sleep = async (ms) => {
    harness.sleeps.push(ms);
    harness.nowMs += ms;
    harness.onTick(harness.nowMs - baseNow, harness);
  };
  harness.wait = (overrides = {}) => waitForSmsCode({
    filePath: harness.filePath,
    timeoutMs: 10000,
    pollMs: 1000,
    now: harness.now,
    sleep: harness.sleep,
    ...overrides,
  });
  return harness;
}

test("delivers a code written mid-wait and consumes the file without residue", async () => {
  const harness = createConsumerHarness();
  try {
    harness.onTick = (elapsed) => {
      if (elapsed === 3000) writeSmsCode("246810", harness.filePath);
    };
    const code = await harness.wait();
    assert.equal(code, "246810");
    assert.deepEqual(harness.sleeps, [1000, 1000, 1000]);
    assert.deepEqual(fs.readdirSync(harness.dir), []);
  } finally {
    harness.cleanup();
  }
});

test("ignores a stale code file left over from before the wait started", async () => {
  const harness = createConsumerHarness();
  try {
    writeSmsCode("999999", harness.filePath);
    harness.onTick = (elapsed) => {
      if (elapsed === 2000) writeSmsCode("246810", harness.filePath);
    };
    const code = await harness.wait();
    assert.equal(code, "246810");
    assert.deepEqual(harness.sleeps, [1000, 1000]);
  } finally {
    harness.cleanup();
  }
});

test("times out instead of consuming a stale code, and clears it", async () => {
  const harness = createConsumerHarness();
  try {
    writeSmsCode("999999", harness.filePath);
    await assert.rejects(
      harness.wait({ timeoutMs: 3000 }),
      /等待抖音短信验证码超时/,
    );
    assert.equal(fs.existsSync(harness.filePath), false);
    assert.deepEqual(fs.readdirSync(harness.dir), []);
    assert.deepEqual(harness.sleeps, [1000, 1000, 1000]);
  } finally {
    harness.cleanup();
  }
});

test("discards invalid or foreign content instead of rereading it forever", async () => {
  const harness = createConsumerHarness();
  try {
    harness.onTick = (elapsed) => {
      if (elapsed === 1000) fs.writeFileSync(harness.filePath, "24ab");
      if (elapsed === 2000) {
        assert.equal(fs.existsSync(harness.filePath), false);
        fs.writeFileSync(harness.filePath, "10000000000");
      }
      if (elapsed === 3000) {
        assert.equal(fs.existsSync(harness.filePath), false);
        fs.writeFileSync(harness.filePath, "");
      }
      if (elapsed === 4000) fs.writeFileSync(harness.filePath, "246810\n0421");
      if (elapsed === 5000) {
        assert.equal(fs.existsSync(harness.filePath), false);
        fs.writeFileSync(harness.filePath, " 246810\n");
      }
    };
    const code = await harness.wait();
    assert.equal(code, "246810");
    assert.deepEqual(harness.sleeps, [1000, 1000, 1000, 1000, 1000]);
    assert.deepEqual(fs.readdirSync(harness.dir), []);
  } finally {
    harness.cleanup();
  }
});

test("times out on the injected clock after the configured budget", async () => {
  const harness = createConsumerHarness();
  try {
    await assert.rejects(
      harness.wait({ timeoutMs: 5000 }),
      /等待抖音短信验证码超时/,
    );
    assert.deepEqual(harness.sleeps, [1000, 1000, 1000, 1000, 1000]);
  } finally {
    harness.cleanup();
  }
});

test("falls back to the default budget when the configured wait is garbage", async () => {
  const garbage = createConsumerHarness();
  try {
    await assert.rejects(
      garbage.wait({ timeoutMs: Number("not-a-number") }),
      /等待抖音短信验证码超时/,
    );
    assert.equal(garbage.sleeps.length, 300);
  } finally {
    garbage.cleanup();
  }

  const negative = createConsumerHarness();
  try {
    await assert.rejects(negative.wait({ timeoutMs: -1 }), /等待抖音短信验证码超时/);
    assert.equal(negative.sleeps.length, 300);
  } finally {
    negative.cleanup();
  }

  const zero = createConsumerHarness();
  try {
    await assert.rejects(zero.wait({ timeoutMs: 0 }), /等待抖音短信验证码超时/);
    assert.deepEqual(zero.sleeps, []);
  } finally {
    zero.cleanup();
  }
});

test("claims a code atomically and tolerates the file vanishing mid-poll", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-sms-consumer-test-"));
  const filePath = path.join(dir, "code.txt");
  try {
    assert.equal(claimSmsCode(filePath), "");

    writeSmsCode("246810", filePath);
    assert.equal(claimSmsCode(filePath), "246810");
    assert.equal(fs.existsSync(filePath), false);
    assert.deepEqual(fs.readdirSync(dir), []);

    assert.equal(claimSmsCode(filePath), "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lets exactly one of two concurrent waiters consume a single code", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-sms-consumer-test-"));
  const filePath = path.join(dir, "code.txt");
  try {
    let nowMs = baseNow;
    const wakeQueue = [];
    const options = {
      filePath,
      timeoutMs: 5000,
      pollMs: 1000,
      now: () => nowMs,
      sleep: () => new Promise((resolve) => wakeQueue.push(resolve)),
    };
    const settled = Promise.allSettled([
      waitForSmsCode(options),
      waitForSmsCode(options),
    ]);

    for (let tick = 1; tick <= 6; tick += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      nowMs = baseNow + tick * 1000;
      if (tick === 3) writeSmsCode("246810", filePath);
      for (const wake of wakeQueue.splice(0)) wake();
    }
    await new Promise((resolve) => setImmediate(resolve));

    const results = await settled;
    const codes = results
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);
    const failures = results.filter((result) => result.status === "rejected");
    assert.deepEqual(codes, ["246810"]);
    assert.equal(failures.length, 1);
    assert.match(failures[0].reason.message, /等待抖音短信验证码超时/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("douyin-login consumes the code file through the shared injectable waiter", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../scripts/douyin-login.cjs"),
    "utf8",
  );
  assert.match(source, /require\("\.\/douyin-sms-repair\.cjs"\)/);
  assert.match(source, /createSmsRepairRequest\(/);
  assert.match(
    source,
    /clearSmsCode\(codeFile\);[\s\S]*createSmsRepairRequest\([\s\S]*waitForSmsCode\(\{[\s\S]*discardExisting:\s*false/,
  );
  assert.match(
    source,
    /loadFreshSmsRepairTarget\(\)[\s\S]*createSmsRepairRequest\(\{[\s\S]*conversationId:\s*listenerTarget\.conversationId[\s\S]*senderStaffId:\s*listenerTarget\.senderStaffId/,
  );
  assert.doesNotMatch(source, /waitForSmsCodeFile/);
  assert.doesNotMatch(source, /existsSync\(filePath\)/);
});

test("accepts only a fresh, fully bound SMS target before the login sends a code", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-sms-target-preflight-test-"));
  const filePath = path.join(dir, "target.json");
  const target = {
    conversationId: "cid-1",
    senderStaffId: "user-1",
    savedAt: new Date(baseNow - 1000).toISOString(),
  };
  try {
    fs.writeFileSync(filePath, JSON.stringify(target));
    assert.deepEqual(
      loadFreshSmsRepairTarget({ filePath, now: baseNow, ttlMs: 5000 }),
      target,
    );

    fs.writeFileSync(filePath, JSON.stringify({
      ...target,
      savedAt: new Date(baseNow - 5001).toISOString(),
    }));
    assert.equal(
      loadFreshSmsRepairTarget({ filePath, now: baseNow, ttlMs: 5000 }),
      null,
    );

    fs.writeFileSync(filePath, JSON.stringify({
      conversationId: "cid-1",
      savedAt: new Date(baseNow - 1000).toISOString(),
    }));
    assert.equal(
      loadFreshSmsRepairTarget({ filePath, now: baseNow, ttlMs: 5000 }),
      null,
    );

    fs.writeFileSync(filePath, "{broken");
    assert.equal(
      loadFreshSmsRepairTarget({ filePath, now: baseNow, ttlMs: 5000 }),
      null,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps a fresh code when the caller already cleared stale delivery", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-sms-consumer-test-"));
  const filePath = path.join(dir, "code.txt");
  let nowMs = baseNow;
  try {
    writeSmsCode("246810", filePath);
    const code = await waitForSmsCode({
      filePath,
      discardExisting: false,
      timeoutMs: 5,
      pollMs: 1,
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms;
      },
    });
    assert.equal(code, "246810");
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("requires an explicit listener SMS mode for the production repair entry", () => {
  assert.equal(listenerSmsRepairRequested({ argv: [], env: {} }), false);
  assert.equal(
    listenerSmsRepairRequested({ argv: ["--listener-sms"], env: {} }),
    true,
  );
  assert.equal(
    listenerSmsRepairRequested({
      argv: [],
      env: { DOUYIN_SMS_REPAIR_MODE: "listener" },
    }),
    true,
  );
  assert.equal(
    listenerSmsRepairRequested({
      argv: [],
      env: { DOUYIN_SMS_CODE_FILE: "/tmp/legacy-code-path" },
    }),
    false,
  );

  const packageJson = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, "../package.json"),
    "utf8",
  ));
  assert.equal(
    packageJson.scripts["douyin:login:repair"],
    "node scripts/douyin-login.cjs --listener-sms",
  );
});
