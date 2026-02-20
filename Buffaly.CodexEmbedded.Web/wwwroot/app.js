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
let pendingCreateRequests = new Map(); // requestId -> { threadName }
let pendingRenameOnAttach = new Map(); // threadId -> threadName

let timelineCursor = null;
let timelinePollTimer = null;
let timelineFlushTimer = null;
let timelinePollGeneration = 0;
let timelinePollInFlight = false;
let autoAttachAttempted = false;

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

const layoutRoot = document.querySelector(".layout");
const chatMessages = document.getElementById("chatMessages");
const logOutput = document.getElementById("logOutput");
const promptForm = document.getElementById("promptForm");
const promptInput = document.getElementById("promptInput");
const promptQueue = document.getElementById("promptQueue");
const composerImages = document.getElementById("composerImages");
const imageUploadInput = document.getElementById("imageUploadInput");
const imageUploadBtn = document.getElementById("imageUploadBtn");
const queuePromptBtn = document.getElementById("queuePromptBtn");

const newSessionBtn = document.getElementById("newSessionBtn");
const newProjectBtn = document.getElementById("newProjectBtn");
const newProjectSidebarBtn = document.getElementById("newProjectSidebarBtn");
const attachSessionBtn = document.getElementById("attachSessionBtn");
const existingSessionSelect = document.getElementById("existingSessionSelect");
const stopSessionBtn = document.getElementById("stopSessionBtn");
const sessionSelect = document.getElementById("sessionSelect");
const sessionMeta = document.getElementById("sessionMeta");
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
    restore: "bi-arrow-counterclockwise"
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

    const project = ensureProject(entry.cwd || "");
    const attachedSessionId = getAttachedSessionIdByThreadId(entry.threadId);
    const attachedState = attachedSessionId ? sessions.get(attachedSessionId) : null;
    const tick = Math.max(getCatalogSessionUpdatedTick(entry), attachedState?.createdAtTick || 0);
    if (tick > project.latestTick) {
      project.latestTick = tick;
    }

    project.sessions.push({
      threadId: entry.threadId,
      threadName: entry.threadName || attachedState?.threadName || "",
      updatedAtUtc: entry.updatedAtUtc || (tick > 0 ? new Date(tick).toISOString() : null),
      sortTick: tick,
      cwd: normalizeProjectCwd(entry.cwd || ""),
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
    project.sessions.push({
      threadId: state.threadId,
      threadName: state.threadName || "",
      updatedAtUtc: state.createdAtTick ? new Date(state.createdAtTick).toISOString() : null,
      sortTick: state.createdAtTick || 0,
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

function applySidebarCollapsed(isCollapsed) {
  if (!layoutRoot) {
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
  if (threadName) {
    pendingCreateRequests.set(requestId, { threadName });
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
  if (model) {
    payload.model = model;
  }

  const normalizedCwd = normalizeProjectCwd(cwd || cwdInput.value.trim());
  if (normalizedCwd) {
    payload.cwd = normalizedCwd;
    cwdInput.value = normalizedCwd;
    localStorage.setItem(STORAGE_CWD_KEY, normalizedCwd);
  }

  send("session_attach", payload);
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

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "project-toggle";
    toggleBtn.textContent = collapsedProjectKeys.has(group.key) ? ">" : "v";
    toggleBtn.title = "Collapse/expand project";
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
      if (entry.attachedSessionId && entry.attachedSessionId === activeSessionId) {
        row.classList.add("active");
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
          setActiveSession(entry.attachedSessionId);
          send("session_select", { sessionId: entry.attachedSessionId });
          return;
        }

        await attachSessionByThreadId(entry.threadId, entry.cwd || group.cwd);
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
        processing.textContent = "Processing";
        badges.appendChild(processing);
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

  const normalized = !!value;
  const prior = turnInFlightBySession.get(sessionId) === true;
  turnInFlightBySession.set(sessionId, normalized);
  if (prior !== normalized) {
    renderProjectSidebar();
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

  promptInput.focus();
  promptInput.selectionStart = promptInput.selectionEnd = promptInput.value.length;
}

function startTurn(sessionId, promptText, images = [], options = {}) {
  const normalizedText = String(promptText || "").trim();
  const safeImages = Array.isArray(images) ? images.filter((x) => x && typeof x.url === "string" && x.url.trim().length > 0) : [];
  const turnCwd = cwdInput.value.trim();
  if (!sessionId || (!normalizedText && safeImages.length === 0)) {
    return false;
  }

  const payload = {
    sessionId,
    text: normalizedText,
    images: safeImages.map((x) => ({ url: x.url, name: x.name || "image" }))
  };
  if (turnCwd) {
    payload.cwd = turnCwd;
    const state = sessions.get(sessionId);
    if (state) {
      state.cwd = turnCwd;
      if (sessionId === activeSessionId) {
        refreshSessionMeta();
      }
      renderProjectSidebar();
    }
  }

  if (!send("turn_start", payload)) {
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

function refreshSessionMeta() {
  if (!sessionMeta) {
    return;
  }

  const state = getActiveSessionState();
  if (!state) {
    sessionMeta.textContent = "";
    return;
  }

  const metaParts = [];
  const namedCatalogEntry = getCatalogEntryByThreadId(state.threadId);
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
  if (state && state.threadId) {
    storeLastThreadId(state.threadId);
  }
  syncSelectedProjectFromActiveSession();
  refreshSessionMeta();
  renderPromptQueue();
  if (changed) {
    clearComposerImages();
    restorePromptDraftForActiveSession();
  }
  renderProjectSidebar();

  if (changed || restartTimeline) {
    timelineCursor = null;
    timeline.clear();
    restartTimelinePolling();
  }
}

function clearActiveSession() {
  const previousState = getActiveSessionState();
  rememberPromptDraftForState(previousState);

  activeSessionId = null;
  if (sessionMeta) {
    sessionMeta.textContent = "";
  }
  stopSessionBtn.disabled = true;
  renderPromptQueue();
  clearComposerImages();
  restorePromptDraftForActiveSession();
  timelineCursor = null;
  timeline.clear();
  renderProjectSidebar();
  restartTimelinePolling();
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
  loadProjectUiState();
  loadPromptDraftState();

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
  restorePromptDraftForActiveSession();
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
    autoAttachAttempted = false;
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

      const requestId = payload.requestId || null;
      if (requestId && pendingCreateRequests.has(requestId)) {
        const pending = pendingCreateRequests.get(requestId);
        pendingCreateRequests.delete(requestId);
        if (pending && pending.threadName) {
          send("session_rename", { sessionId, threadName: pending.threadName });
          send("session_catalog_list");
        }
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
    applySidebarCollapsed(!isSidebarCollapsed());
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

  if (isTurnInFlight(activeSessionId)) {
    queuePrompt(activeSessionId, prompt, images);
    promptInput.value = "";
    clearCurrentPromptDraft();
    clearComposerImages();
    appendLog(`[turn] queued prompt for session=${activeSessionId}`);
    return;
  }

  promptInput.value = "";
  clearCurrentPromptDraft();
  clearComposerImages();
  startTurn(activeSessionId, prompt, images);
  renderPromptQueue();
});

promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
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

window.addEventListener("beforeunload", () => {
  rememberPromptDraftForState(getActiveSessionState());
});

applySavedUiSettings();
renderComposerImages();
renderProjectSidebar();

timelineFlushTimer = setInterval(() => timeline.flush(), TIMELINE_POLL_INTERVAL_MS);

ensureSocket().catch((error) => appendLog(`[ws] connect failed: ${error}`));
