(function () {
  const panel = document.getElementById("worktreeDiffPanel");
  const summaryNode = document.getElementById("worktreeDiffSummary");
  const listNode = document.getElementById("worktreeDiffList");
  const refreshBtn = document.getElementById("worktreeDiffRefreshBtn");
  const toggleBtn = document.getElementById("worktreeDiffToggleBtn");
  const indicatorBtn = document.getElementById("worktreeDiffIndicatorBtn");
  const indicatorCountNode = document.getElementById("worktreeDiffIndicatorCount");
  const composerNotesNode = document.getElementById("diffNotesComposer");
  const noteModal = document.getElementById("diffNoteModal");
  const noteModalPath = document.getElementById("diffNoteModalPath");
  const noteModalTextarea = document.getElementById("diffNoteModalTextarea");
  const noteModalSaveBtn = document.getElementById("diffNoteModalSaveBtn");
  const noteModalRemoveBtn = document.getElementById("diffNoteModalRemoveBtn");
  const noteModalCancelBtn = document.getElementById("diffNoteModalCancelBtn");
  if (!panel || !summaryNode || !listNode || !refreshBtn || !toggleBtn || !indicatorBtn || !indicatorCountNode || !composerNotesNode ||
    !noteModal || !noteModalPath || !noteModalTextarea || !noteModalSaveBtn || !noteModalRemoveBtn || !noteModalCancelBtn) {
    return;
  }

  const POLL_MS = 5000;
  const MAX_LINES_PER_FILE = 280;
  const STORAGE_NOTES_PREFIX = "codex-worktree-diff-notes-v1::";

  let pollTimer = null;
  let pollInFlight = false;
  let lastRenderKey = "";
  let lastCwd = "";
  let currentBranch = "";
  let currentFiles = [];
  let hasVisibleChanges = false;
  let isExpanded = false;
  let notesByKey = new Map();
  let currentNoteEdit = null;

  function notesStorageKey(cwd) {
    return `${STORAGE_NOTES_PREFIX}${cwd || ""}`;
  }

  function loadNotesForCwd(cwd) {
    const next = new Map();
    if (!cwd) {
      return next;
    }

    try {
      const raw = window.localStorage.getItem(notesStorageKey(cwd));
      if (!raw) {
        return next;
      }

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return next;
      }

      for (const item of parsed) {
        if (!item || typeof item.path !== "string" || !item.path.trim()) {
          continue;
        }
        const lineNo = Number.isFinite(item.lineNo) ? item.lineNo : Number.parseInt(String(item.lineNo || ""), 10);
        if (!Number.isFinite(lineNo) || lineNo <= 0) {
          continue;
        }
        const note = typeof item.note === "string" ? item.note.trim() : "";
        if (!note) {
          continue;
        }
        const snippet = typeof item.snippet === "string" ? item.snippet : "";
        next.set(buildNoteKey(item.path, lineNo), {
          path: item.path,
          lineNo,
          note,
          snippet
        });
      }
    } catch {
    }

    return next;
  }

  function saveNotesForCwd(cwd) {
    if (!cwd) {
      return;
    }

    try {
      const payload = Array.from(notesByKey.values()).map((x) => ({
        path: x.path,
        lineNo: x.lineNo,
        note: x.note,
        snippet: x.snippet || ""
      }));
      window.localStorage.setItem(notesStorageKey(cwd), JSON.stringify(payload));
    } catch {
    }
  }

  function buildNoteKey(path, lineNo) {
    return `${path}::${lineNo}`;
  }

  function getActiveContext() {
    const state = typeof getActiveSessionState === "function" ? getActiveSessionState() : null;
    if (!state) {
      return null;
    }

    const cwd = typeof state.cwd === "string" ? state.cwd.trim() : "";
    const threadId = typeof state.threadId === "string" ? state.threadId.trim() : "";
    if (!cwd) {
      return null;
    }

    return { cwd, threadId };
  }

  function applyPanelState() {
    const showPanel = hasVisibleChanges && isExpanded;
    panel.classList.toggle("hidden", !showPanel);
    panel.classList.toggle("worktree-diff-collapsed", false);
    panel.classList.toggle("worktree-diff-fullscreen", hasVisibleChanges && isExpanded);
    toggleBtn.textContent = "Close";
    toggleBtn.setAttribute("aria-expanded", showPanel ? "true" : "false");
    toggleBtn.disabled = !hasVisibleChanges;
    indicatorBtn.classList.toggle("hidden", !hasVisibleChanges);
    indicatorCountNode.textContent = hasVisibleChanges ? String(currentFiles.length) : "0";
    indicatorBtn.setAttribute("aria-label", hasVisibleChanges
      ? `Open working tree diff (${currentFiles.length} changed file${currentFiles.length === 1 ? "" : "s"})`
      : "Open working tree diff");
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/"/g, "&quot;");
  }

  function renderComposerNotes() {
    const notes = Array.from(notesByKey.values())
      .sort((a, b) => {
        const pathCompare = a.path.localeCompare(b.path);
        if (pathCompare !== 0) {
          return pathCompare;
        }
        return a.lineNo - b.lineNo;
      });

    if (notes.length === 0) {
      composerNotesNode.classList.add("hidden");
      composerNotesNode.innerHTML = "";
      return;
    }

    const pills = notes.map((note) => {
      const key = buildNoteKey(note.path, note.lineNo);
      const text = `L${note.lineNo} ${note.path}: ${note.note}`;
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
    isExpanded = false;
    currentFiles = [];
    summaryNode.textContent = message;
    listNode.innerHTML = "";
    applyPanelState();
    renderComposerNotes();
  }

  function updateSummary(changeCount) {
    const notesCount = notesByKey.size;
    const branch = currentBranch || "detached";
    summaryNode.textContent = `${changeCount} change(s) on ${branch}${notesCount > 0 ? ` | ${notesCount} note(s) queued` : ""}`;
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

  function buildFileNotesMarkup(path) {
    const notes = Array.from(notesByKey.values())
      .filter((x) => x.path === path)
      .sort((a, b) => a.lineNo - b.lineNo);
    if (notes.length === 0) {
      return "";
    }

    const items = notes.map((x) => {
      const noteTitle = escapeHtml(x.note);
      return `<button type=\"button\" class=\"worktree-diff-note-pill\" data-note-jump=\"1\" data-note-path=\"${escapeHtml(path)}\" data-note-line=\"${x.lineNo}\" title=\"${noteTitle}\">L${x.lineNo}: ${noteTitle}</button>`;
    }).join("");

    return `<div class=\"worktree-diff-note-list\">${items}</div>`;
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
      const patchLines = patchText ? patchText.split(/\r?\n/) : [];
      const shownLines = patchLines.slice(0, MAX_LINES_PER_FILE);
      const truncated = patchLines.length > shownLines.length;
      const noteMarkup = buildFileNotesMarkup(file.path);
      const lineMarkup = isBinary
        ? `<span class=\"watcher-diff-line\">Binary file changed. Diff body is hidden.</span>`
        : shownLines.length > 0
          ? shownLines.map((line, index) => {
            const lineNo = index + 1;
            const noteKey = buildNoteKey(file.path, lineNo);
            const lineClass = classForDiffLine(line);
            const hasNote = notesByKey.has(noteKey);
            const classes = ["watcher-diff-line", "worktree-diff-line-clickable"];
            if (lineClass) {
              classes.push(lineClass);
            }
            if (hasNote) {
              classes.push("worktree-diff-line-noted");
            }
            return `<span class=\"${classes.join(" ")}\" data-diff-line-no=\"${lineNo}\" data-diff-line-text=\"${escapeHtml(line)}\" title=\"Click to add or edit a note\">${escapeHtml(line)}</span>`;
          }).join("")
          : `<span class=\"watcher-diff-line\">No patch available for this file yet.</span>`;

      html.push(
        `<details class=\"worktree-diff-file\" data-diff-path=\"${pathLabel}\" open>
          <summary>
            <span class=\"worktree-diff-code\" title=\"${statusLabel}\">${statusCode}</span>
            <span class=\"worktree-diff-path\" title=\"${pathLabel}\">${pathLabel}</span>
          </summary>
          <div class=\"worktree-diff-detail\">
            ${originalPath ? `<div class=\"worktree-diff-truncated\">Renamed from ${originalPath}</div>` : ""}
            ${noteMarkup}
            <pre class=\"worktree-diff-pre\">${lineMarkup}</pre>
            ${truncated ? `<p class=\"worktree-diff-truncated\">Patch truncated to ${MAX_LINES_PER_FILE} lines.</p>` : ""}
          </div>
        </details>`
      );
    }

    listNode.innerHTML = html.join("");
  }

  function jumpToNotedLine(path, lineNo) {
    const details = listNode.querySelector(`details[data-diff-path=\"${CSS.escape(path)}\"]`);
    if (!details) {
      return;
    }
    details.open = true;
    const lineNode = details.querySelector(`[data-diff-line-no=\"${lineNo}\"]`);
    if (!lineNode) {
      return;
    }
    lineNode.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function upsertLineNote(path, lineNo, lineText) {
    currentNoteEdit = {
      path,
      lineNo,
      snippet: (lineText || "").trim()
    };

    const noteKey = buildNoteKey(path, lineNo);
    const existing = notesByKey.get(noteKey);
    const initial = existing && typeof existing.note === "string" ? existing.note : "";
    noteModalPath.textContent = `${path} (diff line ${lineNo})`;
    noteModalTextarea.value = initial;
    noteModal.classList.remove("hidden");
    noteModalRemoveBtn.disabled = !notesByKey.has(noteKey);
    noteModalTextarea.focus();
    noteModalTextarea.setSelectionRange(noteModalTextarea.value.length, noteModalTextarea.value.length);
  }

  function closeNoteModal() {
    noteModal.classList.add("hidden");
    currentNoteEdit = null;
  }

  function saveNoteFromModal() {
    if (!currentNoteEdit) {
      return;
    }

    const cleaned = (noteModalTextarea.value || "").trim();
    const noteKey = buildNoteKey(currentNoteEdit.path, currentNoteEdit.lineNo);
    if (!cleaned) {
      notesByKey.delete(noteKey);
    } else {
      notesByKey.set(noteKey, {
        path: currentNoteEdit.path,
        lineNo: currentNoteEdit.lineNo,
        note: cleaned,
        snippet: currentNoteEdit.snippet
      });
    }

    saveNotesForCwd(lastCwd);
    updateSummary(currentFiles.length);
    renderFiles(currentFiles);
    renderComposerNotes();
    closeNoteModal();
  }

  function removeNoteFromModal() {
    if (!currentNoteEdit) {
      return;
    }

    const noteKey = buildNoteKey(currentNoteEdit.path, currentNoteEdit.lineNo);
    notesByKey.delete(noteKey);
    saveNotesForCwd(lastCwd);
    updateSummary(currentFiles.length);
    renderFiles(currentFiles);
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
        return a.lineNo - b.lineNo;
      });

    const lines = ["[Diff line notes]"];
    for (const item of ordered) {
      const base = `- file=${item.path}; diffLine=${item.lineNo}; note=${item.note}`;
      if (item.snippet) {
        lines.push(`${base}; snippet=${item.snippet}`);
      } else {
        lines.push(base);
      }
    }

    notesByKey.clear();
    saveNotesForCwd(lastCwd);
    updateSummary(currentFiles.length);
    renderFiles(currentFiles);
    renderComposerNotes();

    return {
      metadataText: lines.join("\n"),
      noteCount: ordered.length
    };
  }

  window.codexDiffNotesConsumePromptMetadata = consumePromptMetadata;

  async function fetchAndRenderDiff(force) {
    if (pollInFlight) {
      return;
    }

    const context = getActiveContext();
    if (!context) {
      hasVisibleChanges = false;
      listNode.innerHTML = "";
      summaryNode.textContent = "No active session";
      currentFiles = [];
      isExpanded = false;
      lastRenderKey = "";
      lastCwd = "";
      applyPanelState();
      renderComposerNotes();
      return;
    }

    if (context.cwd !== lastCwd) {
      notesByKey = loadNotesForCwd(context.cwd);
      lastCwd = context.cwd;
      renderComposerNotes();
    }

    pollInFlight = true;
    refreshBtn.disabled = true;
    try {
      const url = new URL("api/worktree/diff/current", document.baseURI);
      url.searchParams.set("cwd", context.cwd);
      url.searchParams.set("maxFiles", "240");
      url.searchParams.set("maxPatchChars", "800000");
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json" }
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const files = Array.isArray(data.files) ? data.files : [];
      const renderKey = [
        context.cwd,
        data.headSha || "",
        String(files.length),
        String(data.isTimedOut === true),
        files.map((x) => `${x.statusCode || ""}:${x.path || ""}:${(x.patch || "").length}:${x.isBinary === true ? "1" : "0"}`).join("|")
      ].join("::");

      const cwdChanged = context.cwd !== lastCwd;
      if (!force && !cwdChanged && renderKey === lastRenderKey) {
        return;
      }

      lastRenderKey = renderKey;
      currentBranch = typeof data.branch === "string" && data.branch.trim() ? data.branch.trim() : "detached";

      if (data.isGitRepo !== true) {
        setEmptyState("Not a git repository");
        return;
      }

      hasVisibleChanges = files.length > 0;
      currentFiles = files;
      if (!hasVisibleChanges) {
        isExpanded = false;
      }
      if (hasVisibleChanges) {
        renderFiles(files);
      } else {
        listNode.innerHTML = "";
      }
      updateSummary(files.length);
      applyPanelState();
      renderComposerNotes();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      hasVisibleChanges = false;
      currentFiles = [];
      isExpanded = false;
      summaryNode.textContent = `Diff load failed: ${message}`;
      listNode.innerHTML = "";
      applyPanelState();
      renderComposerNotes();
    } finally {
      refreshBtn.disabled = false;
      pollInFlight = false;
    }
  }

  function startPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }

    fetchAndRenderDiff(true).catch(() => { });
    pollTimer = setInterval(() => {
      fetchAndRenderDiff(false).catch(() => { });
    }, POLL_MS);
  }

  toggleBtn.addEventListener("click", () => {
    isExpanded = false;
    applyPanelState();
  });

  indicatorBtn.addEventListener("click", () => {
    if (!hasVisibleChanges) {
      return;
    }
    isExpanded = true;
    applyPanelState();
  });

  refreshBtn.addEventListener("click", () => {
    fetchAndRenderDiff(true).catch(() => { });
  });

  listNode.addEventListener("click", (event) => {
    const jumpBtn = event.target instanceof Element ? event.target.closest("[data-note-jump='1']") : null;
    if (jumpBtn) {
      const path = jumpBtn.getAttribute("data-note-path") || "";
      const lineNo = Number.parseInt(jumpBtn.getAttribute("data-note-line") || "", 10);
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

    upsertLineNote(path, lineNo, lineText);
  });

  composerNotesNode.addEventListener("click", (event) => {
    const removeBtn = event.target instanceof Element ? event.target.closest("[data-diff-note-remove]") : null;
    if (removeBtn) {
      const key = removeBtn.getAttribute("data-diff-note-remove") || "";
      if (key && notesByKey.has(key)) {
        notesByKey.delete(key);
        saveNotesForCwd(lastCwd);
        updateSummary(currentFiles.length);
        renderFiles(currentFiles);
        renderComposerNotes();
      }
      return;
    }

    const clearBtn = event.target instanceof Element ? event.target.closest("[data-diff-note-clear='1']") : null;
    if (!clearBtn) {
      return;
    }

    notesByKey.clear();
    saveNotesForCwd(lastCwd);
    updateSummary(currentFiles.length);
    renderFiles(currentFiles);
    renderComposerNotes();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      startPolling();
      return;
    }

    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });

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

  applyPanelState();
  renderComposerNotes();
  startPolling();
})();
