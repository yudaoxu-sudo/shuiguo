const marker = "HEALTHCHECK_FAILURE_JSON=";

function finalHealthFailureMessage(error) {
  return String(error?.healthFailureMessage || error?.message || error);
}

function writeHealthFailure(error) {
  if (process.env.HEALTHCHECK_PREVIEW !== "1") return;
  console.error(`${marker}${JSON.stringify({
    message: finalHealthFailureMessage(error).slice(0, 4000),
  })}`);
}

function extractHealthFailure(output) {
  const line = String(output)
    .split(/\r?\n/)
    .reverse()
    .find((value) => value.startsWith(marker));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice(marker.length));
    return typeof parsed.message === "string" ? parsed.message : null;
  } catch {
    return null;
  }
}

module.exports = {
  extractHealthFailure,
  finalHealthFailureMessage,
  writeHealthFailure,
};
