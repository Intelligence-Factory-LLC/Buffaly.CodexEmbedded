const POLL_INTERVAL_MS = 2000;

const watcherDirectorySelect = document.getElementById("watcherDirectorySelect");
const watcherSessionSelect = document.getElementById("watcherSessionSelect");
const watcherRefreshBtn = document.getElementById("watcherRefreshBtn");
const watcherStatus = document.getElementById("watcherStatus");
const watcherTimeline = document.getElementById("watcherTimeline");

const timeline = new window.CodexSessionTimeline({
  container: watcherTimeline,
  maxRenderedEntries: 1500,
  systemTitle: "Watcher"
});

let sessions = [];
let directoryGroups = []; // [{ key, label, sessions, latestTick }]
let sessionsByDirectory = new Map(); // directoryKey -> sessions[]
let activeDirectoryKey = null;
let activeThreadId = null;
let cursor = null;

let flushTimer = null;
let pollTimer = null;
let pollGeneration = 0;
let pollInFlight = false;

function setStatus(text) {
  watcherStatus.textContent = text;
}

function normalizePath(path) {
  if (!path || typeof path !== "string") {
    return "";
  }

  return path.replace(/\\/g, "/");
}

function getSessionUpdatedTick(session) {
  if (!session || !session.updatedAtUtc) {
    return 0;
  }

  const tick = Date.parse(session.updatedAtUtc);
  return Number.isFinite(tick) ? tick : 0;
}

function getDirectoryInfo(session) {
  const normalizedCwd = normalizePath(session?.cwd || "").replace(/\/+$/g, "");
  if (!normalizedCwd) {
    return { key: "(unknown)", label: "(unknown)" };
  }

  return {
    key: normalizedCwd.toLowerCase(),
    label: normalizedCwd
  };
}

function findDirectoryKeyByThreadId(threadId) {
  if (!threadId) {
    return null;
  }

  for (const group of directoryGroups) {
    if (group.sessions.some((s) => s.threadId === threadId)) {
      return group.key;
    }
  }

  return null;
}

function getDirectoryLabel(directoryKey) {
  if (!directoryKey) {
    return "";
  }

  const group = directoryGroups.find((x) => x.key === directoryKey);
  return group ? group.label : directoryKey;
}

function rebuildDirectoryGroups() {
  const map = new Map();
  for (const session of sessions) {
    const info = getDirectoryInfo(session);
    if (!map.has(info.key)) {
      map.set(info.key, {
        key: info.key,
        label: info.label,
        sessions: [],
        latestTick: 0
      });
    }

    const group = map.get(info.key);
    group.sessions.push(session);
    const tick = getSessionUpdatedTick(session);
    if (tick > group.latestTick) {
      group.latestTick = tick;
    }
  }

  const groups = Array.from(map.values());
  for (const group of groups) {
    group.sessions.sort((a, b) => {
      const tickCompare = getSessionUpdatedTick(b) - getSessionUpdatedTick(a);
      if (tickCompare !== 0) return tickCompare;
      return (a.threadId || "").localeCompare(b.threadId || "");
    });
  }

  groups.sort((a, b) => {
    const tickCompare = b.latestTick - a.latestTick;
    if (tickCompare !== 0) return tickCompare;
    return a.label.localeCompare(b.label);
  });

  directoryGroups = groups;
  sessionsByDirectory = new Map(groups.map((group) => [group.key, group.sessions]));
}

function getSessionByThreadId(threadId) {
  return sessions.find((s) => s.threadId === threadId) || null;
}

function updateSessionSelectForActiveDirectory(preferredThreadId = null) {
  const previous = watcherSessionSelect.value;
  watcherSessionSelect.textContent = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "(select session)";
  watcherSessionSelect.appendChild(placeholder);

  const scopedSessions = activeDirectoryKey && sessionsByDirectory.has(activeDirectoryKey)
    ? sessionsByDirectory.get(activeDirectoryKey)
    : [];

  for (const session of scopedSessions) {
    const option = document.createElement("option");
    option.value = session.threadId || "";
    const threadLabel = session.threadName || (session.threadId || "unknown").slice(0, 12);
    const updated = session.updatedAtUtc ? ` | ${new Date(session.updatedAtUtc).toLocaleString()}` : "";
    option.textContent = `${threadLabel}${updated}`;
    option.title = `thread=${session.threadId || "unknown"} cwd=${session.cwd || "(unknown)"}`;
    watcherSessionSelect.appendChild(option);
  }

  let nextThreadId = null;
  if (preferredThreadId && scopedSessions.some((s) => s.threadId === preferredThreadId)) {
    nextThreadId = preferredThreadId;
  } else if (previous && scopedSessions.some((s) => s.threadId === previous)) {
    nextThreadId = previous;
  } else if (scopedSessions.length > 0) {
    nextThreadId = scopedSessions[0].threadId || null;
  }

  activeThreadId = nextThreadId;
  watcherSessionSelect.value = nextThreadId || "";
}

