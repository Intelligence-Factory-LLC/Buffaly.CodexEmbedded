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
      if (!ok) {
        console.warn("[vs-bridge] unexpected ping response:", pong);
      }
    } catch (e) {
      bridge.available = false;
      bridge.connected = false;
      renderStatus(false, "Visual Studio: Disconnected");
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
    checkConnection();
    setInterval(checkConnection, 5000);
    console.log("[vs-bridge] installed", bridge);
  });
})();
