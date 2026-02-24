const TIMELINE_POLL_INTERVAL_MS = 2000;
const TURN_ACTIVITY_TICK_INTERVAL_MS = 1000;
const LOG_FLUSH_INTERVAL_MS = 250;
const MAX_RENDERED_CLIENT_LOG_LINES = 800;
const ENABLE_CONSOLE_LOG_FALLBACK = false;
const INDEX_TIMELINE_SOURCE = "logs"; // keep index timeline poll-based; backend now serves consolidated turns from logs

let socket = null;
let socketReadyPromise = null;

let sessions = new Map(); // sessionId -> { threadId, cwd, model, reasoningEffort }
let sessionCatalog = []; // [{ threadId, threadName, updatedAtUtc, cwd, model, reasoningEffort, sessionFilePath }]
let activeSessionId = null;
let pendingApproval = null; // { sessionId, approvalId }
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
let projectOrderIndexByKey = new Map(); // projectKey -> stable display order index for current page lifetime
let nextProjectOrderIndex = 0;
let projectOrderInitialized = false;
let pendingCreateRequests = new Map(); // requestId -> { threadName, cwd }
let pendingRenameOnAttach = new Map(); // threadId -> threadName
let pendingSessionLoadThreadId = null;
let pendingSessionLoadPreviousActiveId = null;

let timelineCursor = null;
let timelinePollTimer = null;
let timelinePollGeneration = 0;
let timelinePollInFlight = false;
let sessionListPollTimer = null;
let logFlushTimer = null;
let autoAttachAttempted = false;
let sessionCatalogLoadedOnce = false;
let syncingConversationModelSelect = false;
let sessionMetaDetailsExpanded = false;
let contextUsageByThread = new Map(); // threadId -> { usedTokens, contextWindow, percentLeft }
let permissionLevelByThread = new Map(); // threadId -> { approval, sandbox }
let preferredModelByThread = new Map(); // threadId -> model string ("" means default)
let preferredReasoningByThread = new Map(); // threadId -> reasoning effort string ("" means default)
let processingByThread = new Map(); // threadId -> boolean
let completedUnreadThreadIds = new Set(); // threadId -> completion happened while not selected
let pendingSessionModelSyncBySession = new Map(); // sessionId -> "model||effort" pending sync request key
let lastConfirmedSessionModelSyncBySession = new Map(); // sessionId -> "model||effort" confirmed from server session state
let timelineHasTruncatedHead = false;
let timelineConnectionIssueShown = false;
let runtimeSecurityConfig = null;
let rateLimitBySession = new Map(); // sessionId -> latest rate limit summary payload
let renderedClientLogLines = [];
let pendingClientLogLines = [];
let turnActivityTickTimer = null;
let turnStartedAtBySession = new Map(); // sessionId -> epoch ms when running turn started
let lastReasoningByThread = new Map(); // threadId -> latest reasoning summary
let jumpCollapseMode = false;

const STORAGE_CWD_KEY = "codex-web-cwd";
const STORAGE_LOG_VERBOSITY_KEY = "codex-web-log-verbosity";
const STORAGE_LAST_THREAD_ID_KEY = "codex-web-last-thread-id";
const STORAGE_LAST_SESSION_ID_KEY = "codex-web-last-session-id";
const STORAGE_PROMPT_DRAFTS_KEY = "codex-web-prompt-drafts-v1";
const STORAGE_THREAD_MODELS_KEY = "codex-web-thread-models-v1";
const STORAGE_THREAD_REASONING_KEY = "codex-web-thread-reasoning-v1";
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
const SESSION_LIST_SYNC_INTERVAL_MS = 10000;
const SECURITY_WARNING_TEXT = "Security warning: this UI can execute commands and modify files through Codex. Do not expose it to the public internet. Recommended: bind to localhost and access via Tailscale tailnet-only.";
const REASONING_EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh"];

const layoutRoot = document.querySelector(".layout");
const chatPanel = document.querySelector(".chat-panel");
const chatMessages = document.getElementById("chatMessages");
const logOutput = document.getElementById("logOutput");
const promptForm = document.getElementById("promptForm");
const promptInput = document.getElementById("promptInput");
const promptQueue = document.getElementById("promptQueue");
const timelineTruncationNotice = document.getElementById("timelineTruncationNotice");
const scrollToBottomBtn = document.getElementById("scrollToBottomBtn");
const contextLeftIndicator = document.getElementById("contextLeftIndicator");
const permissionLevelIndicator = document.getElementById("permissionLevelIndicator");
const composerImages = document.getElementById("composerImages");
const imageUploadInput = document.getElementById("imageUploadInput");
const imageUploadBtn = document.getElementById("imageUploadBtn");
const queuePromptBtn = document.getElementById("queuePromptBtn");
const cancelTurnBtn = document.getElementById("cancelTurnBtn");
const turnActivityStrip = document.getElementById("turnActivityStrip");
const turnActivityTimer = document.getElementById("turnActivityTimer");
const turnActivityReasoning = document.getElementById("turnActivityReasoning");
const turnActivityCancelLink = document.getElementById("turnActivityCancelLink");
const sendPromptBtn = document.getElementById("sendPromptBtn");
const mobileProjectsBtn = document.getElementById("mobileProjectsBtn");
const sidebarBackdrop = document.getElementById("sidebarBackdrop");
const securityWarningBanner = document.getElementById("securityWarningBanner");
const aboutBtn = document.getElementById("aboutBtn");
const aboutModal = document.getElementById("aboutModal");
const aboutModalCloseBtn = document.getElementById("aboutModalCloseBtn");
const aboutProjectLine = document.getElementById("aboutProjectLine");
const aboutVersionLine = document.getElementById("aboutVersionLine");

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
const jumpToBtn = document.getElementById("jumpToBtn");
const conversationModelSelect = document.getElementById("conversationModelSelect");
const conversationReasoningSelect = document.getElementById("conversationReasoningSelect");
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
const newProjectModal = document.getElementById("newProjectModal");
const newProjectCwdInput = document.getElementById("newProjectCwdInput");
const newProjectFirstSessionInput = document.getElementById("newProjectFirstSessionInput");
const newProjectCreateBtn = document.getElementById("newProjectCreateBtn");
const newProjectCancelBtn = document.getElementById("newProjectCancelBtn");

const timeline = new window.CodexSessionTimeline({
  container: chatMessages,
  maxRenderedEntries: 1500,
  systemTitle: "Session"
});

function timelineUsesEventFeed() {
  return INDEX_TIMELINE_SOURCE === "events";
}

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

function updateTimelineTruncationNotice() {
  if (!timelineTruncationNotice || !chatMessages) {
    return;
  }

  const isAtTop = chatMessages.scrollTop <= 2;
  const shouldShow = timelineHasTruncatedHead && isAtTop;
  timelineTruncationNotice.classList.toggle("hidden", !shouldShow);
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
  updateTimelineTruncationNotice();
}

