const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { withLock } = require("./runtime-lock.cjs");

const defaultRequestPath = path.resolve("output/zhimadi-login-repair-request.json");
const defaultStatePath = path.resolve("output/zhimadi-login-repair-state.json");
const defaultFreshMs = 4 * 60 * 60 * 1000;
const resumeModePriority = {
  direct: 1,
  listener: 2,
  scheduled: 3,
};

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, data) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function parsedTimestamp(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isFreshPendingReportRequest(request, state, {
  now = Date.now(),
  freshMs = defaultFreshMs,
} = {}) {
  if (request?.afterLoginReport !== true) return false;
  const candidates = [];
  if (state?.handledRequestAt !== request.requestedAt) {
    candidates.push(request.requestedAt);
  }
  const listenerIntent = request.latestListenerResumeIntent;
  if (
    listenerIntent?.requestedAt
    && state?.latestListenerResumeIntent?.requestedAt !== listenerIntent.requestedAt
    && state?.handledListenerResumeRequestAt !== listenerIntent.requestedAt
  ) {
    candidates.push(listenerIntent.requestedAt);
  }
  return candidates.some((value) => {
    const requestedAt = parsedTimestamp(value);
    return requestedAt !== null
      && requestedAt <= now
      && now - requestedAt <= freshMs;
  });
}

function requestIsNewer(candidate, current) {
  const candidateAt = parsedTimestamp(candidate?.requestedAt) ?? -Infinity;
  const currentAt = parsedTimestamp(current?.requestedAt) ?? -Infinity;
  return candidateAt >= currentAt;
}

function normalizedResumeMode(request) {
  const mode = request?.reportResumeMode;
  return Object.hasOwn(resumeModePriority, mode) ? mode : "direct";
}

function boundedReportIntent(request) {
  if (request?.afterLoginReport !== true || !request.requestedAt) return null;
  return {
    requestedAt: request.requestedAt,
    reportResumeMode: normalizedResumeMode(request),
    reportDate: request.reportDate || null,
    requesterPid: Number.isInteger(request.requesterPid)
      ? request.requesterPid
      : null,
  };
}

function latestListenerIntent(current, incoming) {
  const candidates = [
    current?.latestListenerResumeIntent,
    normalizedResumeMode(current) === "listener" ? boundedReportIntent(current) : null,
    incoming?.latestListenerResumeIntent,
    normalizedResumeMode(incoming) === "listener" ? boundedReportIntent(incoming) : null,
  ].filter((candidate) => candidate?.reportResumeMode === "listener");
  return candidates.reduce(
    (latest, candidate) => (!latest || requestIsNewer(candidate, latest) ? candidate : latest),
    null,
  );
}

function supersededScheduledIntent(current, incoming, selected) {
  if (
    current?.afterLoginReport === true
    && incoming?.afterLoginReport === true
    && normalizedResumeMode(current) === "scheduled"
    && normalizedResumeMode(incoming) === "scheduled"
    && current.reportDate !== incoming.reportDate
    && selected?.requestedAt === incoming.requestedAt
    && current.requestedAt !== incoming.requestedAt
  ) {
    return boundedReportIntent(current);
  }
  return incoming?.supersededScheduledResumeIntent
    || current?.supersededScheduledResumeIntent
    || null;
}

function preferredReportRequest(current, incoming) {
  if (!current) return incoming;
  if (!incoming) return current;
  const currentPriority = resumeModePriority[normalizedResumeMode(current)];
  const incomingPriority = resumeModePriority[normalizedResumeMode(incoming)];
  if (incomingPriority !== currentPriority) {
    return incomingPriority > currentPriority ? incoming : current;
  }
  return requestIsNewer(incoming, current) ? incoming : current;
}

function withoutRequesterFields(request) {
  return Object.fromEntries(Object.entries(request || {}).filter(
    ([key]) => !/^requester[A-Z]/.test(key),
  ));
}

function mergeRepairRequests(current, incoming, {
  state = null,
  now = Date.now(),
  freshMs = defaultFreshMs,
} = {}) {
  if (!current) return { ...incoming };
  const currentReport = isFreshPendingReportRequest(current, state, {
    now,
    freshMs,
  }) ? current : null;
  const incomingReport = incoming?.afterLoginReport === true ? incoming : null;
  const reportRequest = preferredReportRequest(currentReport, incomingReport);
  if (!reportRequest) {
    return requestIsNewer(incoming, current) ? { ...incoming } : { ...current };
  }

  const base = withoutRequesterFields(reportRequest);
  delete base.latestListenerResumeIntent;
  delete base.supersededScheduledResumeIntent;
  const requesterFields = Object.fromEntries(Object.entries(reportRequest).filter(
    ([key]) => /^requester[A-Z]/.test(key),
  ));
  const merged = {
    ...base,
    ...requesterFields,
    afterLoginReport: true,
    reportResumeMode: normalizedResumeMode(reportRequest),
  };
  const listenerIntent = latestListenerIntent(current, incoming);
  if (
    listenerIntent
    && !(
      merged.reportResumeMode === "listener"
      && merged.requestedAt === listenerIntent.requestedAt
    )
  ) {
    merged.latestListenerResumeIntent = listenerIntent;
  }
  const supersededScheduled = supersededScheduledIntent(
    current,
    incoming,
    reportRequest,
  );
  if (supersededScheduled) {
    merged.supersededScheduledResumeIntent = supersededScheduled;
  }
  return merged;
}

async function persistMergedRepairRequest(incoming, options = {}) {
  const requestPath = options.requestPath || defaultRequestPath;
  const statePath = options.statePath || defaultStatePath;
  const requestLock = options.withRequestLock || withLock;
  const now = typeof options.now === "function"
    ? options.now()
    : options.now ?? Date.now();
  return requestLock(options.lockName || "zhimadi-repair-request", {
    waitMs: options.waitMs ?? 5000,
    staleMs: options.staleMs ?? 60 * 1000,
  }, async () => {
    const merged = mergeRepairRequests(
      readJson(requestPath),
      incoming,
      {
        state: readJson(statePath),
        now,
        freshMs: options.freshMs ?? defaultFreshMs,
      },
    );
    writeJsonAtomic(requestPath, merged);
    return merged;
  });
}

module.exports = {
  boundedReportIntent,
  isFreshPendingReportRequest,
  mergeRepairRequests,
  persistMergedRepairRequest,
  preferredReportRequest,
  writeJsonAtomic,
};