function updateDirectoryAndSessionSelects(preferredDirectoryKey = null, preferredThreadId = null) {
  const previousDirectory = watcherDirectorySelect.value;
  watcherDirectorySelect.textContent = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "(select directory)";
  watcherDirectorySelect.appendChild(placeholder);

  for (const group of directoryGroups) {
    const option = document.createElement("option");
    option.value = group.key;
    option.textContent = `${group.label} (${group.sessions.length})`;
    watcherDirectorySelect.appendChild(option);
  }

  let nextDirectory = null;
  if (preferredDirectoryKey && sessionsByDirectory.has(preferredDirectoryKey)) {
    nextDirectory = preferredDirectoryKey;
  } else if (preferredThreadId) {
    nextDirectory = findDirectoryKeyByThreadId(preferredThreadId);
  } else if (previousDirectory && sessionsByDirectory.has(previousDirectory)) {
    nextDirectory = previousDirectory;
  } else if (directoryGroups.length > 0) {
    nextDirectory = directoryGroups[0].key;
  }

  activeDirectoryKey = nextDirectory;
  watcherDirectorySelect.value = nextDirectory || "";
  updateSessionSelectForActiveDirectory(preferredThreadId);
}

async function refreshSessionList() {
  const previousThreadId = activeThreadId;
  const previousDirectoryKey = activeDirectoryKey;

  const sessionsUrl = new URL("api/logs/sessions", document.baseURI);
  sessionsUrl.searchParams.set("limit", "20");
  const response = await fetch(sessionsUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`failed loading sessions (${response.status})`);
  }

  const data = await response.json();
  sessions = Array.isArray(data.sessions) ? data.sessions : [];
  rebuildDirectoryGroups();
  updateDirectoryAndSessionSelects(previousDirectoryKey, previousThreadId);
}

async function pollOnce(initial, generation) {
  if (pollInFlight) {
    return;
  }

  pollInFlight = true;
  try {
    if (!activeThreadId) {
      const directoryLabel = getDirectoryLabel(activeDirectoryKey);
      if (directoryLabel) {
        setStatus(`Watcher: no session selected in ${directoryLabel}.`);
      } else {
        setStatus("Watcher: no session selected.");
      }
      return;
    }

    const url = new URL("api/logs/watch", document.baseURI);
    url.searchParams.set("threadId", activeThreadId);
    url.searchParams.set("maxLines", "200");
    if (initial || cursor === null) {
      url.searchParams.set("initial", "true");
    } else {
      url.searchParams.set("cursor", String(cursor));
    }

    const response = await fetch(url, { cache: "no-store" });
    if (generation !== pollGeneration) {
      return;
    }

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`watch failed (${response.status}): ${detail}`);
    }

    const data = await response.json();
    if (generation !== pollGeneration) {
      return;
    }

    if (initial || data.reset === true) {
      timeline.clear();
      if (data.reset === true) {
        timeline.enqueueSystem("session file was reset or rotated");
      }
    }

    cursor = typeof data.nextCursor === "number" ? data.nextCursor : cursor;
    timeline.enqueueParsedLines(Array.isArray(data.lines) ? data.lines : []);
    if (data.truncated === true) {
      timeline.enqueueSystem("tail update truncated to latest lines");
    }

    const session = getSessionByThreadId(activeThreadId);
    const directoryLabel = getDirectoryLabel(activeDirectoryKey);
    const label = session?.threadName || activeThreadId;
    setStatus(`Watcher: ${directoryLabel ? `${directoryLabel} / ` : ""}${label} | reconstructed updates every 2 seconds`);
  } finally {
    pollInFlight = false;
  }
}

function restartPolling() {
  pollGeneration += 1;
  const generation = pollGeneration;

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  pollOnce(true, generation).catch((error) => {
    timeline.enqueueSystem(`[error] ${error}`);
    setStatus("Watcher error.");
  });

  pollTimer = setInterval(() => {
    pollOnce(false, generation).catch((error) => {
      timeline.enqueueSystem(`[error] ${error}`);
      setStatus("Watcher error.");
    });
  }, POLL_INTERVAL_MS);
}

watcherRefreshBtn.addEventListener("click", async () => {
  try {
    await refreshSessionList();
    cursor = null;
    timeline.clear();
    restartPolling();
  } catch (error) {
    timeline.enqueueSystem(`[error] ${error}`);
    setStatus("Unable to refresh sessions.");
  }
});

watcherDirectorySelect.addEventListener("change", () => {
  activeDirectoryKey = watcherDirectorySelect.value || null;
  updateSessionSelectForActiveDirectory(null);
  cursor = null;
  timeline.clear();
  restartPolling();
});

watcherSessionSelect.addEventListener("change", () => {
  activeThreadId = watcherSessionSelect.value || null;
  cursor = null;
  timeline.clear();
  restartPolling();
});

flushTimer = setInterval(() => timeline.flush(), POLL_INTERVAL_MS);

(async () => {
  setStatus("Loading recent sessions...");
  try {
    await refreshSessionList();
    restartPolling();
  } catch (error) {
    timeline.enqueueSystem(`[error] ${error}`);
    setStatus("Watcher initialization failed.");
  }
})();
