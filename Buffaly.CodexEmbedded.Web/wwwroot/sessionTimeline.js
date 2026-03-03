(function initCodexSessionTimeline(global) {
  const DEFAULT_MAX_RENDERED_ENTRIES = 1500;
  const DEFAULT_MAX_TEXT_CHARS = 5000;
  const ANSI_ESCAPE_REGEX = /\u001b\[[0-9;]*[A-Za-z]/g;
  const TOOL_PREVIEW_HEAD_LINES = 8;
  const TOOL_PREVIEW_TAIL_LINES = 5;
  const TOOL_PREVIEW_MIN_HIDDEN_LINES = 3;
  const STORAGE_RENDER_ASSISTANT_MARKDOWN_KEY = "codex.settings.renderAssistantMarkdown.v1";
  const MAX_TIMELINE_ENTRY_TEXT_CHARS = 20_000;
  const MAX_TIMELINE_IMAGE_URL_CHARS = 8_192;

  class CodexSessionTimeline {
    constructor(options) {
      const opts = options || {};
      if (!opts.container) {
        throw new Error("CodexSessionTimeline requires a container element.");
      }

      this.container = opts.container;
      this.maxRenderedEntries = Number.isFinite(opts.maxRenderedEntries) ? opts.maxRenderedEntries : DEFAULT_MAX_RENDERED_ENTRIES;
      this.maxTextChars = Number.isFinite(opts.maxTextChars) ? opts.maxTextChars : DEFAULT_MAX_TEXT_CHARS;
      this.systemTitle = opts.systemTitle || "System";

      this.pendingEntries = [];
      this.pendingUpdatedEntries = new Map();
      this.renderCount = 0;
      this.nextEntryId = 1;
      this.autoScrollPinned = true;
      this.bottomThresholdPx = 20;

      this.entryNodeById = new Map(); // entryId -> { card, body, time, compact }
      this.toolEntriesByCallId = new Map(); // callId -> entry
      this.pendingOptimisticUserKeys = [];
      this.nextTaskGroupId = 1;
      this.activeTaskStack = [];
      this.collapsedTaskIds = new Set();
      this.currentSessionModel = "";
      this.visibleActionEntryId = null;
      this.liveAssistantEntriesByStreamKey = new Map(); // streamKey -> entry
      this.viewMode = "default";
      this.expandedToolEntryIds = new Set();
      this.expandedPlanEntryKeys = new Set();
      this.pinnedAssistantEntryId = null;
      this.assistantPinEnabled = false;
      this.renderAssistantMarkdown = this.resolveAssistantMarkdownPreference(opts.renderAssistantMarkdown);
      this.imagePreviewOverlay = null;
      this.imagePreviewImage = null;

      this.container.addEventListener("scroll", () => {
        this.autoScrollPinned = this.isNearBottom();
      });

      this.refreshVisibility();
    }

    resolveAssistantMarkdownPreference(explicitValue) {
      if (typeof explicitValue === "boolean") {
        return explicitValue;
      }

      try {
        if (typeof localStorage === "undefined") {
          return true;
        }

        const raw = localStorage.getItem(STORAGE_RENDER_ASSISTANT_MARKDOWN_KEY);
        if (raw === null) {
          return true;
        }

        return raw === "1";
      } catch {
        return true;
      }
    }

    persistAssistantMarkdownPreference(enabled) {
      try {
        if (typeof localStorage === "undefined") {
          return;
        }

        localStorage.setItem(STORAGE_RENDER_ASSISTANT_MARKDOWN_KEY, enabled ? "1" : "0");
      } catch {
        // no-op
      }
    }

    shouldRenderAssistantMarkdown(entry, bodyText) {
      if (!this.renderAssistantMarkdown) {
        return false;
      }

      if (!entry || entry.role !== "assistant") {
        return false;
      }

      if (!bodyText || typeof bodyText !== "string" || !bodyText.trim()) {
        return false;
      }

      if (this.isToolEntry(entry)) {
        return false;
      }

      return !this.shouldUsePlanCollapsedBody(entry, bodyText);
    }

    setRenderAssistantMarkdown(enabled, options = {}) {
      const normalized = !!enabled;
      const persist = options.persist === true;
      if (this.renderAssistantMarkdown === normalized) {
        if (persist) {
          this.persistAssistantMarkdownPreference(normalized);
        }
        return;
      }

      this.renderAssistantMarkdown = normalized;
      if (persist) {
        this.persistAssistantMarkdownPreference(normalized);
      }

      for (const node of this.entryNodeById.values()) {
        if (!node || !node.entry) {
          continue;
        }

        this.updateEntryNode(node.entry);
      }
    }

    parseEntryId(value) {
      const normalized = Number(value);
      return Number.isFinite(normalized) ? Math.floor(normalized) : null;
    }

    toEntrySnapshot(entry) {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      return {
        id: this.parseEntryId(entry.id),
        role: entry.role || "",
        title: entry.title || "",
        text: entry.text || "",
        bodyText: this.getEntryBodyText(entry),
        timestamp: entry.timestamp || null,
        rawType: entry.rawType || "",
        kind: entry.kind || "",
        compact: entry.compact === true,
        taskId: entry.taskId || null,
        taskDepth: Number.isFinite(entry.taskDepth) ? entry.taskDepth : 0,
        taskBoundary: entry.taskBoundary || null
      };
    }

    dispatchTimelineEvent(name, detail = {}) {
      if (!this.container || typeof this.container.dispatchEvent !== "function") {
        return;
      }

      try {
        this.container.dispatchEvent(new CustomEvent(`codex:${name}`, { detail }));
      } catch {
        // no-op
      }
    }

    normalizeViewMode(value) {
      if (value === "condensed-user" || value === "user-anchors") {
        return "user-anchors";
      }

      return "default";
    }

    isUserAnchorsMode() {
      return this.viewMode === "user-anchors";
    }

    setViewMode(mode) {
      const normalized = this.normalizeViewMode(mode);
      if (this.viewMode === normalized) {
        return;
      }

      this.viewMode = normalized;
      this.refreshVisibility();
    }

    isEntryHiddenForCurrentMode(entry) {
      return this.isUserAnchorsMode() && entry?.role !== "user";
    }

    getEntryVisibility(entry) {
      const hiddenByMode = this.isEntryHiddenForCurrentMode(entry);
      const hiddenByTask = !this.isUserAnchorsMode() && !hiddenByMode && this.isEntryHiddenForCollapsedTask(entry);
      return {
        hidden: hiddenByMode || hiddenByTask
      };
    }

    rebuildTaskContextForRenderedEntries() {
      const stack = [];

      for (const node of this.entryNodeById.values()) {
        const entry = node?.entry;
        if (!entry) {
          continue;
        }

        const taskId = typeof entry.taskId === "string" && entry.taskId.trim().length > 0
          ? entry.taskId
          : null;

        if (entry.taskBoundary === "start" && taskId) {
          stack.push(taskId);
          entry.taskPath = stack.slice();
          entry.taskDepth = stack.length;
          continue;
        }

        if (entry.taskBoundary === "end" && taskId) {
          if (stack.length > 0 && stack[stack.length - 1] === taskId) {
            entry.taskPath = stack.slice();
            entry.taskDepth = stack.length;
            stack.pop();
            continue;
          }

          const fallbackIndex = stack.lastIndexOf(taskId);
          if (fallbackIndex >= 0) {
            entry.taskPath = stack.slice(0, fallbackIndex + 1);
            entry.taskDepth = fallbackIndex + 1;
            stack.splice(fallbackIndex, 1);
            continue;
          }
        }

        if (stack.length > 0) {
          entry.taskPath = stack.slice();
          entry.taskDepth = stack.length;
        } else {
          entry.taskPath = [];
          entry.taskDepth = 0;
        }
      }

      this.activeTaskStack = stack.slice();
    }

    applyTaskStructure(node, entry) {
      if (!node || !node.card || !entry) {
        return;
      }

      const isChild = Number.isFinite(entry.taskDepth) && entry.taskDepth > 0 && !entry.taskBoundary && entry.taskAnchor !== true;
      node.card.classList.toggle("watcher-task-child", isChild);
      if (isChild) {
        node.card.style.setProperty("--task-depth", String(entry.taskDepth));
      } else {
        node.card.style.removeProperty("--task-depth");
      }
      node.card.classList.toggle("watcher-task-start", entry.taskBoundary === "start");
      node.card.classList.toggle("watcher-task-end", entry.taskBoundary === "end");
    }

    applyEntryVisibility(node, entry) {
      if (!node || !node.card || !entry) {
        return;
      }

      const visibility = this.getEntryVisibility(entry);
      node.card.classList.toggle("watcher-view-hidden", visibility.hidden);
    }

    refreshVisibility() {
      this.rebuildTaskContextForRenderedEntries();

      for (const node of this.entryNodeById.values()) {
        if (!node || !node.entry) {
          continue;
        }

        this.applyTaskStructure(node, node.entry);
        this.updateTaskToggleState(node, node.entry);
        this.applyEntryVisibility(node, node.entry);
      }
    }

    setServerMessages(rawMessages) {
      const safeEntries = this.normalizeServerMessages(rawMessages);
      const shouldStick = this.autoScrollPinned || this.isNearBottom();
      const livePlanKeys = this.collectPlanStateKeysFromEntries(safeEntries);
      for (const key of Array.from(this.expandedPlanEntryKeys)) {
        if (!livePlanKeys.has(key)) {
          this.expandedPlanEntryKeys.delete(key);
        }
      }

      this.pendingEntries = [];
      this.pendingUpdatedEntries.clear();
      this.entryNodeById.clear();
      this.toolEntriesByCallId.clear();
      this.liveAssistantEntriesByStreamKey.clear();
      this.visibleActionEntryId = null;
      this.container.textContent = "";
      this.expandedToolEntryIds.clear();
      this.activeTaskStack = [];
      this.collapsedTaskIds.clear();
      this.nextTaskGroupId = 1;
      this.pinnedAssistantEntryId = null;
      this.assistantPinEnabled = this.hasOpenTaskInEntries(safeEntries);

      for (const entry of safeEntries) {
        this.pendingEntries.push(entry);
      }

      this.flush();
      this.refreshVisibility();
      if (shouldStick) {
        this.container.scrollTop = this.container.scrollHeight;
        this.autoScrollPinned = true;
      }

      this.dispatchTimelineEvent("timeline-updated", { mode: "messages", messageCount: safeEntries.length });
      try {
        this.container.dispatchEvent(new CustomEvent("codex:timeline-updated"));
      } catch {
        // no-op
      }
    }

    collectPlanStateKeysFromEntries(entries) {
      const keys = new Set();
      if (!Array.isArray(entries)) {
        return keys;
      }

      for (const entry of entries) {
        const bodyText = this.getEntryBodyText(entry);
        if (!this.shouldUsePlanCollapsedBody(entry, bodyText)) {
          continue;
        }

        const key = this.getPlanStateKey(entry, bodyText);
        if (key) {
          keys.add(key);
        }
      }

      return keys;
    }

    normalizeServerMessages(rawMessages) {
      if (!Array.isArray(rawMessages)) {
        return [];
      }

      const entries = [];
      this.toolEntriesByCallId.clear();
      this.activeTaskStack = [];
      this.nextTaskGroupId = 1;

      for (const row of rawMessages) {
        const mapped = this.mapBuffalyMessageRowToEntries(row);
        if (!Array.isArray(mapped) || mapped.length === 0) {
          continue;
        }
        for (const entry of mapped) {
          if (!entry) {
            continue;
          }
          this.annotateEntryWithTaskContext(entry);
          entries.push(entry);
        }
      }

      this.assignTaskConversationAnchors(entries);
      this.repositionTaskStartsAfterFirstUser(entries);
      return entries;
    }

    hasOpenTaskInEntries(entries) {
      if (!Array.isArray(entries) || entries.length === 0) {
        return false;
      }

      const stack = [];
      for (const entry of entries) {
        if (!entry || typeof entry.taskBoundary !== "string") {
          continue;
        }

        const taskId = typeof entry.taskId === "string" && entry.taskId.trim().length > 0
          ? entry.taskId
          : null;

        if (entry.taskBoundary === "start") {
          stack.push(taskId || `__anon_start_${stack.length}`);
          continue;
        }

        if (entry.taskBoundary !== "end" || stack.length === 0) {
          continue;
        }

        if (!taskId) {
          stack.pop();
          continue;
        }

        const topTaskId = stack[stack.length - 1];
        if (topTaskId === taskId) {
          stack.pop();
          continue;
        }

        const fallbackIndex = stack.lastIndexOf(taskId);
        if (fallbackIndex >= 0) {
          stack.splice(fallbackIndex, 1);
        } else {
          stack.pop();
        }
      }

      return stack.length > 0;
    }

    assignTaskConversationAnchors(entries) {
      if (!Array.isArray(entries) || entries.length === 0) {
        return;
      }

      const byTaskId = new Map();
      for (const entry of entries) {
        if (!entry || entry.taskBoundary || !entry.taskId) {
          continue;
        }

        const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
        if (role !== "user" && role !== "assistant") {
          continue;
        }

        if (!byTaskId.has(entry.taskId)) {
          byTaskId.set(entry.taskId, { firstUser: null, lastAssistant: null });
        }

        const taskState = byTaskId.get(entry.taskId);
        if (role === "user" && !taskState.firstUser) {
          taskState.firstUser = entry;
        }
        if (role === "assistant") {
          taskState.lastAssistant = entry;
        }
      }

      for (const entry of entries) {
        if (entry && entry.taskAnchor === true) {
          delete entry.taskAnchor;
        }
      }

      for (const taskState of byTaskId.values()) {
        if (taskState.firstUser) {
          taskState.firstUser.taskAnchor = true;
        }
        if (taskState.lastAssistant) {
          taskState.lastAssistant.taskAnchor = true;
        }
      }
    }

    repositionTaskStartsAfterFirstUser(entries) {
      if (!Array.isArray(entries) || entries.length < 2) {
        return;
      }

      const firstUserByTaskId = new Map();
      const startByTaskId = new Map();

      for (let idx = 0; idx < entries.length; idx++) {
        const entry = entries[idx];
        if (!entry || !entry.taskId) {
          continue;
        }

        if (entry.taskBoundary === "start") {
          if (!startByTaskId.has(entry.taskId)) {
            startByTaskId.set(entry.taskId, { index: idx, entry });
          }
          continue;
        }

        if (entry.taskBoundary) {
          continue;
        }

        const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
        if (role === "user" && !firstUserByTaskId.has(entry.taskId)) {
          firstUserByTaskId.set(entry.taskId, { index: idx, entry });
        }
      }

      const moves = [];
      for (const [taskId, startState] of startByTaskId.entries()) {
        const userState = firstUserByTaskId.get(taskId);
        if (!userState) {
          continue;
        }

        if (startState.index < userState.index) {
          moves.push({
            fromIndex: startState.index,
            toIndex: userState.index
          });
        }
      }

      if (moves.length === 0) {
        return;
      }

      moves.sort((a, b) => b.fromIndex - a.fromIndex);
      for (const move of moves) {
        if (move.fromIndex < 0 || move.fromIndex >= entries.length) {
          continue;
        }

        const [startEntry] = entries.splice(move.fromIndex, 1);
        const insertIndex = Math.max(0, Math.min(entries.length, move.toIndex));
        entries.splice(insertIndex, 0, startEntry);
      }
    }

    mapBuffalyMessageRowToEntries(row) {
      if (!row || typeof row !== "object") {
        return [];
      }

      const role = this.normalizeText(String(row.Role || row.role || ""));
      const normalizedRole = role.toLowerCase();
      const timestamp = this.readSavedTimestamp(row);
      if (normalizedRole === "event") {
        return this.mapBuffalyEventRow(row, timestamp);
      }

      if (normalizedRole === "subagent") {
        return this.mapBuffalySubAgentRow(row, timestamp);
      }

      if (normalizedRole === "tools") {
        return this.mapBuffalyToolsRow(row, timestamp);
      }

      if (normalizedRole === "assistant") {
        const tools = this.extractAssistantToolsFromContent(row.Content ?? row.content);
        if (tools.length > 0) {
          const toolEntries = tools.map((tool) => this.createToolEntry(
            `Tool Call: ${tool.toolName || "tool"}`,
            timestamp,
            "function_call",
            tool.toolName || "tool",
            tool.callId || null,
            tool.command || "",
            [],
            ""
          ));
          for (const toolEntry of toolEntries) {
            if (toolEntry && toolEntry.callId) {
              this.toolEntriesByCallId.set(toolEntry.callId, toolEntry);
            }
          }
          return toolEntries;
        }

        return this.mapBuffalyConversationRow("assistant", "Assistant", row, timestamp);
      }

      if (normalizedRole === "user") {
        const mapped = this.mapBuffalyConversationRow("user", "User", row, timestamp);
        if (mapped.length === 1) {
          const entry = mapped[0];
          const key = this.createUserMessageKey(entry.text, entry.images || []);
          if (this.consumeOptimisticUserKey(key)) {
            return [];
          }
        }
        return mapped;
      }

      if (normalizedRole === "system") {
        return this.mapBuffalyConversationRow("system", "System", row, timestamp);
      }

      return [];
    }

    mapBuffalyConversationRow(fallbackRole, fallbackTitle, row, timestamp) {
      const extracted = this.extractMessageTextAndImages(row.Content ?? row.content, row.ContentParts ?? row.contentParts ?? row.content_parts);
      if (!extracted.text && extracted.images.length === 0) {
        return [];
      }

      return [
        this.createEntry(
          fallbackRole,
          fallbackTitle,
          extracted.text,
          timestamp,
          "message",
          extracted.images
        )
      ];
    }

    mapBuffalyToolsRow(row, timestamp) {
      const toolName = this.normalizeNullableToken(row.ToolName ?? row.toolName ?? row.Name ?? row.name) || "tool";
      const callId = this.normalizeNullableToken(row.ToolCallId ?? row.toolCallId ?? row.call_id);
      const output = this.extractContentText(row.Content ?? row.content) || "";
      const entry = this.createToolEntry("Tool Output", timestamp, "function_call_output", toolName, callId, "", [], output);
      if (callId) {
        const existing = this.toolEntriesByCallId.get(callId) || null;
        if (existing) {
          existing.output = output || existing.output;
          existing.timestamp = timestamp || existing.timestamp;
          this.queueEntryUpdate(existing);
          return [];
        }
      }
      return [entry];
    }

    mapBuffalySubAgentRow(row, timestamp) {
      const entries = [];
      const subAgent = (row.SubAgent && typeof row.SubAgent === "object") ? row.SubAgent : (row.subAgent || {});
      const label = this.normalizeText(subAgent.Label || subAgent.label || row.Name || row.name || "SubAgent");
      const status = this.normalizeText(subAgent.Status || subAgent.status || "running");
      const summary = `${label} - ${status}`;
      const summaryEntry = this.createEntry("system", "SubAgent", summary, timestamp, "subagent");
      summaryEntry.compact = true;
      entries.push(summaryEntry);

      const nested = Array.isArray(row.Messages) ? row.Messages : (Array.isArray(row.messages) ? row.messages : []);
      for (const nestedRow of nested) {
        const nestedEntries = this.mapBuffalyMessageRowToEntries(nestedRow);
        for (const nestedEntry of nestedEntries) {
          if (nestedEntry) {
            entries.push(nestedEntry);
          }
        }
      }

      return entries;
    }

    mapBuffalyEventRow(row, timestamp) {
      const name = this.normalizeText(String(row.Name || row.name || "")).toLowerCase();
      const eventPayload = (row.Event && typeof row.Event === "object") ? row.Event : (row.event || {});
      const summary = this.extractContentText(eventPayload.Summary ?? eventPayload.summary ?? row.Content ?? row.content);
      if (name === "turn_started") {
        const entry = this.createEntry("system", "Task Started", this.truncateText(summary || "Turn started", 240), timestamp, "task_started");
        entry.compact = true;
        return [this.markTaskStart(entry)];
      }

      if (name === "turn_completed") {
        const status = this.normalizeText(String(eventPayload.Status || eventPayload.status || "completed")).toLowerCase();
        const suffix = status && status !== "completed" ? ` (${status})` : "";
        const entry = this.createEntry("system", "Task Complete", this.truncateText(summary || `Turn completed${suffix}`, 240), timestamp, "task_complete");
        entry.compact = true;
        return [this.markTaskEnd(entry)];
      }

      if (name === "context_compression") {
        const entry = this.createEntry("system", "Context Compression", this.truncateText(summary || "Context compressed", 240), timestamp, "thread_compacted");
        entry.compact = true;
        return [entry];
      }

      if (name === "plan_updated" || name === "plan_update") {
        const planText = summary || "Plan updated";
        const entry = this.createEntry("system", "Plan Updated", this.truncateText(planText, 240), timestamp, "plan_updated");
        entry.compact = true;
        return [entry];
      }

      if (name === "reasoning_summary") {
        const entry = this.createEntry("reasoning", "Reasoning Summary", this.truncateText(summary || "Reasoning updated", 1200), timestamp, "reasoning");
        return [entry];
      }

      const fallbackText = summary || (name ? `Event: ${name}` : "Event");
      const entry = this.createEntry("system", `Event: ${name || "unknown"}`, this.truncateText(fallbackText, 1200), timestamp, name || "event");
      entry.compact = true;
      return [entry];
    }

    extractAssistantToolsFromContent(content) {
      if (!content || typeof content !== "object" || Array.isArray(content)) {
        return [];
      }
      const tools = Array.isArray(content.tools) ? content.tools : [];
      const output = [];
      for (const tool of tools) {
        if (!tool || typeof tool !== "object") {
          continue;
        }
        output.push({
          toolName: this.normalizeNullableToken(tool.tool ?? tool.name),
          callId: this.normalizeNullableToken(tool.call_id ?? tool.callId),
          command: this.normalizeText(String(tool.command || "")),
          arguments: typeof tool.arguments === "string" ? tool.arguments : JSON.stringify(tool.arguments ?? "")
        });
      }
      return output;
    }

    extractMessageTextAndImages(content, contentParts) {
      const images = [];
      if (Array.isArray(contentParts)) {
        for (const part of contentParts) {
          if (!part || typeof part !== "object") {
            continue;
          }
          const type = this.normalizeText(String(part.Type || part.type || "")).toLowerCase();
          const imageUrl = this.normalizeText(String(part.ImageUrl || part.imageUrl || part.image_url || part.url || ""));
          if (!imageUrl) {
            continue;
          }
          if (type === "imageurl" || type === "image_url" || type === "input_image" || type === "image" || type === "1") {
            images.push(imageUrl);
          }
        }
      }

      const text = this.extractContentText(content);
      return { text, images };
    }

    extractContentText(content) {
      if (content === null || content === undefined) {
        return "";
      }
      if (typeof content === "string") {
        return this.normalizeText(content);
      }
      if (typeof content === "number" || typeof content === "boolean") {
        return String(content);
      }
      if (Array.isArray(content)) {
        const parts = [];
        for (const item of content) {
          const text = this.extractTextFromUnknownValue(item, 0);
          if (text) {
            parts.push(text);
          }
        }
        return this.normalizeText(parts.join("\n"));
      }
      if (typeof content === "object") {
        const fromPayload = this.extractTextFromUnknownValue(content, 0);
        if (fromPayload) {
          return this.normalizeText(fromPayload);
        }
        try {
          return this.normalizeText(JSON.stringify(content));
        } catch {
          return "";
        }
      }
      return "";
    }

    readSavedTimestamp(row) {
      const candidates = [
        row.Timestamp, row.timestamp, row.CreatedAt, row.createdAt, row.CreatedOn, row.createdOn, row.DateCreated, row.dateCreated, row.Date, row.date
      ];
      for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim().length > 0) {
          return candidate.trim();
        }
      }
      return null;
    }

    normalizeNullableToken(value) {
      if (value === null || value === undefined) {
        return null;
      }
      const normalized = this.normalizeText(String(value));
      if (!normalized) {
        return null;
      }
      const lowered = normalized.toLowerCase();
      if (lowered === "null" || lowered === "\"null\"" || lowered === "undefined") {
        return null;
      }
      return normalized;
    }


    formatTime(value) {
      if (!value) {
        return "";
      }

      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return value;
      }

      return date.toLocaleString();
    }

    normalizeText(text) {
      if (!text) {
        return "";
      }

      return String(text)
        .replace(/\r/g, "")
        .replace(ANSI_ESCAPE_REGEX, "")
        .trimEnd();
    }

    classifyDiffLine(line) {
      if (typeof line !== "string" || !line.length) {
        return "";
      }

      if (line.startsWith("@@")) {
        return "hunk";
      }

      if (line.startsWith("+") && !line.startsWith("+++")) {
        return "add";
      }

      if (line.startsWith("-") && !line.startsWith("---")) {
        return "remove";
      }

      if (line.startsWith("diff ")
        || line.startsWith("index ")
        || line.startsWith("+++ ")
        || line.startsWith("--- ")) {
        return "header";
      }

      if (line.startsWith("*** Begin Patch")
        || line.startsWith("*** End Patch")
        || line.startsWith("*** Add File:")
        || line.startsWith("*** Update File:")
        || line.startsWith("*** Delete File:")
        || line.startsWith("*** Move to:")
        || line.startsWith("*** End of File")) {
        return "header";
      }

      return "";
    }

    isLikelyDiffText(text) {
      const normalized = this.normalizeText(text || "");
      if (!normalized) {
        return false;
      }

      const lines = normalized.split("\n");
      if (lines.length < 2) {
        return false;
      }

      let addCount = 0;
      let removeCount = 0;
      let headerCount = 0;
      for (const line of lines) {
        const kind = this.classifyDiffLine(line);
        if (kind === "add") {
          addCount++;
        } else if (kind === "remove") {
          removeCount++;
        } else if (kind === "header" || kind === "hunk") {
          headerCount++;
        }
      }

      return (addCount > 0 && removeCount > 0) || (headerCount > 0 && (addCount > 0 || removeCount > 0));
    }

    renderTextWithOptionalDiffHighlight(element, text) {
      if (!element) {
        return;
      }

      const normalized = this.normalizeText(text || "");
      element.classList.remove("watcher-diff-block");
      element.textContent = "";
      if (!normalized) {
        return;
      }

      if (!this.isLikelyDiffText(normalized)) {
        element.textContent = normalized;
        return;
      }

      element.classList.add("watcher-diff-block");
      const lines = normalized.split("\n");
      for (const line of lines) {
        const lineNode = document.createElement("span");
        lineNode.className = "watcher-diff-line";
        const lineKind = this.classifyDiffLine(line);
        if (lineKind) {
          lineNode.classList.add(`watcher-diff-${lineKind}`);
        }
        lineNode.textContent = line;
        element.appendChild(lineNode);
      }
    }

    createToolPreBlock(className, text) {
      const block = document.createElement("pre");
      block.className = className;
      this.renderTextWithOptionalDiffHighlight(block, text);
      return block;
    }

    truncateText(text, maxLength = this.maxTextChars) {
      const normalized = this.normalizeText(text);
      if (normalized.length <= maxLength) {
        return normalized;
      }

      return `${normalized.slice(0, maxLength)}\n... (truncated)`;
    }

    setSessionModel(model) {
      this.currentSessionModel = this.normalizeModelName(model);
    }

    normalizeModelName(value) {
      const normalized = typeof value === "string" ? value.trim() : "";
      if (!normalized) {
        return "";
      }

      return normalized.length > 200 ? normalized.slice(0, 200) : normalized;
    }

    createEntry(role, title, text, timestamp, rawType, images) {
      return {
        id: this.nextEntryId++,
        role,
        title,
        text: text || "",
        timestamp: timestamp || null,
        rawType: rawType || "",
        images: Array.isArray(images) ? images.slice() : [],
        rendered: false
      };
    }

    createToolEntry(title, timestamp, rawType, toolName, callId, command, details, output) {
      return {
        id: this.nextEntryId++,
        role: "tool",
        title,
        timestamp: timestamp || null,
        rawType: rawType || "",
        rendered: false,
        kind: "tool",
        toolName: toolName || null,
        callId: callId || null,
        command: command || "",
        details: Array.isArray(details) ? details : [],
        output: output || ""
      };
    }

    isToolEntry(entry) {
      if (!entry || typeof entry !== "object") {
        return false;
      }

      if (entry.kind === "tool") {
        return true;
      }

      return entry.role === "tool";
    }

    clear() {
      this.pendingEntries = [];
      this.pendingUpdatedEntries.clear();
      this.renderCount = 0;
      this.container.textContent = "";
      this.expandedToolEntryIds.clear();
      this.entryNodeById.clear();
      this.toolEntriesByCallId.clear();
      this.pendingOptimisticUserKeys = [];
      this.nextTaskGroupId = 1;
      this.activeTaskStack = [];
      this.collapsedTaskIds.clear();
      this.currentSessionModel = "";
      this.autoScrollPinned = true;
      this.visibleActionEntryId = null;
      this.liveAssistantEntriesByStreamKey.clear();
      this.viewMode = "default";
      this.pinnedAssistantEntryId = null;
      this.assistantPinEnabled = false;
      this.refreshVisibility();
      this.dispatchTimelineEvent("timeline-cleared");
    }

    isPinnableAssistantEntry(entry) {
      return this.assistantPinEnabled === true && !!entry && entry.role === "assistant" && entry.compact !== true;
    }

    setAssistantPinEnabled(enabled) {
      const nextEnabled = enabled === true;
      if (this.assistantPinEnabled === nextEnabled) {
        return;
      }

      this.assistantPinEnabled = nextEnabled;
      if (!nextEnabled) {
        this.setPinnedAssistantEntryId(null);
        return;
      }

      let latestAssistantEntryId = null;
      for (const node of this.entryNodeById.values()) {
        const entry = node && node.entry ? node.entry : null;
        if (entry && entry.role === "assistant" && entry.compact !== true) {
          latestAssistantEntryId = entry.id;
        }
      }

      if (Number.isFinite(latestAssistantEntryId)) {
        this.setPinnedAssistantEntryId(latestAssistantEntryId);
      }
    }

    updateAssistantPinEnabledFromTaskBoundary(entry) {
      if (!entry || entry.taskBoundary !== "start" && entry.taskBoundary !== "end") {
        return;
      }

      if (entry.taskBoundary === "start") {
        this.setAssistantPinEnabled(true);
        return;
      }

      this.setAssistantPinEnabled(this.activeTaskStack.length > 0);
    }

    setPinnedAssistantEntryId(entryId) {
      const priorId = Number.isFinite(this.pinnedAssistantEntryId) ? this.pinnedAssistantEntryId : null;
      if (priorId !== null && priorId !== entryId) {
        const priorNode = this.entryNodeById.get(priorId);
        if (priorNode && priorNode.card) {
          priorNode.card.classList.remove("watcher-entry-assistant-pinned");
        }
      }

      const nextId = Number.isFinite(entryId) ? entryId : null;
      this.pinnedAssistantEntryId = nextId;
      if (nextId !== null) {
        const nextNode = this.entryNodeById.get(nextId);
        if (nextNode && nextNode.card) {
          nextNode.card.classList.add("watcher-entry-assistant-pinned");
        }
      }
    }

    placeNodeInTimeline(card, entry) {
      if (!card || !this.container) {
        return;
      }

      if (this.assistantPinEnabled !== true) {
        this.container.appendChild(card);
        return;
      }

      const pinnedId = Number.isFinite(this.pinnedAssistantEntryId) ? this.pinnedAssistantEntryId : null;
      const pinnedNode = pinnedId !== null ? this.entryNodeById.get(pinnedId) : null;
      const pinnedCard = pinnedNode && pinnedNode.card && pinnedNode.card.parentElement === this.container
        ? pinnedNode.card
        : null;

      if (this.isPinnableAssistantEntry(entry)) {
        this.container.appendChild(card);
        return;
      }

      if (pinnedCard && pinnedCard !== card) {
        this.container.insertBefore(card, pinnedCard);
        return;
      }

      this.container.appendChild(card);
    }

    isNearBottom() {
      const remaining = this.container.scrollHeight - (this.container.scrollTop + this.container.clientHeight);
      return remaining <= this.bottomThresholdPx;
    }

    markTaskStart(entry) {
      const taskId = `task-${this.nextTaskGroupId++}`;
      this.activeTaskStack.push(taskId);
      entry.taskId = taskId;
      entry.taskDepth = this.activeTaskStack.length;
      entry.taskBoundary = "start";
      entry.taskPath = this.activeTaskStack.slice();
      return entry;
    }

    markTaskEnd(entry) {
      const depth = this.activeTaskStack.length;
      const taskId = depth > 0 ? this.activeTaskStack[depth - 1] : null;
      entry.taskId = taskId;
      entry.taskDepth = depth;
      entry.taskBoundary = "end";
      entry.taskPath = this.activeTaskStack.slice();
      if (depth > 0) {
        this.activeTaskStack.pop();
      }
      return entry;
    }

    annotateEntryWithTaskContext(entry) {
      if (!entry) {
        return null;
      }

      if (!entry.taskBoundary && this.activeTaskStack.length > 0) {
        entry.taskId = this.activeTaskStack[this.activeTaskStack.length - 1];
        entry.taskDepth = this.activeTaskStack.length;
        entry.taskPath = this.activeTaskStack.slice();
      }

      return entry;
    }

    isEntryHiddenForCollapsedTask(entry) {
      if (!entry || !Array.isArray(entry.taskPath) || entry.taskPath.length === 0) {
        return false;
      }

      if (entry.taskAnchor === true) {
        return false;
      }

      for (const taskId of entry.taskPath) {
        if (!this.collapsedTaskIds.has(taskId)) {
          continue;
        }

        if (entry.taskBoundary === "start" && entry.taskId === taskId) {
          continue;
        }

        if (entry.taskBoundary === "end" && entry.taskId === taskId) {
          continue;
        }

        return true;
      }

      return false;
    }

    updateTaskToggleState(node, entry) {
      if (!node || !node.taskToggle || !entry || !entry.taskId || entry.taskBoundary !== "start") {
        return;
      }

      const collapsed = this.collapsedTaskIds.has(entry.taskId);
      node.taskToggle.textContent = collapsed ? "[+]" : "[-]";
      node.card.classList.toggle("watcher-task-collapsed", collapsed);
      node.card.setAttribute("aria-expanded", collapsed ? "false" : "true");
      node.card.setAttribute("aria-label", collapsed ? "Expand task section" : "Collapse task section");
    }

    toggleTaskCollapsed(taskId) {
      if (!taskId) {
        return;
      }

      if (this.collapsedTaskIds.has(taskId)) {
        this.collapsedTaskIds.delete(taskId);
      } else {
        this.collapsedTaskIds.add(taskId);
      }

      this.refreshVisibility();
    }

    enqueueSystem(text, title = this.systemTitle, options = {}) {
      const entry = this.createEntry("system", title, String(text || ""), new Date().toISOString(), "system");
      if (options && options.compact === true) {
        entry.compact = true;
      }
      this.pendingEntries.push(entry);
    }

    enqueueInlineNotice(text) {
      const entry = this.createEntry("system", "Note", String(text || ""), new Date().toISOString(), "inline_notice");
      entry.compact = true;
      this.pendingEntries.push(entry);
    }

    enqueueOptimisticUserMessage(text, images) {
      const safeImages = Array.isArray(images) ? images.filter((x) => typeof x === "string" && x.trim().length > 0) : [];
      const normalizedText = this.normalizeText(text || "");
      const key = this.createUserMessageKey(normalizedText, safeImages);
      if (key) {
        if (this.pendingOptimisticUserKeys.includes(key)) {
          return;
        }
        this.pendingOptimisticUserKeys.push(key);
        if (this.pendingOptimisticUserKeys.length > 40) {
          this.pendingOptimisticUserKeys.shift();
        }
      }

      this.pendingEntries.push(this.createEntry("user", "User", normalizedText, new Date().toISOString(), "optimistic_user", safeImages));
    }

    beginEventTask(summary, timestamp = null) {
      const entry = this.createEntry(
        "system",
        "Task Started",
        this.truncateText(summary || "Task started", 240),
        timestamp || new Date().toISOString(),
        "task_started"
      );
      entry.compact = true;
      this.pendingEntries.push(this.markTaskStart(entry));
    }

    completeEventTask(summary, timestamp = null) {
      const entry = this.createEntry(
        "system",
        "Task Complete",
        this.truncateText(summary || "Task complete", 240),
        timestamp || new Date().toISOString(),
        "task_complete"
      );
      entry.compact = true;
      this.pendingEntries.push(this.markTaskEnd(entry));
    }

    appendAssistantDelta(text, options = {}) {
      const chunk = String(text || "");
      if (!chunk) {
        return;
      }

      const streamKey = typeof options.streamKey === "string" && options.streamKey.trim().length > 0
        ? options.streamKey.trim()
        : "default";
      const timestamp = options.timestamp || new Date().toISOString();
      const existing = this.liveAssistantEntriesByStreamKey.get(streamKey) || null;
      if (!existing) {
        const created = this.createEntry("assistant", "Assistant", chunk, timestamp, "assistant_delta");
        this.liveAssistantEntriesByStreamKey.set(streamKey, created);
        this.pendingEntries.push(created);
        return;
      }

      existing.text = `${existing.text || ""}${chunk}`;
      existing.timestamp = timestamp || existing.timestamp;
      this.queueEntryUpdate(existing);
    }

    completeAssistantDelta(options = {}) {
      const streamKey = typeof options.streamKey === "string" && options.streamKey.trim().length > 0
        ? options.streamKey.trim()
        : "default";
      const existing = this.liveAssistantEntriesByStreamKey.get(streamKey) || null;
      if (!existing) {
        return;
      }

      existing.timestamp = options.timestamp || existing.timestamp;
      existing.rawType = "assistant_done";
      this.queueEntryUpdate(existing);
      this.liveAssistantEntriesByStreamKey.delete(streamKey);
    }

    normalizeServerEntry(rawEntry) {
      if (!rawEntry || typeof rawEntry !== "object") {
        return null;
      }

      let entryId = this.parseEntryId(rawEntry.id);
      if (entryId === null) {
        entryId = this.nextEntryId++;
      } else if (entryId >= this.nextEntryId) {
        this.nextEntryId = entryId + 1;
      }

      const role = typeof rawEntry.role === "string" && rawEntry.role.trim().length > 0
        ? rawEntry.role.trim()
        : "system";
      const title = typeof rawEntry.title === "string" && rawEntry.title.trim().length > 0
        ? rawEntry.title.trim()
        : (role === "assistant" ? "Assistant" : "System");
      const text = this.truncateText(rawEntry.text || "", MAX_TIMELINE_ENTRY_TEXT_CHARS);
      const rawType = typeof rawEntry.rawType === "string" ? rawEntry.rawType : "";
      const images = Array.isArray(rawEntry.images)
        ? rawEntry.images
          .filter((x) => typeof x === "string" && x.trim().length > 0)
          .map((x) => x.trim())
          .filter((x) => !(x.startsWith("data:") && x.length > MAX_TIMELINE_IMAGE_URL_CHARS))
        : [];
      const taskDepthRaw = Number(rawEntry.taskDepth);
      const taskDepth = Number.isFinite(taskDepthRaw) ? Math.max(0, Math.floor(taskDepthRaw)) : 0;
      const taskBoundary = (typeof rawEntry.taskBoundary === "string" && rawEntry.taskBoundary)
        ? rawEntry.taskBoundary
        : null;
      const taskId = typeof rawEntry.taskId === "string" && rawEntry.taskId.trim().length > 0
        ? rawEntry.taskId.trim()
        : null;

      return {
        id: entryId,
        role,
        kind: typeof rawEntry.kind === "string" ? rawEntry.kind : "",
        title,
        text,
        timestamp: rawEntry.timestamp || null,
        rawType,
        compact: rawEntry.compact === true,
        taskId,
        taskDepth,
        taskBoundary,
        images,
        rendered: false
      };
    }

    enqueueServerEntries(entries) {
      if (!Array.isArray(entries) || entries.length === 0) {
        return;
      }

      for (const rawEntry of entries) {
        const normalized = this.normalizeServerEntry(rawEntry);
        if (!normalized) {
          continue;
        }

        const existingNode = this.entryNodeById.get(normalized.id) || null;
        if (existingNode && existingNode.entry) {
          const existing = existingNode.entry;
          existing.role = normalized.role;
          existing.title = normalized.title;
          existing.text = normalized.text;
          existing.timestamp = normalized.timestamp;
          existing.rawType = normalized.rawType;
          existing.compact = normalized.compact === true;
          existing.taskId = normalized.taskId;
          existing.taskDepth = normalized.taskDepth;
          existing.taskBoundary = normalized.taskBoundary;
          existing.images = normalized.images;
          this.queueEntryUpdate(existing);
          continue;
        }

        this.pendingEntries.push(normalized);
      }
    }

    flush() {
      if (this.pendingEntries.length === 0 && this.pendingUpdatedEntries.size === 0) {
        return;
      }

      const shouldStick = this.autoScrollPinned || this.isNearBottom();

      if (this.pendingEntries.length > 0) {
        for (const entry of this.pendingEntries) {
          try {
            this.appendEntryNode(entry);
          } catch (error) {
            if (typeof console !== "undefined" && typeof console.error === "function") {
              console.error("timeline append failed", error, entry);
            }
          }
        }
        this.pendingEntries = [];
      }

      if (this.pendingUpdatedEntries.size > 0) {
        for (const entry of this.pendingUpdatedEntries.values()) {
          try {
            this.updateEntryNode(entry);
          } catch (error) {
            if (typeof console !== "undefined" && typeof console.error === "function") {
              console.error("timeline update failed", error, entry);
            }
          }
        }
        this.pendingUpdatedEntries.clear();
      }

      if (shouldStick) {
        this.container.scrollTop = this.container.scrollHeight;
        this.autoScrollPinned = true;
      }

      try {
        this.container.dispatchEvent(new CustomEvent("codex:timeline-updated"));
      } catch (error) {
        if (typeof console !== "undefined" && typeof console.error === "function") {
          console.error("timeline update event failed", error);
        }
      }
    }

    tryParseJson(text) {
      if (!text || typeof text !== "string") {
        return null;
      }

      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    }

    createUserMessageKey(text, imageUrls) {
      const normalizedText = this.normalizeText(text || "");
      const normalizedUrls = Array.isArray(imageUrls)
        ? imageUrls
          .filter((x) => typeof x === "string" && x.trim().length > 0)
          .map((x) => this.normalizeText(x).slice(0, 200))
        : [];

      if (!normalizedText && normalizedUrls.length === 0) {
        return "";
      }

      return `${normalizedText}|||${normalizedUrls.join("|")}`;
    }

    consumeOptimisticUserKey(key) {
      if (!key) {
        return false;
      }

      const index = this.pendingOptimisticUserKeys.indexOf(key);
      if (index < 0) {
        return false;
      }

      this.pendingOptimisticUserKeys.splice(index, 1);
      return true;
    }

    extractImageUrlFromContentItem(item) {
      if (!item || typeof item !== "object") {
        return null;
      }

      if (typeof item.url === "string" && item.url.trim().length > 0) {
        return item.url;
      }

      if (typeof item.image_url === "string" && item.image_url.trim().length > 0) {
        return item.image_url;
      }

      if (item.image_url && typeof item.image_url === "object" && typeof item.image_url.url === "string") {
        return item.image_url.url;
      }

      if (item.imageUrl && typeof item.imageUrl === "string" && item.imageUrl.trim().length > 0) {
        return item.imageUrl;
      }

      if (item.imageUrl && typeof item.imageUrl === "object" && typeof item.imageUrl.url === "string") {
        return item.imageUrl.url;
      }

      return null;
    }

    extractTextFromUnknownValue(value, depth = 0) {
      if (depth > 6 || value === null || value === undefined) {
        return "";
      }

      if (typeof value === "string") {
        return value.trim();
      }

      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }

      if (Array.isArray(value)) {
        const chunks = [];
        for (const item of value) {
          const text = this.extractTextFromUnknownValue(item, depth + 1);
          if (text) {
            chunks.push(text);
          }
        }
        return chunks.join("\n");
      }

      if (typeof value !== "object") {
        return "";
      }

      const directStringKeys = ["text", "value", "output_text", "outputText", "message"];
      for (const key of directStringKeys) {
        if (typeof value[key] === "string" && value[key].trim().length > 0) {
          return value[key].trim();
        }
      }

      const nestedKeys = ["text", "value", "output_text", "outputText", "content", "parts", "items", "message", "output", "data"];
      for (const key of nestedKeys) {
        if (!(key in value)) {
          continue;
        }
        const nested = this.extractTextFromUnknownValue(value[key], depth + 1);
        if (nested) {
          return nested;
        }
      }

      return "";
    }

    extractTextFromContentItem(item) {
      return this.extractTextFromUnknownValue(item, 0);
    }

    extractMessageParts(contentItems) {
      const chunks = [];
      const imageUrls = [];
      if (typeof contentItems === "string") {
        return { text: this.stripImageTagMarkers(this.normalizeText(contentItems)), imageUrls };
      }
      if (!Array.isArray(contentItems)) {
        return { text: "", imageUrls };
      }

      for (const item of contentItems) {
        if (!item || typeof item !== "object") {
          continue;
        }

        const extractedText = this.extractTextFromContentItem(item);
        if (extractedText) {
          chunks.push(extractedText);
          continue;
        }

        const type = typeof item.type === "string" ? item.type : "";
        if (type === "input_image" || type === "image" || type === "image_url" || type === "inputImage") {
          const imageUrl = this.extractImageUrlFromContentItem(item);
          if (typeof imageUrl === "string" && imageUrl.trim().length > 0) {
            imageUrls.push(imageUrl);
            continue;
          }
        }

        const suppressPlaceholder = type === "output_text" ||
          type === "input_text" ||
          type === "outputText" ||
          type === "inputText" ||
          type === "text";
        if (type && !suppressPlaceholder) {
          chunks.push(`[${type}]`);
        }
      }

      return {
        text: this.stripImageTagMarkers(this.normalizeText(chunks.join("\n"))),
        imageUrls
      };
    }

    stripImageTagMarkers(text) {
      const normalized = this.normalizeText(text || "");
      if (!normalized) {
        return "";
      }

      const stripped = normalized
        .replace(/<\s*image\s*>\s*<\s*\/\s*image\s*>/gi, "")
        .replace(/^\s*<\s*image\s*>\s*$/gim, "")
        .replace(/^\s*<\s*\/\s*image\s*>\s*$/gim, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      return stripped;
    }

    extractToolCommand(name, argsObject, rawArguments) {
      if (name === "shell_command" && argsObject && typeof argsObject.command === "string") {
        return this.normalizeText(argsObject.command);
      }

      if (name === "multi_tool_use.parallel" && argsObject && Array.isArray(argsObject.tool_uses)) {
        const commands = [];
        for (let i = 0; i < argsObject.tool_uses.length; i++) {
          const use = argsObject.tool_uses[i] || {};
          const recipient = use.recipient_name || "unknown_tool";
          const parameters = use.parameters || {};

          if (recipient === "functions.shell_command" && typeof parameters.command === "string") {
            commands.push(`[${i + 1}] shell_command: ${this.normalizeText(parameters.command)}`);
            continue;
          }

          commands.push(`[${i + 1}] ${recipient}`);
        }

        if (commands.length > 0) {
          return commands.join("\n");
        }
      }

      if (argsObject && typeof argsObject.command === "string") {
        return this.normalizeText(argsObject.command);
      }

      if (typeof rawArguments === "string" && rawArguments.trim().length > 0) {
        return this.truncateText(rawArguments, 1200);
      }

      return "";
    }

    extractToolDetails(argsObject) {
      if (!argsObject || typeof argsObject !== "object") {
        return [];
      }

      const lines = [];
      if (typeof argsObject.workdir === "string" && argsObject.workdir.trim().length > 0) {
        lines.push(`workdir=${argsObject.workdir}`);
      }
      if (typeof argsObject.timeout_ms === "number") {
        lines.push(`timeoutMs=${argsObject.timeout_ms}`);
      }
      if (typeof argsObject.login === "boolean") {
        lines.push(`login=${argsObject.login}`);
      }
      if (typeof argsObject.sandbox_permissions === "string" && argsObject.sandbox_permissions.trim().length > 0) {
        lines.push(`sandbox=${argsObject.sandbox_permissions}`);
      }

      return lines;
    }

    toSimpleValue(value) {
      if (value === null || value === undefined) {
        return null;
      }

      if (typeof value === "string") {
        return value;
      }

      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }

      return JSON.stringify(value, null, 2);
    }

    formatMetadataLines(metadata, excludedKeys = []) {
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        return [];
      }

      const excluded = new Set(excludedKeys);
      const lines = [];
      for (const [key, value] of Object.entries(metadata)) {
        if (excluded.has(key)) {
          continue;
        }
        const text = this.toSimpleValue(value);
        if (text === null || text === "") {
          continue;
        }
        lines.push(`${key}: ${text}`);
      }

      return lines;
    }

    formatToolOutput(toolName, rawOutput) {
      if (rawOutput === null || rawOutput === undefined) {
        return "";
      }

      let parsed = null;
      if (typeof rawOutput === "string") {
        parsed = this.tryParseJson(rawOutput.trim());
      } else if (typeof rawOutput === "object") {
        parsed = rawOutput;
      }

      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const lines = [];

        const metadata = parsed.metadata && typeof parsed.metadata === "object" ? parsed.metadata : null;
        const status = typeof parsed.status === "string"
          ? parsed.status
          : parsed.success === true
            ? "success"
            : parsed.success === false
              ? "failed"
              : null;
        const exitCode = parsed.exit_code ?? parsed.exitCode ?? metadata?.exit_code ?? metadata?.exitCode ?? null;
        const durationSeconds = parsed.duration_seconds ?? parsed.durationSeconds ?? metadata?.duration_seconds ?? metadata?.durationSeconds ?? null;

        const summaryParts = [];
        if (toolName) summaryParts.push(`tool=${toolName}`);
        if (status) summaryParts.push(`status=${status}`);
        if (exitCode !== null && exitCode !== undefined) summaryParts.push(`exitCode=${exitCode}`);
        if (typeof durationSeconds === "number") summaryParts.push(`durationSeconds=${durationSeconds}`);
        if (summaryParts.length > 0) {
          lines.push("Summary:");
          lines.push(summaryParts.join(" | "));
          lines.push("");
        }

        const outputText = this.toSimpleValue(parsed.output);
        if (outputText) {
          lines.push("Output:");
          lines.push(outputText);
          lines.push("");
        }

        const stdoutText = this.toSimpleValue(parsed.stdout);
        if (stdoutText) {
          lines.push("Stdout:");
          lines.push(stdoutText);
          lines.push("");
        }

        const stderrText = this.toSimpleValue(parsed.stderr);
        if (stderrText) {
          lines.push("Stderr:");
          lines.push(stderrText);
          lines.push("");
        }

        const errorText = this.toSimpleValue(parsed.error);
        if (errorText) {
          lines.push("Error:");
          lines.push(errorText);
          lines.push("");
        }

        const metadataLines = this.formatMetadataLines(metadata, ["exit_code", "exitCode", "duration_seconds", "durationSeconds"]);
        if (metadataLines.length > 0) {
          lines.push("Metadata:");
          for (const line of metadataLines) {
            lines.push(line);
          }
          lines.push("");
        }

        if (lines.length > 0) {
          return this.truncateText(lines.join("\n"));
        }
      }

      if (typeof rawOutput === "string") {
        return this.truncateText(rawOutput);
      }

      return this.truncateText(JSON.stringify(rawOutput, null, 2));
    }

    formatToolEntryText(entry) {
      const lines = [];
      lines.push("Command:");
      lines.push(entry.command || "(command unavailable)");

      if (entry.details && entry.details.length > 0) {
        lines.push("");
        lines.push("Context:");
        for (const detail of entry.details) {
          lines.push(detail);
        }
      }

      lines.push("");
      lines.push("Result:");
      lines.push(entry.output ? entry.output : "(waiting for output)");
      return lines.join("\n");
    }

    getEntryBodyText(entry) {
      if (entry.kind === "tool") {
        return this.formatToolEntryText(entry);
      }

      return this.stripImageTagMarkers(entry.text || "");
    }

    normalizePlanPayloadText(rawText) {
      if (typeof rawText !== "string") {
        return "";
      }

      let text = rawText.replace(/\r/g, "");
      text = text.replace(/^\s*<proposed_plan>\s*/i, "");
      text = text.replace(/\s*<\/proposed_plan>\s*$/i, "");
      return text.trim();
    }

    extractTaggedProposedPlanText(rawText) {
      if (typeof rawText !== "string" || !rawText.trim()) {
        return "";
      }

      const normalized = rawText.replace(/\r/g, "");
      const match = normalized.match(/<proposed_plan>([\s\S]*?)<\/proposed_plan>/i);
      if (!match || typeof match[1] !== "string") {
        return "";
      }

      return this.normalizePlanPayloadText(match[1]);
    }

    isPlanUpdatedRawType(rawType) {
      const normalized = typeof rawType === "string" ? rawType.trim().toLowerCase() : "";
      return normalized === "plan_update" || normalized === "plan_updated" || normalized === "turn/plan/updated";
    }

    isPlanUpdatedEntry(entry) {
      if (!entry || typeof entry !== "object") {
        return false;
      }

      if (this.isPlanUpdatedRawType(entry.rawType || "")) {
        return true;
      }

      const title = typeof entry.title === "string" ? entry.title.trim().toLowerCase() : "";
      return title === "plan updated";
    }

    extractPlanTextForEntry(entry, bodyText) {
      const tagged = this.extractTaggedProposedPlanText(bodyText);
      if (tagged) {
        return tagged;
      }

      if (this.isPlanUpdatedEntry(entry)) {
        return this.normalizePlanPayloadText(bodyText);
      }

      return "";
    }

    getPlanStateKey(entry, bodyText) {
      if (!entry || typeof entry !== "object") {
        return "";
      }

      const planText = this.extractPlanTextForEntry(entry, bodyText);
      if (!planText) {
        return "";
      }

      const role = typeof entry.role === "string" ? entry.role : "";
      const title = typeof entry.title === "string" ? entry.title : "";
      const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "";
      return `${role}|${title}|${timestamp}|${planText}`;
    }

    shouldUsePlanCollapsedBody(entry, bodyText) {
      if (!entry || (entry.role !== "assistant" && entry.role !== "system")) {
        return false;
      }

      return !!this.extractPlanTextForEntry(entry, bodyText);
    }

    appendPlanInlineMarkdown(parent, text) {
      const source = typeof text === "string" ? text : "";
      if (!source) {
        return;
      }

      let cursor = 0;
      while (cursor < source.length) {
        if (source.startsWith("[", cursor)) {
          const labelEnd = source.indexOf("]", cursor + 1);
          if (labelEnd > cursor + 1 && source.startsWith("(", labelEnd + 1)) {
            const urlEnd = source.indexOf(")", labelEnd + 2);
            if (urlEnd > labelEnd + 2) {
              const label = source.slice(cursor + 1, labelEnd);
              const href = source.slice(labelEnd + 2, urlEnd).trim();
              if (href) {
                const link = document.createElement("a");
                link.textContent = label;
                link.href = this.toLocalFileHref(href);
                link.target = "_blank";
                link.rel = "noopener noreferrer";
                parent.appendChild(link);
                cursor = urlEnd + 1;
                continue;
              }
            }
          }
        }

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
        const nextLink = source.indexOf("[", cursor);
        const nextBold = source.indexOf("**", cursor);
        const nextCode = source.indexOf("`", cursor);
        if (nextLink >= 0 && nextLink < next) {
          next = nextLink;
        }
        if (nextBold >= 0 && nextBold < next) {
          next = nextBold;
        }
        if (nextCode >= 0 && nextCode < next) {
          next = nextCode;
        }

        parent.appendChild(document.createTextNode(source.slice(cursor, next)));
        cursor = next;
      }
    }

    toLocalFileHref(rawHref) {
      const value = typeof rawHref === "string" ? rawHref.trim() : "";
      if (!value) {
        return "";
      }

      if (/^[a-zA-Z]:[\\/]/.test(value)) {
        const normalized = value.replace(/\\/g, "/");
        return `file:///${encodeURI(normalized)}`;
      }

      if (value.startsWith("\\\\")) {
        const normalizedUnc = value.replace(/\\/g, "/");
        return `file:${encodeURI(normalizedUnc)}`;
      }

      if (value.startsWith("/")) {
        return `file://${encodeURI(value)}`;
      }

      return value;
    }

    parseMarkdownTableCells(rawLine) {
      const line = typeof rawLine === "string" ? rawLine.trim() : "";
      if (!line || !line.includes("|")) {
        return null;
      }

      let normalized = line;
      if (normalized.startsWith("|")) {
        normalized = normalized.slice(1);
      }
      if (normalized.endsWith("|")) {
        normalized = normalized.slice(0, -1);
      }

      const cells = normalized.split("|").map((cell) => cell.trim());
      if (cells.length < 2) {
        return null;
      }

      return cells;
    }

    isMarkdownTableDivider(rawLine, expectedCellCount) {
      const cells = this.parseMarkdownTableCells(rawLine);
      if (!cells) {
        return false;
      }

      if (expectedCellCount > 0 && cells.length !== expectedCellCount) {
        return false;
      }

      return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
    }

    appendMarkdownTable(fragment, headerCells, bodyRows) {
      if (!fragment || !Array.isArray(headerCells) || headerCells.length === 0) {
        return;
      }

      const wrap = document.createElement("div");
      wrap.className = "watcher-markdown-table-wrap";

      const table = document.createElement("table");
      table.className = "watcher-markdown-table";

      const thead = document.createElement("thead");
      const headerRow = document.createElement("tr");
      for (const cellText of headerCells) {
        const th = document.createElement("th");
        this.appendPlanInlineMarkdown(th, cellText);
        headerRow.appendChild(th);
      }
      thead.appendChild(headerRow);
      table.appendChild(thead);

      if (Array.isArray(bodyRows) && bodyRows.length > 0) {
        const tbody = document.createElement("tbody");
        for (const row of bodyRows) {
          const normalizedRow = Array.isArray(row) ? row.slice(0, headerCells.length) : [];
          while (normalizedRow.length < headerCells.length) {
            normalizedRow.push("");
          }

          const tr = document.createElement("tr");
          for (const cellText of normalizedRow) {
            const td = document.createElement("td");
            this.appendPlanInlineMarkdown(td, cellText);
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
      }

      wrap.appendChild(table);
      fragment.appendChild(wrap);
    }

    renderMarkdownIntoContainer(container, markdownText) {
      if (!container) {
        return;
      }

      container.textContent = "";
      const text = typeof markdownText === "string" ? markdownText.trim() : "";
      if (!text) {
        return;
      }

      const fragment = document.createDocumentFragment();
      const lines = text.split("\n");
      let paragraphLines = [];
      let listElement = null;
      let listType = "";
      let codeBlock = null;
      let codeBlockLines = [];

      const flushParagraph = () => {
        if (paragraphLines.length === 0) {
          return;
        }
        const paragraph = document.createElement("p");
        this.appendPlanInlineMarkdown(paragraph, paragraphLines.join(" ").trim());
        fragment.appendChild(paragraph);
        paragraphLines = [];
      };

      const clearList = () => {
        listElement = null;
        listType = "";
      };

      let index = 0;
      while (index < lines.length) {
        const rawLine = lines[index];
        const line = rawLine.replace(/\s+$/, "");
        const trimmed = line.trim();

        if (codeBlock) {
          if (trimmed.startsWith("```")) {
            this.renderTextWithOptionalDiffHighlight(codeBlock, codeBlockLines.join("\n"));
            codeBlockLines = [];
            codeBlock = null;
          } else {
            codeBlockLines.push(line);
          }
          index += 1;
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
          codeBlockLines = [];
          index += 1;
          continue;
        }

        if (!trimmed) {
          flushParagraph();
          clearList();
          index += 1;
          continue;
        }

        const tableHeaderCells = this.parseMarkdownTableCells(trimmed);
        if (tableHeaderCells && index + 1 < lines.length) {
          const divider = lines[index + 1].replace(/\s+$/, "").trim();
          if (this.isMarkdownTableDivider(divider, tableHeaderCells.length)) {
            flushParagraph();
            clearList();

            const bodyRows = [];
            index += 2;
            while (index < lines.length) {
              const nextLine = lines[index].replace(/\s+$/, "");
              const nextTrimmed = nextLine.trim();
              const nextRowCells = this.parseMarkdownTableCells(nextTrimmed);
              if (!nextTrimmed || !nextRowCells) {
                break;
              }

              bodyRows.push(nextRowCells);
              index += 1;
            }

            this.appendMarkdownTable(fragment, tableHeaderCells, bodyRows);
            continue;
          }
        }

        const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
        if (headingMatch) {
          flushParagraph();
          clearList();
          const level = Math.min(6, headingMatch[1].length);
          const heading = document.createElement(`h${level}`);
          this.appendPlanInlineMarkdown(heading, headingMatch[2]);
          fragment.appendChild(heading);
          index += 1;
          continue;
        }

        const unorderedMatch = trimmed.match(/^[-*]\s+(.*)$/);
        if (unorderedMatch) {
          flushParagraph();
          if (!listElement || listType !== "ul") {
            listElement = document.createElement("ul");
            listType = "ul";
            fragment.appendChild(listElement);
          }
          const item = document.createElement("li");
          this.appendPlanInlineMarkdown(item, unorderedMatch[1]);
          listElement.appendChild(item);
          index += 1;
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
          this.appendPlanInlineMarkdown(item, orderedMatch[1]);
          listElement.appendChild(item);
          index += 1;
          continue;
        }

        clearList();
        paragraphLines.push(trimmed);
        index += 1;
      }

      if (codeBlock) {
        this.renderTextWithOptionalDiffHighlight(codeBlock, codeBlockLines.join("\n"));
      }

      flushParagraph();
      container.appendChild(fragment);
    }

    renderPlanMarkdownIntoContainer(container, markdownText) {
      if (!container) {
        return;
      }

      const text = this.normalizePlanPayloadText(markdownText || "");
      this.renderMarkdownIntoContainer(container, text);
    }

    normalizeMarkdownText(rawText) {
      if (typeof rawText !== "string") {
        return "";
      }

      return rawText.replace(/\r/g, "").trim();
    }

    renderAssistantMarkdownIntoContainer(container, markdownText) {
      if (!container) {
        return;
      }

      const text = this.normalizeMarkdownText(markdownText || "");
      this.renderMarkdownIntoContainer(container, text);
    }

    renderPlanBodyContent(bodyWrap, entry, bodyText) {
      if (!bodyWrap) {
        return;
      }

      const planText = this.extractPlanTextForEntry(entry, bodyText);
      bodyWrap.textContent = "";
      bodyWrap.dataset.bodyKind = "plan";
      if (!planText) {
        const empty = document.createElement("p");
        empty.textContent = "Plan content unavailable.";
        bodyWrap.appendChild(empty);
        return;
      }

      this.renderPlanMarkdownIntoContainer(bodyWrap, planText);
    }

    parseAgentsInstructionHeader(bodyText) {
      const normalized = typeof bodyText === "string" ? bodyText : "";
      if (!normalized) {
        return null;
      }

      const lines = normalized.split("\n");
      if (lines.length === 0) {
        return null;
      }

      const header = lines[0].trim();
      const match = header.match(/^#\s*AGENTS\.md instructions for\s+(.+)$/i);
      if (!match || !match[1]) {
        return null;
      }

      const targetPath = match[1].trim();
      return {
        targetPath,
        hasInstructionBlock: normalized.includes("<INSTRUCTIONS>")
      };
    }

    shouldUseAgentsCollapsedBody(entry, bodyText) {
      if (!entry || entry.role !== "user") {
        return false;
      }

      const parsed = this.parseAgentsInstructionHeader(bodyText);
      return !!parsed && parsed.hasInstructionBlock;
    }

    parseEnvironmentContext(bodyText) {
      const normalized = typeof bodyText === "string" ? bodyText.trim() : "";
      if (!normalized) {
        return null;
      }

      if (!/^<environment_context>[\s\S]*<\/environment_context>$/i.test(normalized)) {
        return null;
      }

      const readTag = (tagName) => {
        const match = normalized.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i"));
        if (!match || typeof match[1] !== "string") {
          return "";
        }

        return match[1].trim();
      };

      return {
        cwd: readTag("cwd"),
        shell: readTag("shell")
      };
    }

    shouldUseEnvironmentCollapsedBody(entry, bodyText) {
      if (!entry || entry.role !== "user") {
        return false;
      }

      return !!this.parseEnvironmentContext(bodyText);
    }

    shouldUseEmbeddedInstructionPresentation(entry, bodyText) {
      if (!entry || entry.role !== "user") {
        return false;
      }

      return this.shouldUseAgentsCollapsedBody(entry, bodyText)
        || this.shouldUseEnvironmentCollapsedBody(entry, bodyText);
    }

    isNarrowViewport() {
      return typeof window !== "undefined"
        && typeof window.matchMedia === "function"
        && window.matchMedia("(max-width: 900px)").matches;
    }

    shouldUseCollapsibleBody(entry) {
      return this.isNarrowViewport() && entry && entry.role === "tool";
    }

    buildToolBodySegments(bodyText) {
      const normalized = this.normalizeText(bodyText || "");
      if (!normalized) {
        return null;
      }

      const lines = normalized.split("\n");
      const minimumTotalLines = TOOL_PREVIEW_HEAD_LINES + TOOL_PREVIEW_TAIL_LINES + TOOL_PREVIEW_MIN_HIDDEN_LINES;
      if (lines.length < minimumTotalLines) {
        return null;
      }

      const hiddenStart = Math.min(TOOL_PREVIEW_HEAD_LINES, lines.length);
      const hiddenEnd = Math.max(hiddenStart, lines.length - TOOL_PREVIEW_TAIL_LINES);
      const hiddenCount = hiddenEnd - hiddenStart;
      if (hiddenCount < TOOL_PREVIEW_MIN_HIDDEN_LINES) {
        return null;
      }

      return {
        headText: lines.slice(0, hiddenStart).join("\n"),
        hiddenText: lines.slice(hiddenStart, hiddenEnd).join("\n"),
        tailText: lines.slice(hiddenEnd).join("\n"),
        hiddenCount
      };
    }

    renderToolBodyContent(bodyWrap, entry, bodyText) {
      if (!bodyWrap) {
        return;
      }

      const normalizedBodyText = this.normalizeText(bodyText || "");
      const entryId = Number.isFinite(entry?.id) ? Math.floor(entry.id) : null;
      bodyWrap.textContent = "";

      if (!normalizedBodyText) {
        bodyWrap.dataset.bodyKind = "tool";
        if (entryId !== null) {
          this.expandedToolEntryIds.delete(entryId);
        }
        return;
      }

      const segments = this.buildToolBodySegments(normalizedBodyText);
      if (!segments || entryId === null) {
        const fullBody = this.createToolPreBlock("watcher-entry-text", normalizedBodyText);
        bodyWrap.appendChild(fullBody);
        bodyWrap.dataset.bodyKind = "tool";
        if (entryId !== null) {
          this.expandedToolEntryIds.delete(entryId);
        }
        return;
      }

      bodyWrap.dataset.bodyKind = "tool-fold";

      const head = this.createToolPreBlock("watcher-entry-text watcher-tool-body-block", segments.headText);
      bodyWrap.appendChild(head);

      const hidden = this.createToolPreBlock("watcher-entry-text watcher-tool-body-block watcher-tool-body-hidden", segments.hiddenText);
      const expanded = this.expandedToolEntryIds.has(entryId);
      hidden.classList.toggle("hidden", !expanded);
      bodyWrap.appendChild(hidden);

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "watcher-tool-hidden-toggle";
      toggle.textContent = expanded
        ? `Hide ${segments.hiddenCount} hidden lines`
        : `... +${segments.hiddenCount} lines (click to expand)`;
      toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
      toggle.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();

        if (this.expandedToolEntryIds.has(entryId)) {
          this.expandedToolEntryIds.delete(entryId);
        } else {
          this.expandedToolEntryIds.add(entryId);
        }

        this.renderToolBodyContent(bodyWrap, entry, normalizedBodyText);
      });
      bodyWrap.appendChild(toggle);

      const tail = this.createToolPreBlock("watcher-entry-text watcher-tool-body-block", segments.tailText);
      bodyWrap.appendChild(tail);
    }

    hasActiveTextSelection() {
      if (typeof window === "undefined" || typeof window.getSelection !== "function") {
        return false;
      }

      return String(window.getSelection() || "").trim().length > 0;
    }

    setEntryActionsVisible(entryId, visible) {
      const node = this.entryNodeById.get(entryId);
      if (!node || node.compact || !node.card) {
        return;
      }

      node.card.classList.toggle("watcher-entry-actions-visible", visible);
      if (visible) {
        this.visibleActionEntryId = entryId;
      } else if (this.visibleActionEntryId === entryId) {
        this.visibleActionEntryId = null;
      }
    }

    hideEntryActions(exceptEntryId = null) {
      for (const [entryId, node] of this.entryNodeById.entries()) {
        if (!node || node.compact || !node.card) {
          continue;
        }

        if (exceptEntryId !== null && entryId === exceptEntryId) {
          continue;
        }

        node.card.classList.remove("watcher-entry-actions-visible");
      }

      if (exceptEntryId === null) {
        this.visibleActionEntryId = null;
      }
    }

    toggleEntryActions(entryId) {
      const node = this.entryNodeById.get(entryId);
      if (!node || node.compact || !node.card) {
        return;
      }

      const currentlyVisible = node.card.classList.contains("watcher-entry-actions-visible");
      this.hideEntryActions(currentlyVisible ? null : entryId);
      this.setEntryActionsVisible(entryId, !currentlyVisible);
    }

    getCopyTextForEntry(entry) {
      if (!entry) {
        return "";
      }

      const bodyText = this.getEntryBodyText(entry);
      if (bodyText && bodyText.trim().length > 0) {
        return bodyText;
      }

      const imageUrls = Array.isArray(entry.images)
        ? entry.images.filter((x) => typeof x === "string" && x.trim().length > 0)
        : [];
      return imageUrls.join("\n");
    }

    async copyTextToClipboard(text) {
      if (!text) {
        return false;
      }

      if (typeof navigator !== "undefined"
        && navigator.clipboard
        && typeof navigator.clipboard.writeText === "function") {
        try {
          await navigator.clipboard.writeText(text);
          return true;
        } catch (error) {
          // Fall through to a legacy path when clipboard permissions are unavailable.
        }
      }

      if (typeof document === "undefined" || typeof document.execCommand !== "function") {
        return false;
      }

      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.setAttribute("readonly", "readonly");
      textArea.style.position = "fixed";
      textArea.style.top = "-9999px";
      textArea.style.left = "-9999px";
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();

      let copied = false;
      try {
        copied = document.execCommand("copy");
      } catch (error) {
        copied = false;
      }

      textArea.remove();
      return copied;
    }

    createEntryActionButton(entryId) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "watcher-entry-copy-btn";
      button.setAttribute("aria-label", "Copy message");
      button.title = "Copy message";

      const icon = document.createElement("i");
      icon.className = "bi bi-copy watcher-entry-copy-icon";
      icon.setAttribute("aria-hidden", "true");
      button.appendChild(icon);

      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();

        const node = this.entryNodeById.get(entryId);
        const textToCopy = this.getCopyTextForEntry(node?.entry || null);
        if (!textToCopy) {
          return;
        }

        const copied = await this.copyTextToClipboard(textToCopy);
        if (!copied) {
          return;
        }

        button.classList.add("is-copied");
        button.setAttribute("aria-label", "Copied");
        button.title = "Copied";
        setTimeout(() => {
          if (!button.isConnected) {
            return;
          }

          button.classList.remove("is-copied");
          button.setAttribute("aria-label", "Copy message");
          button.title = "Copy message";
        }, 1200);
      });

      return button;
    }

    createEntryActions(card, entry) {
      const actions = document.createElement("div");
      actions.className = "watcher-entry-actions";
      const copyActionButton = this.createEntryActionButton(entry.id);
      actions.appendChild(copyActionButton);
      card.appendChild(actions);

      card.addEventListener("click", (event) => {
        const target = event?.target;
        if (target && typeof target.closest === "function") {
          if (target.closest(".watcher-entry-copy-btn")) {
            return;
          }

          if (target.closest("summary")) {
            return;
          }
        }

        if (this.hasActiveTextSelection()) {
          return;
        }

        this.toggleEntryActions(entry.id);
      });

      return copyActionButton;
    }

    createBodyNodeForEntry(card, entry, bodyText) {
      if (!bodyText) {
        return { body: null, detailsWrap: null };
      }

      if (this.shouldUsePlanCollapsedBody(entry, bodyText)) {
        const planStateKey = this.getPlanStateKey(entry, bodyText);
        const details = document.createElement("details");
        details.className = "watcher-entry-collapsible watcher-plan-collapsible";

        const toggle = document.createElement("summary");
        const summaryWrap = document.createElement("span");
        summaryWrap.className = "watcher-plan-summary";

        const icon = document.createElement("i");
        icon.className = "bi bi-diagram-3 watcher-plan-icon";
        icon.setAttribute("aria-hidden", "true");
        summaryWrap.appendChild(icon);

        const summaryText = document.createElement("span");
        const baseText = "Plan";
        const isExpanded = planStateKey && this.expandedPlanEntryKeys.has(planStateKey);
        summaryText.textContent = isExpanded ? `${baseText} (click to collapse)` : `${baseText} (click to expand)`;
        summaryWrap.appendChild(summaryText);
        toggle.appendChild(summaryWrap);
        details.appendChild(toggle);
        details.open = !!isExpanded;

        const body = document.createElement("div");
        body.className = "watcher-plan-body";
        this.renderPlanBodyContent(body, entry, bodyText);
        details.appendChild(body);

        details.addEventListener("toggle", () => {
          const stateText = details.open ? " (click to collapse)" : " (click to expand)";
          summaryText.textContent = `${baseText}${stateText}`;
          if (!planStateKey) {
            return;
          }

          if (details.open) {
            this.expandedPlanEntryKeys.add(planStateKey);
          } else {
            this.expandedPlanEntryKeys.delete(planStateKey);
          }
        });

        card.classList.add("watcher-plan-entry");
        card.appendChild(details);
        return { body, detailsWrap: details };
      }

      if (this.isToolEntry(entry)) {
        const bodyWrap = document.createElement("div");
        bodyWrap.className = "watcher-tool-body";
        this.renderToolBodyContent(bodyWrap, entry, bodyText);
        card.appendChild(bodyWrap);
        return { body: bodyWrap, detailsWrap: null };
      }

      if (this.shouldRenderAssistantMarkdown(entry, bodyText)) {
        const body = document.createElement("div");
        body.className = "watcher-entry-text watcher-assistant-markdown";
        body.dataset.bodyKind = "assistant-markdown";
        this.renderAssistantMarkdownIntoContainer(body, bodyText);
        card.appendChild(body);
        return { body, detailsWrap: null };
      }

      if (this.shouldUseAgentsCollapsedBody(entry, bodyText)) {
        const parsed = this.parseAgentsInstructionHeader(bodyText);
        const details = document.createElement("details");
        details.className = "watcher-entry-collapsible watcher-agents-collapsible";

        const toggle = document.createElement("summary");
        const summaryWrap = document.createElement("span");
        summaryWrap.className = "watcher-agents-summary";

        const icon = document.createElement("i");
        icon.className = "bi bi-file-earmark-text watcher-agents-icon";
        icon.setAttribute("aria-hidden", "true");
        summaryWrap.appendChild(icon);

        const summaryText = document.createElement("span");
        const baseText = parsed?.targetPath
          ? `AGENTS.md instructions for ${parsed.targetPath}`
          : "AGENTS.md instructions detected";
        summaryText.textContent = `${baseText} (click to expand)`;
        summaryWrap.appendChild(summaryText);

        toggle.appendChild(summaryWrap);
        details.appendChild(toggle);

        const body = document.createElement("pre");
        body.className = "watcher-entry-text";
        body.textContent = bodyText;
        details.appendChild(body);

        details.addEventListener("toggle", () => {
          const stateText = details.open ? " (click to collapse)" : " (click to expand)";
          summaryText.textContent = `${baseText}${stateText}`;
        });

        card.appendChild(details);
        return { body, detailsWrap: details };
      }

      if (this.shouldUseEnvironmentCollapsedBody(entry, bodyText)) {
        const parsed = this.parseEnvironmentContext(bodyText);
        const details = document.createElement("details");
        details.className = "watcher-entry-collapsible watcher-env-collapsible";

        const toggle = document.createElement("summary");
        const summaryWrap = document.createElement("span");
        summaryWrap.className = "watcher-env-summary";

        const icon = document.createElement("i");
        icon.className = "bi bi-terminal watcher-env-icon";
        icon.setAttribute("aria-hidden", "true");
        summaryWrap.appendChild(icon);

        const summaryText = document.createElement("span");
        const parts = [];
        if (parsed?.cwd) {
          parts.push(`cwd: ${parsed.cwd}`);
        }
        if (parsed?.shell) {
          parts.push(`shell: ${parsed.shell}`);
        }

        const detailSuffix = parts.length > 0 ? ` (${parts.join(" | ")})` : "";
        const baseText = `Environment context${detailSuffix}`;
        summaryText.textContent = `${baseText} (click to expand)`;
        summaryWrap.appendChild(summaryText);

        toggle.appendChild(summaryWrap);
        details.appendChild(toggle);

        const body = document.createElement("pre");
        body.className = "watcher-entry-text";
        body.textContent = bodyText;
        details.appendChild(body);

        details.addEventListener("toggle", () => {
          const stateText = details.open ? " (click to collapse)" : " (click to expand)";
          summaryText.textContent = `${baseText}${stateText}`;
        });

        card.appendChild(details);
        return { body, detailsWrap: details };
      }

      if (!this.shouldUseCollapsibleBody(entry)) {
        const body = document.createElement("pre");
        body.className = "watcher-entry-text";
        body.textContent = bodyText;
        card.appendChild(body);
        return { body, detailsWrap: null };
      }

      const details = document.createElement("details");
      details.className = "watcher-entry-collapsible";

      const toggle = document.createElement("summary");
      toggle.textContent = "Show details";
      details.appendChild(toggle);

      const body = document.createElement("pre");
      body.className = "watcher-entry-text";
      body.textContent = bodyText;
      details.appendChild(body);

      details.addEventListener("toggle", () => {
        toggle.textContent = details.open ? "Hide details" : "Show details";
      });

      card.appendChild(details);
      return { body, detailsWrap: details };
    }

    queueEntryUpdate(entry) {
      if (!entry || !entry.rendered) {
        return;
      }

      this.pendingUpdatedEntries.set(entry.id, entry);
    }

    removeToolMappingsForEntryId(entryId) {
      for (const [callId, entry] of this.toolEntriesByCallId.entries()) {
        if (entry.id === entryId) {
          this.toolEntriesByCallId.delete(callId);
        }
      }
    }

    trimIfNeeded() {
      while (this.renderCount > this.maxRenderedEntries && this.container.firstElementChild) {
        const oldest = this.container.firstElementChild;
        const oldestId = Number(oldest.getAttribute("data-entry-id"));
        const oldestNode = Number.isFinite(oldestId) ? this.entryNodeById.get(oldestId) : null;
        const removedEntry = oldestNode?.entry || null;
        this.container.removeChild(oldest);
        this.renderCount -= 1;

        if (Number.isFinite(oldestId)) {
          this.entryNodeById.delete(oldestId);
          this.removeToolMappingsForEntryId(oldestId);
          this.expandedToolEntryIds.delete(oldestId);
          if (this.visibleActionEntryId === oldestId) {
            this.visibleActionEntryId = null;
          }
        }

        if (removedEntry) {
          this.dispatchTimelineEvent("timeline-entry-removed", {
            entry: this.toEntrySnapshot(removedEntry),
            reason: "trimmed"
          });
        }
      }
    }

    renderEntryImages(card, images) {
      const safeImages = Array.isArray(images) ? images.filter((x) => typeof x === "string" && x.trim().length > 0) : [];
      if (safeImages.length === 0) {
        return null;
      }

      const wrap = document.createElement("div");
      wrap.className = "watcher-entry-images";
      for (const url of safeImages) {
        const item = document.createElement("div");
        item.className = "watcher-entry-image";

        const img = document.createElement("img");
        img.src = url;
        img.alt = "attached image";
        img.loading = "lazy";
        img.tabIndex = 0;
        img.title = "Click to enlarge";
        img.addEventListener("click", () => {
          this.openImagePreview(url);
        });
        img.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            this.openImagePreview(url);
          }
        });

        item.appendChild(img);
        wrap.appendChild(item);
      }

      card.appendChild(wrap);
      return wrap;
    }

    updateEntryImages(node, images) {
      const safeImages = Array.isArray(images) ? images.filter((x) => typeof x === "string" && x.trim().length > 0) : [];
      if (safeImages.length === 0) {
        if (node.imagesWrap && node.imagesWrap.parentElement) {
          node.imagesWrap.parentElement.removeChild(node.imagesWrap);
        }
        node.imagesWrap = null;
        return;
      }

      if (!node.imagesWrap) {
        node.imagesWrap = this.renderEntryImages(node.card, safeImages);
        return;
      }

      node.imagesWrap.textContent = "";
      for (const url of safeImages) {
        const item = document.createElement("div");
        item.className = "watcher-entry-image";
        const img = document.createElement("img");
        img.src = url;
        img.alt = "attached image";
        img.loading = "lazy";
        img.tabIndex = 0;
        img.title = "Click to enlarge";
        img.addEventListener("click", () => {
          this.openImagePreview(url);
        });
        img.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            this.openImagePreview(url);
          }
        });
        item.appendChild(img);
        node.imagesWrap.appendChild(item);
      }
    }

    ensureImagePreviewOverlay() {
      if (this.imagePreviewOverlay && this.imagePreviewImage) {
        return;
      }

      const overlay = document.createElement("div");
      overlay.className = "watcher-image-preview-overlay hidden";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.setAttribute("aria-label", "Image preview");

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "watcher-image-preview-close";
      closeBtn.setAttribute("aria-label", "Close image preview");
      closeBtn.textContent = "x";
      closeBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.closeImagePreview();
      });

      const img = document.createElement("img");
      img.className = "watcher-image-preview-image";
      img.alt = "expanded image preview";
      img.addEventListener("click", (event) => {
        event.stopPropagation();
      });

      overlay.addEventListener("click", () => {
        this.closeImagePreview();
      });

      overlay.appendChild(closeBtn);
      overlay.appendChild(img);
      document.body.appendChild(overlay);

      if (!overlay.dataset.escapeBound) {
        document.addEventListener("keydown", (event) => {
          if (event.key === "Escape" && this.imagePreviewOverlay && !this.imagePreviewOverlay.classList.contains("hidden")) {
            this.closeImagePreview();
          }
        });
        overlay.dataset.escapeBound = "1";
      }

      this.imagePreviewOverlay = overlay;
      this.imagePreviewImage = img;
    }

    openImagePreview(url) {
      const targetUrl = typeof url === "string" ? url.trim() : "";
      if (!targetUrl) {
        return;
      }

      this.ensureImagePreviewOverlay();
      if (!this.imagePreviewOverlay || !this.imagePreviewImage) {
        return;
      }

      this.imagePreviewImage.src = targetUrl;
      this.imagePreviewOverlay.classList.remove("hidden");
    }

    closeImagePreview() {
      if (!this.imagePreviewOverlay || !this.imagePreviewImage) {
        return;
      }

      this.imagePreviewOverlay.classList.add("hidden");
      this.imagePreviewImage.removeAttribute("src");
    }

    appendEntryNode(entry) {
      try {
      this.updateAssistantPinEnabledFromTaskBoundary(entry);
      if (entry.compact) {
        const row = document.createElement("div");
        row.className = "watcher-inline-entry";
        if (entry.rawType === "inline_notice") {
          row.classList.add("watcher-inline-note");
        }
        if (entry.rawType === "task_started" || entry.rawType === "task_complete") {
          row.classList.add("watcher-inline-task");
        }
        if (entry.taskDepth > 0 && !entry.taskBoundary && entry.taskAnchor !== true) {
          row.classList.add("watcher-task-child");
          row.style.setProperty("--task-depth", String(entry.taskDepth));
        }
        if (entry.taskBoundary === "start") {
          row.classList.add("watcher-task-start");
        } else if (entry.taskBoundary === "end") {
          row.classList.add("watcher-task-end");
        }
        row.dataset.entryId = String(entry.id);

        let taskToggle = null;
        if (entry.taskBoundary === "start" && entry.taskId) {
          taskToggle = document.createElement("span");
          taskToggle.className = "watcher-task-toggle";
          taskToggle.setAttribute("aria-hidden", "true");
          row.classList.add("watcher-task-boundary-clickable");
          row.tabIndex = 0;
          row.setAttribute("role", "button");

          const toggle = () => {
            this.toggleTaskCollapsed(entry.taskId);
          };

          row.addEventListener("click", () => {
            const selected = typeof window !== "undefined" && window.getSelection ? String(window.getSelection() || "") : "";
            if (selected.trim().length > 0) {
              return;
            }
            toggle();
          });
          row.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              toggle();
            }
          });

          row.appendChild(taskToggle);
        }

        const title = document.createElement("span");
        title.className = "watcher-inline-title";
        title.textContent = entry.title || entry.role;

        const text = document.createElement("span");
        text.className = "watcher-inline-text";
        text.textContent = this.getEntryBodyText(entry);

        const time = document.createElement("span");
        time.className = "watcher-inline-time";
        time.textContent = this.formatTime(entry.timestamp);

        row.appendChild(title);
        row.appendChild(text);
        row.appendChild(time);
        this.placeNodeInTimeline(row, entry);

        entry.rendered = true;
        this.renderCount += 1;
        const node = { card: row, body: text, time, compact: true, taskToggle, entry };
        this.entryNodeById.set(entry.id, node);
        if (this.isPinnableAssistantEntry(entry)) {
          this.setPinnedAssistantEntryId(entry.id);
        }
        this.updateTaskToggleState(node, entry);
        this.applyEntryVisibility(node, entry);
        this.trimIfNeeded();
        this.dispatchTimelineEvent("timeline-entry-appended", {
          entry: this.toEntrySnapshot(entry)
        });
        return;
      }

      const bodyText = this.getEntryBodyText(entry);
      if (this.shouldUseEmbeddedInstructionPresentation(entry, bodyText)) {
        const wrap = document.createElement("div");
        wrap.className = "watcher-embedded-entry";
        wrap.dataset.entryId = String(entry.id);

        const bodyNode = this.createBodyNodeForEntry(wrap, entry, bodyText);
        const body = bodyNode.body;
        const imagesWrap = this.renderEntryImages(wrap, entry.images || []);
        let copyActionButton = null;
        try {
          copyActionButton = this.createEntryActions(wrap, entry);
        } catch (error) {
          copyActionButton = null;
        }

        this.placeNodeInTimeline(wrap, entry);
        entry.rendered = true;
        this.renderCount += 1;
        const node = {
          card: wrap,
          body,
          time: null,
          compact: false,
          imagesWrap,
          detailsWrap: bodyNode.detailsWrap,
          copyActionButton,
          entry
        };
        this.entryNodeById.set(entry.id, node);
        if (this.isPinnableAssistantEntry(entry)) {
          this.setPinnedAssistantEntryId(entry.id);
        }
        this.updateTaskToggleState(node, entry);
        this.applyEntryVisibility(node, entry);
        this.trimIfNeeded();
        this.dispatchTimelineEvent("timeline-entry-appended", {
          entry: this.toEntrySnapshot(entry)
        });
        return;
      }

      const card = document.createElement("article");
      card.className = `watcher-entry ${entry.role}`;
      if (entry.taskDepth > 0 && !entry.taskBoundary && entry.taskAnchor !== true) {
        card.classList.add("watcher-task-child");
        card.style.setProperty("--task-depth", String(entry.taskDepth));
      }
      if (entry.taskBoundary === "start") {
        card.classList.add("watcher-task-start");
      } else if (entry.taskBoundary === "end") {
        card.classList.add("watcher-task-end");
      }
      card.dataset.entryId = String(entry.id);

      const header = document.createElement("div");
      header.className = "watcher-entry-header";

      const title = document.createElement("div");
      title.className = "watcher-entry-title";
      title.textContent = entry.title || entry.role;

      const time = document.createElement("div");
      time.className = "watcher-entry-time";
      time.textContent = this.formatTime(entry.timestamp);

      header.appendChild(title);
      header.appendChild(time);
      card.appendChild(header);

      const bodyNode = this.createBodyNodeForEntry(card, entry, bodyText);
      const body = bodyNode.body;

      const imagesWrap = this.renderEntryImages(card, entry.images || []);
      let copyActionButton = null;
      try {
        copyActionButton = this.createEntryActions(card, entry);
      } catch (error) {
        copyActionButton = null;
      }

      this.placeNodeInTimeline(card, entry);
      entry.rendered = true;
      this.renderCount += 1;
      const node = {
        card,
        body,
        time,
        compact: false,
        imagesWrap,
        detailsWrap: bodyNode.detailsWrap,
        copyActionButton,
        entry
      };
      this.entryNodeById.set(entry.id, node);
      if (this.isPinnableAssistantEntry(entry)) {
        this.setPinnedAssistantEntryId(entry.id);
      }
      this.updateTaskToggleState(node, entry);
      this.applyEntryVisibility(node, entry);
      this.trimIfNeeded();
      this.dispatchTimelineEvent("timeline-entry-appended", {
        entry: this.toEntrySnapshot(entry)
      });
      } catch (error) {
        if (typeof console !== "undefined" && typeof console.error === "function") {
          console.error("timeline appendEntryNode failed", error, entry);
        }

        const fallback = document.createElement("div");
        fallback.className = "watcher-inline-entry watcher-inline-note";
        fallback.dataset.entryId = String(entry?.id || "");
        fallback.textContent = `[render warning] ${entry?.title || entry?.role || "entry"} could not be displayed`;
        this.container.appendChild(fallback);

        if (entry && typeof entry === "object") {
          entry.rendered = true;
          this.renderCount += 1;
          const node = { card: fallback, body: fallback, time: null, compact: true, taskToggle: null, entry };
          this.entryNodeById.set(entry.id, node);
          this.updateTaskToggleState(node, entry);
          this.applyEntryVisibility(node, entry);
          this.dispatchTimelineEvent("timeline-entry-appended", {
            entry: this.toEntrySnapshot(entry)
          });
        } else {
          this.renderCount += 1;
        }

        this.trimIfNeeded();
      }
    }

    updateEntryNode(entry) {
      const node = this.entryNodeById.get(entry.id);
      if (!node) {
        return;
      }
      node.entry = entry;

      if (node.compact) {
        node.body.textContent = this.getEntryBodyText(entry);
        node.time.textContent = this.formatTime(entry.timestamp);
        this.updateTaskToggleState(node, entry);
        this.applyEntryVisibility(node, entry);
        this.dispatchTimelineEvent("timeline-entry-updated", {
          entry: this.toEntrySnapshot(entry)
        });
        return;
      }

      const bodyText = this.getEntryBodyText(entry);
      const shouldCollapse = this.shouldUseCollapsibleBody(entry);
      const shouldUsePlan = this.shouldUsePlanCollapsedBody(entry, bodyText);
      const hasPlanBody = node.body?.dataset?.bodyKind === "plan";
      const shouldUseAssistantMarkdown = this.shouldRenderAssistantMarkdown(entry, bodyText);
      const hasAssistantMarkdownBody = node.body?.dataset?.bodyKind === "assistant-markdown";

      if (!node.body && bodyText) {
        const bodyNode = this.createBodyNodeForEntry(node.card, entry, bodyText);
        node.body = bodyNode.body;
        node.detailsWrap = bodyNode.detailsWrap;
      } else if (node.body) {
        if (shouldUsePlan && !hasPlanBody) {
          const bodyNode = this.createBodyNodeForEntry(node.card, entry, bodyText);
          if (bodyNode.body) {
            const parent = node.body.parentElement;
            if (parent && parent.classList && parent.classList.contains("watcher-entry-collapsible")) {
              parent.remove();
            } else if (parent === node.card) {
              node.card.removeChild(node.body);
            }
            node.card.classList.add("watcher-plan-entry");
            node.body = bodyNode.body;
            node.detailsWrap = bodyNode.detailsWrap;
          }
        } else if (shouldUseAssistantMarkdown && !hasAssistantMarkdownBody) {
          const bodyNode = this.createBodyNodeForEntry(node.card, entry, bodyText);
          if (bodyNode.body) {
            const parent = node.body.parentElement;
            if (parent && parent.classList && parent.classList.contains("watcher-entry-collapsible")) {
              parent.remove();
            } else if (parent === node.card) {
              node.card.removeChild(node.body);
            }
            node.body = bodyNode.body;
            node.detailsWrap = bodyNode.detailsWrap;
          }
        } else if (hasPlanBody) {
          if (!shouldUsePlan) {
            const bodyNode = this.createBodyNodeForEntry(node.card, entry, bodyText);
            if (bodyNode.body) {
              const parent = node.body.parentElement;
              if (parent && parent.classList && parent.classList.contains("watcher-entry-collapsible")) {
                parent.remove();
              } else if (parent === node.card) {
                node.card.removeChild(node.body);
              }
              node.card.classList.remove("watcher-plan-entry");
              node.body = bodyNode.body;
              node.detailsWrap = bodyNode.detailsWrap;
            }
          } else {
            this.renderPlanBodyContent(node.body, entry, bodyText);
          }
        } else if (node.body.dataset?.bodyKind === "tool" || node.body.dataset?.bodyKind === "tool-fold") {
          this.renderToolBodyContent(node.body, entry, bodyText);
        } else if (node.body.dataset?.bodyKind === "assistant-markdown") {
          if (this.shouldRenderAssistantMarkdown(entry, bodyText)) {
            this.renderAssistantMarkdownIntoContainer(node.body, bodyText);
          } else {
            const bodyNode = this.createBodyNodeForEntry(node.card, entry, bodyText);
            if (bodyNode.body) {
              if (node.body.parentElement === node.card) {
                node.card.removeChild(node.body);
              }
              node.body = bodyNode.body;
              node.detailsWrap = bodyNode.detailsWrap;
            }
          }
        } else if (shouldCollapse && !node.detailsWrap) {
          const bodyNode = this.createBodyNodeForEntry(node.card, entry, bodyText);
          if (bodyNode.body) {
            const parent = node.body.parentElement;
            if (parent && parent.classList && parent.classList.contains("watcher-entry-collapsible")) {
              parent.remove();
            } else if (parent === node.card) {
              node.card.removeChild(node.body);
            }
            node.body = bodyNode.body;
            node.detailsWrap = bodyNode.detailsWrap;
          }
        } else {
          node.body.textContent = bodyText;
        }
      }

      this.updateEntryImages(node, entry.images || []);
      if (node.time) {
        node.time.textContent = this.formatTime(entry.timestamp);
      }
      this.updateTaskToggleState(node, entry);
      this.applyEntryVisibility(node, entry);
      if (this.isPinnableAssistantEntry(entry)) {
        this.setPinnedAssistantEntryId(entry.id);
      } else if (this.pinnedAssistantEntryId === entry.id) {
        this.setPinnedAssistantEntryId(null);
      }
      this.dispatchTimelineEvent("timeline-entry-updated", {
        entry: this.toEntrySnapshot(entry)
      });
    }

    hasEntry(entryId) {
      const normalizedEntryId = this.parseEntryId(entryId);
      if (normalizedEntryId === null) {
        return false;
      }

      return this.entryNodeById.has(normalizedEntryId);
    }

    getRenderedEntry(entryId) {
      const normalizedEntryId = this.parseEntryId(entryId);
      if (normalizedEntryId === null) {
        return null;
      }

      const node = this.entryNodeById.get(normalizedEntryId);
      if (!node || !node.entry) {
        return null;
      }

      return this.toEntrySnapshot(node.entry);
    }

    scrollToEntry(entryId, options = {}) {
      const normalizedEntryId = this.parseEntryId(entryId);
      if (normalizedEntryId === null) {
        return false;
      }

      const node = this.entryNodeById.get(normalizedEntryId);
      if (!node || !node.card) {
        return false;
      }

      const behavior = options.behavior === "smooth" ? "smooth" : "auto";
      const block = typeof options.block === "string" && options.block ? options.block : "center";
      if (typeof node.card.scrollIntoView === "function") {
        node.card.scrollIntoView({ behavior, block, inline: "nearest" });
      }

      if (options.highlight !== false) {
        const durationMs = Number.isFinite(options.highlightDurationMs)
          ? Math.max(250, Math.floor(options.highlightDurationMs))
          : 1800;
        if (typeof node.card.__jumpHighlightTimer !== "undefined" && node.card.__jumpHighlightTimer) {
          clearTimeout(node.card.__jumpHighlightTimer);
        }
        node.card.classList.add("watcher-entry-jump-highlight");
        node.card.__jumpHighlightTimer = setTimeout(() => {
          node.card.classList.remove("watcher-entry-jump-highlight");
          node.card.__jumpHighlightTimer = null;
        }, durationMs);
      }

      this.autoScrollPinned = false;
      return true;
    }
  }

  global.CodexSessionTimeline = CodexSessionTimeline;
})(window);
