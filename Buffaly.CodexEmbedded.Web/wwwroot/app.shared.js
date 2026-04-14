// Shared helpers extracted from app.js to keep app.js focused on orchestration and event wiring.

function normalizeCollaborationMode(value) {
  if (value === null || value === undefined) {
    return "";
  }

  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return "";
  }

  if (normalized === "plan") {
    return "plan";
  }

  if (normalized === "default") {
    return "default";
  }

  return "";
}

function normalizePlanStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "streaming" || normalized === "completed" || normalized === "error") {
    return normalized;
  }

  return "idle";
}

function ensurePlanStateShape(state) {
  if (!state || typeof state !== "object") {
    return;
  }

  if (typeof state.planStatus !== "string") {
    state.planStatus = "idle";
  }
  if (typeof state.planText !== "string") {
    state.planText = "";
  }
  if (typeof state.planDraftText !== "string") {
    state.planDraftText = "";
  }
  if (typeof state.isPlanTurn !== "boolean") {
    state.isPlanTurn = false;
  }
  if (state.planUpdatedAt !== null && state.planUpdatedAt !== undefined && typeof state.planUpdatedAt !== "string") {
    state.planUpdatedAt = null;
  }
}

function normalizePlanPayloadText(rawText) {
  if (typeof rawText !== "string") {
    return "";
  }

  let text = rawText.replace(/\r/g, "");
  text = text.replace(/^\s*<proposed_plan>\s*/i, "");
  text = text.replace(/\s*<\/proposed_plan>\s*$/i, "");
  return text.trim();
}

function extractTaggedProposedPlanText(rawText) {
  if (typeof rawText !== "string" || !rawText.trim()) {
    return "";
  }

  const normalized = rawText.replace(/\r/g, "");
  const taggedMatch = normalized.match(/<proposed_plan>([\s\S]*?)<\/proposed_plan>/i);
  if (!taggedMatch || typeof taggedMatch[1] !== "string") {
    return "";
  }

  return normalizePlanPayloadText(taggedMatch[1]);
}

function readTurnSnapshotEntryText(entry) {
  if (!entry || typeof entry !== "object") {
    return "";
  }

  if (typeof entry.text === "string") {
    return entry.text;
  }

  if (typeof entry.Text === "string") {
    return entry.Text;
  }

  return "";
}

function readTurnSnapshotEntryRawType(entry) {
  if (!entry || typeof entry !== "object") {
    return "";
  }

  if (typeof entry.rawType === "string") {
    return entry.rawType.trim().toLowerCase();
  }

  if (typeof entry.RawType === "string") {
    return entry.RawType.trim().toLowerCase();
  }

  return "";
}

function readTurnSnapshotEntryTitle(entry) {
  if (!entry || typeof entry !== "object") {
    return "";
  }

  if (typeof entry.title === "string") {
    return entry.title.trim().toLowerCase();
  }

  if (typeof entry.Title === "string") {
    return entry.Title.trim().toLowerCase();
  }

  return "";
}

function isPlanUpdatedRawType(rawType) {
  return rawType === "plan_update" || rawType === "plan_updated" || rawType === "turn/plan/updated";
}

function extractPlanFromTurnSnapshot(turn) {
  if (!turn || typeof turn !== "object") {
    return "";
  }

  const assistantEntry = (turn.assistantFinal && typeof turn.assistantFinal === "object")
    ? turn.assistantFinal
    : ((turn.AssistantFinal && typeof turn.AssistantFinal === "object") ? turn.AssistantFinal : null);
  const assistantText = readTurnSnapshotEntryText(assistantEntry);
  const taggedPlanText = extractTaggedProposedPlanText(assistantText);
  if (taggedPlanText) {
    return taggedPlanText;
  }

  const intermediate = Array.isArray(turn.intermediate)
    ? turn.intermediate
    : (Array.isArray(turn.Intermediate) ? turn.Intermediate : []);
  for (let i = intermediate.length - 1; i >= 0; i -= 1) {
    const entry = intermediate[i];
    const rawType = readTurnSnapshotEntryRawType(entry);
    const title = readTurnSnapshotEntryTitle(entry);
    if (!isPlanUpdatedRawType(rawType) && title !== "plan updated") {
      continue;
    }

    const planText = normalizePlanPayloadText(readTurnSnapshotEntryText(entry));
    if (planText) {
      return planText;
    }
  }

  return "";
}