function setJumpCollapseMode(enabled) {
  const hasState = !!getActiveSessionState();
  const next = !!enabled && hasState;
  jumpCollapseMode = next;

  if (timeline && typeof timeline.setViewMode === "function") {
    timeline.setViewMode(next ? "user-anchors" : "default");
  }

  if (jumpToBtn) {
    jumpToBtn.setAttribute("aria-expanded", next ? "true" : "false");
    jumpToBtn.title = next ? "Expand all turn details" : "Collapse all turn details";
    jumpToBtn.setAttribute("aria-label", jumpToBtn.title);
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
  queuePromptBtn.title = "Queue this instruction (Tab)";
  cancelTurnBtn.title = "Stop running turn";
  updateTurnActivityStrip();
}

function formatTurnElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const paddedMinutes = String(minutes).padStart(2, "0");
  const paddedSeconds = String(seconds).padStart(2, "0");
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${paddedMinutes}:${paddedSeconds}`;
  }

  return `${paddedMinutes}:${paddedSeconds}`;
}

function normalizeReasoningSummary(text) {
  if (typeof text !== "string") {
    return "";
  }

  const normalized = text.replace(/\r/g, "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  return normalized.length > 800 ? `${normalized.slice(0, 800)}...` : normalized;
}

function parseIsoTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const tick = Date.parse(value);
  return Number.isFinite(tick) ? tick : null;
}

function extractReasoningSummaryFromPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const eventType = typeof payload.type === "string" ? payload.type.trim().toLowerCase() : "";
  if (eventType === "reasoning") {
    if (Array.isArray(payload.summary)) {
      const parts = [];
      for (const item of payload.summary) {
        if (item && typeof item.text === "string" && item.text.trim().length > 0) {
          parts.push(item.text.trim());
        }
      }
      const combined = normalizeReasoningSummary(parts.join(" "));
      if (combined) {
        return combined;
      }
    }

    const fromContent = normalizeReasoningSummary(typeof payload.content === "string" ? payload.content : "");
    if (fromContent) {
      return fromContent;
    }
  }

  if (eventType === "agent_reasoning") {
    const fromMessage = normalizeReasoningSummary(
      typeof payload.message === "string"
        ? payload.message
        : typeof payload.summary === "string"
          ? payload.summary
          : typeof payload.text === "string"
            ? payload.text
            : ""
    );
    if (fromMessage) {
      return fromMessage;
    }
  }

  return "";
}

function extractReasoningSummaryFromLogLine(line) {
  if (typeof line !== "string" || !line.trim()) {
    return "";
  }

  const parsed = safeJsonParse(line, null);
  if (!parsed || typeof parsed !== "object") {
    return "";
  }

  if (parsed.type === "response_item") {
    return extractReasoningSummaryFromPayload(parsed.payload || {});
  }

  if (parsed.type === "event_msg") {
    return extractReasoningSummaryFromPayload(parsed.payload || {});
  }

  return "";
}

function updateReasoningFromLogLines(threadId, lines) {
  const normalizedThreadId = normalizeThreadId(threadId);
  if (!normalizedThreadId || !Array.isArray(lines) || lines.length === 0) {
    return;
  }

  let latest = "";
  for (const line of lines) {
    const next = extractReasoningSummaryFromLogLine(line);
    if (next) {
      latest = next;
    }
  }

  if (!latest) {
    return;
  }

  lastReasoningByThread.set(normalizedThreadId, latest);
  const activeThreadId = normalizeThreadId(getActiveSessionState()?.threadId || "");
  if (activeThreadId && activeThreadId === normalizedThreadId) {
    updateTurnActivityStrip();
  }
}

function updateTurnActivityStrip() {
  if (!turnActivityStrip || !turnActivityTimer || !turnActivityReasoning) {
    return;
  }

  const sessionId = activeSessionId || "";
  const running = !!sessionId && isTurnInFlight(sessionId);
  if (!running) {
    turnActivityStrip.classList.add("hidden");
    turnActivityStrip.classList.remove("running");
    return;
  }

  if (!turnStartedAtBySession.has(sessionId)) {
    turnStartedAtBySession.set(sessionId, Date.now());
  }

  const startedAt = turnStartedAtBySession.get(sessionId) || Date.now();
  const elapsed = formatTurnElapsed(Date.now() - startedAt);
  turnActivityTimer.textContent = `Working ${elapsed}`;

  const threadId = normalizeThreadId(getActiveSessionState()?.threadId || "");
  const reasoning = threadId ? normalizeReasoningSummary(lastReasoningByThread.get(threadId) || "") : "";
  turnActivityReasoning.textContent = reasoning || "Waiting for reasoning update...";
  turnActivityStrip.classList.remove("hidden");
  turnActivityStrip.classList.add("running");
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
    permissionLevelIndicator.textContent = "Permissions: unavailable";
    permissionLevelIndicator.title = "Permission level unavailable";
    return;
  }

  const approvalLabel = formatApprovalPolicyLabel(approval);
  const sandboxLabel = formatSandboxPolicyLabel(sandbox);
  permissionLevelIndicator.textContent = `${approvalLabel} | ${sandboxLabel}`;
  permissionLevelIndicator.title = `Approval policy: ${approval || "unknown"} | Sandbox policy: ${sandbox || "unknown"}`;
}

function formatApprovalPolicyLabel(approval) {
  const normalized = normalizePermissionPolicy(approval).toLowerCase();
  switch (normalized) {
    case "never":
      return "No approvals needed";
    case "on-request":
      return "Approvals on request";
    case "on-failure":
      return "Approve on failure";
    case "always":
      return "Always ask approval";
    case "untrusted":
      return "Strict approval";
    default:
      return normalized ? `Approval: ${normalized}` : "Approval: unknown";
  }
}

function formatSandboxPolicyLabel(sandbox) {
  const normalized = normalizePermissionPolicy(sandbox).toLowerCase();
  switch (normalized) {
    case "workspace-write":
      return "Can edit workspace";
    case "read-only":
      return "Read-only workspace";
    case "danger-full-access":
      return "Full system access";
    case "no-sandbox":
    case "none":
      return "No sandbox";
    default:
      return normalized ? `Sandbox: ${normalized}` : "Sandbox: unknown";
  }
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
    if (input !== null) {
      return input;
    }

    if (cachedInput === null) {
      return null;
    }

    return cachedInput;
  }

  function readTotalTokens(usage) {
    if (!usage || typeof usage !== "object") {
      return null;
    }

    return readNumber(usage.total_tokens ?? usage.totalTokens);
  }

  const lastInputSide = readInputSideTokens(lastUsage);
  const lastTotal = readTotalTokens(lastUsage);
  const totalInputSide = readInputSideTokens(totalUsage);
  const cumulativeTotal = readTotalTokens(totalUsage);
  // Prefer latest request-side token usage for context occupancy.
  let usedTokens = null;
  if (lastInputSide !== null) {
    usedTokens = lastInputSide;
  } else if (lastTotal !== null) {
    usedTokens = lastTotal;
  } else if (totalInputSide !== null) {
    usedTokens = totalInputSide;
  } else if (cumulativeTotal !== null) {
    usedTokens = cumulativeTotal;
  }

  if (contextWindow === null && usedTokens === null) {
    return null;
  }

  return {
    contextWindow,
    usedTokens,
    source: lastInputSide !== null
      ? "last_input_side"
      : (lastTotal !== null
        ? "last_total"
        : (totalInputSide !== null ? "total_input_side" : "total_total"))
  };
}

function readNonNegativeNumber(value) {
  const next = Number(value);
  return Number.isFinite(next) && next >= 0 ? next : null;
}

function readThreadCompactedInfo(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const eventType = typeof payload.type === "string" ? payload.type.trim().toLowerCase() : "";
  const isCompactionType = eventType === "thread_compacted" || eventType === "thread/compacted";
  const hasCompactionFields = payload.reclaimedTokens !== undefined
    || payload.reclaimed_tokens !== undefined
    || payload.usedTokensAfter !== undefined
    || payload.used_tokens_after !== undefined
    || payload.percentLeft !== undefined
    || payload.percent_left !== undefined;
  if (!isCompactionType && !hasCompactionFields) {
    return null;
  }

  const contextWindow = readNonNegativeNumber(
    payload.contextWindow
      ?? payload.context_window
      ?? payload.modelContextWindow
      ?? payload.model_context_window
  );
  const usedTokensBefore = readNonNegativeNumber(
    payload.usedTokensBefore
      ?? payload.used_tokens_before
      ?? payload.tokensBefore
      ?? payload.tokens_before
  );
  const usedTokensAfter = readNonNegativeNumber(
    payload.usedTokensAfter
      ?? payload.used_tokens_after
      ?? payload.tokensAfter
      ?? payload.tokens_after
      ?? payload.usedTokens
      ?? payload.used_tokens
  );
  let reclaimedTokens = readNonNegativeNumber(
    payload.reclaimedTokens
      ?? payload.reclaimed_tokens
      ?? payload.tokensReclaimed
      ?? payload.tokens_reclaimed
  );
  if (reclaimedTokens === null && usedTokensBefore !== null && usedTokensAfter !== null) {
    reclaimedTokens = Math.max(0, usedTokensBefore - usedTokensAfter);
  }

  let percentLeft = readNonNegativeNumber(
    payload.percentLeft
      ?? payload.percent_left
      ?? payload.contextPercentLeft
      ?? payload.context_percent_left
  );
  if (percentLeft !== null) {
    percentLeft = Math.max(0, Math.min(100, percentLeft));
  }
  if (percentLeft === null && contextWindow !== null && contextWindow > 0 && usedTokensAfter !== null) {
    const ratio = Math.min(1, Math.max(0, usedTokensAfter / contextWindow));
    percentLeft = Math.max(0, Math.min(100, Math.round((1 - ratio) * 100)));
  }

  if (contextWindow === null && usedTokensAfter === null && percentLeft === null && reclaimedTokens === null) {
    return null;
  }

  return {
    contextWindow,
    usedTokensBefore,
    usedTokensAfter,
    reclaimedTokens,
    percentLeft,
    summary: typeof payload.summary === "string"
      ? payload.summary.trim()
      : typeof payload.message === "string"
        ? payload.message.trim()
        : ""
  };
}

function applyContextUsageForThread(threadId, pieces, sourceTag = "") {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId || !pieces || typeof pieces !== "object") {
    return false;
  }

  const prior = contextUsageByThread.get(normalizedThreadId) || null;
  let contextWindow = Number.isFinite(pieces.contextWindow) && pieces.contextWindow > 0
    ? pieces.contextWindow
    : (Number.isFinite(prior?.contextWindow) ? prior.contextWindow : null);
  let usedTokens = Number.isFinite(pieces.usedTokens) && pieces.usedTokens >= 0
    ? pieces.usedTokens
    : (Number.isFinite(pieces.usedTokensAfter) && pieces.usedTokensAfter >= 0
      ? pieces.usedTokensAfter
      : (Number.isFinite(prior?.usedTokens) ? prior.usedTokens : null));
  let percentLeft = Number.isFinite(pieces.percentLeft) ? pieces.percentLeft : null;
  if (percentLeft !== null) {
    percentLeft = Math.max(0, Math.min(100, Math.round(percentLeft)));
  }

  if (Number.isFinite(contextWindow) && contextWindow > 0 && Number.isFinite(usedTokens) && usedTokens >= 0) {
    if (usedTokens > (contextWindow * 1.1) && sourceTag === "total_total") {
      return false;
    }

    const boundedUsedTokens = Math.min(usedTokens, contextWindow);
    const ratio = Math.min(1, Math.max(0, boundedUsedTokens / contextWindow));
    const derivedPercentLeft = Math.max(0, Math.min(100, Math.round((1 - ratio) * 100)));
    contextUsageByThread.set(normalizedThreadId, {
      usedTokens: boundedUsedTokens,
      contextWindow,
      percentLeft: percentLeft === null ? derivedPercentLeft : percentLeft
    });
  } else if (Number.isFinite(contextWindow) && contextWindow > 0 && Number.isFinite(percentLeft)) {
    const normalizedPercentLeft = Math.max(0, Math.min(100, Math.round(percentLeft)));
    const derivedUsedTokens = Math.max(0, Math.round(contextWindow * (1 - (normalizedPercentLeft / 100))));
    contextUsageByThread.set(normalizedThreadId, {
      usedTokens: derivedUsedTokens,
      contextWindow,
      percentLeft: normalizedPercentLeft
    });
  } else {
    return false;
  }

  const activeThreadId = typeof getActiveSessionState()?.threadId === "string" ? getActiveSessionState().threadId.trim() : "";
  if (activeThreadId === normalizedThreadId) {
    updateContextLeftIndicator();
  }
  return true;
}

function updateContextUsageFromLogLines(threadId, lines) {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId || !Array.isArray(lines) || lines.length === 0) {
    return;
  }

  const prior = contextUsageByThread.get(normalizedThreadId) || null;
  let contextWindow = Number.isFinite(prior?.contextWindow) ? prior.contextWindow : null;
  let usedTokens = Number.isFinite(prior?.usedTokens) ? prior.usedTokens : null;
  let updatedFromSource = "";

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

      const compactionPieces = readThreadCompactedInfo(payload);
      if (compactionPieces) {
        if (compactionPieces.contextWindow !== null) {
          contextWindow = compactionPieces.contextWindow;
        }
        if (compactionPieces.usedTokensAfter !== null) {
          usedTokens = compactionPieces.usedTokensAfter;
          updatedFromSource = "thread_compacted";
        }
      }

      const eventPieces = readTokenCountInfo(payload);
      if (eventPieces) {
        if (eventPieces.contextWindow !== null) {
          contextWindow = eventPieces.contextWindow;
        }
        if (eventPieces.usedTokens !== null) {
          usedTokens = eventPieces.usedTokens;
          updatedFromSource = eventPieces.source || "";
        }
      }
    }
  }

  applyContextUsageForThread(
    normalizedThreadId,
    {
      contextWindow,
      usedTokens
    },
    updatedFromSource
  );
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

function applyTimelineWatchMetadata(threadId, data) {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId || !data || typeof data !== "object") {
    return;
  }

  const usage = data.contextUsage;
  if (usage && typeof usage === "object") {
    const contextWindow = Number(usage.contextWindow);
    const usedTokens = Number(usage.usedTokens);
    const percentLeft = Number(usage.percentLeft);
    applyContextUsageForThread(
      normalizedThreadId,
      {
        contextWindow: Number.isFinite(contextWindow) ? contextWindow : null,
        usedTokens: Number.isFinite(usedTokens) ? usedTokens : null,
        percentLeft: Number.isFinite(percentLeft) ? percentLeft : null
      },
      "timeline_watch"
    );
  }

  const permission = data.permission;
  if (permission && typeof permission === "object") {
    const approval = normalizePermissionPolicy(permission.approval || "");
    const sandbox = normalizePermissionPolicy(permission.sandbox || "");
    if (approval || sandbox) {
      setPermissionLevelForThread(normalizedThreadId, { approval, sandbox });
    }
  }

  const reasoning = normalizeReasoningSummary(data.reasoningSummary || "");
  if (reasoning) {
    lastReasoningByThread.set(normalizedThreadId, reasoning);
    const activeThreadId = normalizeThreadId(getActiveSessionState()?.threadId || "");
    if (activeThreadId && activeThreadId === normalizedThreadId) {
      updateTurnActivityStrip();
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

function normalizeModelValue(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}

function normalizeReasoningEffort(value) {
  if (value === null || value === undefined) {
    return "";
  }

  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return "";
  }

  return REASONING_EFFORT_LEVELS.includes(normalized) ? normalized : "";
}

function loadThreadModelState() {
  preferredModelByThread = new Map();
  const raw = safeJsonParse(localStorage.getItem(STORAGE_THREAD_MODELS_KEY), {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return;
  }

  for (const [threadId, model] of Object.entries(raw)) {
    const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
    if (!normalizedThreadId) {
      continue;
    }

    preferredModelByThread.set(normalizedThreadId, normalizeModelValue(model));
  }
}

function persistThreadModelState() {
  const payload = {};
  for (const [threadId, model] of preferredModelByThread.entries()) {
    const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
    if (!normalizedThreadId) {
      continue;
    }

    payload[normalizedThreadId] = normalizeModelValue(model);
  }

  localStorage.setItem(STORAGE_THREAD_MODELS_KEY, JSON.stringify(payload));
}

function loadThreadReasoningState() {
  preferredReasoningByThread = new Map();
  const raw = safeJsonParse(localStorage.getItem(STORAGE_THREAD_REASONING_KEY), {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return;
  }

  for (const [threadId, effort] of Object.entries(raw)) {
    const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
    if (!normalizedThreadId) {
      continue;
    }

    preferredReasoningByThread.set(normalizedThreadId, normalizeReasoningEffort(effort));
  }
}

function persistThreadReasoningState() {
  const payload = {};
  for (const [threadId, effort] of preferredReasoningByThread.entries()) {
    const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
    if (!normalizedThreadId) {
      continue;
    }

    payload[normalizedThreadId] = normalizeReasoningEffort(effort);
  }

  localStorage.setItem(STORAGE_THREAD_REASONING_KEY, JSON.stringify(payload));
}

function getPreferredModelForThread(threadId) {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId || !preferredModelByThread.has(normalizedThreadId)) {
    return { found: false, model: "" };
  }

  return {
    found: true,
    model: normalizeModelValue(preferredModelByThread.get(normalizedThreadId))
  };
}

function getPreferredReasoningForThread(threadId) {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId || !preferredReasoningByThread.has(normalizedThreadId)) {
    return { found: false, effort: "" };
  }

  return {
    found: true,
    effort: normalizeReasoningEffort(preferredReasoningByThread.get(normalizedThreadId))
  };
}

function setPreferredModelForThread(threadId, model, options = {}) {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId) {
    return;
  }

  preferredModelByThread.set(normalizedThreadId, normalizeModelValue(model));
  if (options.persist !== false) {
    persistThreadModelState();
  }
}

function setPreferredReasoningForThread(threadId, effort, options = {}) {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId) {
    return;
  }

  preferredReasoningByThread.set(normalizedThreadId, normalizeReasoningEffort(effort));
  if (options.persist !== false) {
    persistThreadReasoningState();
  }
}

function ensureThreadModelPreference(threadId, model, options = {}) {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId) {
    return false;
  }

  const normalizedModel = normalizeModelValue(model);
  if (preferredModelByThread.has(normalizedThreadId)) {
    return false;
  }

  preferredModelByThread.set(normalizedThreadId, normalizedModel);
  if (options.persist !== false) {
    persistThreadModelState();
  }

  return true;
}

function ensureThreadReasoningPreference(threadId, effort, options = {}) {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId) {
    return false;
  }

  const normalizedEffort = normalizeReasoningEffort(effort);
  if (preferredReasoningByThread.has(normalizedThreadId)) {
    return false;
  }

  preferredReasoningByThread.set(normalizedThreadId, normalizedEffort);
  if (options.persist !== false) {
    persistThreadReasoningState();
  }

  return true;
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

function normalizeQueuedTurnSummaryList(list) {
  if (!Array.isArray(list)) {
    return [];
  }

  const normalized = [];
  for (const item of list) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const queueItemId = typeof item.queueItemId === "string" ? item.queueItemId.trim() : "";
    if (!queueItemId) {
      continue;
    }

    const previewText = typeof item.previewText === "string" ? item.previewText : "";
    const imageCount = Number.isFinite(item.imageCount) ? Math.max(0, Math.floor(item.imageCount)) : 0;
    normalized.push({
      queueItemId,
      previewText,
      imageCount,
      createdAtUtc: typeof item.createdAtUtc === "string" ? item.createdAtUtc : null
    });
  }

  return normalized;
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
  timelineHasTruncatedHead = false;
  updateTimelineTruncationNotice();
  const title = displayName && displayName.trim().length > 0
    ? `Loading ${displayName.trim()}...`
    : `Loading ${normalizedThreadId}...`;
  appendLog(`[session] ${title}`);
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
    const tick = Math.max(getCatalogSessionUpdatedTick(entry), attachedState?.lastActivityTick || 0);
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
      reasoningEffort: normalizeReasoningEffort(entry.reasoningEffort || attachedState?.reasoningEffort || ""),
      attachedSessionId,
      isAttached: !!attachedSessionId,
      isProcessing: attachedSessionId ? isTurnInFlight(attachedSessionId) : isThreadProcessing(entry.threadId),
      isArchived: archivedThreadIds.has(entry.threadId),
      hasUnreadCompletion: hasThreadCompletionUnread(entry.threadId)
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
      reasoningEffort: normalizeReasoningEffort(state.reasoningEffort || ""),
      attachedSessionId: sessionId,
      isAttached: true,
      isProcessing: isTurnInFlight(sessionId),
      isArchived: archivedThreadIds.has(state.threadId),
      hasUnreadCompletion: hasThreadCompletionUnread(state.threadId)
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

  const hasSessions = groups.some((group) => Array.isArray(group.sessions) && group.sessions.length > 0);
  if (!projectOrderInitialized && hasSessions && sessionCatalogLoadedOnce) {
    const initial = [...groups].sort((a, b) => {
      const tickCompare = (b.latestTick || 0) - (a.latestTick || 0);
      if (tickCompare !== 0) {
        return tickCompare;
      }

      return getProjectDisplayName(a).localeCompare(getProjectDisplayName(b));
    });
    projectOrderIndexByKey = new Map();
    nextProjectOrderIndex = 0;
    for (const group of initial) {
      projectOrderIndexByKey.set(group.key, nextProjectOrderIndex++);
    }
    projectOrderInitialized = true;
  }

  if (projectOrderInitialized) {
    for (const group of groups) {
      if (!projectOrderIndexByKey.has(group.key)) {
        projectOrderIndexByKey.set(group.key, nextProjectOrderIndex++);
      }
    }

    groups.sort((a, b) => {
      const rankA = projectOrderIndexByKey.get(a.key);
      const rankB = projectOrderIndexByKey.get(b.key);
      if (rankA !== rankB) {
        return rankA - rankB;
      }

      return getProjectDisplayName(a).localeCompare(getProjectDisplayName(b));
    });
  } else {
    groups.sort((a, b) => getProjectDisplayName(a).localeCompare(getProjectDisplayName(b)));
  }

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
  if (jumpToBtn) {
    jumpToBtn.disabled = !hasState;
  }
  if (!hasState) {
    setJumpCollapseMode(false);
  }
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
    const effort = normalizeReasoningEffort(entry.reasoningEffort || "");
    parts.push(effort ? `${entry.model} (${effort})` : entry.model);
  } else if (entry.reasoningEffort) {
    parts.push(`reasoning: ${entry.reasoningEffort}`);
  }

  return parts.join(" | ");
}

async function createSessionForCwd(cwd, options = {}) {
  const normalizedCwd = normalizeProjectCwd(cwd || "");
  const hasProvidedName = Object.prototype.hasOwnProperty.call(options, "threadName");
  const rawName = hasProvidedName
    ? String(options.threadName || "")
    : (options.askName === false ? "" : window.prompt("Session name (optional):", ""));
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
  const preferred = getPreferredModelForThread(threadId);
  const model = preferred.found
    ? preferred.model
    : normalizeModelValue(getCatalogEntryByThreadId(threadId)?.model || modelValueForCreate() || "");
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

function promoteProjectToTop(projectKey) {
  const normalizedProjectKey = typeof projectKey === "string" ? projectKey.trim().toLowerCase() : "";
  if (!normalizedProjectKey) {
    return;
  }

  const orderedKeys = [];
  if (projectOrderInitialized) {
    const ranked = Array.from(projectOrderIndexByKey.entries())
      .sort((a, b) => (a[1] || 0) - (b[1] || 0))
      .map((entry) => entry[0]);
    for (const key of ranked) {
      if (key && key !== normalizedProjectKey) {
        orderedKeys.push(key);
      }
    }
  }

  projectOrderIndexByKey = new Map();
  projectOrderIndexByKey.set(normalizedProjectKey, 0);
  nextProjectOrderIndex = 1;
  for (const key of orderedKeys) {
    if (!projectOrderIndexByKey.has(key)) {
      projectOrderIndexByKey.set(key, nextProjectOrderIndex++);
    }
  }

  projectOrderInitialized = true;
}

function openNewProjectModal() {
  if (!newProjectModal || !newProjectCwdInput || !newProjectFirstSessionInput) {
    return;
  }

  const selectedGroup = buildSidebarProjectGroups().find((x) => x.key === selectedProjectKey) || null;
  const seedCwd = normalizeProjectCwd(selectedGroup?.cwd || cwdInput.value.trim());
  newProjectCwdInput.value = seedCwd;
  newProjectFirstSessionInput.value = "";
  newProjectModal.classList.remove("hidden");
  newProjectCwdInput.focus();
  newProjectCwdInput.select();
}

function closeNewProjectModal() {
  if (!newProjectModal) {
    return;
  }

  newProjectModal.classList.add("hidden");
}

async function submitNewProjectModal() {
  if (!newProjectCwdInput || !newProjectFirstSessionInput) {
    return;
  }

  const cwd = normalizeProjectCwd(newProjectCwdInput.value || "");
  if (!cwd) {
    appendLog("[project] working directory is required");
    newProjectCwdInput.focus();
    return;
  }

  const firstSessionName = String(newProjectFirstSessionInput.value || "").trim();
  if (firstSessionName.length > 200) {
    appendLog("[project] first session name must be 200 characters or fewer");
    newProjectFirstSessionInput.focus();
    return;
  }

  const key = getProjectKeyFromCwd(cwd);
  if (!customProjects.some((x) => x && x.key === key)) {
    customProjects.push({ key, cwd, name: "" });
    persistCustomProjects();
  }

  promoteProjectToTop(key);
  selectProject(key, cwd);
  closeNewProjectModal();

  await createSessionForCwd(cwd, { askName: false, threadName: firstSessionName });
}

function promptCreateProject() {
  openNewProjectModal();
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
      if (!entry.isProcessing && entry.hasUnreadCompletion) {
        const completed = document.createElement("span");
        completed.className = "session-badge completed-unread";
        completed.title = "New completed output";
        completed.setAttribute("aria-label", "New completed output");
        badges.appendChild(completed);
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
  const line = `${stamp} ${text}`;
  if (!logOutput) {
    if (ENABLE_CONSOLE_LOG_FALLBACK) {
      console.log(line);
    }
    return;
  }

  pendingClientLogLines.push(line);
}

function flushPendingClientLogs() {
  if (!logOutput || pendingClientLogLines.length === 0) {
    return;
  }

  const shouldStickToBottom = (logOutput.scrollHeight - (logOutput.scrollTop + logOutput.clientHeight)) <= 20;
  renderedClientLogLines.push(...pendingClientLogLines);
  pendingClientLogLines = [];

  if (renderedClientLogLines.length > MAX_RENDERED_CLIENT_LOG_LINES) {
    renderedClientLogLines = renderedClientLogLines.slice(renderedClientLogLines.length - MAX_RENDERED_CLIENT_LOG_LINES);
  }

  logOutput.textContent = renderedClientLogLines.join("\n");
  if (shouldStickToBottom) {
    logOutput.scrollTop = logOutput.scrollHeight;
  }
}

function setSecurityWarningVisible(message, reasons = []) {
  if (!securityWarningBanner) {
    return;
  }

  const normalizedMessage = String(message || "").trim() || SECURITY_WARNING_TEXT;
  const normalizedReasons = Array.isArray(reasons)
    ? reasons.map((x) => String(x || "").trim()).filter((x) => x.length > 0)
    : [];

  securityWarningBanner.textContent = normalizedMessage;
  securityWarningBanner.title = normalizedReasons.length > 0 ? normalizedReasons.join(" | ") : normalizedMessage;
  securityWarningBanner.classList.remove("hidden");
}

function setSecurityWarningHidden() {
  if (!securityWarningBanner) {
    return;
  }

  securityWarningBanner.textContent = "";
  securityWarningBanner.title = "";
  securityWarningBanner.classList.add("hidden");
}

function applySecurityConfig(config) {
  runtimeSecurityConfig = config && typeof config === "object" ? config : null;
  if (!runtimeSecurityConfig) {
    setSecurityWarningVisible(SECURITY_WARNING_TEXT, ["Security posture could not be loaded from the server."]);
    return;
  }

  const reasons = Array.isArray(runtimeSecurityConfig.unsafeReasons) ? runtimeSecurityConfig.unsafeReasons : [];
  if (runtimeSecurityConfig.unsafeConfigurationDetected === true) {
    setSecurityWarningVisible(runtimeSecurityConfig.securityWarningMessage || SECURITY_WARNING_TEXT, reasons);
  } else {
    setSecurityWarningHidden();
  }

  if (aboutVersionLine) {
    const version = String(runtimeSecurityConfig.projectVersion || "unknown").trim() || "unknown";
    aboutVersionLine.textContent = `Codex Embedded version: ${version}`;
  }
}

async function loadRuntimeSecurityConfig() {
  const response = await fetch(new URL("api/security/config", document.baseURI), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`security config request failed (${response.status})`);
  }

  const data = await response.json();
  applySecurityConfig(data);
}

function openAboutModal() {
  if (!aboutModal) {
    return;
  }

  aboutModal.classList.remove("hidden");
}

function closeAboutModal() {
  if (!aboutModal) {
    return;
  }

  aboutModal.classList.add("hidden");
}

function setApprovalVisible(show) {
  approvalPanel.classList.toggle("hidden", !show);
}

function ensureSessionState(sessionId) {
  if (!sessions.has(sessionId)) {
    const now = Date.now();
    sessions.set(sessionId, {
      threadId: null,
      cwd: null,
      model: null,
      reasoningEffort: null,
      pendingApproval: null,
      createdAtTick: now,
      lastActivityTick: now,
    });
  }
  return sessions.get(sessionId);
}

function getActiveSessionState() {
  if (!activeSessionId || !sessions.has(activeSessionId)) {
    return null;
  }

  return sessions.get(activeSessionId) || null;
}

function normalizeThreadId(threadId) {
  return typeof threadId === "string" ? threadId.trim() : "";
}

function getActiveThreadId() {
  return normalizeThreadId(getActiveSessionState()?.threadId || "");
}

function hasAttachedSessionForThread(threadId) {
  const normalizedThreadId = normalizeThreadId(threadId);
  if (!normalizedThreadId) {
    return false;
  }

  for (const state of sessions.values()) {
    if (normalizeThreadId(state?.threadId || "") === normalizedThreadId) {
      return true;
    }
  }

  return false;
}

function hasThreadCompletionUnread(threadId) {
  const normalizedThreadId = normalizeThreadId(threadId);
  if (!normalizedThreadId) {
    return false;
  }

  return completedUnreadThreadIds.has(normalizedThreadId);
}

function markThreadCompletionUnread(threadId, options = {}) {
  const normalizedThreadId = normalizeThreadId(threadId);
  if (!normalizedThreadId) {
    return false;
  }

  if (options.requireAttached === true && !hasAttachedSessionForThread(normalizedThreadId)) {
    return false;
  }

  if (normalizedThreadId === getActiveThreadId()) {
    return false;
  }

  const hadEntry = completedUnreadThreadIds.has(normalizedThreadId);
  completedUnreadThreadIds.add(normalizedThreadId);
  return !hadEntry;
}

function markThreadCompletionSeen(threadId) {
  const normalizedThreadId = normalizeThreadId(threadId);
  if (!normalizedThreadId) {
    return false;
  }

  return completedUnreadThreadIds.delete(normalizedThreadId);
}

function applyProcessingByThread(nextProcessingMap) {
  const prior = processingByThread;
  const next = new Map();

  if (nextProcessingMap && typeof nextProcessingMap[Symbol.iterator] === "function") {
    for (const [threadId, processing] of nextProcessingMap) {
      const normalizedThreadId = normalizeThreadId(threadId);
      if (!normalizedThreadId || processing !== true) {
        continue;
      }

      next.set(normalizedThreadId, true);
    }
  }

  for (const [threadId, wasProcessing] of prior.entries()) {
    if (wasProcessing !== true) {
      continue;
    }

    if (next.get(threadId) === true) {
      continue;
    }

    markThreadCompletionUnread(threadId, { requireAttached: true });
  }

  processingByThread = next;
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

function getQueuedTurnsForSession(sessionId) {
  if (!sessionId) {
    return [];
  }

  const state = sessions.get(sessionId);
  if (!state || !Array.isArray(state.queuedTurns)) {
    return [];
  }

  return state.queuedTurns;
}

function isThreadProcessing(threadId) {
  const normalizedThreadId = normalizeThreadId(threadId);
  if (!normalizedThreadId) {
    return false;
  }

  return processingByThread.get(normalizedThreadId) === true;
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
    const state = sessions.get(sessionId) || null;
    const threadId = normalizeThreadId(state?.threadId || "");
    if (normalized) {
      if (!turnStartedAtBySession.has(sessionId)) {
        turnStartedAtBySession.set(sessionId, Date.now());
      }
      if (threadId) {
        lastReasoningByThread.delete(threadId);
      }
    } else {
      turnStartedAtBySession.delete(sessionId);
    }

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

  const queue = getQueuedTurnsForSession(activeSessionId);
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
    const imageCount = Number.isFinite(item.imageCount) ? Math.max(0, Math.floor(item.imageCount)) : 0;
    const imageSuffix = imageCount > 0 ? ` (+${imageCount} image${imageCount > 1 ? "s" : ""})` : "";
    const rawPreview = (item.previewText || "").trim() || (imageCount > 0 ? "(image only)" : "");

    const row = document.createElement("div");
    row.className = "prompt-queue-row";

    const itemButton = document.createElement("button");
    itemButton.type = "button";
    itemButton.className = "prompt-queue-item";
    itemButton.textContent = `${i + 1}. ${trimPromptPreview(rawPreview)}${imageSuffix}`;
    itemButton.addEventListener("click", () => {
      requestQueuedPromptForEditing(activeSessionId, item.queueItemId);
    });

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "prompt-queue-remove";
    removeButton.title = "Remove queued prompt";
    removeButton.setAttribute("aria-label", "Remove queued prompt");
    removeButton.textContent = "x";
    removeButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeQueuedPrompt(activeSessionId, item.queueItemId);
    });

    row.append(itemButton, removeButton);
    list.appendChild(row);
  }
  promptQueue.appendChild(list);
  promptQueue.classList.remove("hidden");
}

async function queuePrompt(sessionId, promptText, images = []) {
  if (!sessionId) {
    return false;
  }

  const normalizedText = String(promptText || "");
  const safeImages = Array.isArray(images) ? images.filter((x) => x && typeof x.url === "string" && x.url.trim().length > 0) : [];
  if (!normalizedText.trim() && safeImages.length === 0) {
    return false;
  }

  const turnCwd = cwdInput.value.trim();
  const state = sessions.get(sessionId);
  const turnModel = normalizeModelValue(state?.model || "");
  const turnEffort = normalizeReasoningEffort(state?.reasoningEffort || "");

  const payload = {
    sessionId,
    text: normalizedText,
    images: safeImages.map((x) => ({ url: x.url, name: x.name || "image" }))
  };
  if (turnCwd) {
    payload.cwd = turnCwd;
  }
  if (turnModel) {
    payload.model = turnModel;
  }
  if (turnEffort) {
    payload.effort = turnEffort;
  }

  if (!send("turn_queue_add", payload)) {
    return false;
  }

  return true;
}

function requestQueuedPromptForEditing(sessionId, queueItemId) {
  if (!sessionId) {
    return;
  }

  const normalizedQueueItemId = typeof queueItemId === "string" ? queueItemId.trim() : "";
  if (!normalizedQueueItemId) {
    return;
  }

  if (!send("turn_queue_pop", { sessionId, queueItemId: normalizedQueueItemId })) {
    appendLog("[queue] failed to request queued prompt edit; websocket is closed");
  }
}

function removeQueuedPrompt(sessionId, queueItemId) {
  if (!sessionId) {
    return;
  }

  const normalizedQueueItemId = typeof queueItemId === "string" ? queueItemId.trim() : "";
  if (!normalizedQueueItemId) {
    return;
  }

  if (!send("turn_queue_remove", { sessionId, queueItemId: normalizedQueueItemId })) {
    appendLog("[queue] failed to remove queued prompt; websocket is closed");
  }
}

function restoreQueuedPromptForEditing(text, images = []) {
  promptInput.value = String(text || "");
  rememberPromptDraftForState(getActiveSessionState());

  pendingComposerImages = images
    .filter((x) => x && typeof x.url === "string" && x.url.trim().length > 0)
    .slice(0, MAX_COMPOSER_IMAGES)
    .map((x) => ({
    id: nextComposerImageId++,
    name: x.name || "image",
    mimeType: x.mimeType || "image/*",
    size: typeof x.size === "number" ? x.size : 0,
    url: x.url
  }));
  renderComposerImages();

  promptInput.focus();
  promptInput.selectionStart = promptInput.selectionEnd = promptInput.value.length;
}

function startTurn(sessionId, promptText, images = [], options = {}) {
  const normalizedText = String(promptText || "").trim();
  const safeImages = Array.isArray(images) ? images.filter((x) => x && typeof x.url === "string" && x.url.trim().length > 0) : [];
  const turnCwd = cwdInput.value.trim();
  const state = sessions.get(sessionId);
  const turnModel = normalizeModelValue(state?.model || "");
  if (!sessionId || (!normalizedText && safeImages.length === 0)) {
    return false;
  }

  const payload = {
    sessionId,
    text: normalizedText,
    images: safeImages.map((x) => ({ url: x.url, name: x.name || "image" }))
  };

  if (state && turnModel) {
    state.model = turnModel;
  }

  const turnEffort = normalizeReasoningEffort(state?.reasoningEffort || "");
  if (state && turnEffort) {
    state.reasoningEffort = turnEffort;
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
  }
  if (turnEffort) {
    payload.effort = turnEffort;
  }
  if (state && sessionId === activeSessionId && !turnCwd) {
    refreshSessionMeta();
    renderProjectSidebar();
  }

  if (!send("turn_start", payload)) {
    return false;
  }

  touchSessionActivity(sessionId);
  setTurnInFlight(sessionId, true);
  if (normalizedText) {
    lastSentPromptBySession.set(sessionId, normalizedText);
  }

  if (options.fromQueue === true) {
    appendLog(`[turn] dequeued next prompt for session=${sessionId}`);
  }

  return true;
}

function prunePromptState() {
  const validIds = new Set(sessions.keys());
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

function storeLastSessionId(sessionId) {
  const normalized = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!normalized) {
    return;
  }

  localStorage.setItem(STORAGE_LAST_SESSION_ID_KEY, normalized);
}

function getStoredLastSessionId() {
  const value = localStorage.getItem(STORAGE_LAST_SESSION_ID_KEY);
  return value && value.trim().length > 0 ? value.trim() : null;
}

async function tryAutoAttachStoredThread() {
  if (autoAttachAttempted) {
    return;
  }

  const threadId = getStoredLastThreadId();
  if (!threadId) {
    autoAttachAttempted = true;
    return;
  }

  if (getAttachedSessionIdByThreadId(threadId)) {
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
  const catalogEntry = getCatalogEntryByThreadId(threadId);
  await attachSessionByThreadId(threadId, catalogEntry?.cwd || cwdInput.value.trim());
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

function populateReasoningEffortSelect() {
  if (!conversationReasoningSelect) {
    return;
  }

  conversationReasoningSelect.textContent = "";

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "default";
  conversationReasoningSelect.appendChild(defaultOption);

  for (const level of REASONING_EFFORT_LEVELS) {
    const option = document.createElement("option");
    option.value = level;
    option.textContent = level;
    conversationReasoningSelect.appendChild(option);
  }
}

function syncConversationReasoningOptions(preferredValue = null) {
  if (!conversationReasoningSelect) {
    return;
  }

  const targetValue = preferredValue === null || preferredValue === undefined
    ? (conversationReasoningSelect.value || "")
    : normalizeReasoningEffort(preferredValue);

  if (conversationReasoningSelect.options.length === 0) {
    populateReasoningEffortSelect();
  }

  syncingConversationModelSelect = true;
  const hasTarget = Array.from(conversationReasoningSelect.options).some((x) => x.value === targetValue);
  conversationReasoningSelect.value = hasTarget ? targetValue : "";
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
    if (timeline && typeof timeline.setSessionModel === "function") {
      timeline.setSessionModel("");
    }
    sessionMeta.classList.add("hidden");
    sessionMetaModelItem.classList.add("hidden");
    syncConversationModelOptions(modelSelect.value || "");
    syncConversationReasoningOptions("");
    sessionMeta.title = "";
    updateContextLeftIndicator();
    updatePermissionLevelIndicator();
    updateConversationMetaVisibility();
    return;
  }

  const namedCatalogEntry = getCatalogEntryByThreadId(state.threadId);
  const threadName = namedCatalogEntry?.threadName || state.threadName || "";
  const threadId = state.threadId || "";
  const preferred = getPreferredModelForThread(state.threadId);
  const preferredEffort = getPreferredReasoningForThread(state.threadId);
  const selectedModel = preferred.found
    ? preferred.model
    : normalizeModelValue(state.model || "");
  const selectedEffort = preferredEffort.found
    ? preferredEffort.effort
    : normalizeReasoningEffort(state.reasoningEffort || "");
  const titleValue = threadName || threadId || "Conversation";
  if (conversationTitle) {
    conversationTitle.textContent = titleValue;
    conversationTitle.title = titleValue;
  }
  sessionMeta.classList.remove("hidden");

  syncConversationModelOptions(selectedModel);
  syncConversationReasoningOptions(selectedEffort);
  if (timeline && typeof timeline.setSessionModel === "function") {
    timeline.setSessionModel(selectedModel);
  }
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

  if (timelineUsesEventFeed()) {
    timelineCursor = null;
    timelineHasTruncatedHead = false;
    updateTimelineTruncationNotice();
    pollTimelineOnce(true, generation).catch((error) => {
      handleTimelinePollError(error);
    });
    return;
  }

  const state = getActiveSessionState();
  if (!state || !state.threadId) {
    return;
  }

  pollTimelineOnce(true, generation).catch((error) => {
    handleTimelinePollError(error);
  });

  timelinePollTimer = setInterval(() => {
    pollTimelineOnce(false, generation).catch((error) => {
      handleTimelinePollError(error);
    });
  }, TIMELINE_POLL_INTERVAL_MS);
}

function handleTimelinePollError(error) {
  const message = String(error || "");
  const isConnectionError = message.includes("Failed to fetch") || message.includes("NetworkError");
  if (isConnectionError) {
    if (!timelineConnectionIssueShown) {
      appendLog("[timeline] There is a problem connecting to the server. The application may have stopped.");
      timelineConnectionIssueShown = true;
    }
    return;
  }

  appendLog(`[timeline] error: ${message}`);
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
    const url = new URL("api/turns/watch", document.baseURI);
    url.searchParams.set("threadId", state.threadId);
    url.searchParams.set("maxEntries", "6000");

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
    timelineConnectionIssueShown = false;
    if (generation !== timelinePollGeneration) {
      return;
    }

    const priorCursor = timelineCursor;
    const nextCursor = typeof data.nextCursor === "number" ? data.nextCursor : timelineCursor;
    const turns = Array.isArray(data.turns) ? data.turns : [];
    const cursorChanged = Number.isFinite(nextCursor) && priorCursor !== null && nextCursor !== priorCursor;
    const shouldReplaceTurns =
      initial ||
      data.reset === true ||
      priorCursor === null ||
      cursorChanged;

    if (shouldReplaceTurns) {
      if (typeof timeline.setServerTurns === "function") {
        timeline.setServerTurns(turns);
      } else {
        timeline.clear();
      }
      timelineHasTruncatedHead = false;
      if (data.reset === true) {
        appendLog("[timeline] session file was reset or rotated");
      }
    }

    timelineCursor = nextCursor;
    applyTimelineWatchMetadata(state.threadId, data);

    if (data.truncated === true) {
      timelineHasTruncatedHead = true;
    }
    updateTimelineTruncationNotice();
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
    setJumpCollapseMode(false);
  }

  activeSessionId = sessionId;
  if (sessionSelect) {
    sessionSelect.value = sessionId;
  }
  stopSessionBtn.disabled = false;
  const state = sessions.get(sessionId);
  markThreadCompletionSeen(state?.threadId || "");
  if (state?.threadId) {
    const preferred = getPreferredModelForThread(state.threadId);
    if (preferred.found) {
      state.model = preferred.model || null;
    }
    const preferredEffort = getPreferredReasoningForThread(state.threadId);
    if (preferredEffort.found) {
      state.reasoningEffort = preferredEffort.effort || null;
    }
  }
  if (state?.threadId && pendingSessionLoadThreadId && state.threadId === pendingSessionLoadThreadId) {
    clearPendingSessionLoad();
  }
  storeLastSessionId(sessionId);
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
    timelineHasTruncatedHead = false;
    updateTimelineTruncationNotice();
    restartTimelinePolling();
  }

  updateScrollToBottomButton();
}

function clearActiveSession() {
  const previousState = getActiveSessionState();
  rememberPromptDraftForState(previousState);
  setJumpCollapseMode(false);

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
  timelineHasTruncatedHead = false;
  updateTimelineTruncationNotice();
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

  const storedSessionId = getStoredLastSessionId();
  const storedThreadId = getStoredLastThreadId();
  const sessionForStoredThread = storedThreadId ? getAttachedSessionIdByThreadId(storedThreadId) : null;
  const toSelect = activeSessionId ||
    current ||
    (storedSessionId && sessions.has(storedSessionId) ? storedSessionId : null) ||
    (sessionForStoredThread && sessions.has(sessionForStoredThread) ? sessionForStoredThread : null) ||
    activeIdFromServer ||
    (ids.length > 0 ? ids[0] : null);
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

function selectedReasoningValue() {
  if (!conversationReasoningSelect) {
    return "";
  }

  return normalizeReasoningEffort(conversationReasoningSelect.value || "");
}

function applySessionModelSettingsToActiveSession(selectedModel, selectedEffort = null) {
  const state = getActiveSessionState();
  if (!state || !state.threadId || !activeSessionId) {
    return;
  }

  const normalizedModel = normalizeModelValue(selectedModel);
  const normalizedEffort = selectedEffort === null || selectedEffort === undefined
    ? normalizeReasoningEffort(state.reasoningEffort || "")
    : normalizeReasoningEffort(selectedEffort);

  state.model = normalizedModel || null;
  state.reasoningEffort = normalizedEffort || null;
  setPreferredModelForThread(state.threadId, normalizedModel);
  setPreferredReasoningForThread(state.threadId, normalizedEffort);
  trySendSessionModelSync(activeSessionId, normalizedModel, normalizedEffort);
}

function applyModelSelection(value) {
  const normalized = normalizeModelValue(value);
  if (!normalized) {
    modelSelect.value = "";
    modelCustomInput.classList.add("hidden");
    syncModelCommandOptionsFromToolbar();
    applySessionModelSettingsToActiveSession("", selectedReasoningValue());
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
    applySessionModelSettingsToActiveSession(modelValueForCreate() || "", selectedReasoningValue());
    refreshSessionMeta();
    renderProjectSidebar();
    return;
  }

  modelSelect.value = "__custom__";
  modelCustomInput.classList.remove("hidden");
  modelCustomInput.value = normalized;
  syncModelCommandOptionsFromToolbar();
  applySessionModelSettingsToActiveSession(modelValueForCreate() || "", selectedReasoningValue());
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
  loadThreadModelState();
  loadThreadReasoningState();

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
    pendingApproval = null;
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

function buildSessionModelSyncKey(model, effort) {
  const normalizedModel = normalizeModelValue(model);
  const normalizedEffort = normalizeReasoningEffort(effort);
  return `${normalizedModel}||${normalizedEffort}`;
}

function trySendSessionModelSync(sessionId, model, effort) {
  const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!normalizedSessionId) {
    return false;
  }

  const key = buildSessionModelSyncKey(model, effort);
  if (lastConfirmedSessionModelSyncBySession.get(normalizedSessionId) === key) {
    return false;
  }
  if (pendingSessionModelSyncBySession.get(normalizedSessionId) === key) {
    return false;
  }

  const normalizedModel = normalizeModelValue(model);
  const normalizedEffort = normalizeReasoningEffort(effort);
  if (!send("session_set_model", { sessionId: normalizedSessionId, model: normalizedModel, effort: normalizedEffort })) {
    return false;
  }

  pendingSessionModelSyncBySession.set(normalizedSessionId, key);
  return true;
}

function acknowledgeSessionModelSync(sessionId, model, effort) {
  const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!normalizedSessionId) {
    return;
  }

  const serverKey = buildSessionModelSyncKey(model, effort);
  lastConfirmedSessionModelSyncBySession.set(normalizedSessionId, serverKey);

  const pending = pendingSessionModelSyncBySession.get(normalizedSessionId);
  if (!pending) {
    return;
  }

  if (pending === serverKey) {
    pendingSessionModelSyncBySession.delete(normalizedSessionId);
  }
}

function prunePendingSessionModelSync(validSessionIds) {
  const valid = new Set(Array.isArray(validSessionIds) ? validSessionIds.filter((x) => typeof x === "string" && x.trim()) : []);
  for (const sessionId of Array.from(pendingSessionModelSyncBySession.keys())) {
    if (!valid.has(sessionId)) {
      pendingSessionModelSyncBySession.delete(sessionId);
    }
  }
  for (const sessionId of Array.from(lastConfirmedSessionModelSyncBySession.keys())) {
    if (!valid.has(sessionId)) {
      lastConfirmedSessionModelSyncBySession.delete(sessionId);
    }
  }
}

function pruneTurnActivityState(validSessionIds) {
  const valid = new Set(Array.isArray(validSessionIds) ? validSessionIds.filter((x) => typeof x === "string" && x.trim()) : []);
  for (const sessionId of Array.from(turnStartedAtBySession.keys())) {
    if (!valid.has(sessionId)) {
      turnStartedAtBySession.delete(sessionId);
    }
  }
}

function pruneRateLimitState(validSessionIds) {
  const valid = new Set(Array.isArray(validSessionIds) ? validSessionIds.filter((x) => typeof x === "string" && x.trim()) : []);
  for (const sessionId of Array.from(rateLimitBySession.keys())) {
    if (!valid.has(sessionId)) {
      rateLimitBySession.delete(sessionId);
    }
  }
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
      let persistedPreferenceUpdated = false;
      if (state.threadId) {
        const serverModel = normalizeModelValue(payload.model || "");
        const serverEffort = normalizeReasoningEffort(payload.reasoningEffort ?? payload.effort ?? "");
        const preferred = getPreferredModelForThread(state.threadId);
        const preferredEffort = getPreferredReasoningForThread(state.threadId);
        const targetModel = preferred.found ? preferred.model : serverModel;
        const targetEffort = preferredEffort.found ? preferredEffort.effort : serverEffort;
        acknowledgeSessionModelSync(sessionId, serverModel, serverEffort);

        state.model = targetModel || null;
        state.reasoningEffort = targetEffort || null;

        if (preferred.found) {
          state.model = preferred.model || null;
        } else if (payload.model !== undefined) {
          persistedPreferenceUpdated = ensureThreadModelPreference(state.threadId, serverModel, { persist: false }) || persistedPreferenceUpdated;
        }

        if (preferredEffort.found) {
          state.reasoningEffort = preferredEffort.effort || null;
        } else if (payload.reasoningEffort !== undefined || payload.effort !== undefined) {
          persistedPreferenceUpdated = ensureThreadReasoningPreference(state.threadId, serverEffort, { persist: false }) || persistedPreferenceUpdated;
        }
      }
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
        if (entry && state.model !== null && state.model !== undefined) {
          entry.model = state.model;
        }
      }
      if (persistedPreferenceUpdated) {
        persistThreadModelState();
        persistThreadReasoningState();
      }
      const attachedMode = payload.attached === true || type === "session_attached";
      if (!attachedMode) {
        touchSessionActivity(sessionId);
      }
      if (state.threadId && pendingSessionLoadThreadId && state.threadId === pendingSessionLoadThreadId) {
        clearPendingSessionLoad();
      }
      setTurnInFlight(sessionId, false);
      const mode = attachedMode ? "attached" : "created";
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
      const nextProcessingByThread = new Map();
      let matchedPendingThread = false;
      let persistedPreferenceUpdated = false;
      for (const s of list) {
        const existing = sessions.get(s.sessionId);
        const st =
          existing || { threadId: null, cwd: null, model: null, reasoningEffort: null, pendingApproval: null, queuedTurns: [], queuedTurnCount: 0, turnCountInMemory: 0, createdAtTick: Date.now(), lastActivityTick: 0 };
        st.threadId = s.threadId || st.threadId || null;
        st.cwd = s.cwd || st.cwd || null;
        const serverModel = normalizeModelValue(s.model);
        const serverEffort = normalizeReasoningEffort(s.reasoningEffort ?? s.effort ?? "");
        if (st.threadId) {
          const preferred = getPreferredModelForThread(st.threadId);
          const preferredEffort = getPreferredReasoningForThread(st.threadId);
          const targetModel = preferred.found ? preferred.model : serverModel;
          const targetEffort = preferredEffort.found ? preferredEffort.effort : serverEffort;
          acknowledgeSessionModelSync(s.sessionId, serverModel, serverEffort);

          st.model = targetModel || st.model || null;
          st.reasoningEffort = targetEffort || st.reasoningEffort || null;

          if (preferred.found) {
            st.model = preferred.model || null;
          } else {
            st.model = serverModel || st.model || null;
            if (s.model !== undefined) {
              persistedPreferenceUpdated = ensureThreadModelPreference(st.threadId, serverModel, { persist: false }) || persistedPreferenceUpdated;
            }
          }

          if (preferredEffort.found) {
            st.reasoningEffort = preferredEffort.effort || null;
          } else if (s.reasoningEffort !== undefined || s.effort !== undefined) {
            persistedPreferenceUpdated = ensureThreadReasoningPreference(st.threadId, serverEffort, { persist: false }) || persistedPreferenceUpdated;
          }
        } else {
          st.model = serverModel || st.model || null;
          st.reasoningEffort = serverEffort || st.reasoningEffort || null;
        }
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

        const pending =
          s.pendingApproval && typeof s.pendingApproval === "object" && !Array.isArray(s.pendingApproval) ? s.pendingApproval : null;
        st.pendingApproval = pending && typeof pending.approvalId === "string" && pending.approvalId.trim() ? pending : null;
        st.queuedTurns = normalizeQueuedTurnSummaryList(s.queuedTurns || s.queuedMessages || []);
        st.queuedTurnCount = Number.isFinite(s.queuedTurnCount)
          ? Math.max(0, Math.floor(s.queuedTurnCount))
          : st.queuedTurns.length;
        st.turnCountInMemory = Number.isFinite(s.turnCountInMemory)
          ? Math.max(0, Math.floor(s.turnCountInMemory))
          : Number.isFinite(st.turnCountInMemory) ? st.turnCountInMemory : 0;

        const inFlight = s.isTurnInFlight === true || s.turnInFlight === true;
        setTurnInFlight(s.sessionId, inFlight);
        if (inFlight && st.threadId) {
          nextProcessingByThread.set(st.threadId, true);
        }
        next.set(s.sessionId, st);
      }
      if (payload.processingByThread && typeof payload.processingByThread === "object" && !Array.isArray(payload.processingByThread)) {
        for (const [threadId, processing] of Object.entries(payload.processingByThread)) {
          const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
          if (!normalizedThreadId || processing !== true) {
            continue;
          }

          nextProcessingByThread.set(normalizedThreadId, true);
        }
      }
      if (persistedPreferenceUpdated) {
        persistThreadModelState();
        persistThreadReasoningState();
      }
      if (matchedPendingThread) {
        clearPendingSessionLoad();
      }
      sessions = next;
      prunePendingSessionModelSync(Array.from(next.keys()));
      pruneTurnActivityState(Array.from(next.keys()));
      pruneRateLimitState(Array.from(next.keys()));
      applyProcessingByThread(nextProcessingByThread);
      prunePromptState();
      updateSessionSelect(payload.activeSessionId || null);

      const activeState = getActiveSessionState();
      const activePending = activeState && activeState.pendingApproval ? activeState.pendingApproval : null;
      if (activeSessionId && activePending && typeof activePending.approvalId === "string" && activePending.approvalId.trim()) {
        const approvalId = activePending.approvalId.trim();
        if (!pendingApproval || pendingApproval.sessionId !== activeSessionId || pendingApproval.approvalId !== approvalId) {
          pendingApproval = { sessionId: activeSessionId, approvalId };
          approvalSummary.textContent = activePending.summary || "Approval requested";
          const lines = [];
          if (activePending.reason) lines.push(`Reason: ${activePending.reason}`);
          if (activePending.cwd) lines.push(`CWD: ${activePending.cwd}`);
          if (Array.isArray(activePending.actions) && activePending.actions.length > 0) lines.push(`Actions: ${activePending.actions.join("; ")}`);
          approvalDetails.textContent = lines.join("\n");
          setApprovalVisible(true);
          appendLog(`[approval] pending session=${activeSessionId} approvalId=${approvalId}`);
        }
      } else if (pendingApproval) {
        const priorState = pendingApproval.sessionId ? sessions.get(pendingApproval.sessionId) : null;
        const stillPending =
          priorState &&
          priorState.pendingApproval &&
          typeof priorState.pendingApproval.approvalId === "string" &&
          priorState.pendingApproval.approvalId === pendingApproval.approvalId;
        if (!stillPending) {
          pendingApproval = null;
          setApprovalVisible(false);
        }
      }

      return;
    }

    case "session_catalog": {
      sessionCatalogLoadedOnce = true;
      const list = Array.isArray(payload.sessions) ? payload.sessions : [];
      const nextProcessingByThread = new Map(processingByThread);
      let persistedPreferenceUpdated = false;
      sessionCatalog = list
        .filter((s) => s && s.threadId)
        .map((s) => {
          const normalizedThreadId = typeof s.threadId === "string" ? s.threadId.trim() : "";
          if (normalizedThreadId) {
            if (s.isProcessing === true) {
              nextProcessingByThread.set(normalizedThreadId, true);
            } else if (s.isProcessing === false) {
              nextProcessingByThread.delete(normalizedThreadId);
            }
          }

          const preferred = getPreferredModelForThread(s.threadId);
          const preferredEffort = getPreferredReasoningForThread(s.threadId);
          if (preferred.found) {
            return { ...s, model: preferred.model, reasoningEffort: preferredEffort.found ? preferredEffort.effort : normalizeReasoningEffort(s.reasoningEffort ?? s.effort ?? "") };
          }

          const normalizedServerModel = normalizeModelValue(s.model);
          const normalizedServerEffort = normalizeReasoningEffort(s.reasoningEffort ?? s.effort ?? "");
          if (ensureThreadModelPreference(s.threadId, normalizedServerModel, { persist: false })) {
            persistedPreferenceUpdated = true;
          }
          if (ensureThreadReasoningPreference(s.threadId, normalizedServerEffort, { persist: false })) {
            persistedPreferenceUpdated = true;
          }
          return { ...s, model: normalizedServerModel, reasoningEffort: preferredEffort.found ? preferredEffort.effort : normalizedServerEffort };
        })
        .sort((a, b) => (b.updatedAtUtc || "").localeCompare(a.updatedAtUtc || ""));
      if (payload.processingByThread && typeof payload.processingByThread === "object" && !Array.isArray(payload.processingByThread)) {
        nextProcessingByThread.clear();
        for (const [threadId, processing] of Object.entries(payload.processingByThread)) {
          const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
          if (!normalizedThreadId || processing !== true) {
            continue;
          }

          nextProcessingByThread.set(normalizedThreadId, true);
        }
      }
      applyProcessingByThread(nextProcessingByThread);
      if (persistedPreferenceUpdated) {
        persistThreadModelState();
        persistThreadReasoningState();
      }
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
        pendingSessionModelSyncBySession.delete(sessionId);
        lastConfirmedSessionModelSyncBySession.delete(sessionId);
      }
      if (sessionId) {
        turnInFlightBySession.delete(sessionId);
        turnStartedAtBySession.delete(sessionId);
        lastSentPromptBySession.delete(sessionId);
        rateLimitBySession.delete(sessionId);
      }
      appendLog(`[session] stopped id=${sessionId || "unknown"}`);
      updateSessionSelect(payload.activeSessionId || null);
      return;
    }

    case "assistant_delta": {
      return;
    }

    case "assistant_response_started": {
      return;
    }

    case "assistant_done": {
      return;
    }

    case "turn_complete": {
      const sessionId = payload.sessionId || null;
      const status = payload.status || "unknown";
      let sidebarStateChanged = false;
      if (sessionId) {
        touchSessionActivity(sessionId);
        const state = sessions.get(sessionId) || null;
        const threadId = normalizeThreadId(state?.threadId || "");
        if (threadId) {
          const wasProcessing = processingByThread.get(threadId) === true;
          processingByThread.delete(threadId);
          if (wasProcessing) {
            sidebarStateChanged = true;
          }
          if (status === "completed") {
            sidebarStateChanged = markThreadCompletionUnread(threadId, { requireAttached: true }) || sidebarStateChanged;
          }
        }
        setTurnInFlight(sessionId, false);
      }
      const errorMessage = payload.errorMessage || null;
      appendLog(`[turn] session=${payload.sessionId || "unknown"} status=${status}${errorMessage ? " error=" + errorMessage : ""}`);
      if (sidebarStateChanged) {
        renderProjectSidebar();
      }
      renderPromptQueue();
      return;
    }

    case "turn_started": {
      const sessionId = payload.sessionId || null;
      let sidebarStateChanged = false;
      if (sessionId) {
        touchSessionActivity(sessionId);
        const state = sessions.get(sessionId) || null;
        const threadId = normalizeThreadId(state?.threadId || "");
        if (threadId) {
          if (processingByThread.get(threadId) !== true) {
            sidebarStateChanged = true;
          }
          processingByThread.set(threadId, true);
          sidebarStateChanged = completedUnreadThreadIds.delete(threadId) || sidebarStateChanged;
        }
        setTurnInFlight(sessionId, true);
      }
      if (sidebarStateChanged) {
        renderProjectSidebar();
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

    case "turn_queue_edit_item": {
      const sessionId = payload.sessionId || null;
      if (!sessionId || !activeSessionId || sessionId !== activeSessionId) {
        return;
      }

      const images = Array.isArray(payload.images)
        ? payload.images
            .filter((x) => x && typeof x.url === "string" && x.url.trim().length > 0)
            .map((x) => ({
              url: x.url,
              name: typeof x.name === "string" ? x.name : "image",
              mimeType: typeof x.mimeType === "string" ? x.mimeType : "image/*",
              size: typeof x.size === "number" ? x.size : 0
            }))
        : [];
      restoreQueuedPromptForEditing(payload.text || "", images);
      appendLog(`[queue] restored queued prompt ${payload.queueItemId || ""} for editing`);
      return;
    }

    case "rate_limits_updated": {
      const sessionId = payload.sessionId || null;
      if (sessionId) {
        rateLimitBySession.set(sessionId, payload);
      }

      const summary = typeof payload.summary === "string" && payload.summary.trim()
        ? payload.summary.trim()
        : "Rate limits updated";
      appendLog(`[rate_limit] session=${sessionId || "unknown"} ${summary}`);
      return;
    }

    case "session_configured": {
      const sessionId = payload.sessionId || null;
      let sidebarStateChanged = false;
      let sessionConfigChanged = false;
      if (sessionId && sessions.has(sessionId)) {
        const state = sessions.get(sessionId);
        if (state) {
          if (typeof payload.threadId === "string" && payload.threadId.trim()) {
            const nextThreadId = payload.threadId.trim();
            if ((state.threadId || "") !== nextThreadId) {
              state.threadId = nextThreadId;
              sidebarStateChanged = true;
              sessionConfigChanged = true;
            }
          }
          if (typeof payload.cwd === "string" && payload.cwd.trim()) {
            const nextCwd = payload.cwd.trim();
            if ((state.cwd || "") !== nextCwd) {
              state.cwd = nextCwd;
              sidebarStateChanged = true;
              sessionConfigChanged = true;
            }
          }

          const configuredModel = normalizeModelValue(payload.model);
          const configuredEffort = normalizeReasoningEffort(payload.reasoningEffort ?? payload.effort ?? "");
          if (payload.model !== undefined) {
            if ((state.model || "") !== configuredModel) {
              sidebarStateChanged = true;
              sessionConfigChanged = true;
            }
            state.model = configuredModel || null;
          }
          if (payload.reasoningEffort !== undefined || payload.effort !== undefined) {
            if ((state.reasoningEffort || "") !== configuredEffort) {
              sidebarStateChanged = true;
              sessionConfigChanged = true;
            }
            state.reasoningEffort = configuredEffort || null;
          }

          if (payload.model !== undefined || payload.reasoningEffort !== undefined || payload.effort !== undefined) {
            acknowledgeSessionModelSync(sessionId, state.model || "", state.reasoningEffort || "");
          }

          if (state.threadId) {
            const permissionInfo = readPermissionInfoFromPayload(payload);
            if (permissionInfo) {
              setPermissionLevelForThread(state.threadId, permissionInfo);
            }
          }
        }
      }

      if (sessionId && sessionConfigChanged) {
        touchSessionActivity(sessionId);
      }

      const summaryParts = [];
      if (payload.model) summaryParts.push(`model=${payload.model}`);
      if (payload.reasoningEffort || payload.effort) summaryParts.push(`effort=${payload.reasoningEffort || payload.effort}`);
      if (payload.approvalPolicy || payload.approval_policy) summaryParts.push(`approval=${payload.approvalPolicy || payload.approval_policy}`);
      if (payload.sandboxPolicy || payload.sandbox_policy) summaryParts.push(`sandbox=${payload.sandboxPolicy || payload.sandbox_policy}`);
      const summary = summaryParts.length > 0 ? summaryParts.join(" | ") : "Session configured";

      appendLog(`[session_configured] session=${sessionId || "unknown"} ${summary}`);
      if (sessionId && activeSessionId === sessionId) {
        refreshSessionMeta();
      }
      if (sidebarStateChanged) {
        renderProjectSidebar();
      }
      return;
    }

    case "thread_compacted": {
      const sessionId = payload.sessionId || null;
      let threadId = typeof payload.threadId === "string" ? payload.threadId.trim() : "";
      if (!threadId && sessionId && sessions.has(sessionId)) {
        const state = sessions.get(sessionId);
        threadId = normalizeThreadId(state?.threadId || "");
      }

      const compactionPieces = readThreadCompactedInfo({ ...payload, type: "thread_compacted" });
      if (threadId && compactionPieces) {
        applyContextUsageForThread(
          threadId,
          {
            contextWindow: compactionPieces.contextWindow,
            usedTokensAfter: compactionPieces.usedTokensAfter,
            percentLeft: compactionPieces.percentLeft
          },
          "thread_compacted"
        );
      }

      const summary = compactionPieces?.summary
        || (typeof payload.summary === "string" && payload.summary.trim() ? payload.summary.trim() : "Context compressed");
      appendLog(`[thread_compacted] thread=${threadId || "unknown"} ${summary}`);
      return;
    }

    case "thread_name_updated": {
      const sessionId = payload.sessionId || null;
      const threadId = normalizeThreadId(payload.threadId || "");
      const threadName = String(payload.threadName || "").trim();
      if (!threadId || !threadName) {
        return;
      }

      let priorName = "";
      for (const state of sessions.values()) {
        if (state && normalizeThreadId(state.threadId || "") === threadId && typeof state.threadName === "string" && state.threadName.trim()) {
          priorName = state.threadName.trim();
          break;
        }
      }
      if (!priorName) {
        const entry = getCatalogEntryByThreadId(threadId);
        if (entry && typeof entry.threadName === "string" && entry.threadName.trim()) {
          priorName = entry.threadName.trim();
        }
      }
      if (priorName && priorName === threadName) {
        return;
      }

      setLocalThreadName(threadId, threadName);
      const activeThreadId = normalizeThreadId(getActiveSessionState()?.threadId || "");
      if (activeThreadId === threadId) {
        refreshSessionMeta();
      }
      updateSessionSelect(activeSessionId || null);
      renderProjectSidebar();

      if (sessionId) {
        touchSessionActivity(sessionId);
      }

      appendLog(`[thread_name_updated] thread=${threadId} name=${threadName}`);
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

    case "approval_resolved": {
      const sessionId = payload.sessionId || null;
      const approvalId = payload.approvalId || null;
      const decision = payload.decision || "unknown";
      if (pendingApproval && pendingApproval.sessionId === sessionId && pendingApproval.approvalId === approvalId) {
        pendingApproval = null;
        setApprovalVisible(false);
      }
      appendLog(`[approval] resolved session=${sessionId || "unknown"} approvalId=${approvalId || "unknown"} decision=${decision}`);
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
      if (payload.source === "connection" && typeof payload.message === "string" && payload.message.startsWith("[client] raw")) {
        return;
      }
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
  if (modelSelect.value === "__custom__" && !nextModel) {
    return;
  }
  if (activeSessionId && sessions.has(activeSessionId)) {
    applySessionModelSettingsToActiveSession(nextModel || "", selectedReasoningValue());
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
        syncConversationModelOptions(normalizeModelValue(getActiveSessionState()?.model || ""));
        return;
      }

      const custom = String(proposed || "").trim();
      if (!custom) {
        appendLog("[model] custom model cannot be empty");
        syncConversationModelOptions(normalizeModelValue(getActiveSessionState()?.model || ""));
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

if (conversationReasoningSelect) {
  conversationReasoningSelect.addEventListener("change", () => {
    if (syncingConversationModelSelect) {
      return;
    }

    const nextEffort = normalizeReasoningEffort(conversationReasoningSelect.value || "");
    const nextModel = modelValueForCreate() || "";
    applySessionModelSettingsToActiveSession(nextModel, nextEffort);
    refreshSessionMeta();
    renderProjectSidebar();
    appendLog(nextEffort ? `[reasoning] set to '${nextEffort}'` : "[reasoning] reverted to default");
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

if (newProjectCreateBtn) {
  newProjectCreateBtn.addEventListener("click", () => {
    submitNewProjectModal().catch((error) => appendLog(`[project] create failed: ${error}`));
  });
}

if (newProjectCancelBtn) {
  newProjectCancelBtn.addEventListener("click", () => {
    closeNewProjectModal();
  });
}

if (newProjectCwdInput) {
  newProjectCwdInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitNewProjectModal().catch((error) => appendLog(`[project] create failed: ${error}`));
    }
  });
}

if (newProjectFirstSessionInput) {
  newProjectFirstSessionInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitNewProjectModal().catch((error) => appendLog(`[project] create failed: ${error}`));
    }
  });
}

if (newProjectModal) {
  newProjectModal.addEventListener("click", (event) => {
    if (event.target === newProjectModal) {
      closeNewProjectModal();
    }
  });
}

if (aboutBtn) {
  aboutBtn.addEventListener("click", () => {
    openAboutModal();
  });
}

if (aboutModalCloseBtn) {
  aboutModalCloseBtn.addEventListener("click", () => {
    closeAboutModal();
  });
}

if (aboutModal) {
  aboutModal.addEventListener("click", (event) => {
    if (event.target === aboutModal) {
      closeAboutModal();
    }
  });
}

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
    updateTimelineTruncationNotice();
  });

  chatMessages.addEventListener("codex:timeline-updated", () => {
    updateScrollToBottomButton();
    updateTimelineTruncationNotice();
  });
}

if (scrollToBottomBtn) {
  scrollToBottomBtn.addEventListener("click", () => {
    scrollMessagesToBottom(true);
  });
}

if (jumpToBtn) {
  jumpToBtn.addEventListener("click", () => {
    setJumpCollapseMode(!jumpCollapseMode);
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

async function queueCurrentComposerPrompt() {
  const prompt = promptInput.value.trim();
  const images = pendingComposerImages.map((x) => ({ ...x }));
  if (!prompt && images.length === 0) {
    return false;
  }

  if (!activeSessionId) {
    appendLog("[client] no active session; create or attach one first");
    return true;
  }

  if (!isTurnInFlight(activeSessionId)) {
    appendLog(`[queue] no running turn for session=${activeSessionId}; send directly instead`);
    return true;
  }

  try {
    await ensureSocket();
  } catch (error) {
    appendLog(`[ws] connect failed: ${error}`);
    return true;
  }

  const queued = await queuePrompt(activeSessionId, prompt, images);
  if (!queued) {
    appendLog(`[queue] failed to queue prompt for session=${activeSessionId}`);
    return true;
  }

  promptInput.value = "";
  clearCurrentPromptDraft();
  clearComposerImages();
  appendLog(`[turn] queued prompt for session=${activeSessionId}`);
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
});

promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    if (!promptInput.value.trim() && pendingComposerImages.length === 0) {
      return;
    }

    if (!activeSessionId || !isTurnInFlight(activeSessionId)) {
      return;
    }

    event.preventDefault();
    queueCurrentComposerPrompt().catch((error) => appendLog(`[queue] failed: ${error}`));
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
    queueCurrentComposerPrompt().catch((error) => appendLog(`[queue] failed: ${error}`));
    promptInput.focus();
  });
}

if (cancelTurnBtn) {
  cancelTurnBtn.addEventListener("click", () => {
    cancelCurrentTurn();
    promptInput.focus();
  });
}

if (turnActivityCancelLink) {
  turnActivityCancelLink.addEventListener("click", (event) => {
    event.preventDefault();
    cancelCurrentTurn();
    if (promptInput) {
      promptInput.focus();
    }
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

  if (jumpCollapseMode) {
    event.preventDefault();
    setJumpCollapseMode(false);
    return;
  }

  if (newProjectModal && !newProjectModal.classList.contains("hidden")) {
    event.preventDefault();
    closeNewProjectModal();
    return;
  }

  if (aboutModal && !aboutModal.classList.contains("hidden")) {
    event.preventDefault();
    closeAboutModal();
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
  updateTimelineTruncationNotice();
});

window.addEventListener("beforeunload", () => {
  rememberPromptDraftForState(getActiveSessionState());
});

applySavedUiSettings();
renderComposerImages();
renderProjectSidebar();
updateScrollToBottomButton();
updateTimelineTruncationNotice();
updatePromptActionState();
updateContextLeftIndicator();
updatePermissionLevelIndicator();
updateMobileProjectsButton();
updateConversationMetaVisibility();

turnActivityTickTimer = setInterval(() => {
  updateTurnActivityStrip();
}, TURN_ACTIVITY_TICK_INTERVAL_MS);
logFlushTimer = setInterval(() => flushPendingClientLogs(), LOG_FLUSH_INTERVAL_MS);

loadRuntimeSecurityConfig()
  .catch((error) => {
    appendLog(`[security] config load failed: ${error}`);
    setSecurityWarningVisible(SECURITY_WARNING_TEXT, ["Security posture could not be loaded from the server."]);
  })
  .finally(() => {
    ensureSocket().catch((error) => appendLog(`[ws] connect failed: ${error}`));
  });
