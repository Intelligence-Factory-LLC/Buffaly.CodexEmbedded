const POLL_INTERVAL_MS = 2000;
const MAX_RENDERED_LINES = 5000;

const logsStatus = document.getElementById("logsStatus");
const logsOutput = document.getElementById("logsOutput");

let cursor = null;
let logFile = null;

let renderedLines = [];
let pendingLines = [];

let flushTimer = null;
let pollTimer = null;
let pollGeneration = 0;
let pollInFlight = false;

function setStatus(text) {
  logsStatus.textContent = text;
}

function clearOutput() {
  renderedLines = [];
  pendingLines = [];
  logsOutput.textContent = "";
}

function enqueueSystem(text) {
  pendingLines.push(`${new Date().toISOString()} ${text}`);
}

function enqueueLines(lines) {
  for (const line of lines) {
    pendingLines.push(line);
  }
}

function flushPending() {
  if (pendingLines.length === 0) {
    return;
  }

  renderedLines.push(...pendingLines);
  pendingLines = [];

  if (renderedLines.length > MAX_RENDERED_LINES) {
    renderedLines = renderedLines.slice(renderedLines.length - MAX_RENDERED_LINES);
  }

  logsOutput.textContent = renderedLines.join("\n");
  logsOutput.scrollTop = logsOutput.scrollHeight;
}

async function pollOnce(initial, generation) {
  if (pollInFlight) {
    return;
  }

  pollInFlight = true;
  try {
    const url = new URL("/api/logs/realtime/current", window.location.origin);
    url.searchParams.set("maxLines", "200");
    if (initial || cursor === null) {
      url.searchParams.set("initial", "true");
    } else {
      url.searchParams.set("cursor", String(cursor));
    }
    if (logFile) {
      url.searchParams.set("logFile", logFile);
    }

    const response = await fetch(url, { cache: "no-store" });
    if (generation !== pollGeneration) {
      return;
    }

    if (response.status === 404) {
      setStatus("Realtime Logs: waiting for an active session log...");
      return;
    }

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`realtime watch failed (${response.status}): ${detail}`);
    }

    const data = await response.json();
    if (generation !== pollGeneration) {
      return;
    }

    const fileChanged = !!logFile && logFile !== data.logFile;
    if (initial || data.reset === true || fileChanged) {
      clearOutput();
      if (fileChanged) {
        enqueueSystem(`[watch] switched to ${data.logFile}`);
      }
    }

    logFile = data.logFile || logFile;
    cursor = typeof data.nextCursor === "number" ? data.nextCursor : cursor;

    const lines = Array.isArray(data.lines) ? data.lines : [];
    enqueueLines(lines);
    if (data.truncated === true) {
      enqueueSystem("[watch] update truncated to latest lines");
    }

    setStatus(`Realtime Logs: ${logFile || "(unknown)"} | update every 2 seconds`);
  } finally {
    pollInFlight = false;
  }
}

function startPolling() {
  pollGeneration += 1;
  const generation = pollGeneration;

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  pollOnce(true, generation).catch((error) => {
    enqueueSystem(`[error] ${error}`);
    setStatus("Realtime watcher error.");
  });

  pollTimer = setInterval(() => {
    pollOnce(false, generation).catch((error) => {
      enqueueSystem(`[error] ${error}`);
      setStatus("Realtime watcher error.");
    });
  }, POLL_INTERVAL_MS);
}

flushTimer = setInterval(flushPending, POLL_INTERVAL_MS);
startPolling();
