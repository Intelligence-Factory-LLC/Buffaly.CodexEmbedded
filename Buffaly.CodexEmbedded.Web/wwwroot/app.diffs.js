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
  const composerNotesNode = document.getElementById("diffNotesComposer");
  const noteModal = document.getElementById("diffNoteModal");
  const noteModalPath = document.getElementById("diffNoteModalPath");
  const noteModalTextarea = document.getElementById("diffNoteModalTextarea");
  const noteModalSaveBtn = document.getElementById("diffNoteModalSaveBtn");
  const noteModalRemoveBtn = document.getElementById("diffNoteModalRemoveBtn");
  const noteModalCancelBtn = document.getElementById("diffNoteModalCancelBtn");
  const noteModalCard = noteModal ? noteModal.querySelector(".diff-note-modal-card") : null;
  const noteModalTitle = document.getElementById("diffNoteModalTitle");

  if (!panel || !summaryNode || !listNode || !refreshBtn || !toggleBtn || !indicatorBtn || !indicatorCountNode || !modeWorktreeBtn || !modeCommitBtn || !commitSelect || !composerNotesNode) {
    return;
  }

  const noteModalReady = !!(noteModal && noteModalPath && noteModalTextarea && noteModalSaveBtn && noteModalRemoveBtn && noteModalCancelBtn && noteModalCard && noteModalTitle);

  const REFRESH_DEBOUNCE_MS = 120;
  const MAX_LINES_PER_FILE = 280;
  const STORAGE_NOTES_PREFIX = "codex-worktree-diff-notes-v2::";

  let pollInFlight = false;
  let refreshTimer = null;
  let refreshPendingForce = false;
  let lastRenderKey = "";
  let lastCwd = "";
  let currentRepoRoot = "";
  let currentBranch = "";
  let currentMode = "worktree";
  let availableCommits = [];
  let selectedCommitSha = "";
  let selectedCommitInfo = null;
  let currentNotesScopeKey = "";
  let currentFileViewScopeKey = "";
  let panelAvailable = false;
  let currentFiles = [];
  let hasVisibleChanges = false;
  let isExpanded = false;
  let notesByKey = new Map();
  let currentNoteEdit = null;
  let ignoreNextLineClick = false;
  let fileOpenStateByPath = new Map();
  let modalOffset = { x: 0, y: 0 };
  let modalDragState = null;
  let missingContextLogged = false;
  let lastContextState = "unknown";

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
    summaryNode.textContent = message;
    listNode.innerHTML = `<div class="worktree-diff-empty">${escapeHtml(message)}</div>`;
    applyPanelState();
    renderComposerNotes();
  }

  function updateSummary(changeCount) {
    const notesCount = notesByKey.size;
    const branch = currentBranch || "detached";
    if (currentMode === "commit") {
      const commitLabel = getActiveCommitLabel();
      summaryNode.textContent = `${changeCount} file change(s) in ${commitLabel}${notesCount > 0 ? ` | ${notesCount} note(s) queued` : ""}`;
      return;
    }

    summaryNode.textContent = `${changeCount} file change(s) in working tree on ${branch}${notesCount > 0 ? ` | ${notesCount} note(s) queued` : ""}`;
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
      const noteMarkup = buildFileNotesMarkup(file.path);
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
            return `<span class="${classes.join(" ")}" data-diff-line-no="${lineNo}" data-diff-line-text="${escapeHtml(line)}" title="Click to add note. Shift-click to select a range.">${escapeHtml(line)}</span>`;
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
    updateSummary(currentFiles.length);
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
    updateSummary(currentFiles.length);
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
      `- mode=${currentMode}; branch=${currentBranch || "detached"}${currentMode === "commit" && selectedCommitSha ? `; commit=${selectedCommitSha}` : ""}`,
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
    updateSummary(currentFiles.length);
    rerenderFilesPreserveView();
    renderComposerNotes();

    return {
      metadataText: lines.join("\n"),
      noteCount: ordered.length
    };
  }

  window.codexDiffNotesConsumePromptMetadata = consumePromptMetadata;
  window.codexDiffNotesHasPending = () => notesByKey.size > 0;

  async function fetchCurrentWorktreeSnapshot(context, force) {
    const url = new URL("api/worktree/diff/current", document.baseURI);
    url.searchParams.set("cwd", context.cwd);
    url.searchParams.set("maxFiles", "240");
    url.searchParams.set("maxPatchChars", "800000");
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
        ignoreNextLineClick = false;
        currentFileViewScopeKey = scopeKey;
      }

      const renderKey = [
        context.cwd,
        currentMode,
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
      hasVisibleChanges = files.length > 0;
      currentFiles = files;
      captureFileOpenState();
      if (hasVisibleChanges) {
        renderFiles(files);
      } else {
        listNode.innerHTML = currentMode === "commit"
          ? "<div class=\"worktree-diff-empty\">No file changes in selected commit.</div>"
          : "<div class=\"worktree-diff-empty\">Working tree is clean.</div>";
      }
      updateSummary(files.length);
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
      ignoreNextLineClick = false;
      summaryNode.textContent = `Diff load failed: ${message}`;
      listNode.innerHTML = `<div class="worktree-diff-empty">${escapeHtml(`Diff load failed: ${message}`)}</div>`;
      applyPanelState();
      renderComposerNotes();
    } finally {
      refreshBtn.disabled = false;
      pollInFlight = false;
      commitSelect.disabled = currentMode !== "commit" || availableCommits.length === 0;
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
        updateSummary(currentFiles.length);
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
    updateSummary(currentFiles.length);
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
