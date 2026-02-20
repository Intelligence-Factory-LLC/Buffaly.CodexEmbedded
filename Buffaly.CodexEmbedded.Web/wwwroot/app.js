const TIMELINE_POLL_INTERVAL_MS = 2000;

let socket = null;
let socketReadyPromise = null;

let sessions = new Map(); // sessionId -> { threadId, cwd, model }
let sessionCatalog = []; // [{ threadId, threadName, updatedAtUtc, cwd, model, sessionFilePath }]
let activeSessionId = null;
let pendingApproval = null; // { sessionId, approvalId }
let promptQueuesBySession = new Map(); // sessionId -> [{ text, images }]
let turnInFlightBySession = new Map(); // sessionId -> boolean
let lastSentPromptBySession = new Map(); // sessionId -> string
let pendingComposerImages = [];
let nextComposerImageId = 1;

let timelineCursor = null;
let timelinePollTimer = null;
let timelineFlushTimer = null;
let timelinePollGeneration = 0;
let timelinePollInFlight = false;

const STORAGE_CWD_KEY = "codex-web-cwd";
const STORAGE_LOG_VERBOSITY_KEY = "codex-web-log-verbosity";
const MAX_QUEUE_PREVIEW = 3;
const MAX_QUEUE_TEXT_CHARS = 90;
const MAX_COMPOSER_IMAGES = 4;
const MAX_COMPOSER_IMAGE_BYTES = 8 * 1024 * 1024;

const chatMessages = document.getElementById("chatMessages");
const logOutput = document.getElementById("logOutput");
const promptForm = document.getElementById("promptForm");
const promptInput = document.getElementById("promptInput");
const promptQueue = document.getElementById("promptQueue");
const composerImages = document.getElementById("composerImages");
const imageUploadInput = document.getElementById("imageUploadInput");
const imageUploadBtn = document.getElementById("imageUploadBtn");

const newSessionBtn = document.getElementById("newSessionBtn");
const attachSessionBtn = document.getElementById("attachSessionBtn");
const existingSessionSelect = document.getElementById("existingSessionSelect");
const stopSessionBtn = document.getElementById("stopSessionBtn");
const sessionSelect = document.getElementById("sessionSelect");
const sessionMeta = document.getElementById("sessionMeta");

const logVerbositySelect = document.getElementById("logVerbositySelect");
const modelSelect = document.getElementById("modelSelect");
const modelCustomInput = document.getElementById("modelCustomInput");
const reloadModelsBtn = document.getElementById("reloadModelsBtn");
const cwdInput = document.getElementById("cwdInput");

const approvalPanel = document.getElementById("approvalPanel");
const approvalSummary = document.getElementById("approvalSummary");
const approvalDetails = document.getElementById("approvalDetails");
const modelCommandModal = document.getElementById("modelCommandModal");
const modelCommandSelect = document.getElementById("modelCommandSelect");
const modelCommandCustomInput = document.getElementById("modelCommandCustomInput");
const modelCommandApplyBtn = document.getElementById("modelCommandApplyBtn");
const modelCommandCancelBtn = document.getElementById("modelCommandCancelBtn");

const timeline = new window.CodexSessionTimeline({
  container: chatMessages,
  maxRenderedEntries: 1500,
  systemTitle: "Session"
});

function normalizePath(path) {
  if (!path || typeof path !== "string") {
    return "";
  }

  return path.replace(/\\/g, "/");
}

function getCatalogSessionUpdatedTick(session) {
  if (!session || !session.updatedAtUtc) {
    return 0;
  }

  const tick = Date.parse(session.updatedAtUtc);
  return Number.isFinite(tick) ? tick : 0;
}

function getCatalogDirectoryInfo(session) {
  const normalizedCwd = normalizePath(session?.cwd || "").replace(/\/+$/g, "");
  if (!normalizedCwd) {
    return { key: "(unknown)", label: "(unknown)" };
  }

  return {
    key: normalizedCwd.toLowerCase(),
    label: normalizedCwd
  };
}

function buildCatalogDirectoryGroups() {
  const map = new Map();
  for (const session of sessionCatalog) {
    const info = getCatalogDirectoryInfo(session);
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
    const tick = getCatalogSessionUpdatedTick(session);
    if (tick > group.latestTick) {
      group.latestTick = tick;
    }
  }

  const groups = Array.from(map.values());
  for (const group of groups) {
    group.sessions.sort((a, b) => {
      const tickCompare = getCatalogSessionUpdatedTick(b) - getCatalogSessionUpdatedTick(a);
      if (tickCompare !== 0) return tickCompare;
      return (a.threadId || "").localeCompare(b.threadId || "");
    });
  }

  groups.sort((a, b) => {
    const tickCompare = b.latestTick - a.latestTick;
    if (tickCompare !== 0) return tickCompare;
    return a.label.localeCompare(b.label);
  });

  return groups;
}

