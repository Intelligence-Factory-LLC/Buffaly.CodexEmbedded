const POLL_INTERVAL_MS = 2000;
const MAX_RENDERED_ENTRIES = 1500;
const MAX_TOOL_TEXT = 1200;

const watcherSessionSelect = document.getElementById("watcherSessionSelect");
const watcherRefreshBtn = document.getElementById("watcherRefreshBtn");
const watcherStatus = document.getElementById("watcherStatus");
const watcherTimeline = document.getElementById("watcherTimeline");

let sessions = [];
let activeThreadId = null;
let cursor = null;

let pendingEntries = [];
let renderCount = 0;

let flushTimer = null;
let pollTimer = null;
let pollGeneration = 0;
let pollInFlight = false;

function setStatus(text) {
  watcherStatus.textContent = text;
}

function formatTime(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function clearTimeline() {
  pendingEntries = [];
  renderCount = 0;
  watcherTimeline.textContent = "";
}

function getSessionByThreadId(threadId) {
  return sessions.find((s) => s.threadId === threadId) || null;
}

function truncateText(text, maxLength = MAX_TOOL_TEXT) {
  if (!text) {
    return "";
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n... (truncated)`;
}

function extractMessageText(contentItems) {
  if (!Array.isArray(contentItems)) {
    return "";
  }

  const chunks = [];
  for (const item of contentItems) {
    if (!item || typeof item !== "object") {
      continue;
    }

    if (typeof item.text === "string" && item.text.trim().length > 0) {
      chunks.push(item.text);
      continue;
    }

    if (item.type && typeof item.type === "string") {
      chunks.push(`[${item.type}]`);
    }
  }

  return chunks.join("\n").trim();
}

function createEntry(role, title, text, timestamp, rawType) {
  return {
    role,
    title,
    text: text || "",
    timestamp: timestamp || null,
    rawType: rawType || ""
  };
}

function parseResponseItem(timestamp, payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (payload.type === "message") {
    const role = payload.role || "system";
    const text = extractMessageText(payload.content);
    if (!text) {
      return null;
    }

    if (role === "assistant") {
      const phase = payload.phase ? ` (${payload.phase})` : "";
      return createEntry("assistant", `Assistant${phase}`, text, timestamp, payload.type);
    }

    if (role === "user") {
      return createEntry("user", "User", text, timestamp, payload.type);
    }

    if (role === "developer" || role === "system") {
      return createEntry("system", role === "developer" ? "Developer Context" : "System", truncateText(text, 800), timestamp, payload.type);
    }

    return createEntry("system", role, truncateText(text, 800), timestamp, payload.type);
  }

  if (payload.type === "function_call" || payload.type === "custom_tool_call") {
    const name = payload.name || "tool";
    const args = payload.arguments || payload.input || "";
    const text = truncateText(typeof args === "string" ? args : JSON.stringify(args, null, 2));
    return createEntry("tool", `Tool Call: ${name}`, text, timestamp, payload.type);
  }

  if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
    const output = payload.output || payload.content || payload.result || "";
    const text = truncateText(typeof output === "string" ? output : JSON.stringify(output, null, 2));
    const id = payload.call_id ? ` (${payload.call_id})` : "";
    return createEntry("tool", `Tool Output${id}`, text, timestamp, payload.type);
  }

  if (payload.type === "reasoning") {
    let summary = "";
    if (Array.isArray(payload.summary)) {
      const lines = [];
      for (const item of payload.summary) {
        if (item && typeof item.text === "string" && item.text.trim().length > 0) {
          lines.push(item.text.trim());
        }
      }
      summary = lines.join("\n");
    }

    if (!summary && typeof payload.content === "string") {
      summary = payload.content;
    }

    if (!summary) {
      return null;
    }

    return createEntry("reasoning", "Reasoning Summary", truncateText(summary, 1000), timestamp, payload.type);
  }

  return null;
}

function parseEventMsg(timestamp, payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const eventType = payload.type || "";
  if (eventType === "token_count" || eventType === "agent_message" || eventType === "user_message" || eventType === "agent_reasoning") {
    return null;
  }

  if (eventType === "task_started") {
    return createEntry("system", "Task Started", payload.title || payload.message || "", timestamp, eventType);
  }

  if (eventType === "task_complete") {
    return createEntry("system", "Task Complete", payload.message || "", timestamp, eventType);
  }

  const message = payload.message || payload.summary || "";
  if (!message) {
    return createEntry("system", `Event: ${eventType || "unknown"}`, "", timestamp, eventType);
  }

  return createEntry("system", `Event: ${eventType || "unknown"}`, truncateText(String(message), 800), timestamp, eventType);
}

function parseLine(line) {
  let root;
  try {
    root = JSON.parse(line);
  } catch {
    return createEntry("system", "Invalid JSONL Line", truncateText(line, 800), null, "invalid_json");
  }

  const timestamp = root.timestamp || null;
  const type = root.type || "";

  if (type === "session_meta") {
    const payload = root.payload || {};
    const details = [];
    if (payload.id) details.push(`thread=${payload.id}`);
    if (payload.model_provider) details.push(`provider=${payload.model_provider}`);
    if (payload.cwd) details.push(`cwd=${payload.cwd}`);
    return createEntry("system", "Session Meta", details.join(" | "), timestamp, type);
  }

  if (type === "turn_context") {
    const payload = root.payload || {};
    const details = [];
    if (payload.turn_id) details.push(`turn=${payload.turn_id}`);
    if (payload.model) details.push(`model=${payload.model}`);
    if (payload.cwd) details.push(`cwd=${payload.cwd}`);
    return createEntry("system", "Turn Context", details.join(" | "), timestamp, type);
  }

  if (type === "response_item") {
    return parseResponseItem(timestamp, root.payload || {});
  }

  if (type === "event_msg") {
    return parseEventMsg(timestamp, root.payload || {});
  }

  return null;
}

function appendEntryNode(entry) {
  const card = document.createElement("article");
  card.className = `watcher-entry ${entry.role}`;

  const header = document.createElement("div");
  header.className = "watcher-entry-header";

  const title = document.createElement("div");
  title.className = "watcher-entry-title";
  title.textContent = entry.title || entry.role;

  const time = document.createElement("div");
  time.className = "watcher-entry-time";
  time.textContent = formatTime(entry.timestamp);

  header.appendChild(title);
  header.appendChild(time);
  card.appendChild(header);

  if (entry.text) {
    const body = document.createElement("pre");
    body.className = "watcher-entry-text";
    body.textContent = entry.text;
    card.appendChild(body);
  }

  watcherTimeline.appendChild(card);
  renderCount += 1;

  while (renderCount > MAX_RENDERED_ENTRIES && watcherTimeline.firstChild) {
    watcherTimeline.removeChild(watcherTimeline.firstChild);
    renderCount -= 1;
  }
}

function flushPending() {
  if (pendingEntries.length === 0) {
    return;
  }

  for (const entry of pendingEntries) {
    appendEntryNode(entry);
  }
  pendingEntries = [];
  watcherTimeline.scrollTop = watcherTimeline.scrollHeight;
}

function enqueueSystem(text) {
  pendingEntries.push(createEntry("system", "Watcher", text, new Date().toISOString(), "watcher"));
}

function enqueueParsedLines(lines) {
  for (const line of lines) {
    const entry = parseLine(line);
    if (entry) {
      pendingEntries.push(entry);
    }
  }
}

function updateSessionSelect() {
  const previous = watcherSessionSelect.value;
  watcherSessionSelect.textContent = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "(select session)";
  watcherSessionSelect.appendChild(placeholder);

  for (const session of sessions) {
    const option = document.createElement("option");
    option.value = session.threadId || "";
    const parts = [];
    if (session.threadName) parts.push(session.threadName);
    parts.push((session.threadId || "unknown").slice(0, 12));
    if (session.updatedAtUtc) parts.push(new Date(session.updatedAtUtc).toLocaleString());
    option.textContent = parts.join(" | ");
    watcherSessionSelect.appendChild(option);
  }

  if (previous && sessions.some((s) => s.threadId === previous)) {
    watcherSessionSelect.value = previous;
    activeThreadId = previous;
    return;
  }

  const first = sessions.length > 0 ? sessions[0].threadId : null;
  activeThreadId = first;
  watcherSessionSelect.value = first || "";
}

async function refreshSessionList() {
  const response = await fetch("/api/logs/sessions?limit=10", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`failed loading sessions (${response.status})`);
  }

  const data = await response.json();
  sessions = Array.isArray(data.sessions) ? data.sessions : [];
  updateSessionSelect();
}

async function pollOnce(initial, generation) {
  if (pollInFlight) {
    return;
  }

  pollInFlight = true;
  try {
    if (!activeThreadId) {
      setStatus("Watcher: no session selected.");
      return;
    }

    const url = new URL("/api/logs/watch", window.location.origin);
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
      clearTimeline();
      if (data.reset === true) {
        enqueueSystem("session file was reset or rotated");
      }
    }

    cursor = typeof data.nextCursor === "number" ? data.nextCursor : cursor;
    const lines = Array.isArray(data.lines) ? data.lines : [];
    enqueueParsedLines(lines);
    if (data.truncated === true) {
      enqueueSystem("tail update truncated to latest lines");
    }

    const session = getSessionByThreadId(activeThreadId);
    const label = session?.threadName || activeThreadId;
    setStatus(`Watcher: ${label} | reconstructed updates every 2 seconds`);
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
    enqueueSystem(`[error] ${error}`);
    setStatus("Watcher error.");
  });

  pollTimer = setInterval(() => {
    pollOnce(false, generation).catch((error) => {
      enqueueSystem(`[error] ${error}`);
      setStatus("Watcher error.");
    });
  }, POLL_INTERVAL_MS);
}

watcherRefreshBtn.addEventListener("click", async () => {
  try {
    await refreshSessionList();
    cursor = null;
    clearTimeline();
    restartPolling();
  } catch (error) {
    enqueueSystem(`[error] ${error}`);
    setStatus("Unable to refresh sessions.");
  }
});

watcherSessionSelect.addEventListener("change", () => {
  activeThreadId = watcherSessionSelect.value || null;
  cursor = null;
  clearTimeline();
  restartPolling();
});

flushTimer = setInterval(flushPending, POLL_INTERVAL_MS);

(async () => {
  setStatus("Loading recent sessions...");
  try {
    await refreshSessionList();
    restartPolling();
  } catch (error) {
    enqueueSystem(`[error] ${error}`);
    setStatus("Watcher initialization failed.");
  }
})();
