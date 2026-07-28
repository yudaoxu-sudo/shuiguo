const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const archiveVersion = 1;

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function validateMonth(value) {
  const month = String(value || "");
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error("月份格式必须是 YYYY-MM");
  }
  return month;
}

function validateDate(value) {
  const dateText = String(value || "");
  const match = dateText.match(/^(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
  if (!match) throw new Error("报表日期格式必须是 YYYY-MM-DD");
  const date = new Date(`${dateText}T00:00:00.000Z`);
  if (date.toISOString().slice(0, 10) !== dateText) {
    throw new Error("报表日期无效");
  }
  return dateText;
}

function validateSuffix(value) {
  const suffix = String(value || "");
  if (suffix && !/^[A-Za-z0-9_-]+$/.test(suffix)) {
    throw new Error("报表后缀包含非法字符");
  }
  return suffix;
}

function reportFileNames(dateText, suffix = "") {
  const safeDate = validateDate(dateText);
  const safeSuffix = validateSuffix(suffix);
  const tail = safeSuffix ? `-${safeSuffix}` : "";
  return {
    report: `monthly-report-${safeDate}${tail}.md`,
    required: [
      `zhimadi-monthly-${safeDate}${tail}.json`,
      `lemeng-monthly-${safeDate}${tail}.json`,
    ],
    optional: [
      `douyin-monthly-${safeDate}${tail}.json`,
    ],
  };
}

function readRegularFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`历史报表文件类型不安全：${path.basename(filePath)}`);
  }
  return fs.readFileSync(filePath);
}

function fileRecord(filePath) {
  const content = readRegularFile(filePath);
  return {
    name: path.basename(filePath),
    bytes: content.length,
    sha256: sha256(content),
    content,
  };
}

function archiveDigest(files) {
  return sha256(Buffer.from(JSON.stringify(
    files.map(({ name, bytes, sha256: fileSha }) => ({
      name,
      bytes,
      sha256: fileSha,
    })),
  )));
}

function safeArchivePath(parent, child) {
  if (
    !/^[A-Za-z0-9_.-]+$/.test(child)
    || child === "."
    || child === ".."
    || path.basename(child) !== child
  ) {
    throw new Error("历史报表清单包含非法文件名");
  }
  const resolved = path.resolve(parent, child);
  if (!resolved.startsWith(`${path.resolve(parent)}${path.sep}`)) {
    throw new Error("历史报表路径越界");
  }
  return resolved;
}

function verifyArchive(archiveDir, expectedMonth) {
  const dirStat = fs.lstatSync(archiveDir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new Error("历史报表归档目录类型不安全");
  }
  const manifestPath = safeArchivePath(archiveDir, "manifest.json");
  const manifest = JSON.parse(readRegularFile(manifestPath).toString("utf8"));
  const month = validateMonth(manifest.month);
  if (month !== validateMonth(expectedMonth)) {
    throw new Error("历史报表月份与目录不一致");
  }
  validateDate(manifest.reportDate);
  validateSuffix(manifest.suffix);
  if (!Number.isFinite(Date.parse(manifest.createdAt))) {
    throw new Error("历史报表归档时间无效");
  }
  if (manifest.version !== archiveVersion || !Array.isArray(manifest.files)) {
    throw new Error("历史报表清单版本或文件列表无效");
  }
  if (!manifest.files.some((file) => file.name === manifest.reportFile)) {
    throw new Error("历史报表清单缺少正文");
  }

  const files = manifest.files.map((expected) => {
    const filePath = safeArchivePath(archiveDir, expected.name);
    const actual = fileRecord(filePath);
    if (
      actual.bytes !== expected.bytes
      || actual.sha256 !== expected.sha256
    ) {
      throw new Error(`历史报表归档校验失败：${expected.name}`);
    }
    return actual;
  });
  const digest = archiveDigest(files);
  if (digest !== manifest.archiveSha256) {
    throw new Error("历史报表归档摘要校验失败");
  }
  if (!path.basename(archiveDir).endsWith(`--${digest}`)) {
    throw new Error("历史报表归档目录与摘要不一致");
  }
  return { archiveDir, manifest, files };
}

