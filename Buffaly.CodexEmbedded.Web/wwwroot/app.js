const TIMELINE_POLL_INTERVAL_MS = 2000;

let socket = null;
let socketReadyPromise = null;

let sessions = new Map(); // sessionId -> { threadId, cwd, model }
let sessionCatalog = []; // [{ threadId, threadName, updatedAtUtc, cwd, model, sessionFilePath }]
let activeSessionId = null;
let pendingApproval = null; // { sessionId, approvalId }
let promptQueuesBySession = new Map(); // sessionId -> [{ text, images }]
let persistedPromptQueuesByThread = new Map(); // threadId -> [{ text, images }]
let turnInFlightBySession = new Map(); // sessionId -> boolean
let lastSentPromptBySession = new Map(); // sessionId -> string
let promptDraftByKey = new Map(); // "thread:<threadId>" | "__global__" -> text
let pendingComposerImages = [];
let nextComposerImageId = 1;
let selectedProjectKey = null;
let projectNameByKey = new Map();
let collapsedProjectKeys = new Set();
let archivedThreadIds = new Set();
let expandedProjectKeys = new Set();
let customProjects = [];
let pendingCreateRequests = new Map(); // requestId -> { threadName, cwd }
let pendingRenameOnAttach = new Map(); // threadId -> threadName
let pendingSessionLoadThreadId = null;
let pendingSessionLoadPreviousActiveId = null;

let timelineCursor = null;
let timelinePollTimer = null;
let timelineFlushTimer = null;
let timelinePollGeneration = 0;
let timelinePollInFlight = false;
let sessionListPollTimer = null;
let autoAttachAttempted = false;
let syncingConversationModelSelect = false;
let sessionMetaDetailsExpanded = false;
let contextUsageByThread = new Map(); // threadId -> { usedTokens, contextWindow, percentLeft }
let permissionLevelByThread = new Map(); // threadId -> { approval, sandbox }

const STORAGE_CWD_KEY = "codex-web-cwd";
const STORAGE_LOG_VERBOSITY_KEY = "codex-web-log-verbosity";
const STORAGE_LAST_THREAD_ID_KEY = "codex-web-last-thread-id";
const STORAGE_QUEUED_PROMPTS_KEY = "codex-web-queued-prompts-v1";
const STORAGE_PROMPT_DRAFTS_KEY = "codex-web-prompt-drafts-v1";
const STORAGE_PROJECT_META_KEY = "codex-web-project-meta";
const STORAGE_COLLAPSED_PROJECTS_KEY = "codex-web-collapsed-projects";
const STORAGE_ARCHIVED_THREADS_KEY = "codex-web-archived-threads";
const STORAGE_SIDEBAR_COLLAPSED_KEY = "codex-web-sidebar-collapsed";
const STORAGE_CUSTOM_PROJECTS_KEY = "codex-web-custom-projects";
const MAX_QUEUE_PREVIEW = 3;
const MAX_QUEUE_TEXT_CHARS = 90;
const MAX_PROJECT_SESSIONS_COLLAPSED = 4;
const MAX_COMPOSER_IMAGES = 4;
const MAX_COMPOSER_IMAGE_BYTES = 8 * 1024 * 1024;
const GLOBAL_PROMPT_DRAFT_KEY = "__global__";
const SESSION_LIST_SYNC_INTERVAL_MS = 2500;

const layoutRoot = document.querySelector(".layout");
const chatPanel = document.querySelector(".chat-panel");
const chatMessages = document.getElementById("chatMessages");
const logOutput = document.getElementById("logOutput");
const promptForm = document.getElementById("promptForm");
const promptInput = document.getElementById("promptInput");
const promptQueue = document.getElementById("promptQueue");
const scrollToBottomBtn = document.getElementById("scrollToBottomBtn");
const contextLeftIndicator = document.getElementById("contextLeftIndicator");
const permissionLevelIndicator = document.getElementById("permissionLevelIndicator");
const composerImages = document.getElementById("composerImages");
const imageUploadInput = document.getElementById("imageUploadInput");
const imageUploadBtn = document.getElementById("imageUploadBtn");
const queuePromptBtn = document.getElementById("queuePromptBtn");
const cancelTurnBtn = document.getElementById("cancelTurnBtn");
const sendPromptBtn = document.getElementById("sendPromptBtn");
const mobileProjectsBtn = document.getElementById("mobileProjectsBtn");
const sidebarBackdrop = document.getElementById("sidebarBackdrop");

const newSessionBtn = document.getElementById("newSessionBtn");
const newProjectBtn = document.getElementById("newProjectBtn");
const newProjectSidebarBtn = document.getElementById("newProjectSidebarBtn");
const attachSessionBtn = document.getElementById("attachSessionBtn");
const existingSessionSelect = document.getElementById("existingSessionSelect");
const stopSessionBtn = document.getElementById("stopSessionBtn");
const sessionSelect = document.getElementById("sessionSelect");
const conversationTitle = document.getElementById("conversationTitle");
const sessionMeta = document.getElementById("sessionMeta");
const sessionMetaDetailsBtn = document.getElementById("sessionMetaDetailsBtn");
const sessionMetaSummaryItem = document.getElementById("sessionMetaSummaryItem");
const sessionMetaSummaryValue = document.getElementById("sessionMetaSummaryValue");
const sessionMetaNameItem = document.getElementById("sessionMetaNameItem");
const sessionMetaNameValue = document.getElementById("sessionMetaNameValue");
const sessionMetaThreadItem = document.getElementById("sessionMetaThreadItem");
const sessionMetaThreadValue = document.getElementById("sessionMetaThreadValue");
const sessionMetaModelItem = document.getElementById("sessionMetaModelItem");
const sessionMetaCwdItem = document.getElementById("sessionMetaCwdItem");
const sessionMetaCwdValue = document.getElementById("sessionMetaCwdValue");
const conversationModelSelect = document.getElementById("conversationModelSelect");
const sessionSidebar = document.getElementById("sessionSidebar");
const sidebarToggleBtn = document.getElementById("sidebarToggleBtn");
const projectList = document.getElementById("projectList");

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

function getMessageListRemainingScroll() {
  if (!chatMessages) {
    return 0;
  }

  return chatMessages.scrollHeight - (chatMessages.scrollTop + chatMessages.clientHeight);
}

function updateScrollToBottomButton() {
  if (!scrollToBottomBtn || !chatMessages) {
    return;
  }

  const remaining = getMessageListRemainingScroll();
  const shouldShow = remaining > 96;
  scrollToBottomBtn.classList.toggle("hidden", !shouldShow);
}

function scrollMessagesToBottom(smooth = false) {
  if (!chatMessages) {
    return;
  }

  if (smooth && typeof chatMessages.scrollTo === "function") {
    chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: "smooth" });
  } else {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  updateScrollToBottomButton();
}

function updatePromptActionState() {
  if (!queuePromptBtn || !sendPromptBtn || !cancelTurnBtn) {
    return;
  }

  const processingActive = !!activeSessionId && isTurnInFlight(activeSessionId);
  queuePromptBtn.classList.toggle("hidden", !processingActive);
  cancelTurnBtn.classList.toggle("hidden", !processingActive);
  sendPromptBtn.classList.toggle("queue-mode", processingActive);
  sendPromptBtn.classList.toggle("solo-send", !processingActive);
  sendPromptBtn.title = processingActive ? "Send now (Enter)" : "Send (Enter)";
  queuePromptBtn.title = "Queue prompt (Tab)";
  cancelTurnBtn.title = "Cancel running turn";
}

function updateContextLeftIndicator() {
  if (!contextLeftIndicator) {
    return;
  }

  const state = getActiveSessionState();
  const threadId = typeof state?.threadId === "string" ? state.threadId.trim() : "";
  const info = threadId ? contextUsageByThread.get(threadId) : null;
  if (!info || !Number.isFinite(info.percentLeft) || !Number.isFinite(info.usedTokens) || !Number.isFinite(info.contextWindow)
      || info.contextWindow <= 0 || info.usedTokens > (info.contextWindow * 1.1)) {
    contextLeftIndicator.textContent = "--% context left";
    contextLeftIndicator.title = "Context usage unavailable";
    return;
  }

  contextLeftIndicator.textContent = `${info.percentLeft}% context left`;
  contextLeftIndicator.title = `Used ${info.usedTokens.toLocaleString()} / ${info.contextWindow.toLocaleString()} tokens`;
}

function normalizePermissionPolicy(value) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value !== "object") {
    return String(value || "").trim();
  }

  const fromNamedField = value.mode || value.kind || value.type || value.name;
  if (typeof fromNamedField === "string" && fromNamedField.trim()) {
    return fromNamedField.trim();
  }

  const objectKeys = Object.keys(value);
  if (objectKeys.length === 1 && typeof objectKeys[0] === "string" && objectKeys[0].trim()) {
    return objectKeys[0].trim();
  }

  return "";
}

function setPermissionLevelForThread(threadId, nextValue) {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId || !nextValue || typeof nextValue !== "object") {
    return;
  }

  const prior = permissionLevelByThread.get(normalizedThreadId) || { approval: "", sandbox: "" };
  const merged = {
    approval: nextValue.approval || prior.approval || "",
    sandbox: nextValue.sandbox || prior.sandbox || ""
  };

  permissionLevelByThread.set(normalizedThreadId, merged);
  const activeThreadId = typeof getActiveSessionState()?.threadId === "string" ? getActiveSessionState().threadId.trim() : "";
  if (activeThreadId === normalizedThreadId) {
    updatePermissionLevelIndicator();
  }
}

