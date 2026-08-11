function todayText(now = new Date()) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("当前日期无效");
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function resolveReportTargetDate(value, fallback = todayText()) {
  const candidate = String(value || fallback);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
    throw new Error(`定时报表日期无效: ${candidate}`);
  }
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate) {
    throw new Error(`定时报表日期无效: ${candidate}`);
  }
  return candidate;
}

function assertCurrentReportTargetDate(reportDate, currentDate = todayText(), {
  stage = "运行",
  label = "定时报表",
} = {}) {
  const targetDate = resolveReportTargetDate(reportDate);
  const actualDate = resolveReportTargetDate(currentDate);
  if (targetDate !== actualDate) {
    const error = new Error(
      `历史报表数据源尚未完成无推送验收，${label}在${stage}阶段拒绝自动生成 ${targetDate}`,
    );
    error.code = "REPORT_TARGET_DATE_ROLLOVER";
    error.reportDate = targetDate;
    error.currentDate = actualDate;
    error.stage = stage;
    throw error;
  }
  return targetDate;
}

function createReportTargetDateGuard(reportDate, {
  currentDate = () => todayText(),
  label = "定时报表",
} = {}) {
  const targetDate = resolveReportTargetDate(reportDate);
  return (stage = "运行") => assertCurrentReportTargetDate(
    targetDate,
    currentDate(),
    { stage, label },
  );
}

function shouldGuardFormalReportTarget(env = process.env) {
  return env.REPORT_MANAGED_BY_SCHEDULED === "1"
    || env.REPORT_MANAGED_BY_LISTENER === "1"
    || env.REPORT_FORMAL_WRAPPER === "1";
}

async function runGuardedAction(guard, stage, action) {
  guard(stage);
  return action();
}

module.exports = {
  assertCurrentReportTargetDate,
  createReportTargetDateGuard,
  resolveReportTargetDate,
  runGuardedAction,
  shouldGuardFormalReportTarget,
  todayText,
};
