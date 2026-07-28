const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const {
  archiveExistingReports,
  archiveMonthlyReport,
  exportMonthBundle,
  handleHistoryCommand,
  listMonthArchives,
  parseHistoryCommand,
  readLatestMonthlyReport,
  validateMonth,
  verifyExportBundle,
} = require("../scripts/report-history.cjs");

function makeWritable(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    fs.chmodSync(target, 0o755);
    for (const name of fs.readdirSync(target)) {
      makeWritable(path.join(target, name));
    }
  } else {
    fs.chmodSync(target, 0o644);
  }
}

function createHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fruit-report-history-"));
  const outputDir = path.join(dir, "output");
  fs.mkdirSync(outputDir);
  return {
    dir,
    outputDir,
    cleanup() {
      makeWritable(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function writeSnapshot(outputDir, {
  dateText = "2026-07-28",
  suffix = "",
  marker = "first",
} = {}) {
  const tail = suffix ? `-${suffix}` : "";
  fs.writeFileSync(
    path.join(outputDir, `monthly-report-${dateText}${tail}.md`),
    `### ${dateText}\n\n${marker}\n`,
  );
  fs.writeFileSync(
    path.join(outputDir, `zhimadi-monthly-${dateText}${tail}.json`),
    JSON.stringify({ source: "zhimadi", marker }),
  );
  fs.writeFileSync(
    path.join(outputDir, `lemeng-monthly-${dateText}${tail}.json`),
    JSON.stringify({ source: "lemeng", marker }),
  );
  fs.writeFileSync(
    path.join(outputDir, `douyin-monthly-${dateText}${tail}.json`),
    JSON.stringify({ source: "douyin", marker }),
  );
}

test("accepts only canonical months and rejects traversal-shaped input", () => {
  assert.equal(validateMonth("2026-07"), "2026-07");
  assert.equal(parseHistoryCommand("报表 2026-07"), "2026-07");
  assert.equal(parseHistoryCommand("@水果店月报 报表 2026-07"), "2026-07");
  assert.equal(parseHistoryCommand("666"), null);
  assert.equal(parseHistoryCommand("请给我报表 2026-07"), null);
  for (const value of [
    "2026-00",
    "2026-13",
    "26-07",
    "../../2026-07",
    "2026-07/..",
    "2026-07-extra",
  ]) {
    assert.throws(() => validateMonth(value), /YYYY-MM/);
  }
  assert.throws(() => parseHistoryCommand("报表 ../../2026-07"), /YYYY-MM/);
  assert.throws(
    () => parseHistoryCommand("@水果店月报 报表 ../../2026-07"),
    /YYYY-MM/,
  );
});

test("creates content-addressed read-only archives and keeps changed versions", () => {
  const harness = createHarness();
  try {
    writeSnapshot(harness.outputDir, { marker: "first" });
    const first = archiveMonthlyReport({
      outputDir: harness.outputDir,
      dateText: "2026-07-28",
      now: new Date("2026-07-28T01:00:00.000Z"),
    });
    const repeated = archiveMonthlyReport({
      outputDir: harness.outputDir,
      dateText: "2026-07-28",
      now: new Date("2026-07-28T01:01:00.000Z"),
    });
    assert.equal(first.archiveDir, repeated.archiveDir);
    assert.equal(fs.statSync(path.join(first.archiveDir, "manifest.json")).mode & 0o777, 0o444);

    writeSnapshot(harness.outputDir, { marker: "corrected" });
    const corrected = archiveMonthlyReport({
      outputDir: harness.outputDir,
      dateText: "2026-07-28",
      now: new Date("2026-07-28T02:00:00.000Z"),
    });
    assert.notEqual(corrected.archiveDir, first.archiveDir);
    assert.equal(listMonthArchives({
      outputDir: harness.outputDir,
      month: "2026-07",
    }).length, 2);
    assert.match(readLatestMonthlyReport({
      outputDir: harness.outputDir,
      month: "2026-07",
    }).markdown, /corrected/);
    assert.match(
      fs.readFileSync(path.join(first.archiveDir, first.manifest.reportFile), "utf8"),
      /first/,
    );
  } finally {
    harness.cleanup();
  }
});

test("fails closed when an archived file no longer matches its manifest", () => {
  const harness = createHarness();
  try {
    writeSnapshot(harness.outputDir);
    const archived = archiveMonthlyReport({
      outputDir: harness.outputDir,
      dateText: "2026-07-28",
    });
    const reportPath = path.join(archived.archiveDir, archived.manifest.reportFile);
    fs.chmodSync(archived.archiveDir, 0o755);
    fs.chmodSync(reportPath, 0o644);
    fs.writeFileSync(reportPath, "tampered");
    assert.throws(
      () => readLatestMonthlyReport({
        outputDir: harness.outputDir,
        month: "2026-07",
      }),
      /归档校验失败/,
    );
    assert.throws(
      () => archiveMonthlyReport({
        outputDir: harness.outputDir,
        dateText: "2026-07-28",
      }),
      /归档校验失败/,
    );
  } finally {
    harness.cleanup();
  }
});

test("backfills 30 existing reports idempotently, including a report-only legacy file", () => {
  const harness = createHarness();
  try {
    for (let day = 1; day <= 30; day += 1) {
      writeSnapshot(harness.outputDir, {
        dateText: `2026-07-${String(day).padStart(2, "0")}`,
        marker: `legacy-${day}`,
      });
    }
    for (const prefix of ["zhimadi", "lemeng", "douyin"]) {
      fs.rmSync(path.join(harness.outputDir, `${prefix}-monthly-2026-07-01.json`));
    }
    fs.writeFileSync(
      path.join(harness.outputDir, "monthly-report-../../2026-07.md".replaceAll("/", "_")),
      "ignored",
    );
    fs.writeFileSync(path.join(harness.outputDir, "monthly-report-2026-13-01.md"), "ignored");
    const command = spawnSync(
      process.execPath,
      [path.resolve(__dirname, "../scripts/report-history.cjs"), "archive-existing"],
      { cwd: harness.dir, encoding: "utf8" },
    );
    assert.equal(command.status, 0, command.stderr);
    assert.match(command.stdout, /已归档 30 份历史报表/);
    const migrated = listMonthArchives({
      outputDir: harness.outputDir,
      month: "2026-07",
    }).sort((left, right) => left.manifest.reportDate.localeCompare(right.manifest.reportDate));
    assert.equal(migrated.length, 30);
    assert.equal(migrated[0].manifest.reportDate, "2026-07-01");
    assert.equal(migrated[0].manifest.files.length, 1);
    assert.equal(archiveExistingReports({ outputDir: harness.outputDir }).length, 30);
  } finally {
    harness.cleanup();
  }
});

test("exports a self-contained verified bundle and detects content tampering", () => {
  const harness = createHarness();
  try {
    writeSnapshot(harness.outputDir);
    archiveMonthlyReport({
      outputDir: harness.outputDir,
      dateText: "2026-07-28",
    });
    const exportDir = path.join(harness.dir, "offsite");
    const exportPath = exportMonthBundle({
      outputDir: harness.outputDir,
      month: "2026-07",
      exportDir,
    });
    const bundle = JSON.parse(fs.readFileSync(exportPath, "utf8"));
    assert.equal(verifyExportBundle(bundle), true);
    assert.equal(fs.statSync(exportPath).mode & 0o777, 0o444);
    const verified = spawnSync(
      process.execPath,
      [path.resolve(__dirname, "../scripts/report-history.cjs"), "verify-export", "--", exportPath],
      { encoding: "utf8" },
    );
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /备份校验通过/);
    const shown = spawnSync(
      process.execPath,
      [path.resolve(__dirname, "../scripts/report-history.cjs"), "show", "--", "2026-07"],
      { cwd: harness.dir, encoding: "utf8" },
    );
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /2026-07-28/);

    bundle.archives[0].files[0].contentBase64 = Buffer.from("tampered").toString("base64");
    assert.throws(() => verifyExportBundle(bundle), /校验失败/);
    const tamperedPath = path.join(harness.dir, "tampered.json");
    fs.writeFileSync(tamperedPath, JSON.stringify(bundle));
    const rejected = spawnSync(
      process.execPath,
      [path.resolve(__dirname, "../scripts/report-history.cjs"), "verify-export", tamperedPath],
      { encoding: "utf8" },
    );
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /校验失败/);
  } finally {
    harness.cleanup();
  }
});