function updatePermissionLevelIndicator() {
  if (!permissionLevelIndicator) {
    return;
  }

  const state = getActiveSessionState();
  const threadId = typeof state?.threadId === "string" ? state.threadId.trim() : "";
  const info = threadId ? permissionLevelByThread.get(threadId) : null;
  const approval = info?.approval || "";
  const sandbox = info?.sandbox || "";
  if (!approval && !sandbox) {
    permissionLevelIndicator.textContent = "perm: --";
    permissionLevelIndicator.title = "Permission level unavailable";
    return;
  }

  const approvalLabel = approval || "?";
  const sandboxLabel = sandbox || "?";
  permissionLevelIndicator.textContent = `perm: ${approvalLabel} / ${sandboxLabel}`;
  permissionLevelIndicator.title = `Approval: ${approvalLabel} | Sandbox: ${sandboxLabel}`;
}

function readPermissionInfoFromPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const approvalRaw = payload.approval_policy
    ?? payload.approvalPolicy
    ?? payload.approval_mode
    ?? payload.approvalMode
    ?? null;
  const sandboxRaw = payload.sandbox_policy
    ?? payload.sandboxPolicy
    ?? payload.sandbox_mode
    ?? payload.sandboxMode
    ?? payload.sandbox
    ?? null;

  const approval = normalizePermissionPolicy(approvalRaw);
  const sandbox = normalizePermissionPolicy(sandboxRaw);
  if (!approval && !sandbox) {
    return null;
  }

  return { approval, sandbox };
}

function readTokenCountInfo(payload) {
  if (!payload || typeof payload !== "object" || payload.type !== "token_count") {
    return null;
  }

  const info = payload.info;
  if (!info || typeof info !== "object") {
    return null;
  }

  const contextWindowRaw = info.model_context_window ?? info.modelContextWindow ?? null;
  const contextWindowNumber = Number(contextWindowRaw);
  const contextWindow = Number.isFinite(contextWindowNumber) && contextWindowNumber > 0 ? contextWindowNumber : null;

  const lastUsage = info.last_token_usage ?? info.lastTokenUsage ?? info.last ?? null;
  const totalUsage = info.total_token_usage ?? info.totalTokenUsage ?? info.total ?? null;

  function readNumber(value) {
    const next = Number(value);
    return Number.isFinite(next) && next >= 0 ? next : null;
  }

  function readInputSideTokens(usage) {
    if (!usage || typeof usage !== "object") {
      return null;
    }

    const input = readNumber(usage.input_tokens ?? usage.inputTokens);
    const cachedInput = readNumber(usage.cached_input_tokens ?? usage.cachedInputTokens);
    if (input === null && cachedInput === null) {
      return null;
    }

    return (input || 0) + (cachedInput || 0);
  }

  function readTotalTokens(usage) {
    if (!usage || typeof usage !== "object") {
      return null;
    }

    return readNumber(usage.total_tokens ?? usage.totalTokens);
  }

  const candidates = [];
  const lastInputSide = readInputSideTokens(lastUsage);
  const lastTotal = readTotalTokens(lastUsage);
  const totalInputSide = readInputSideTokens(totalUsage);
  const cumulativeTotal = readTotalTokens(totalUsage);
  if (lastInputSide !== null) candidates.push(lastInputSide);
  if (lastTotal !== null) candidates.push(lastTotal);
  if (totalInputSide !== null) candidates.push(totalInputSide);
  if (cumulativeTotal !== null && (contextWindow === null || cumulativeTotal <= contextWindow * 1.05)) {
    candidates.push(cumulativeTotal);
  }

  let usedTokens = null;
  if (contextWindow !== null) {
    const bounded = candidates.filter((x) => x <= (contextWindow * 1.1));
    if (bounded.length > 0) {
      usedTokens = Math.max(...bounded);
    }
  }
  if (usedTokens === null && candidates.length > 0) {
    usedTokens = candidates[0];
  }

  if (contextWindow === null && usedTokens === null) {
    return null;
  }

  return { contextWindow, usedTokens };
}

function updateContextUsageFromLogLines(threadId, lines) {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId || !Array.isArray(lines) || lines.length === 0) {
    return;
  }

  const prior = contextUsageByThread.get(normalizedThreadId) || null;
  let contextWindow = Number.isFinite(prior?.contextWindow) ? prior.contextWindow : null;
  let usedTokens = Number.isFinite(prior?.usedTokens) ? prior.usedTokens : null;

  for (const line of lines) {
    if (typeof line !== "string" || !line.trim()) {
      continue;
    }

    const parsed = safeJsonParse(line, null);
    if (!parsed || typeof parsed !== "object") {
      continue;
    }

    if (parsed.type === "event_msg" && parsed.payload && typeof parsed.payload === "object") {
      const payload = parsed.payload;
      if (payload.type === "task_started") {
        const startedWindow = Number(payload.model_context_window ?? payload.modelContextWindow ?? null);
        if (Number.isFinite(startedWindow) && startedWindow > 0) {
          contextWindow = startedWindow;
        }
      }

      const eventPieces = readTokenCountInfo(payload);
      if (eventPieces) {
        if (eventPieces.contextWindow !== null) {
          contextWindow = eventPieces.contextWindow;
        }
        if (eventPieces.usedTokens !== null) {
          usedTokens = eventPieces.usedTokens;
        }
      }
    }
  }

  if (Number.isFinite(contextWindow) && contextWindow > 0 && Number.isFinite(usedTokens) && usedTokens >= 0) {
    const ratio = Math.min(1, Math.max(0, usedTokens / contextWindow));
    const percentLeft = Math.max(0, Math.min(100, Math.round((1 - ratio) * 100)));
    contextUsageByThread.set(normalizedThreadId, { usedTokens, contextWindow, percentLeft });
    const activeThreadId = typeof getActiveSessionState()?.threadId === "string" ? getActiveSessionState().threadId.trim() : "";
    if (activeThreadId === normalizedThreadId) {
      updateContextLeftIndicator();
    }
  }
}

function updatePermissionInfoFromLogLines(threadId, lines) {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId || !Array.isArray(lines) || lines.length === 0) {
    return;
  }

  for (const line of lines) {
    if (typeof line !== "string" || !line.trim()) {
      continue;
    }

    const parsed = safeJsonParse(line, null);
    if (!parsed || typeof parsed !== "object") {
      continue;
    }

    if (parsed.type === "event_msg" && parsed.payload && typeof parsed.payload === "object") {
      const next = readPermissionInfoFromPayload(parsed.payload);
      if (next) {
        setPermissionLevelForThread(normalizedThreadId, next);
      }
      continue;
    }

    if (parsed.type === "session_meta" || parsed.type === "turn_context") {
      const next = readPermissionInfoFromPayload(parsed.payload || null);
      if (next) {
        setPermissionLevelForThread(normalizedThreadId, next);
      }
    }
  }
}

function normalizePath(path) {
  if (!path || typeof path !== "string") {
    return "";
  }

  return path.replace(/\\/g, "/");
}

