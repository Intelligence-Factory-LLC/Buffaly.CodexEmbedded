(function () {
  const panel = document.getElementById("worktreeDiffPanel");
  const summaryNode = document.getElementById("worktreeDiffSummary");
  const listNode = document.getElementById("worktreeDiffList");
  const refreshBtn = document.getElementById("worktreeDiffRefreshBtn");
  const toggleBtn = document.getElementById("worktreeDiffToggleBtn");
  const indicatorBtn = document.getElementById("worktreeDiffIndicatorBtn");
  const indicatorCountNode = document.getElementById("worktreeDiffIndicatorCount");
  const modeWorktreeBtn = document.getElementById("worktreeDiffModeWorktreeBtn");
  const modeCommitBtn = document.getElementById("worktreeDiffModeCommitBtn");
  const commitSelect = document.getElementById("worktreeDiffCommitSelect");
  const contextSelect = document.getElementById("worktreeDiffContextSelect");
  const sendNotesBtn = document.getElementById("worktreeDiffSendNotesBtn");
  const queueReviewBtn = document.getElementById("worktreeDiffQueueReviewBtn");
  const runReviewBtn = document.getElementById("worktreeDiffRunReviewBtn");
  const commitReviewSummaryNode = document.getElementById("worktreeDiffCommitReviewSummary");
  const reviewFindingsNode = document.getElementById("diffReviewFindings");
  const fullFileWindow = document.getElementById("diffFullFileWindow");
  const fullFileTitle = document.getElementById("diffFullFileTitle");
  const fullFileClassSelect = document.getElementById("diffFullFileClassSelect");
  const fullFileMethodSelect = document.getElementById("diffFullFileMethodSelect");
  const fullFileCloseBtn = document.getElementById("diffFullFileCloseBtn");
  const fullFileStatus = document.getElementById("diffFullFileStatus");
  const fullFileBody = document.getElementById("diffFullFileBody");
  const fullFileReviewPanel = document.getElementById("diffFullFileReviewPanel");
  const fullFileReviewTitle = document.getElementById("diffFullFileReviewTitle");
  const fullFileReviewMeta = document.getElementById("diffFullFileReviewMeta");
  const fullFileReviewContext = document.getElementById("diffFullFileReviewContext");
  const fullFileNoteTarget = document.getElementById("diffFullFileNoteTarget");
  const fullFileNoteTextarea = document.getElementById("diffFullFileNoteTextarea");
  const fullFileNoteSaveBtn = document.getElementById("diffFullFileNoteSaveBtn");
  const fullFileNoteRemoveBtn = document.getElementById("diffFullFileNoteRemoveBtn");
  const fullFileNoteSendBtn = document.getElementById("diffFullFileNoteSendBtn");
  const composerNotesNode = document.getElementById("diffNotesComposer");
  const noteModal = document.getElementById("diffNoteModal");
  const noteModalPath = document.getElementById("diffNoteModalPath");
  const noteModalTextarea = document.getElementById("diffNoteModalTextarea");
  const noteModalSaveBtn = document.getElementById("diffNoteModalSaveBtn");
  const noteModalRemoveBtn = document.getElementById("diffNoteModalRemoveBtn");
  const noteModalCancelBtn = document.getElementById("diffNoteModalCancelBtn");
  const noteModalCard = noteModal ? noteModal.querySelector(".diff-note-modal-card") : null;
  const noteModalTitle = document.getElementById("diffNoteModalTitle");
  const reviewModal = document.getElementById("diffReviewModal");
  const reviewModalTarget = document.getElementById("diffReviewModalTarget");
  const reviewModalTextarea = document.getElementById("diffReviewModalTextarea");
  const reviewModalQueueBtn = document.getElementById("diffReviewModalQueueBtn");
  const reviewModalRunBtn = document.getElementById("diffReviewModalRunBtn");
  const reviewModalCancelBtn = document.getElementById("diffReviewModalCancelBtn");
  const chatMessagesNode = document.getElementById("chatMessages");
  const bodyNode = document.body;

  if (!panel || !summaryNode || !listNode || !refreshBtn || !toggleBtn || !indicatorBtn || !indicatorCountNode || !modeWorktreeBtn || !modeCommitBtn || !commitSelect || !contextSelect || !sendNotesBtn || !queueReviewBtn || !runReviewBtn || !commitReviewSummaryNode || !reviewFindingsNode || !composerNotesNode) {
    return;
  }

  const noteModalReady = !!(noteModal && noteModalPath && noteModalTextarea && noteModalSaveBtn && noteModalRemoveBtn && noteModalCancelBtn && noteModalCard && noteModalTitle);
  const reviewModalReady = !!(reviewModal && reviewModalTarget && reviewModalTextarea && reviewModalQueueBtn && reviewModalRunBtn && reviewModalCancelBtn);
  const fullFileWindowReady = !!(fullFileWindow
    && fullFileTitle
    && fullFileClassSelect
    && fullFileMethodSelect
    && fullFileCloseBtn
    && fullFileStatus
    && fullFileBody
    && fullFileReviewPanel
    && fullFileReviewTitle
    && fullFileReviewMeta
    && fullFileReviewContext
    && fullFileNoteTarget
    && fullFileNoteTextarea
    && fullFileNoteSaveBtn
    && fullFileNoteRemoveBtn
    && fullFileNoteSendBtn);

  const REFRESH_DEBOUNCE_MS = 120;
  const MAX_LINES_PER_FILE = 280;
  const MAX_REVIEW_NOTE_CHARS = 1000;
  const STORAGE_NOTES_PREFIX = "codex-worktree-diff-notes-v2::";
  const STORAGE_REVIEW_FINDING_STATE_PREFIX = "codex-worktree-diff-review-state-v1::";
  const STORAGE_REVIEW_FINDINGS_PREFIX = "codex-worktree-diff-review-findings-v1::";
  const STORAGE_REVIEW_LIFECYCLE_PREFIX = "codex-worktree-diff-review-lifecycle-v1::";
  const STORAGE_CONTEXT_MODE_KEY = "codex-worktree-diff-context-mode-v1";
  const STORAGE_COMMIT_REVIEW_COLLAPSED_KEY = "codex-worktree-diff-commit-review-collapsed-v1";
  const STORAGE_REVIEW_PANEL_COLLAPSED_KEY = "codex-worktree-diff-review-panel-collapsed-v1";
  const CONTEXT_MODE_VALUES = new Set(["3", "10", "30", "full"]);

  let pollInFlight = false;
  let refreshTimer = null;
  let refreshPendingForce = false;
  let reviewQueuedBadgeTimer = null;
  let reviewDraftText = "";
  let lastRenderKey = "";
  let lastCwd = "";
  let currentRepoRoot = "";
  let currentBranch = "";
  let currentMode = "worktree";
  let currentContextMode = "3";
  let availableCommits = [];
  let selectedCommitSha = "";
  let selectedCommitInfo = null;
  let currentNotesScopeKey = "";
  let currentFileViewScopeKey = "";
  let panelAvailable = false;
  let currentFiles = [];
  let currentTotalChangeCount = 0;
  let hiddenBinaryFileCount = 0;
  let hasVisibleChanges = false;
  let isExpanded = false;
  let notesByKey = new Map();
  let fullFileLoadingByPath = new Set();
  let fullFileViewerLoadToken = 0;
  let fullFileViewerState = createEmptyFullFileViewerState();
  let currentNoteEdit = null;
  let ignoreNextLineClick = false;
  let ignoreNextFullFileLineClick = false;
  let fileOpenStateByPath = new Map();
  let modalOffset = { x: 0, y: 0 };
  let modalDragState = null;
  let missingContextLogged = false;
  let lastContextState = "unknown";
  let reviewFindingsByScope = new Map();
  let reviewFindingsIndexByScope = new Map();
  let reviewScopeByTurnId = new Map();
  let pendingReviewScopeQueue = [];
  let reviewRequestedTurns = new Set();
  let reviewCompletedTurns = new Set();
  let reviewLifecycleByScope = new Map(); // scopeKey -> { requestedCount, completedCount, lastRequestedUtc, lastCompletedUtc }
  let currentReviewStateScopeKey = "";
  let reviewFindingStateByKey = new Map();
  let commitReviewSummaryCollapsed = false;
  let reviewPanelCollapsed = false;
  let workspaceMode = "tasks";
  let reviewPageMode = "list"; // list | detail
  let detailReviewAction = ""; // run | queue | ""
  try {
    currentContextMode = normalizeContextMode(window.localStorage.getItem(STORAGE_CONTEXT_MODE_KEY) || "3");
  } catch {
    currentContextMode = "3";
  }
  try {
    commitReviewSummaryCollapsed = window.localStorage.getItem(STORAGE_COMMIT_REVIEW_COLLAPSED_KEY) === "1";
  } catch {
    commitReviewSummaryCollapsed = false;
  }
  try {
    reviewPanelCollapsed = window.localStorage.getItem(STORAGE_REVIEW_PANEL_COLLAPSED_KEY) === "1";
  } catch {
    reviewPanelCollapsed = false;
  }
  try {
    const workspaceProvider = window.codexWorkspaceGetTabMode;
    if (typeof workspaceProvider === "function") {
      workspaceMode = workspaceProvider() === "code_reviews" ? "code_reviews" : "tasks";
    }
  } catch {
    workspaceMode = "tasks";
  }
  reviewPageMode = "list";
  detailReviewAction = "";

  function createEmptyFullFileViewerState() {
    return {
      path: "",
      content: "",
      changedLines: new Set(),
      firstChangedLine: 1,
      requestedLineNo: null,
      classes: [],
      methods: [],
      selectedClass: "",
      selectedMethodKey: "",
      selectedNoteTarget: null,
      reviewContext: null,
      noteDraftKey: "",
      noteDraftText: "",
      noteDraftDirty: false
    };
  }

  function isCodeReviewsWorkspace() {
    return workspaceMode === "code_reviews";
  }

  function setReviewPageMode(mode) {
    const next = mode === "detail" ? "detail" : "list";
    if (reviewPageMode === next) {
      applyPanelState();
      return;
    }
    reviewPageMode = next;
    applyPanelState();
  }

  function openCodeReviewCommitDetail(sha, action = "") {
    const normalizedSha = typeof sha === "string" ? sha.trim() : "";
    if (!normalizedSha) {
      return;
    }

    detailReviewAction = action === "run" || action === "queue" ? action : "";
    setReviewPageMode("detail");
    selectCommitForDetails(normalizedSha);
    if (selectedCommitSha === normalizedSha && currentFiles.length > 0 && detailReviewAction) {
      const pendingAction = detailReviewAction;
      detailReviewAction = "";
      if (pendingAction === "run" || pendingAction === "queue") {
        runReviewFromDiffPanel("").catch(() => { });
      }
    }
  }

  function getActiveContext() {
    const provider = window.codexDiffGetActiveContext;
    if (typeof provider !== "function") {
      if (!missingContextLogged) {
        missingContextLogged = true;
        if (typeof window.uiAuditLog === "function") {
          window.uiAuditLog("diff.context_provider_missing", { provider: "window.codexDiffGetActiveContext" }, "warn");
        } else if (typeof console !== "undefined" && typeof console.warn === "function") {
          console.warn(`${new Date().toISOString()} diff.context_provider_missing provider=window.codexDiffGetActiveContext`);
        }
      }
      return null;
    }

    const context = provider();
    if (!context || typeof context.cwd !== "string" || !context.cwd.trim()) {
      return null;
    }

    return {
      sessionId: typeof context.sessionId === "string" ? context.sessionId : "",
      threadId: typeof context.threadId === "string" ? context.threadId : "",
      cwd: context.cwd.trim()
    };
  }

  function buildDiffScopeKey(cwd, mode, commitSha) {
    const normalizedCwd = typeof cwd === "string" ? cwd.trim() : "";
    const normalizedMode = mode === "commit" ? "commit" : "worktree";
    if (normalizedMode === "commit") {
      const normalizedCommit = typeof commitSha === "string" ? commitSha.trim() : "";
      return `${normalizedCwd}::${normalizedMode}::${normalizedCommit}`;
    }

    return `${normalizedCwd}::${normalizedMode}`;
  }

  function normalizeReviewSeverity(text) {
    const source = typeof text === "string" ? text.toLowerCase() : "";
    if (source.includes("critical")) {
      return "critical";
    }
    if (source.includes("high")) {
      return "high";
    }
    if (source.includes("medium")) {
      return "medium";
    }
    if (source.includes("low")) {
      return "low";
    }

    return "";
  }

  function parseReviewRequestContextFromPromptText(bodyText) {
    const source = typeof bodyText === "string" ? bodyText : "";
    if (!source.trim()) {
      return null;
    }

    if (!/^Run a code review for the current repository state\./im.test(source)) {
      return null;
    }

    const context = getActiveContext();
    const contextCwd = context && typeof context.cwd === "string" && context.cwd.trim()
      ? context.cwd.trim()
      : (typeof lastCwd === "string" ? lastCwd.trim() : "");
    if (!contextCwd) {
      return null;
    }

    const commitMatch = source.match(/Review target:\s*commit\s+([0-9a-f]{7,40})\b/i);
    if (commitMatch) {
      const commitSha = (commitMatch[1] || "").trim();
      if (!commitSha) {
        return null;
      }
      return {
        mode: "commit",
        commitSha,
        scopeKey: buildDiffScopeKey(contextCwd, "commit", commitSha)
      };
    }

    if (/Review target:\s*uncommitted working tree changes/i.test(source)) {
      return {
        mode: "worktree",
        commitSha: "",
        scopeKey: buildDiffScopeKey(contextCwd, "worktree", "")
      };
    }

    return null;
  }

  function extractReviewFindingsFromBodyText(bodyText, cwd) {
    const source = typeof bodyText === "string" ? bodyText : "";
    const normalizedCwd = typeof cwd === "string" ? cwd.trim() : "";
    if (!source.trim() || !normalizedCwd) {
      return [];
    }

    const looksLikeReview = /\bfindings?\b/i.test(source) || /\b(critical|high|medium|low)\b/i.test(source);
    if (!looksLikeReview) {
      return [];
    }

    const findings = [];
    const dedupe = new Set();
    const lines = source.split(/\r?\n/);
    for (const rawLine of lines) {
      if (typeof rawLine !== "string" || !rawLine.includes("[") || !rawLine.includes("(")) {
        continue;
      }

      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      const severity = normalizeReviewSeverity(line);
      const compactLine = line.replace(/\s+/g, " ").trim();
      const markdownLinkMatches = line.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g);
      for (const match of markdownLinkMatches) {
        const label = typeof match[1] === "string" ? match[1].trim() : "";
        const href = typeof match[2] === "string" ? match[2].trim() : "";
        const parsed = parseFileLinkTarget(href);
        if (!parsed || !parsed.path || !Number.isFinite(parsed.lineNo) || parsed.lineNo <= 0) {
          continue;
        }

        const normalizedPath = normalizePathForDiffViewer(parsed.path, normalizedCwd);
        if (!normalizedPath) {
          continue;
        }

        const detailText = compactLine.length > 320 ? `${compactLine.slice(0, 319)}...` : compactLine;
        const key = `${normalizedPath}|${parsed.lineNo}|${detailText}`;
        if (dedupe.has(key)) {
          continue;
        }

        dedupe.add(key);
        findings.push({
          path: normalizedPath,
          lineNo: parsed.lineNo,
          severity,
          label,
          detail: detailText
        });
      }
    }

    return findings;
  }

  function looksLikeReviewResponseBody(bodyText) {
    const source = typeof bodyText === "string" ? bodyText : "";
    if (!source.trim()) {
      return false;
    }
    if (/\bFindings\b/i.test(source) || /\b(critical|high|medium|low)\b/i.test(source)) {
      return true;
    }
    if (/\bcode review\b/i.test(source) && /\b(issue|risk|regression|test)\b/i.test(source)) {
      return true;
    }
    return false;
  }

  function rebuildReviewFindingsIndex(scopeKey) {
    if (!scopeKey) {
      return;
    }

    const entries = reviewFindingsByScope.get(scopeKey);
    if (!(entries instanceof Map) || entries.size === 0) {
      reviewFindingsIndexByScope.delete(scopeKey);
      return;
    }

    const index = new Map();
    for (const findingList of entries.values()) {
      if (!Array.isArray(findingList) || findingList.length === 0) {
        continue;
      }

      for (const finding of findingList) {
        if (!finding || typeof finding.path !== "string" || !finding.path) {
          continue;
        }
        if (!Number.isFinite(finding.lineNo) || finding.lineNo <= 0) {
          continue;
        }

        let byLine = index.get(finding.path);
        if (!(byLine instanceof Map)) {
          byLine = new Map();
          index.set(finding.path, byLine);
        }

        let list = byLine.get(finding.lineNo);
        if (!Array.isArray(list)) {
          list = [];
          byLine.set(finding.lineNo, list);
        }
        list.push(finding);
      }
    }

    if (index.size === 0) {
      reviewFindingsIndexByScope.delete(scopeKey);
      return;
    }
    reviewFindingsIndexByScope.set(scopeKey, index);
  }

  function reviewFindingsStorageKey(scopeKey) {
    return `${STORAGE_REVIEW_FINDINGS_PREFIX}${scopeKey || ""}`;
  }

  function loadReviewFindingsForScope(scopeKey) {
    const next = new Map();
    if (!scopeKey) {
      return next;
    }

    try {
      const raw = window.localStorage.getItem(reviewFindingsStorageKey(scopeKey));
      if (!raw) {
        return next;
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return next;
      }

      for (const item of parsed) {
        if (!item || typeof item.entryId !== "string" || !item.entryId.trim()) {
          continue;
        }
        if (!Array.isArray(item.findings)) {
          continue;
        }

        const normalizedFindings = [];
        for (const f of item.findings) {
          if (!f || typeof f.path !== "string" || !f.path.trim()) {
            continue;
          }
          const lineNo = Number.isFinite(f.lineNo) ? Math.floor(f.lineNo) : Number.parseInt(String(f.lineNo || ""), 10);
          if (!Number.isFinite(lineNo) || lineNo <= 0) {
            continue;
          }
          normalizedFindings.push({
            path: f.path.trim(),
            lineNo,
            severity: typeof f.severity === "string" ? f.severity : "",
            label: typeof f.label === "string" ? f.label : "",
            detail: typeof f.detail === "string" ? f.detail : ""
          });
        }

        if (normalizedFindings.length > 0) {
          next.set(item.entryId.trim(), normalizedFindings);
        }
      }
    } catch {
    }

    return next;
  }

  function saveReviewFindingsForScope(scopeKey) {
    if (!scopeKey) {
      return;
    }

    try {
      const scoped = reviewFindingsByScope.get(scopeKey);
      if (!(scoped instanceof Map) || scoped.size === 0) {
        window.localStorage.removeItem(reviewFindingsStorageKey(scopeKey));
        return;
      }

      const payload = Array.from(scoped.entries()).map(([entryId, findings]) => ({
        entryId,
        findings: Array.isArray(findings) ? findings : []
      }));
      window.localStorage.setItem(reviewFindingsStorageKey(scopeKey), JSON.stringify(payload));
    } catch {
    }
  }

  function ensureReviewFindingsScopeLoaded(scopeKey) {
    if (!scopeKey) {
      return;
    }
    if (reviewFindingsByScope.has(scopeKey)) {
      return;
    }

    const loaded = loadReviewFindingsForScope(scopeKey);
    if (loaded.size > 0) {
      reviewFindingsByScope.set(scopeKey, loaded);
    }
    rebuildReviewFindingsIndex(scopeKey);
  }

  function reviewLifecycleStorageKey(scopeKey) {
    return `${STORAGE_REVIEW_LIFECYCLE_PREFIX}${scopeKey || ""}`;
  }

  function readReviewLifecycle(scopeKey) {
    if (!scopeKey) {
      return {
        requestedCount: 0,
        completedCount: 0,
        lastRequestedUtc: "",
        lastCompletedUtc: ""
      };
    }

    const existing = reviewLifecycleByScope.get(scopeKey);
    if (existing) {
      return existing;
    }

    const fallback = {
      requestedCount: 0,
      completedCount: 0,
      lastRequestedUtc: "",
      lastCompletedUtc: ""
    };
    try {
      const raw = window.localStorage.getItem(reviewLifecycleStorageKey(scopeKey));
      if (!raw) {
        reviewLifecycleByScope.set(scopeKey, fallback);
        return fallback;
      }
      const parsed = JSON.parse(raw);
      const requestedCount = Number.isFinite(parsed?.requestedCount) ? Math.max(0, Math.floor(parsed.requestedCount)) : 0;
      const completedCount = Number.isFinite(parsed?.completedCount) ? Math.max(0, Math.floor(parsed.completedCount)) : 0;
      const loaded = {
        requestedCount,
        completedCount,
        lastRequestedUtc: typeof parsed?.lastRequestedUtc === "string" ? parsed.lastRequestedUtc : "",
        lastCompletedUtc: typeof parsed?.lastCompletedUtc === "string" ? parsed.lastCompletedUtc : ""
      };
      reviewLifecycleByScope.set(scopeKey, loaded);
      return loaded;
    } catch {
      reviewLifecycleByScope.set(scopeKey, fallback);
      return fallback;
    }
  }

  function saveReviewLifecycle(scopeKey) {
    if (!scopeKey) {
      return;
    }

    const state = readReviewLifecycle(scopeKey);
    try {
      window.localStorage.setItem(reviewLifecycleStorageKey(scopeKey), JSON.stringify(state));
    } catch {
    }
  }

  function markReviewRequested(scopeKey, turnId = "") {
    if (!scopeKey) {
      return;
    }
    if (turnId && reviewRequestedTurns.has(turnId)) {
      return;
    }
    if (turnId) {
      reviewRequestedTurns.add(turnId);
    }
    const state = readReviewLifecycle(scopeKey);
    state.requestedCount += 1;
    state.lastRequestedUtc = new Date().toISOString();
    reviewLifecycleByScope.set(scopeKey, state);
    saveReviewLifecycle(scopeKey);
  }

  function markReviewCompleted(scopeKey, turnId = "") {
    if (!scopeKey) {
      return;
    }
    if (turnId && reviewCompletedTurns.has(turnId)) {
      return;
    }
    if (turnId) {
      reviewCompletedTurns.add(turnId);
    }
    const state = readReviewLifecycle(scopeKey);
    state.completedCount += 1;
    state.lastCompletedUtc = new Date().toISOString();
    reviewLifecycleByScope.set(scopeKey, state);
    saveReviewLifecycle(scopeKey);
  }

  function getReviewStatusForScope(scopeKey) {
    return getScopeReviewSummary(scopeKey).status || "not_started";
  }

  function getCurrentReviewFindingsIndex() {
    const key = currentFileViewScopeKey || currentNotesScopeKey;
    if (!key) {
      return null;
    }

    const findings = flattenReviewFindingsForScope(
      key,
      key === currentReviewStateScopeKey ? reviewFindingStateByKey : loadReviewFindingState(key)
    );
    if (!Array.isArray(findings) || findings.length === 0) {
      return null;
    }

    const index = new Map();
    for (const finding of findings) {
      if (!finding || typeof finding !== "object") {
        continue;
      }

      const references = Array.isArray(finding.references) && finding.references.length > 0
        ? finding.references
        : [{
          path: finding.path,
          lineStart: finding.lineNo,
          lineEnd: finding.lineEnd || finding.lineNo,
          label: ""
        }];

      for (const reference of references) {
        if (!reference || typeof reference.path !== "string" || !reference.path) {
          continue;
        }
        const lineStart = Number.isFinite(reference.lineStart) ? Math.floor(reference.lineStart) : 0;
        if (lineStart <= 0) {
          continue;
        }
        const lineEnd = Number.isFinite(reference.lineEnd) && reference.lineEnd >= lineStart
          ? Math.floor(reference.lineEnd)
          : lineStart;

        let byLine = index.get(reference.path);
        if (!(byLine instanceof Map)) {
          byLine = new Map();
          index.set(reference.path, byLine);
        }
        for (let lineNo = lineStart; lineNo <= lineEnd; lineNo += 1) {
          let list = byLine.get(lineNo);
          if (!Array.isArray(list)) {
            list = [];
            byLine.set(lineNo, list);
          }
          list.push(finding);
        }
      }
    }
    return index;
  }

  function getLineReviewFindings(path, lineNo) {
    if (!path || !Number.isFinite(lineNo) || lineNo <= 0) {
      return [];
    }

    const index = getCurrentReviewFindingsIndex();
    if (!(index instanceof Map)) {
      return [];
    }
    const byLine = index.get(path);
    if (!(byLine instanceof Map)) {
      return [];
    }
    const list = byLine.get(lineNo);
    return Array.isArray(list) ? list : [];
  }

  function hasLineReviewFinding(path, lineNo) {
    return getLineReviewFindings(path, lineNo).length > 0;
  }

  function getLineReviewTitle(path, lineNo) {
    const findings = getLineReviewFindings(path, lineNo);
    if (findings.length === 0) {
      return "";
    }

    const preview = findings.slice(0, 2).map((x) => {
      const prefix = x.severity ? `${x.severity.toUpperCase()}: ` : "";
      return `${prefix}${x.detail || x.label || "Review finding"}`;
    });
    if (findings.length > 2) {
      preview.push(`+${findings.length - 2} more`);
    }
    return preview.join(" | ");
  }

  function countReviewFindingsForPath(path) {
    if (!path) {
      return 0;
    }

    const index = getCurrentReviewFindingsIndex();
    if (!(index instanceof Map)) {
      return 0;
    }
    const byLine = index.get(path);
    if (!(byLine instanceof Map)) {
      return 0;
    }

    let count = 0;
    for (const list of byLine.values()) {
      if (Array.isArray(list) && list.length > 0) {
        count += list.length;
      }
    }
    return count;
  }

  function loadReviewFindingState(scopeKey) {
    const next = new Map();
    if (!scopeKey) {
      return next;
    }

    const findings = getScopeReviewFindings(scopeKey);
    for (const item of findings) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const key = typeof item.key === "string" && item.key.trim()
        ? item.key.trim()
        : makeFindingKey(item);
      if (!key) {
        continue;
      }

      const done = item.done === true;
      if (!next.has(key)) {
        next.set(key, done);
      } else if (next.get(key) === true && done !== true) {
        next.set(key, false);
      }
    }

    return next;
  }

  function saveReviewFindingState(scopeKey) {
    void scopeKey;
  }

  function ensureReviewFindingStateScope(scopeKey) {
    if (!scopeKey) {
      currentReviewStateScopeKey = "";
      reviewFindingStateByKey = new Map();
      return;
    }
    if (scopeKey === currentReviewStateScopeKey) {
      return;
    }
    currentReviewStateScopeKey = scopeKey;
    reviewFindingStateByKey = loadReviewFindingState(scopeKey);
  }

  function makeFindingKey(finding) {
    if (!finding) {
      return "";
    }

    const reference = Array.isArray(finding.references) && finding.references.length > 0
      ? finding.references[0]
      : null;
    const path = typeof finding.path === "string" && finding.path.trim()
      ? finding.path.trim()
      : (typeof reference?.path === "string" ? reference.path.trim() : "");
    const lineNo = Number.isFinite(finding.lineNo) && finding.lineNo > 0
      ? Math.floor(finding.lineNo)
      : (Number.isFinite(reference?.lineStart) && reference.lineStart > 0 ? Math.floor(reference.lineStart) : 0);
    const detail = typeof finding.detail === "string"
      ? finding.detail.replace(/\s+/g, " ").trim().toLowerCase()
      : "";
    if (!path || lineNo <= 0 || !detail) {
      return "";
    }

    return `${path}|${lineNo}|${detail}`;
  }

  function severityRank(severity) {
    const normalized = typeof severity === "string" ? severity.toLowerCase() : "";
    if (normalized === "critical") {
      return 0;
    }
    if (normalized === "high") {
      return 1;
    }
    if (normalized === "medium") {
      return 2;
    }
    if (normalized === "low") {
      return 3;
    }
    return 4;
  }

  function getScopeReviewSummary(scopeKey) {
    const provider = window.codexDiffGetReviewScopeSummary;
    if (typeof provider !== "function") {
      return {
        scopeKey,
        status: "not_started",
        reviewCount: 0,
        queuedCount: 0,
        runningCount: 0,
        requestedCount: 0,
        completedCount: 0,
        openFindingCount: 0,
        records: []
      };
    }

    try {
      const result = provider(scopeKey);
      if (result && typeof result === "object") {
        return {
          scopeKey,
          status: typeof result.status === "string" ? result.status : "not_started",
          reviewCount: Number.isFinite(result.reviewCount) ? result.reviewCount : 0,
          queuedCount: Number.isFinite(result.queuedCount) ? result.queuedCount : 0,
          runningCount: Number.isFinite(result.runningCount) ? result.runningCount : 0,
          requestedCount: Number.isFinite(result.requestedCount) ? result.requestedCount : 0,
          completedCount: Number.isFinite(result.completedCount) ? result.completedCount : 0,
          openFindingCount: Number.isFinite(result.openFindingCount) ? result.openFindingCount : 0,
          records: Array.isArray(result.records) ? result.records : []
        };
      }
    } catch {
    }

    return {
      scopeKey,
      status: "not_started",
      reviewCount: 0,
      queuedCount: 0,
      runningCount: 0,
      requestedCount: 0,
      completedCount: 0,
      openFindingCount: 0,
      records: []
    };
  }

  function getScopeReviewFindings(scopeKey) {
    const provider = window.codexDiffGetReviewFindingsForScope;
    if (typeof provider !== "function") {
      return [];
    }

    try {
      const result = provider(scopeKey);
      return Array.isArray(result) ? result : [];
    } catch {
      return [];
    }
  }

  function flattenReviewFindingsForScope(scopeKey, stateByKey = null) {
    if (!scopeKey) {
      return [];
    }

    const rawFindings = getScopeReviewFindings(scopeKey);
    if (!Array.isArray(rawFindings) || rawFindings.length === 0) {
      return [];
    }

    const effectiveStateByKey = stateByKey instanceof Map ? stateByKey : loadReviewFindingState(scopeKey);
    const dedupe = new Map();
    for (const finding of rawFindings) {
      if (!finding || typeof finding !== "object") {
        continue;
      }
      const key = typeof finding.key === "string" && finding.key.trim()
        ? finding.key.trim()
        : makeFindingKey(finding);
      if (!key || dedupe.has(key)) {
        continue;
      }

      const reviewId = typeof finding.reviewId === "string" ? finding.reviewId : "";
      const done = effectiveStateByKey.get(key) === true;
      if (dedupe.has(key)) {
        const existing = dedupe.get(key);
        if (existing) {
          if (reviewId && !existing.reviewIds.includes(reviewId)) {
            existing.reviewIds.push(reviewId);
          }
          existing.done = existing.done === true && done === true;
        }
        continue;
      }

      dedupe.set(key, {
        key,
        reviewIds: reviewId ? [reviewId] : [],
        reviewId,
        reviewLabel: typeof finding.reviewLabel === "string" ? finding.reviewLabel : "",
        path: typeof finding.path === "string" ? finding.path : "",
        lineNo: Number.isFinite(finding.lineNo) ? finding.lineNo : 0,
        lineEnd: Number.isFinite(finding.lineEnd) ? finding.lineEnd : 0,
        severity: finding.severity || "",
        detail: finding.detail || finding.label || "Review finding",
        done,
        references: Array.isArray(finding.references) && finding.references.length > 0
          ? finding.references.map((reference) => ({
            path: typeof reference?.path === "string" ? reference.path : "",
            lineStart: Number.isFinite(reference?.lineStart) ? Math.floor(reference.lineStart) : 0,
            lineEnd: Number.isFinite(reference?.lineEnd) ? Math.floor(reference.lineEnd) : 0,
            label: typeof reference?.label === "string" ? reference.label : ""
          })).filter((reference) => reference.path)
          : (typeof finding.path === "string" && finding.path && Number.isFinite(finding.lineNo) && finding.lineNo > 0
            ? [{
              path: finding.path,
              lineStart: Math.floor(finding.lineNo),
              lineEnd: Number.isFinite(finding.lineEnd) && finding.lineEnd >= finding.lineNo
                ? Math.floor(finding.lineEnd)
                : Math.floor(finding.lineNo),
              label: ""
            }]
            : [])
      });
    }

    const result = Array.from(dedupe.values());
    result.sort((a, b) => {
      if (a.done !== b.done) {
        return a.done ? 1 : -1;
      }
      const sev = severityRank(a.severity) - severityRank(b.severity);
      if (sev !== 0) {
        return sev;
      }
      const aRef = Array.isArray(a.references) && a.references.length > 0 ? a.references[0] : null;
      const bRef = Array.isArray(b.references) && b.references.length > 0 ? b.references[0] : null;
      const aPath = a.path || (aRef && typeof aRef.path === "string" ? aRef.path : "");
      const bPath = b.path || (bRef && typeof bRef.path === "string" ? bRef.path : "");
      const pathCompare = aPath.localeCompare(bPath);
      if (pathCompare !== 0) {
        return pathCompare;
      }
      const aLine = Number.isFinite(a.lineNo) && a.lineNo > 0
        ? a.lineNo
        : (aRef && Number.isFinite(aRef.lineStart) ? aRef.lineStart : 0);
      const bLine = Number.isFinite(b.lineNo) && b.lineNo > 0
        ? b.lineNo
        : (bRef && Number.isFinite(bRef.lineStart) ? bRef.lineStart : 0);
      if (aLine !== bLine) {
        return aLine - bLine;
      }
      return a.detail.localeCompare(b.detail);
    });

    return result;
  }

  function getCurrentScopeKey() {
    return currentFileViewScopeKey || currentNotesScopeKey || "";
  }

  function getEntryReviewScopeKey(entry) {
    if (!entry || typeof entry !== "object") {
      return "";
    }

    const turnId = typeof entry.turnId === "string" ? entry.turnId.trim() : "";
    if (turnId && reviewScopeByTurnId.has(turnId)) {
      const stored = reviewScopeByTurnId.get(turnId);
      return typeof stored === "string" ? stored : "";
    }

    if (pendingReviewScopeQueue.length > 0) {
      const queuedScope = pendingReviewScopeQueue[0];
      if (typeof queuedScope === "string" && queuedScope) {
        return queuedScope;
      }
    }

    const context = getActiveContext();
    if (!context || !context.cwd) {
      return "";
    }
    return buildDiffScopeKey(context.cwd, currentMode, currentMode === "commit" ? selectedCommitSha : "");
  }

  function getCurrentFlattenedReviewFindings() {
    const scopeKey = getCurrentScopeKey();
    if (!scopeKey) {
      return [];
    }

    ensureReviewFindingStateScope(scopeKey);
    return flattenReviewFindingsForScope(scopeKey, reviewFindingStateByKey);
  }

  function getOpenReviewCountForScope(scopeKey) {
    if (!scopeKey) {
      return 0;
    }

    const findings = scopeKey === currentReviewStateScopeKey
      ? flattenReviewFindingsForScope(scopeKey, reviewFindingStateByKey)
      : flattenReviewFindingsForScope(scopeKey, loadReviewFindingState(scopeKey));
    if (!Array.isArray(findings) || findings.length === 0) {
      return 0;
    }
    return findings.filter((x) => x.done !== true).length;
  }

  function getCommitScopeKey(commitSha) {
    const context = getActiveContext();
    if (!context || !context.cwd) {
      return "";
    }

    const sha = typeof commitSha === "string" ? commitSha.trim() : "";
    if (!sha) {
      return "";
    }

    return buildDiffScopeKey(context.cwd, "commit", sha);
  }

  function renderCommitModeBadge() {
    if (!Array.isArray(availableCommits) || availableCommits.length === 0) {
      modeCommitBtn.textContent = "Recent Commit";
      return;
    }

    let totalOpen = 0;
    let commitWithOpen = 0;
    for (const commit of availableCommits) {
      const normalized = normalizeCommitInfo(commit);
      if (!normalized) {
        continue;
      }
      const scopeKey = getCommitScopeKey(normalized.sha);
      if (!scopeKey) {
        continue;
      }
      const openCount = getOpenReviewCountForScope(scopeKey);
      if (openCount > 0) {
        totalOpen += openCount;
        commitWithOpen += 1;
      }
    }

    if (totalOpen > 0) {
      modeCommitBtn.textContent = `Recent Commit (${commitWithOpen}/${totalOpen} open)`;
    } else {
      let started = 0;
      let completed = 0;
      for (const commit of availableCommits) {
        const normalized = normalizeCommitInfo(commit);
        if (!normalized) {
          continue;
        }
        const scopeKey = getCommitScopeKey(normalized.sha);
        if (!scopeKey) {
          continue;
        }
        const status = getReviewStatusForScope(scopeKey);
        if (status === "started") {
          started += 1;
        } else if (status === "completed") {
          completed += 1;
        }
      }

      if (started > 0 || completed > 0) {
        modeCommitBtn.textContent = `Recent Commit (${started} started, ${completed} completed)`;
      } else {
        modeCommitBtn.textContent = "Recent Commit";
      }
    }
  }

  function setCommitReviewSummaryCollapsed(nextCollapsed) {
    commitReviewSummaryCollapsed = nextCollapsed === true;
    try {
      window.localStorage.setItem(STORAGE_COMMIT_REVIEW_COLLAPSED_KEY, commitReviewSummaryCollapsed ? "1" : "0");
    } catch {
    }
    renderCommitReviewSummary();
  }

  function setReviewPanelCollapsed(nextCollapsed) {
    reviewPanelCollapsed = nextCollapsed === true;
    try {
      window.localStorage.setItem(STORAGE_REVIEW_PANEL_COLLAPSED_KEY, reviewPanelCollapsed ? "1" : "0");
    } catch {
    }
    renderReviewFindingsPanel();
  }

  function renderCommitReviewSummary() {
    renderCommitModeBadge();
    if (!Array.isArray(availableCommits) || availableCommits.length === 0) {
      const prefix = isCodeReviewsWorkspace()
        ? "Code Reviews"
        : (currentMode === "commit" ? "Pending Reviews" : "Pending Commit Reviews");
      commitReviewSummaryNode.innerHTML = `<div class="diff-commit-review-header">
      <span class="label">${escapeHtml(prefix)}</span>
      <button type="button" class="diff-review-collapse-btn" data-commit-review-collapse="1" aria-expanded="${commitReviewSummaryCollapsed ? "false" : "true"}">${commitReviewSummaryCollapsed ? "Expand" : "Collapse"}</button>
      </div><span class="diff-commit-review-empty">No commits loaded.</span>`;
      commitReviewSummaryNode.classList.remove("hidden");
      return;
    }

    const rows = [];
    let startedCount = 0;
    let completedCount = 0;
    let openCountTotal = 0;
    for (const commit of availableCommits) {
      const normalized = normalizeCommitInfo(commit);
      if (!normalized) {
        continue;
      }

      const scopeKey = getCommitScopeKey(normalized.sha);
      if (!scopeKey) {
        continue;
      }

      const openCount = getOpenReviewCountForScope(scopeKey);
      openCountTotal += openCount;
      const status = getReviewStatusForScope(scopeKey);
      if (status === "started") {
        startedCount += 1;
      } else if (status === "completed") {
        completedCount += 1;
      }

      const shortSha = normalized.shortSha || normalized.sha.slice(0, 7);
      const subject = normalized.subject ? normalized.subject.trim() : "";
      const statusLabel = status === "reviewed"
        ? "Reviewed"
        : (status === "completed"
          ? "Review Completed"
          : (status === "started" ? "Review Started" : "Not Started"));
      const statusClass = status === "reviewed"
        ? "reviewed"
        : (status === "completed"
          ? "completed"
          : (status === "started" ? "started" : "not-started"));
      const reviewActionLabel = status === "reviewed" ? "Reviewed" : "Review";
      const reviewActionDisabled = status === "reviewed" ? " disabled" : "";
      const outcomeLabel = openCount > 0
        ? `${openCount} open`
        : (status === "reviewed"
          ? "dismissed"
          : (status === "completed" ? "clear" : (status === "started" ? "running" : "not run")));
      rows.push(
        `<div class="diff-commit-review-row${normalized.sha === selectedCommitSha ? " active" : ""}" data-commit-review-jump="${escapeAttribute(normalized.sha)}" tabindex="0" role="button" aria-label="Open review details for ${escapeAttribute(subject || normalized.sha)}">
          <div class="diff-commit-review-main">
            <div class="diff-commit-review-sha">${escapeHtml(shortSha)}</div>
            <div class="diff-commit-review-subject">${escapeHtml(subject || "(no subject)")}</div>
          </div>
          <button type="button" class="diff-commit-review-open-btn" data-commit-review-open="${escapeAttribute(normalized.sha)}">Open</button>
          <button type="button" class="diff-commit-review-action-btn" data-commit-review-request="${escapeAttribute(normalized.sha)}"${reviewActionDisabled}>${escapeHtml(reviewActionLabel)}</button>
          <span class="diff-commit-review-status ${statusClass}">${escapeHtml(statusLabel)}</span>
          <span class="diff-commit-review-open-count">${escapeHtml(outcomeLabel)}</span>
        </div>`
      );
    }

    const prefix = isCodeReviewsWorkspace()
      ? "Code Reviews"
      : (currentMode === "commit" ? "Pending Reviews" : "Pending Commit Reviews");
    const headerMeta = `${startedCount} started | ${completedCount} completed | ${openCountTotal} open findings`;
    commitReviewSummaryNode.innerHTML = `<div class="diff-commit-review-header">
      <span class="label">${escapeHtml(prefix)}</span>
      <span class="diff-commit-review-meta">${escapeHtml(headerMeta)}</span>
      <button type="button" class="diff-review-collapse-btn" data-commit-review-collapse="1" aria-expanded="${commitReviewSummaryCollapsed ? "false" : "true"}">${commitReviewSummaryCollapsed ? "Expand" : "Collapse"}</button>
    </div>
    ${commitReviewSummaryCollapsed
      ? "<div class=\"diff-commit-review-collapsed-note\">Commit review list hidden.</div>"
      : `<div class="diff-commit-review-list">${rows.join("") || "<span class=\"diff-commit-review-empty\">No commits loaded.</span>"}</div>`}`;
    commitReviewSummaryNode.classList.remove("hidden");
  }

  function renderInlineReviewMarkdown(text) {
    const source = typeof text === "string" ? text : "";
    if (!source) {
      return "";
    }
    let html = escapeHtml(source);
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label) => escapeHtml(label || ""));
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    return html;
  }

  function renderReviewMarkdownBody(markdownText) {
    const lines = typeof markdownText === "string" ? markdownText.split(/\r?\n/) : [];
    if (lines.length === 0) {
      return "";
    }

    const blocks = [];
    let findingBlocks = [];
    let findingTitle = "";
    let findingIndex = 0;

    function flushFinding() {
      if (findingBlocks.length === 0) {
        return;
      }

      blocks.push(`<section class="diff-review-md-finding" data-review-finding="1" data-review-finding-index="${findingIndex}" data-review-finding-title="${escapeAttribute(findingTitle)}">${findingBlocks.join("")}</section>`);
      findingBlocks = [];
      findingTitle = "";
      findingIndex += 1;
    }

    for (const raw of lines) {
      const line = typeof raw === "string" ? raw : "";
      const trimmed = line.trim();
      if (!trimmed) {
        if (findingBlocks.length > 0) {
          findingBlocks.push("<div class=\"diff-review-md-spacer\"></div>");
        } else {
          blocks.push("<div class=\"diff-review-md-spacer\"></div>");
        }
        continue;
      }

      if (/^#{1,6}\s+/.test(trimmed)) {
        flushFinding();
        const text = trimmed.replace(/^#{1,6}\s+/, "");
        blocks.push(`<div class="diff-review-md-heading">${renderInlineReviewMarkdown(text)}</div>`);
        continue;
      }

      if (/^\d+\.\s+/.test(trimmed)) {
        flushFinding();
        const text = trimmed.replace(/^\d+\.\s+/, "");
        findingTitle = text;
        findingBlocks.push(`<div class="diff-review-md-item ordered">${renderInlineReviewMarkdown(text)}</div>`);
        continue;
      }

      if (/^-\s+/.test(trimmed)) {
        const text = trimmed.replace(/^-\s+/, "");
        if (findingBlocks.length > 0) {
          findingBlocks.push(`<div class="diff-review-md-item bullet">${renderInlineReviewMarkdown(text)}</div>`);
        } else {
          blocks.push(`<div class="diff-review-md-item bullet">${renderInlineReviewMarkdown(text)}</div>`);
        }
        continue;
      }

      if (findingBlocks.length > 0) {
        findingBlocks.push(`<div class="diff-review-md-paragraph">${renderInlineReviewMarkdown(trimmed)}</div>`);
      } else {
        blocks.push(`<div class="diff-review-md-paragraph">${renderInlineReviewMarkdown(trimmed)}</div>`);
      }
    }

    flushFinding();
    return blocks.join("");
  }

  function getPrimaryCompletedReviewRecord(summary) {
    const records = Array.isArray(summary?.records) ? summary.records : [];
    const completed = records.filter((record) => record && (record.status === "completed" || record.status === "reviewed"));
    if (completed.length === 0) {
      return null;
    }

    completed.sort((a, b) => {
      const aTime = typeof a.completedAtUtc === "string" ? a.completedAtUtc : "";
      const bTime = typeof b.completedAtUtc === "string" ? b.completedAtUtc : "";
      return bTime.localeCompare(aTime);
    });
    return completed[0] || null;
  }

  function getFindingReferences(finding) {
    if (!finding || typeof finding !== "object") {
      return [];
    }

    if (Array.isArray(finding.references) && finding.references.length > 0) {
      return finding.references
        .map((reference) => {
          if (!reference || typeof reference.path !== "string" || !reference.path) {
            return null;
          }
          const lineStart = Number.isFinite(reference.lineStart) ? Math.floor(reference.lineStart) : 0;
          const lineEnd = Number.isFinite(reference.lineEnd) && reference.lineEnd >= lineStart
            ? Math.floor(reference.lineEnd)
            : lineStart;
          return {
            path: reference.path,
            lineStart,
            lineEnd,
            label: typeof reference.label === "string" ? reference.label : ""
          };
        })
        .filter((reference) => !!reference);
    }

    if (typeof finding.path === "string" && finding.path && Number.isFinite(finding.lineNo) && finding.lineNo > 0) {
      return [{
        path: finding.path,
        lineStart: Math.floor(finding.lineNo),
        lineEnd: Number.isFinite(finding.lineEnd) && finding.lineEnd >= finding.lineNo
          ? Math.floor(finding.lineEnd)
          : Math.floor(finding.lineNo),
        label: ""
      }];
    }

    return [];
  }

  function renderStructuredReviewFindings(record) {
    if (!record || !Array.isArray(record.findings) || record.findings.length === 0) {
      return "";
    }

    const rows = record.findings.map((finding) => {
      if (!finding || typeof finding !== "object") {
        return "";
      }
      const severity = normalizeReviewSeverity(finding.severity || "");
      const severityLabel = severity ? severity.toUpperCase() : "INFO";
      const detail = typeof finding.detail === "string" && finding.detail.trim()
        ? finding.detail.trim()
        : "Review finding";
      const references = getFindingReferences(finding);
      const referenceButtons = references.length > 0
        ? `<div class="diff-review-refs">${references.map((reference) => {
          const lineLabel = reference.lineStart > 0
            ? (reference.lineEnd > reference.lineStart ? `${reference.lineStart}-${reference.lineEnd}` : `${reference.lineStart}`)
            : "";
          const label = reference.label && reference.label.trim()
            ? reference.label.trim()
            : `${reference.path}${lineLabel ? `:${lineLabel}` : ""}`;
          return `<button type="button" class="diff-review-ref-link" data-review-jump-path="${escapeAttribute(reference.path)}"${reference.lineStart > 0 ? ` data-review-jump-line="${reference.lineStart}"` : ""}${reference.lineEnd > reference.lineStart ? ` data-review-jump-end="${reference.lineEnd}"` : ""} title="Open ${escapeAttribute(reference.path)}${lineLabel ? `:${lineLabel}` : ""}">${escapeHtml(label)}</button>`;
        }).join("")}</div>`
        : "<div class=\"diff-review-refs-empty\">No file reference extracted.</div>";

      return `<div class="diff-review-finding-row">
        <div class="diff-review-finding-header"><span class="diff-review-finding-severity">${escapeHtml(severityLabel)}</span><span class="diff-review-finding-detail">${escapeHtml(detail)}</span></div>
        ${referenceButtons}
      </div>`;
    }).filter((row) => !!row);

    if (rows.length === 0) {
      return "";
    }
    return `<div class="diff-review-structured">${rows.join("")}</div>`;
  }

  function renderReviewFindingsPanel() {
    if (isCodeReviewsWorkspace() && currentMode === "commit" && !selectedCommitSha) {
      reviewFindingsNode.classList.add("hidden");
      reviewFindingsNode.innerHTML = "";
      return;
    }

    const scopeKey = getCurrentScopeKey();
    const summary = getScopeReviewSummary(scopeKey);
    const record = getPrimaryCompletedReviewRecord(summary);
    if (!record || !record.assistantText || !record.assistantText.trim()) {
      reviewFindingsNode.classList.add("hidden");
      reviewFindingsNode.innerHTML = "";
      return;
    }

    const targetLabel = record.targetType === "commit" && typeof record.commitSha === "string" && record.commitSha
      ? `commit ${record.commitSha.slice(0, 7)}`
      : "worktree";
    const when = typeof record.completedAtUtc === "string" ? record.completedAtUtc : "";
    const statusLabel = record.status === "reviewed" ? "Reviewed" : "Review Completed";
    const bodyHtml = renderReviewMarkdownBody(record.assistantText);
    const structuredHtml = renderStructuredReviewFindings(record);
    const openCount = Number.isFinite(summary.openFindingCount) ? summary.openFindingCount : 0;
    const notesCount = notesByKey.size;

    reviewFindingsNode.innerHTML = `<div class="diff-review-header">
      <span class="diff-review-title">Review</span>
      <span class="diff-review-count">${escapeHtml(statusLabel)} | ${openCount} open | ${notesCount} notes</span>
      <button type="button" class="diff-review-collapse-btn" data-review-panel-collapse="1" aria-expanded="${reviewPanelCollapsed ? "false" : "true"}">${reviewPanelCollapsed ? "Expand" : "Collapse"}</button>
      <button type="button" class="diff-review-send-notes" data-review-send-notes="1">Send Notes To Prompt</button>
      <button type="button" class="diff-review-done-review" data-review-scope-done="1"${record.status === "reviewed" ? " disabled" : ""}>Done Review</button>
    </div>
    ${reviewPanelCollapsed
      ? "<div class=\"diff-review-collapsed-note\">Review details hidden.</div>"
      : `<div class="diff-review-output-item">
      <div class="diff-review-output-meta">${escapeHtml(targetLabel)}${when ? ` | ${escapeHtml(when)}` : ""}</div>
      ${structuredHtml}
      <div class="diff-review-md-body">${bodyHtml}</div>
    </div>`}`;
    reviewFindingsNode.classList.remove("hidden");
  }

  function deriveFullFileSnippet(target, contentOverride = null) {
    if (!target || !Number.isFinite(target.startLine) || target.startLine <= 0) {
      return "";
    }

    const content = typeof contentOverride === "string" ? contentOverride : fullFileViewerState.content;
    if (typeof content !== "string" || !content) {
      return "";
    }

    const lines = content.split(/\r?\n/);
    const snippetLines = [];
    const endLine = Number.isFinite(target.endLine) && target.endLine >= target.startLine
      ? target.endLine
      : target.startLine;
    for (let lineNo = target.startLine; lineNo <= endLine; lineNo += 1) {
      const index = lineNo - 1;
      if (index < 0 || index >= lines.length) {
        continue;
      }
      snippetLines.push(lines[index]);
    }
    return snippetLines.join("\n").trim();
  }

  function setFullFileNoteTarget(target, options = {}) {
    if (!fullFileWindowReady) {
      return;
    }

    if (!target || !target.path || !Number.isFinite(target.startLine) || target.startLine <= 0) {
      fullFileViewerState.selectedNoteTarget = null;
      fullFileViewerState.noteDraftKey = "";
      fullFileViewerState.noteDraftText = "";
      fullFileViewerState.noteDraftDirty = false;
      renderFullFileReviewPanel();
      rerenderFullFileWindowIfOpen();
      return;
    }

    const normalizedTarget = {
      path: target.path,
      startLine: Math.floor(target.startLine),
      endLine: Number.isFinite(target.endLine) && target.endLine >= target.startLine
        ? Math.floor(target.endLine)
        : Math.floor(target.startLine),
      snippet: typeof target.snippet === "string" ? target.snippet : "",
      origin: "file"
    };
    if (!normalizedTarget.snippet) {
      normalizedTarget.snippet = deriveFullFileSnippet(normalizedTarget);
    }

    fullFileViewerState.selectedNoteTarget = normalizedTarget;
    fullFileViewerState.requestedLineNo = normalizedTarget.startLine;

    const noteKey = buildNoteKey(normalizedTarget.path, normalizedTarget.startLine, normalizedTarget.endLine, "file");
    if (fullFileViewerState.noteDraftKey !== noteKey || options.resetDraft === true) {
      const existing = notesByKey.get(noteKey);
      fullFileViewerState.noteDraftKey = noteKey;
      fullFileViewerState.noteDraftText = existing && typeof existing.note === "string" ? existing.note : "";
      fullFileViewerState.noteDraftDirty = false;
    }

    renderFullFileReviewPanel();
    rerenderFullFileWindowIfOpen();

    if (options.focus === true) {
      window.setTimeout(() => {
        if (fullFileNoteTextarea) {
          fullFileNoteTextarea.focus();
          fullFileNoteTextarea.setSelectionRange(fullFileNoteTextarea.value.length, fullFileNoteTextarea.value.length);
        }
      }, 10);
    }
  }

  function setFullFileReviewContext(context) {
    if (!fullFileWindowReady) {
      return;
    }

    if (!context) {
      fullFileViewerState.reviewContext = null;
      renderFullFileReviewPanel();
      return;
    }

    fullFileViewerState.reviewContext = {
      title: typeof context.title === "string" ? context.title.trim() : "",
      html: typeof context.html === "string" ? context.html : "",
      text: typeof context.text === "string" ? context.text.trim() : "",
      path: typeof context.path === "string" ? context.path : "",
      lineNo: Number.isFinite(context.lineNo) ? Math.floor(context.lineNo) : null
    };
    renderFullFileReviewPanel();
  }

  function renderFullFileReviewPanel() {
    if (!fullFileWindowReady) {
      return;
    }

    const target = fullFileViewerState.selectedNoteTarget;
    const reviewContext = fullFileViewerState.reviewContext;
    const noteKey = target
      ? buildNoteKey(target.path, target.startLine, target.endLine, "file")
      : "";
    const existing = noteKey ? notesByKey.get(noteKey) : null;
    const noteText = noteKey && fullFileViewerState.noteDraftKey === noteKey
      ? fullFileViewerState.noteDraftText
      : (existing && typeof existing.note === "string" ? existing.note : "");

    fullFileReviewTitle.textContent = reviewContext && reviewContext.title
      ? reviewContext.title
      : "Review Context";
    fullFileReviewMeta.textContent = target
      ? `${target.path} (${noteLineLabel(target.startLine, target.endLine, "file")})`
      : "Select a review link or code line to annotate.";

    if (reviewContext && reviewContext.html) {
      fullFileReviewContext.innerHTML = `<div class="diff-full-window-review-card">${reviewContext.html}</div>`;
    } else if (reviewContext && reviewContext.text) {
      fullFileReviewContext.innerHTML = `<div class="diff-full-window-review-card"><div class="diff-review-md-paragraph">${escapeHtml(reviewContext.text)}</div></div>`;
    } else {
      fullFileReviewContext.innerHTML = "<div class=\"diff-full-window-review-empty\">Click a finding link to keep the review note visible while you inspect and annotate the code.</div>";
    }

    fullFileNoteTarget.textContent = target
      ? `${target.path} (${noteLineLabel(target.startLine, target.endLine, "file")})`
      : "No line selected.";
    fullFileNoteTextarea.value = noteText;
    fullFileNoteTextarea.disabled = !target;
    fullFileNoteSaveBtn.disabled = !target;
    fullFileNoteRemoveBtn.disabled = !target || !existing;
    fullFileNoteSendBtn.disabled = notesByKey.size === 0 && !noteText.trim();
  }

  function saveFullFilePanelNote() {
    if (!fullFileWindowReady) {
      return;
    }

    const target = fullFileViewerState.selectedNoteTarget;
    if (!target) {
      return;
    }

    const noteText = fullFileNoteTextarea.value || "";
    applyNoteToState(target.path, target.startLine, target.endLine, noteText, target.snippet || deriveFullFileSnippet(target), "file");
    saveNotesForScope(currentNotesScopeKey);
    fullFileViewerState.noteDraftKey = buildNoteKey(target.path, target.startLine, target.endLine, "file");
    fullFileViewerState.noteDraftText = (noteText || "").trim();
    fullFileViewerState.noteDraftDirty = false;
    updateSummary(currentTotalChangeCount);
    rerenderFilesPreserveView();
    rerenderFullFileWindowIfOpen();
    renderComposerNotes();
    renderFullFileReviewPanel();
  }

  function removeFullFilePanelNote() {
    if (!fullFileWindowReady) {
      return;
    }

    const target = fullFileViewerState.selectedNoteTarget;
    if (!target) {
      return;
    }

    const noteKey = buildNoteKey(target.path, target.startLine, target.endLine, "file");
    notesByKey.delete(noteKey);
    saveNotesForScope(currentNotesScopeKey);
    fullFileViewerState.noteDraftKey = noteKey;
    fullFileViewerState.noteDraftText = "";
    fullFileViewerState.noteDraftDirty = false;
    updateSummary(currentTotalChangeCount);
    rerenderFilesPreserveView();
    rerenderFullFileWindowIfOpen();
    renderComposerNotes();
    renderFullFileReviewPanel();
  }

  function sendCurrentNotesToPrompt() {
    const consumeMetadata = window.codexDiffNotesConsumePromptMetadata;
    const appendPrompt = window.codexAppendTextToPrompt;
    if (typeof consumeMetadata !== "function" || typeof appendPrompt !== "function") {
      return;
    }

    if (fullFileWindowReady && fullFileViewerState.noteDraftDirty && fullFileViewerState.selectedNoteTarget) {
      saveFullFilePanelNote();
    }

    const payload = consumeMetadata();
    const metadataText = typeof payload?.metadataText === "string" ? payload.metadataText.trim() : "";
    if (!metadataText) {
      renderFullFileReviewPanel();
      renderReviewFindingsPanel();
      renderCommitOptions();
      return;
    }

    appendPrompt(`Please implement the requested fixes from these review notes.\n\n${metadataText}`, { focus: true });
    renderFullFileReviewPanel();
    renderReviewFindingsPanel();
    renderCommitOptions();
    updateReviewActionAvailability();
  }

  function persistPendingNoteDraft() {
    if (!fullFileWindowReady) {
      return;
    }

    if (!fullFileViewerState.noteDraftDirty || !fullFileViewerState.selectedNoteTarget) {
      return;
    }

    saveFullFilePanelNote();
  }

  function extractReviewContextFromElement(element, path, lineNo) {
    if (!(element instanceof Element)) {
      return null;
    }

    const findingNode = element.closest("[data-review-finding='1']");
    if (findingNode) {
      return {
        title: findingNode.getAttribute("data-review-finding-title") || "",
        html: findingNode.innerHTML,
        text: findingNode.textContent || "",
        path,
        lineNo
      };
    }

    const blockNode = element.closest(".diff-review-md-item, .diff-review-md-paragraph, .diff-review-md-heading");
    if (blockNode) {
      return {
        title: blockNode.textContent || "",
        html: blockNode.outerHTML,
        text: blockNode.textContent || "",
        path,
        lineNo
      };
    }

    return {
      title: path && Number.isFinite(lineNo) ? `${path}:${lineNo}` : (path || "Review note"),
      html: "",
      text: element.textContent || "",
      path,
      lineNo
    };
  }

  function getEventTargetElement(event) {
    const target = event && event.target;
    if (target instanceof Element) {
      return target;
    }
    if (target && typeof target === "object" && "parentElement" in target) {
      const parent = target.parentElement;
      if (parent instanceof Element) {
        return parent;
      }
    }
    return null;
  }

  function findReviewJumpElementFromEvent(event) {
    const targetElement = getEventTargetElement(event);
    if (!targetElement) {
      return null;
    }
    return targetElement.closest("[data-review-jump-path], [data-review-md-link='1']");
  }

  function handleReviewJumpFromEvent(event) {
    const jumpBtn = findReviewJumpElementFromEvent(event);
    if (!jumpBtn) {
      return false;
    }

    const path = jumpBtn.getAttribute("data-review-jump-path") || "";
    const lineNo = Number.parseInt(jumpBtn.getAttribute("data-review-jump-line") || "", 10);
    const lineEnd = Number.parseInt(jumpBtn.getAttribute("data-review-jump-end") || "", 10);
    if (!path) {
      return true;
    }

    if (event && typeof event.preventDefault === "function") {
      event.preventDefault();
    }
    if (event && typeof event.stopPropagation === "function") {
      event.stopPropagation();
    }
    const reviewContext = extractReviewContextFromElement(jumpBtn, path, lineNo);
    openReviewLinkInFullFile(path, lineNo, lineEnd, reviewContext).catch(() => { });
    return true;
  }

  function openReviewLinkInFullFile(path, lineNo, lineEnd, reviewContext) {
    if (!path) {
      return Promise.resolve();
    }

    const resolvedPath = resolveDiffPathFromReviewReference(path);
    if (!resolvedPath) {
      return Promise.resolve();
    }

    const resolvedReviewContext = reviewContext
      ? {
        ...reviewContext,
        path: resolvedPath
      }
      : null;

    if (fullFileWindowReady && fullFileViewerState.noteDraftDirty && fullFileViewerState.selectedNoteTarget) {
      saveFullFilePanelNote();
    }

    if (fullFileWindowReady
      && !fullFileWindow.classList.contains("hidden")
      && normalizePathCaseInsensitive(fullFileViewerState.path) === normalizePathCaseInsensitive(resolvedPath)
      && typeof fullFileViewerState.content === "string"
      && fullFileViewerState.content) {
      setFullFileReviewContext(resolvedReviewContext);
      if (Number.isFinite(lineNo) && lineNo > 0) {
        const normalizedLineEnd = Number.isFinite(lineEnd) && lineEnd >= lineNo ? lineEnd : lineNo;
        setFullFileNoteTarget({
          path: resolvedPath,
          startLine: lineNo,
          endLine: normalizedLineEnd,
          snippet: "",
          origin: "file"
        }, { focus: true, resetDraft: true });
        window.setTimeout(() => {
          jumpFullFileWindowToLine(lineNo);
        }, 10);
      }
      return Promise.resolve();
    }

    return openFullFileWindow(resolvedPath, {
      lineNo,
      lineEnd: Number.isFinite(lineEnd) && lineEnd >= lineNo ? lineEnd : lineNo,
      reviewContext: resolvedReviewContext
    });
  }

  function upsertReviewFindingsForEntry(entry) {
    if (!entry || (entry.role !== "assistant" && entry.role !== "user")) {
      return;
    }

    const turnId = typeof entry.turnId === "string" ? entry.turnId.trim() : "";
    if (entry.role === "user") {
      const parsed = parseReviewRequestContextFromPromptText(entry.bodyText || "");
      if (parsed && parsed.scopeKey) {
        if (turnId) {
          reviewScopeByTurnId.set(turnId, parsed.scopeKey);
        }
        pendingReviewScopeQueue.push(parsed.scopeKey);
        markReviewRequested(parsed.scopeKey, turnId);
        renderCommitReviewSummary();
        renderCommitOptions();
      }
    }

    if (entry.role !== "assistant") {
      return;
    }

    const entryId = Number.isFinite(entry.id) ? Math.floor(entry.id) : null;
    if (!Number.isFinite(entryId) || entryId <= 0) {
      return;
    }

    const context = getActiveContext();
    if (!context || !context.cwd) {
      return;
    }

    const responseLooksLikeReview = looksLikeReviewResponseBody(entry.bodyText || "");
    const scopeKey = getEntryReviewScopeKey(entry);
    if (!scopeKey) {
      return;
    }

    const findings = extractReviewFindingsFromBodyText(entry.bodyText || "", context.cwd);
    if (responseLooksLikeReview) {
      if (!turnId && pendingReviewScopeQueue.length > 0) {
        pendingReviewScopeQueue.shift();
      }
      markReviewCompleted(scopeKey, turnId);
    }
    let scopedEntries = reviewFindingsByScope.get(scopeKey);
    if (!(scopedEntries instanceof Map)) {
      scopedEntries = new Map();
      reviewFindingsByScope.set(scopeKey, scopedEntries);
    }
    const entryKey = String(entryId);
    const hadExisting = scopedEntries.has(entryKey);
    if (findings.length === 0 && !hadExisting) {
      return;
    }
    if (findings.length === 0) {
      scopedEntries.delete(entryKey);
    } else {
      scopedEntries.set(entryKey, findings);
    }
    if (scopedEntries.size === 0) {
      reviewFindingsByScope.delete(scopeKey);
    }
    rebuildReviewFindingsIndex(scopeKey);
    saveReviewFindingsForScope(scopeKey);

    if (scopeKey === currentFileViewScopeKey || scopeKey === currentNotesScopeKey) {
      rerenderFilesPreserveView();
      rerenderFullFileWindowIfOpen();
    }
    renderCommitReviewSummary();
    renderCommitOptions();
  }

  function removeReviewFindingsForEntry(entry) {
    if (!entry) {
      return;
    }

    const entryId = Number.isFinite(entry.id) ? Math.floor(entry.id) : null;
    if (!Number.isFinite(entryId) || entryId <= 0) {
      return;
    }

    const turnId = typeof entry.turnId === "string" ? entry.turnId.trim() : "";
    if (turnId && reviewScopeByTurnId.has(turnId)) {
      reviewScopeByTurnId.delete(turnId);
    }

    for (const [scopeKey, scopedEntries] of reviewFindingsByScope.entries()) {
      if (!(scopedEntries instanceof Map)) {
        continue;
      }
      if (!scopedEntries.has(String(entryId))) {
        continue;
      }
      scopedEntries.delete(String(entryId));
      if (scopedEntries.size === 0) {
        reviewFindingsByScope.delete(scopeKey);
      }
      rebuildReviewFindingsIndex(scopeKey);
      saveReviewFindingsForScope(scopeKey);
    }

    rerenderFilesPreserveView();
    rerenderFullFileWindowIfOpen();
    renderCommitReviewSummary();
    renderCommitOptions();
  }

  function normalizeContextMode(value) {
    const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (CONTEXT_MODE_VALUES.has(candidate)) {
      return candidate;
    }

    return "3";
  }

  function contextLinesForMode(mode) {
    const normalized = normalizeContextMode(mode);
    if (normalized === "10") {
      return 10;
    }
    if (normalized === "30") {
      return 30;
    }
    if (normalized === "full") {
      return 200000;
    }

    return 3;
  }

  function contextModeLabel(mode) {
    const normalized = normalizeContextMode(mode);
    if (normalized === "10") {
      return "+10";
    }
    if (normalized === "30") {
      return "+30";
    }
    if (normalized === "full") {
      return "full";
    }

    return "+3";
  }

  function notesStorageKey(scopeKey) {
    return `${STORAGE_NOTES_PREFIX}${scopeKey || ""}`;
  }

  function normalizeNoteOrigin(origin) {
    return origin === "file" ? "file" : "diff";
  }

  function buildNoteKey(path, startLine, endLine, origin = "diff") {
    return `${normalizeNoteOrigin(origin)}::${path}::${startLine}-${endLine}`;
  }

  function noteLineLabel(startLine, endLine, origin = "diff") {
    const prefix = normalizeNoteOrigin(origin) === "file" ? "file line " : "diff line ";
    return formatLineSpan(startLine, endLine).replace("L", prefix);
  }

  function normalizeNoteFromStorage(item) {
    if (!item || typeof item.path !== "string" || !item.path.trim()) {
      return null;
    }

    let startLine = Number.isFinite(item.startLine) ? item.startLine : Number.parseInt(String(item.startLine || ""), 10);
    let endLine = Number.isFinite(item.endLine) ? item.endLine : Number.parseInt(String(item.endLine || ""), 10);

    // Backward compatibility with prior single-line notes.
    if (!Number.isFinite(startLine) && Number.isFinite(item.lineNo)) {
      startLine = Number.parseInt(String(item.lineNo), 10);
    }
    if (!Number.isFinite(endLine) && Number.isFinite(item.lineNo)) {
      endLine = Number.parseInt(String(item.lineNo), 10);
    }

    if (!Number.isFinite(startLine) || startLine <= 0) {
      return null;
    }
    if (!Number.isFinite(endLine) || endLine <= 0) {
      endLine = startLine;
    }

    const fixedStart = Math.min(startLine, endLine);
    const fixedEnd = Math.max(startLine, endLine);
    const note = typeof item.note === "string" ? item.note.trim() : "";
    if (!note) {
      return null;
    }

    return {
      path: item.path,
      startLine: fixedStart,
      endLine: fixedEnd,
      note,
      snippet: typeof item.snippet === "string" ? item.snippet : "",
      origin: normalizeNoteOrigin(typeof item.origin === "string" ? item.origin : "diff")
    };
  }

  function loadNotesForScope(scopeKey) {
    const next = new Map();
    if (!scopeKey) {
      return next;
    }

    try {
      const raw = window.localStorage.getItem(notesStorageKey(scopeKey));
      if (!raw) {
        return next;
      }

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return next;
      }

      for (const item of parsed) {
        const normalized = normalizeNoteFromStorage(item);
        if (!normalized) {
          continue;
        }

        next.set(
          buildNoteKey(normalized.path, normalized.startLine, normalized.endLine, normalized.origin),
          normalized
        );
      }
    } catch {
    }

    return next;
  }

  function saveNotesForScope(scopeKey) {
    if (!scopeKey) {
      return;
    }

    try {
      const payload = Array.from(notesByKey.values()).map((x) => ({
        path: x.path,
        startLine: x.startLine,
        endLine: x.endLine,
        note: x.note,
        snippet: x.snippet || "",
        origin: normalizeNoteOrigin(x.origin)
      }));
      window.localStorage.setItem(notesStorageKey(scopeKey), JSON.stringify(payload));
    } catch {
    }
  }

  function switchNotesScope(scopeKey) {
    if (scopeKey === currentNotesScopeKey) {
      return false;
    }

    currentNotesScopeKey = scopeKey;
    notesByKey = loadNotesForScope(scopeKey);
    return true;
  }

  function captureFileOpenState() {
    const details = listNode.querySelectorAll("details[data-diff-path]");
    for (const node of details) {
      const path = node.getAttribute("data-diff-path") || "";
      if (!path) {
        continue;
      }
      fileOpenStateByPath.set(path, node.open === true);
    }
  }

  function restoreListScroll(scrollTop) {
    try {
      listNode.scrollTop = scrollTop;
    } catch {
    }
  }

  function rerenderFilesPreserveView() {
    const priorScrollTop = listNode.scrollTop;
    captureFileOpenState();
    renderFiles(currentFiles);
    restoreListScroll(priorScrollTop);
  }

  function applyModeUiState() {
    const isCommitMode = currentMode === "commit";
    modeWorktreeBtn.classList.toggle("active", !isCommitMode);
    modeCommitBtn.classList.toggle("active", isCommitMode);
    modeWorktreeBtn.setAttribute("aria-pressed", !isCommitMode ? "true" : "false");
    modeCommitBtn.setAttribute("aria-pressed", isCommitMode ? "true" : "false");
    commitSelect.classList.add("hidden");
    modeWorktreeBtn.classList.toggle("hidden", isCodeReviewsWorkspace());
    contextSelect.value = normalizeContextMode(currentContextMode);
    renderCommitModeBadge();
    renderCommitReviewSummary();
  }

  function getActiveCommitLabel() {
    if (!selectedCommitInfo) {
      return selectedCommitSha ? selectedCommitSha.slice(0, 12) : "commit";
    }

    const shortSha = selectedCommitInfo.shortSha || (selectedCommitInfo.sha || "").slice(0, 12);
    const subject = typeof selectedCommitInfo.subject === "string" ? selectedCommitInfo.subject.trim() : "";
    return subject ? `${shortSha} ${subject}` : shortSha || "commit";
  }

  function applyPanelState() {
    const dedicatedWorkspace = workspaceMode === "code_reviews";
    const showPanel = dedicatedWorkspace ? true : isExpanded;
    panel.classList.toggle("hidden", !showPanel);
    panel.classList.toggle("worktree-diff-collapsed", false);
    panel.classList.toggle("worktree-diff-fullscreen", dedicatedWorkspace ? false : isExpanded);
    panel.classList.toggle("worktree-diff-dedicated-workspace", dedicatedWorkspace);
    toggleBtn.textContent = dedicatedWorkspace && reviewPageMode === "detail" ? "Back" : "Close";
    toggleBtn.setAttribute("aria-expanded", showPanel ? "true" : "false");
    toggleBtn.disabled = false;
    toggleBtn.classList.toggle("hidden", dedicatedWorkspace ? reviewPageMode !== "detail" : false);
    indicatorBtn.classList.toggle("hidden", dedicatedWorkspace ? true : false);
    panel.classList.toggle("worktree-diff-review-index", dedicatedWorkspace && reviewPageMode !== "detail");
    panel.classList.toggle("worktree-diff-review-detail", dedicatedWorkspace && reviewPageMode === "detail");
    if (bodyNode) {
      bodyNode.classList.toggle("code-reviews-page-list", dedicatedWorkspace && reviewPageMode !== "detail");
      bodyNode.classList.toggle("code-reviews-page-detail", dedicatedWorkspace && reviewPageMode === "detail");
    }
    indicatorCountNode.textContent = String(currentFiles.length);
    const fileLabel = `${currentFiles.length} file${currentFiles.length === 1 ? "" : "s"}`;
    if (!lastCwd) {
      indicatorBtn.setAttribute("aria-label", "Open repository diff (no active session)");
    } else if (currentMode === "commit") {
      indicatorBtn.setAttribute("aria-label", `Open recent commit diff (${fileLabel} in ${getActiveCommitLabel()})`);
    } else {
      indicatorBtn.setAttribute("aria-label", `Open working tree diff (${fileLabel})`);
    }
    indicatorBtn.title = indicatorBtn.getAttribute("aria-label") || "Open repository diff";
    applyModeUiState();
    updateReviewActionAvailability();
  }

  function canSubmitReviewRequest() {
    const context = getActiveContext();
    if (!context || !context.cwd) {
      return false;
    }

    if (panelAvailable !== true) {
      return false;
    }

    if (currentMode === "commit" && !selectedCommitSha) {
      return false;
    }

    return true;
  }

  function updateReviewActionAvailability() {
    const enabled = canSubmitReviewRequest();
    const hasPendingNotes = notesByKey.size > 0 || (fullFileWindowReady && fullFileViewerState.noteDraftDirty === true);
    sendNotesBtn.disabled = !hasPendingNotes;
    if (hasPendingNotes) {
      const noteCount = notesByKey.size + (fullFileWindowReady && fullFileViewerState.noteDraftDirty ? 1 : 0);
      sendNotesBtn.textContent = `Send Notes${noteCount > 0 ? ` (${noteCount})` : ""}`;
    } else {
      sendNotesBtn.textContent = "Send Notes";
    }
    queueReviewBtn.disabled = !enabled;
    runReviewBtn.disabled = !enabled;
    if (!enabled) {
      setReviewQueuedBadgeActive(false);
    }
  }

  function selectCommitForDetails(sha) {
    const normalizedSha = typeof sha === "string" ? sha.trim() : "";
    if (!normalizedSha) {
      return;
    }

    if (!availableCommits.some((x) => x && typeof x.sha === "string" && x.sha === normalizedSha)) {
      return;
    }

    if (normalizedSha === selectedCommitSha && currentFiles.length > 0) {
      return;
    }

    selectedCommitSha = normalizedSha;
    selectedCommitInfo = findSelectedCommitInfo();
    lastRenderKey = "";
    refreshBtn.disabled = true;
    commitSelect.disabled = true;
    closeFullFileWindow();
    showLoadingState(`Loading ${getActiveCommitLabel()}...`);
    queueRefresh({ force: true });
  }

  function clearCommitSelection(options = {}) {
    selectedCommitSha = "";
    selectedCommitInfo = null;
    currentFiles = [];
    currentTotalChangeCount = 0;
    hiddenBinaryFileCount = 0;
    hasVisibleChanges = false;
    if (options.keepListMarkup !== true) {
      listNode.innerHTML = "<div class=\"worktree-diff-empty\">Select a commit to view diffs, findings, and add notes.</div>";
    }
    renderReviewFindingsPanel();
    applyPanelState();
  }

  function setReviewQueuedBadgeActive(isActive) {
    queueReviewBtn.classList.toggle("review-queued", isActive === true);
    if (isActive !== true && reviewQueuedBadgeTimer) {
      window.clearTimeout(reviewQueuedBadgeTimer);
      reviewQueuedBadgeTimer = null;
    }
  }

  function normalizeReviewNoteText(rawValue) {
    const raw = typeof rawValue === "string" ? rawValue.trim() : "";
    if (!raw) {
      return "";
    }

    return raw.length > MAX_REVIEW_NOTE_CHARS ? raw.slice(0, MAX_REVIEW_NOTE_CHARS) : raw;
  }

  function buildReviewTargetLabel() {
    if (currentMode === "commit") {
      const commitSha = typeof selectedCommitSha === "string" ? selectedCommitSha.trim() : "";
      const commitSubject = typeof selectedCommitInfo?.subject === "string" ? selectedCommitInfo.subject.trim() : "";
      return commitSha ? `Commit ${commitSha}${commitSubject ? ` - ${commitSubject}` : ""}` : "Commit";
    }

    return "Uncommitted Working Tree";
  }

  function getCurrentReviewTargetScopeKey() {
    const context = getActiveContext();
    if (!context || !context.cwd) {
      return "";
    }
    if (currentMode === "commit") {
      const commitSha = typeof selectedCommitSha === "string" ? selectedCommitSha.trim() : "";
      if (!commitSha) {
        return "";
      }
      return buildDiffScopeKey(context.cwd, "commit", commitSha);
    }
    return buildDiffScopeKey(context.cwd, "worktree", "");
  }

  function findCommitInfoBySha(sha) {
    const normalizedSha = typeof sha === "string" ? sha.trim() : "";
    if (!normalizedSha || !Array.isArray(availableCommits)) {
      return null;
    }

    for (const commit of availableCommits) {
      const normalized = normalizeCommitInfo(commit);
      if (!normalized) {
        continue;
      }
      if (normalized.sha === normalizedSha) {
        return normalized;
      }
    }

    return null;
  }

  async function buildReviewRequestPayload(noteTextRaw, options = {}) {
    const noteText = normalizeReviewNoteText(noteTextRaw);
    const contextLabel = contextModeLabel(currentContextMode);
    const targetTypeOverride = options && options.targetType === "worktree" ? "worktree" : (options && options.targetType === "commit" ? "commit" : "");
    const targetType = targetTypeOverride || (currentMode === "commit" ? "commit" : "worktree");
    const commitSha = targetType === "commit"
      ? (typeof options?.commitSha === "string" && options.commitSha.trim() ? options.commitSha.trim() : (selectedCommitSha || ""))
      : "";
    const commitInfo = targetType === "commit" ? (findCommitInfoBySha(commitSha) || selectedCommitInfo || null) : null;
    const commitSubject = targetType === "commit"
      ? (typeof options?.commitSubject === "string" && options.commitSubject.trim()
        ? options.commitSubject.trim()
        : (typeof commitInfo?.subject === "string" ? commitInfo.subject : ""))
      : "";
    const visibleCount = Number.isFinite(options?.visibleFiles)
      ? Math.max(0, Math.floor(options.visibleFiles))
      : (Number.isFinite(currentFiles.length) ? currentFiles.length : 0);
    const totalCount = Number.isFinite(options?.totalFiles)
      ? Math.max(0, Math.floor(options.totalFiles))
      : (Number.isFinite(currentTotalChangeCount) ? currentTotalChangeCount : visibleCount);
    const hiddenBinaryCount = Number.isFinite(options?.hiddenBinaryFiles)
      ? Math.max(0, Math.floor(options.hiddenBinaryFiles))
      : (Number.isFinite(hiddenBinaryFileCount) ? hiddenBinaryFileCount : 0);
    const context = getActiveContext();
    const builder = window.codexDiffCreateReviewRequest;
    if (!context || !context.cwd || typeof builder !== "function") {
      return null;
    }

    if (targetType === "commit" && !commitSha) {
      return null;
    }

    const request = await builder({
      sessionId: context.sessionId || "",
      threadId: context.threadId || "",
      cwd: context.cwd,
      targetType,
      commitSha,
      commitSubject,
      contextLabel,
      visibleFiles: visibleCount,
      totalFiles: totalCount,
      hiddenBinaryFiles: hiddenBinaryCount,
      noteText,
      initialStatus: "queued"
    });
    return request && typeof request === "object" ? request : null;
  }

  async function queueReviewFromDiffPanel(noteTextRaw) {
    if (!canSubmitReviewRequest()) {
      return;
    }

    const reviewRequest = await buildReviewRequestPayload(noteTextRaw);
    if (!reviewRequest || !reviewRequest.promptText) {
      return;
    }

    const queueReview = window.codexDiffQueueReviewPrompt;
    if (typeof queueReview !== "function") {
      if (typeof console !== "undefined" && typeof console.warn === "function") {
        console.warn(`${new Date().toISOString()} review.queue_bridge_unavailable`);
      }
      return;
    }

    try {
      const ok = await queueReview(reviewRequest.promptText, { logSuccess: true, reviewRequest });
      if (ok === true) {
        renderCommitReviewSummary();
        renderCommitOptions();
        setReviewQueuedBadgeActive(true);
        if (reviewQueuedBadgeTimer) {
          window.clearTimeout(reviewQueuedBadgeTimer);
        }
        reviewQueuedBadgeTimer = window.setTimeout(() => {
          reviewQueuedBadgeTimer = null;
          setReviewQueuedBadgeActive(false);
        }, 900);
      }
    } catch {
    }
  }

  async function runReviewFromDiffPanel(noteTextRaw) {
    if (!canSubmitReviewRequest()) {
      return;
    }

    const reviewRequest = await buildReviewRequestPayload(noteTextRaw);
    if (!reviewRequest || !reviewRequest.promptText) {
      return;
    }

    const runReview = window.codexDiffRunReviewPrompt;
    if (typeof runReview !== "function") {
      if (typeof console !== "undefined" && typeof console.warn === "function") {
        console.warn(`${new Date().toISOString()} review.run_bridge_unavailable`);
      }
      return;
    }

    const ok = await runReview(reviewRequest.promptText, { logSuccess: true, reviewRequest });
    if (ok === true) {
      renderCommitReviewSummary();
      renderCommitOptions();
    }
  }

  async function runCommitReviewRequest(sha) {
    const normalizedSha = typeof sha === "string" ? sha.trim() : "";
    if (!normalizedSha) {
      return;
    }

    const reviewRequest = await buildReviewRequestPayload("", {
      targetType: "commit",
      commitSha: normalizedSha,
      visibleFiles: 0,
      totalFiles: 0,
      hiddenBinaryFiles: 0
    });
    if (!reviewRequest || !reviewRequest.promptText) {
      return;
    }

    const runReview = window.codexDiffRunReviewPrompt;
    if (typeof runReview !== "function") {
      return;
    }

    const ok = await runReview(reviewRequest.promptText, { logSuccess: true, reviewRequest });
    if (ok === true) {
      renderCommitReviewSummary();
      renderCommitOptions();
      setReviewQueuedBadgeActive(true);
      if (reviewQueuedBadgeTimer) {
        window.clearTimeout(reviewQueuedBadgeTimer);
      }
      reviewQueuedBadgeTimer = window.setTimeout(() => {
        reviewQueuedBadgeTimer = null;
        setReviewQueuedBadgeActive(false);
      }, 900);
    }
  }

  function openReviewModal() {
    if (!canSubmitReviewRequest()) {
      return;
    }

    if (!reviewModalReady) {
      runReviewFromDiffPanel(reviewDraftText).catch(() => { });
      return;
    }

    const contextLabel = contextModeLabel(currentContextMode);
    const visibleCount = Number.isFinite(currentFiles.length) ? currentFiles.length : 0;
    const totalCount = Number.isFinite(currentTotalChangeCount) ? currentTotalChangeCount : visibleCount;
    const hiddenBinaryCount = Number.isFinite(hiddenBinaryFileCount) ? hiddenBinaryFileCount : 0;
    const targetLabel = buildReviewTargetLabel();
    reviewModalTarget.textContent = `${targetLabel} | ${totalCount} files (${visibleCount} visible, ${hiddenBinaryCount} binary hidden) | context ${contextLabel}`;
    reviewModalTextarea.value = reviewDraftText;
    reviewModal.classList.remove("hidden");
    reviewModalTextarea.focus();
    reviewModalTextarea.setSelectionRange(reviewModalTextarea.value.length, reviewModalTextarea.value.length);
  }

  function closeReviewModal(options = {}) {
    if (!reviewModalReady) {
      return;
    }

    if (options.keepDraft === true) {
      reviewDraftText = normalizeReviewNoteText(reviewModalTextarea.value || "");
    } else {
      reviewDraftText = "";
    }

    reviewModal.classList.add("hidden");
  }

  async function submitReviewFromModal() {
    if (!reviewModalReady) {
      return;
    }

    reviewDraftText = normalizeReviewNoteText(reviewModalTextarea.value || "");
    await runReviewFromDiffPanel(reviewDraftText);
    closeReviewModal({ keepDraft: false });
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/"/g, "&quot;");
  }

  function formatLineSpan(startLine, endLine) {
    return startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`;
  }

  function formatCommitTime(isoText) {
    if (typeof isoText !== "string" || !isoText.trim()) {
      return "";
    }

    const stamp = new Date(isoText);
    if (Number.isNaN(stamp.getTime())) {
      return "";
    }

    return stamp.toLocaleString(undefined, {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function normalizeCommitInfo(commit) {
    if (!commit || typeof commit !== "object") {
      return null;
    }

    const sha = typeof commit.sha === "string" ? commit.sha.trim() : "";
    if (!sha) {
      return null;
    }

    const shortShaRaw = typeof commit.shortSha === "string" ? commit.shortSha.trim() : "";
    return {
      sha,
      shortSha: shortShaRaw || sha.slice(0, 12),
      subject: typeof commit.subject === "string" ? commit.subject.trim() : "",
      authorName: typeof commit.authorName === "string" ? commit.authorName.trim() : "",
      committedAtUtc: typeof commit.committedAtUtc === "string" ? commit.committedAtUtc : ""
    };
  }

  function renderCommitOptions() {
    if (currentMode !== "commit") {
      commitSelect.innerHTML = "";
      commitSelect.disabled = true;
      renderCommitReviewSummary();
      return;
    }

    if (!Array.isArray(availableCommits) || availableCommits.length === 0) {
      commitSelect.innerHTML = "<option value=\"\">No recent commits</option>";
      commitSelect.disabled = true;
      renderCommitReviewSummary();
      return;
    }

    const options = [];
    for (const commit of availableCommits) {
      const normalized = normalizeCommitInfo(commit);
      if (!normalized) {
        continue;
      }

      const when = formatCommitTime(normalized.committedAtUtc);
      const subject = normalized.subject || "(no subject)";
      const author = normalized.authorName || "unknown";
      const scopeKey = getCommitScopeKey(normalized.sha);
      const openCount = scopeKey ? getOpenReviewCountForScope(scopeKey) : 0;
      const pendingSuffix = openCount > 0 ? ` [${openCount} open]` : "";
      const label = `${normalized.shortSha} ${subject}${pendingSuffix}`;
      const title = when
        ? `${normalized.sha} | ${author} | ${when}`
        : `${normalized.sha} | ${author}`;
      options.push(`<option value="${escapeAttribute(normalized.sha)}" title="${escapeAttribute(title)}">${escapeHtml(label)}</option>`);
    }

    if (options.length === 0) {
      commitSelect.innerHTML = "<option value=\"\">No recent commits</option>";
      commitSelect.disabled = true;
      renderCommitReviewSummary();
      return;
    }

    commitSelect.innerHTML = options.join("");
    if (isCodeReviewsWorkspace() && !selectedCommitSha) {
      commitSelect.value = "";
      commitSelect.disabled = pollInFlight !== false;
      renderCommitReviewSummary();
      return;
    }

    if (!selectedCommitSha || !availableCommits.some((x) => (x && typeof x.sha === "string" && x.sha === selectedCommitSha))) {
      selectedCommitSha = availableCommits[0].sha;
    }

    commitSelect.value = selectedCommitSha;
    commitSelect.disabled = pollInFlight !== false;
    renderCommitReviewSummary();
  }

  function setDiffMode(mode) {
    const nextMode = mode === "commit" ? "commit" : "worktree";
    if (isCodeReviewsWorkspace() && nextMode !== "commit") {
      return;
    }
    if (currentMode === nextMode) {
      return;
    }

    persistPendingNoteDraft();
    currentMode = nextMode;
    lastRenderKey = "";
    if (currentMode === "worktree") {
      selectedCommitInfo = null;
    }
    applyModeUiState();
    queueRefresh({ force: true });
  }

  function renderComposerNotes() {
    const notes = Array.from(notesByKey.values())
      .sort((a, b) => {
        const pathCompare = a.path.localeCompare(b.path);
        if (pathCompare !== 0) {
          return pathCompare;
        }
        if (a.startLine !== b.startLine) {
          return a.startLine - b.startLine;
        }
        return a.endLine - b.endLine;
      });

    if (notes.length === 0) {
      composerNotesNode.classList.add("hidden");
      composerNotesNode.innerHTML = "";
      updateReviewActionAvailability();
      return;
    }

    const pills = notes.map((note) => {
      const origin = normalizeNoteOrigin(note.origin);
      const key = buildNoteKey(note.path, note.startLine, note.endLine, origin);
      const prefix = origin === "file" ? "File" : "Diff";
      const lineText = noteLineLabel(note.startLine, note.endLine, origin);
      const text = `[${prefix}] ${lineText} ${note.path}: ${note.note}`;
      return `<span class="diff-notes-composer-pill" title="${escapeAttribute(text)}">
        <span class="diff-notes-composer-pill-text">${escapeHtml(text)}</span>
        <button type="button" class="diff-notes-composer-pill-remove" data-diff-note-remove="${escapeAttribute(key)}" aria-label="Remove note">&times;</button>
      </span>`;
    }).join("");

    composerNotesNode.innerHTML = `<span class="diff-notes-composer-label">Code notes (${notes.length})</span>${pills}<button type="button" class="diff-notes-composer-clear" data-diff-note-clear="1">Clear</button>`;
    composerNotesNode.classList.remove("hidden");
    updateReviewActionAvailability();
  }

  function setEmptyState(message) {
    hasVisibleChanges = false;
    currentFiles = [];
    currentTotalChangeCount = 0;
    hiddenBinaryFileCount = 0;
    summaryNode.textContent = message;
    listNode.innerHTML = `<div class="worktree-diff-empty">${escapeHtml(message)}</div>`;
    renderReviewFindingsPanel();
    applyPanelState();
    renderComposerNotes();
  }

  function showLoadingState(message) {
    hasVisibleChanges = false;
    currentFiles = [];
    currentTotalChangeCount = 0;
    hiddenBinaryFileCount = 0;
    summaryNode.textContent = message;
    listNode.innerHTML = `<div class="worktree-diff-loading" role="status" aria-live="polite"><span class="worktree-diff-loading-spinner" aria-hidden="true"></span><span class="worktree-diff-loading-text">${escapeHtml(message)}</span></div>`;
    renderReviewFindingsPanel();
    applyPanelState();
  }

  function updateSummary(changeCount) {
    const notesCount = notesByKey.size;
    const branch = currentBranch || "detached";
    const contextLabel = contextModeLabel(currentContextMode);
    const hiddenBinaryText = hiddenBinaryFileCount > 0 ? ` | ${hiddenBinaryFileCount} binary hidden` : "";
    let pendingCommitReviews = 0;
    if (Array.isArray(availableCommits) && availableCommits.length > 0) {
      for (const commit of availableCommits) {
        const normalized = normalizeCommitInfo(commit);
        if (!normalized) {
          continue;
        }
        const scopeKey = getCommitScopeKey(normalized.sha);
        if (!scopeKey) {
          continue;
        }
        if (getOpenReviewCountForScope(scopeKey) > 0) {
          pendingCommitReviews += 1;
        }
      }
    }
    const pendingReviewText = pendingCommitReviews > 0
      ? ` | ${pendingCommitReviews} commit review${pendingCommitReviews === 1 ? "" : "s"} open`
      : "";
    if (currentMode === "commit") {
      if (isCodeReviewsWorkspace() && !selectedCommitSha) {
        const commitCount = Array.isArray(availableCommits) ? availableCommits.length : 0;
        summaryNode.textContent = `${commitCount} recent commit${commitCount === 1 ? "" : "s"} on ${branch} | context ${contextLabel}${notesCount > 0 ? ` | ${notesCount} note(s) queued` : ""}${pendingReviewText}`;
        return;
      }
      const commitLabel = getActiveCommitLabel();
      summaryNode.textContent = `${changeCount} file change(s) in ${commitLabel} | context ${contextLabel}${hiddenBinaryText}${notesCount > 0 ? ` | ${notesCount} note(s) queued` : ""}${pendingReviewText}`;
      return;
    }

    summaryNode.textContent = `${changeCount} file change(s) in working tree on ${branch} | context ${contextLabel}${hiddenBinaryText}${notesCount > 0 ? ` | ${notesCount} note(s) queued` : ""}${pendingReviewText}`;
  }

  function filterVisibleFiles(files) {
    const all = Array.isArray(files) ? files : [];
    const visible = [];
    let hiddenBinary = 0;
    for (const file of all) {
      if (!file || typeof file !== "object") {
        continue;
      }

      if (file.isBinary === true) {
        hiddenBinary += 1;
        continue;
      }

      visible.push(file);
    }

    return {
      visible,
      hiddenBinary
    };
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function classForDiffLine(line) {
    if (!line) {
      return "";
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      return "watcher-diff-add";
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      return "watcher-diff-remove";
    }
    if (line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) {
      return "watcher-diff-header";
    }
    return "";
  }

  function getFileDiffStat(file) {
    if (!file) {
      return { added: 0, removed: 0 };
    }

    const patchText = typeof file.patch === "string" ? file.patch : "";
    if (!patchText) {
      return { added: 0, removed: 0 };
    }

    let added = 0;
    let removed = 0;
    const lines = patchText.split(/\r?\n/);
    for (const line of lines) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        added += 1;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        removed += 1;
      }
    }

    return { added, removed };
  }

  function stripDiffPrefix(line) {
    if (typeof line !== "string" || line.length === 0) {
      return "";
    }
    if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
      return line.slice(1);
    }
    return line;
  }

  function extractClassName(line) {
    const normalized = stripDiffPrefix(line).trim();
    if (!normalized) {
      return "";
    }

    const match = normalized.match(/\b(class|struct|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
    return match ? match[2] : "";
  }

  function extractMethodName(line) {
    const normalized = stripDiffPrefix(line).trim();
    if (!normalized) {
      return "";
    }

    const methodMatch = normalized.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (!methodMatch) {
      return "";
    }

    const name = methodMatch[1] || "";
    if (!name) {
      return "";
    }

    const disallowed = new Set(["if", "for", "while", "switch", "catch", "foreach", "using", "return", "new", "lock"]);
    return disallowed.has(name) ? "" : name;
  }

  function parseHunkNewStart(line) {
    if (typeof line !== "string" || !line.startsWith("@@")) {
      return null;
    }

    const match = line.match(/^@@\s*-[^ ]+\s+\+(\d+)(?:,\d+)?\s*@@/);
    if (!match) {
      return null;
    }

    const parsed = Number.parseInt(match[1] || "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  function collectChangedLinesFromPatch(patchText) {
    const changed = new Set();
    if (typeof patchText !== "string" || !patchText) {
      return { changed, first: 1 };
    }

    const lines = patchText.split(/\r?\n/);
    let currentNewLine = 0;
    let inHunk = false;
    for (const line of lines) {
      if (line.startsWith("@@")) {
        inHunk = true;
        currentNewLine = parseHunkNewStart(line) || currentNewLine || 1;
        continue;
      }

      if (!inHunk) {
        continue;
      }

      if (line.startsWith("+") && !line.startsWith("+++")) {
        changed.add(currentNewLine);
        currentNewLine += 1;
        continue;
      }

      if (line.startsWith("-") && !line.startsWith("---")) {
        changed.add(Math.max(currentNewLine, 1));
        continue;
      }

      if (line.startsWith(" ") || line === "") {
        currentNewLine += 1;
      }
    }

    const ordered = Array.from(changed.values()).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
    return {
      changed,
      first: ordered.length > 0 ? ordered[0] : 1
    };
  }

  function extractSymbolsFromContent(content) {
    const classes = [];
    const methods = [];
    const classSeen = new Set();
    const methodSeen = new Set();
    const disallowed = new Set(["if", "for", "while", "switch", "catch", "foreach", "using", "return", "new", "lock"]);
    const lines = typeof content === "string" ? content.split(/\r?\n/) : [];
    let currentClass = "";
    for (let i = 0; i < lines.length; i += 1) {
      const lineNo = i + 1;
      const line = lines[i] || "";
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const className = extractClassName(trimmed);
      if (className) {
        currentClass = className;
        if (!classSeen.has(className)) {
          classSeen.add(className);
          classes.push({ name: className, lineNo });
        }
      }

      const methodName = extractMethodName(trimmed);
      if (!methodName || disallowed.has(methodName)) {
        continue;
      }

      const looksDeclaration = /\(/.test(trimmed) && (/\)\s*(\{|=>|;)/.test(trimmed) || /\)\s*$/.test(trimmed));
      if (!looksDeclaration) {
        continue;
      }

      const owner = currentClass || "";
      const methodKey = `${owner}|${methodName}`;
      if (methodSeen.has(methodKey)) {
        continue;
      }

      methodSeen.add(methodKey);
      methods.push({
        key: `${lineNo}:${methodName}`,
        name: methodName,
        className: owner,
        lineNo
      });
    }

    return { classes, methods };
  }

  function buildFullFileActionMarkup(file) {
    const loading = fullFileLoadingByPath.has(file.path);
    const label = loading ? "Loading..." : "Open Full File";
    return `<div class="worktree-diff-detail-actions"><button type="button" class="worktree-diff-open-file-btn" data-open-full-file="1" data-open-full-file-path="${escapeAttribute(file.path)}"${loading ? " disabled" : ""}>${label}</button></div>`;
  }

  function methodLabel(method) {
    if (!method) {
      return "";
    }

    return method.className
      ? `${method.className}::${method.name}`
      : method.name;
  }

  function jumpFullFileWindowToLine(lineNo) {
    if (!fullFileWindowReady || !Number.isFinite(lineNo) || lineNo <= 0) {
      return;
    }

    const lineNode = fullFileBody.querySelector(`[data-full-window-line="${lineNo}"]`);
    if (!lineNode) {
      return;
    }

    lineNode.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function renderFullFileWindowBody(content, changedLines) {
    if (!fullFileWindowReady) {
      return;
    }

    const lines = typeof content === "string" ? content.split(/\r?\n/) : [];
    if (lines.length === 0) {
      fullFileBody.innerHTML = "<div class=\"worktree-diff-file-empty\">File content is empty.</div>";
      return;
    }

    const html = lines.map((line, index) => {
      const lineNo = index + 1;
      const classes = ["diff-full-window-line", "diff-full-window-line-clickable"];
      const reviewTitle = getLineReviewTitle(fullFileViewerState.path, lineNo);
      const selectedTarget = fullFileViewerState.selectedNoteTarget;
      if (changedLines && changedLines.has(lineNo)) {
        classes.push("diff-full-window-line-changed");
      }
      if (Number.isFinite(fullFileViewerState.requestedLineNo) && fullFileViewerState.requestedLineNo === lineNo) {
        classes.push("diff-full-window-line-requested");
      }
      if (hasLineNote(fullFileViewerState.path, lineNo, "file")) {
        classes.push("diff-full-window-line-noted");
      }
      if (reviewTitle) {
        classes.push("diff-full-window-line-reviewed");
      }
      if (selectedTarget && lineNo >= selectedTarget.startLine && lineNo <= selectedTarget.endLine) {
        classes.push("diff-full-window-line-selected");
      }
      const title = reviewTitle
        ? `Click to add note. Shift-select lines to annotate a range. Review: ${reviewTitle}`
        : "Click to add note. Shift-select lines to annotate a range.";
      return `<div class="${classes.join(" ")}" data-full-window-line="${lineNo}" data-full-window-line-text="${escapeHtml(line)}" title="${escapeAttribute(title)}">
        <span class="diff-full-window-line-no">${lineNo}</span>
        <span class="diff-full-window-line-text">${escapeHtml(line)}</span>
      </div>`;
    }).join("");
    fullFileBody.innerHTML = html;
  }

  function rerenderFullFileWindowIfOpen() {
    if (!fullFileWindowReady || fullFileWindow.classList.contains("hidden")) {
      return;
    }
    renderFullFileWindowBody(fullFileViewerState.content, fullFileViewerState.changedLines);
  }

  function renderFullFileWindowMethodOptions() {
    if (!fullFileWindowReady) {
      return;
    }

    const selectedClass = fullFileViewerState.selectedClass || "";
    const methods = Array.isArray(fullFileViewerState.methods)
      ? fullFileViewerState.methods.filter((x) => !selectedClass || x.className === selectedClass)
      : [];
    methods.sort((a, b) => {
      const aClass = typeof a?.className === "string" ? a.className : "";
      const bClass = typeof b?.className === "string" ? b.className : "";
      const classCompare = aClass.localeCompare(bClass, undefined, { sensitivity: "base" });
      if (classCompare !== 0) {
        return classCompare;
      }

      const aName = typeof a?.name === "string" ? a.name : "";
      const bName = typeof b?.name === "string" ? b.name : "";
      const nameCompare = aName.localeCompare(bName, undefined, { sensitivity: "base" });
      if (nameCompare !== 0) {
        return nameCompare;
      }

      const aLine = Number.isFinite(a?.lineNo) ? a.lineNo : Number.MAX_SAFE_INTEGER;
      const bLine = Number.isFinite(b?.lineNo) ? b.lineNo : Number.MAX_SAFE_INTEGER;
      return aLine - bLine;
    });
    const options = ["<option value=\"\">Methods</option>"];
    for (const method of methods) {
      options.push(`<option value="${escapeAttribute(method.key)}">${escapeHtml(methodLabel(method))}</option>`);
    }
    fullFileMethodSelect.innerHTML = options.join("");
    const selectedKey = fullFileViewerState.selectedMethodKey || "";
    if (selectedKey && methods.some((x) => x.key === selectedKey)) {
      fullFileMethodSelect.value = selectedKey;
    } else {
      fullFileViewerState.selectedMethodKey = "";
      fullFileMethodSelect.value = "";
    }
    fullFileMethodSelect.disabled = methods.length === 0;
  }

  function findFullFileClassByName(name) {
    if (!name) {
      return null;
    }

    const classes = Array.isArray(fullFileViewerState.classes) ? fullFileViewerState.classes : [];
    for (const entry of classes) {
      if (entry && entry.name === name) {
        return entry;
      }
    }

    return null;
  }

  function findFullFileMethodByKey(key) {
    if (!key) {
      return null;
    }

    const methods = Array.isArray(fullFileViewerState.methods) ? fullFileViewerState.methods : [];
    for (const entry of methods) {
      if (entry && entry.key === key) {
        return entry;
      }
    }

    return null;
  }

  function renderFullFileWindowClassOptions() {
    if (!fullFileWindowReady) {
      return;
    }

    const classes = Array.isArray(fullFileViewerState.classes) ? fullFileViewerState.classes.slice() : [];
    classes.sort((a, b) => {
      const aName = typeof a?.name === "string" ? a.name : "";
      const bName = typeof b?.name === "string" ? b.name : "";
      const nameCompare = aName.localeCompare(bName, undefined, { sensitivity: "base" });
      if (nameCompare !== 0) {
        return nameCompare;
      }

      const aLine = Number.isFinite(a?.lineNo) ? a.lineNo : Number.MAX_SAFE_INTEGER;
      const bLine = Number.isFinite(b?.lineNo) ? b.lineNo : Number.MAX_SAFE_INTEGER;
      return aLine - bLine;
    });
    const options = ["<option value=\"\">Classes</option>"];
    for (const entry of classes) {
      options.push(`<option value="${escapeAttribute(entry.name)}">${escapeHtml(entry.name)}</option>`);
    }
    fullFileClassSelect.innerHTML = options.join("");
    const selectedClass = fullFileViewerState.selectedClass || "";
    if (selectedClass && classes.some((x) => x.name === selectedClass)) {
      fullFileClassSelect.value = selectedClass;
    } else {
      fullFileViewerState.selectedClass = "";
      fullFileClassSelect.value = "";
    }
    fullFileClassSelect.disabled = classes.length === 0;
    renderFullFileWindowMethodOptions();
  }

  function closeFullFileWindow() {
    if (!fullFileWindowReady) {
      return;
    }

    persistPendingNoteDraft();
    fullFileWindow.classList.add("hidden");
    fullFileViewerState = createEmptyFullFileViewerState();
    fullFileTitle.textContent = "Full File";
    fullFileStatus.textContent = "";
    fullFileBody.innerHTML = "";
    fullFileClassSelect.innerHTML = "<option value=\"\">Classes</option>";
    fullFileClassSelect.disabled = true;
    fullFileMethodSelect.innerHTML = "<option value=\"\">Methods</option>";
    fullFileMethodSelect.disabled = true;
    renderFullFileReviewPanel();
    ignoreNextFullFileLineClick = false;
  }

  function notesForPath(path, origin = null) {
    const normalizedOrigin = origin ? normalizeNoteOrigin(origin) : "";
    return Array.from(notesByKey.values())
      .filter((x) => x.path === path && (!normalizedOrigin || normalizeNoteOrigin(x.origin) === normalizedOrigin))
      .sort((a, b) => {
        if (a.startLine !== b.startLine) {
          return a.startLine - b.startLine;
        }
        return a.endLine - b.endLine;
      });
  }

  function hasLineNote(path, lineNo, origin = null) {
    const notes = notesForPath(path, origin);
    for (const note of notes) {
      if (lineNo >= note.startLine && lineNo <= note.endLine) {
        return true;
      }
    }
    return false;
  }

  function buildFileNotesMarkup(path) {
    const notes = notesForPath(path, "diff");
    if (notes.length === 0) {
      return "";
    }

    const items = notes.map((x) => {
      const lineText = noteLineLabel(x.startLine, x.endLine, "diff");
      const noteTitle = escapeHtml(x.note);
      return `<button type="button" class="worktree-diff-note-pill" data-note-jump="1" data-note-path="${escapeHtml(path)}" data-note-start="${x.startLine}" data-note-end="${x.endLine}" title="${noteTitle}">${lineText}: ${noteTitle}</button>`;
    }).join("");

    return `<div class="worktree-diff-note-list">${items}</div>`;
  }

  function renderFiles(files) {
    currentFiles = Array.isArray(files) ? files : [];
    if (currentFiles.length === 0) {
      listNode.innerHTML = "";
      renderReviewFindingsPanel();
      return;
    }

    const html = [];
    for (const file of currentFiles) {
      if (!file || typeof file.path !== "string" || !file.path.trim()) {
        continue;
      }

      const statusCode = escapeHtml(file.statusCode || "--");
      const statusLabel = escapeHtml(file.statusLabel || "Changed");
      const pathLabel = escapeHtml(file.path);
      const originalPath = typeof file.originalPath === "string" && file.originalPath.trim()
        ? escapeHtml(file.originalPath)
        : "";
      const isBinary = file.isBinary === true;
      const patchText = isBinary ? "" : (typeof file.patch === "string" ? file.patch : "");
      const diffStat = getFileDiffStat(file);
      const patchLines = patchText ? patchText.split(/\r?\n/) : [];
      const shownLines = patchLines.slice(0, MAX_LINES_PER_FILE);
      const truncated = patchLines.length > shownLines.length;
      const noteMarkup = buildFileNotesMarkup(file.path);
      const actionMarkup = buildFullFileActionMarkup(file);
      const reviewFindingCount = countReviewFindingsForPath(file.path);
      const lineMarkup = isBinary
        ? `<span class="watcher-diff-line">Binary file changed. Diff body is hidden.</span>`
        : shownLines.length > 0
          ? shownLines.map((line, index) => {
            const lineNo = index + 1;
            const lineClass = classForDiffLine(line);
            const lineHasNote = hasLineNote(file.path, lineNo, "diff");
            const reviewTitle = getLineReviewTitle(file.path, lineNo);
            const classes = ["watcher-diff-line", "worktree-diff-line-clickable"];
            if (lineClass) {
              classes.push(lineClass);
            }
            if (lineHasNote) {
              classes.push("worktree-diff-line-noted");
            }
            if (reviewTitle) {
              classes.push("worktree-diff-line-reviewed");
            }
            const title = reviewTitle
              ? `Click to add note. Shift-click to select a range. Review: ${reviewTitle}`
              : "Click to add note. Shift-click to select a range.";
            return `<span class="${classes.join(" ")}" data-diff-line-no="${lineNo}" data-diff-line-text="${escapeHtml(line)}" title="${escapeAttribute(title)}">${escapeHtml(line)}</span>`;
          }).join("")
          : `<span class="watcher-diff-line">No patch available for this file yet.</span>`;

      const isOpen = fileOpenStateByPath.get(file.path) === true;
      html.push(
        `<details class="worktree-diff-file" data-diff-path="${pathLabel}"${isOpen ? " open" : ""}>
          <summary>
            <span class="worktree-diff-code" title="${statusLabel}">${statusCode}</span>
            <span class="worktree-diff-path" title="${pathLabel}">${pathLabel}</span>
            ${reviewFindingCount > 0 ? `<span class="worktree-diff-review-pill" title="${reviewFindingCount} review finding${reviewFindingCount === 1 ? "" : "s"} extracted from timeline">R ${reviewFindingCount}</span>` : ""}
            <span class="worktree-diff-stat" aria-label="Diff stat">
              <span class="worktree-diff-stat-add">+${diffStat.added}</span>
              <span class="worktree-diff-stat-remove">-${diffStat.removed}</span>
            </span>
          </summary>
          <div class="worktree-diff-detail">
            ${originalPath ? `<div class="worktree-diff-truncated">Renamed from ${originalPath}</div>` : ""}
            ${noteMarkup}
            ${actionMarkup}
            <pre class="worktree-diff-pre">${lineMarkup}</pre>
            ${truncated ? `<p class="worktree-diff-truncated">Patch truncated to ${MAX_LINES_PER_FILE} lines.</p>` : ""}
          </div>
        </details>`
      );
    }

    listNode.innerHTML = html.join("");
    renderReviewFindingsPanel();
  }

  function jumpToReviewFinding(path, lineNo) {
    if (!path || !Number.isFinite(lineNo) || lineNo <= 0) {
      return;
    }

    const details = listNode.querySelector(`details[data-diff-path="${CSS.escape(path)}"]`);
    if (details) {
      details.open = true;
      fileOpenStateByPath.set(path, true);
      const lineNode = details.querySelector(`[data-diff-line-no="${lineNo}"]`);
      if (lineNode) {
        lineNode.scrollIntoView({ block: "center", behavior: "smooth" });
        return;
      }
    }

    openFullFileWindow(path, { lineNo }).catch(() => { });
  }

  function collectRangeSnippet(fileNode, startLine, endLine) {
    const lines = [];
    for (let i = startLine; i <= endLine; i += 1) {
      const lineNode = fileNode.querySelector(`[data-diff-line-no="${i}"]`);
      if (!lineNode) {
        continue;
      }
      lines.push(lineNode.getAttribute("data-diff-line-text") || lineNode.textContent || "");
    }
    return lines.join("\n").trim();
  }

  function jumpToNotedLine(path, lineNo) {
    const details = listNode.querySelector(`details[data-diff-path="${CSS.escape(path)}"]`);
    if (!details) {
      return;
    }
    details.open = true;
    fileOpenStateByPath.set(path, true);
    const lineNode = details.querySelector(`[data-diff-line-no="${lineNo}"]`);
    if (!lineNode) {
      return;
    }
    lineNode.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function applyNoteToState(path, startLine, endLine, note, snippet, origin = "diff") {
    const normalizedOrigin = normalizeNoteOrigin(origin);
    const key = buildNoteKey(path, startLine, endLine, normalizedOrigin);
    const cleaned = (note || "").trim();
    if (!cleaned) {
      notesByKey.delete(key);
      return;
    }

    notesByKey.set(key, {
      path,
      startLine,
      endLine,
      note: cleaned,
      snippet: snippet || "",
      origin: normalizedOrigin
    });
  }

  function openNoteModal(path, startLine, endLine, snippet, origin = "diff") {
    if (!noteModalReady) {
      return;
    }

    const normalizedOrigin = normalizeNoteOrigin(origin);
    const key = buildNoteKey(path, startLine, endLine, normalizedOrigin);
    const existing = notesByKey.get(key);
    const initial = existing && typeof existing.note === "string" ? existing.note : "";
    const lineLabel = noteLineLabel(startLine, endLine, normalizedOrigin);

    currentNoteEdit = {
      path,
      startLine,
      endLine,
      snippet: snippet || "",
      origin: normalizedOrigin
    };

    noteModalPath.textContent = `${path} (${lineLabel})`;
    noteModalTextarea.value = initial;
    noteModalRemoveBtn.disabled = !notesByKey.has(key);
    noteModal.classList.remove("hidden");
    noteModalTextarea.focus();
    noteModalTextarea.setSelectionRange(noteModalTextarea.value.length, noteModalTextarea.value.length);
  }

  function openNoteModalForTargets(targets) {
    if (!noteModalReady) {
      return;
    }

    if (!Array.isArray(targets) || targets.length === 0) {
      return;
    }

    currentNoteEdit = {
      targets: targets.map((x) => ({
        path: x.path,
        startLine: x.startLine,
        endLine: x.endLine,
        snippet: x.snippet || "",
        origin: normalizeNoteOrigin(x.origin)
      }))
    };

    if (targets.length === 1) {
      const only = targets[0];
      const key = buildNoteKey(only.path, only.startLine, only.endLine, only.origin);
      const existing = notesByKey.get(key);
      const initial = existing && typeof existing.note === "string" ? existing.note : "";
      const lineLabel = noteLineLabel(only.startLine, only.endLine, only.origin);
      noteModalPath.textContent = `${only.path} (${lineLabel})`;
      noteModalTextarea.value = initial;
      noteModalRemoveBtn.disabled = !notesByKey.has(key);
    } else {
      const fileCount = new Set(targets.map((x) => x.path)).size;
      const anyExisting = targets.some((x) => notesByKey.has(buildNoteKey(x.path, x.startLine, x.endLine, x.origin)));
      noteModalPath.textContent = `${targets.length} ranges selected across ${fileCount} file(s)`;
      noteModalTextarea.value = "";
      noteModalRemoveBtn.disabled = !anyExisting;
    }

    noteModal.classList.remove("hidden");
    noteModalTextarea.focus();
    noteModalTextarea.setSelectionRange(noteModalTextarea.value.length, noteModalTextarea.value.length);
  }

  function collectSelectionTargets() {
    const selection = window.getSelection ? window.getSelection() : null;
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return [];
    }

    const range = selection.getRangeAt(0);
    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    const withinList = (anchorNode && listNode.contains(anchorNode)) || (focusNode && listNode.contains(focusNode)) || listNode.contains(range.commonAncestorContainer);
    if (!withinList) {
      return [];
    }

    const lineNodes = Array.from(listNode.querySelectorAll("[data-diff-line-no]"));
    const buckets = new Map();
    for (const node of lineNodes) {
      if (!(node instanceof Element)) {
        continue;
      }

      let intersects = false;
      try {
        intersects = range.intersectsNode(node);
      } catch {
        intersects = false;
      }
      if (!intersects) {
        continue;
      }

      const fileNode = node.closest("details[data-diff-path]");
      if (!fileNode) {
        continue;
      }

      const path = fileNode.getAttribute("data-diff-path") || "";
      const lineNo = Number.parseInt(node.getAttribute("data-diff-line-no") || "", 10);
      if (!path || !Number.isFinite(lineNo) || lineNo <= 0) {
        continue;
      }

      const key = path;
      if (!buckets.has(key)) {
        buckets.set(key, {
          path,
          startLine: lineNo,
          endLine: lineNo,
          snippets: [(node.getAttribute("data-diff-line-text") || node.textContent || "").trim()]
        });
      } else {
        const state = buckets.get(key);
        state.startLine = Math.min(state.startLine, lineNo);
        state.endLine = Math.max(state.endLine, lineNo);
        state.snippets.push((node.getAttribute("data-diff-line-text") || node.textContent || "").trim());
      }
    }

    const targets = Array.from(buckets.values())
      .map((x) => ({
        path: x.path,
        startLine: x.startLine,
        endLine: x.endLine,
        snippet: x.snippets.filter(Boolean).join("\n").trim(),
        origin: "diff"
      }))
      .sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine);

    return targets;
  }

  function collectFullFileSelectionTargets() {
    if (!fullFileWindowReady || !fullFileViewerState.path) {
      return [];
    }

    const selection = window.getSelection ? window.getSelection() : null;
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return [];
    }

    const range = selection.getRangeAt(0);
    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    const withinFullFile = (anchorNode && fullFileBody.contains(anchorNode))
      || (focusNode && fullFileBody.contains(focusNode))
      || fullFileBody.contains(range.commonAncestorContainer);
    if (!withinFullFile) {
      return [];
    }

    const lineNodes = Array.from(fullFileBody.querySelectorAll("[data-full-window-line]"));
    let startLine = Number.POSITIVE_INFINITY;
    let endLine = 0;
    const snippetLines = [];
    for (const node of lineNodes) {
      if (!(node instanceof Element)) {
        continue;
      }

      let intersects = false;
      try {
        intersects = range.intersectsNode(node);
      } catch {
        intersects = false;
      }
      if (!intersects) {
        continue;
      }

      const lineNo = Number.parseInt(node.getAttribute("data-full-window-line") || "", 10);
      if (!Number.isFinite(lineNo) || lineNo <= 0) {
        continue;
      }

      startLine = Math.min(startLine, lineNo);
      endLine = Math.max(endLine, lineNo);
      snippetLines.push((node.getAttribute("data-full-window-line-text") || node.textContent || "").trim());
    }

    if (!Number.isFinite(startLine) || startLine <= 0 || endLine <= 0) {
      return [];
    }

    return [{
      path: fullFileViewerState.path,
      startLine,
      endLine,
      snippet: snippetLines.filter(Boolean).join("\n").trim(),
      origin: "file"
    }];
  }

  function closeNoteModal() {
    if (!noteModalReady) {
      return;
    }

    noteModal.classList.add("hidden");
    currentNoteEdit = null;
  }

  function saveNoteFromModal() {
    if (!noteModalReady) {
      return;
    }

    if (!currentNoteEdit) {
      return;
    }
    const noteText = noteModalTextarea.value || "";
    const targets = Array.isArray(currentNoteEdit.targets) && currentNoteEdit.targets.length > 0
      ? currentNoteEdit.targets
      : [currentNoteEdit];
    for (const target of targets) {
      applyNoteToState(
        target.path,
        target.startLine,
        target.endLine,
        noteText,
        target.snippet,
        target.origin
      );
    }

    saveNotesForScope(currentNotesScopeKey);
    updateSummary(currentTotalChangeCount);
    rerenderFilesPreserveView();
    rerenderFullFileWindowIfOpen();
    renderComposerNotes();
    closeNoteModal();
  }

  function removeNoteFromModal() {
    if (!noteModalReady) {
      return;
    }

    if (!currentNoteEdit) {
      return;
    }
    const targets = Array.isArray(currentNoteEdit.targets) && currentNoteEdit.targets.length > 0
      ? currentNoteEdit.targets
      : [currentNoteEdit];
    for (const target of targets) {
      notesByKey.delete(buildNoteKey(target.path, target.startLine, target.endLine, target.origin));
    }
    saveNotesForScope(currentNotesScopeKey);
    updateSummary(currentTotalChangeCount);
    rerenderFilesPreserveView();
    rerenderFullFileWindowIfOpen();
    renderComposerNotes();
    closeNoteModal();
  }

  function buildPromptMetadata(consume = true) {
    if (notesByKey.size === 0) {
      return { metadataText: "", noteCount: 0 };
    }

    const ordered = Array.from(notesByKey.values())
      .sort((a, b) => {
        const pathCompare = a.path.localeCompare(b.path);
        if (pathCompare !== 0) {
          return pathCompare;
        }
        if (a.startLine !== b.startLine) {
          return a.startLine - b.startLine;
        }
        return a.endLine - b.endLine;
      });

    const lines = [
      "[Diff source]",
      `- mode=${currentMode}; branch=${currentBranch || "detached"}; context=${contextModeLabel(currentContextMode)}${currentMode === "commit" && selectedCommitSha ? `; commit=${selectedCommitSha}` : ""}`,
      "[Code notes]"
    ];
    for (const item of ordered) {
      const origin = normalizeNoteOrigin(item.origin);
      const linePart = origin === "file"
        ? (item.startLine === item.endLine
          ? `fileLine=${item.startLine}`
          : `fileLineStart=${item.startLine}; fileLineEnd=${item.endLine}`)
        : (item.startLine === item.endLine
          ? `diffLine=${item.startLine}`
          : `diffLineStart=${item.startLine}; diffLineEnd=${item.endLine}`);
      const base = `- file=${item.path}; ${linePart}; note=${item.note}`;
      if (item.snippet) {
        lines.push(`${base}; snippet=${item.snippet}`);
      } else {
        lines.push(base);
      }
    }

    if (consume) {
      notesByKey.clear();
      saveNotesForScope(currentNotesScopeKey);
      updateSummary(currentTotalChangeCount);
      rerenderFilesPreserveView();
      rerenderFullFileWindowIfOpen();
      renderComposerNotes();
    }

    return {
      metadataText: lines.join("\n"),
      noteCount: ordered.length
    };
  }

  function consumePromptMetadata() {
    return buildPromptMetadata(true);
  }

  window.codexDiffNotesConsumePromptMetadata = consumePromptMetadata;
  window.codexDiffNotesBuildPromptMetadata = function codexDiffNotesBuildPromptMetadata() {
    return buildPromptMetadata(false);
  };
  window.codexDiffNotesHasPending = () => notesByKey.size > 0;

  function normalizePathForDiffViewer(path, cwd) {
    const rawPath = typeof path === "string" ? path.trim() : "";
    if (!rawPath) {
      return "";
    }

    const normalizedPath = rawPath.replace(/\\/g, "/");
    const normalizedCwd = typeof cwd === "string" ? cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "") : "";
    if (!normalizedCwd) {
      return normalizedPath;
    }

    if (normalizedPath.length > normalizedCwd.length + 1
      && normalizedPath.toLowerCase().startsWith(`${normalizedCwd.toLowerCase()}/`)) {
      return normalizedPath.slice(normalizedCwd.length + 1);
    }

    return normalizedPath;
  }

  function normalizePathCaseInsensitive(path) {
    return typeof path === "string" ? path.replace(/\\/g, "/").trim().toLowerCase() : "";
  }

  function resolveDiffPathFromReviewReference(path) {
    const source = typeof path === "string" ? path.trim() : "";
    if (!source) {
      return "";
    }

    const activeContext = getActiveContext();
    const normalized = normalizePathForDiffViewer(source, activeContext && activeContext.cwd ? activeContext.cwd : "");
    if (!normalized) {
      return "";
    }

    const exact = currentFiles.find((x) => x && typeof x.path === "string" && x.path === normalized);
    if (exact && typeof exact.path === "string") {
      return exact.path;
    }

    const normalizedNeedle = normalizePathCaseInsensitive(normalized);
    if (!normalizedNeedle) {
      return normalized;
    }

    const exactInsensitive = currentFiles.find((x) => normalizePathCaseInsensitive(x && x.path) === normalizedNeedle);
    if (exactInsensitive && typeof exactInsensitive.path === "string") {
      return exactInsensitive.path;
    }

    const suffixNeedle = normalizedNeedle.startsWith("/") ? normalizedNeedle : `/${normalizedNeedle}`;
    const suffixMatches = currentFiles.filter((x) => {
      const candidate = normalizePathCaseInsensitive(x && x.path);
      if (!candidate) {
        return false;
      }
      if (candidate === normalizedNeedle) {
        return true;
      }
      return candidate.endsWith(suffixNeedle);
    });
    if (suffixMatches.length === 1 && typeof suffixMatches[0]?.path === "string") {
      return suffixMatches[0].path;
    }

    const baseName = normalizedNeedle.includes("/")
      ? normalizedNeedle.slice(normalizedNeedle.lastIndexOf("/") + 1)
      : normalizedNeedle;
    if (!baseName) {
      return normalized;
    }

    const baseNameMatches = currentFiles.filter((x) => {
      const candidate = normalizePathCaseInsensitive(x && x.path);
      if (!candidate) {
        return false;
      }
      return candidate.endsWith(`/${baseName}`) || candidate === baseName;
    });
    if (baseNameMatches.length === 1 && typeof baseNameMatches[0]?.path === "string") {
      return baseNameMatches[0].path;
    }

    return normalized;
  }

  function parseFileLinkTarget(rawHref) {
    const source = typeof rawHref === "string" ? rawHref.trim() : "";
    if (!source) {
      return null;
    }

    let value = source;
    if (/^file:\/\//i.test(value)) {
      try {
        value = decodeURI(value);
      } catch {
      }
      value = value.replace(/^file:\/\/\/?/i, "");
    } else {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
        return null;
      }
      try {
        value = decodeURI(value);
      } catch {
      }
    }

    value = value.replace(/[?#].*$/, "");
    if (!value) {
      return null;
    }

    let lineNo = null;
    const lineMatch = value.match(/:(\d+)(?:(?::\d+)|(?:-\d+))?$/);
    if (lineMatch) {
      const parsed = Number.parseInt(lineMatch[1] || "", 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        lineNo = parsed;
        value = value.slice(0, lineMatch.index);
      }
    }

    const normalizedPath = value.replace(/\\/g, "/");
    if (!normalizedPath) {
      return null;
    }

    return { path: normalizedPath, lineNo };
  }

  async function openFullFileWindow(path, options = {}) {
    if (!fullFileWindowReady) {
      return;
    }

    const activeContext = getActiveContext();
    if (!activeContext || !activeContext.cwd) {
      return;
    }

    const normalizedPath = resolveDiffPathFromReviewReference(path);
    if (!normalizedPath) {
      return;
    }

    const file = currentFiles.find((x) => x && typeof x.path === "string" && x.path === normalizedPath);
    const patchText = typeof file?.patch === "string" ? file.patch : "";
    const changed = collectChangedLinesFromPatch(patchText);
    const requestedLineNo = Number.isFinite(options?.lineNo) && options.lineNo > 0
      ? Math.floor(options.lineNo)
      : null;
    const requestedLineEnd = Number.isFinite(options?.lineEnd) && options.lineEnd >= requestedLineNo
      ? Math.floor(options.lineEnd)
      : requestedLineNo;
    const selectedTarget = requestedLineNo
      ? {
        path: normalizedPath,
        startLine: requestedLineNo,
        endLine: requestedLineEnd,
        snippet: "",
        origin: "file"
      }
      : null;
    const loadToken = ++fullFileViewerLoadToken;

    fullFileLoadingByPath.add(normalizedPath);
    rerenderFilesPreserveView();

    fullFileViewerState = {
      ...createEmptyFullFileViewerState(),
      path: normalizedPath,
      changedLines: changed.changed,
      firstChangedLine: requestedLineNo || changed.first,
      requestedLineNo,
      selectedNoteTarget: selectedTarget
    };
    if (options?.reviewContext) {
      fullFileViewerState.reviewContext = {
        title: typeof options.reviewContext.title === "string" ? options.reviewContext.title.trim() : "",
        html: typeof options.reviewContext.html === "string" ? options.reviewContext.html : "",
        text: typeof options.reviewContext.text === "string" ? options.reviewContext.text.trim() : "",
        path: normalizedPath,
        lineNo: requestedLineNo
      };
    }
    if (selectedTarget) {
      const noteKey = buildNoteKey(selectedTarget.path, selectedTarget.startLine, selectedTarget.endLine, "file");
      const existing = notesByKey.get(noteKey);
      fullFileViewerState.noteDraftKey = noteKey;
      fullFileViewerState.noteDraftText = existing && typeof existing.note === "string" ? existing.note : "";
      fullFileViewerState.noteDraftDirty = false;
    }
    fullFileTitle.textContent = normalizedPath;
    fullFileStatus.textContent = "Loading full file content...";
    fullFileBody.innerHTML = "";
    fullFileClassSelect.innerHTML = "<option value=\"\">Classes</option>";
    fullFileClassSelect.disabled = true;
    fullFileMethodSelect.innerHTML = "<option value=\"\">Methods</option>";
    fullFileMethodSelect.disabled = true;
    fullFileWindow.classList.remove("hidden");
    renderFullFileReviewPanel();

    try {
      const url = new URL("api/worktree/diff/file", document.baseURI);
      url.searchParams.set("cwd", activeContext.cwd);
      url.searchParams.set("path", normalizedPath);
      url.searchParams.set("maxChars", "1000000");
      if (currentMode === "commit" && selectedCommitSha) {
        url.searchParams.set("commit", selectedCommitSha);
      }

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json" }
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      if (loadToken !== fullFileViewerLoadToken) {
        return;
      }

      if (data.exists !== true) {
        fullFileStatus.textContent = typeof data.message === "string" && data.message ? data.message : "File not found.";
        fullFileBody.innerHTML = "";
        return;
      }

      if (data.isBinary === true) {
        fullFileStatus.textContent = typeof data.message === "string" && data.message ? data.message : "Binary file cannot be displayed.";
        fullFileBody.innerHTML = "";
        return;
      }

      const content = typeof data.content === "string" ? data.content : "";
      fullFileViewerState.content = content;
      const symbols = extractSymbolsFromContent(content);
      fullFileViewerState.classes = symbols.classes;
      fullFileViewerState.methods = symbols.methods;
      if (fullFileViewerState.selectedNoteTarget && !fullFileViewerState.selectedNoteTarget.snippet) {
        fullFileViewerState.selectedNoteTarget.snippet = deriveFullFileSnippet(fullFileViewerState.selectedNoteTarget, content);
      }
      fullFileStatus.textContent = data.isTruncated === true
        ? "Showing truncated file content."
        : "Use Classes and Methods dropdowns to jump.";
      renderFullFileWindowBody(content, fullFileViewerState.changedLines);
      renderFullFileReviewPanel();
      renderFullFileWindowClassOptions();
      window.setTimeout(() => {
        jumpFullFileWindowToLine(requestedLineNo || fullFileViewerState.firstChangedLine || 1);
      }, 40);
    } catch (error) {
      if (loadToken !== fullFileViewerLoadToken) {
        return;
      }

      fullFileStatus.textContent = `Failed to load file: ${error instanceof Error ? error.message : String(error)}`;
      fullFileBody.innerHTML = "";
    } finally {
      fullFileLoadingByPath.delete(normalizedPath);
      rerenderFilesPreserveView();
    }
  }

  window.codexDiffOpenFileFromLink = function codexDiffOpenFileFromLink(rawHref) {
    const parsed = parseFileLinkTarget(rawHref);
    if (!parsed || !parsed.path) {
      return false;
    }

    openFullFileWindow(parsed.path, { lineNo: parsed.lineNo }).catch(() => { });
    return true;
  };

  async function fetchCurrentWorktreeSnapshot(context, force) {
    const url = new URL("api/worktree/diff/current", document.baseURI);
    url.searchParams.set("cwd", context.cwd);
    url.searchParams.set("maxFiles", "240");
    url.searchParams.set("maxPatchChars", "800000");
    url.searchParams.set("contextLines", String(contextLinesForMode(currentContextMode)));
    if (typeof window.uiAuditLog === "function") {
      window.uiAuditLog("out.diff_count_request", {
        cwd: context.cwd,
        force: force === true
      });
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  }

  async function fetchRecentCommitCatalog(context, force) {
    const url = new URL("api/worktree/diff/commits", document.baseURI);
    url.searchParams.set("cwd", context.cwd);
    url.searchParams.set("limit", "60");
    if (typeof window.uiAuditLog === "function") {
      window.uiAuditLog("out.diff_commit_list_request", {
        cwd: context.cwd,
        force: force === true
      });
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  }

  async function fetchCommitSnapshot(context, commitSha) {
    const url = new URL("api/worktree/diff/commit", document.baseURI);
    url.searchParams.set("cwd", context.cwd);
    url.searchParams.set("commit", commitSha);
    url.searchParams.set("maxFiles", "240");
    url.searchParams.set("maxPatchChars", "800000");
    url.searchParams.set("contextLines", String(contextLinesForMode(currentContextMode)));
    if (typeof window.uiAuditLog === "function") {
      window.uiAuditLog("out.diff_commit_request", {
        cwd: context.cwd,
        commit: commitSha
      });
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  }

  async function refreshReviewCatalogForContext(context, force) {
    const refreshCatalog = window.codexDiffRefreshReviewCatalog;
    if (!context || !context.cwd || typeof refreshCatalog !== "function") {
      return;
    }

    try {
      await refreshCatalog(context.cwd, { force: force === true });
    } catch {
    }
  }

  function buildFilesFingerprint(files) {
    return files.map((x) => `${x.statusCode || ""}:${x.path || ""}:${(x.patch || "").length}:${x.isBinary === true ? "1" : "0"}`).join("|");
  }

  function findSelectedCommitInfo() {
    if (!selectedCommitSha) {
      return null;
    }

    for (const commit of availableCommits) {
      const normalized = normalizeCommitInfo(commit);
      if (!normalized) {
        continue;
      }
      if (normalized.sha === selectedCommitSha) {
        return normalized;
      }
    }

    return null;
  }

  async function fetchAndRenderDiff(force) {
    if (pollInFlight) {
      return;
    }

    const context = getActiveContext();
    if (!context) {
      persistPendingNoteDraft();
      if (lastContextState !== "none") {
        lastContextState = "none";
        if (typeof window.uiAuditLog === "function") {
          window.uiAuditLog("diff.context_unavailable");
        } else if (typeof console !== "undefined" && typeof console.info === "function") {
          console.info(`${new Date().toISOString()} diff.context_unavailable`);
        }
      }
      panelAvailable = false;
      hasVisibleChanges = false;
      listNode.innerHTML = "";
      summaryNode.textContent = "No active session";
      currentFiles = [];
      currentTotalChangeCount = 0;
      hiddenBinaryFileCount = 0;
      isExpanded = false;
      ignoreNextLineClick = false;
      lastRenderKey = "";
      lastCwd = "";
      currentRepoRoot = "";
      currentBranch = "";
      availableCommits = [];
      if (reviewPageMode !== "detail") {
        selectedCommitSha = "";
        selectedCommitInfo = null;
      }
      currentNotesScopeKey = "";
      currentFileViewScopeKey = "";
      notesByKey = new Map();
      ensureReviewFindingStateScope("");
      reviewScopeByTurnId = new Map();
      pendingReviewScopeQueue = [];
      reviewRequestedTurns = new Set();
      reviewCompletedTurns = new Set();
      renderCommitModeBadge();
      fullFileLoadingByPath = new Set();
      closeReviewModal({ keepDraft: true });
      closeFullFileWindow();
      contextSelect.disabled = false;
      renderCommitOptions();
      applyPanelState();
      renderComposerNotes();
      renderReviewFindingsPanel();
      return;
    }
    if (lastContextState !== "active") {
      lastContextState = "active";
      if (typeof window.uiAuditLog === "function") {
        window.uiAuditLog("diff.context_active", { sessionId: context.sessionId || null, cwd: context.cwd });
      } else if (typeof console !== "undefined" && typeof console.info === "function") {
        console.info(`${new Date().toISOString()} diff.context_active sessionId=${context.sessionId || ""} cwd=${context.cwd}`);
      }
    }

    if (context.cwd !== lastCwd) {
      persistPendingNoteDraft();
      currentRepoRoot = "";
      currentBranch = "";
      currentNotesScopeKey = "";
      currentFileViewScopeKey = "";
      notesByKey = new Map();
      ensureReviewFindingStateScope("");
      reviewScopeByTurnId = new Map();
      pendingReviewScopeQueue = [];
      reviewRequestedTurns = new Set();
      reviewCompletedTurns = new Set();
      renderCommitModeBadge();
      fileOpenStateByPath = new Map();
      fullFileLoadingByPath = new Set();
      closeReviewModal({ keepDraft: true });
      closeFullFileWindow();
      currentTotalChangeCount = 0;
      hiddenBinaryFileCount = 0;
      availableCommits = [];
      selectedCommitSha = "";
      selectedCommitInfo = null;
      ignoreNextLineClick = false;
      lastRenderKey = "";
      lastCwd = context.cwd;
      renderCommitOptions();
      renderComposerNotes();
    }

    pollInFlight = true;
    refreshBtn.disabled = true;
    commitSelect.disabled = true;
    contextSelect.disabled = true;
    try {
      await refreshReviewCatalogForContext(context, force);
      let data;
      let files = [];
      if (currentMode === "commit") {
        const commitCatalog = await fetchRecentCommitCatalog(context, force);
        currentRepoRoot = typeof commitCatalog.repoRoot === "string" ? commitCatalog.repoRoot : "";
        currentBranch = typeof commitCatalog.branch === "string" && commitCatalog.branch.trim() ? commitCatalog.branch.trim() : "detached";
        panelAvailable = commitCatalog.isGitRepo === true;
        availableCommits = Array.isArray(commitCatalog.commits)
          ? commitCatalog.commits.map((x) => normalizeCommitInfo(x)).filter((x) => !!x)
          : [];

        if (!panelAvailable) {
          setEmptyState("Not a git repository");
          return;
        }

        const hasSelectedCommit = !!(selectedCommitSha && availableCommits.some((x) => x.sha === selectedCommitSha));
        if (isCodeReviewsWorkspace()) {
          if (!hasSelectedCommit) {
            selectedCommitSha = "";
            selectedCommitInfo = null;
          }
        } else if (!hasSelectedCommit) {
          selectedCommitSha = availableCommits.length > 0 ? availableCommits[0].sha : "";
        }
        selectedCommitInfo = findSelectedCommitInfo();
        renderCommitOptions();

        if (!selectedCommitSha) {
          const scopeKey = buildDiffScopeKey(context.cwd, currentMode, "");
          const notesChanged = switchNotesScope(scopeKey);
          ensureReviewFindingStateScope(scopeKey);
          if (notesChanged) {
            renderComposerNotes();
          }
          hasVisibleChanges = false;
          currentFiles = [];
          currentTotalChangeCount = 0;
          hiddenBinaryFileCount = 0;
          updateSummary(0);
          listNode.innerHTML = isCodeReviewsWorkspace()
            ? "<div class=\"worktree-diff-empty\">Select a commit to view diffs, findings, and add notes.</div>"
            : "<div class=\"worktree-diff-empty\">No recent commits found.</div>";
          applyPanelState();
          return;
        }

        data = await fetchCommitSnapshot(context, selectedCommitSha);
        files = Array.isArray(data.files) ? data.files : [];
        panelAvailable = data.isGitRepo === true;
        currentRepoRoot = typeof data.repoRoot === "string" ? data.repoRoot : "";
        currentBranch = typeof data.branch === "string" && data.branch.trim() ? data.branch.trim() : "detached";
        const fromSnapshot = normalizeCommitInfo({
          sha: data.commitSha,
          shortSha: data.commitShortSha,
          subject: data.commitSubject,
          authorName: data.commitAuthorName,
          committedAtUtc: data.commitCommittedAtUtc
        });
        if (fromSnapshot) {
          selectedCommitInfo = fromSnapshot;
          selectedCommitSha = fromSnapshot.sha;
        } else {
          selectedCommitInfo = findSelectedCommitInfo();
        }
        renderCommitOptions();
      } else {
        data = await fetchCurrentWorktreeSnapshot(context, force);
        files = Array.isArray(data.files) ? data.files : [];
        panelAvailable = data.isGitRepo === true;
        currentRepoRoot = typeof data.repoRoot === "string" ? data.repoRoot : "";
        currentBranch = typeof data.branch === "string" && data.branch.trim() ? data.branch.trim() : "detached";
        selectedCommitInfo = null;
        try {
          const commitCatalog = await fetchRecentCommitCatalog(context, false);
          if (commitCatalog && commitCatalog.isGitRepo === true && Array.isArray(commitCatalog.commits)) {
            availableCommits = commitCatalog.commits.map((x) => normalizeCommitInfo(x)).filter((x) => !!x);
            if (!selectedCommitSha || !availableCommits.some((x) => x.sha === selectedCommitSha)) {
              selectedCommitSha = availableCommits.length > 0 ? availableCommits[0].sha : "";
            }
          }
        } catch {
          // Non-fatal in worktree mode.
        }
        renderCommitOptions();
      }

      if (!panelAvailable) {
        setEmptyState("Not a git repository");
        return;
      }

      const scopeKey = buildDiffScopeKey(context.cwd, currentMode, currentMode === "commit" ? selectedCommitSha : "");
      const notesChanged = switchNotesScope(scopeKey);
      ensureReviewFindingStateScope(scopeKey);
      if (notesChanged) {
        renderComposerNotes();
      }
      if (scopeKey !== currentFileViewScopeKey) {
        fileOpenStateByPath = new Map();
        fullFileLoadingByPath = new Set();
        closeFullFileWindow();
        ignoreNextLineClick = false;
        currentFileViewScopeKey = scopeKey;
      }

      const renderKey = [
        context.cwd,
        currentMode,
        currentContextMode,
        currentMode === "commit" ? (selectedCommitSha || "") : (data.headSha || ""),
        String(files.length),
        String(data.isTimedOut === true),
        buildFilesFingerprint(files)
      ].join("::");

      if (!force && renderKey === lastRenderKey) {
        return;
      }

      lastRenderKey = renderKey;
      if (typeof window.uiAuditLog === "function") {
        window.uiAuditLog("in.diff_count_response", {
          cwd: context.cwd,
          mode: currentMode,
          changeCount: Number.isFinite(data.changeCount) ? data.changeCount : files.length,
          fileCount: files.length,
          timedOut: data.isTimedOut === true,
          isGitRepo: data.isGitRepo === true
        });
      } else if (typeof console !== "undefined" && typeof console.info === "function") {
        console.info(
          `${new Date().toISOString()} in.diff_count_response cwd=${context.cwd} changeCount=${Number.isFinite(data.changeCount) ? data.changeCount : files.length} fileCount=${files.length} timedOut=${data.isTimedOut === true} isGitRepo=${data.isGitRepo === true}`);
      }
      const filtered = filterVisibleFiles(files);
      currentTotalChangeCount = files.length;
      hiddenBinaryFileCount = filtered.hiddenBinary;
      hasVisibleChanges = filtered.visible.length > 0;
      currentFiles = filtered.visible;
      captureFileOpenState();
      if (hasVisibleChanges) {
        renderFiles(filtered.visible);
      } else {
        if (hiddenBinaryFileCount > 0) {
          listNode.innerHTML = `<div class="worktree-diff-empty">All ${hiddenBinaryFileCount} change(s) are binary and hidden.</div>`;
        } else {
          listNode.innerHTML = currentMode === "commit"
            ? "<div class=\"worktree-diff-empty\">No file changes in selected commit.</div>"
            : "<div class=\"worktree-diff-empty\">Working tree is clean.</div>";
        }
      }
      updateSummary(currentTotalChangeCount);
      applyPanelState();
      renderComposerNotes();
      if (isCodeReviewsWorkspace() && reviewPageMode === "detail" && detailReviewAction && selectedCommitSha) {
        const action = detailReviewAction;
        detailReviewAction = "";
        if (action === "run" || action === "queue") {
          runReviewFromDiffPanel("").catch(() => { });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (typeof window.uiAuditLog === "function") {
        window.uiAuditLog("in.diff_count_response_failed", { cwd: context.cwd, error: message }, "warn");
      } else if (typeof console !== "undefined" && typeof console.warn === "function") {
        console.warn(`${new Date().toISOString()} in.diff_count_response_failed cwd=${context.cwd} error=${message}`);
      }
      panelAvailable = true;
      hasVisibleChanges = false;
      currentFiles = [];
      currentTotalChangeCount = 0;
      hiddenBinaryFileCount = 0;
      ignoreNextLineClick = false;
      summaryNode.textContent = `Diff load failed: ${message}`;
      listNode.innerHTML = `<div class="worktree-diff-empty">${escapeHtml(`Diff load failed: ${message}`)}</div>`;
      applyPanelState();
      renderComposerNotes();
    } finally {
      refreshBtn.disabled = false;
      pollInFlight = false;
      commitSelect.disabled = currentMode !== "commit" || availableCommits.length === 0;
      contextSelect.disabled = false;
    }
  }

  function queueRefresh(options = {}) {
    if (options.force === true) {
      refreshPendingForce = true;
    }
    if (refreshTimer) {
      return;
    }

    refreshTimer = setTimeout(() => {
      const force = refreshPendingForce;
      refreshPendingForce = false;
      refreshTimer = null;
      fetchAndRenderDiff(force).catch(() => { });
    }, REFRESH_DEBOUNCE_MS);
  }

  window.codexDiffRequestRefresh = function codexDiffRequestRefresh(options = {}) {
    queueRefresh(options);
  };

  window.codexDiffSetWorkspaceMode = function codexDiffSetWorkspaceMode(mode) {
    const nextMode = mode === "code_reviews" ? "code_reviews" : "tasks";
    if (workspaceMode === nextMode) {
      applyPanelState();
      return;
    }

    workspaceMode = nextMode;
    if (workspaceMode === "code_reviews" && currentMode !== "commit") {
      currentMode = "commit";
    }
    if (workspaceMode === "code_reviews") {
      reviewPageMode = "list";
      clearCommitSelection();
      lastRenderKey = "";
      queueRefresh({ force: true });
    }
    applyPanelState();
  };

  function startModalDrag(event) {
    if (!(event.target instanceof Element)) {
      return;
    }

    const handle = event.target.closest("#diffNoteModalTitle, .diff-note-modal-path");
    if (!handle) {
      return;
    }

    modalDragState = {
      startX: event.clientX,
      startY: event.clientY,
      originX: modalOffset.x,
      originY: modalOffset.y
    };
  }

  function continueModalDrag(event) {
    if (!modalDragState) {
      return;
    }

    const dx = event.clientX - modalDragState.startX;
    const dy = event.clientY - modalDragState.startY;
    modalOffset = {
      x: modalDragState.originX + dx,
      y: modalDragState.originY + dy
    };
    noteModalCard.style.transform = `translate(${modalOffset.x}px, ${modalOffset.y}px)`;
  }

  function endModalDrag() {
    modalDragState = null;
  }

  toggleBtn.addEventListener("click", () => {
    if (isCodeReviewsWorkspace() && reviewPageMode === "detail") {
      setReviewPageMode("list");
      return;
    }
    persistPendingNoteDraft();
    isExpanded = false;
    applyPanelState();
  });

  indicatorBtn.addEventListener("click", () => {
    isExpanded = true;
    applyPanelState();
    queueRefresh({ force: false });
  });

  modeWorktreeBtn.addEventListener("click", () => {
    setDiffMode("worktree");
  });

  modeCommitBtn.addEventListener("click", () => {
    setDiffMode("commit");
  });

  commitSelect.addEventListener("change", () => {
    const nextSha = typeof commitSelect.value === "string" ? commitSelect.value.trim() : "";
    if (!nextSha || nextSha === selectedCommitSha) {
      return;
    }

    selectCommitForDetails(nextSha);
  });

  commitReviewSummaryNode.addEventListener("click", (event) => {
    const collapseBtn = event.target instanceof Element ? event.target.closest("[data-commit-review-collapse='1']") : null;
    if (collapseBtn) {
      setCommitReviewSummaryCollapsed(!commitReviewSummaryCollapsed);
      return;
    }

    const openBtn = event.target instanceof Element ? event.target.closest("[data-commit-review-open]") : null;
    if (openBtn) {
      const sha = (openBtn.getAttribute("data-commit-review-open") || "").trim();
      if (!sha) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (isCodeReviewsWorkspace()) {
        openCodeReviewCommitDetail(sha);
        return;
      }
      selectCommitForDetails(sha);
      return;
    }

    const requestBtn = event.target instanceof Element ? event.target.closest("[data-commit-review-request]") : null;
    if (requestBtn) {
      const sha = (requestBtn.getAttribute("data-commit-review-request") || "").trim();
      if (!sha) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (isCodeReviewsWorkspace()) {
        runCommitReviewRequest(sha).catch(() => { });
        return;
      }
      if (sha !== selectedCommitSha || currentFiles.length === 0) {
        selectCommitForDetails(sha);
      }
      window.setTimeout(() => {
        openReviewModal("run");
      }, 0);
      return;
    }

    const jumpBtn = event.target instanceof Element ? event.target.closest("[data-commit-review-jump]") : null;
    if (!jumpBtn) {
      return;
    }

    const sha = (jumpBtn.getAttribute("data-commit-review-jump") || "").trim();
    if (!sha) {
      return;
    }

    if (isCodeReviewsWorkspace()) {
      openCodeReviewCommitDetail(sha);
      return;
    }
    selectCommitForDetails(sha);
  });

  commitReviewSummaryNode.addEventListener("keydown", (event) => {
    if (event.isComposing) {
      return;
    }

    const row = event.target instanceof Element ? event.target.closest("[data-commit-review-jump]") : null;
    if (!row) {
      return;
    }

    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    const sha = (row.getAttribute("data-commit-review-jump") || "").trim();
    if (!sha) {
      return;
    }
    if (isCodeReviewsWorkspace()) {
      openCodeReviewCommitDetail(sha);
      return;
    }
    selectCommitForDetails(sha);
  });

  contextSelect.addEventListener("change", () => {
    const nextMode = normalizeContextMode(contextSelect.value);
    if (nextMode === currentContextMode) {
      return;
    }

    currentContextMode = nextMode;
    try {
      window.localStorage.setItem(STORAGE_CONTEXT_MODE_KEY, currentContextMode);
    } catch {
    }
    lastRenderKey = "";
    queueRefresh({ force: true });
  });

  queueReviewBtn.addEventListener("click", () => {
    openReviewModal();
  });

  runReviewBtn.addEventListener("click", () => {
    openReviewModal();
  });

  sendNotesBtn.addEventListener("click", () => {
    sendCurrentNotesToPrompt();
  });

  if (reviewModalReady) {
    if (reviewModalRunBtn) {
      reviewModalRunBtn.classList.add("hidden");
      reviewModalRunBtn.setAttribute("aria-hidden", "true");
    }

    reviewModalQueueBtn.addEventListener("click", () => {
      submitReviewFromModal().catch(() => { });
    });

    if (reviewModalRunBtn) {
      reviewModalRunBtn.addEventListener("click", () => {
        submitReviewFromModal().catch(() => { });
      });
    }

    reviewModalCancelBtn.addEventListener("click", () => {
      closeReviewModal({ keepDraft: true });
    });

    reviewModal.addEventListener("click", (event) => {
      if (event.target === reviewModal) {
        closeReviewModal({ keepDraft: true });
      }
    });

    reviewModalTextarea.addEventListener("keydown", (event) => {
      if (event.isComposing) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        closeReviewModal({ keepDraft: true });
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        submitReviewFromModal().catch(() => { });
      }
    });

    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !reviewModal.classList.contains("hidden")) {
        event.preventDefault();
        closeReviewModal({ keepDraft: true });
      }
    });
  }

  if (fullFileWindowReady) {
    fullFileCloseBtn.addEventListener("click", () => {
      closeFullFileWindow();
    });

    fullFileClassSelect.addEventListener("change", () => {
      const className = typeof fullFileClassSelect.value === "string" ? fullFileClassSelect.value : "";
      fullFileViewerState.selectedClass = className;
      fullFileViewerState.selectedMethodKey = "";
      renderFullFileWindowMethodOptions();
      const classEntry = findFullFileClassByName(className);
      if (classEntry && Number.isFinite(classEntry.lineNo)) {
        jumpFullFileWindowToLine(classEntry.lineNo);
      }
    });

    fullFileMethodSelect.addEventListener("change", () => {
      const methodKey = typeof fullFileMethodSelect.value === "string" ? fullFileMethodSelect.value : "";
      fullFileViewerState.selectedMethodKey = methodKey;
      const methodEntry = findFullFileMethodByKey(methodKey);
      if (methodEntry && Number.isFinite(methodEntry.lineNo)) {
        jumpFullFileWindowToLine(methodEntry.lineNo);
      }
    });

    fullFileBody.addEventListener("click", (event) => {
      if (ignoreNextFullFileLineClick) {
        ignoreNextFullFileLineClick = false;
        return;
      }

      const lineNode = event.target instanceof Element ? event.target.closest("[data-full-window-line]") : null;
      if (!lineNode) {
        return;
      }

      const lineNo = Number.parseInt(lineNode.getAttribute("data-full-window-line") || "", 10);
      const lineText = lineNode.getAttribute("data-full-window-line-text") || "";
      if (!fullFileViewerState.path || !Number.isFinite(lineNo) || lineNo <= 0) {
        return;
      }

      setFullFileNoteTarget({
        path: fullFileViewerState.path,
        startLine: lineNo,
        endLine: lineNo,
        snippet: (lineText || "").trim(),
        origin: "file"
      }, { focus: true });
    });

    fullFileBody.addEventListener("mouseup", () => {
      const targets = collectFullFileSelectionTargets();
      if (!Array.isArray(targets) || targets.length === 0) {
        return;
      }

      ignoreNextFullFileLineClick = true;
      setFullFileNoteTarget(targets[0], { focus: true, resetDraft: true });
      const selection = window.getSelection ? window.getSelection() : null;
      if (selection && typeof selection.removeAllRanges === "function") {
        selection.removeAllRanges();
      }
    });

    fullFileNoteTextarea.addEventListener("input", () => {
      const target = fullFileViewerState.selectedNoteTarget;
      if (!target) {
        fullFileViewerState.noteDraftKey = "";
        fullFileViewerState.noteDraftText = "";
        fullFileViewerState.noteDraftDirty = false;
        return;
      }

      fullFileViewerState.noteDraftKey = buildNoteKey(target.path, target.startLine, target.endLine, "file");
      fullFileViewerState.noteDraftText = fullFileNoteTextarea.value || "";
      fullFileViewerState.noteDraftDirty = true;
      fullFileNoteSaveBtn.disabled = false;
      fullFileNoteSendBtn.disabled = !fullFileViewerState.noteDraftText.trim() && notesByKey.size === 0;
    });

    fullFileNoteSaveBtn.addEventListener("click", () => {
      saveFullFilePanelNote();
    });

    fullFileNoteRemoveBtn.addEventListener("click", () => {
      removeFullFilePanelNote();
    });

    fullFileNoteSendBtn.addEventListener("click", () => {
      sendCurrentNotesToPrompt();
    });

    fullFileReviewPanel.addEventListener("click", (event) => {
      handleReviewJumpFromEvent(event);
    });

    fullFileWindow.addEventListener("click", (event) => {
      if (event.target === fullFileWindow) {
        closeFullFileWindow();
      }
    });

    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !fullFileWindow.classList.contains("hidden")) {
        closeFullFileWindow();
      }
    });
  }

  refreshBtn.addEventListener("click", () => {
    fetchAndRenderDiff(true).catch(() => { });
  });

  listNode.addEventListener("toggle", (event) => {
    const details = event.target instanceof Element ? event.target.closest("details[data-diff-path]") : null;
    if (!details) {
      return;
    }

    const path = details.getAttribute("data-diff-path") || "";
    if (!path) {
      return;
    }
    fileOpenStateByPath.set(path, details.open === true);
  });

  listNode.addEventListener("click", (event) => {
    if (ignoreNextLineClick) {
      ignoreNextLineClick = false;
      return;
    }

    const jumpBtn = event.target instanceof Element ? event.target.closest("[data-note-jump='1']") : null;
    if (jumpBtn) {
      const path = jumpBtn.getAttribute("data-note-path") || "";
      const lineNo = Number.parseInt(jumpBtn.getAttribute("data-note-start") || "", 10);
      if (path && Number.isFinite(lineNo) && lineNo > 0) {
        jumpToNotedLine(path, lineNo);
      }
      return;
    }

    const fullFileBtn = event.target instanceof Element ? event.target.closest("[data-open-full-file='1']") : null;
    if (fullFileBtn) {
      event.preventDefault();
      const path = fullFileBtn.getAttribute("data-open-full-file-path") || "";
      if (path) {
        openFullFileWindow(path).catch(() => { });
      }
      return;
    }

    const lineNode = event.target instanceof Element ? event.target.closest("[data-diff-line-no]") : null;
    if (!lineNode) {
      return;
    }

    const fileNode = lineNode.closest("details[data-diff-path]");
    if (!fileNode) {
      return;
    }

    const path = fileNode.getAttribute("data-diff-path") || "";
    const lineNo = Number.parseInt(lineNode.getAttribute("data-diff-line-no") || "", 10);
    const lineText = lineNode.getAttribute("data-diff-line-text") || "";
    if (!path || !Number.isFinite(lineNo) || lineNo <= 0) {
      return;
    }
    if (noteModalReady) {
      openNoteModal(path, lineNo, lineNo, (lineText || "").trim(), "diff");
    }
  });

  listNode.addEventListener("mouseup", () => {
    if (!noteModalReady) {
      return;
    }

    const targets = collectSelectionTargets();
    if (!Array.isArray(targets) || targets.length === 0) {
      return;
    }

    ignoreNextLineClick = true;
    openNoteModalForTargets(targets);
    const selection = window.getSelection ? window.getSelection() : null;
    if (selection && typeof selection.removeAllRanges === "function") {
      selection.removeAllRanges();
    }
  });

  reviewFindingsNode.addEventListener("click", (event) => {
    const collapseBtn = event.target instanceof Element ? event.target.closest("[data-review-panel-collapse='1']") : null;
    if (collapseBtn) {
      setReviewPanelCollapsed(!reviewPanelCollapsed);
      return;
    }

    const doneReviewBtn = event.target instanceof Element ? event.target.closest("[data-review-scope-done='1']") : null;
    if (doneReviewBtn) {
      const scopeKey = getCurrentScopeKey();
      const doneScope = window.codexDiffMarkReviewScopeDone;
      const refreshCatalog = window.codexDiffRefreshReviewCatalog;
      const context = getActiveContext();
      if (!scopeKey || typeof doneScope !== "function") {
        return;
      }

      Promise.resolve(doneScope(scopeKey))
        .catch(() => { })
        .then(async () => {
          if (context && context.cwd && typeof refreshCatalog === "function") {
            await refreshCatalog(context.cwd, { force: true }).catch(() => { });
          }
          ensureReviewFindingStateScope(scopeKey);
          rerenderFilesPreserveView();
          rerenderFullFileWindowIfOpen();
          renderCommitReviewSummary();
          renderCommitOptions();
        });
      return;
    }

    const sendNotesBtn = event.target instanceof Element ? event.target.closest("[data-review-send-notes='1']") : null;
    if (sendNotesBtn) {
      sendCurrentNotesToPrompt();
      return;
    }

    if (!handleReviewJumpFromEvent(event)) {
      return;
    }
  });

  document.addEventListener("click", (event) => {
    if (event.defaultPrevented) {
      return;
    }
    const targetElement = getEventTargetElement(event);
    if (!targetElement) {
      return;
    }
    if (!targetElement.closest("#diffReviewFindings, #diffFullFileReviewPanel")) {
      return;
    }
    handleReviewJumpFromEvent(event);
  });

  composerNotesNode.addEventListener("click", (event) => {
    const removeBtn = event.target instanceof Element ? event.target.closest("[data-diff-note-remove]") : null;
    if (removeBtn) {
      const key = removeBtn.getAttribute("data-diff-note-remove") || "";
      if (key && notesByKey.has(key)) {
        notesByKey.delete(key);
        saveNotesForScope(currentNotesScopeKey);
        updateSummary(currentTotalChangeCount);
        rerenderFilesPreserveView();
        rerenderFullFileWindowIfOpen();
        renderComposerNotes();
      }
      return;
    }

    const clearBtn = event.target instanceof Element ? event.target.closest("[data-diff-note-clear='1']") : null;
    if (!clearBtn) {
      return;
    }

    notesByKey.clear();
    saveNotesForScope(currentNotesScopeKey);
    updateSummary(currentTotalChangeCount);
    rerenderFilesPreserveView();
    rerenderFullFileWindowIfOpen();
    renderComposerNotes();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      queueRefresh({ force: true });
      return;
    }
  });

  if (noteModalReady) {
    noteModalSaveBtn.addEventListener("click", () => {
      saveNoteFromModal();
    });

    noteModalRemoveBtn.addEventListener("click", () => {
      removeNoteFromModal();
    });

    noteModalCancelBtn.addEventListener("click", () => {
      closeNoteModal();
    });

    noteModal.addEventListener("click", (event) => {
      if (event.target === noteModal) {
        closeNoteModal();
      }
    });

    noteModalTextarea.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        saveNoteFromModal();
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        closeNoteModal();
      }
    });

    noteModalTitle.addEventListener("mousedown", startModalDrag);
    noteModalPath.addEventListener("mousedown", startModalDrag);
    window.addEventListener("mousemove", continueModalDrag);
    window.addEventListener("mouseup", endModalDrag);
  }

  window.addEventListener("codex:reviews-updated", () => {
    rerenderFilesPreserveView();
    rerenderFullFileWindowIfOpen();
    renderCommitOptions();
  });

  if (workspaceMode === "code_reviews") {
    currentMode = "commit";
    reviewPageMode = "list";
    selectedCommitSha = "";
    selectedCommitInfo = null;
  }
  renderCommitOptions();
  applyModeUiState();
  applyPanelState();
  renderComposerNotes();
  queueRefresh({ force: true });
})();