function isTurnSnapshotInFlight(turn) {
  if (!turn || typeof turn !== "object") {
    return false;
  }

  if (turn.isInFlight === true || turn.IsInFlight === true) {
    return true;
  }

  return false;
}

function reconcileTurnAndPlanStateFromTurnsWatch(sessionId, turns) {
  if (!sessionId || !Array.isArray(turns) || turns.length === 0) {
    return;
  }

  const latestTurn = turns[turns.length - 1];
  const state = ensureSessionState(sessionId);
  ensurePlanStateShape(state);
  const watchInFlight = isTurnSnapshotInFlight(latestTurn) || isThreadProcessing(state.threadId || "");
  const resolvedInFlight = resolveTurnInFlightFromServer(sessionId, watchInFlight);
  const localInFlight = isTurnInFlight(sessionId);
  if (localInFlight !== resolvedInFlight) {
    setTurnInFlight(sessionId, resolvedInFlight);
    if (!resolvedInFlight && sessionId === activeSessionId) {
      renderPromptQueue();
    }
  }

  const planText = extractPlanFromTurnSnapshot(latestTurn);
  if (planText) {
    state.isPlanTurn = true;
    state.planText = planText;
    state.planDraftText = planText;
    state.planStatus = resolvedInFlight ? "streaming" : "completed";
    state.planUpdatedAt = new Date().toISOString();
    if (sessionId === activeSessionId) {
      updatePlanPanel();
    }
    return;
  }

  if (!resolvedInFlight && state.isPlanTurn === true && normalizePlanStatus(state.planStatus) === "streaming") {
    const currentText = normalizePlanPayloadText(state.planText || state.planDraftText || "");
    if (currentText) {
      state.planText = currentText;
      state.planDraftText = currentText;
    }
    state.planStatus = "completed";
    state.planUpdatedAt = new Date().toISOString();
    if (sessionId === activeSessionId) {
      updatePlanPanel();
    }
  }
}

function findPlanTextOverlapSuffixPrefix(left, right) {
  if (!left || !right) {
    return 0;
  }

  const maxWindow = 4096;
  const leftSlice = left.length > maxWindow ? left.slice(left.length - maxWindow) : left;
  const rightSlice = right.length > maxWindow ? right.slice(0, maxWindow) : right;
  const maxOverlap = Math.min(leftSlice.length, rightSlice.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (leftSlice.slice(leftSlice.length - size) === rightSlice.slice(0, size)) {
      return size;
    }
  }

  return 0;
}

function mergePlanDeltaText(currentDraft, incomingDelta) {
  const current = normalizePlanPayloadText(currentDraft || "");
  const incoming = normalizePlanPayloadText(incomingDelta || "");
  if (!incoming) {
    return current;
  }
  if (!current) {
    return incoming;
  }
  if (current === incoming) {
    return current;
  }
  if (incoming.startsWith(current)) {
    return incoming;
  }
  if (current.endsWith(incoming)) {
    return current;
  }
  if (incoming.length > 16 && current.includes(incoming)) {
    return current;
  }

  const overlap = findPlanTextOverlapSuffixPrefix(current, incoming);
  return overlap > 0 ? `${current}${incoming.slice(overlap)}` : `${current}${incoming}`;
}

function appendPlanInlineMarkdown(parent, text) {
  const source = typeof text === "string" ? text : "";
  if (!source) {
    return;
  }

  let cursor = 0;
  while (cursor < source.length) {
    if (source.startsWith("**", cursor)) {
      const end = source.indexOf("**", cursor + 2);
      if (end > cursor + 2) {
        const strong = document.createElement("strong");
        strong.textContent = source.slice(cursor + 2, end);
        parent.appendChild(strong);
        cursor = end + 2;
        continue;
      }
    }

    if (source.startsWith("`", cursor)) {
      const end = source.indexOf("`", cursor + 1);
      if (end > cursor + 1) {
        const code = document.createElement("code");
        code.textContent = source.slice(cursor + 1, end);
        parent.appendChild(code);
        cursor = end + 1;
        continue;
      }
    }

    let next = source.length;
    const nextBold = source.indexOf("**", cursor);
    const nextCode = source.indexOf("`", cursor);
    if (nextBold >= 0 && nextBold < next) {
      next = nextBold;
    }
    if (nextCode >= 0 && nextCode < next) {
      next = nextCode;
    }

    if (next <= cursor) {
      parent.appendChild(document.createTextNode(source.charAt(cursor)));
      cursor += 1;
      continue;
    }

    parent.appendChild(document.createTextNode(source.slice(cursor, next)));
    cursor = next;
  }
}

