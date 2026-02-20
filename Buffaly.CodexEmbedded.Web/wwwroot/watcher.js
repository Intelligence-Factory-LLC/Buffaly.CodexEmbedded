const POLL_INTERVAL_MS = 2000;
const MAX_RENDERED_ENTRIES = 1500;
const MAX_TEXT_CHARS = 5000;
const ANSI_ESCAPE_REGEX = /\u001b\[[0-9;]*[A-Za-z]/g;

const watcherDirectorySelect = document.getElementById("watcherDirectorySelect");
const watcherSessionSelect = document.getElementById("watcherSessionSelect");
const watcherRefreshBtn = document.getElementById("watcherRefreshBtn");
const watcherStatus = document.getElementById("watcherStatus");
const watcherTimeline = document.getElementById("watcherTimeline");

let sessions = [];
let directoryGroups = []; // [{ key, label, sessions, latestTick }]
let sessionsByDirectory = new Map(); // directoryKey -> sessions[]
let activeDirectoryKey = null;
let activeThreadId = null;
let cursor = null;

let pendingEntries = [];
const pendingUpdatedEntries = new Map();
let renderCount = 0;
let nextEntryId = 1;

const entryNodeById = new Map(); // entryId -> { card, body, time }
const toolEntriesByCallId = new Map(); // callId -> entry

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

function normalizeText(text) {
  if (!text) {
    return "";
  }

  return String(text)
    .replace(/\r/g, "")
    .replace(ANSI_ESCAPE_REGEX, "")
    .trimEnd();
}

function truncateText(text, maxLength = MAX_TEXT_CHARS) {
  const normalized = normalizeText(text);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}\n... (truncated)`;
}

function createEntry(role, title, text, timestamp, rawType) {
  return {
    id: nextEntryId++,
    role,
    title,
    text: text || "",
    timestamp: timestamp || null,
    rawType: rawType || "",
    rendered: false
  };
}

function createToolEntry(title, timestamp, rawType, toolName, callId, command, details, output) {
  return {
    id: nextEntryId++,
    role: "tool",
    title,
    timestamp: timestamp || null,
    rawType: rawType || "",
    rendered: false,
    kind: "tool",
    toolName: toolName || null,
    callId: callId || null,
    command: command || "",
    details: Array.isArray(details) ? details : [],
    output: output || ""
  };
}

function clearTimeline() {
  pendingEntries = [];
  pendingUpdatedEntries.clear();
  renderCount = 0;
  watcherTimeline.textContent = "";
  entryNodeById.clear();
  toolEntriesByCallId.clear();
}

function getSessionByThreadId(threadId) {
  return sessions.find((s) => s.threadId === threadId) || null;
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

  // Group by working directory path, case-insensitively.
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

function tryParseJson(text) {
  if (!text || typeof text !== "string") {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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

  return normalizeText(chunks.join("\n"));
}

function extractToolCommand(name, argsObject, rawArguments) {
  if (name === "shell_command" && argsObject && typeof argsObject.command === "string") {
    return normalizeText(argsObject.command);
  }

  if (name === "multi_tool_use.parallel" && argsObject && Array.isArray(argsObject.tool_uses)) {
    const commands = [];
    for (let i = 0; i < argsObject.tool_uses.length; i++) {
      const use = argsObject.tool_uses[i] || {};
      const recipient = use.recipient_name || "unknown_tool";
      const parameters = use.parameters || {};

      if (recipient === "functions.shell_command" && typeof parameters.command === "string") {
        commands.push(`[${i + 1}] shell_command: ${normalizeText(parameters.command)}`);
        continue;
      }

      commands.push(`[${i + 1}] ${recipient}`);
    }

    if (commands.length > 0) {
      return commands.join("\n");
    }
  }

  if (argsObject && typeof argsObject.command === "string") {
    return normalizeText(argsObject.command);
  }

  if (typeof rawArguments === "string" && rawArguments.trim().length > 0) {
    return truncateText(rawArguments, 1200);
  }

  return "";
}

function extractToolDetails(argsObject) {
  if (!argsObject || typeof argsObject !== "object") {
    return [];
  }

  const lines = [];
  if (typeof argsObject.workdir === "string" && argsObject.workdir.trim().length > 0) {
    lines.push(`workdir=${argsObject.workdir}`);
  }
  if (typeof argsObject.timeout_ms === "number") {
    lines.push(`timeoutMs=${argsObject.timeout_ms}`);
  }
  if (typeof argsObject.login === "boolean") {
    lines.push(`login=${argsObject.login}`);
  }
  if (typeof argsObject.sandbox_permissions === "string" && argsObject.sandbox_permissions.trim().length > 0) {
    lines.push(`sandbox=${argsObject.sandbox_permissions}`);
  }

  return lines;
}

function toSimpleValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value, null, 2);
}

function formatMetadataLines(metadata, excludedKeys = []) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return [];
  }

  const excluded = new Set(excludedKeys);
  const lines = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (excluded.has(key)) {
      continue;
    }
    const text = toSimpleValue(value);
    if (text === null || text === "") {
      continue;
    }
    lines.push(`${key}: ${text}`);
  }

  return lines;
}

function formatToolOutput(toolName, rawOutput) {
  if (rawOutput === null || rawOutput === undefined) {
    return "";
  }

  let parsed = null;
  if (typeof rawOutput === "string") {
    parsed = tryParseJson(rawOutput.trim());
  } else if (typeof rawOutput === "object") {
    parsed = rawOutput;
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const lines = [];

    const metadata = parsed.metadata && typeof parsed.metadata === "object" ? parsed.metadata : null;
    const status = typeof parsed.status === "string"
      ? parsed.status
      : parsed.success === true
        ? "success"
        : parsed.success === false
          ? "failed"
          : null;
    const exitCode = parsed.exit_code ?? parsed.exitCode ?? metadata?.exit_code ?? metadata?.exitCode ?? null;
    const durationSeconds = parsed.duration_seconds ?? parsed.durationSeconds ?? metadata?.duration_seconds ?? metadata?.durationSeconds ?? null;

    const summaryParts = [];
    if (toolName) summaryParts.push(`tool=${toolName}`);
    if (status) summaryParts.push(`status=${status}`);
    if (exitCode !== null && exitCode !== undefined) summaryParts.push(`exitCode=${exitCode}`);
    if (typeof durationSeconds === "number") summaryParts.push(`durationSeconds=${durationSeconds}`);
    if (summaryParts.length > 0) {
      lines.push("Summary:");
      lines.push(summaryParts.join(" | "));
      lines.push("");
    }

    const outputText = toSimpleValue(parsed.output);
    if (outputText) {
      lines.push("Output:");
      lines.push(outputText);
      lines.push("");
    }

    const stdoutText = toSimpleValue(parsed.stdout);
    if (stdoutText) {
      lines.push("Stdout:");
      lines.push(stdoutText);
      lines.push("");
    }

    const stderrText = toSimpleValue(parsed.stderr);
    if (stderrText) {
      lines.push("Stderr:");
      lines.push(stderrText);
      lines.push("");
    }

    const errorText = toSimpleValue(parsed.error);
    if (errorText) {
      lines.push("Error:");
      lines.push(errorText);
      lines.push("");
    }

    const metadataLines = formatMetadataLines(metadata, ["exit_code", "exitCode", "duration_seconds", "durationSeconds"]);
    if (metadataLines.length > 0) {
      lines.push("Metadata:");
      for (const line of metadataLines) {
        lines.push(line);
      }
      lines.push("");
    }

    if (lines.length > 0) {
      return truncateText(lines.join("\n"));
    }
  }

  if (typeof rawOutput === "string") {
    return truncateText(rawOutput);
  }

  return truncateText(JSON.stringify(rawOutput, null, 2));
}

function formatToolEntryText(entry) {
  const lines = [];
  lines.push("Command:");
  lines.push(entry.command || "(command unavailable)");

  if (entry.details && entry.details.length > 0) {
    lines.push("");
    lines.push("Context:");
    for (const detail of entry.details) {
      lines.push(detail);
    }
  }

  lines.push("");
  lines.push("Result:");
  lines.push(entry.output ? entry.output : "(waiting for output)");
  return lines.join("\n");
}

function getEntryBodyText(entry) {
  if (entry.kind === "tool") {
    return formatToolEntryText(entry);
  }

  return entry.text || "";
}

function queueEntryUpdate(entry) {
  if (!entry || !entry.rendered) {
    return;
  }

  pendingUpdatedEntries.set(entry.id, entry);
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

    // Skip developer/system scaffolding to keep the watcher focused on dialogue + tools.
    return null;
  }

  if (payload.type === "function_call" || payload.type === "custom_tool_call") {
    const name = payload.name || "tool";
    const rawArgs = typeof payload.arguments === "string"
      ? payload.arguments
      : typeof payload.input === "string"
        ? payload.input
        : "";
    const argsObject = tryParseJson(rawArgs);

    const command = extractToolCommand(name, argsObject, rawArgs);
    const details = extractToolDetails(argsObject);
    const entry = createToolEntry(`Tool Call: ${name}`, timestamp, payload.type, name, payload.call_id || null, command, details, "");

    if (entry.callId) {
      toolEntriesByCallId.set(entry.callId, entry);
    }
    return entry;
  }

  if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
    const callId = payload.call_id || null;
    const rawOutput = payload.output ?? payload.result ?? payload.content ?? null;
    const output = formatToolOutput(null, rawOutput);

    if (callId && toolEntriesByCallId.has(callId)) {
      const entry = toolEntriesByCallId.get(callId);
      if (entry) {
        entry.output = formatToolOutput(entry.toolName, rawOutput) || entry.output;
        entry.timestamp = timestamp || entry.timestamp;
        queueEntryUpdate(entry);
      }
      return null;
    }

    return createToolEntry("Tool Output", timestamp, payload.type, null, callId, "", [], output);
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

    return createEntry("reasoning", "Reasoning Summary", truncateText(summary, 1200), timestamp, payload.type);
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
    return null;
  }

  return createEntry("system", `Event: ${eventType || "unknown"}`, truncateText(String(message), 1200), timestamp, eventType);
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

function removeToolMappingsForEntryId(entryId) {
  for (const [callId, entry] of toolEntriesByCallId.entries()) {
    if (entry.id === entryId) {
      toolEntriesByCallId.delete(callId);
    }
  }
}

function appendEntryNode(entry) {
  const card = document.createElement("article");
  card.className = `watcher-entry ${entry.role}`;
  card.dataset.entryId = String(entry.id);

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

  const bodyText = getEntryBodyText(entry);
  let body = null;
  if (bodyText) {
    body = document.createElement("pre");
    body.className = "watcher-entry-text";
    body.textContent = bodyText;
    card.appendChild(body);
  }

  watcherTimeline.appendChild(card);
  entry.rendered = true;
  renderCount += 1;
  entryNodeById.set(entry.id, { card, body, time });

  while (renderCount > MAX_RENDERED_ENTRIES && watcherTimeline.firstElementChild) {
    const oldest = watcherTimeline.firstElementChild;
    const oldestId = Number(oldest.getAttribute("data-entry-id"));
    watcherTimeline.removeChild(oldest);
    renderCount -= 1;

    if (Number.isFinite(oldestId)) {
      entryNodeById.delete(oldestId);
      removeToolMappingsForEntryId(oldestId);
    }
  }
}

function updateEntryNode(entry) {
  const node = entryNodeById.get(entry.id);
  if (!node) {
    return;
  }

  const bodyText = getEntryBodyText(entry);
  if (!node.body && bodyText) {
    const body = document.createElement("pre");
    body.className = "watcher-entry-text";
    body.textContent = bodyText;
    node.card.appendChild(body);
    node.body = body;
  } else if (node.body) {
    node.body.textContent = bodyText;
  }

  node.time.textContent = formatTime(entry.timestamp);
}

function flushPending() {
  if (pendingEntries.length === 0 && pendingUpdatedEntries.size === 0) {
    return;
  }

  if (pendingEntries.length > 0) {
    for (const entry of pendingEntries) {
      appendEntryNode(entry);
    }
    pendingEntries = [];
  }

  if (pendingUpdatedEntries.size > 0) {
    for (const entry of pendingUpdatedEntries.values()) {
      updateEntryNode(entry);
    }
    pendingUpdatedEntries.clear();
  }

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

watcherDirectorySelect.addEventListener("change", () => {
  activeDirectoryKey = watcherDirectorySelect.value || null;
  updateSessionSelectForActiveDirectory(null);
  cursor = null;
  clearTimeline();
  restartPolling();
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
