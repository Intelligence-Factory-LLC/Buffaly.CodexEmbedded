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
  const composerNotesNode = document.getElementById("diffNotesComposer");
  const noteModal = document.getElementById("diffNoteModal");
  const noteModalPath = document.getElementById("diffNoteModalPath");
  const noteModalTextarea = document.getElementById("diffNoteModalTextarea");
  const noteModalSaveBtn = document.getElementById("diffNoteModalSaveBtn");
  const noteModalRemoveBtn = document.getElementById("diffNoteModalRemoveBtn");
  const noteModalCancelBtn = document.getElementById("diffNoteModalCancelBtn");
  const noteModalCard = noteModal ? noteModal.querySelector(".diff-note-modal-card") : null;
  const noteModalTitle = document.getElementById("diffNoteModalTitle");

  if (!panel || !summaryNode || !listNode || !refreshBtn || !toggleBtn || !indicatorBtn || !indicatorCountNode || !modeWorktreeBtn || !modeCommitBtn || !commitSelect || !contextSelect || !composerNotesNode) {
    return;
  }

  const noteModalReady = !!(noteModal && noteModalPath && noteModalTextarea && noteModalSaveBtn && noteModalRemoveBtn && noteModalCancelBtn && noteModalCard && noteModalTitle);

  const REFRESH_DEBOUNCE_MS = 120;
  const MAX_LINES_PER_FILE = 280;
  const STORAGE_NOTES_PREFIX = "codex-worktree-diff-notes-v2::";
  const STORAGE_CONTEXT_MODE_KEY = "codex-worktree-diff-context-mode-v1";
  const CONTEXT_MODE_VALUES = new Set(["3", "10", "30", "full"]);

  let pollInFlight = false;
  let refreshTimer = null;
  let refreshPendingForce = false;
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
  let fileDrawerStateByPath = new Map();
  let currentNoteEdit = null;
  let ignoreNextLineClick = false;
  let fileOpenStateByPath = new Map();
  let modalOffset = { x: 0, y: 0 };
  let modalDragState = null;
  let missingContextLogged = false;
  let lastContextState = "unknown";
  try {
    currentContextMode = normalizeContextMode(window.localStorage.getItem(STORAGE_CONTEXT_MODE_KEY) || "3");
  } catch {
    currentContextMode = "3";
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

  function buildNoteKey(path, startLine, endLine) {
    return `${path}::${startLine}-${endLine}`;
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
      snippet: typeof item.snippet === "string" ? item.snippet : ""
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
          buildNoteKey(normalized.path, normalized.startLine, normalized.endLine),
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
        snippet: x.snippet || ""
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
    commitSelect.classList.toggle("hidden", !isCommitMode);
    contextSelect.value = normalizeContextMode(currentContextMode);
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
    const showPanel = isExpanded;
    panel.classList.toggle("hidden", !showPanel);
    panel.classList.toggle("worktree-diff-collapsed", false);
    panel.classList.toggle("worktree-diff-fullscreen", isExpanded);
    toggleBtn.textContent = "Close";
    toggleBtn.setAttribute("aria-expanded", showPanel ? "true" : "false");
    toggleBtn.disabled = false;
    indicatorBtn.classList.toggle("hidden", false);
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
      return;
    }

    if (!Array.isArray(availableCommits) || availableCommits.length === 0) {
      commitSelect.innerHTML = "<option value=\"\">No recent commits</option>";
      commitSelect.disabled = true;
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
      const label = `${normalized.shortSha} ${subject}`;
      const title = when
        ? `${normalized.sha} | ${author} | ${when}`
        : `${normalized.sha} | ${author}`;
      options.push(`<option value="${escapeAttribute(normalized.sha)}" title="${escapeAttribute(title)}">${escapeHtml(label)}</option>`);
    }

    if (options.length === 0) {
      commitSelect.innerHTML = "<option value=\"\">No recent commits</option>";
      commitSelect.disabled = true;
      return;
    }

    commitSelect.innerHTML = options.join("");
    if (!selectedCommitSha || !availableCommits.some((x) => (x && typeof x.sha === "string" && x.sha === selectedCommitSha))) {
      selectedCommitSha = availableCommits[0].sha;
    }

    commitSelect.value = selectedCommitSha;
    commitSelect.disabled = pollInFlight !== false;
  }

  function setDiffMode(mode) {
    const nextMode = mode === "commit" ? "commit" : "worktree";
    if (currentMode === nextMode) {
      return;
    }

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
      return;
    }

    const pills = notes.map((note) => {
      const key = buildNoteKey(note.path, note.startLine, note.endLine);
      const prefix = formatLineSpan(note.startLine, note.endLine);
      const text = `${prefix} ${note.path}: ${note.note}`;
      return `<span class="diff-notes-composer-pill" title="${escapeAttribute(text)}">
        <span class="diff-notes-composer-pill-text">${escapeHtml(text)}</span>
        <button type="button" class="diff-notes-composer-pill-remove" data-diff-note-remove="${escapeAttribute(key)}" aria-label="Remove diff note">&times;</button>
      </span>`;
    }).join("");

    composerNotesNode.innerHTML = `<span class="diff-notes-composer-label">Diff notes (${notes.length})</span>${pills}<button type="button" class="diff-notes-composer-clear" data-diff-note-clear="1">Clear</button>`;
    composerNotesNode.classList.remove("hidden");
  }

  function setEmptyState(message) {
    hasVisibleChanges = false;
    currentFiles = [];
    currentTotalChangeCount = 0;
    hiddenBinaryFileCount = 0;
    summaryNode.textContent = message;
    listNode.innerHTML = `<div class="worktree-diff-empty">${escapeHtml(message)}</div>`;
    applyPanelState();
    renderComposerNotes();
  }

  function updateSummary(changeCount) {
    const notesCount = notesByKey.size;
    const branch = currentBranch || "detached";
    const contextLabel = contextModeLabel(currentContextMode);
    const hiddenBinaryText = hiddenBinaryFileCount > 0 ? ` | ${hiddenBinaryFileCount} binary hidden` : "";
    if (currentMode === "commit") {
      const commitLabel = getActiveCommitLabel();
      summaryNode.textContent = `${changeCount} file change(s) in ${commitLabel} | context ${contextLabel}${hiddenBinaryText}${notesCount > 0 ? ` | ${notesCount} note(s) queued` : ""}`;
      return;
    }

    summaryNode.textContent = `${changeCount} file change(s) in working tree on ${branch} | context ${contextLabel}${hiddenBinaryText}${notesCount > 0 ? ` | ${notesCount} note(s) queued` : ""}`;
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

  function hunkHeaderContext(line) {
    if (typeof line !== "string" || !line.startsWith("@@")) {
      return "";
    }

    const match = line.match(/^@@\s*-[^ ]+\s+\+[^ ]+\s*@@\s*(.*)$/);
    return match && typeof match[1] === "string" ? match[1].trim() : "";
  }

  function buildHunkBreadcrumbByLineNo(patchLines) {
    const breadcrumbs = new Map();
    if (!Array.isArray(patchLines) || patchLines.length === 0) {
      return breadcrumbs;
    }

    let currentClass = "";
    for (let i = 0; i < patchLines.length; i += 1) {
      const line = typeof patchLines[i] === "string" ? patchLines[i] : "";
      const classFromLine = extractClassName(line);
      if (classFromLine) {
        currentClass = classFromLine;
      }

      if (!line.startsWith("@@")) {
        continue;
      }

      const context = hunkHeaderContext(line);
      let className = extractClassName(context) || currentClass;
      let methodName = extractMethodName(context);
      if (!methodName) {
        for (let j = i + 1; j < Math.min(i + 14, patchLines.length); j += 1) {
          const candidate = extractMethodName(patchLines[j]);
          if (candidate) {
            methodName = candidate;
            break;
          }
        }
      }
      if (!className) {
        for (let j = i; j >= Math.max(i - 20, 0); j -= 1) {
          const candidateClass = extractClassName(patchLines[j]);
          if (candidateClass) {
            className = candidateClass;
            break;
          }
        }
      }

      const breadcrumb = className && methodName
        ? `${className} > ${methodName}`
        : (className || methodName || "scope");
      breadcrumbs.set(i + 1, breadcrumb);
    }

    return breadcrumbs;
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

  function drawerStateForPath(path) {
    if (!fileDrawerStateByPath.has(path)) {
      fileDrawerStateByPath.set(path, {
        open: false,
        loading: false,
        loaded: false,
        content: "",
        changedLines: new Set(),
        firstChangedLine: 1,
        exists: true,
        isBinary: false,
        isTruncated: false,
        message: "",
        error: ""
      });
    }

    return fileDrawerStateByPath.get(path);
  }

  function buildFullFileDrawerMarkup(file) {
    const state = fileDrawerStateByPath.get(file.path);
    const isOpen = state && state.open === true;
    const actionLabel = isOpen ? "Hide Full File" : "Open Full File";
    const disabled = state && state.loading === true;
    const actionMarkup = `<div class="worktree-diff-detail-actions"><button type="button" class="worktree-diff-open-file-btn" data-open-full-file="1" data-open-full-file-path="${escapeAttribute(file.path)}"${disabled ? " disabled" : ""}>${actionLabel}</button></div>`;
    if (!isOpen) {
      return actionMarkup;
    }

    if (!state) {
      return `${actionMarkup}<div class="worktree-diff-file-empty">File view unavailable.</div>`;
    }

    if (state.loading) {
      return `${actionMarkup}<div class="worktree-diff-file-empty">Loading file content...</div>`;
    }

    if (state.error) {
      return `${actionMarkup}<div class="worktree-diff-file-empty">${escapeHtml(state.error)}</div>`;
    }

    if (state.exists !== true) {
      return `${actionMarkup}<div class="worktree-diff-file-empty">${escapeHtml(state.message || "File not found.")}</div>`;
    }

    if (state.isBinary === true) {
      return `${actionMarkup}<div class="worktree-diff-file-empty">${escapeHtml(state.message || "Binary file cannot be displayed inline.")}</div>`;
    }

    const rawLines = typeof state.content === "string" ? state.content.split(/\r?\n/) : [];
    if (rawLines.length === 0) {
      return `${actionMarkup}<div class="worktree-diff-file-empty">File content is empty.</div>`;
    }

    const bodyMarkup = rawLines.map((line, index) => {
      const lineNo = index + 1;
      const lineClass = state.changedLines && state.changedLines.has(lineNo)
        ? "worktree-diff-file-line worktree-diff-file-line-changed"
        : "worktree-diff-file-line";
      return `<div class="${lineClass}" data-full-file-line="${lineNo}">
        <span class="worktree-diff-file-line-no">${lineNo}</span>
        <span class="worktree-diff-file-line-text">${escapeHtml(line)}</span>
      </div>`;
    }).join("");

    const drawerTitle = state.isTruncated === true
      ? `${file.path} (truncated)`
      : file.path;
    return `${actionMarkup}
      <div class="worktree-diff-file-drawer" data-full-file-drawer="${escapeAttribute(file.path)}">
        <div class="worktree-diff-file-drawer-header">${escapeHtml(drawerTitle)}</div>
        <div class="worktree-diff-file-drawer-body">${bodyMarkup}</div>
      </div>`;
  }

  function notesForPath(path) {
    return Array.from(notesByKey.values())
      .filter((x) => x.path === path)
      .sort((a, b) => {
        if (a.startLine !== b.startLine) {
          return a.startLine - b.startLine;
        }
        return a.endLine - b.endLine;
      });
  }

  function hasLineNote(path, lineNo) {
    const notes = notesForPath(path);
    for (const note of notes) {
      if (lineNo >= note.startLine && lineNo <= note.endLine) {
        return true;
      }
    }
    return false;
  }

  function buildFileNotesMarkup(path) {
    const notes = notesForPath(path);
    if (notes.length === 0) {
      return "";
    }

    const items = notes.map((x) => {
      const lineText = formatLineSpan(x.startLine, x.endLine);
      const noteTitle = escapeHtml(x.note);
      return `<button type="button" class="worktree-diff-note-pill" data-note-jump="1" data-note-path="${escapeHtml(path)}" data-note-start="${x.startLine}" data-note-end="${x.endLine}" title="${noteTitle}">${lineText}: ${noteTitle}</button>`;
    }).join("");

    return `<div class="worktree-diff-note-list">${items}</div>`;
  }

  function renderFiles(files) {
    currentFiles = Array.isArray(files) ? files : [];
    if (currentFiles.length === 0) {
      listNode.innerHTML = "";
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
      const hunkBreadcrumbByLineNo = buildHunkBreadcrumbByLineNo(shownLines);
      const noteMarkup = buildFileNotesMarkup(file.path);
      const drawerMarkup = buildFullFileDrawerMarkup(file);
      const lineMarkup = isBinary
        ? `<span class="watcher-diff-line">Binary file changed. Diff body is hidden.</span>`
        : shownLines.length > 0
          ? shownLines.map((line, index) => {
            const lineNo = index + 1;
            const lineClass = classForDiffLine(line);
            const lineHasNote = hasLineNote(file.path, lineNo);
            const classes = ["watcher-diff-line", "worktree-diff-line-clickable"];
            if (lineClass) {
              classes.push(lineClass);
            }
            if (lineHasNote) {
              classes.push("worktree-diff-line-noted");
            }
            const breadcrumb = hunkBreadcrumbByLineNo.get(lineNo) || "";
            const breadcrumbMarkup = line.startsWith("@@") && breadcrumb
              ? `<span class="worktree-diff-hunk-breadcrumb">${escapeHtml(breadcrumb)}</span>`
              : "";
            return `<span class="${classes.join(" ")}" data-diff-line-no="${lineNo}" data-diff-line-text="${escapeHtml(line)}" title="Click to add note. Shift-click to select a range.">${escapeHtml(line)}${breadcrumbMarkup}</span>`;
          }).join("")
          : `<span class="watcher-diff-line">No patch available for this file yet.</span>`;

      const isOpen = fileOpenStateByPath.get(file.path) === true;
      html.push(
        `<details class="worktree-diff-file" data-diff-path="${pathLabel}"${isOpen ? " open" : ""}>
          <summary>
            <span class="worktree-diff-code" title="${statusLabel}">${statusCode}</span>
            <span class="worktree-diff-path" title="${pathLabel}">${pathLabel}</span>
            <span class="worktree-diff-stat" aria-label="Diff stat">
              <span class="worktree-diff-stat-add">+${diffStat.added}</span>
              <span class="worktree-diff-stat-remove">-${diffStat.removed}</span>
            </span>
          </summary>
          <div class="worktree-diff-detail">
            ${originalPath ? `<div class="worktree-diff-truncated">Renamed from ${originalPath}</div>` : ""}
            ${noteMarkup}
            ${drawerMarkup}
            <pre class="worktree-diff-pre">${lineMarkup}</pre>
            ${truncated ? `<p class="worktree-diff-truncated">Patch truncated to ${MAX_LINES_PER_FILE} lines.</p>` : ""}
          </div>
        </details>`
      );
    }

    listNode.innerHTML = html.join("");
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

  function applyNoteToState(path, startLine, endLine, note, snippet) {
    const key = buildNoteKey(path, startLine, endLine);
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
      snippet: snippet || ""
    });
  }

  function openNoteModal(path, startLine, endLine, snippet) {
    if (!noteModalReady) {
      return;
    }

    const key = buildNoteKey(path, startLine, endLine);
    const existing = notesByKey.get(key);
    const initial = existing && typeof existing.note === "string" ? existing.note : "";
    const lineLabel = formatLineSpan(startLine, endLine).replace("L", "diff line ");

    currentNoteEdit = {
      path,
      startLine,
      endLine,
      snippet: snippet || ""
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
        snippet: x.snippet || ""
      }))
    };

    if (targets.length === 1) {
      const only = targets[0];
      const key = buildNoteKey(only.path, only.startLine, only.endLine);
      const existing = notesByKey.get(key);
      const initial = existing && typeof existing.note === "string" ? existing.note : "";
      const lineLabel = formatLineSpan(only.startLine, only.endLine).replace("L", "diff line ");
      noteModalPath.textContent = `${only.path} (${lineLabel})`;
      noteModalTextarea.value = initial;
      noteModalRemoveBtn.disabled = !notesByKey.has(key);
    } else {
      const fileCount = new Set(targets.map((x) => x.path)).size;
      const anyExisting = targets.some((x) => notesByKey.has(buildNoteKey(x.path, x.startLine, x.endLine)));
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
        snippet: x.snippets.filter(Boolean).join("\n").trim()
      }))
      .sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine);

    return targets;
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
        target.snippet
      );
    }

    saveNotesForScope(currentNotesScopeKey);
    updateSummary(currentTotalChangeCount);
    rerenderFilesPreserveView();
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
      notesByKey.delete(buildNoteKey(target.path, target.startLine, target.endLine));
    }
    saveNotesForScope(currentNotesScopeKey);
    updateSummary(currentTotalChangeCount);
    rerenderFilesPreserveView();
    renderComposerNotes();
    closeNoteModal();
  }

  function consumePromptMetadata() {
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
      "[Diff line notes]"
    ];
    for (const item of ordered) {
      const linePart = item.startLine === item.endLine
        ? `diffLine=${item.startLine}`
        : `diffLineStart=${item.startLine}; diffLineEnd=${item.endLine}`;
      const base = `- file=${item.path}; ${linePart}; note=${item.note}`;
      if (item.snippet) {
        lines.push(`${base}; snippet=${item.snippet}`);
      } else {
        lines.push(base);
      }
    }

    notesByKey.clear();
    saveNotesForScope(currentNotesScopeKey);
    updateSummary(currentTotalChangeCount);
    rerenderFilesPreserveView();
    renderComposerNotes();

    return {
      metadataText: lines.join("\n"),
      noteCount: ordered.length
    };
  }

  window.codexDiffNotesConsumePromptMetadata = consumePromptMetadata;
  window.codexDiffNotesHasPending = () => notesByKey.size > 0;

  function scheduleFullFileFocus(path) {
    const state = fileDrawerStateByPath.get(path);
    if (!state || state.open !== true || state.loaded !== true) {
      return;
    }

    const focusLine = Number.isFinite(state.firstChangedLine) && state.firstChangedLine > 0
      ? state.firstChangedLine
      : 1;
    window.setTimeout(() => {
      const drawerNode = listNode.querySelector(`[data-full-file-drawer="${CSS.escape(path)}"]`);
      if (!drawerNode) {
        return;
      }

      const lineNode = drawerNode.querySelector(`[data-full-file-line="${focusLine}"]`);
      if (lineNode && typeof lineNode.scrollIntoView === "function") {
        lineNode.scrollIntoView({ block: "center", behavior: "smooth" });
        return;
      }

      if (typeof drawerNode.scrollTo === "function") {
        drawerNode.scrollTo({ top: 0, behavior: "smooth" });
      }
    }, 40);
  }

  async function loadFullFileDrawerContent(path, patchText) {
    const state = drawerStateForPath(path);
    const activeContext = getActiveContext();
    if (!activeContext || !activeContext.cwd) {
      state.loading = false;
      state.loaded = false;
      state.error = "No active session context.";
      rerenderFilesPreserveView();
      return;
    }

    const changed = collectChangedLinesFromPatch(typeof patchText === "string" ? patchText : "");
    state.changedLines = changed.changed;
    state.firstChangedLine = changed.first;
    state.loading = true;
    state.loaded = false;
    state.error = "";
    rerenderFilesPreserveView();

    try {
      const url = new URL("api/worktree/diff/file", document.baseURI);
      url.searchParams.set("cwd", activeContext.cwd);
      url.searchParams.set("path", path);
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
      state.loading = false;
      state.loaded = true;
      state.exists = data.exists === true;
      state.isBinary = data.isBinary === true;
      state.isTruncated = data.isTruncated === true;
      state.content = typeof data.content === "string" ? data.content : "";
      state.message = typeof data.message === "string" ? data.message : "";
      state.error = "";
      rerenderFilesPreserveView();
      scheduleFullFileFocus(path);
    } catch (error) {
      state.loading = false;
      state.loaded = false;
      state.error = error instanceof Error ? error.message : String(error);
      rerenderFilesPreserveView();
    }
  }

  function toggleFullFileDrawer(path) {
    const file = currentFiles.find((x) => x && typeof x.path === "string" && x.path === path);
    if (!file) {
      return;
    }

    const state = drawerStateForPath(path);
    if (state.open === true) {
      state.open = false;
      rerenderFilesPreserveView();
      return;
    }

    state.open = true;
    const changed = collectChangedLinesFromPatch(typeof file.patch === "string" ? file.patch : "");
    state.changedLines = changed.changed;
    state.firstChangedLine = changed.first;
    rerenderFilesPreserveView();
    if (state.loaded === true) {
      scheduleFullFileFocus(path);
      return;
    }

    loadFullFileDrawerContent(path, typeof file.patch === "string" ? file.patch : "").catch(() => { });
  }

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
      selectedCommitSha = "";
      selectedCommitInfo = null;
      currentNotesScopeKey = "";
      currentFileViewScopeKey = "";
      notesByKey = new Map();
      fileDrawerStateByPath = new Map();
      contextSelect.disabled = false;
      renderCommitOptions();
      applyPanelState();
      renderComposerNotes();
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
      currentRepoRoot = "";
      currentBranch = "";
      currentNotesScopeKey = "";
      currentFileViewScopeKey = "";
      notesByKey = new Map();
      fileOpenStateByPath = new Map();
      fileDrawerStateByPath = new Map();
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

        if (!selectedCommitSha || !availableCommits.some((x) => x.sha === selectedCommitSha)) {
          selectedCommitSha = availableCommits.length > 0 ? availableCommits[0].sha : "";
        }
        selectedCommitInfo = findSelectedCommitInfo();
        renderCommitOptions();

        if (!selectedCommitSha) {
          const scopeKey = buildDiffScopeKey(context.cwd, currentMode, "");
          const notesChanged = switchNotesScope(scopeKey);
          if (notesChanged) {
            renderComposerNotes();
          }
          hasVisibleChanges = false;
          currentFiles = [];
          currentTotalChangeCount = 0;
          hiddenBinaryFileCount = 0;
          updateSummary(0);
          listNode.innerHTML = "<div class=\"worktree-diff-empty\">No recent commits found.</div>";
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
      }

      if (!panelAvailable) {
        setEmptyState("Not a git repository");
        return;
      }

      const scopeKey = buildDiffScopeKey(context.cwd, currentMode, currentMode === "commit" ? selectedCommitSha : "");
      const notesChanged = switchNotesScope(scopeKey);
      if (notesChanged) {
        renderComposerNotes();
      }
      if (scopeKey !== currentFileViewScopeKey) {
        fileOpenStateByPath = new Map();
        fileDrawerStateByPath = new Map();
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

    selectedCommitSha = nextSha;
    selectedCommitInfo = findSelectedCommitInfo();
    lastRenderKey = "";
    queueRefresh({ force: true });
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
        toggleFullFileDrawer(path);
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
      openNoteModal(path, lineNo, lineNo, (lineText || "").trim());
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

  composerNotesNode.addEventListener("click", (event) => {
    const removeBtn = event.target instanceof Element ? event.target.closest("[data-diff-note-remove]") : null;
    if (removeBtn) {
      const key = removeBtn.getAttribute("data-diff-note-remove") || "";
      if (key && notesByKey.has(key)) {
        notesByKey.delete(key);
        saveNotesForScope(currentNotesScopeKey);
        updateSummary(currentTotalChangeCount);
        rerenderFilesPreserveView();
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

  renderCommitOptions();
  applyModeUiState();
  applyPanelState();
  renderComposerNotes();
  queueRefresh({ force: true });
})();