function renderPlanMarkdownIntoBody(container, markdownText) {
  if (!container) {
    return;
  }

  container.textContent = "";
  container.classList.remove("plan-panel-empty");
  const text = normalizePlanPayloadText(markdownText || "");
  if (!text) {
    return;
  }

  const fragment = document.createDocumentFragment();
  const lines = text.split("\n");
  let paragraphLines = [];
  let listElement = null;
  let listType = "";
  let lastListItem = null;
  let codeBlock = null;

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }
    const paragraph = document.createElement("p");
    appendPlanInlineMarkdown(paragraph, paragraphLines.join(" ").trim());
    fragment.appendChild(paragraph);
    paragraphLines = [];
  };

  const clearList = () => {
    listElement = null;
    listType = "";
    lastListItem = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    const trimmed = line.trim();

    if (codeBlock) {
      if (trimmed.startsWith("```")) {
        codeBlock = null;
      } else {
        codeBlock.textContent += `${line}\n`;
      }
      continue;
    }

  if (trimmed.startsWith("```")) {
    flushParagraph();
    clearList();
    const pre = document.createElement("pre");
      const code = document.createElement("code");
      pre.appendChild(code);
      fragment.appendChild(pre);
      codeBlock = code;
      continue;
    }

  if (!trimmed) {
    flushParagraph();
    continue;
  }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
  if (headingMatch) {
    flushParagraph();
    clearList();
    const level = Math.min(6, headingMatch[1].length);
      const heading = document.createElement(`h${level}`);
      appendPlanInlineMarkdown(heading, headingMatch[2]);
      fragment.appendChild(heading);
      continue;
    }

    const unorderedMatch = trimmed.match(/^[-*]\s+(.*)$/);
    if (unorderedMatch) {
      flushParagraph();
      if (listType === "ol" && lastListItem) {
        let nestedList = lastListItem.lastElementChild;
        if (!nestedList || nestedList.tagName !== "UL") {
          nestedList = document.createElement("ul");
          lastListItem.appendChild(nestedList);
        }
        const item = document.createElement("li");
        appendPlanInlineMarkdown(item, unorderedMatch[1]);
        nestedList.appendChild(item);
        continue;
      }
      if (!listElement || listType !== "ul") {
        listElement = document.createElement("ul");
        listType = "ul";
        fragment.appendChild(listElement);
      }
      const item = document.createElement("li");
      appendPlanInlineMarkdown(item, unorderedMatch[1]);
      listElement.appendChild(item);
      lastListItem = item;
      continue;
    }

    const orderedMatch = trimmed.match(/^\d+\.\s+(.*)$/);
    if (orderedMatch) {
      flushParagraph();
      if (!listElement || listType !== "ol") {
        listElement = document.createElement("ol");
        listType = "ol";
        fragment.appendChild(listElement);
      }
      const item = document.createElement("li");
      appendPlanInlineMarkdown(item, orderedMatch[1]);
      listElement.appendChild(item);
      lastListItem = item;
      continue;
    }

    clearList();
    paragraphLines.push(trimmed);
  }

  flushParagraph();
  container.appendChild(fragment);
}

function setPlanModeNextTurn(enabled) {
  planModeNextTurn = !!enabled;
  if (!planTurnToggleBtn) {
    return;
  }

  planTurnToggleBtn.classList.toggle("is-active", planModeNextTurn);
  planTurnToggleBtn.setAttribute("aria-pressed", planModeNextTurn ? "true" : "false");
  const title = planModeNextTurn
    ? "Plan mode enabled for next turn"
    : "Enable plan mode for next turn";
  planTurnToggleBtn.title = title;
  planTurnToggleBtn.setAttribute("aria-label", title);
}

function resetPlanModeNextTurn() {
  setPlanModeNextTurn(false);
}

function getPlanStatusLabel(status) {
  switch (normalizePlanStatus(status)) {
    case "streaming":
      return "Streaming";
    case "completed":
      return "Complete";
    case "error":
      return "Error";
    default:
      return "Idle";
  }
}

