(function () {
  const params = new URLSearchParams(window.location.search || "");
  const promptForm = document.getElementById("promptForm");
  const promptInput = document.getElementById("promptInput");
  const queuePromptBtn = document.getElementById("queuePromptBtn");
  const sendPromptBtn = document.getElementById("sendPromptBtn");
  const cancelTurnBtn = document.getElementById("cancelTurnBtn");
  const connectionStatusBanner = document.getElementById("connectionStatusBanner");
  const connectionStatusText = document.getElementById("connectionStatusText");
  const connectionReconnectBtn = document.getElementById("connectionReconnectBtn");

  let socket = null;
  let socketReadyPromise = null;
  let turnInFlight = false;
  let attachCounter = 0;

  let activeSessionId = String(params.get("review_session") || "").trim();
  let activeThreadId = String(params.get("review_thread") || "").trim();
  let activeCwd = normalizeCwd(params.get("review_cwd") || "");

  const reviewsByCwd = new Map(); // cwd -> { reviews: [], approvals: [] }
  const inflightCatalogByCwd = new Map(); // cwd -> Promise

  window.codexCodeReviewsBridge = {
    getWorkspaceMode() { return "code_reviews"; },
    setWorkspaceMode() { return "code_reviews"; },
    isCodeReviewsWorkspace() { return true; },
    getReviewPageMode() { return "detail"; },
    setReviewPageMode() { return "detail"; }
  };

  window.codexWorkspaceGetTabMode = function codexWorkspaceGetTabMode() {
    return "code_reviews";
  };

  window.uiAuditLog = window.uiAuditLog || function uiAuditLog(eventName, details, level) {
    const method = level === "error" ? "error" : (level === "warn" ? "warn" : "info");
    if (typeof console !== "undefined" && typeof console[method] === "function") {
      console[method](`[review-detail] ${eventName}`, details || {});
    }
  };

  function normalizeCwd(value) {
    return String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  }

  function normalizeTargetType(value) {
    return value === "commit" ? "commit" : "worktree";
  }

  function normalizeCommitSha(value) {
    return String(value || "").trim().toLowerCase();
  }

  function buildScopeKey(cwd, targetType, commitSha) {
    const normalizedCwd = normalizeCwd(cwd);
    if (!normalizedCwd) {
      return "";
    }
    const normalizedType = normalizeTargetType(targetType);
    if (normalizedType === "commit") {
      return `${normalizedCwd}::commit::${normalizeCommitSha(commitSha)}`;
    }
    return `${normalizedCwd}::worktree`;
  }

  function parseScopeKey(scopeKey) {
    const value = String(scopeKey || "").trim();
    if (!value) {
      return { cwd: "", targetType: "worktree", commitSha: "" };
    }
    const parts = value.split("::");
    if (parts.length >= 3 && parts[1] === "commit") {
      return {
        cwd: normalizeCwd(parts[0]),
        targetType: "commit",
        commitSha: normalizeCommitSha(parts.slice(2).join("::"))
      };
    }
    return {
      cwd: normalizeCwd(parts[0] || value),
      targetType: "worktree",
      commitSha: ""
    };
  }

  function recordScopeKey(record) {
    return buildScopeKey(record?.cwd || "", record?.targetType || "worktree", record?.commitSha || "");
  }

  function dispatchReviewUpdate(reason, scopeKey = "") {
    try {
      window.dispatchEvent(new CustomEvent("codex:reviews-updated", {
        detail: { reason, scopeKey }
      }));
    } catch {
    }
  }

  function setConnectionBanner(state, message, showReconnect) {
    if (!connectionStatusBanner || !connectionStatusText) {
      return;
    }
    const normalizedMessage = String(message || "").trim();
    if (!normalizedMessage || state === "connected") {
      connectionStatusBanner.classList.add("hidden");
      connectionStatusText.textContent = "";
      connectionStatusBanner.dataset.state = "connected";
      if (connectionReconnectBtn) {
        connectionReconnectBtn.classList.add("hidden");
      }
      return;
    }
    connectionStatusBanner.classList.remove("hidden");
    connectionStatusBanner.dataset.state = String(state || "disconnected");
    connectionStatusText.textContent = normalizedMessage;
    if (connectionReconnectBtn) {
      connectionReconnectBtn.classList.toggle("hidden", showReconnect !== true);
    }
  }

  function updatePromptButtons() {
    if (!queuePromptBtn || !sendPromptBtn || !cancelTurnBtn) {
      return;
    }
    queuePromptBtn.classList.toggle("hidden", !turnInFlight);
    cancelTurnBtn.classList.toggle("hidden", !turnInFlight);
    sendPromptBtn.classList.toggle("queue-mode", turnInFlight);
    sendPromptBtn.classList.toggle("solo-send", !turnInFlight);
    queuePromptBtn.disabled = !activeSessionId;
    sendPromptBtn.disabled = !activeSessionId;
    cancelTurnBtn.disabled = !activeSessionId || !turnInFlight;
  }

  function wsUrl() {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const endpoint = new URL("ws", document.baseURI);
    endpoint.protocol = scheme;
    return endpoint.toString();
  }

  function send(type, payload = {}) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setConnectionBanner("disconnected", "Websocket is disconnected. Reconnect to continue.", true);
      return false;
    }
    socket.send(JSON.stringify({ type, ...payload }));
    return true;
  }

  function applySessionPayload(payload) {
    const sessionId = String(payload?.sessionId || "").trim();
    const threadId = String(payload?.threadId || "").trim();
    const cwd = normalizeCwd(payload?.cwd || "");
    if (sessionId) {
      activeSessionId = sessionId;
    }
    if (threadId) {
      activeThreadId = threadId;
    }
    if (cwd) {
      activeCwd = cwd;
      refreshReviewCatalogForCwd(activeCwd, { force: true }).catch(() => { });
    }
    updatePromptButtons();
  }

  function handleSessionList(payload) {
    const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
    if (activeSessionId && sessions.some((x) => x && x.id === activeSessionId)) {
      return;
    }
    if (!activeThreadId) {
      return;
    }
    const match = sessions.find((x) => x && String(x.threadId || "").trim() === activeThreadId);
    if (!match) {
      return;
    }
    activeSessionId = String(match.id || "").trim();
    if (match.cwd) {
      activeCwd = normalizeCwd(match.cwd);
    }
    updatePromptButtons();
  }

  function handleServerEvent(frame) {
    const type = String(frame?.type || "");
    if (type === "session_attached" || type === "session_created") {
      applySessionPayload(frame);
      return;
    }
    if (type === "session_list") {
      handleSessionList(frame);
      return;
    }
    if (type === "turn_started" && frame?.sessionId === activeSessionId) {
      turnInFlight = true;
      updatePromptButtons();
      return;
    }
    if ((type === "turn_completed" || type === "turn_failed" || type === "turn_cancel_requested") && frame?.sessionId === activeSessionId) {
      turnInFlight = false;
      updatePromptButtons();
      if (activeCwd) {
        refreshReviewCatalogForCwd(activeCwd, { force: true }).catch(() => { });
      }
    }
  }

  function ensureSocket() {
    if (socket && socket.readyState === WebSocket.OPEN) {
      setConnectionBanner("connected", "", false);
      return Promise.resolve();
    }
    if (socket && socket.readyState === WebSocket.CONNECTING && socketReadyPromise) {
      return socketReadyPromise;
    }

    setConnectionBanner("reconnecting", "Connecting to websocket bridge...", true);
    socket = new WebSocket(wsUrl());
    socketReadyPromise = new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("websocket connect error")), { once: true });
      socket.addEventListener("close", () => reject(new Error("websocket closed before open")), { once: true });
    });

    socket.addEventListener("open", () => {
      socketReadyPromise = null;
      setConnectionBanner("connected", "", false);
      send("session_list");
      if (activeThreadId) {
        send("session_attach", {
          requestId: `detail-attach-${Date.now()}-${attachCounter += 1}`,
          threadId: activeThreadId,
          cwd: activeCwd || undefined
        });
      }
    });

    socket.addEventListener("close", () => {
      socketReadyPromise = null;
      setConnectionBanner("disconnected", "Disconnected from websocket bridge.", true);
    });
    socket.addEventListener("error", () => {
      setConnectionBanner("error", "Websocket error. Waiting for reconnect.", true);
    });
    socket.addEventListener("message", (event) => {
      try {
        const frame = JSON.parse(event.data);
        handleServerEvent(frame);
      } catch {
      }
    });

    return socketReadyPromise;
  }

  function appendDiffNotes(promptText) {
    const base = String(promptText || "").trim();
    const buildMetadata = window.codexDiffNotesBuildPromptMetadata;
    if (typeof buildMetadata !== "function") {
      return base;
    }
    const payload = buildMetadata();
    const metadataText = typeof payload?.metadataText === "string" ? payload.metadataText.trim() : "";
    if (!metadataText) {
      return base;
    }
    return base ? `${base}\n\n${metadataText}` : metadataText;
  }

  async function queuePrompt(sessionId, promptText) {
    return send("turn_queue_add", {
      sessionId,
      queueItemId: `detail-queue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: promptText,
      planMode: false
    });
  }

  function startTurn(sessionId, promptText) {
    const started = send("turn_start", {
      sessionId,
      text: promptText,
      planMode: false
    });
    if (started) {
      turnInFlight = true;
      updatePromptButtons();
    }
    return started;
  }

  async function sendComposerPrompt(mode) {
    const promptText = appendDiffNotes(promptInput ? promptInput.value : "").trim();
    if (!promptText || !activeSessionId) {
      return false;
    }
    await ensureSocket();
    const ok = mode === "queue" || turnInFlight
      ? await queuePrompt(activeSessionId, promptText)
      : startTurn(activeSessionId, promptText);
    if (!ok) {
      return false;
    }
    if (promptInput) {
      promptInput.value = "";
      promptInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return true;
  }

  async function postReviewJson(path, payload) {
    const response = await fetch(new URL(path, document.baseURI).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(payload || {})
    });
    if (!response.ok) {
      throw new Error(`${path} failed (${response.status})`);
    }
    return await response.json();
  }

  async function refreshReviewCatalogForCwd(cwd, options = {}) {
    const normalizedCwd = normalizeCwd(cwd || "");
    if (!normalizedCwd) {
      return [];
    }
    const force = options.force === true;
    const existing = inflightCatalogByCwd.get(normalizedCwd);
    if (existing && !force) {
      return await existing;
    }

    const loadPromise = (async () => {
      const url = new URL("api/reviews", document.baseURI);
      url.searchParams.set("cwd", normalizedCwd);
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store"
      });
      if (!response.ok) {
        throw new Error(`api/reviews failed (${response.status})`);
      }
      const payload = await response.json();
      const reviews = Array.isArray(payload?.reviews) ? payload.reviews : [];
      const approvals = Array.isArray(payload?.approvals) ? payload.approvals : [];
      reviewsByCwd.set(normalizedCwd, { reviews, approvals });
      dispatchReviewUpdate(force ? "review_catalog_refresh_forced" : "review_catalog_refresh");
      return reviews;
    })();

    inflightCatalogByCwd.set(normalizedCwd, loadPromise);
    try {
      return await loadPromise;
    } finally {
      if (inflightCatalogByCwd.get(normalizedCwd) === loadPromise) {
        inflightCatalogByCwd.delete(normalizedCwd);
      }
    }
  }

  function getScopeRecords(scopeKey) {
    const scope = parseScopeKey(scopeKey);
    const entry = reviewsByCwd.get(scope.cwd);
    const reviews = Array.isArray(entry?.reviews) ? entry.reviews : [];
    return reviews
      .filter((record) => recordScopeKey(record) === buildScopeKey(scope.cwd, scope.targetType, scope.commitSha))
      .sort((a, b) => Date.parse(b?.completedAtUtc || b?.startedAtUtc || b?.queuedAtUtc || 0) - Date.parse(a?.completedAtUtc || a?.startedAtUtc || a?.queuedAtUtc || 0));
  }

  function getScopeApproval(scopeKey) {
    const scope = parseScopeKey(scopeKey);
    const entry = reviewsByCwd.get(scope.cwd);
    const approvals = Array.isArray(entry?.approvals) ? entry.approvals : [];
    return approvals.find((approval) => recordScopeKey(approval) === buildScopeKey(scope.cwd, scope.targetType, scope.commitSha)) || null;
  }

  function scopeSummary(scopeKey) {
    const records = getScopeRecords(scopeKey);
    const approval = getScopeApproval(scopeKey);

    let queuedCount = 0;
    let runningCount = 0;
    let completedCount = 0;
    let dismissedCount = 0;
    let failedCount = 0;
    let staleCount = 0;
    for (const record of records) {
      const status = String(record?.status || "").toLowerCase();
      if (status === "running") {
        runningCount += 1;
      } else if (status === "completed") {
        completedCount += 1;
      } else if (status === "dismissed") {
        dismissedCount += 1;
      } else if (status === "failed") {
        failedCount += 1;
      } else if (status === "stale") {
        staleCount += 1;
      } else {
        queuedCount += 1;
      }
    }

    const primaryRecord = records.length > 0 ? records[0] : null;
    const status = runningCount > 0
      ? "running"
      : (queuedCount > 0 ? "queued" : (String(primaryRecord?.status || "not_started").toLowerCase() || "not_started"));
    const findings = Array.isArray(primaryRecord?.findings) ? primaryRecord.findings : [];
    const openFindingCount = status === "dismissed" ? 0 : findings.length;

    return {
      scopeKey: String(scopeKey || ""),
      status,
      isApproved: !!approval,
      approval: approval ? { ...approval } : null,
      approvedAtUtc: String(approval?.approvedAtUtc || ""),
      reviewCount: records.length,
      queuedCount,
      runningCount,
      requestedCount: queuedCount + runningCount,
      completedCount,
      dismissedCount,
      failedCount,
      staleCount,
      openFindingCount,
      records,
      primaryRecord
    };
  }

  function scopeFindings(scopeKey) {
    const records = getScopeRecords(scopeKey);
    const findings = [];
    for (const record of records) {
      if (String(record?.status || "").toLowerCase() === "dismissed") {
        continue;
      }
      const reviewLabel = record?.commitSha
        ? `${String(record.commitSha).slice(0, 7)} review`
        : "worktree review";
      const list = Array.isArray(record?.findings) ? record.findings : [];
      for (const finding of list) {
        findings.push({
          ...finding,
          reviewId: String(record?.reviewId || ""),
          reviewLabel
        });
      }
    }
    return findings;
  }

  window.codexAppendTextToPrompt = function codexAppendTextToPrompt(text, options = {}) {
    if (!promptInput) {
      return false;
    }
    const addition = String(text || "").trim();
    if (!addition) {
      return false;
    }
    const current = promptInput.value || "";
    const separator = current.trim().length > 0 ? "\n\n" : "";
    promptInput.value = `${current}${separator}${addition}`;
    promptInput.dispatchEvent(new Event("input", { bubbles: true }));
    if (options.focus !== false) {
      promptInput.focus();
      promptInput.selectionStart = promptInput.selectionEnd = promptInput.value.length;
    }
    return true;
  };

  window.codexDiffGetActiveContext = function codexDiffGetActiveContext() {
    if (!activeCwd) {
      return null;
    }
    return {
      sessionId: activeSessionId || "",
      threadId: activeThreadId || "",
      cwd: activeCwd
    };
  };

  window.codexAttachSessionByThreadId = async function codexAttachSessionByThreadId(threadId, cwd) {
    const normalizedThreadId = String(threadId || "").trim();
    if (!normalizedThreadId) {
      return false;
    }
    activeThreadId = normalizedThreadId;
    if (cwd) {
      activeCwd = normalizeCwd(cwd);
    }
    await ensureSocket();
    return send("session_attach", {
      requestId: `detail-attach-${Date.now()}-${attachCounter += 1}`,
      threadId: activeThreadId,
      cwd: activeCwd || undefined
    });
  };

  window.codexDiffRefreshReviewCatalog = async function codexDiffRefreshReviewCatalog(cwd, options = {}) {
    return await refreshReviewCatalogForCwd(cwd, options);
  };

  window.codexDiffMarkReviewScopeDone = async function codexDiffMarkReviewScopeDone(scopeKey) {
    const records = getScopeRecords(scopeKey).filter((x) => x && x.reviewId && String(x.status || "").toLowerCase() !== "dismissed");
    if (records.length <= 0) {
      return false;
    }
    await Promise.all(records.map((record) => postReviewJson("api/reviews/status", {
      reviewId: String(record.reviewId),
      status: "dismissed"
    })));
    const scope = parseScopeKey(scopeKey);
    await refreshReviewCatalogForCwd(scope.cwd, { force: true });
    return true;
  };

  window.codexDiffSetReviewScopeApproval = async function codexDiffSetReviewScopeApproval(options = {}) {
    const cwd = normalizeCwd(options.cwd || "");
    if (!cwd) {
      return { updated: false, approval: null };
    }
    const payload = await postReviewJson("api/reviews/approval", {
      cwd,
      targetType: normalizeTargetType(options.targetType),
      commitSha: normalizeCommitSha(options.commitSha),
      approved: options.approved === true
    });
    await refreshReviewCatalogForCwd(cwd, { force: true });
    return {
      updated: payload?.updated === true,
      approval: payload?.approval || null
    };
  };

  window.codexDiffCreateReviewRequest = async function codexDiffCreateReviewRequest(options = {}) {
    const cwd = normalizeCwd(options.cwd || activeCwd || "");
    const targetType = normalizeTargetType(options.targetType);
    const commitSha = normalizeCommitSha(options.commitSha);
    if (!cwd) {
      return null;
    }
    if (targetType === "commit" && !commitSha) {
      return null;
    }
    const payload = await postReviewJson("api/reviews/create", {
      threadId: String(options.threadId || activeThreadId || "").trim(),
      sessionId: String(options.sessionId || activeSessionId || "").trim(),
      cwd,
      targetType,
      commitSha,
      commitSubject: String(options.commitSubject || "").trim(),
      contextLabel: String(options.contextLabel || "+3").trim(),
      visibleFiles: Number.isFinite(options.visibleFiles) ? Math.max(0, Math.floor(options.visibleFiles)) : 0,
      totalFiles: Number.isFinite(options.totalFiles) ? Math.max(0, Math.floor(options.totalFiles)) : 0,
      hiddenBinaryFiles: Number.isFinite(options.hiddenBinaryFiles) ? Math.max(0, Math.floor(options.hiddenBinaryFiles)) : 0,
      noteText: String(options.noteText || "").trim(),
      initialStatus: String(options.initialStatus || "queued").trim()
    });
    await refreshReviewCatalogForCwd(cwd, { force: true });
    const review = payload?.review || null;
    const promptText = typeof payload?.promptText === "string" ? payload.promptText : "";
    if (!review || !promptText) {
      return null;
    }
    return {
      reviewId: String(review.reviewId || ""),
      scopeKey: recordScopeKey(review),
      cwd: normalizeCwd(review.cwd || cwd),
      targetType: normalizeTargetType(review.targetType || targetType),
      commitSha: normalizeCommitSha(review.commitSha || commitSha),
      commitSubject: String(review.commitSubject || ""),
      noteText: String(review.noteText || ""),
      promptText
    };
  };

  window.codexDiffGetReviewScopeSummary = function codexDiffGetReviewScopeSummary(scopeKey) {
    return scopeSummary(scopeKey);
  };

  window.codexDiffGetReviewFindingsForScope = function codexDiffGetReviewFindingsForScope(scopeKey) {
    return scopeFindings(scopeKey);
  };

  window.codexDiffQueueReviewPrompt = async function codexDiffQueueReviewPrompt(rawPromptText, options = {}) {
    const promptText = appendDiffNotes(rawPromptText || "").trim();
    if (!promptText || !activeSessionId) {
      return false;
    }
    await ensureSocket();
    const queued = await queuePrompt(activeSessionId, promptText);
    if (options.reviewRequest?.cwd) {
      refreshReviewCatalogForCwd(options.reviewRequest.cwd, { force: true }).catch(() => { });
    }
    return queued;
  };

  window.codexDiffQueueFixPrompt = async function codexDiffQueueFixPrompt(rawPromptText) {
    const promptText = appendDiffNotes(rawPromptText || "").trim();
    if (!promptText || !activeSessionId) {
      return false;
    }
    await ensureSocket();
    return await queuePrompt(activeSessionId, promptText);
  };

  window.codexDiffRunReviewPrompt = async function codexDiffRunReviewPrompt(rawPromptText, options = {}) {
    const promptText = appendDiffNotes(rawPromptText || "").trim();
    if (!promptText || !activeSessionId) {
      return false;
    }
    await ensureSocket();
    const sent = turnInFlight
      ? await queuePrompt(activeSessionId, promptText)
      : startTurn(activeSessionId, promptText);
    if (options.reviewRequest?.cwd) {
      refreshReviewCatalogForCwd(options.reviewRequest.cwd, { force: true }).catch(() => { });
    }
    return sent;
  };

  if (promptForm) {
    promptForm.addEventListener("submit", (event) => {
      event.preventDefault();
      sendComposerPrompt("start").catch(() => { });
    });
  }

  if (queuePromptBtn) {
    queuePromptBtn.addEventListener("click", () => {
      sendComposerPrompt("queue").catch(() => { });
    });
  }

  if (cancelTurnBtn) {
    cancelTurnBtn.addEventListener("click", () => {
      if (!activeSessionId) {
        return;
      }
      if (send("turn_cancel", { sessionId: activeSessionId })) {
        turnInFlight = false;
        updatePromptButtons();
      }
    });
  }

  if (connectionReconnectBtn) {
    connectionReconnectBtn.addEventListener("click", () => {
      ensureSocket().catch(() => { });
    });
  }

  updatePromptButtons();
  ensureSocket().catch(() => {
    setConnectionBanner("error", "Unable to connect to websocket bridge.", true);
  });
  if (activeCwd) {
    refreshReviewCatalogForCwd(activeCwd, { force: false }).catch(() => { });
  }
})();