test("handles a history query without running a report or sending to a network", async () => {
  const harness = createHarness();
  try {
    writeSnapshot(harness.outputDir);
    archiveMonthlyReport({
      outputDir: harness.outputDir,
      dateText: "2026-07-28",
    });
    const replies = [];
    const sent = await handleHistoryCommand({
      text: "报表 2026-07",
      outputDir: harness.outputDir,
      reply: async (content) => replies.push(content),
    });
    assert.equal(sent.outcome, "sent");
    assert.match(replies[0], /2026-07-28/);

    const invalid = await handleHistoryCommand({
      text: "报表 ../../etc",
      outputDir: harness.outputDir,
      reply: async (content) => replies.push(content),
    });
    assert.equal(invalid.outcome, "invalid-month");
    assert.match(replies.at(-1), /YYYY-MM/);

    const missing = await handleHistoryCommand({
      text: "报表 2026-06",
      outputDir: harness.outputDir,
      reply: async (content) => replies.push(content),
    });
    assert.equal(missing.outcome, "failed");
    assert.match(replies.at(-1), /没有找到/);
  } finally {
    harness.cleanup();
  }
});

test("the DingTalk listener wires history queries before preserving the 666 flow", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../scripts/listen-dingtalk.cjs"),
    "utf8",
  );
  assert.match(source, /parseHistoryCommand\(text\)/);
  assert.match(source, /handleHistoryCommand\(\{/);
  assert.match(source, /if \(!text\.includes\("666"\)\)/);
  assert.ok(
    source.indexOf("parseHistoryCommand(text)") < source.indexOf('if (!text.includes("666"))'),
  );
});
