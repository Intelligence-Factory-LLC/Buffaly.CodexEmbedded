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
    "ide.v1.openDiffFromSelection"
  ];
  var DEBUG_PANEL_REV = "2026-02-28a";
  var loadedAtIso = new Date().toISOString();

  var bridge = {
    available: false,
    connected: false,
    version: 1,
    methods: METHODS.slice(0),
    rpc: rpc,
    commands: {
      getContext: function () { return rpc("ide.v1.getContext", {}); },
      openFile: function (path) { return rpc("ide.v1.openFile", { path: path }); },
      goToLine: function (line) { return rpc("ide.v1.goToLine", { line: line }); },
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
    meta.textContent = "rev " + DEBUG_PANEL_REV + " | loaded " + loadedAtIso;
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
      " | connected: " + String(bridge.connected);
  }

  function renderStatus(connected, text) {
    var el = ensureBadge();
    if (!el) return;
    if (connected) {
      el.textContent = text || "Visual Studio: Connected";
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
    checkConnection();
    setInterval(checkConnection, 5000);
    console.log("[vs-bridge] installed", bridge);
  });
})();