function safeJsonParse(raw, fallbackValue) {
  if (!raw || typeof raw !== "string") {
    return fallbackValue;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

function getPromptDraftKeyForThreadId(threadId) {
  const normalized = typeof threadId === "string" ? threadId.trim() : "";
  return normalized ? `thread:${normalized}` : GLOBAL_PROMPT_DRAFT_KEY;
}

function getPromptDraftKeyForState(state) {
  if (!state) {
    return GLOBAL_PROMPT_DRAFT_KEY;
  }

  return getPromptDraftKeyForThreadId(state.threadId);
}

function getCurrentPromptDraftKey() {
  return getPromptDraftKeyForState(getActiveSessionState());
}

function loadPromptDraftState() {
  promptDraftByKey = new Map();
  const raw = safeJsonParse(localStorage.getItem(STORAGE_PROMPT_DRAFTS_KEY), {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return;
  }

  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== "string" || !key.trim()) {
      continue;
    }

    const text = typeof value === "string" ? value : String(value || "");
    if (!text) {
      continue;
    }

    promptDraftByKey.set(key, text);
  }
}

function persistPromptDraftState() {
  const payload = {};
  for (const [key, value] of promptDraftByKey.entries()) {
    if (typeof key !== "string" || !key.trim()) {
      continue;
    }

    const text = typeof value === "string" ? value : String(value || "");
    if (!text) {
      continue;
    }

    payload[key] = text;
  }

  localStorage.setItem(STORAGE_PROMPT_DRAFTS_KEY, JSON.stringify(payload));
}

function rememberPromptDraftForKey(key, text) {
  const normalizedKey = typeof key === "string" ? key.trim() : "";
  if (!normalizedKey) {
    return;
  }

  const normalizedText = typeof text === "string" ? text : String(text || "");
  if (normalizedText) {
    promptDraftByKey.set(normalizedKey, normalizedText);
  } else {
    promptDraftByKey.delete(normalizedKey);
  }
}

function rememberPromptDraftForState(state) {
  if (!promptInput) {
    return;
  }

  rememberPromptDraftForKey(getPromptDraftKeyForState(state), promptInput.value);
  persistPromptDraftState();
}

function clearCurrentPromptDraft() {
  rememberPromptDraftForKey(getCurrentPromptDraftKey(), "");
  persistPromptDraftState();
}

function restorePromptDraftForActiveSession(options = {}) {
  if (!promptInput) {
    return;
  }

  const includeGlobalFallback = options.includeGlobalFallback !== false;
  const key = getCurrentPromptDraftKey();
  let nextValue = promptDraftByKey.get(key);

  if ((nextValue === undefined || nextValue === null || nextValue === "")
      && includeGlobalFallback
      && key !== GLOBAL_PROMPT_DRAFT_KEY) {
    nextValue = promptDraftByKey.get(GLOBAL_PROMPT_DRAFT_KEY);
  }

  const normalized = typeof nextValue === "string" ? nextValue : "";
  if (promptInput.value !== normalized) {
    promptInput.value = normalized;
  }
}

function normalizeQueuedPromptItem(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const text = typeof item.text === "string" ? item.text : String(item.text || "");
  const images = Array.isArray(item.images)
    ? item.images
      .filter((x) => x && typeof x.url === "string" && x.url.trim().length > 0)
      .slice(0, MAX_COMPOSER_IMAGES)
      .map((x) => ({
        url: x.url,
        name: typeof x.name === "string" ? x.name : "image",
        mimeType: typeof x.mimeType === "string" ? x.mimeType : "image/*",
        size: typeof x.size === "number" ? x.size : 0
      }))
    : [];

  if (!text.trim() && images.length === 0) {
    return null;
  }

  return { text, images };
}

function normalizeQueuedPromptList(list) {
  if (!Array.isArray(list)) {
    return [];
  }

  const normalized = [];
  for (const item of list) {
    const next = normalizeQueuedPromptItem(item);
    if (next) {
      normalized.push(next);
    }
  }

  return normalized;
}

function loadQueuedPromptState() {
  persistedPromptQueuesByThread = new Map();
  const raw = safeJsonParse(localStorage.getItem(STORAGE_QUEUED_PROMPTS_KEY), {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return;
  }

  for (const [threadId, list] of Object.entries(raw)) {
    const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
    if (!normalizedThreadId) {
      continue;
    }

    const normalizedList = normalizeQueuedPromptList(list);
    if (normalizedList.length > 0) {
      persistedPromptQueuesByThread.set(normalizedThreadId, normalizedList);
    }
  }
}

function restorePersistedQueueForSession(sessionId, threadId) {
  const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedSessionId || !normalizedThreadId) {
    return;
  }

  const existing = promptQueuesBySession.get(normalizedSessionId);
  if (existing && existing.length > 0) {
    return;
  }

  const persisted = persistedPromptQueuesByThread.get(normalizedThreadId);
  if (!persisted || persisted.length === 0) {
    return;
  }

  promptQueuesBySession.set(normalizedSessionId, persisted.map((x) => ({
    text: x.text,
    images: Array.isArray(x.images) ? x.images.map((img) => ({ ...img })) : []
  })));
}

function persistQueuedPromptState() {
  const nextByThread = new Map();

  for (const [threadId, items] of persistedPromptQueuesByThread.entries()) {
    const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
    if (!normalizedThreadId) {
      continue;
    }

    const normalizedItems = normalizeQueuedPromptList(items);
    if (normalizedItems.length > 0) {
      nextByThread.set(normalizedThreadId, normalizedItems);
    }
  }

  for (const [sessionId, queue] of promptQueuesBySession.entries()) {
    const state = sessions.get(sessionId);
    const threadId = typeof state?.threadId === "string" ? state.threadId.trim() : "";
    if (!threadId) {
      continue;
    }

    const normalizedQueue = normalizeQueuedPromptList(queue);
    if (normalizedQueue.length > 0) {
      nextByThread.set(threadId, normalizedQueue);
    } else {
      nextByThread.delete(threadId);
    }
  }

  persistedPromptQueuesByThread = nextByThread;

  const payload = {};
  for (const [threadId, queue] of nextByThread.entries()) {
    payload[threadId] = queue;
  }

  localStorage.setItem(STORAGE_QUEUED_PROMPTS_KEY, JSON.stringify(payload));
}

function normalizeProjectCwd(cwd) {
  const normalized = normalizePath(cwd || "").replace(/\/+$/g, "");
  return normalized;
}

function getProjectKeyFromCwd(cwd) {
  const normalized = normalizeProjectCwd(cwd);
  return normalized ? normalized.toLowerCase() : "(unknown)";
}

function pathLeaf(path) {
  const normalized = normalizeProjectCwd(path);
  if (!normalized) {
    return "";
  }

  const parts = normalized.split("/");
  return parts.length > 0 ? parts[parts.length - 1] : normalized;
}

function createRequestId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }

  return `req-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
}

function persistProjectNameMap() {
  const payload = {};
  for (const [key, value] of projectNameByKey.entries()) {
    const trimmed = String(value || "").trim();
    if (!trimmed) {
      continue;
    }

    payload[key] = trimmed;
  }

  localStorage.setItem(STORAGE_PROJECT_META_KEY, JSON.stringify(payload));
}

function persistCollapsedProjectKeys() {
  localStorage.setItem(STORAGE_COLLAPSED_PROJECTS_KEY, JSON.stringify(Array.from(collapsedProjectKeys)));
}

function persistArchivedThreads() {
  localStorage.setItem(STORAGE_ARCHIVED_THREADS_KEY, JSON.stringify(Array.from(archivedThreadIds)));
}

function persistCustomProjects() {
  localStorage.setItem(STORAGE_CUSTOM_PROJECTS_KEY, JSON.stringify(customProjects));
}

function loadProjectUiState() {
  projectNameByKey = new Map();
  const projectMeta = safeJsonParse(localStorage.getItem(STORAGE_PROJECT_META_KEY), {});
  if (projectMeta && typeof projectMeta === "object" && !Array.isArray(projectMeta)) {
    for (const [key, value] of Object.entries(projectMeta)) {
      const trimmed = String(value || "").trim();
      if (trimmed) {
        projectNameByKey.set(String(key), trimmed);
      }
    }
  }

  const collapsed = safeJsonParse(localStorage.getItem(STORAGE_COLLAPSED_PROJECTS_KEY), []);
  collapsedProjectKeys = new Set(Array.isArray(collapsed) ? collapsed.filter((x) => typeof x === "string") : []);

  const archived = safeJsonParse(localStorage.getItem(STORAGE_ARCHIVED_THREADS_KEY), []);
  archivedThreadIds = new Set(Array.isArray(archived) ? archived.filter((x) => typeof x === "string" && x.trim()) : []);

  const custom = safeJsonParse(localStorage.getItem(STORAGE_CUSTOM_PROJECTS_KEY), []);
  customProjects = Array.isArray(custom)
    ? custom
      .filter((x) => x && typeof x === "object")
      .map((x) => {
        const cwd = normalizeProjectCwd(x.cwd || "");
        const key = cwd ? getProjectKeyFromCwd(cwd) : "";
        const name = typeof x.name === "string" ? x.name.trim() : "";
        if (!cwd) {
          return null;
        }

        return { key, cwd, name };
      })
      .filter((x) => !!x)
    : [];
}

function getProjectDisplayName(project) {
  if (!project) {
    return "(unknown project)";
  }

  const stored = projectNameByKey.get(project.key);
  if (stored) {
    return stored;
  }

  if (project.customName) {
    return project.customName;
  }

  const leaf = pathLeaf(project.cwd);
  return leaf || "(unknown project)";
}

function buildActionIcon(kind) {
  const icon = document.createElement("i");
  icon.setAttribute("aria-hidden", "true");

  const iconClass = {
    plus: "bi-plus-lg",
    pencil: "bi-pencil-square",
    archive: "bi-archive",
    restore: "bi-arrow-counterclockwise",
    chevronDown: "bi-chevron-down",
    chevronRight: "bi-chevron-right"
  }[kind] || "bi-plus-lg";

  icon.className = `bi ${iconClass}`;
  return icon;
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

function getCatalogEntryByThreadId(threadId) {
  if (!threadId) {
    return null;
  }

  return sessionCatalog.find((x) => x && x.threadId === threadId) || null;
}

function touchSessionActivity(sessionId, tick = Date.now()) {
  if (!sessionId || !sessions.has(sessionId)) {
    return;
  }

  const state = sessions.get(sessionId);
  if (!state) {
    return;
  }

  const normalizedTick = Number.isFinite(tick) ? tick : Date.now();
  state.lastActivityTick = normalizedTick;
  if (!state.createdAtTick) {
    state.createdAtTick = normalizedTick;
  }

  if (state.threadId) {
    const entry = getCatalogEntryByThreadId(state.threadId);
    if (entry) {
      entry.updatedAtUtc = new Date(normalizedTick).toISOString();
    }
  }
}

function clearPendingSessionLoad(options = {}) {
  pendingSessionLoadThreadId = null;
  if (!options.keepPrevious) {
    pendingSessionLoadPreviousActiveId = null;
  }
  if (chatPanel) {
    chatPanel.classList.remove("session-loading");
  }
}

function beginPendingSessionLoad(threadId, displayName = "") {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId) {
    return;
  }

  pendingSessionLoadThreadId = normalizedThreadId;
  pendingSessionLoadPreviousActiveId = activeSessionId || null;
  if (chatPanel) {
    chatPanel.classList.add("session-loading");
  }

  timelinePollGeneration += 1;
  if (timelinePollTimer) {
    clearInterval(timelinePollTimer);
    timelinePollTimer = null;
  }
  timelineCursor = null;
  timeline.clear();
  const title = displayName && displayName.trim().length > 0
    ? `Loading ${displayName.trim()}...`
    : `Loading ${normalizedThreadId}...`;
  timeline.enqueueSystem(title, "Session");
  timeline.flush();
  renderProjectSidebar();
}

function handlePendingSessionLoadFailure() {
  if (!pendingSessionLoadThreadId) {
    return;
  }

  const prior = pendingSessionLoadPreviousActiveId;
  clearPendingSessionLoad();
  if (prior && sessions.has(prior)) {
    setActiveSession(prior, { restartTimeline: true });
    return;
  }

  restartTimelinePolling();
}

function setLocalThreadName(threadId, threadName) {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId) {
    return;
  }

  const normalizedName = String(threadName || "").trim();
  for (const state of sessions.values()) {
    if (state && state.threadId === normalizedThreadId) {
      state.threadName = normalizedName || state.threadName || "";
    }
  }

  for (const entry of sessionCatalog) {
    if (entry && entry.threadId === normalizedThreadId && normalizedName) {
      entry.threadName = normalizedName;
    }
  }
}

function getAttachedSessionIdByThreadId(threadId) {
  if (!threadId) {
    return null;
  }

  for (const [sessionId, state] of sessions.entries()) {
    if (state && state.threadId === threadId) {
      return sessionId;
    }
  }

  return null;
}

function getProjectForSessionState(state) {
  if (!state) {
    return { key: "(unknown)", cwd: "" };
  }

  const cwd = normalizeProjectCwd(state.cwd || "");
  return { key: getProjectKeyFromCwd(cwd), cwd };
}

function buildSidebarProjectGroups() {
  const map = new Map();
  const seenThreads = new Set();

  function ensureProject(cwd) {
    const normalizedCwd = normalizeProjectCwd(cwd || "");
    const key = getProjectKeyFromCwd(normalizedCwd);
    if (!map.has(key)) {
      const custom = customProjects.find((x) => x && x.key === key) || null;
      map.set(key, {
        key,
        cwd: normalizedCwd,
        customName: custom?.name || "",
        isCustom: !!custom,
        sessions: [],
        latestTick: 0
      });
    }

    return map.get(key);
  }

  for (const customProject of customProjects) {
    ensureProject(customProject.cwd);
  }

  for (const entry of sessionCatalog) {
    if (!entry || !entry.threadId) {
      continue;
    }

    const attachedSessionId = getAttachedSessionIdByThreadId(entry.threadId);
    const attachedState = attachedSessionId ? sessions.get(attachedSessionId) : null;
    const effectiveCwd = normalizeProjectCwd(entry.cwd || attachedState?.cwd || "");
    const project = ensureProject(effectiveCwd);
    const tick = Math.max(getCatalogSessionUpdatedTick(entry), attachedState?.lastActivityTick || attachedState?.createdAtTick || 0);
    if (tick > project.latestTick) {
      project.latestTick = tick;
    }

    project.sessions.push({
      threadId: entry.threadId,
      threadName: entry.threadName || attachedState?.threadName || "",
      updatedAtUtc: tick > 0 ? new Date(tick).toISOString() : (entry.updatedAtUtc || null),
      sortTick: tick,
      cwd: effectiveCwd,
      model: entry.model || "",
      attachedSessionId,
      isAttached: !!attachedSessionId,
      isProcessing: attachedSessionId ? isTurnInFlight(attachedSessionId) : false,
      isArchived: archivedThreadIds.has(entry.threadId)
    });
    seenThreads.add(entry.threadId);
  }

  for (const [sessionId, state] of sessions.entries()) {
    if (!state || !state.threadId || seenThreads.has(state.threadId)) {
      continue;
    }

    const project = ensureProject(state.cwd || "");
    const tick = state.lastActivityTick || state.createdAtTick || 0;
    if (tick > project.latestTick) {
      project.latestTick = tick;
    }
    project.sessions.push({
      threadId: state.threadId,
      threadName: state.threadName || "",
      updatedAtUtc: tick > 0 ? new Date(tick).toISOString() : null,
      sortTick: tick,
      cwd: normalizeProjectCwd(state.cwd || ""),
      model: state.model || "",
      attachedSessionId: sessionId,
      isAttached: true,
      isProcessing: isTurnInFlight(sessionId),
      isArchived: archivedThreadIds.has(state.threadId)
    });
  }

  const groups = Array.from(map.values());
  for (const group of groups) {
    group.sessions.sort((a, b) => {
      const tickCompare = (b.sortTick || 0) - (a.sortTick || 0);
      if (tickCompare !== 0) {
        return tickCompare;
      }

      return (a.threadId || "").localeCompare(b.threadId || "");
    });
  }

  groups.sort((a, b) => {
    const tickCompare = b.latestTick - a.latestTick;
    if (tickCompare !== 0) {
      return tickCompare;
    }

    return getProjectDisplayName(a).localeCompare(getProjectDisplayName(b));
  });

  return groups;
}

function isMobileViewport() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(max-width: 900px)").matches
    : false;
}

function isMobileProjectsOpen() {
  return !!layoutRoot && layoutRoot.classList.contains("mobile-projects-open");
}

function updateMobileProjectsButton() {
  const mobile = isMobileViewport();
  const open = mobile && isMobileProjectsOpen();

  if (mobileProjectsBtn) {
    mobileProjectsBtn.setAttribute("aria-expanded", open ? "true" : "false");
    mobileProjectsBtn.title = open ? "Hide projects" : "Show projects";
    mobileProjectsBtn.setAttribute("aria-label", mobileProjectsBtn.title);
  }

  if (sidebarToggleBtn) {
    const icon = sidebarToggleBtn.querySelector("i");
    if (mobile) {
      sidebarToggleBtn.title = "Close projects";
      sidebarToggleBtn.setAttribute("aria-label", "Close projects");
      sidebarToggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
      if (icon) {
        icon.className = "bi bi-x-lg";
      }
      return;
    }

    const collapsed = isSidebarCollapsed();
    const label = collapsed ? "Show projects" : "Hide projects";
    sidebarToggleBtn.title = label;
    sidebarToggleBtn.setAttribute("aria-label", label);
    sidebarToggleBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    if (icon) {
      icon.className = collapsed ? "bi bi-layout-sidebar-inset" : "bi bi-layout-sidebar-inset-reverse";
    }
  }
}

function setMobileProjectsOpen(isOpen) {
  if (!layoutRoot) {
    return;
  }

  const mobile = isMobileViewport();
  const open = mobile ? !!isOpen : false;
  layoutRoot.classList.toggle("mobile-projects-open", open);
  if (sidebarBackdrop) {
    sidebarBackdrop.classList.toggle("hidden", !open);
  }

  updateMobileProjectsButton();
}

function updateConversationMetaVisibility() {
  if (!sessionMeta || !sessionMetaModelItem) {
    return;
  }

  const hasState = !!getActiveSessionState();

  if (sessionMetaDetailsBtn) {
    sessionMetaDetailsBtn.classList.add("hidden");
    sessionMetaDetailsBtn.setAttribute("aria-expanded", "false");
  }

  sessionMeta.classList.toggle("hidden", !hasState);
  sessionMetaModelItem.classList.toggle("hidden", !hasState);
  permissionLevelIndicator?.classList.toggle("hidden", !hasState);
}

function applySidebarCollapsed(isCollapsed) {
  if (!layoutRoot) {
    return;
  }

  if (isMobileViewport()) {
    layoutRoot.classList.remove("sidebar-collapsed");
    updateMobileProjectsButton();
    return;
  }

  layoutRoot.classList.toggle("sidebar-collapsed", isCollapsed);
  localStorage.setItem(STORAGE_SIDEBAR_COLLAPSED_KEY, isCollapsed ? "1" : "0");
  if (sidebarToggleBtn) {
    const label = isCollapsed ? "Show projects" : "Hide projects";
    sidebarToggleBtn.title = label;
    sidebarToggleBtn.setAttribute("aria-label", label);
    sidebarToggleBtn.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    const icon = sidebarToggleBtn.querySelector("i");
    if (icon) {
      icon.className = isCollapsed ? "bi bi-layout-sidebar-inset" : "bi bi-layout-sidebar-inset-reverse";
    }
  }
}

function isSidebarCollapsed() {
  return !!layoutRoot && layoutRoot.classList.contains("sidebar-collapsed");
}

function selectProject(projectKey, projectCwd = "") {
  selectedProjectKey = projectKey || null;
  const normalizedCwd = normalizeProjectCwd(projectCwd || "");
  if (normalizedCwd) {
    cwdInput.value = normalizedCwd;
    localStorage.setItem(STORAGE_CWD_KEY, normalizedCwd);
  }

  renderProjectSidebar();
  if (isMobileViewport()) {
    setMobileProjectsOpen(false);
  }
}

function syncSelectedProjectFromActiveSession() {
  const active = getActiveSessionState();
  if (!active) {
    return;
  }

  const info = getProjectForSessionState(active);
  if (!info.key || info.key === "(unknown)") {
    return;
  }

  selectedProjectKey = info.key;
}

function formatSessionSubtitle(entry) {
  const parts = [];
  if (entry.updatedAtUtc) {
    const tick = Date.parse(entry.updatedAtUtc);
    if (Number.isFinite(tick)) {
      parts.push(new Date(tick).toLocaleString());
    }
  }

  if (entry.model) {
    parts.push(entry.model);
  }

  return parts.join(" | ");
}

async function createSessionForCwd(cwd, options = {}) {
  const normalizedCwd = normalizeProjectCwd(cwd || "");
  const rawName = options.askName === false ? "" : window.prompt("Session name (optional):", "");
  if (rawName === null) {
    return;
  }

  const threadName = String(rawName || "").trim();

  try {
    await ensureSocket();
  } catch (error) {
    appendLog(`[ws] connect failed: ${error}`);
    return;
  }

  const payload = {};
  if (normalizedCwd) {
    payload.cwd = normalizedCwd;
  }

  const model = modelValueForCreate();
  if (model) {
    payload.model = model;
  }

  const requestId = createRequestId();
  payload.requestId = requestId;
  if (threadName || normalizedCwd) {
    pendingCreateRequests.set(requestId, { threadName, cwd: normalizedCwd });
  }

  if (normalizedCwd) {
    cwdInput.value = normalizedCwd;
    localStorage.setItem(STORAGE_CWD_KEY, normalizedCwd);
  }

  send("session_create", payload);
  send("session_catalog_list");
}

async function attachSessionByThreadId(threadId, cwd) {
  if (!threadId) {
    return false;
  }

  try {
    await ensureSocket();
  } catch (error) {
    appendLog(`[ws] connect failed: ${error}`);
    return false;
  }

  const payload = { threadId };
  const model = modelValueForCreate();
  if (model) {
    payload.model = model;
  }

  const normalizedCwd = normalizeProjectCwd(cwd || cwdInput.value.trim());
  if (normalizedCwd) {
    payload.cwd = normalizedCwd;
    cwdInput.value = normalizedCwd;
    localStorage.setItem(STORAGE_CWD_KEY, normalizedCwd);
  }

  return send("session_attach", payload);
}

async function renameSessionFromSidebar(entry) {
  if (!entry || !entry.threadId) {
    return;
  }

  const currentName = entry.threadName || "";
  const nextNameRaw = window.prompt("Rename session:", currentName);
  if (nextNameRaw === null) {
    return;
  }

  const nextName = String(nextNameRaw || "").trim();
  if (!nextName) {
    appendLog("[rename] session name cannot be empty");
    return;
  }

  if (nextName.length > 200) {
    appendLog("[rename] name must be 200 characters or fewer");
    return;
  }

  try {
    await ensureSocket();
  } catch (error) {
    appendLog(`[ws] connect failed: ${error}`);
    return;
  }

  if (entry.attachedSessionId && sessions.has(entry.attachedSessionId)) {
    send("session_rename", { sessionId: entry.attachedSessionId, threadName: nextName });
    send("session_catalog_list");
    return;
  }

  pendingRenameOnAttach.set(entry.threadId, nextName);
  await attachSessionByThreadId(entry.threadId, entry.cwd);
}

function toggleSessionArchived(threadId) {
  if (!threadId) {
    return;
  }

  if (archivedThreadIds.has(threadId)) {
    archivedThreadIds.delete(threadId);
  } else {
    archivedThreadIds.add(threadId);
  }

  persistArchivedThreads();
  renderProjectSidebar();
}

function promptCreateProject() {
  const seedCwd = cwdInput.value.trim();
  const cwdRaw = window.prompt("Project working directory:", seedCwd || "");
  if (cwdRaw === null) {
    return;
  }

  const cwd = normalizeProjectCwd(cwdRaw || "");
  if (!cwd) {
    appendLog("[project] working directory is required");
    return;
  }

  const key = getProjectKeyFromCwd(cwd);
  if (!customProjects.some((x) => x && x.key === key)) {
    customProjects.push({ key, cwd, name: "" });
    persistCustomProjects();
  }

  const currentName = projectNameByKey.get(key) || pathLeaf(cwd);
  const nameRaw = window.prompt("Project name (optional):", currentName || "");
  if (nameRaw !== null) {
    const name = String(nameRaw || "").trim();
    if (name) {
      projectNameByKey.set(key, name);
    } else {
      projectNameByKey.delete(key);
    }
    persistProjectNameMap();
  }

  selectProject(key, cwd);
}

function renameProject(project) {
  if (!project) {
    return;
  }

  const key = project.key;
  const currentName = projectNameByKey.get(key) || getProjectDisplayName(project);
  const nameRaw = window.prompt("Rename project:", currentName || "");
  if (nameRaw === null) {
    return;
  }

  const name = String(nameRaw || "").trim();
  if (name) {
    projectNameByKey.set(key, name);
  } else {
    projectNameByKey.delete(key);
  }

  persistProjectNameMap();
  renderProjectSidebar();
}

function toggleProjectCollapsed(projectKey) {
  if (!projectKey) {
    return;
  }

  if (collapsedProjectKeys.has(projectKey)) {
    collapsedProjectKeys.delete(projectKey);
  } else {
    collapsedProjectKeys.add(projectKey);
  }

  persistCollapsedProjectKeys();
  renderProjectSidebar();
}

function renderProjectSidebar() {
  if (!projectList) {
    return;
  }

  const groups = buildSidebarProjectGroups();
  if (!selectedProjectKey && groups.length > 0) {
    selectedProjectKey = groups[0].key;
  } else if (selectedProjectKey && !groups.some((x) => x.key === selectedProjectKey)) {
    selectedProjectKey = groups.length > 0 ? groups[0].key : null;
  }

  projectList.textContent = "";
  if (groups.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "No sessions yet. Create a project or start a session.";
    projectList.appendChild(empty);
    return;
  }

  for (const group of groups) {
    const visibleSessions = group.sessions.filter((x) => !x.isArchived || x.attachedSessionId === activeSessionId);
    const hasSessionOverflow = visibleSessions.length > MAX_PROJECT_SESSIONS_COLLAPSED;
    const projectSessionsExpanded = expandedProjectKeys.has(group.key);
    const sessionsToRender = hasSessionOverflow && !projectSessionsExpanded
      ? visibleSessions.slice(0, MAX_PROJECT_SESSIONS_COLLAPSED)
      : visibleSessions;
    if (visibleSessions.length === 0 && !group.isCustom) {
      continue;
    }

    const groupEl = document.createElement("div");
    groupEl.className = "project-group";
    if (collapsedProjectKeys.has(group.key)) {
      groupEl.classList.add("collapsed");
    }

    const header = document.createElement("div");
    header.className = "project-header";
    if (group.key === selectedProjectKey) {
      header.classList.add("active");
    }

    const projectCollapsed = collapsedProjectKeys.has(group.key);
    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "project-toggle";
    toggleBtn.appendChild(buildActionIcon(projectCollapsed ? "chevronRight" : "chevronDown"));
    toggleBtn.title = projectCollapsed ? "Expand project" : "Collapse project";
    toggleBtn.setAttribute("aria-label", projectCollapsed ? "Expand project" : "Collapse project");
    toggleBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleProjectCollapsed(group.key);
    });
    header.appendChild(toggleBtn);

    const nameWrap = document.createElement("div");
    nameWrap.className = "project-name-wrap";
    nameWrap.addEventListener("click", () => {
      selectProject(group.key, group.cwd);
    });

    const name = document.createElement("div");
    name.className = "project-name";
    name.textContent = `${getProjectDisplayName(group)} (${visibleSessions.length})`;
    nameWrap.appendChild(name);

    const path = document.createElement("div");
    path.className = "project-path";
    path.textContent = group.cwd || "(unknown cwd)";
    nameWrap.appendChild(path);
    header.appendChild(nameWrap);

    const headerActions = document.createElement("div");
    headerActions.className = "project-actions";

    const newSessionAction = document.createElement("button");
    newSessionAction.type = "button";
    newSessionAction.className = "icon-btn";
    newSessionAction.title = "New session in this project";
    newSessionAction.setAttribute("aria-label", "New session in this project");
    newSessionAction.appendChild(buildActionIcon("plus"));
    newSessionAction.addEventListener("click", (event) => {
      event.stopPropagation();
      createSessionForCwd(group.cwd || cwdInput.value.trim());
    });
    headerActions.appendChild(newSessionAction);

    const renameProjectAction = document.createElement("button");
    renameProjectAction.type = "button";
    renameProjectAction.className = "icon-btn";
    renameProjectAction.title = "Rename project";
    renameProjectAction.setAttribute("aria-label", "Rename project");
    renameProjectAction.appendChild(buildActionIcon("pencil"));
    renameProjectAction.addEventListener("click", (event) => {
      event.stopPropagation();
      renameProject(group);
    });
    headerActions.appendChild(renameProjectAction);
    header.appendChild(headerActions);

    groupEl.appendChild(header);

    const sessionsWrap = document.createElement("div");
    sessionsWrap.className = "project-sessions";
    for (const entry of sessionsToRender) {
      const row = document.createElement("div");
      row.className = "session-row";
      const isPendingLoad = pendingSessionLoadThreadId && entry.threadId === pendingSessionLoadThreadId;
      const showOnlyPendingAsActive = !!pendingSessionLoadThreadId;
      if (!showOnlyPendingAsActive && entry.attachedSessionId && entry.attachedSessionId === activeSessionId) {
        row.classList.add("active");
      }
      if (isPendingLoad) {
        row.classList.add("active", "loading");
      }

      const head = document.createElement("div");
      head.className = "session-row-head";

      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "session-open-btn";
      openBtn.title = entry.threadId;
      openBtn.addEventListener("click", async () => {
        selectProject(group.key, group.cwd);

        if (entry.attachedSessionId && sessions.has(entry.attachedSessionId)) {
          clearPendingSessionLoad();
          setActiveSession(entry.attachedSessionId);
          send("session_select", { sessionId: entry.attachedSessionId });
          return;
        }

        beginPendingSessionLoad(entry.threadId, entry.threadName || entry.threadId);
        const attached = await attachSessionByThreadId(entry.threadId, entry.cwd || group.cwd);
        if (!attached) {
          handlePendingSessionLoadFailure();
        }
      });

      const title = document.createElement("div");
      title.className = "session-title";
      title.textContent = entry.threadName || entry.threadId;
      openBtn.appendChild(title);

      const subtitle = document.createElement("div");
      subtitle.className = "session-subtitle";
      subtitle.textContent = formatSessionSubtitle(entry);
      openBtn.appendChild(subtitle);
      head.appendChild(openBtn);

      const badges = document.createElement("div");
      badges.className = "session-badges";
      if (entry.isAttached) {
        const live = document.createElement("span");
        live.className = "session-badge live";
        live.textContent = "Live";
        badges.appendChild(live);
      }
      if (entry.isProcessing) {
        const processing = document.createElement("span");
        processing.className = "session-badge processing";
        processing.title = "Processing";
        processing.setAttribute("aria-label", "Processing");
        const spinner = document.createElement("i");
        spinner.className = "bi bi-arrow-repeat session-processing-icon";
        spinner.setAttribute("aria-hidden", "true");
        processing.appendChild(spinner);
        badges.appendChild(processing);
      }
      if (isPendingLoad) {
        const loading = document.createElement("span");
        loading.className = "session-badge processing";
        loading.title = "Loading session";
        loading.setAttribute("aria-label", "Loading session");
        const spinner = document.createElement("i");
        spinner.className = "bi bi-arrow-repeat session-processing-icon";
        spinner.setAttribute("aria-hidden", "true");
        loading.appendChild(spinner);
        badges.appendChild(loading);
      }
      head.appendChild(badges);

      const actions = document.createElement("div");
      actions.className = "project-actions";

      const renameSessionAction = document.createElement("button");
      renameSessionAction.type = "button";
      renameSessionAction.className = "icon-btn";
      renameSessionAction.title = "Rename session";
      renameSessionAction.setAttribute("aria-label", "Rename session");
      renameSessionAction.appendChild(buildActionIcon("pencil"));
      renameSessionAction.addEventListener("click", (event) => {
        event.stopPropagation();
        renameSessionFromSidebar(entry);
      });
      actions.appendChild(renameSessionAction);

      const archiveAction = document.createElement("button");
      archiveAction.type = "button";
      archiveAction.className = "icon-btn";
      archiveAction.title = entry.isArchived ? "Unarchive session" : "Archive session";
      archiveAction.setAttribute("aria-label", archiveAction.title);
      archiveAction.appendChild(buildActionIcon(entry.isArchived ? "restore" : "archive"));
      archiveAction.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleSessionArchived(entry.threadId);
      });
      actions.appendChild(archiveAction);
      head.appendChild(actions);

      row.appendChild(head);
      sessionsWrap.appendChild(row);
    }

    if (visibleSessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "sidebar-empty";
      empty.textContent = "No sessions in this project.";
      sessionsWrap.appendChild(empty);
    } else if (hasSessionOverflow) {
      const toggleMoreBtn = document.createElement("button");
      toggleMoreBtn.type = "button";
      toggleMoreBtn.className = "more-sessions-btn";
      if (projectSessionsExpanded) {
        toggleMoreBtn.textContent = "Show less";
      } else {
        const remainingCount = visibleSessions.length - sessionsToRender.length;
        toggleMoreBtn.textContent = `Read more (${remainingCount})`;
      }

      toggleMoreBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        if (expandedProjectKeys.has(group.key)) {
          expandedProjectKeys.delete(group.key);
        } else {
          expandedProjectKeys.add(group.key);
        }

        renderProjectSidebar();
      });
      sessionsWrap.appendChild(toggleMoreBtn);
    }

    groupEl.appendChild(sessionsWrap);
    projectList.appendChild(groupEl);
  }

  if (!projectList.firstChild) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "No sessions to display.";
    projectList.appendChild(empty);
  }
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
    const now = Date.now();
    sessions.set(sessionId, { threadId: null, cwd: null, model: null, createdAtTick: now, lastActivityTick: now });
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

  const normalized = !!value;
  const prior = turnInFlightBySession.get(sessionId) === true;
  turnInFlightBySession.set(sessionId, normalized);
  if (prior !== normalized) {
    renderProjectSidebar();
    if (sessionId === activeSessionId) {
      updatePromptActionState();
    }
  }
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

  promptQueue.textContent = "";
  const header = document.createElement("div");
  header.className = "prompt-queue-header";
  header.textContent = `Queued (${queue.length}) - tap to edit before sending`;
  promptQueue.appendChild(header);

  const list = document.createElement("div");
  list.className = "prompt-queue-list";
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    const imageCount = Array.isArray(item.images) ? item.images.length : 0;
    const imageSuffix = imageCount > 0 ? ` (+${imageCount} image${imageCount > 1 ? "s" : ""})` : "";
    const rawPreview = (item.text || "").trim() || (imageCount > 0 ? "(image only)" : "");
    const itemButton = document.createElement("button");
    itemButton.type = "button";
    itemButton.className = "prompt-queue-item";
    itemButton.textContent = `${i + 1}. ${trimPromptPreview(rawPreview)}${imageSuffix}`;
    itemButton.addEventListener("click", () => {
      restoreQueuedPromptForEditing(activeSessionId, i);
    });
    list.appendChild(itemButton);
  }
  promptQueue.appendChild(list);
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
  persistQueuedPromptState();
  if (sessionId === activeSessionId) {
    renderPromptQueue();
  }
}

function restoreQueuedPromptForEditing(sessionId, itemIndex) {
  if (!sessionId) {
    return;
  }

  const queue = getQueueForSession(sessionId);
  if (!queue || itemIndex < 0 || itemIndex >= queue.length) {
    return;
  }

  const [item] = queue.splice(itemIndex, 1);
  const text = String(item?.text || "");
  const restoredImages = Array.isArray(item?.images)
    ? item.images.filter((x) => x && typeof x.url === "string" && x.url.trim().length > 0)
    : [];

  promptInput.value = text;
  rememberPromptDraftForState(getActiveSessionState());

  pendingComposerImages = restoredImages.slice(0, MAX_COMPOSER_IMAGES).map((x) => ({
    id: nextComposerImageId++,
    name: x.name || "image",
    mimeType: x.mimeType || "image/*",
    size: typeof x.size === "number" ? x.size : 0,
    url: x.url
  }));
  renderComposerImages();
  renderPromptQueue();
  persistQueuedPromptState();

  promptInput.focus();
  promptInput.selectionStart = promptInput.selectionEnd = promptInput.value.length;
}

function startTurn(sessionId, promptText, images = [], options = {}) {
  const normalizedText = String(promptText || "").trim();
  const safeImages = Array.isArray(images) ? images.filter((x) => x && typeof x.url === "string" && x.url.trim().length > 0) : [];
  const turnCwd = cwdInput.value.trim();
  const turnModel = modelValueForCreate();
  if (!sessionId || (!normalizedText && safeImages.length === 0)) {
    return false;
  }

  const payload = {
    sessionId,
    text: normalizedText,
    images: safeImages.map((x) => ({ url: x.url, name: x.name || "image" }))
  };

  const state = sessions.get(sessionId);
  if (state && turnModel) {
    state.model = turnModel;
  }

  if (turnCwd) {
    payload.cwd = turnCwd;
    if (state) {
      state.cwd = turnCwd;
      if (sessionId === activeSessionId) {
        refreshSessionMeta();
      }
      renderProjectSidebar();
    }
  }

  if (turnModel) {
    payload.model = turnModel;
    if (state && sessionId === activeSessionId && !turnCwd) {
      refreshSessionMeta();
      renderProjectSidebar();
    }
  }

  if (!send("turn_start", payload)) {
    return false;
  }

  touchSessionActivity(sessionId);
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
    persistQueuedPromptState();
    return false;
  }
  persistQueuedPromptState();

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

  persistQueuedPromptState();
}

function storeLastThreadId(threadId) {
  const normalized = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalized) {
    return;
  }

  localStorage.setItem(STORAGE_LAST_THREAD_ID_KEY, normalized);
}

function getStoredLastThreadId() {
  const value = localStorage.getItem(STORAGE_LAST_THREAD_ID_KEY);
  return value && value.trim().length > 0 ? value.trim() : null;
}

async function tryAutoAttachStoredThread() {
  if (autoAttachAttempted) {
    return;
  }

  if (sessions.size > 0 || activeSessionId) {
    autoAttachAttempted = true;
    return;
  }

  const threadId = getStoredLastThreadId();
  if (!threadId) {
    autoAttachAttempted = true;
    return;
  }

  const existsInCatalog = sessionCatalog.some((s) => s && s.threadId === threadId);
  if (!existsInCatalog) {
    autoAttachAttempted = true;
    return;
  }

  autoAttachAttempted = true;

  try {
    await ensureSocket();
  } catch (error) {
    appendLog(`[session] auto-attach connect failed: ${error}`);
    return;
  }

  appendLog(`[session] auto-attaching previous thread=${threadId}`);
  send("session_attach", { threadId });
}

function syncConversationModelOptions(preferredValue = null) {
  if (!conversationModelSelect || !modelSelect) {
    return;
  }

  const targetValue = preferredValue === null || preferredValue === undefined
    ? (conversationModelSelect.value || modelSelect.value || "")
    : String(preferredValue || "");

  syncingConversationModelSelect = true;
  conversationModelSelect.textContent = "";

  for (const option of Array.from(modelSelect.options)) {
    const next = document.createElement("option");
    next.value = option.value;
    next.textContent = option.textContent || option.value;
    conversationModelSelect.appendChild(next);
  }

  if (targetValue && Array.from(conversationModelSelect.options).some((x) => x.value === targetValue)) {
    conversationModelSelect.value = targetValue;
  } else if (targetValue && targetValue.trim()) {
    const custom = targetValue.trim();
    const adHocOption = document.createElement("option");
    adHocOption.value = custom;
    adHocOption.textContent = `${custom} (active)`;
    conversationModelSelect.appendChild(adHocOption);
    conversationModelSelect.value = custom;
  } else {
    conversationModelSelect.value = modelSelect.value || "";
  }

  syncingConversationModelSelect = false;
}

function refreshSessionMeta() {
  if (!sessionMeta || !sessionMetaModelItem) {
    return;
  }

  const state = getActiveSessionState();
  if (!state) {
    if (conversationTitle) {
      conversationTitle.textContent = "Conversation";
      conversationTitle.title = "";
    }
    sessionMeta.classList.add("hidden");
    sessionMetaModelItem.classList.add("hidden");
    syncConversationModelOptions(modelSelect.value || "");
    sessionMeta.title = "";
    updateContextLeftIndicator();
    updatePermissionLevelIndicator();
    updateConversationMetaVisibility();
    return;
  }

  const namedCatalogEntry = getCatalogEntryByThreadId(state.threadId);
  const threadName = namedCatalogEntry?.threadName || state.threadName || "";
  const threadId = state.threadId || "";
  const selectedModel = state.model || modelValueForCreate() || "";
  const titleValue = threadName || threadId || "Conversation";
  if (conversationTitle) {
    conversationTitle.textContent = titleValue;
    conversationTitle.title = titleValue;
  }
  sessionMeta.classList.remove("hidden");

  syncConversationModelOptions(selectedModel);
  sessionMetaModelItem.dataset.available = "1";
  sessionMetaModelItem.classList.remove("hidden");
  sessionMeta.title = "";
  updateContextLeftIndicator();
  updatePermissionLevelIndicator();
  updateConversationMetaVisibility();
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
    const lines = Array.isArray(data.lines) ? data.lines : [];
    updateContextUsageFromLogLines(state.threadId, lines);
    updatePermissionInfoFromLogLines(state.threadId, lines);
    timeline.enqueueParsedLines(lines);

    if (data.truncated === true) {
      timeline.enqueueInlineNotice("Showing latest log lines.");
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
  const previousState = getActiveSessionState();
  if (changed) {
    rememberPromptDraftForState(previousState);
  }

  activeSessionId = sessionId;
  if (sessionSelect) {
    sessionSelect.value = sessionId;
  }
  stopSessionBtn.disabled = false;
  const state = sessions.get(sessionId);
  if (state?.threadId && pendingSessionLoadThreadId && state.threadId === pendingSessionLoadThreadId) {
    clearPendingSessionLoad();
  }
  if (state?.threadId) {
    restorePersistedQueueForSession(sessionId, state.threadId);
  }
  if (state && state.threadId) {
    storeLastThreadId(state.threadId);
  }
  syncSelectedProjectFromActiveSession();
  refreshSessionMeta();
  updateContextLeftIndicator();
  updatePermissionLevelIndicator();
  updatePromptActionState();
  renderPromptQueue();
  if (changed) {
    clearComposerImages();
    restorePromptDraftForActiveSession();
  }
  renderProjectSidebar();
  if (changed && isMobileViewport()) {
    setMobileProjectsOpen(false);
  }

  if (changed || restartTimeline) {
    timelineCursor = null;
    timeline.clear();
    restartTimelinePolling();
  }

  updateScrollToBottomButton();
}

function clearActiveSession() {
  const previousState = getActiveSessionState();
  rememberPromptDraftForState(previousState);

  activeSessionId = null;
  refreshSessionMeta();
  stopSessionBtn.disabled = true;
  renderPromptQueue();
  clearComposerImages();
  restorePromptDraftForActiveSession();
  updateContextLeftIndicator();
  updatePermissionLevelIndicator();
  updatePromptActionState();
  timelineCursor = null;
  timeline.clear();
  renderProjectSidebar();
  restartTimelinePolling();
  updateScrollToBottomButton();
}

function updateSessionSelect(activeIdFromServer) {
  const current = sessionSelect ? sessionSelect.value : "";
  if (sessionSelect) {
    sessionSelect.textContent = "";
  }

  const ids = Array.from(sessions.keys());
  ids.sort();
  if (sessionSelect) {
    for (const id of ids) {
      const state = sessions.get(id);
      const option = document.createElement("option");
      option.value = id;
      const namedCatalogEntry = getCatalogEntryByThreadId(state.threadId);
      const threadShort = state.threadId ? state.threadId.slice(0, 8) : "unknown";
      const threadName = namedCatalogEntry && namedCatalogEntry.threadName ? namedCatalogEntry.threadName : null;
      option.textContent = threadName || `${id.slice(0, 8)} (${threadShort})`;
      option.title = `session=${id} thread=${state.threadId || "unknown"}`;
      sessionSelect.appendChild(option);
    }
  }

  const toSelect = activeIdFromServer || activeSessionId || current || (ids.length > 0 ? ids[0] : null);
  if (toSelect && sessions.has(toSelect)) {
    const changed = activeSessionId !== toSelect;
    setActiveSession(toSelect, { restartTimeline: changed });
  } else {
    clearActiveSession();
  }

  renderProjectSidebar();
}

function updateExistingSessionSelect() {
  if (existingSessionSelect) {
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

  renderProjectSidebar();
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
  if (modelCommandSelect) {
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

  syncConversationModelOptions();
}

function applyModelSelection(value) {
  const normalized = (value || "").trim();
  if (!normalized) {
    modelSelect.value = "";
    modelCustomInput.classList.add("hidden");
    syncModelCommandOptionsFromToolbar();
    const state = getActiveSessionState();
    if (state) {
      state.model = null;
    }
    refreshSessionMeta();
    renderProjectSidebar();
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
    const state = getActiveSessionState();
    if (state) {
      state.model = modelValueForCreate() || null;
    }
    refreshSessionMeta();
    renderProjectSidebar();
    return;
  }

  modelSelect.value = "__custom__";
  modelCustomInput.classList.remove("hidden");
  modelCustomInput.value = normalized;
  syncModelCommandOptionsFromToolbar();
  const state = getActiveSessionState();
  if (state) {
    state.model = modelValueForCreate() || null;
  }
  refreshSessionMeta();
  renderProjectSidebar();
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
  loadProjectUiState();
  loadPromptDraftState();
  loadQueuedPromptState();

  const savedCwd = localStorage.getItem(STORAGE_CWD_KEY);
  if (savedCwd) {
    cwdInput.value = normalizeProjectCwd(savedCwd);
    if (cwdInput.value) {
      selectedProjectKey = getProjectKeyFromCwd(cwdInput.value);
    }
  }

  const savedVerbosity = localStorage.getItem(STORAGE_LOG_VERBOSITY_KEY);
  if (savedVerbosity && Array.from(logVerbositySelect.options).some((o) => o.value === savedVerbosity)) {
    logVerbositySelect.value = savedVerbosity;
  }

  const sidebarCollapsed = localStorage.getItem(STORAGE_SIDEBAR_COLLAPSED_KEY) === "1";
  applySidebarCollapsed(sidebarCollapsed);
  setMobileProjectsOpen(false);
  restorePromptDraftForActiveSession();
}

function getCurrentLogVerbosity() {
  return logVerbositySelect.value || "normal";
}

function sendCurrentLogVerbosity() {
  send("log_verbosity_set", { verbosity: getCurrentLogVerbosity() });
}

function stopSessionListSync() {
  if (sessionListPollTimer) {
    clearInterval(sessionListPollTimer);
    sessionListPollTimer = null;
  }
}

function startSessionListSync() {
  stopSessionListSync();
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  sessionListPollTimer = setInterval(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      stopSessionListSync();
      return;
    }
    send("session_list");
  }, SESSION_LIST_SYNC_INTERVAL_MS);
}

function ensureSocket() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    startSessionListSync();
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
    startSessionListSync();
    send("session_list");
    send("session_catalog_list");
    send("models_list");
    sendCurrentLogVerbosity();
  });
  socket.addEventListener("close", () => {
    appendLog("[ws] disconnected");
    socketReadyPromise = null;
    stopSessionListSync();
    setMobileProjectsOpen(false);
    clearPendingSessionLoad();
    autoAttachAttempted = false;
    persistQueuedPromptState();
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
      let pendingCreate = null;
      const requestId = payload.requestId || null;
      if (requestId && pendingCreateRequests.has(requestId)) {
        pendingCreate = pendingCreateRequests.get(requestId) || null;
        pendingCreateRequests.delete(requestId);
      }
      if (!normalizeProjectCwd(state.cwd || "") && pendingCreate?.cwd) {
        state.cwd = pendingCreate.cwd;
      }
      if (!state.createdAtTick) {
        state.createdAtTick = Date.now();
      }
      if (state.threadId) {
        const permissionInfo = readPermissionInfoFromPayload(payload);
        if (permissionInfo) {
          setPermissionLevelForThread(state.threadId, permissionInfo);
        }
      }
      if (state.threadId && normalizeProjectCwd(state.cwd || "")) {
        const entry = getCatalogEntryByThreadId(state.threadId);
        if (entry && !normalizeProjectCwd(entry.cwd || "")) {
          entry.cwd = state.cwd;
        }
      }
      touchSessionActivity(sessionId);
      if (state.threadId && pendingSessionLoadThreadId && state.threadId === pendingSessionLoadThreadId) {
        clearPendingSessionLoad();
      }
      setTurnInFlight(sessionId, false);
      const mode = payload.attached || type === "session_attached" ? "attached" : "created";
      appendLog(`[session] ${mode} id=${sessionId} thread=${state.threadId || "unknown"} log=${payload.logPath || "n/a"}`);

      if (pendingCreate && pendingCreate.threadName) {
        send("session_rename", { sessionId, threadName: pendingCreate.threadName });
          send("session_catalog_list");
      }

      if (state.threadId && pendingRenameOnAttach.has(state.threadId)) {
        const requestedName = pendingRenameOnAttach.get(state.threadId) || "";
        pendingRenameOnAttach.delete(state.threadId);
        if (requestedName) {
          send("session_rename", { sessionId, threadName: requestedName });
          send("session_catalog_list");
        }
      }

      updateSessionSelect(sessionId);
      return;
    }

    case "session_list": {
      const list = Array.isArray(payload.sessions) ? payload.sessions : [];
      const next = new Map();
      let matchedPendingThread = false;
      for (const s of list) {
        const existing = sessions.get(s.sessionId);
        const st = existing || { threadId: null, cwd: null, model: null, createdAtTick: Date.now(), lastActivityTick: 0 };
        st.threadId = s.threadId || st.threadId || null;
        st.cwd = s.cwd || st.cwd || null;
        st.model = s.model || st.model || null;
        st.createdAtTick = st.createdAtTick || Date.now();
        st.lastActivityTick = Number.isFinite(st.lastActivityTick) ? st.lastActivityTick : st.createdAtTick;
        if (st.threadId) {
          const permissionInfo = readPermissionInfoFromPayload(s);
          if (permissionInfo) {
            setPermissionLevelForThread(st.threadId, permissionInfo);
          }
        }
        if (pendingSessionLoadThreadId && st.threadId === pendingSessionLoadThreadId) {
          matchedPendingThread = true;
        }
        setTurnInFlight(s.sessionId, s.isTurnInFlight === true || s.turnInFlight === true);
        next.set(s.sessionId, st);
      }
      if (matchedPendingThread) {
        clearPendingSessionLoad();
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
      tryAutoAttachStoredThread().catch((error) => appendLog(`[session] auto-attach failed: ${error}`));
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
        touchSessionActivity(sessionId);
        setTurnInFlight(sessionId, false);
        pumpQueuedPrompt(sessionId);
      }
      const status = payload.status || "unknown";
      const errorMessage = payload.errorMessage || null;
      appendLog(`[turn] session=${payload.sessionId || "unknown"} status=${status}${errorMessage ? " error=" + errorMessage : ""}`);
      renderPromptQueue();
      return;
    }

    case "turn_started": {
      const sessionId = payload.sessionId || null;
      if (sessionId) {
        touchSessionActivity(sessionId);
        setTurnInFlight(sessionId, true);
      }
      return;
    }

    case "turn_cancel_requested": {
      const sessionId = payload.sessionId || null;
      if (sessionId) {
        touchSessionActivity(sessionId);
        setTurnInFlight(sessionId, true);
      }
      appendLog(`[turn] cancel requested for session=${sessionId || "unknown"}`);
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
      if (pendingSessionLoadThreadId) {
        handlePendingSessionLoadFailure();
      }
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
  const selectedGroup = buildSidebarProjectGroups().find((x) => x.key === selectedProjectKey) || null;
  const preferredCwd = selectedGroup?.cwd || cwdInput.value.trim();
  await createSessionForCwd(preferredCwd);
});

if (newProjectBtn) {
  newProjectBtn.addEventListener("click", () => {
    promptCreateProject();
  });
}

if (newProjectSidebarBtn) {
  newProjectSidebarBtn.addEventListener("click", () => {
    promptCreateProject();
  });
}

if (attachSessionBtn) {
  attachSessionBtn.addEventListener("click", async () => {
    const threadId = existingSessionSelect ? existingSessionSelect.value : "";
    if (!threadId) {
      appendLog("[catalog] select an existing thread to attach");
      return;
    }

    const catalogEntry = getCatalogEntryByThreadId(threadId);
    await attachSessionByThreadId(threadId, catalogEntry?.cwd || cwdInput.value.trim());
  });
}

stopSessionBtn.addEventListener("click", () => {
  if (!activeSessionId) return;
  send("session_stop", { sessionId: activeSessionId });
});

if (sessionSelect) {
  sessionSelect.addEventListener("change", () => {
    const sessionId = sessionSelect.value;
    if (!sessionId) return;
    if (!sessions.has(sessionId)) return;
    setActiveSession(sessionId);
    send("session_select", { sessionId });
  });
}

modelSelect.addEventListener("change", () => {
  if (modelSelect.value === "__custom__") {
    modelCustomInput.classList.remove("hidden");
    modelCustomInput.focus();
  } else {
    modelCustomInput.classList.add("hidden");
  }
  syncModelCommandOptionsFromToolbar();

  const nextModel = modelValueForCreate();
  if (activeSessionId && sessions.has(activeSessionId)) {
    const state = sessions.get(activeSessionId);
    if (state) {
      state.model = nextModel || null;
    }
    refreshSessionMeta();
    renderProjectSidebar();
  }
});

if (conversationModelSelect) {
  conversationModelSelect.addEventListener("change", () => {
    if (syncingConversationModelSelect) {
      return;
    }

    let selectedValue = conversationModelSelect.value || "";
    if (selectedValue === "__custom__") {
      const proposed = window.prompt("Custom model:", modelCustomInput.value || "");
      if (proposed === null) {
        syncConversationModelOptions(modelSelect.value || "");
        return;
      }

      const custom = String(proposed || "").trim();
      if (!custom) {
        appendLog("[model] custom model cannot be empty");
        syncConversationModelOptions(modelSelect.value || "");
        return;
      }

      selectedValue = custom;
    }

    applyModelSelection(selectedValue);
    const nextModel = modelValueForCreate();
    if (nextModel) {
      appendLog(`[model] selected '${nextModel}'`);
    } else {
      appendLog("[model] reverted to default");
    }
  });
}

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
  const normalized = normalizeProjectCwd(cwdInput.value.trim());
  cwdInput.value = normalized;
  localStorage.setItem(STORAGE_CWD_KEY, normalized);
  if (normalized) {
    selectedProjectKey = getProjectKeyFromCwd(normalized);
  }
  renderProjectSidebar();
});

if (sidebarToggleBtn) {
  sidebarToggleBtn.addEventListener("click", () => {
    if (isMobileViewport()) {
      setMobileProjectsOpen(false);
      return;
    }
    applySidebarCollapsed(!isSidebarCollapsed());
  });
}

if (mobileProjectsBtn) {
  mobileProjectsBtn.addEventListener("click", () => {
    setMobileProjectsOpen(!isMobileProjectsOpen());
  });
}

if (sidebarBackdrop) {
  sidebarBackdrop.addEventListener("click", () => {
    setMobileProjectsOpen(false);
  });
}

if (sessionMetaDetailsBtn) {
  sessionMetaDetailsBtn.addEventListener("click", () => {
    sessionMetaDetailsExpanded = !sessionMetaDetailsExpanded;
    updateConversationMetaVisibility();
  });
}

if (chatMessages) {
  chatMessages.addEventListener("scroll", () => {
    updateScrollToBottomButton();
  });

  chatMessages.addEventListener("codex:timeline-updated", () => {
    updateScrollToBottomButton();
  });
}

if (scrollToBottomBtn) {
  scrollToBottomBtn.addEventListener("click", () => {
    scrollMessagesToBottom(true);
  });
}

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

promptInput.addEventListener("input", () => {
  rememberPromptDraftForState(getActiveSessionState());
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
    send("session_catalog_list");
    appendLog(`[rename] requested '${nextName}'`);
    return true;
  }

  appendLog(`[client] unknown slash command: /${command}`);
  return true;
}

function queueCurrentComposerPrompt() {
  const prompt = promptInput.value.trim();
  const images = pendingComposerImages.map((x) => ({ ...x }));
  if (!prompt && images.length === 0) {
    return false;
  }

  if (!activeSessionId) {
    appendLog("[client] no active session; create or attach one first");
    return true;
  }

  queuePrompt(activeSessionId, prompt, images);
  promptInput.value = "";
  clearCurrentPromptDraft();
  clearComposerImages();
  appendLog(`[turn] queued prompt for session=${activeSessionId}`);
  renderPromptQueue();
  return true;
}

function cancelCurrentTurn() {
  if (!activeSessionId) {
    appendLog("[turn] no active session to cancel");
    return;
  }

  if (!isTurnInFlight(activeSessionId)) {
    appendLog(`[turn] no running turn to cancel for session=${activeSessionId}`);
    return;
  }

  if (!send("turn_cancel", { sessionId: activeSessionId })) {
    appendLog("[turn] failed to send cancel; websocket is closed");
    return;
  }

  appendLog(`[turn] cancel requested for session=${activeSessionId}`);
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
    clearCurrentPromptDraft();
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

  const started = startTurn(activeSessionId, prompt, images);
  if (!started) {
    appendLog(`[turn] failed to send prompt for session=${activeSessionId}`);
    return;
  }

  promptInput.value = "";
  clearCurrentPromptDraft();
  clearComposerImages();
  renderPromptQueue();
});

promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    if (!promptInput.value.trim() && pendingComposerImages.length === 0) {
      return;
    }

    event.preventDefault();
    queueCurrentComposerPrompt();
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
    rememberPromptDraftForState(getActiveSessionState());
    return;
  }

  if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    promptForm.requestSubmit();
  }
});

if (queuePromptBtn) {
  queuePromptBtn.addEventListener("click", () => {
    queueCurrentComposerPrompt();
    promptInput.focus();
  });
}

if (cancelTurnBtn) {
  cancelTurnBtn.addEventListener("click", () => {
    cancelCurrentTurn();
    promptInput.focus();
  });
}

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

  if (!modelCommandModal.classList.contains("hidden")) {
    event.preventDefault();
    closeModelCommandModal();
    return;
  }

  if (isMobileProjectsOpen()) {
    event.preventDefault();
    setMobileProjectsOpen(false);
  }
});

window.addEventListener("resize", () => {
  if (!isMobileViewport()) {
    setMobileProjectsOpen(false);
  }
  updateMobileProjectsButton();
  updateConversationMetaVisibility();
  updateScrollToBottomButton();
});

window.addEventListener("beforeunload", () => {
  rememberPromptDraftForState(getActiveSessionState());
  persistQueuedPromptState();
});

applySavedUiSettings();
renderComposerImages();
renderProjectSidebar();
updateScrollToBottomButton();
updatePromptActionState();
updateContextLeftIndicator();
updatePermissionLevelIndicator();
updateMobileProjectsButton();
updateConversationMetaVisibility();

timelineFlushTimer = setInterval(() => timeline.flush(), TIMELINE_POLL_INTERVAL_MS);

ensureSocket().catch((error) => appendLog(`[ws] connect failed: ${error}`));