function archiveMonthlyReport({
  outputDir = path.resolve("output"),
  dateText,
  suffix = "",
  now = new Date(),
  requireSnapshots = true,
}) {
  const safeOutputDir = path.resolve(outputDir);
  const names = reportFileNames(dateText, suffix);
  const sourceNames = [names.report];
  for (const snapshotName of [...names.required, ...names.optional]) {
    if (fs.existsSync(path.join(safeOutputDir, snapshotName))) {
      sourceNames.push(snapshotName);
    } else if (requireSnapshots && names.required.includes(snapshotName)) {
      throw new Error(`报表缺少必要快照：${snapshotName}`);
    }
  }
  const files = sourceNames.map((name) => fileRecord(
    safeArchivePath(safeOutputDir, name),
  ));
  const archiveSha256 = archiveDigest(files);
  const stableSha256 = archiveDigest(sourceNames.map((name) => fileRecord(
    safeArchivePath(safeOutputDir, name),
  )));
  if (stableSha256 !== archiveSha256) {
    throw new Error("源报表正在变化，请稍后重试归档");
  }
  const month = validateMonth(dateText.slice(0, 7));
  const historyRoot = path.join(safeOutputDir, "report-history");
  const monthDir = path.join(historyRoot, month);
  const stem = path.basename(names.report, ".md");
  const archiveId = `${stem}--${archiveSha256}`;
  const archiveDir = path.join(monthDir, archiveId);
  const manifest = {
    version: archiveVersion,
    month,
    reportDate: validateDate(dateText),
    suffix: validateSuffix(suffix),
    createdAt: new Date(now).toISOString(),
    archiveSha256,
    reportFile: names.report,
    files: files.map(({ name, bytes, sha256: fileSha }) => ({
      name,
      bytes,
      sha256: fileSha,
    })),
  };

  fs.mkdirSync(monthDir, { recursive: true, mode: 0o755 });
  if (fs.existsSync(archiveDir)) {
    return verifyArchive(archiveDir, month);
  }

  const pendingDir = path.join(
    monthDir,
    `pending-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(pendingDir, { mode: 0o700 });
  try {
    for (const file of files) {
      const destination = safeArchivePath(pendingDir, file.name);
      fs.writeFileSync(destination, file.content, { flag: "wx", mode: 0o444 });
    }
    fs.writeFileSync(
      safeArchivePath(pendingDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o444 },
    );
    fs.renameSync(pendingDir, archiveDir);
    for (const file of [...files, { name: "manifest.json" }]) {
      fs.chmodSync(path.join(archiveDir, file.name), 0o444);
    }
    fs.chmodSync(archiveDir, 0o555);
  } catch (error) {
    fs.rmSync(pendingDir, { recursive: true, force: true });
    if (fs.existsSync(archiveDir)) return verifyArchive(archiveDir, month);
    throw error;
  }
  return verifyArchive(archiveDir, month);
}

function listMonthArchives({
  outputDir = path.resolve("output"),
  month,
}) {
  const safeMonth = validateMonth(month);
  const monthDir = path.join(path.resolve(outputDir), "report-history", safeMonth);
  if (!fs.existsSync(monthDir)) return [];
  const monthStat = fs.lstatSync(monthDir);
  if (!monthStat.isDirectory() || monthStat.isSymbolicLink()) {
    throw new Error("历史报表月份目录类型不安全");
  }
  return fs.readdirSync(monthDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .filter((entry) => !entry.name.startsWith("pending-"))
    .map((entry) => verifyArchive(safeArchivePath(monthDir, entry.name), safeMonth));
}

function readLatestMonthlyReport({
  outputDir = path.resolve("output"),
  month,
}) {
  const safeMonth = validateMonth(month);
  const archives = listMonthArchives({ outputDir, month: safeMonth });
  if (archives.length === 0) {
    const error = new Error(`没有找到 ${safeMonth} 的历史报表`);
    error.code = "REPORT_HISTORY_NOT_FOUND";
    throw error;
  }
  archives.sort((left, right) => (
    right.manifest.reportDate.localeCompare(left.manifest.reportDate)
    || Number(left.manifest.suffix !== "") - Number(right.manifest.suffix !== "")
    || right.manifest.createdAt.localeCompare(left.manifest.createdAt)
    || right.manifest.archiveSha256.localeCompare(left.manifest.archiveSha256)
  ));
  const selected = archives[0];
  const report = selected.files.find(
    (file) => file.name === selected.manifest.reportFile,
  );
  return {
    month: safeMonth,
    markdown: report.content.toString("utf8"),
    manifest: selected.manifest,
    archiveDir: selected.archiveDir,
  };
}

function archiveExistingReports({ outputDir = path.resolve("output") } = {}) {
  const safeOutputDir = path.resolve(outputDir);
  if (!fs.existsSync(safeOutputDir)) return [];
  const reports = fs.readdirSync(safeOutputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
    .map((entry) => {
      const match = entry.name.match(
        /^monthly-report-(20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))(?:-([A-Za-z0-9_-]+))?\.md$/,
      );
      return match ? { dateText: match[1], suffix: match[2] || "" } : null;
    })
    .filter(Boolean)
    .sort((left, right) => (
      left.dateText.localeCompare(right.dateText)
      || left.suffix.localeCompare(right.suffix)
    ));
  return reports.map((report) => archiveMonthlyReport({
    outputDir: safeOutputDir,
    requireSnapshots: false,
    ...report,
  }));
}

function verifyExportBundle(bundle) {
  const month = validateMonth(bundle.month);
  if (bundle.version !== archiveVersion || !Array.isArray(bundle.archives)) {
    throw new Error("历史报表备份格式无效");
  }
  for (const archive of bundle.archives) {
    const manifest = archive?.manifest;
    if (
      manifest?.version !== archiveVersion
      || validateMonth(manifest.month) !== month
      || !Array.isArray(manifest.files)
      || !Array.isArray(archive.files)
    ) {
      throw new Error("历史报表备份中的归档清单无效");
    }
    const fileMap = new Map(archive.files.map((file) => [file.name, file]));
    const records = manifest.files.map((expected) => {
      safeArchivePath("/history", expected.name);
      const exported = fileMap.get(expected.name);
      if (!exported || typeof exported.contentBase64 !== "string") {
        throw new Error(`历史报表备份缺少文件：${expected.name}`);
      }
      const content = Buffer.from(exported.contentBase64, "base64");
      if (content.length !== expected.bytes || sha256(content) !== expected.sha256) {
        throw new Error(`历史报表备份文件校验失败：${expected.name}`);
      }
      return { ...expected, content };
    });
    if (
      !manifest.files.some((file) => file.name === manifest.reportFile)
      || archiveDigest(records) !== manifest.archiveSha256
    ) {
      throw new Error("历史报表备份归档摘要校验失败");
    }
  }
  const payload = {
    version: bundle.version,
    month: bundle.month,
    archives: bundle.archives,
  };
  if (sha256(Buffer.from(JSON.stringify(payload))) !== bundle.bundleSha256) {
    throw new Error("历史报表备份摘要校验失败");
  }
  return true;
}

function verifyExportFile(filePath) {
  const bundle = JSON.parse(readRegularFile(path.resolve(filePath)).toString("utf8"));
  verifyExportBundle(bundle);
  return bundle;
}

function exportMonthBundle({
  outputDir = path.resolve("output"),
  month,
  exportDir = path.resolve("output/report-history-exports"),
}) {
  const safeMonth = validateMonth(month);
  const archives = listMonthArchives({ outputDir, month: safeMonth });
  if (archives.length === 0) {
    const error = new Error(`没有找到 ${safeMonth} 的历史报表`);
    error.code = "REPORT_HISTORY_NOT_FOUND";
    throw error;
  }
  const payload = {
    version: archiveVersion,
    month: safeMonth,
    archives: archives
      .sort((left, right) => left.manifest.archiveSha256.localeCompare(right.manifest.archiveSha256))
      .map(({ manifest, files }) => ({
        manifest,
        files: files.map((file) => ({
          name: file.name,
          contentBase64: file.content.toString("base64"),
        })),
      })),
  };
  const bundle = {
    ...payload,
    bundleSha256: sha256(Buffer.from(JSON.stringify(payload))),
  };
  verifyExportBundle(bundle);

  const safeExportDir = path.resolve(exportDir);
  fs.mkdirSync(safeExportDir, { recursive: true, mode: 0o755 });
  const fileName = `fruit-report-history-${safeMonth}-${bundle.bundleSha256}.json`;
  const destination = path.join(safeExportDir, fileName);
  const content = `${JSON.stringify(bundle, null, 2)}\n`;
  if (fs.existsSync(destination)) {
    if (readRegularFile(destination).toString("utf8") !== content) {
      throw new Error("同名历史报表备份内容不一致");
    }
    return destination;
  }
  const pending = path.join(
    safeExportDir,
    `pending-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.json`,
  );
  fs.writeFileSync(pending, content, { flag: "wx", mode: 0o444 });
  try {
    fs.renameSync(pending, destination);
  } catch (error) {
    fs.rmSync(pending, { force: true });
    if (!fs.existsSync(destination)) throw error;
  }
  fs.chmodSync(destination, 0o444);
  return destination;
}

function parseHistoryCommand(text) {
  const normalized = String(text || "").replace(/\s+/g, "").trim();
  const markerIndex = normalized.lastIndexOf("报表");
  if (markerIndex < 0) return null;
  const prefix = normalized.slice(0, markerIndex);
  if (prefix && !prefix.startsWith("@")) return null;
  return validateMonth(normalized.slice(markerIndex + 2));
}

async function handleHistoryCommand({
  text,
  outputDir = path.resolve("output"),
  reply,
}) {
  let month;
  try {
    month = parseHistoryCommand(text);
  } catch {
    await reply("历史报表命令格式：报表 YYYY-MM");
    return { handled: true, outcome: "invalid-month" };
  }
  if (!month) return { handled: false };

  try {
    const result = readLatestMonthlyReport({ outputDir, month });
    await reply(result.markdown);
    return { handled: true, outcome: "sent", month, manifest: result.manifest };
  } catch (error) {
    const content = error.code === "REPORT_HISTORY_NOT_FOUND"
      ? `没有找到 ${month} 的历史报表。`
      : `历史报表 ${month} 校验失败，请检查服务器归档。`;
    await reply(content);
    return { handled: true, outcome: "failed", month, error };
  }
}

function main(argv = process.argv.slice(2)) {
  const [command, month, destination] = argv;
  if (command === "archive-existing") {
    const archives = archiveExistingReports();
    console.log(`已归档 ${archives.length} 份历史报表`);
    return;
  }
  if (command === "show") {
    console.log(readLatestMonthlyReport({ month }).markdown);
    return;
  }
  if (command === "export") {
    console.log(exportMonthBundle({
      month,
      exportDir: destination ? path.resolve(destination) : undefined,
    }));
    return;
  }
  if (command === "verify-export") {
    const bundle = verifyExportFile(month);
    console.log(`历史报表备份校验通过：${bundle.month}，${bundle.archives.length} 份归档`);
    return;
  }
  throw new Error("用法：report-history.cjs archive-existing | show YYYY-MM | export YYYY-MM [目录] | verify-export 文件");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = {
  archiveExistingReports,
  archiveMonthlyReport,
  exportMonthBundle,
  handleHistoryCommand,
  listMonthArchives,
  parseHistoryCommand,
  readLatestMonthlyReport,
  validateMonth,
  verifyExportBundle,
  verifyExportFile,
};
