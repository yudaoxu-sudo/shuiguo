const schema = "zhimadi_login_repair.v2";
const minute = 60 * 1000;
const defaultRetryOffsetsMs = [0, 5 * minute, 15 * minute, 30 * minute];
const terminalUnresolvedStatuses = new Set([
  "captcha-sent",
  "escalating",
  "escalation-failed",
  "fatal",
  "manual-failed",
  "manual-expired",
]);
const retryablePromptStatuses = new Set([
  "escalating",
  "escalation-failed",
  "manual-failed",
  "manual-expired",
]);
const resolvedStatuses = new Set([
  "already-ok",
  "auto-ok",
  "manual-ok",
  "observed-ok",
]);

function iso(timestamp) {
  return new Date(timestamp).toISOString();
}

function parsedTimestamp(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function mergedResumeMode(current, next) {
  if (current === "scheduled" || next === "scheduled") return "scheduled";
  return current || next || null;
}

function mergedReportDate(state, request, reportResumeMode) {
  if (state?.reportResumeMode === reportResumeMode && state.reportDate) {
    return state.reportDate;
  }
  return request?.reportResumeMode === reportResumeMode
    ? request.reportDate || null
    : null;
}

function requestIsNewer(candidate, current) {
  const candidateAt = parsedTimestamp(candidate?.requestedAt) ?? -Infinity;
  const currentAt = parsedTimestamp(current?.requestedAt) ?? -Infinity;
  return candidateAt >= currentAt;
}

function scheduledRequestReplacesState(state, request) {
  if (
    state?.afterLoginReport !== true
    || state.reportResumeMode !== "scheduled"
    || request?.afterLoginReport !== true
    || request.reportResumeMode !== "scheduled"
    || state.reportDate === request.reportDate
  ) return false;
  const stateRequestedAt = parsedTimestamp(state.reportRequestedAt);
  const requestRequestedAt = parsedTimestamp(request.requestedAt);
  return requestRequestedAt !== null
    && (stateRequestedAt === null || requestRequestedAt > stateRequestedAt);
}

function listenerIntentFromRequest(request) {
  if (
    request?.afterLoginReport !== true
    || request.reportResumeMode !== "listener"
    || !request.requestedAt
  ) return null;
  return {
    requestedAt: request.requestedAt,
    reportResumeMode: "listener",
    reportDate: request.reportDate || null,
    requesterPid: Number.isInteger(request.requesterPid)
      ? request.requesterPid
      : null,
  };
}

function mergedListenerResumeIntent(state, request, primaryMode) {
  if (primaryMode !== "scheduled") return null;
  const candidates = [
    state?.latestListenerResumeIntent,
    request?.latestListenerResumeIntent,
    listenerIntentFromRequest(request),
  ].filter((candidate) => candidate?.reportResumeMode === "listener");
  return candidates.reduce(
    (latest, candidate) => (!latest || requestIsNewer(candidate, latest) ? candidate : latest),
    null,
  );
}

function activeIncidentId(state) {
  if (!state?.incidentId) return null;
  if (state.status === "auto-retrying" || terminalUnresolvedStatuses.has(state.status)) {
    return state.incidentId;
  }
  return null;
}

function zhimadiRepairDeferral(state, {
  problemKey,
  message = "",
} = {}) {
  const text = String(message);
  if (
    problemKey !== "zhimadi-login"
    || text.includes("乐檬")
    || text.includes("抖音")
  ) {
    return null;
  }
  if (!state?.incidentId || !state?.incidentStartedAt || !state?.deadlineAt) {
    return null;
  }

  const details = {
    incidentId: state.incidentId,
    incidentStartedAt: state.incidentStartedAt,
    deadlineAt: state.deadlineAt,
    promptSentAt: state.promptSentAt || null,
  };
  if (state.status === "auto-retrying") {
    return { ...details, phase: "auto-retrying" };
  }
  if (
    terminalUnresolvedStatuses.has(state.status)
    && (
      state.promptSentAt
      || state.escalationAttemptedAt
      || state.fatalAlertAttemptedAt
    )
  ) {
    return { ...details, phase: "prompted" };
  }
  return null;
}

function requesterCanResumeReport(state, {
  now = Date.now(),
  isProcessRunning = () => false,
  graceMs = 4 * minute,
} = {}) {
  const requestedAt = parsedTimestamp(state?.reportRequestedAt);
  if (
    requestedAt === null
    || now < requestedAt
    || now - requestedAt > graceMs
    || state?.requesterResumeMode !== state?.reportResumeMode
  ) {
    return false;
  }
  return isProcessRunning(Number(state?.requesterPid));
}

function nextScheduledAttempt(startedAt, currentTime, retryOffsetsMs, repeatMs) {
  for (const offset of retryOffsetsMs) {
    const candidate = startedAt + offset;
    if (candidate > currentTime) return candidate;
  }

  const repeatingStart = startedAt + retryOffsetsMs.at(-1);
  const periodsElapsed = Math.floor((currentTime - repeatingStart) / repeatMs) + 1;
  return repeatingStart + periodsElapsed * repeatMs;
}

function newIncident(request, currentTime, silentWindowMs) {
  const requestedAt = parsedTimestamp(request?.requestedAt);
  const startedAt = requestedAt !== null && requestedAt <= currentTime
    ? requestedAt
    : currentTime;
  const incidentId = iso(startedAt);
  const state = {
    schema,
    status: "auto-retrying",
    incidentId,
    incidentStartedAt: incidentId,
    deadlineAt: iso(startedAt + silentWindowMs),
    nextAttemptAt: iso(currentTime),
    promptSentAt: null,
    handledRequestAt: request.requestedAt,
    latestRequestAt: request.requestedAt,
    afterLoginReport: request.afterLoginReport === true,
    reportResumeMode: request.reportResumeMode || null,
    reportDate: request.afterLoginReport === true ? request.reportDate || null : null,
    requesterPid: Number.isInteger(request.requesterPid) ? request.requesterPid : null,
    requesterResumeMode: request.afterLoginReport === true
      ? request.reportResumeMode || null
      : null,
    reportRequestedAt: request.afterLoginReport === true ? request.requestedAt : null,
    attemptCount: 0,
    updatedAt: iso(currentTime),
  };
  if (request.latestListenerResumeIntent) {
    state.latestListenerResumeIntent = request.latestListenerResumeIntent;
    state.handledListenerResumeRequestAt = request.latestListenerResumeIntent.requestedAt;
  }
  if (request.supersededScheduledResumeIntent) {
    state.supersededScheduledResumeIntent = request.supersededScheduledResumeIntent;
  }
  return state;
}

function shouldStartNewIncident(state, request) {
  if (!state?.status) return true;
  if (state.status === "auto-retrying" || terminalUnresolvedStatuses.has(state.status)) {
    return false;
  }
  if (state.status === "failed" && state.handledRequestAt === request.requestedAt) {
    return true;
  }
  if (!resolvedStatuses.has(state.status)) return true;

  const requestTime = parsedTimestamp(request.requestedAt);
  const completedAt = parsedTimestamp(state.completedAt || state.handledAt);
  if (state.handledRequestAt === request.requestedAt) return false;
  return requestTime !== null && (completedAt === null || requestTime > completedAt);
}

function mergeRequestIntoState(state, request, currentTime) {
  const replaceScheduled = scheduledRequestReplacesState(state, request);
  const reportResumeMode = mergedResumeMode(
    state.reportResumeMode,
    request.reportResumeMode,
  );
  const nextState = {
    ...state,
    schema,
    handledRequestAt: request.requestedAt,
    latestRequestAt: request.requestedAt,
    afterLoginReport: state.afterLoginReport === true || request.afterLoginReport === true,
    reportResumeMode,
    reportDate: replaceScheduled
      ? request.reportDate || null
      : mergedReportDate(state, request, reportResumeMode),
    requesterPid: replaceScheduled
      ? (Number.isInteger(request.requesterPid) ? request.requesterPid : null)
      : request.afterLoginReport === true && Number.isInteger(request.requesterPid)
        ? request.requesterPid
        : state.requesterPid || null,
    requesterResumeMode: request.afterLoginReport === true
      ? request.reportResumeMode || null
      : state.requesterResumeMode || null,
    reportRequestedAt: request.afterLoginReport === true
      ? request.requestedAt
      : state.reportRequestedAt || null,
    updatedAt: iso(currentTime),
  };
  const listenerIntent = mergedListenerResumeIntent(
    state,
    request,
    reportResumeMode,
  );
  if (listenerIntent) {
    nextState.latestListenerResumeIntent = listenerIntent;
    nextState.handledListenerResumeRequestAt = listenerIntent.requestedAt;
  } else delete nextState.latestListenerResumeIntent;
  if (replaceScheduled) {
    nextState.supersededScheduledResumeIntent = {
      requestedAt: state.reportRequestedAt || state.incidentStartedAt || null,
      reportResumeMode: "scheduled",
      reportDate: state.reportDate || null,
    };
    for (const key of [
      "reportResumeClaimId",
      "reportResumeClaimedAt",
      "reportResumeOwner",
      "reportResumeOwnerPid",
      "reportResumeLeaseUntil",
      "reportResumeCompletedAt",
      "reportResumeDateBlockedAt",
      "reportResumeBlockedReason",
      "reportResumeStartedAt",
      "reportResumeAttemptCount",
      "reportResumeLastFailedAt",
      "reportResumeLastFailure",
      "reportResumeNextAttemptAt",
      "reportResumeAlertAttemptedAt",
    ]) delete nextState[key];
  } else if (request.supersededScheduledResumeIntent) {
    nextState.supersededScheduledResumeIntent = request.supersededScheduledResumeIntent;
  }
  return nextState;
}

function adoptRequest(state, request, currentTime, silentWindowMs) {
  if (shouldStartNewIncident(state, request)) {
    return newIncident(request, currentTime, silentWindowMs);
  }

  if (
    resolvedStatuses.has(state?.status)
    && state.handledRequestAt === request.requestedAt
  ) return state;

  return mergeRequestIntoState(state, request, currentTime);
}

function markManualRepair(state, {
  incidentId,
  outcome,
  now = Date.now(),
  error,
  retryDelayMs = 30 * minute,
} = {}) {
  if (!state || !incidentId || state.incidentId !== incidentId) return state;
  if (!["ok", "failed", "expired"].includes(outcome)) {
    throw new Error(`未知人工修复结果: ${outcome}`);
  }

  return {
    ...state,
    schema,
    status: outcome === "ok" ? "manual-ok" : "auto-retrying",
    nextAttemptAt: outcome === "ok" ? null : iso(now + retryDelayMs),
    updatedAt: iso(now),
    ...(outcome === "ok" ? { completedAt: iso(now) } : {}),
    ...(outcome !== "ok" ? {
      lastManualOutcome: outcome,
      lastManualOutcomeAt: iso(now),
    } : {}),
    ...(error ? { lastFailure: String(error).slice(0, 240) } : {}),
  };
}

function markObservedZhimadiRecovery(state, now = Date.now()) {
  if (
    !state?.incidentId
    || (
      state.status !== "auto-retrying"
      && !terminalUnresolvedStatuses.has(state.status)
    )
  ) {
    return state;
  }

  const nextState = {
    ...state,
    schema,
    status: "observed-ok",
    nextAttemptAt: null,
    completedAt: iso(now),
    updatedAt: iso(now),
  };
  delete nextState.attemptStartedAt;
  return nextState;
}

async function runSingleCaptchaAttempt({
  capture,
  recognize,
  submit,
  confirmAuthenticated,
  isRetryableError = () => false,
}) {
  try {
    const { captchaPath } = await capture();
    const recognized = await recognize(captchaPath);
    const code = String(recognized?.code || "");
    const source = recognized?.source || "none";
    if (!code) return { outcome: "failed", reason: "empty-code", source };

    await submit(code);
    if (!(await confirmAuthenticated())) {
      return {
        outcome: "failed",
        reason: "authentication-not-confirmed",
        source,
      };
    }
    return { outcome: "success", source };
  } catch (error) {
    return {
      outcome: isRetryableError(error) ? "failed" : "fatal",
      reason: "attempt-error",
      error: String(error?.message || error).slice(0, 240),
    };
  }
}

function createZhimadiRepairCoordinator({
  loadState,
  persistState,
  runAttempt,
  escalate,
  now = Date.now,
  silentWindowMs = 3 * 60 * minute,
  retryOffsetsMs = defaultRetryOffsetsMs,
  repeatMs = 30 * minute,
  lockBusyDelayMs = minute,
  manualSessionTtlMs = 5 * minute,
  postDeadlineLockWaitMs = 30 * minute,
  lockStallAlertRetryMs = 6 * 60 * minute,
} = {}) {
  if (typeof loadState !== "function" || typeof persistState !== "function") {
    throw new Error("芝麻地修复协调器缺少状态存储");
  }
  if (typeof runAttempt !== "function" || typeof escalate !== "function") {
    throw new Error("芝麻地修复协调器缺少执行器");
  }

  async function tick(request) {
    if (!request?.requestedAt || parsedTimestamp(request.requestedAt) === null) {
      return { outcome: "no-request" };
    }

    const currentTime = now();
    const previousState = loadState();
    let state = adoptRequest(previousState, request, currentTime, silentWindowMs);
    if (state !== previousState) persistState(state);

    if (state.status === "captcha-sent") {
      const promptStartedAt = parsedTimestamp(
        state.promptSentAt || state.escalationAttemptedAt || state.updatedAt,
      );
      if (promptStartedAt === null || currentTime >= promptStartedAt + manualSessionTtlMs) {
        const anchoredRetryAt = promptStartedAt === null
          ? currentTime
          : promptStartedAt + manualSessionTtlMs + repeatMs;
        state = {
          ...state,
          status: "auto-retrying",
          nextAttemptAt: iso(Math.max(currentTime, anchoredRetryAt)),
          lastManualOutcome: "expired",
          lastManualOutcomeAt: iso(currentTime),
          updatedAt: iso(currentTime),
        };
        persistState(state);
      }
    }

    if (retryablePromptStatuses.has(state.status)) {
      const claimedAt = parsedTimestamp(
        state.status === "escalating"
          ? state.escalationAttemptedAt || state.updatedAt
          : state.escalationFailedAt || state.lastManualOutcomeAt || state.updatedAt,
      );
      const persistedRetryAt = parsedTimestamp(state.nextAttemptAt);
      const anchoredRetryAt = persistedRetryAt
        ?? (claimedAt === null ? currentTime : claimedAt + repeatMs);
      state = {
        ...state,
        status: "auto-retrying",
        nextAttemptAt: iso(Math.max(currentTime, anchoredRetryAt)),
        updatedAt: iso(currentTime),
      };
      persistState(state);
    }

    if (state.status !== "auto-retrying") {
      return { outcome: "inactive", status: state.status, state };
    }

    const startedAtCandidates = [
      parsedTimestamp(state.incidentStartedAt),
      parsedTimestamp(state.incidentId),
      parsedTimestamp(request.requestedAt),
    ];
    const incidentStartedAt = startedAtCandidates.find(
      (candidate) => candidate !== null && candidate <= currentTime,
    ) ?? currentTime;
    const canonicalDeadline = incidentStartedAt + silentWindowMs;
    let deadline = parsedTimestamp(state.deadlineAt);
    if (
      deadline === null
      || deadline < incidentStartedAt
      || deadline > canonicalDeadline
    ) {
      deadline = canonicalDeadline;
      state = {
        ...state,
        incidentStartedAt: iso(incidentStartedAt),
        deadlineAt: iso(deadline),
        updatedAt: iso(currentTime),
      };
      persistState(state);
    }

    let nextAttemptAt = parsedTimestamp(state.nextAttemptAt) ?? currentTime;
    const postPromptRetry = Boolean(
      state.escalationAttemptedAt
      || state.promptSentAt
      || state.promptUnavailableAt
      || state.lastManualOutcomeAt,
    );
    const latestSafeAttemptAt = currentTime < deadline
      ? deadline
      : state.lastFailure === "browser-lock-busy"
        ? currentTime + lockBusyDelayMs
        : postPromptRetry
          ? currentTime + repeatMs
          : currentTime;
    if (nextAttemptAt > latestSafeAttemptAt) {
      nextAttemptAt = latestSafeAttemptAt;
      state = {
        ...state,
        nextAttemptAt: iso(nextAttemptAt),
        updatedAt: iso(currentTime),
      };
      persistState(state);
    }
    if (currentTime < nextAttemptAt) {
      return { outcome: "waiting", nextAttemptAt: state.nextAttemptAt };
    }

    const finalAttempt = currentTime >= deadline;
    state = {
      ...state,
      attemptStartedAt: iso(currentTime),
      updatedAt: iso(currentTime),
    };
    persistState(state);

    let result;
    try {
      result = await runAttempt({
        incidentId: state.incidentId,
        attempt: state.attemptCount + 1,
        finalAttempt,
        afterLoginReport: state.afterLoginReport === true,
      });
    } catch (error) {
      result = {
        outcome: "fatal",
        reason: "attempt-error",
        error: String(error?.message || error).slice(0, 240),
      };
    }

    const finishedAt = now();
    if (result?.outcome === "success") {
      state = {
        ...state,
        status: "auto-ok",
        nextAttemptAt: null,
        attemptCount: state.attemptCount + 1,
        lastAttemptAt: iso(finishedAt),
        completedAt: iso(finishedAt),
        updatedAt: iso(finishedAt),
      };
      delete state.attemptStartedAt;
      delete state.lastFailure;
      persistState(state);
      return { outcome: "success", state };
    }

    if (result?.outcome === "lock-busy") {
      const stalled = finishedAt >= deadline + postDeadlineLockWaitMs;
      const lastLockAlertAttemptAt = parsedTimestamp(state.lockBusyAlertAttemptedAt);
      const claimedStalled = stalled
        && !state.lockBusyAlertSentAt
        && (
          lastLockAlertAttemptAt === null
          || finishedAt - lastLockAlertAttemptAt >= lockStallAlertRetryMs
        );
      const delayedUntil = finishedAt >= deadline
        ? finishedAt + lockBusyDelayMs
        : Math.min(finishedAt + lockBusyDelayMs, deadline);
      state = {
        ...state,
        nextAttemptAt: iso(delayedUntil),
        updatedAt: iso(finishedAt),
        lastFailure: "browser-lock-busy",
        lockBusySince: state.lockBusySince || iso(finishedAt),
        ...(claimedStalled
          ? { lockBusyAlertAttemptedAt: iso(finishedAt) }
          : {}),
      };
      delete state.attemptStartedAt;
      persistState(state);
      return {
        outcome: claimedStalled ? "lock-stalled" : "lock-busy",
        state,
      };
    }

    if (result?.outcome === "fatal") {
      state = {
        ...state,
        status: "fatal",
        nextAttemptAt: null,
        attemptCount: state.attemptCount + 1,
        lastAttemptAt: iso(finishedAt),
        fatalAt: iso(finishedAt),
        fatalAlertAttemptedAt: iso(finishedAt),
        lastFailure: String(result.error || result.reason || "fatal").slice(0, 240),
        updatedAt: iso(finishedAt),
      };
      delete state.attemptStartedAt;
      persistState(state);
      return { outcome: "fatal", state };
    }

    const attemptCount = state.attemptCount + 1;
    const failureText = String(result?.error || result?.reason || "unknown").slice(0, 240);
    if (finishedAt < deadline) {
      const startedAt = parsedTimestamp(state.incidentStartedAt) ?? finishedAt;
      const scheduledAt = Math.min(
        nextScheduledAttempt(startedAt, finishedAt, retryOffsetsMs, repeatMs),
        deadline,
      );
      state = {
        ...state,
        status: "auto-retrying",
        attemptCount,
        lastAttemptAt: iso(finishedAt),
        nextAttemptAt: iso(scheduledAt),
        lastFailure: failureText,
        updatedAt: iso(finishedAt),
      };
      delete state.attemptStartedAt;
      persistState(state);
      return { outcome: "retrying", state };
    }

    if (state.escalationAttemptedAt || state.promptSentAt) {
      state = {
        ...state,
        status: "auto-retrying",
        attemptCount,
        lastAttemptAt: iso(finishedAt),
        nextAttemptAt: iso(finishedAt + repeatMs),
        lastFailure: failureText,
        updatedAt: iso(finishedAt),
      };
      delete state.attemptStartedAt;
      persistState(state);
      return { outcome: "post-prompt-retrying", state };
    }

    state = {
      ...state,
      status: "escalating",
      attemptCount,
      lastAttemptAt: iso(finishedAt),
      nextAttemptAt: null,
      escalationAttemptedAt: iso(finishedAt),
      lastFailure: failureText,
      updatedAt: iso(finishedAt),
    };
    delete state.attemptStartedAt;
    persistState(state);

    let escalation;
    try {
      escalation = await escalate({
        incidentId: state.incidentId,
        afterLoginReport: state.afterLoginReport === true,
        reportResumeMode: state.reportResumeMode,
        reportDate: state.reportDate,
      });
    } catch (error) {
      escalation = {
        outcome: "failed",
        error: String(error?.message || error).slice(0, 240),
      };
    }
    const escalatedAt = now();
    if (escalation?.outcome === "unavailable") {
      state = {
        ...state,
        status: "auto-retrying",
        nextAttemptAt: iso(escalatedAt + repeatMs),
        promptUnavailableAt: iso(escalatedAt),
        updatedAt: iso(escalatedAt),
        lastFailure: String(escalation.error || "prompt-unavailable").slice(0, 240),
      };
      delete state.escalationAttemptedAt;
      persistState(state);
      return { outcome: "prompt-unavailable", state };
    }
    if (escalation?.outcome === "success") {
      state = {
        ...state,
        status: "auto-ok",
        nextAttemptAt: null,
        completedAt: iso(escalatedAt),
        updatedAt: iso(escalatedAt),
      };
      delete state.lastFailure;
      persistState(state);
      return { outcome: "success", state };
    }
    if (escalation?.outcome === "captcha-sent") {
      state = {
        ...state,
        status: "captcha-sent",
        promptSentAt: iso(escalatedAt),
        updatedAt: iso(escalatedAt),
      };
      persistState(state);
      return { outcome: "captcha-sent", state };
    }

    state = {
      ...state,
      status: "auto-retrying",
      nextAttemptAt: iso(escalatedAt + repeatMs),
      escalationFailedAt: iso(escalatedAt),
      updatedAt: iso(escalatedAt),
      lastFailure: String(escalation?.error || "escalation-failed").slice(0, 240),
    };
    persistState(state);
    return { outcome: "escalation-failed", state };
  }

  return { tick };
}

module.exports = {
  activeIncidentId,
  createZhimadiRepairCoordinator,
  markObservedZhimadiRecovery,
  markManualRepair,
  mergedListenerResumeIntent,
  scheduledRequestReplacesState,
  requesterCanResumeReport,
  runSingleCaptchaAttempt,
  zhimadiRepairDeferral,
};
