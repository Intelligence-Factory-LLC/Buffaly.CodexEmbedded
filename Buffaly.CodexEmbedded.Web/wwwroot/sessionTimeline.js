(function initCodexSessionTimeline(global) {
  const DEFAULT_MAX_RENDERED_ENTRIES = 1500;
  const DEFAULT_MAX_TEXT_CHARS = 5000;
  const ANSI_ESCAPE_REGEX = /\u001b\[[0-9;]*[A-Za-z]/g;

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
      this.latestContextUsage = null; // { usedTokens, contextWindow, percentLeft }
      this.latestTurnModel = "";
      this.taskModelById = new Map(); // taskId -> model
      this.currentSessionModel = "";
      this.visibleActionEntryId = null;
      this.liveAssistantEntriesByStreamKey = new Map(); // streamKey -> entry

      this.container.addEventListener("scroll", () => {
        this.autoScrollPinned = this.isNearBottom();
      });
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

    truncateText(text, maxLength = this.maxTextChars) {
      const normalized = this.normalizeText(text);
      if (normalized.length <= maxLength) {
        return normalized;
      }

      return `${normalized.slice(0, maxLength)}\n... (truncated)`;
    }

    readNonNegativeNumber(value) {
      const next = Number(value);
      return Number.isFinite(next) && next >= 0 ? next : null;
    }

    readTokenCountInfo(payload) {
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

      const readInputSideTokens = (usage) => {
        if (!usage || typeof usage !== "object") {
          return null;
        }

        const input = this.readNonNegativeNumber(usage.input_tokens ?? usage.inputTokens);
        const cachedInput = this.readNonNegativeNumber(usage.cached_input_tokens ?? usage.cachedInputTokens);
        if (input !== null) {
          return input;
        }

        if (cachedInput === null) {
          return null;
        }

        return cachedInput;
      };

      const readTotalTokens = (usage) => {
        if (!usage || typeof usage !== "object") {
          return null;
        }

        return this.readNonNegativeNumber(usage.total_tokens ?? usage.totalTokens);
      };

      const lastInputSide = readInputSideTokens(lastUsage);
      const lastTotal = readTotalTokens(lastUsage);
      const totalInputSide = readInputSideTokens(totalUsage);
      const cumulativeTotal = readTotalTokens(totalUsage);
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

      if (!Number.isFinite(contextWindow) || contextWindow <= 0 || !Number.isFinite(usedTokens) || usedTokens < 0) {
        return null;
      }

      const boundedUsedTokens = Math.min(usedTokens, contextWindow);
      const ratio = Math.min(1, Math.max(0, boundedUsedTokens / contextWindow));
      const percentLeft = Math.max(0, Math.min(100, Math.round((1 - ratio) * 100)));
      return {
        contextWindow,
        usedTokens: boundedUsedTokens,
        percentLeft
      };
    }

    updateLatestContextUsageFromPayload(payload) {
      const parsed = this.readTokenCountInfo(payload);
      if (parsed) {
        this.latestContextUsage = parsed;
        return;
      }

      const modelContextWindow = Number(payload?.model_context_window ?? payload?.modelContextWindow ?? null);
      if (!Number.isFinite(modelContextWindow) || modelContextWindow <= 0) {
        return;
      }

      const priorUsedTokens = Number.isFinite(this.latestContextUsage?.usedTokens) ? this.latestContextUsage.usedTokens : null;
      if (priorUsedTokens !== null) {
        const ratio = Math.min(1, Math.max(0, priorUsedTokens / modelContextWindow));
        const percentLeft = Math.max(0, Math.min(100, Math.round((1 - ratio) * 100)));
        this.latestContextUsage = { contextWindow: modelContextWindow, usedTokens: priorUsedTokens, percentLeft };
      } else {
        this.latestContextUsage = { contextWindow: modelContextWindow, usedTokens: null, percentLeft: null };
      }
    }

    formatLatestContextLeftLabel() {
      const percent = this.latestContextUsage?.percentLeft;
      if (!Number.isFinite(percent)) {
        return "";
      }

      return `${percent}% context left`;
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

    extractModelFromText(text) {
      const normalized = typeof text === "string" ? text.trim() : "";
      if (!normalized) {
        return "";
      }

      for (const segment of normalized.split("|")) {
        const match = segment.match(/model\s*=\s*(.+)$/i);
        if (match && typeof match[1] === "string") {
          const extracted = this.normalizeModelName(match[1]);
          if (extracted) {
            return extracted;
          }
        }
      }

      const fallbackMatch = normalized.match(/\bmodel\s*=\s*([^\s|]+)/i);
      if (fallbackMatch && typeof fallbackMatch[1] === "string") {
        return this.normalizeModelName(fallbackMatch[1]);
      }

      return "";
    }

    extractModelFromContextPayload(payload) {
      if (!payload || typeof payload !== "object") {
        return "";
      }

      const directKeys = ["model", "modelName", "model_name", "selectedModel", "selected_model"];
      for (const key of directKeys) {
        if (typeof payload[key] === "string" && payload[key].trim()) {
          return this.normalizeModelName(payload[key]);
        }
      }

      const nested = payload.info;
      if (nested && typeof nested === "object") {
        for (const key of directKeys) {
          if (typeof nested[key] === "string" && nested[key].trim()) {
            return this.normalizeModelName(nested[key]);
          }
        }
      }

      const textKeys = ["summary", "message", "text", "context", "value", "line"];
      for (const key of textKeys) {
        if (typeof payload[key] === "string") {
          const parsed = this.extractModelFromText(payload[key]);
          if (parsed) {
            return parsed;
          }
        }
      }

      return "";
    }

    updateLatestTurnModelFromPayload(payload) {
      const model = this.extractModelFromContextPayload(payload);
      if (model) {
        this.latestTurnModel = model;
      }
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

    clear() {
      this.pendingEntries = [];
      this.pendingUpdatedEntries.clear();
      this.renderCount = 0;
      this.container.textContent = "";
      this.entryNodeById.clear();
      this.toolEntriesByCallId.clear();
      this.pendingOptimisticUserKeys = [];
      this.nextTaskGroupId = 1;
      this.activeTaskStack = [];
      this.collapsedTaskIds.clear();
      this.latestContextUsage = null;
      this.latestTurnModel = "";
      this.taskModelById.clear();
      this.currentSessionModel = "";
      this.autoScrollPinned = true;
      this.visibleActionEntryId = null;
      this.liveAssistantEntriesByStreamKey.clear();
      this.dispatchTimelineEvent("timeline-cleared");
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

    applyTaskVisibility(node, entry) {
      if (!node || !node.card) {
        return;
      }

      node.card.classList.toggle("watcher-task-collapsed-hidden", this.isEntryHiddenForCollapsedTask(entry));
    }

    updateTaskToggleState(node, entry) {
      if (!node || !node.taskToggle || !entry || !entry.taskId || (entry.taskBoundary !== "start" && entry.taskBoundary !== "end")) {
        return;
      }

      const collapsed = this.collapsedTaskIds.has(entry.taskId);
      node.taskToggle.textContent = collapsed ? "[+]" : "[-]";
      node.card.classList.toggle("watcher-task-collapsed", collapsed);
      node.card.setAttribute("aria-expanded", collapsed ? "false" : "true");
      node.card.setAttribute("aria-label", collapsed ? "Expand task block" : "Collapse task block");
    }

    refreshTaskVisualState() {
      for (const node of this.entryNodeById.values()) {
        if (!node || !node.entry) {
          continue;
        }

        this.applyTaskVisibility(node, node.entry);
        this.updateTaskToggleState(node, node.entry);
      }
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

      this.refreshTaskVisualState();
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

    enqueueParsedLines(lines) {
      for (const line of lines || []) {
        const entry = this.parseLine(line);
        if (entry) {
          this.pendingEntries.push(entry);
        }
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
        return { text: this.normalizeText(contentItems), imageUrls };
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
        text: this.normalizeText(chunks.join("\n")),
        imageUrls
      };
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

      return entry.text || "";
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

    parseResponseItem(timestamp, payload) {
      if (!payload || typeof payload !== "object") {
        return null;
      }

      if (payload.type === "message") {
        const role = payload.role || "system";
        const parts = this.extractMessageParts(payload.content);
        const text = parts.text;
        const images = parts.imageUrls;
        if (!text && images.length === 0) {
          return null;
        }

        if (role === "assistant") {
          const phase = payload.phase ? ` (${payload.phase})` : "";
          return this.createEntry("assistant", `Assistant${phase}`, text, timestamp, payload.type, images);
        }

        if (role === "user") {
          const key = this.createUserMessageKey(text, images);
          if (this.consumeOptimisticUserKey(key)) {
            return null;
          }

          return this.createEntry("user", "User", text, timestamp, payload.type, images);
        }

        return null;
      }

      if (payload.type === "function_call" || payload.type === "custom_tool_call") {
        const name = payload.name || "tool";
        const rawArgs = typeof payload.arguments === "string"
          ? payload.arguments
          : typeof payload.input === "string"
            ? payload.input
            : "";
        const argsObject = this.tryParseJson(rawArgs);

        const command = this.extractToolCommand(name, argsObject, rawArgs);
        const details = this.extractToolDetails(argsObject);
        const entry = this.createToolEntry(`Tool Call: ${name}`, timestamp, payload.type, name, payload.call_id || null, command, details, "");

        if (entry.callId) {
          this.toolEntriesByCallId.set(entry.callId, entry);
        }
        return entry;
      }

      if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
        const callId = payload.call_id || null;
        const rawOutput = payload.output ?? payload.result ?? payload.content ?? null;
        const output = this.formatToolOutput(null, rawOutput);

        if (callId && this.toolEntriesByCallId.has(callId)) {
          const entry = this.toolEntriesByCallId.get(callId);
          if (entry) {
            entry.output = this.formatToolOutput(entry.toolName, rawOutput) || entry.output;
            entry.timestamp = timestamp || entry.timestamp;
            this.queueEntryUpdate(entry);
          }
          return null;
        }

        return this.createToolEntry("Tool Output", timestamp, payload.type, null, callId, "", [], output);
      }

      if (payload.type === "reasoning") {
        let summary = "";
        if (Array.isArray(payload.summary)) {
          const lines = [];
          for (const item of payload.summary) {
            if (item && typeof item.text === "string" && item.text.trim().length > 0) {
              lines.push(item.text.trim());
            }
          }
          summary = lines.join("\n");
        }

        if (!summary && typeof payload.content === "string") {
          summary = payload.content;
        }

        if (!summary) {
          return null;
        }

        return this.createEntry("reasoning", "Reasoning Summary", this.truncateText(summary, 1200), timestamp, payload.type);
      }

      return null;
    }

    parseEventMsg(timestamp, payload) {
      if (!payload || typeof payload !== "object") {
        return null;
      }

      const eventType = payload.type || "";
      if (eventType === "token_count") {
        this.updateLatestContextUsageFromPayload(payload);
        return null;
      }

      if (eventType === "thread_compacted" || eventType === "thread/compacted") {
        this.updateLatestContextUsageFromPayload(payload);
        const reclaimedRaw = Number(
          payload.reclaimedTokens
          ?? payload.reclaimed_tokens
          ?? payload.tokensReclaimed
          ?? payload.tokens_reclaimed
          ?? NaN
        );
        const reclaimed = Number.isFinite(reclaimedRaw) && reclaimedRaw >= 0
          ? Math.round(reclaimedRaw)
          : null;
        const contextLeftLabel = this.formatLatestContextLeftLabel();
        const parts = [];
        if (typeof payload.summary === "string" && payload.summary.trim()) {
          parts.push(payload.summary.trim());
        } else {
          parts.push("Context compressed");
        }
        if (reclaimed !== null && reclaimed > 0) {
          parts.push(`${reclaimed.toLocaleString()} tokens reclaimed`);
        }
        if (contextLeftLabel) {
          parts.push(contextLeftLabel);
        }
        const entry = this.createEntry("system", "Context Compression", this.truncateText(parts.join(" | "), 240), timestamp, eventType);
        entry.compact = true;
        return entry;
      }

      if (eventType === "agent_message" || eventType === "user_message" || eventType === "agent_reasoning") {
        return null;
      }

      if (eventType === "task_started") {
        this.updateLatestContextUsageFromPayload(payload);
        const summary = payload.title || payload.message || "Task started";
        const entry = this.createEntry("system", "Task Started", this.truncateText(summary, 240), timestamp, eventType);
        entry.compact = true;
        const started = this.markTaskStart(entry);
        if (started?.taskId) {
          const modelForTask = this.latestTurnModel || this.currentSessionModel || "";
          if (modelForTask) {
            this.taskModelById.set(started.taskId, modelForTask);
          }
        }
        return started;
      }

      if (eventType === "task_complete") {
        const summary = payload.message || "Task complete";
        const contextLeftLabel = this.formatLatestContextLeftLabel();
        const taskId = this.activeTaskStack.length > 0 ? this.activeTaskStack[this.activeTaskStack.length - 1] : null;
        const payloadModel = this.extractModelFromContextPayload(payload);
        if (payloadModel) {
          this.latestTurnModel = payloadModel;
          if (taskId) {
            this.taskModelById.set(taskId, payloadModel);
          }
        }

        const taskModel = taskId
          ? (this.taskModelById.get(taskId) || this.latestTurnModel || this.currentSessionModel || "")
          : (this.latestTurnModel || this.currentSessionModel || "");
        const parts = [summary];
        if (contextLeftLabel) {
          parts.push(contextLeftLabel);
        }
        if (taskModel) {
          parts.push(`Model: ${taskModel}`);
        }

        const displayText = parts.join(" | ");
        const entry = this.createEntry("system", "Task Complete", this.truncateText(displayText, 240), timestamp, eventType);
        entry.compact = true;
        const completed = this.markTaskEnd(entry);
        if (completed?.taskId) {
          this.taskModelById.delete(completed.taskId);
        }
        return completed;
      }

      const message = payload.message || payload.summary || "";
      if (!message) {
        return null;
      }

      return this.createEntry("system", `Event: ${eventType || "unknown"}`, this.truncateText(String(message), 1200), timestamp, eventType);
    }

    parseLine(line) {
      let root;
      try {
        root = JSON.parse(line);
      } catch {
        return this.annotateEntryWithTaskContext(
          this.createEntry("system", "Invalid JSONL Line", this.truncateText(line, 800), null, "invalid_json")
        );
      }

      const timestamp = root.timestamp || null;
      const type = root.type || "";

      if (type === "session_meta") {
        const payload = root.payload || {};
        this.updateLatestTurnModelFromPayload(payload);
        const details = [];
        if (payload.id) details.push(`thread=${payload.id}`);
        if (payload.model_provider) details.push(`provider=${payload.model_provider}`);
        if (payload.cwd) details.push(`cwd=${payload.cwd}`);
        return this.annotateEntryWithTaskContext(
          this.createEntry("system", "Session Meta", details.join(" | "), timestamp, type)
        );
      }

      if (type === "turn_context") {
        this.updateLatestTurnModelFromPayload(root.payload || {});
        return null;
      }

      if (type === "response_item") {
        return this.annotateEntryWithTaskContext(this.parseResponseItem(timestamp, root.payload || {}));
      }

      if (type === "event_msg") {
        return this.annotateEntryWithTaskContext(this.parseEventMsg(timestamp, root.payload || {}));
      }

      return null;
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
        item.appendChild(img);
        node.imagesWrap.appendChild(item);
      }
    }

    appendEntryNode(entry) {
      try {
      if (entry.compact) {
        const row = document.createElement("div");
        row.className = "watcher-inline-entry";
        if (entry.rawType === "inline_notice") {
          row.classList.add("watcher-inline-note");
        }
        if (entry.rawType === "task_started" || entry.rawType === "task_complete") {
          row.classList.add("watcher-inline-task");
        }
        if (entry.taskDepth > 0 && !entry.taskBoundary) {
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
        if ((entry.taskBoundary === "start" || entry.taskBoundary === "end") && entry.taskId) {
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
        this.container.appendChild(row);

        entry.rendered = true;
        this.renderCount += 1;
        const node = { card: row, body: text, time, compact: true, taskToggle, entry };
        this.entryNodeById.set(entry.id, node);
        this.updateTaskToggleState(node, entry);
        this.applyTaskVisibility(node, entry);
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

        this.container.appendChild(wrap);
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
        this.applyTaskVisibility(node, entry);
        this.trimIfNeeded();
        this.dispatchTimelineEvent("timeline-entry-appended", {
          entry: this.toEntrySnapshot(entry)
        });
        return;
      }

      const card = document.createElement("article");
      card.className = `watcher-entry ${entry.role}`;
      if (entry.taskDepth > 0 && !entry.taskBoundary) {
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

      this.container.appendChild(card);
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
      this.applyTaskVisibility(node, entry);
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
          this.applyTaskVisibility(node, entry);
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
        this.applyTaskVisibility(node, entry);
        this.dispatchTimelineEvent("timeline-entry-updated", {
          entry: this.toEntrySnapshot(entry)
        });
        return;
      }

      const bodyText = this.getEntryBodyText(entry);
      const shouldCollapse = this.shouldUseCollapsibleBody(entry);

      if (!node.body && bodyText) {
        const bodyNode = this.createBodyNodeForEntry(node.card, entry, bodyText);
        node.body = bodyNode.body;
        node.detailsWrap = bodyNode.detailsWrap;
      } else if (node.body) {
        if (shouldCollapse && !node.detailsWrap) {
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
        }
        node.body.textContent = bodyText;
      }

      this.updateEntryImages(node, entry.images || []);
      if (node.time) {
        node.time.textContent = this.formatTime(entry.timestamp);
      }
      this.applyTaskVisibility(node, entry);
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