function wsUrl() {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const endpoint = new URL("ws", document.baseURI);
  endpoint.protocol = scheme;
  return endpoint.toString();
}

function appendLog(text) {
  const stamp = new Date().toISOString();
  if (!logOutput) {
    console.log(`${stamp} ${text}`);
    return;
  }

  logOutput.textContent += `${stamp} ${text}\n`;
  logOutput.scrollTop = logOutput.scrollHeight;
}

function setApprovalVisible(show) {
  approvalPanel.classList.toggle("hidden", !show);
}

function ensureSessionState(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { threadId: null, cwd: null, model: null });
  }
  return sessions.get(sessionId);
}

function getActiveSessionState() {
  if (!activeSessionId || !sessions.has(activeSessionId)) {
    return null;
  }

  return sessions.get(activeSessionId) || null;
}

function clearComposerImages() {
  pendingComposerImages = [];
  renderComposerImages();
}

function renderComposerImages() {
  if (!composerImages) {
    return;
  }

  composerImages.textContent = "";
  if (pendingComposerImages.length === 0) {
    composerImages.classList.add("hidden");
    return;
  }

  for (const image of pendingComposerImages) {
    const pill = document.createElement("div");
    pill.className = "composer-image-pill";

    const preview = document.createElement("img");
    preview.src = image.url;
    preview.alt = image.name || "attached image";
    preview.loading = "lazy";
    pill.appendChild(preview);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "composer-image-remove";
    removeBtn.textContent = "x";
    removeBtn.title = "Remove image";
    removeBtn.addEventListener("click", () => {
      pendingComposerImages = pendingComposerImages.filter((x) => x.id !== image.id);
      renderComposerImages();
    });
    pill.appendChild(removeBtn);

    composerImages.appendChild(pill);
  }

  composerImages.classList.remove("hidden");
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(new Error(`failed reading image '${file.name || "unnamed"}'`));
    reader.readAsDataURL(file);
  });
}

async function addComposerFiles(filesLike) {
  const files = Array.from(filesLike || []);
  const imageFiles = files.filter((f) => f && typeof f.type === "string" && f.type.startsWith("image/"));
  if (imageFiles.length === 0) {
    return;
  }

  for (const file of imageFiles) {
    if (pendingComposerImages.length >= MAX_COMPOSER_IMAGES) {
      appendLog(`[image] max ${MAX_COMPOSER_IMAGES} attachments reached`);
      break;
    }

    if (typeof file.size === "number" && file.size > MAX_COMPOSER_IMAGE_BYTES) {
      appendLog(`[image] '${file.name || "image"}' is too large (max ${Math.floor(MAX_COMPOSER_IMAGE_BYTES / (1024 * 1024))}MB)`);
      continue;
    }

    try {
      const dataUrl = await fileToDataUrl(file);
      if (!dataUrl.startsWith("data:image/")) {
        appendLog(`[image] '${file.name || "image"}' is not a supported image`);
        continue;
      }

      pendingComposerImages.push({
        id: nextComposerImageId++,
        name: file.name || "image",
        mimeType: file.type || "image/*",
        size: file.size || 0,
        url: dataUrl
      });
    } catch (error) {
      appendLog(`[image] ${error}`);
    }
  }

  renderComposerImages();
}

function getQueueForSession(sessionId) {
  if (!sessionId) {
    return [];
  }

  if (!promptQueuesBySession.has(sessionId)) {
    promptQueuesBySession.set(sessionId, []);
  }

  return promptQueuesBySession.get(sessionId);
}

function isTurnInFlight(sessionId) {
  if (!sessionId) {
    return false;
  }

  return turnInFlightBySession.get(sessionId) === true;
}

function setTurnInFlight(sessionId, value) {
  if (!sessionId) {
    return;
  }

  turnInFlightBySession.set(sessionId, !!value);
}