function updatePlanPanel() {
  if (!planPanel || !planPanelStatus || !planPanelBody) {
    return;
  }

  const state = getActiveSessionState();
  if (!state) {
    planPanel.classList.add("hidden");
    return;
  }

  ensurePlanStateShape(state);
  const status = normalizePlanStatus(state.planStatus);
  const canonicalText = normalizePlanPayloadText(state.planText || "");
  const streamingText = normalizePlanPayloadText(state.planDraftText || "");
  const shouldShow = status === "streaming" || status === "error";
  planPanel.classList.toggle("hidden", !shouldShow);
  planPanel.classList.toggle("plan-panel-inline", shouldShow);
  if (!shouldShow) {
    if (planPanelSummary) {
      planPanelSummary.textContent = "";
    }
    planPanelBody.classList.remove("hidden");
    return;
  }

  planPanelStatus.textContent = getPlanStatusLabel(status);
  planPanelStatus.classList.remove("streaming", "completed", "error");
  if (status !== "idle") {
    planPanelStatus.classList.add(status);
  }

  if (planPanelSummary) {
    if (status === "streaming") {
      const source = streamingText || canonicalText;
      if (!source) {
        planPanelSummary.textContent = "Generating plan...";
      } else {
        const firstMeaningfulLine = source
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line.length > 0);
        planPanelSummary.textContent = firstMeaningfulLine
          ? `Generating plan: ${firstMeaningfulLine}`
          : "Generating plan...";
      }
    } else if (status === "error") {
      planPanelSummary.textContent = "Plan stream interrupted. Check timeline for latest plan output.";
    } else {
      planPanelSummary.textContent = "Plan update";
    }
  }

  if (status === "error") {
    const fallback = canonicalText || streamingText;
    if (fallback) {
      renderPlanMarkdownIntoBody(planPanelBody, fallback);
      planPanelBody.classList.remove("hidden");
    } else {
      planPanelBody.classList.add("hidden");
    }
  } else {
    planPanelBody.classList.add("hidden");
  }
}

function markPlanTurnStarted(sessionId, isPlanTurn) {
  const state = ensureSessionState(sessionId);
  ensurePlanStateShape(state);
  state.isPlanTurn = !!isPlanTurn;
  state.planStatus = isPlanTurn ? "streaming" : "idle";
  state.planText = "";
  state.planDraftText = "";
  state.planUpdatedAt = isPlanTurn ? new Date().toISOString() : null;
  if (sessionId === activeSessionId) {
    updatePlanPanel();
  }
}

function appendPlanDeltaToSession(sessionId, text) {
  if (!sessionId || typeof text !== "string" || text.length === 0) {
    return;
  }

  const state = ensureSessionState(sessionId);
  ensurePlanStateShape(state);
  state.isPlanTurn = true;
  state.planStatus = "streaming";
  state.planDraftText = mergePlanDeltaText(state.planDraftText || "", text);
  state.planUpdatedAt = new Date().toISOString();
  if (sessionId === activeSessionId) {
    const shouldAutoScroll = planPanelBody
      ? (planPanelBody.scrollTop + planPanelBody.clientHeight >= planPanelBody.scrollHeight - 12)
      : false;
    updatePlanPanel();
    if (planPanelBody && shouldAutoScroll) {
      planPanelBody.scrollTop = planPanelBody.scrollHeight;
    }
  }
}

function applyPlanUpdatedToSession(sessionId, text) {
  if (!sessionId) {
    return;
  }

  const state = ensureSessionState(sessionId);
  ensurePlanStateShape(state);
  state.isPlanTurn = true;
  const normalizedIncoming = normalizePlanPayloadText(text || "");
  if (normalizedIncoming) {
    state.planText = normalizedIncoming;
    state.planDraftText = normalizedIncoming;
  } else if (normalizePlanPayloadText(state.planDraftText || "")) {
    state.planText = normalizePlanPayloadText(state.planDraftText || "");
  }
  state.planStatus = "completed";
  state.planUpdatedAt = new Date().toISOString();
  if (sessionId === activeSessionId) {
    updatePlanPanel();
  }
}

