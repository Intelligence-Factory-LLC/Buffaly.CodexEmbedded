let socket = null;
let socketReadyPromise = null;

let sessions = new Map(); // sessionId -> { threadId, cwd, model, messages: [], streamingIndex: null|number }
let sessionCatalog = []; // [{ threadId, threadName, updatedAtUtc, cwd, model, sessionFilePath }]
let activeSessionId = null;
let pendingApproval = null; // { sessionId, approvalId }

let activeAssistantDiv = null;
let activeAssistantDivSessionId = null;

const STORAGE_CWD_KEY = "codex-web-cwd";
const STORAGE_LOG_VERBOSITY_KEY = "codex-web-log-verbosity";

const chatMessages = document.getElementById("chatMessages");
const logOutput = document.getElementById("logOutput");
const promptForm = document.getElementById("promptForm");
const promptInput = document.getElementById("promptInput");

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
    sessions.set(sessionId, { threadId: null, cwd: null, model: null, messages: [], streamingIndex: null });
  }
  return sessions.get(sessionId);
}

function renderActiveSession() {
  chatMessages.textContent = "";
  activeAssistantDiv = null;
  activeAssistantDivSessionId = null;

  if (!activeSessionId || !sessions.has(activeSessionId)) {
    return;
  }

  const state = sessions.get(activeSessionId);
  for (let i = 0; i < state.messages.length; i++) {
    const msg = state.messages[i];
    const div = document.createElement("div");
    div.className = `msg ${msg.role}`;
    div.textContent = msg.text;
    chatMessages.appendChild(div);

    if (msg.role === "assistant" && state.streamingIndex === i) {
      activeAssistantDiv = div;
      activeAssistantDivSessionId = activeSessionId;
    }
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function setActiveSession(sessionId) {
  if (!sessionId || !sessions.has(sessionId)) {
    return;
  }
  activeSessionId = sessionId;
  sessionSelect.value = sessionId;

  const state = sessions.get(sessionId);
  const metaParts = [];
  const namedCatalogEntry = sessionCatalog.find((s) => s.threadId && state.threadId && s.threadId === state.threadId);
  if (namedCatalogEntry && namedCatalogEntry.threadName) metaParts.push(`name=${namedCatalogEntry.threadName}`);
  if (state.threadId) metaParts.push(`thread=${state.threadId}`);
  if (state.model) metaParts.push(`model=${state.model}`);
  if (state.cwd) metaParts.push(`cwd=${state.cwd}`);
  sessionMeta.textContent = metaParts.join("  ");

  stopSessionBtn.disabled = false;
  renderActiveSession();
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
    setActiveSession(toSelect);
  } else {
    activeSessionId = null;
    sessionMeta.textContent = "";
    stopSessionBtn.disabled = true;
    chatMessages.textContent = "";
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
    activeSessionId = null;
    pendingApproval = null;
    updateSessionSelect(null);
    updateExistingSessionSelect();
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
    return;
  }
  socket.send(JSON.stringify({ type, ...payload }));
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
      const mode = payload.attached || type === "session_attached" ? "attached" : "created";
      appendLog(`[session] ${mode} id=${sessionId} thread=${state.threadId || "unknown"} log=${payload.logPath || "n/a"}`);
      updateSessionSelect(sessionId);
      setActiveSession(sessionId);
      return;
    }

    case "session_list": {
      const list = Array.isArray(payload.sessions) ? payload.sessions : [];
      const next = new Map();
      for (const s of list) {
        const existing = sessions.get(s.sessionId);
        const st = existing || { threadId: null, cwd: null, model: null, messages: [], streamingIndex: null };
        st.threadId = s.threadId || st.threadId || null;
        st.cwd = s.cwd || st.cwd || null;
        st.model = s.model || st.model || null;
        next.set(s.sessionId, st);
      }
      sessions = next;
      updateSessionSelect(payload.activeSessionId || null);
      return;
    }

    case "session_catalog": {
      const list = Array.isArray(payload.sessions) ? payload.sessions : [];
      sessionCatalog = list
        .filter((s) => s && s.threadId)
        .sort((a, b) => (b.updatedAtUtc || "").localeCompare(a.updatedAtUtc || ""));
      updateExistingSessionSelect();
      appendLog(`[catalog] loaded ${sessionCatalog.length} existing sessions from ${payload.codexHomePath || "default CODEX_HOME"}`);
      return;
    }

    case "session_stopped": {
      const sessionId = payload.sessionId;
      if (sessionId && sessions.has(sessionId)) {
        sessions.delete(sessionId);
      }
      appendLog(`[session] stopped id=${sessionId || "unknown"}`);
      updateSessionSelect(payload.activeSessionId || null);
      return;
    }

    case "assistant_delta": {
      const sessionId = payload.sessionId;
      const text = payload.text || "";
      if (!sessionId || !text) return;

      const state = ensureSessionState(sessionId);
      if (state.streamingIndex === null) {
        state.messages.push({ role: "assistant", text: "" });
        state.streamingIndex = state.messages.length - 1;
      }
      state.messages[state.streamingIndex].text += text;

      if (sessionId === activeSessionId && activeAssistantDiv && activeAssistantDivSessionId === sessionId) {
        activeAssistantDiv.textContent += text;
        chatMessages.scrollTop = chatMessages.scrollHeight;
      } else if (sessionId === activeSessionId) {
        renderActiveSession();
      }
      return;
    }

    case "assistant_done": {
      const sessionId = payload.sessionId;
      if (!sessionId) return;
      const state = ensureSessionState(sessionId);
      state.streamingIndex = null;
      if (sessionId === activeSessionId) {
        activeAssistantDiv = null;
        activeAssistantDivSessionId = null;
      }
      return;
    }

    case "turn_complete": {
      const sessionId = payload.sessionId;
      const state = sessionId ? ensureSessionState(sessionId) : null;
      if (state) state.streamingIndex = null;

      const status = payload.status || "unknown";
      const errorMessage = payload.errorMessage || null;
      appendLog(`[turn] session=${sessionId || "unknown"} status=${status}${errorMessage ? " error=" + errorMessage : ""}`);

      if (sessionId) {
        const s = ensureSessionState(sessionId);
        s.messages.push({ role: "system", text: `Turn complete: ${status}` });
        if (errorMessage) s.messages.push({ role: "system", text: errorMessage });
        if (sessionId === activeSessionId) renderActiveSession();
      }
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

    // Back-compat events: ignore quietly.
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

promptForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const prompt = promptInput.value.trim();
  if (!prompt) return;

  try {
    await ensureSocket();
  } catch (error) {
    appendLog(`[ws] connect failed: ${error}`);
    return;
  }

  if (!activeSessionId) {
    appendLog("[client] no active session; create or attach one first");
    return;
  }

  const state = ensureSessionState(activeSessionId);
  state.messages.push({ role: "user", text: prompt });
  state.streamingIndex = null;
  promptInput.value = "";
  renderActiveSession();

  send("turn_start", { sessionId: activeSessionId, text: prompt });
});

promptInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  promptForm.requestSubmit();
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

applySavedUiSettings();

// Auto-connect so sessions/models/catalog populate without clicking anything.
ensureSocket().catch((error) => appendLog(`[ws] connect failed: ${error}`));