function trimPromptPreview(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_QUEUE_TEXT_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_QUEUE_TEXT_CHARS)}...`;
}

function renderPromptQueue() {
  if (!promptQueue) {
    return;
  }

  if (!activeSessionId) {
    promptQueue.textContent = "";
    promptQueue.classList.add("hidden");
    return;
  }

  const queue = getQueueForSession(activeSessionId);
  if (!queue || queue.length === 0) {
    promptQueue.textContent = "";
    promptQueue.classList.add("hidden");
    return;
  }

  const previews = queue
    .slice(0, MAX_QUEUE_PREVIEW)
    .map((item, index) => {
      const imageCount = Array.isArray(item.images) ? item.images.length : 0;
      const imageSuffix = imageCount > 0 ? ` (+${imageCount} image${imageCount > 1 ? "s" : ""})` : "";
      const rawPreview = (item.text || "").trim() || (imageCount > 0 ? "(image only)" : "");
      return `${index + 1}. ${trimPromptPreview(rawPreview)}${imageSuffix}`;
    });
  const overflow = queue.length > MAX_QUEUE_PREVIEW ? ` +${queue.length - MAX_QUEUE_PREVIEW} more` : "";
  promptQueue.textContent = `Queued (${queue.length}): ${previews.join(" | ")}${overflow}`;
  promptQueue.classList.remove("hidden");
}

function queuePrompt(sessionId, promptText, images = []) {
  if (!sessionId) {
    return;
  }

  const queue = getQueueForSession(sessionId);
  queue.push({
    text: String(promptText || ""),
    images: Array.isArray(images) ? images.map((x) => ({ ...x })) : []
  });
  if (sessionId === activeSessionId) {
    renderPromptQueue();
  }
}

function startTurn(sessionId, promptText, images = [], options = {}) {
  const normalizedText = String(promptText || "").trim();
  const safeImages = Array.isArray(images) ? images.filter((x) => x && typeof x.url === "string" && x.url.trim().length > 0) : [];
  if (!sessionId || (!normalizedText && safeImages.length === 0)) {
    return false;
  }

  if (!send("turn_start", { sessionId, text: normalizedText, images: safeImages.map((x) => ({ url: x.url, name: x.name || "image" })) })) {
    return false;
  }

  setTurnInFlight(sessionId, true);
  if (normalizedText) {
    lastSentPromptBySession.set(sessionId, normalizedText);
  }
  timeline.enqueueOptimisticUserMessage(normalizedText, safeImages.map((x) => x.url));
  timeline.flush();

  if (options.fromQueue === true) {
    appendLog(`[turn] dequeued next prompt for session=${sessionId}`);
  }

  return true;
}

function pumpQueuedPrompt(sessionId) {
  if (!sessionId || isTurnInFlight(sessionId)) {
    return false;
  }

  const queue = getQueueForSession(sessionId);
  if (!queue || queue.length === 0) {
    return false;
  }

  const nextPrompt = queue.shift();
  const started = startTurn(sessionId, nextPrompt.text, nextPrompt.images || [], { fromQueue: true });
  if (!started) {
    queue.unshift(nextPrompt);
    return false;
  }

  if (sessionId === activeSessionId) {
    renderPromptQueue();
  }
  return true;
}

function prunePromptState() {
  const validIds = new Set(sessions.keys());
  for (const key of Array.from(promptQueuesBySession.keys())) {
    if (!validIds.has(key)) {
      promptQueuesBySession.delete(key);
    }
  }

  for (const key of Array.from(turnInFlightBySession.keys())) {
    if (!validIds.has(key)) {
      turnInFlightBySession.delete(key);
    }
  }

  for (const key of Array.from(lastSentPromptBySession.keys())) {
    if (!validIds.has(key)) {
      lastSentPromptBySession.delete(key);
    }
  }
}

function refreshSessionMeta() {
  const state = getActiveSessionState();
  if (!state) {
    sessionMeta.textContent = "";
    return;
  }

  const metaParts = [];
  const namedCatalogEntry = sessionCatalog.find((s) => s.threadId && state.threadId && s.threadId === state.threadId);
  if (namedCatalogEntry && namedCatalogEntry.threadName) metaParts.push(`name=${namedCatalogEntry.threadName}`);
  if (state.threadId) metaParts.push(`thread=${state.threadId}`);
  if (state.model) metaParts.push(`model=${state.model}`);
  if (state.cwd) metaParts.push(`cwd=${state.cwd}`);
  sessionMeta.textContent = metaParts.join("  ");
}

function restartTimelinePolling() {
  timelinePollGeneration += 1;
  const generation = timelinePollGeneration;

  if (timelinePollTimer) {
    clearInterval(timelinePollTimer);
    timelinePollTimer = null;
  }

  const state = getActiveSessionState();
  if (!state || !state.threadId) {
    return;
  }

  pollTimelineOnce(true, generation).catch((error) => {
    timeline.enqueueSystem(`[error] ${error}`);
  });

  timelinePollTimer = setInterval(() => {
    pollTimelineOnce(false, generation).catch((error) => {
      timeline.enqueueSystem(`[error] ${error}`);
    });
  }, TIMELINE_POLL_INTERVAL_MS);
}

async function pollTimelineOnce(initial, generation) {
  if (timelinePollInFlight) {
    return;
  }

  const state = getActiveSessionState();
  if (!state || !state.threadId) {
    return;
  }

  timelinePollInFlight = true;
  try {
    const url = new URL("api/logs/watch", document.baseURI);
    url.searchParams.set("threadId", state.threadId);
    url.searchParams.set("maxLines", "200");

    if (initial || timelineCursor === null) {
      url.searchParams.set("initial", "true");
    } else {
      url.searchParams.set("cursor", String(timelineCursor));
    }

    const response = await fetch(url, { cache: "no-store" });
    if (generation !== timelinePollGeneration) {
      return;
    }

    if (response.status === 404) {
      return;
    }

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`watch failed (${response.status}): ${detail}`);
    }

    const data = await response.json();
    if (generation !== timelinePollGeneration) {
      return;
    }

    if (initial || data.reset === true) {
      timeline.clear();
      if (data.reset === true) {
        timeline.enqueueSystem("session file was reset or rotated");
      }
    }

    timelineCursor = typeof data.nextCursor === "number" ? data.nextCursor : timelineCursor;
    timeline.enqueueParsedLines(Array.isArray(data.lines) ? data.lines : []);

    if (data.truncated === true) {
      timeline.enqueueSystem("tail update truncated to latest lines");
    }
  } finally {
    timelinePollInFlight = false;
  }
}

function setActiveSession(sessionId, options = {}) {
  if (!sessionId || !sessions.has(sessionId)) {
    return;
  }

  const restartTimeline = options.restartTimeline !== false;
  const changed = activeSessionId !== sessionId;

  activeSessionId = sessionId;
  sessionSelect.value = sessionId;
  stopSessionBtn.disabled = false;
  refreshSessionMeta();
  renderPromptQueue();
  if (changed) {
    clearComposerImages();
  }

  if (changed || restartTimeline) {
    timelineCursor = null;
    timeline.clear();
    restartTimelinePolling();
  }
}

function clearActiveSession() {
  activeSessionId = null;
  sessionMeta.textContent = "";
  stopSessionBtn.disabled = true;
  renderPromptQueue();
  clearComposerImages();
  timelineCursor = null;
  timeline.clear();
  restartTimelinePolling();
}

function updateSessionSelect(activeIdFromServer) {
  const current = sessionSelect.value;
  sessionSelect.textContent = "";

  const ids = Array.from(sessions.keys());
  ids.sort();
  for (const id of ids) {
    const state = sessions.get(id);
    const option = document.createElement("option");
    option.value = id;
    const namedCatalogEntry = sessionCatalog.find((s) => s.threadId && state.threadId && s.threadId === state.threadId);
    const threadShort = state.threadId ? state.threadId.slice(0, 8) : "unknown";
    const threadName = namedCatalogEntry && namedCatalogEntry.threadName ? namedCatalogEntry.threadName : null;
    option.textContent = threadName || `${id.slice(0, 8)} (${threadShort})`;
    option.title = `session=${id} thread=${state.threadId || "unknown"}`;
    sessionSelect.appendChild(option);
  }

  const toSelect = activeIdFromServer || activeSessionId || current || (ids.length > 0 ? ids[0] : null);
  if (toSelect && sessions.has(toSelect)) {
    const changed = activeSessionId !== toSelect;
    setActiveSession(toSelect, { restartTimeline: changed });
  } else {
    clearActiveSession();
  }
}

function updateExistingSessionSelect() {
  const prior = existingSessionSelect.value;
  existingSessionSelect.textContent = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "(select existing thread)";
  existingSessionSelect.appendChild(placeholder);

  const groups = buildCatalogDirectoryGroups();
  for (const group of groups) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = `${group.label} (${group.sessions.length})`;

    for (const s of group.sessions) {
      const option = document.createElement("option");
      option.value = s.threadId || "";
      const name = s.threadName ? `${s.threadName} ` : "";
      const updated = s.updatedAtUtc ? ` @ ${new Date(s.updatedAtUtc).toLocaleString()}` : "";
      option.textContent = `${name}${s.threadId || "unknown"}${updated}`;
      option.title = `thread=${s.threadId || "unknown"} cwd=${s.cwd || "(unknown)"}`;
      optgroup.appendChild(option);
    }

    existingSessionSelect.appendChild(optgroup);
  }

  if (prior && Array.from(existingSessionSelect.options).some((o) => o.value === prior)) {
    existingSessionSelect.value = prior;
  }
}

function modelValueForCreate() {
  const selection = modelSelect.value || "";
  if (selection === "__custom__") {
    const custom = modelCustomInput.value.trim();
    return custom ? custom : null;
  }
  return selection.trim() ? selection.trim() : null;
}

function populateModelSelect(models) {
  const prior = modelSelect.value;
  modelSelect.textContent = "";

  const optDefault = document.createElement("option");
  optDefault.value = "";
  optDefault.textContent = "(default)";
  modelSelect.appendChild(optDefault);

  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.model;
    const defaultSuffix = m.isDefault ? " (default)" : "";
    opt.textContent = `${m.displayName || m.model}${defaultSuffix}`;
    modelSelect.appendChild(opt);
  }

  const optCustom = document.createElement("option");
  optCustom.value = "__custom__";
  optCustom.textContent = "Custom...";
  modelSelect.appendChild(optCustom);

  if (prior && Array.from(modelSelect.options).some((o) => o.value === prior)) {
    modelSelect.value = prior;
  }

  if (modelSelect.value === "__custom__") {
    modelCustomInput.classList.remove("hidden");
  } else {
    modelCustomInput.classList.add("hidden");
  }

  syncModelCommandOptionsFromToolbar();
}

function syncModelCommandOptionsFromToolbar() {
  if (!modelCommandSelect) {
    return;
  }

  const previous = modelCommandSelect.value;
  modelCommandSelect.textContent = "";
  for (const option of Array.from(modelSelect.options)) {
    const next = document.createElement("option");
    next.value = option.value;
    next.textContent = option.textContent || option.value;
    modelCommandSelect.appendChild(next);
  }

  if (previous && Array.from(modelCommandSelect.options).some((x) => x.value === previous)) {
    modelCommandSelect.value = previous;
  } else {
    modelCommandSelect.value = modelSelect.value || "";
  }

  if (modelCommandSelect.value === "__custom__") {
    modelCommandCustomInput.classList.remove("hidden");
    modelCommandCustomInput.value = modelCustomInput.value || "";
  } else {
    modelCommandCustomInput.classList.add("hidden");
  }
}

function applyModelSelection(value) {
  const normalized = (value || "").trim();
  if (!normalized) {
    modelSelect.value = "";
    modelCustomInput.classList.add("hidden");
    syncModelCommandOptionsFromToolbar();
    return;
  }

  const matching = Array.from(modelSelect.options).find((o) => o.value === normalized);
  if (matching) {
    modelSelect.value = normalized;
    if (normalized === "__custom__") {
      modelCustomInput.classList.remove("hidden");
      modelCustomInput.focus();
    } else {
      modelCustomInput.classList.add("hidden");
    }
    syncModelCommandOptionsFromToolbar();
    return;
  }

  modelSelect.value = "__custom__";
  modelCustomInput.classList.remove("hidden");
  modelCustomInput.value = normalized;
  syncModelCommandOptionsFromToolbar();
}

function openModelCommandModal() {
  syncModelCommandOptionsFromToolbar();
  modelCommandModal.classList.remove("hidden");
  if (modelCommandSelect.value === "__custom__") {
    modelCommandCustomInput.classList.remove("hidden");
    modelCommandCustomInput.focus();
  } else {
    modelCommandCustomInput.classList.add("hidden");
    modelCommandSelect.focus();
  }
}

function closeModelCommandModal() {
  modelCommandModal.classList.add("hidden");
  modelCommandCustomInput.classList.add("hidden");
  promptInput.focus();
}

function applyModelFromCommandModal() {
  const selected = modelCommandSelect.value || "";
  if (selected === "__custom__") {
    const custom = modelCommandCustomInput.value.trim();
    if (!custom) {
      appendLog("[model] custom model cannot be empty");
      modelCommandCustomInput.focus();
      return;
    }

    applyModelSelection(custom);
    appendLog(`[model] selected custom model '${custom}'`);
    closeModelCommandModal();
    return;
  }

  applyModelSelection(selected);
  if (selected) {
    appendLog(`[model] selected '${selected}'`);
  } else {
    appendLog("[model] reverted to default");
  }
  closeModelCommandModal();
}

function applySavedUiSettings() {
  const savedCwd = localStorage.getItem(STORAGE_CWD_KEY);
  if (savedCwd) {
    cwdInput.value = savedCwd;
  }

  const savedVerbosity = localStorage.getItem(STORAGE_LOG_VERBOSITY_KEY);
  if (savedVerbosity && Array.from(logVerbositySelect.options).some((o) => o.value === savedVerbosity)) {
    logVerbositySelect.value = savedVerbosity;
  }
}

function getCurrentLogVerbosity() {
  return logVerbositySelect.value || "normal";
}

function sendCurrentLogVerbosity() {
  send("log_verbosity_set", { verbosity: getCurrentLogVerbosity() });
}

function ensureSocket() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  if (socket && socket.readyState === WebSocket.CONNECTING && socketReadyPromise) {
    return socketReadyPromise;
  }

  socket = new WebSocket(wsUrl());
  socketReadyPromise = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("websocket connect error")), { once: true });
    socket.addEventListener("close", () => reject(new Error("websocket closed before open")), { once: true });
  });

  socket.addEventListener("open", () => {
    appendLog("[ws] connected");
    socketReadyPromise = null;
    send("session_list");
    send("session_catalog_list");
    send("models_list");
    sendCurrentLogVerbosity();
  });
  socket.addEventListener("close", () => {
    appendLog("[ws] disconnected");
    socketReadyPromise = null;
    sessions = new Map();
    sessionCatalog = [];
    pendingApproval = null;
    promptQueuesBySession = new Map();
    turnInFlightBySession = new Map();
    lastSentPromptBySession = new Map();
    pendingComposerImages = [];
    updateSessionSelect(null);
    updateExistingSessionSelect();
    renderComposerImages();
    setApprovalVisible(false);
  });
  socket.addEventListener("error", () => {
    appendLog("[ws] error");
  });
  socket.addEventListener("message", (event) => {
    try {
      const frame = JSON.parse(event.data);
      handleServerEvent(frame);
    } catch (error) {
      appendLog(`[ws] invalid server frame: ${error}`);
    }
  });

  return socketReadyPromise;
}

function send(type, payload = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    appendLog(`[client] cannot send ${type}; websocket is closed`);
    return false;
  }
  socket.send(JSON.stringify({ type, ...payload }));
  return true;
}

function handleServerEvent(frame) {
  const type = frame.type;
  const payload = frame.payload || {};

  switch (type) {
    case "status":
      appendLog(`[status] ${payload.message || ""}`);
      return;

    case "session_created":
    case "session_attached": {
      const sessionId = payload.sessionId;
      if (!sessionId) return;
      const state = ensureSessionState(sessionId);
      state.threadId = payload.threadId || state.threadId;
      state.cwd = payload.cwd || state.cwd;
      state.model = payload.model || state.model;
      setTurnInFlight(sessionId, false);
      const mode = payload.attached || type === "session_attached" ? "attached" : "created";
      appendLog(`[session] ${mode} id=${sessionId} thread=${state.threadId || "unknown"} log=${payload.logPath || "n/a"}`);
      updateSessionSelect(sessionId);
      return;
    }

    case "session_list": {
      const list = Array.isArray(payload.sessions) ? payload.sessions : [];
      const next = new Map();
      for (const s of list) {
        const existing = sessions.get(s.sessionId);
        const st = existing || { threadId: null, cwd: null, model: null };
        st.threadId = s.threadId || st.threadId || null;
        st.cwd = s.cwd || st.cwd || null;
        st.model = s.model || st.model || null;
        next.set(s.sessionId, st);
      }
      sessions = next;
      prunePromptState();
      updateSessionSelect(payload.activeSessionId || null);
      return;
    }

    case "session_catalog": {
      const list = Array.isArray(payload.sessions) ? payload.sessions : [];
      sessionCatalog = list
        .filter((s) => s && s.threadId)
        .sort((a, b) => (b.updatedAtUtc || "").localeCompare(a.updatedAtUtc || ""));
      updateExistingSessionSelect();
      refreshSessionMeta();
      appendLog(`[catalog] loaded ${sessionCatalog.length} existing sessions from ${payload.codexHomePath || "default CODEX_HOME"}`);
      return;
    }

    case "session_stopped": {
      const sessionId = payload.sessionId;
      if (sessionId && sessions.has(sessionId)) {
        sessions.delete(sessionId);
      }
      if (sessionId) {
        promptQueuesBySession.delete(sessionId);
        turnInFlightBySession.delete(sessionId);
        lastSentPromptBySession.delete(sessionId);
      }
      appendLog(`[session] stopped id=${sessionId || "unknown"}`);
      updateSessionSelect(payload.activeSessionId || null);
      return;
    }

    case "assistant_delta":
      return;

    case "assistant_done":
      return;

    case "turn_complete": {
      const sessionId = payload.sessionId || null;
      if (sessionId) {
        setTurnInFlight(sessionId, false);
        pumpQueuedPrompt(sessionId);
      }
      const status = payload.status || "unknown";
      const errorMessage = payload.errorMessage || null;
      appendLog(`[turn] session=${payload.sessionId || "unknown"} status=${status}${errorMessage ? " error=" + errorMessage : ""}`);
      renderPromptQueue();
      return;
    }

    case "approval_request": {
      const sessionId = payload.sessionId;
      const approvalId = payload.approvalId;
      pendingApproval = sessionId && approvalId ? { sessionId, approvalId } : null;

      if (sessionId && sessions.has(sessionId) && sessionId !== activeSessionId) {
        setActiveSession(sessionId);
      }

      approvalSummary.textContent = payload.summary || "Approval requested";
      const lines = [];
      if (payload.reason) lines.push(`Reason: ${payload.reason}`);
      if (payload.cwd) lines.push(`CWD: ${payload.cwd}`);
      if (Array.isArray(payload.actions) && payload.actions.length > 0) lines.push(`Actions: ${payload.actions.join("; ")}`);
      approvalDetails.textContent = lines.join("\n");
      setApprovalVisible(true);
      appendLog(`[approval] requested session=${sessionId || "unknown"} approvalId=${approvalId || "unknown"}`);
      return;
    }

    case "models_list": {
      if (payload.error) {
        appendLog(`[models] error: ${payload.error}`);
        return;
      }
      const models = Array.isArray(payload.models) ? payload.models : [];
      populateModelSelect(models);
      appendLog(`[models] loaded (${models.length})`);
      return;
    }

    case "log_verbosity":
      if (payload.verbosity && Array.from(logVerbositySelect.options).some((o) => o.value === payload.verbosity)) {
        logVerbositySelect.value = payload.verbosity;
      }
      appendLog(`[log] verbosity=${payload.verbosity || "unknown"}`);
      return;

    case "log": {
      const parts = [];
      if (payload.source) parts.push(payload.source);
      if (payload.sessionId) parts.push(`session=${payload.sessionId}`);
      if (payload.level) parts.push(payload.level);
      if (payload.eventType) parts.push(payload.eventType);
      const prefix = parts.length > 0 ? `[${parts.join(":")}] ` : "";
      appendLog(`${prefix}${payload.message || ""}`);
      return;
    }

    case "error":
      appendLog(`[error] ${payload.message || "unknown error"}`);
      return;

    case "session_started":
      return;

    default:
      appendLog(`[ws] unknown event type: ${type}`);
      return;
  }
}

newSessionBtn.addEventListener("click", async () => {
  try {
    await ensureSocket();
  } catch (error) {
    appendLog(`[ws] connect failed: ${error}`);
    return;
  }

  const payload = {};
  const model = modelValueForCreate();
  if (model) payload.model = model;

  const cwd = cwdInput.value.trim();
  if (cwd) payload.cwd = cwd;

  send("session_create", payload);
  send("session_catalog_list");
});

attachSessionBtn.addEventListener("click", async () => {
  const threadId = existingSessionSelect.value;
  if (!threadId) {
    appendLog("[catalog] select an existing thread to attach");
    return;
  }

  try {
    await ensureSocket();
  } catch (error) {
    appendLog(`[ws] connect failed: ${error}`);
    return;
  }

  const payload = { threadId };
  const model = modelValueForCreate();
  if (model) payload.model = model;
  const cwd = cwdInput.value.trim();
  if (cwd) payload.cwd = cwd;
  send("session_attach", payload);
});

stopSessionBtn.addEventListener("click", () => {
  if (!activeSessionId) return;
  send("session_stop", { sessionId: activeSessionId });
});

sessionSelect.addEventListener("change", () => {
  const sessionId = sessionSelect.value;
  if (!sessionId) return;
  if (!sessions.has(sessionId)) return;
  setActiveSession(sessionId);
  send("session_select", { sessionId });
});

modelSelect.addEventListener("change", () => {
  if (modelSelect.value === "__custom__") {
    modelCustomInput.classList.remove("hidden");
    modelCustomInput.focus();
  } else {
    modelCustomInput.classList.add("hidden");
  }
  syncModelCommandOptionsFromToolbar();
});

modelCommandSelect.addEventListener("change", () => {
  if (modelCommandSelect.value === "__custom__") {
    modelCommandCustomInput.classList.remove("hidden");
    modelCommandCustomInput.focus();
  } else {
    modelCommandCustomInput.classList.add("hidden");
  }
});

modelCommandApplyBtn.addEventListener("click", () => {
  applyModelFromCommandModal();
});

modelCommandCancelBtn.addEventListener("click", () => {
  closeModelCommandModal();
});

modelCommandSelect.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    applyModelFromCommandModal();
  }
});

modelCommandCustomInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    applyModelFromCommandModal();
  }
});

modelCommandModal.addEventListener("click", (event) => {
  if (event.target === modelCommandModal) {
    closeModelCommandModal();
  }
});

logVerbositySelect.addEventListener("change", async () => {
  localStorage.setItem(STORAGE_LOG_VERBOSITY_KEY, getCurrentLogVerbosity());
  try {
    await ensureSocket();
  } catch (error) {
    appendLog(`[ws] connect failed: ${error}`);
    return;
  }
  sendCurrentLogVerbosity();
});

reloadModelsBtn.addEventListener("click", async () => {
  try {
    await ensureSocket();
  } catch (error) {
    appendLog(`[ws] connect failed: ${error}`);
    return;
  }
  send("models_list");
});

cwdInput.addEventListener("change", () => {
  localStorage.setItem(STORAGE_CWD_KEY, cwdInput.value.trim());
});

imageUploadBtn.addEventListener("click", () => {
  imageUploadInput.click();
});

imageUploadInput.addEventListener("change", async () => {
  const files = imageUploadInput.files;
  if (!files || files.length === 0) {
    return;
  }

  await addComposerFiles(files);
  imageUploadInput.value = "";
  promptInput.focus();
});

promptInput.addEventListener("paste", async (event) => {
  const items = Array.from(event.clipboardData?.items || []);
  const files = [];
  for (const item of items) {
    if (!item || item.kind !== "file" || !item.type.startsWith("image/")) {
      continue;
    }

    const file = item.getAsFile();
    if (file) {
      files.push(file);
    }
  }

  if (files.length === 0) {
    return;
  }

  event.preventDefault();
  await addComposerFiles(files);
});

promptInput.addEventListener("dragover", (event) => {
  const hasFiles = Array.from(event.dataTransfer?.types || []).includes("Files");
  if (!hasFiles) {
    return;
  }

  event.preventDefault();
  promptInput.classList.add("drag-over");
});

promptInput.addEventListener("dragleave", () => {
  promptInput.classList.remove("drag-over");
});

promptInput.addEventListener("drop", async (event) => {
  const files = Array.from(event.dataTransfer?.files || []);
  if (files.length === 0) {
    return;
  }

  event.preventDefault();
  promptInput.classList.remove("drag-over");
  await addComposerFiles(files);
});

async function tryHandleSlashCommand(inputText) {
  const raw = (inputText || "").trim();
  if (!raw.startsWith("/")) {
    return false;
  }

  const body = raw.slice(1);
  const firstSpace = body.indexOf(" ");
  const command = (firstSpace >= 0 ? body.slice(0, firstSpace) : body).trim().toLowerCase();
  const args = firstSpace >= 0 ? body.slice(firstSpace + 1).trim() : "";

  if (!command) {
    appendLog("[client] empty slash command");
    return true;
  }

  if (command === "model") {
    if (args.length > 0) {
      applyModelSelection(args);
      appendLog(`[model] selected '${args}'`);
      return true;
    }

    try {
      await ensureSocket();
      send("models_list");
    } catch (error) {
      appendLog(`[models] refresh failed: ${error}`);
    }

    openModelCommandModal();
    return true;
  }

  if (command === "rename") {
    if (!activeSessionId || !sessions.has(activeSessionId)) {
      appendLog("[rename] no active session selected");
      return true;
    }

    const nextName = args;
    if (!nextName) {
      appendLog("[rename] usage: /rename <new name>");
      return true;
    }

    if (nextName.length > 200) {
      appendLog("[rename] name must be 200 characters or fewer");
      return true;
    }

    try {
      await ensureSocket();
    } catch (error) {
      appendLog(`[ws] connect failed: ${error}`);
      return true;
    }

    send("session_rename", { sessionId: activeSessionId, threadName: nextName });
    appendLog(`[rename] requested '${nextName}'`);
    return true;
  }

  appendLog(`[client] unknown slash command: /${command}`);
  return true;
}

promptForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const prompt = promptInput.value.trim();
  const images = pendingComposerImages.map((x) => ({ ...x }));
  if (!prompt && images.length === 0) {
    if (activeSessionId && pumpQueuedPrompt(activeSessionId)) {
      renderPromptQueue();
    }
    return;
  }

  if (images.length === 0 && await tryHandleSlashCommand(prompt)) {
    promptInput.value = "";
    return;
  }

  if (!activeSessionId) {
    appendLog("[client] no active session; create or attach one first");
    return;
  }

  try {
    await ensureSocket();
  } catch (error) {
    appendLog(`[ws] connect failed: ${error}`);
    return;
  }

  if (isTurnInFlight(activeSessionId)) {
    queuePrompt(activeSessionId, prompt, images);
    promptInput.value = "";
    clearComposerImages();
    appendLog(`[turn] queued prompt for session=${activeSessionId}`);
    return;
  }

  promptInput.value = "";
  clearComposerImages();
  startTurn(activeSessionId, prompt, images);
  renderPromptQueue();
});

promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
    const prompt = promptInput.value.trim();
    const images = pendingComposerImages.map((x) => ({ ...x }));
    if (!prompt && images.length === 0) {
      return;
    }

    event.preventDefault();
    if (!activeSessionId) {
      appendLog("[client] no active session; create or attach one first");
      return;
    }

    queuePrompt(activeSessionId, prompt, images);
    promptInput.value = "";
    clearComposerImages();
    appendLog(`[turn] queued prompt for session=${activeSessionId}`);
    return;
  }

  if (event.key === "ArrowUp" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    const isEmpty = promptInput.value.trim().length === 0;
    const isAtStart = promptInput.selectionStart === 0 && promptInput.selectionEnd === 0;
    if (!isEmpty && !isAtStart) {
      return;
    }

    if (!activeSessionId) {
      return;
    }

    const lastSent = lastSentPromptBySession.get(activeSessionId);
    if (!lastSent) {
      return;
    }

    event.preventDefault();
    promptInput.value = lastSent;
    promptInput.selectionStart = promptInput.selectionEnd = promptInput.value.length;
    return;
  }

  if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    promptForm.requestSubmit();
  }
});

approvalPanel.querySelectorAll("button[data-decision]").forEach((button) => {
  button.addEventListener("click", () => {
    const decision = button.getAttribute("data-decision");
    if (!decision) return;
    if (!pendingApproval) {
      appendLog("[approval] no pending approval to respond to");
      setApprovalVisible(false);
      return;
    }
    send("approval_response", {
      sessionId: pendingApproval.sessionId,
      approvalId: pendingApproval.approvalId,
      decision
    });
    appendLog(`[approval] decision=${decision} session=${pendingApproval.sessionId} approvalId=${pendingApproval.approvalId}`);
    pendingApproval = null;
    setApprovalVisible(false);
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") {
    return;
  }

  if (modelCommandModal.classList.contains("hidden")) {
    return;
  }

  event.preventDefault();
  closeModelCommandModal();
});

applySavedUiSettings();
renderComposerImages();

timelineFlushTimer = setInterval(() => timeline.flush(), TIMELINE_POLL_INTERVAL_MS);

ensureSocket().catch((error) => appendLog(`[ws] connect failed: ${error}`));