function finalizePlanTurn(sessionId, status, isPlanTurnFlag) {
  if (!sessionId) {
    return;
  }

  const state = ensureSessionState(sessionId);
  ensurePlanStateShape(state);
  if (isPlanTurnFlag !== true && state.isPlanTurn !== true) {
    return;
  }

  state.isPlanTurn = isPlanTurnFlag === true || state.isPlanTurn === true;
  const normalizedStatus = String(status || "").trim().toLowerCase();
  state.planStatus = normalizedStatus === "completed" ? "completed" : "error";
  if (state.planStatus === "completed" && !normalizePlanPayloadText(state.planText || "") && normalizePlanPayloadText(state.planDraftText || "")) {
    state.planText = normalizePlanPayloadText(state.planDraftText || "");
  }
  state.planUpdatedAt = new Date().toISOString();
  if (sessionId === activeSessionId) {
    updatePlanPanel();
  }
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

function extractPermissionPolicyName(value) {
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

function normalizeApprovalPolicy(value, options = {}) {
  const allowInherit = options.allowInherit !== false;
  const normalized = extractPermissionPolicyName(value).trim().toLowerCase().replace(/_/g, "-");
  if (!normalized || (allowInherit && normalized === "inherit")) {
    return "";
  }

  switch (normalized) {
    case "untrusted":
      return "untrusted";
    case "on-failure":
    case "onfailure":
      return "on-failure";
    case "on-request":
    case "onrequest":
      return "on-request";
    case "never":
      return "never";
    default:
      return "";
  }
}

function normalizeSandboxMode(value, options = {}) {
  const allowInherit = options.allowInherit !== false;
  const normalized = extractPermissionPolicyName(value).trim().toLowerCase().replace(/_/g, "-");
  if (!normalized || (allowInherit && normalized === "inherit")) {
    return "";
  }

  switch (normalized) {
    case "read-only":
    case "readonly":
    case "read only":
      return "read-only";
    case "workspace-write":
    case "workspacewrite":
    case "workspace write":
      return "workspace-write";
    case "danger-full-access":
    case "dangerfullaccess":
    case "danger full access":
      return "danger-full-access";
    case "none":
    case "no-sandbox":
    case "nosandbox":
      return "none";
    case "external-sandbox":
    case "externalsandbox":
      return "external-sandbox";
    default:
      return "";
  }
}

function setPermissionLevelForThread(threadId, nextValue) {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId || !nextValue || typeof nextValue !== "object") {
    return;
  }

  const prior = permissionLevelByThread.get(normalizedThreadId) || { approval: "", sandbox: "" };
  const merged = {
    approval: normalizeApprovalPolicy(nextValue.approval) || normalizeApprovalPolicy(prior.approval) || "",
    sandbox: normalizeSandboxMode(nextValue.sandbox) || normalizeSandboxMode(prior.sandbox) || ""
  };

  permissionLevelByThread.set(normalizedThreadId, merged);
  const activeThreadId = typeof getActiveSessionState()?.threadId === "string" ? getActiveSessionState().threadId.trim() : "";
  if (activeThreadId === normalizedThreadId) {
    updatePermissionLevelIndicator();
  }
}

function replacePermissionLevelForThread(threadId, nextValue) {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId || !nextValue || typeof nextValue !== "object") {
    return;
  }

  const nextApproval = normalizeApprovalPolicy(nextValue.approval);
  const nextSandbox = normalizeSandboxMode(nextValue.sandbox);
  if (!nextApproval && !nextSandbox) {
    permissionLevelByThread.delete(normalizedThreadId);
  } else {
    permissionLevelByThread.set(normalizedThreadId, {
      approval: nextApproval,
      sandbox: nextSandbox
    });
  }

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
  const normalized = normalizeApprovalPolicy(approval);
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
  const normalized = normalizeSandboxMode(sandbox);
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

  const approval = normalizeApprovalPolicy(approvalRaw);
  const sandbox = normalizeSandboxMode(sandboxRaw);
  if (!approval && !sandbox) {
    return null;
  }

  return { approval, sandbox };
}

function hasApprovalPolicyField(payload) {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  return Object.prototype.hasOwnProperty.call(payload, "approvalPolicy")
    || Object.prototype.hasOwnProperty.call(payload, "approval_policy")
    || Object.prototype.hasOwnProperty.call(payload, "approvalMode")
    || Object.prototype.hasOwnProperty.call(payload, "approval_mode");
}

function hasSandboxPolicyField(payload) {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  return Object.prototype.hasOwnProperty.call(payload, "sandboxPolicy")
    || Object.prototype.hasOwnProperty.call(payload, "sandbox_policy")
    || Object.prototype.hasOwnProperty.call(payload, "sandboxMode")
    || Object.prototype.hasOwnProperty.call(payload, "sandbox_mode")
    || Object.prototype.hasOwnProperty.call(payload, "sandbox");
}

function hasAnyPermissionField(payload) {
  return hasApprovalPolicyField(payload) || hasSandboxPolicyField(payload);
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
    const approval = normalizeApprovalPolicy(permission.approval || "");
    const sandbox = normalizeSandboxMode(permission.sandbox || "");
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

