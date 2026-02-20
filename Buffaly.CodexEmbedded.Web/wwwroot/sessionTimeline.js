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

      this.entryNodeById = new Map(); // entryId -> { card, body, time, compact }
      this.toolEntriesByCallId = new Map(); // callId -> entry
      this.pendingOptimisticUserKeys = [];
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
    }

    enqueueSystem(text, title = this.systemTitle) {
      this.pendingEntries.push(this.createEntry("system", title, String(text || ""), new Date().toISOString(), "system"));
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

      if (this.pendingEntries.length > 0) {
        for (const entry of this.pendingEntries) {
          this.appendEntryNode(entry);
        }
        this.pendingEntries = [];
      }

      if (this.pendingUpdatedEntries.size > 0) {
        for (const entry of this.pendingUpdatedEntries.values()) {
          this.updateEntryNode(entry);
        }
        this.pendingUpdatedEntries.clear();
      }

      this.container.scrollTop = this.container.scrollHeight;
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

    extractMessageParts(contentItems) {
      const chunks = [];
      const imageUrls = [];
      if (!Array.isArray(contentItems)) {
        return { text: "", imageUrls };
      }

      for (const item of contentItems) {
        if (!item || typeof item !== "object") {
          continue;
        }

        if (typeof item.text === "string" && item.text.trim().length > 0) {
          chunks.push(item.text);
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

        if (type) {
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
      if (eventType === "token_count" || eventType === "agent_message" || eventType === "user_message" || eventType === "agent_reasoning") {
        return null;
      }

      if (eventType === "task_started") {
        return this.createEntry("system", "Task Started", payload.title || payload.message || "", timestamp, eventType);
      }

      if (eventType === "task_complete") {
        return this.createEntry("system", "Task Complete", payload.message || "", timestamp, eventType);
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
        return this.createEntry("system", "Invalid JSONL Line", this.truncateText(line, 800), null, "invalid_json");
      }

      const timestamp = root.timestamp || null;
      const type = root.type || "";

      if (type === "session_meta") {
        const payload = root.payload || {};
        const details = [];
        if (payload.id) details.push(`thread=${payload.id}`);
        if (payload.model_provider) details.push(`provider=${payload.model_provider}`);
        if (payload.cwd) details.push(`cwd=${payload.cwd}`);
        return this.createEntry("system", "Session Meta", details.join(" | "), timestamp, type);
      }

      if (type === "turn_context") {
        const payload = root.payload || {};
        const details = [];
        if (payload.turn_id) details.push(`turn=${payload.turn_id}`);
        if (payload.model) details.push(`model=${payload.model}`);
        if (payload.cwd) details.push(`cwd=${payload.cwd}`);
        const entry = this.createEntry("system", "Turn Context", details.join(" | "), timestamp, type);
        entry.compact = true;
        return entry;
      }

      if (type === "response_item") {
        return this.parseResponseItem(timestamp, root.payload || {});
      }

      if (type === "event_msg") {
        return this.parseEventMsg(timestamp, root.payload || {});
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
        this.container.removeChild(oldest);
        this.renderCount -= 1;

        if (Number.isFinite(oldestId)) {
          this.entryNodeById.delete(oldestId);
          this.removeToolMappingsForEntryId(oldestId);
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
      if (entry.compact) {
        const row = document.createElement("div");
        row.className = "watcher-inline-entry";
        row.dataset.entryId = String(entry.id);

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
        this.entryNodeById.set(entry.id, { card: row, body: text, time, compact: true });
        this.trimIfNeeded();
        return;
      }

      const card = document.createElement("article");
      card.className = `watcher-entry ${entry.role}`;
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

      const bodyText = this.getEntryBodyText(entry);
      let body = null;
      if (bodyText) {
        body = document.createElement("pre");
        body.className = "watcher-entry-text";
        body.textContent = bodyText;
        card.appendChild(body);
      }

      const imagesWrap = this.renderEntryImages(card, entry.images || []);

      this.container.appendChild(card);
      entry.rendered = true;
      this.renderCount += 1;
      this.entryNodeById.set(entry.id, { card, body, time, compact: false, imagesWrap });
      this.trimIfNeeded();
    }

    updateEntryNode(entry) {
      const node = this.entryNodeById.get(entry.id);
      if (!node) {
        return;
      }

      if (node.compact) {
        node.body.textContent = this.getEntryBodyText(entry);
        node.time.textContent = this.formatTime(entry.timestamp);
        return;
      }

      const bodyText = this.getEntryBodyText(entry);
      if (!node.body && bodyText) {
        const body = document.createElement("pre");
        body.className = "watcher-entry-text";
        body.textContent = bodyText;
        node.card.appendChild(body);
        node.body = body;
      } else if (node.body) {
        node.body.textContent = bodyText;
      }

      this.updateEntryImages(node, entry.images || []);
      node.time.textContent = this.formatTime(entry.timestamp);
    }
  }

  global.CodexSessionTimeline = CodexSessionTimeline;
})(window);
