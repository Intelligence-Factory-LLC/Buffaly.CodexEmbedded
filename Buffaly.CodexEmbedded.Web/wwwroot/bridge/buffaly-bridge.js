(function () {
  if (window.__vsBridgeInstalled) return;
  window.__vsBridgeInstalled = true;

  var METHODS = [
    "ide.getContext",
    "ide.v1.getContext",
    "ide.openFile",
    "ide.v1.openFile",
    "ide.goToLine",
    "ide.v1.goToLine",
    "ide.openDiff",
    "ide.v1.openDiff",
    "ide.openDiffFromSelection",
    "ide.v1.openDiffFromSelection",
    "ide.getBuildState",
    "ide.v1.getBuildState",
    "ide.buildSolution",
    "ide.v1.buildSolution",
    "ide.buildSolutionAndWait",
    "ide.v1.buildSolutionAndWait",
    "ide.getErrorList",
    "ide.v1.getErrorList",
    "ide.getWarningList",
    "ide.v1.getWarningList"
  ];
  var loadedAtIso = new Date().toISOString();
  var scriptInfo = {
    url: "",
    fingerprint: "pending"
  };

  var bridge = {
    available: false,
    connected: false,
    version: 1,
    methods: METHODS.slice(0),
    build: {
      state: "idle",
      status: "",
      errors: 0,
      scope: "",
      action: "",
      errorList: "",
      warningList: "",
      updatedAtIso: "",
      notifications: {
        beginCount: 0,
        doneCount: 0,
        errorCount: 0,
        lastType: "",
        lastMessage: "",
        lastAtIso: ""
      }
    },
    rpc: rpc,
    commands: {
      getContext: function () { return rpc("ide.v1.getContext", {}); },
      openFile: function (path) { return rpc("ide.v1.openFile", { path: path }); },
      goToLine: function (line) { return rpc("ide.v1.goToLine", { line: line }); },
      getBuildState: function () { return rpc("ide.v1.getBuildState", {}); },
      buildSolution: function () { return rpc("ide.v1.buildSolution", {}); },
      buildSolutionAndWait: function (timeoutMs) { return rpc("ide.v1.buildSolutionAndWait", { timeoutMs: timeoutMs }); },
      getErrorList: function () { return rpc("ide.v1.getErrorList", {}); },
      getWarningList: function () { return rpc("ide.v1.getWarningList", {}); },
      openDiff: function (title, path, originalText, modifiedText) {
        return rpc("ide.v1.openDiff", {
          title: title,
          path: path,
          originalText: originalText,
          modifiedText: modifiedText
        });
      },
      openDiffFromSelection: function (title, path, modifiedText) {
        return rpc("ide.v1.openDiffFromSelection", {
          title: title,
          path: path,
          modifiedText: modifiedText
        });
      }
    }
  };

  window.__vsBridge = bridge;
  window.devAgentBridge = bridge;

  var badge;
  var debugButton;
  var debugPanel;
  var debugOutput;
  var debugStatus;
  var buildEventBadge;
  var fileLinkInterceptorInstalled = false;
  var webviewMessageInstalled = false;

  function getHost() {
    try {
      return window.chrome &&
        window.chrome.webview &&
        window.chrome.webview.hostObjects &&
        window.chrome.webview.hostObjects.devAgent
        ? window.chrome.webview.hostObjects.devAgent
        : null;
    } catch (e) {
      return null;
    }
  }

  function ensureBadge() {
    if (badge) return badge;
    badge = document.createElement("div");
    badge.id = "vsBridgeStatusBadge";
    badge.style.position = "fixed";
    badge.style.right = "12px";
    badge.style.bottom = "12px";
    badge.style.zIndex = "2147483647";
    badge.style.padding = "6px 10px";
    badge.style.borderRadius = "999px";
    badge.style.border = "1px solid";
    badge.style.fontFamily = "Segoe UI, sans-serif";
    badge.style.fontSize = "12px";
    badge.style.fontWeight = "600";
    if (document.body) document.body.appendChild(badge);
    return badge;
  }

  function ensureBuildEventBadge() {
    if (buildEventBadge) return buildEventBadge;
    buildEventBadge = document.createElement("div");
    buildEventBadge.id = "vsBridgeBuildEventBadge";
    buildEventBadge.style.position = "fixed";
    buildEventBadge.style.right = "12px";
    buildEventBadge.style.bottom = "82px";
    buildEventBadge.style.zIndex = "2147483647";
    buildEventBadge.style.padding = "6px 10px";
    buildEventBadge.style.borderRadius = "8px";
    buildEventBadge.style.border = "1px solid #cbd5e1";
    buildEventBadge.style.background = "#f8fafc";
    buildEventBadge.style.color = "#0f172a";
    buildEventBadge.style.fontFamily = "Segoe UI, sans-serif";
    buildEventBadge.style.fontSize = "12px";
    buildEventBadge.style.fontWeight = "600";
    buildEventBadge.style.maxWidth = "420px";
    buildEventBadge.style.whiteSpace = "nowrap";
    buildEventBadge.style.overflow = "hidden";
    buildEventBadge.style.textOverflow = "ellipsis";
    buildEventBadge.style.display = "none";
    if (document.body) document.body.appendChild(buildEventBadge);
    return buildEventBadge;
  }

  function renderBuildEventBadge() {
    var n = bridge.build.notifications;
    var el = ensureBuildEventBadge();
    if (!el || !n) return;
    if (!n.lastType) {
      el.style.display = "none";
      return;
    }

    var label = "Build notify: " + n.lastType;
    if (n.lastMessage) {
      label += " | " + n.lastMessage;
    }
    label += " | begin " + n.beginCount + " done " + n.doneCount + " err " + n.errorCount;
    el.textContent = label;
    el.style.display = "block";

    if (n.lastType === "error" || n.lastType === "error-list") {
      el.style.background = "#fef2f2";
      el.style.color = "#991b1b";
      el.style.borderColor = "#fca5a5";
    } else if (n.lastType === "done") {
      el.style.background = "#ecfdf5";
      el.style.color = "#065f46";
      el.style.borderColor = "#6ee7b7";
    } else if (n.lastType === "begin") {
      el.style.background = "#eff6ff";
      el.style.color = "#1e40af";
      el.style.borderColor = "#93c5fd";
    } else {
      el.style.background = "#f8fafc";
      el.style.color = "#0f172a";
      el.style.borderColor = "#cbd5e1";
    }
  }

  function markBuildNotification(type, message) {
    var n = bridge.build.notifications;
    if (!n) return;
    var t = String(type || "").trim().toLowerCase();
    if (t === "begin") {
      n.beginCount += 1;
    } else if (t === "done") {
      n.doneCount += 1;
    } else if (t === "error" || t === "error-list") {
      n.errorCount += 1;
    }
    n.lastType = t || "update";
    n.lastMessage = String(message || "");
    n.lastAtIso = new Date().toISOString();
    renderBuildEventBadge();
  }

  function ensureDebugButton() {
    if (debugButton) return debugButton;
    debugButton = document.createElement("button");
    debugButton.id = "vsBridgeDebugButton";
    debugButton.type = "button";
    debugButton.textContent = "VS Bridge Debug";
    debugButton.style.position = "fixed";
    debugButton.style.right = "12px";
    debugButton.style.bottom = "48px";
    debugButton.style.zIndex = "2147483647";
    debugButton.style.padding = "6px 10px";
    debugButton.style.borderRadius = "8px";
    debugButton.style.border = "1px solid #2563eb";
    debugButton.style.background = "#dbeafe";
    debugButton.style.color = "#1e3a8a";
    debugButton.style.fontFamily = "Segoe UI, sans-serif";
    debugButton.style.fontSize = "12px";
    debugButton.style.fontWeight = "600";
    debugButton.style.cursor = "pointer";
    debugButton.addEventListener("click", toggleDebugPanel);
    if (document.body) document.body.appendChild(debugButton);
    return debugButton;
  }

  function ensureDebugPanel() {
    if (debugPanel) return debugPanel;
    debugPanel = document.createElement("div");
    debugPanel.id = "vsBridgeDebugPanel";
    debugPanel.style.position = "fixed";
    debugPanel.style.right = "12px";
    debugPanel.style.bottom = "86px";
    debugPanel.style.width = "360px";
    debugPanel.style.maxWidth = "calc(100vw - 24px)";
    debugPanel.style.maxHeight = "60vh";
    debugPanel.style.overflow = "auto";
    debugPanel.style.zIndex = "2147483647";
    debugPanel.style.padding = "10px";
    debugPanel.style.borderRadius = "10px";
    debugPanel.style.border = "1px solid #cbd5e1";
    debugPanel.style.background = "#ffffff";
    debugPanel.style.boxShadow = "0 10px 30px rgba(2, 6, 23, 0.2)";
    debugPanel.style.fontFamily = "Segoe UI, sans-serif";
    debugPanel.style.fontSize = "12px";
    debugPanel.style.color = "#0f172a";
    debugPanel.style.display = "none";

    var title = document.createElement("div");
    title.textContent = "VS Bridge Debug";
    title.style.fontSize = "13px";
    title.style.fontWeight = "700";
    debugPanel.appendChild(title);

    var meta = document.createElement("div");
    meta.id = "vsBridgeDebugMeta";
    meta.textContent = "loaded " + loadedAtIso + " | " + scriptInfo.fingerprint;
    meta.style.marginTop = "4px";
    meta.style.color = "#475569";
    debugPanel.appendChild(meta);

    debugStatus = document.createElement("div");
    debugStatus.style.marginTop = "8px";
    debugStatus.style.fontWeight = "600";
    debugPanel.appendChild(debugStatus);

    var actions = document.createElement("div");
    actions.style.display = "grid";
    actions.style.gridTemplateColumns = "1fr 1fr";
    actions.style.gap = "6px";
    actions.style.marginTop = "10px";
    debugPanel.appendChild(actions);

    addDebugAction(actions, "Ping", async function () {
      var host = getHost();
      if (!host) throw new Error("Host missing");
      var pong = await host.Ping();
      return { pong: pong };
    });

    addDebugAction(actions, "Get Context", async function () {
      return await bridge.commands.getContext();
    });

    addDebugAction(actions, "Open File", async function () {
      var context = await bridge.commands.getContext();
      await bridge.commands.openFile(context.activeDocumentPath || "");
      return { opened: context.activeDocumentPath || "" };
    });

    addDebugAction(actions, "Go To Line", async function () {
      var context = await bridge.commands.getContext();
      var line = Number(context.caretLine || 1);
      await bridge.commands.goToLine(line);
      return { line: line };
    });

    addDebugAction(actions, "Diff Selection", async function () {
      var context = await bridge.commands.getContext();
      var path = context.activeDocumentPath || "selection.txt";
      var text = (context.selectionText || "").trim();
      var modified = text ? (text + "\n// Bridge debug marker") : "// Bridge debug marker";
      await bridge.commands.openDiffFromSelection("Bridge Debug Diff", path, modified);
      return { path: path, selectionLength: text.length };
    });

    addDebugAction(actions, "Build State", async function () {
      return {
        state: await bridge.commands.getBuildState()
      };
    });

    addDebugAction(actions, "Build+Wait", async function () {
      return {
        result: await bridge.commands.buildSolutionAndWait(120000)
      };
    });

    addDebugAction(actions, "Build Errors", async function () {
      return {
        errors: await bridge.commands.getErrorList(),
        warnings: await bridge.commands.getWarningList()
      };
    });

    addDebugAction(actions, "Close Panel", async function () {
      debugPanel.style.display = "none";
      return { closed: true };
    });

    debugOutput = document.createElement("pre");
    debugOutput.style.marginTop = "10px";
    debugOutput.style.padding = "8px";
    debugOutput.style.borderRadius = "8px";
    debugOutput.style.border = "1px solid #e2e8f0";
    debugOutput.style.background = "#f8fafc";
    debugOutput.style.whiteSpace = "pre-wrap";
    debugOutput.style.wordBreak = "break-word";
    debugOutput.style.maxHeight = "220px";
    debugOutput.style.overflow = "auto";
    debugOutput.textContent = "Ready.";
    debugPanel.appendChild(debugOutput);

    if (document.body) document.body.appendChild(debugPanel);
    refreshDebugStatus();
    return debugPanel;
  }

  function addDebugAction(container, label, handler) {
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.style.padding = "6px 8px";
    button.style.borderRadius = "6px";
    button.style.border = "1px solid #cbd5e1";
    button.style.background = "#f8fafc";
    button.style.color = "#0f172a";
    button.style.fontSize = "12px";
    button.style.cursor = "pointer";
    button.addEventListener("click", async function () {
      try {
        var result = await handler();
        writeDebugOutput("OK " + label, result);
      } catch (e) {
        writeDebugOutput("ERR " + label, e && e.message ? e.message : String(e));
      }
    });
    container.appendChild(button);
  }

  function toggleDebugPanel() {
    var panel = ensureDebugPanel();
    if (!panel) return;
    panel.style.display = panel.style.display === "none" ? "block" : "none";
    refreshDebugStatus();
  }

  function writeDebugOutput(title, value) {
    if (!debugOutput) return;
    var lines = [];
    lines.push("[" + new Date().toISOString() + "] " + title);
    if (typeof value === "string") {
      lines.push(value);
    } else {
      try {
        lines.push(JSON.stringify(value, null, 2));
      } catch (e) {
        lines.push(String(value));
      }
    }
    debugOutput.textContent = lines.join("\n");
  }

  function refreshDebugStatus() {
    if (!debugStatus) return;
    debugStatus.textContent =
      "available: " + String(bridge.available) +
      " | connected: " + String(bridge.connected) +
      " | build: " + String(bridge.build.state || "idle") +
      " | events: b" + bridge.build.notifications.beginCount +
      "/d" + bridge.build.notifications.doneCount +
      "/e" + bridge.build.notifications.errorCount;
    var meta = document.getElementById("vsBridgeDebugMeta");
    if (meta) {
      var urlPart = scriptInfo.url ? (" | src " + scriptInfo.url) : "";
      meta.textContent = "loaded " + loadedAtIso + " | " + scriptInfo.fingerprint + urlPart;
    }
  }

  function tryParseLineFromUrl(url) {
    if (!url) return 0;
    var query = url.searchParams;
    var fromLine = Number(query.get("line") || query.get("ln") || 0);
    if (fromLine > 0) return fromLine;
    var hash = (url.hash || "").replace(/^#/, "");
    var lMatch = /^L(\d+)$/i.exec(hash);
    if (lMatch) return Number(lMatch[1] || 0);
    var lineMatch = /^line=(\d+)$/i.exec(hash);
    if (lineMatch) return Number(lineMatch[1] || 0);
    return 0;
  }

  function fileUrlToPath(url) {
    if (!url || url.protocol !== "file:") return "";
    var path = decodeURIComponent(url.pathname || "");
    if (/^\/[a-zA-Z]:\//.test(path)) {
      path = path.substring(1);
    }
    return path.replace(/\//g, "\\");
  }

  async function openFileUrl(href) {
    var url;
    try {
      url = new URL(href);
    } catch (e) {
      throw new Error("Invalid file URL: " + href);
    }

    if (url.protocol !== "file:") {
      throw new Error("Unsupported protocol: " + url.protocol);
    }

    var path = fileUrlToPath(url);
    if (!path) {
      throw new Error("Could not map file URL to path.");
    }

    var line = tryParseLineFromUrl(url);
    await bridge.commands.openFile(path);
    if (line > 0) {
      await bridge.commands.goToLine(line);
    }
    return { path: path, line: line };
  }

  function installFileLinkInterceptor() {
    if (fileLinkInterceptorInstalled) return;
    fileLinkInterceptorInstalled = true;

    document.addEventListener("click", function (event) {
      try {
        var target = event.target;
        if (!target || typeof target.closest !== "function") return;
        var anchor = target.closest("a[href]");
        if (!anchor) return;
        var href = anchor.getAttribute("href") || "";
        if (!/^file:\/\//i.test(href)) return;

        event.preventDefault();
        event.stopPropagation();
        openFileUrl(anchor.href).then(function (result) {
          console.log("[vs-bridge] opened file link", result);
          if (debugPanel && debugPanel.style.display !== "none") {
            writeDebugOutput("OK Open File Link", result);
          }
        }).catch(function (err) {
          console.error("[vs-bridge] failed to open file link", href, err);
          if (debugPanel && debugPanel.style.display !== "none") {
            writeDebugOutput("ERR Open File Link", err && err.message ? err.message : String(err));
          }
        });
      } catch (e) {
        console.error("[vs-bridge] file link interceptor error", e);
      }
    }, true);
  }

  function resolveScriptUrl() {
    var scripts = document.getElementsByTagName("script");
    for (var i = scripts.length - 1; i >= 0; i -= 1) {
      var src = scripts[i].src || "";
      if (src.indexOf("/bridge/buffaly-bridge.js") >= 0) {
        return src;
      }
    }
    return "";
  }

  function computeFingerprint(text) {
    var hash = 2166136261;
    for (var i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = (hash * 16777619) >>> 0;
    }
    return "fp-" + hash.toString(16).padStart(8, "0") + "-len" + text.length;
  }

  async function refreshScriptFingerprint() {
    try {
      scriptInfo.url = resolveScriptUrl();
      if (!scriptInfo.url) {
        scriptInfo.fingerprint = "embedded-or-unknown-src";
        refreshDebugStatus();
        return;
      }

      var base = scriptInfo.url.split("?")[0];
      var response = await fetch(base + "?v=" + Date.now(), { cache: "no-store" });
      if (!response.ok) {
        scriptInfo.fingerprint = "fetch-failed-" + response.status;
        refreshDebugStatus();
        return;
      }

      var text = await response.text();
      scriptInfo.fingerprint = computeFingerprint(text);
      refreshDebugStatus();
    } catch (e) {
      scriptInfo.fingerprint = "fingerprint-error";
      refreshDebugStatus();
    }
  }

  function renderStatus(connected, text) {
    var el = ensureBadge();
    if (!el) return;
    var buildState = String(bridge.build.state || "idle");
    var buildSuffix = "";
    if (connected) {
      if (buildState === "building") {
        buildSuffix = " | Build: Running";
      } else if (buildState === "failed") {
        buildSuffix = " | Build: Failed";
      } else if (buildState === "succeeded") {
        buildSuffix = " | Build: Succeeded";
      } else if (buildState === "canceled") {
        buildSuffix = " | Build: Canceled";
      }
    }
    if (connected) {
      el.textContent = (text || "Visual Studio: Connected") + buildSuffix;
      el.style.background = "#ecfdf5";
      el.style.color = "#065f46";
      el.style.borderColor = "#6ee7b7";
    } else {
      el.textContent = text || "Visual Studio: Disconnected";
      el.style.background = "#fef2f2";
      el.style.color = "#991b1b";
      el.style.borderColor = "#fca5a5";
    }
  }

  function parseContextJson(json) {
    if (!json) return {};
    try {
      return JSON.parse(json);
    } catch (e) {
      return {};
    }
  }

  function normalizeBuildState(value) {
    var raw = String(value || "").trim().toLowerCase();
    if (raw === "building" || raw === "succeeded" || raw === "failed" || raw === "canceled" || raw === "idle") {
      return raw;
    }
    return "idle";
  }

  async function refreshBuildStateFromHost() {
    try {
      var state = await bridge.commands.getBuildState();
      bridge.build.state = normalizeBuildState(state);
      bridge.build.updatedAtIso = new Date().toISOString();
      refreshDebugStatus();
    } catch (e) {
    }
  }

  async function refreshBuildDiagnostics() {
    try {
      var previousErrors = bridge.build.errorList;
      var results = await Promise.all([
        bridge.commands.getErrorList(),
        bridge.commands.getWarningList()
      ]);
      bridge.build.errorList = String(results[0] || "");
      bridge.build.warningList = String(results[1] || "");
      bridge.build.updatedAtIso = new Date().toISOString();
      if (bridge.build.errorList && bridge.build.errorList !== previousErrors) {
        markBuildNotification("error-list", "error list refreshed");
      }
      refreshDebugStatus();
    } catch (e) {
      console.error("[vs-bridge] failed to refresh build diagnostics", e);
    }
  }

  function handleWebViewMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    var type = String(msg.type || "").trim().toLowerCase();
    if (!type) return;

    if (type === "build.begin") {
      bridge.build.state = "building";
      bridge.build.status = "building";
      bridge.build.scope = String(msg.scope || "");
      bridge.build.action = String(msg.action || "");
      bridge.build.updatedAtIso = new Date().toISOString();
      markBuildNotification("begin", "build started");
      renderStatus(true, "Visual Studio: Connected");
      refreshDebugStatus();
      console.log("[vs-bridge] build.begin", msg);
      return;
    }

    if (type === "build.done") {
      bridge.build.status = String(msg.status || "");
      bridge.build.state = normalizeBuildState(msg.status || "idle");
      bridge.build.errors = Number(msg.errors || 0);
      bridge.build.scope = String(msg.scope || "");
      bridge.build.action = String(msg.action || "");
      bridge.build.updatedAtIso = new Date().toISOString();
      if (bridge.build.errors > 0 || bridge.build.state === "failed") {
        markBuildNotification("error", "build done with " + bridge.build.errors + " errors");
      } else {
        markBuildNotification("done", "build done " + bridge.build.state);
      }
      renderStatus(true, "Visual Studio: Connected");
      refreshDebugStatus();
      refreshBuildDiagnostics();
      console.log("[vs-bridge] build.done", msg);
    }
  }

  function installWebViewMessageListener() {
    if (webviewMessageInstalled) return;
    var webview = window.chrome && window.chrome.webview;
    if (!webview || typeof webview.addEventListener !== "function") return;
    webview.addEventListener("message", function (event) {
      try {
        handleWebViewMessage(event && event.data ? event.data : null);
      } catch (e) {
        console.error("[vs-bridge] message handling failed", e);
      }
    });
    webviewMessageInstalled = true;
  }

  async function rpc(method, params) {
    var host = getHost();
    if (!host) {
      throw new Error("Visual Studio bridge unavailable.");
    }

    var p = params || {};

    switch (method) {
      case "ide.getContext":
      case "ide.v1.getContext": {
        var contextJson = await host.GetContextJson();
        return parseContextJson(contextJson);
      }

      case "ide.openFile":
      case "ide.v1.openFile":
        await host.OpenFile(p.path || "");
        return {};

      case "ide.goToLine":
      case "ide.v1.goToLine":
        await host.GoToLine(Number(p.line || 0));
        return {};

      case "ide.openDiff":
      case "ide.v1.openDiff":
        await host.OpenDiff(
          p.title || "Codex Diff Preview",
          p.path || "",
          p.originalText || "",
          p.modifiedText || ""
        );
        return {};

      case "ide.openDiffFromSelection":
      case "ide.v1.openDiffFromSelection":
        await host.OpenDiffFromSelection(
          p.title || "Codex Selection Diff",
          p.path || "",
          p.modifiedText || ""
        );
        return {};

      case "ide.getBuildState":
      case "ide.v1.getBuildState":
        return String(await host.GetBuildState());

      case "ide.buildSolution":
      case "ide.v1.buildSolution":
        await host.BuildSolution();
        return {};

      case "ide.buildSolutionAndWait":
      case "ide.v1.buildSolutionAndWait": {
        var timeoutMs = Number(p.timeoutMs || 120000);
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
          timeoutMs = 120000;
        }
        return String(await host.BuildSolutionAndWait(Math.floor(timeoutMs)));
      }

      case "ide.getErrorList":
      case "ide.v1.getErrorList":
        return String(await host.GetErrorList());

      case "ide.getWarningList":
      case "ide.v1.getWarningList":
        return String(await host.GetWarningList());

      default:
        throw new Error("Unsupported method: " + method);
    }
  }

  async function checkConnection() {
    try {
      var host = getHost();
      if (!host) {
        bridge.available = false;
        bridge.connected = false;
        renderStatus(false, "Visual Studio: Host Missing");
        return;
      }

      var pong = await host.Ping();
      var ok = pong === "connected";
      bridge.available = ok;
      bridge.connected = ok;
      if (ok) {
        await refreshBuildStateFromHost();
      }
      renderStatus(ok, ok ? "Visual Studio: Connected" : "Visual Studio: Ping Failed");
      refreshDebugStatus();
      if (!ok) {
        console.warn("[vs-bridge] unexpected ping response:", pong);
      }
    } catch (e) {
      bridge.available = false;
      bridge.connected = false;
      renderStatus(false, "Visual Studio: Disconnected");
      refreshDebugStatus();
      console.error("[vs-bridge] connection check failed", e);
    }
  }

  function onReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else {
      fn();
    }
  }

  onReady(function () {
    ensureDebugButton();
    ensureBuildEventBadge();
    installWebViewMessageListener();
    installFileLinkInterceptor();
    refreshScriptFingerprint();
    checkConnection();
    refreshBuildDiagnostics();
    setInterval(checkConnection, 5000);
    setInterval(refreshScriptFingerprint, 5000);
    setInterval(refreshBuildStateFromHost, 5000);
    console.log("[vs-bridge] installed", bridge);
  });
})();
