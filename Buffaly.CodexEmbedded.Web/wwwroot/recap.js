const STORAGE_SIDEBAR_COLLAPSED_KEY = "codex.recap.sidebarCollapsed.v1";
const STORAGE_RECAP_ROOT_KEY = "codex.recap.root.v1";
const RECAP_APPROVAL_POLICY = "untrusted";
const RECAP_SANDBOX = "read-only";

const layoutRoot = document.querySelector(".layout");
const sidebarToggleBtn = document.getElementById("sidebarToggleBtn");
const mobileProjectsBtn = document.getElementById("mobileProjectsBtn");
const sidebarBackdrop = document.getElementById("sidebarBackdrop");

const recapRootInput = document.getElementById("recapRootInput");
const recapStartBtn = document.getElementById("recapStartBtn");
const recapPromptInput = document.getElementById("recapPromptInput");
const recapAskBtn = document.getElementById("recapAskBtn");
const recapOpenTimelineBtn = document.getElementById("recapOpenTimelineBtn");
const recapStatus = document.getElementById("recapStatus");
const recapOutput = document.getElementById("recapOutput");
const recapSessionValue = document.getElementById("recapSessionValue");
const recapThreadValue = document.getElementById("recapThreadValue");
const recapTimelineTitle = document.getElementById("recapTimelineTitle");
const recapTimelineStatus = document.getElementById("recapTimelineStatus");
const recapTimeline = document.getElementById("recapTimeline");

const timeline = new window.CodexSessionTimeline({
  container: recapTimeline,
  maxRenderedEntries: 1500,
  systemTitle: "Recap"
});

let socket = null;
let socketConnected = false;
let recapSessionId = "";
let recapThreadId = "";
let waitingForAnswer = false;
let lastAssistantText = "";

function setStatus(text) {
  if (recapStatus) {
    recapStatus.textContent = text;
  }
}

function setOutput(text) {
  if (recapOutput) {
    recapOutput.textContent = text || "";
  }
}

function trimText(text, maxChars) {
  const value = typeof text === "string" ? text.replace(/\r/g, "").trim() : "";
  if (!value) {
    return "";
  }

  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}...`;
}

function updateSessionMeta() {
  if (recapSessionValue) {
    recapSessionValue.textContent = recapSessionId || "(none)";
  }
  if (recapThreadValue) {
    recapThreadValue.textContent = recapThreadId || "(none)";
  }
}

function currentWsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

function sendFrame(type, payload = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    setStatus("Websocket is not connected.");
    return false;
  }

  const frame = { type, ...payload };
  socket.send(JSON.stringify(frame));
  return true;
}

function handleSocketMessage(data) {
  let envelope;
  try {
    envelope = JSON.parse(data);
  } catch {
    return;
  }

  const type = envelope?.type || "";
  const payload = envelope?.payload || {};
  if (!type) {
    return;
  }

  if (type === "session_created" || type === "session_attached") {
    recapSessionId = payload.sessionId || recapSessionId;
    recapThreadId = payload.threadId || recapThreadId;
    updateSessionMeta();
    setStatus(`Recap session ready (${recapSessionId}).`);
    return;
  }

  if (type === "assistant_response_started") {
    if (!payload.sessionId || payload.sessionId === recapSessionId) {
      waitingForAnswer = true;
      setStatus("Running recap query...");
    }
    return;
  }

  if (type === "assistant_done") {
    if (!payload.sessionId || payload.sessionId === recapSessionId) {
      waitingForAnswer = false;
      lastAssistantText = payload.text || "";
      setOutput(lastAssistantText || "(No assistant output)");
    }
    return;
  }

  if (type === "turn_complete") {
    if (!payload.sessionId || payload.sessionId === recapSessionId) {
      waitingForAnswer = false;
      const status = payload.status || "unknown";
      const message = payload.errorMessage ? `${status}: ${payload.errorMessage}` : `Turn complete (${status}).`;
      setStatus(message);
    }
    return;
  }

  if (type === "status") {
    if (!payload.sessionId || payload.sessionId === recapSessionId) {
      if (typeof payload.message === "string") {
        setStatus(payload.message);
      }
    }
    return;
  }

  if (type === "error") {
    if (!payload.sessionId || payload.sessionId === recapSessionId) {
      waitingForAnswer = false;
      setStatus(typeof payload.message === "string" ? payload.message : "Unknown error.");
    }
  }
}

function connectSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  setStatus("Connecting websocket...");
  socket = new WebSocket(currentWsUrl());

  socket.addEventListener("open", () => {
    socketConnected = true;
    setStatus("Connected. Start recap session.");
  });

  socket.addEventListener("message", (event) => {
    handleSocketMessage(event.data);
  });

  socket.addEventListener("close", () => {
    socketConnected = false;
    setStatus("Websocket disconnected.");
  });

  socket.addEventListener("error", () => {
    socketConnected = false;
    setStatus("Websocket error.");
  });
}

async function loadDefaultRoot() {
  const saved = (localStorage.getItem(STORAGE_RECAP_ROOT_KEY) || "").trim();
  if (saved && recapRootInput) {
    recapRootInput.value = saved;
    return;
  }

  try {
    const url = new URL("api/logs/sessions", document.baseURI);
    url.searchParams.set("limit", "1");
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      return;
    }

    const payload = await response.json();
    const root = typeof payload?.codexHomePath === "string" ? payload.codexHomePath.trim() : "";
    if (root && recapRootInput) {
      recapRootInput.value = root;
      localStorage.setItem(STORAGE_RECAP_ROOT_KEY, root);
    }
  } catch {
  }
}

function startRecapSession() {
  const root = recapRootInput ? String(recapRootInput.value || "").trim() : "";
  if (!root) {
    setStatus("Root path is required.");
    return;
  }

  localStorage.setItem(STORAGE_RECAP_ROOT_KEY, root);
  if (!socketConnected) {
    connectSocket();
  }

  recapSessionId = "";
  recapThreadId = "";
  updateSessionMeta();

  const sent = sendFrame("session_create", {
    cwd: root,
    approvalPolicy: RECAP_APPROVAL_POLICY,
    sandbox: RECAP_SANDBOX
  });
  if (sent) {
    setStatus("Starting recap session...");
  }
}

function askRecap() {
  if (!recapSessionId) {
    setStatus("Start recap session first.");
    return;
  }

  if (waitingForAnswer) {
    setStatus("Wait for current response to complete.");
    return;
  }

  const text = recapPromptInput ? String(recapPromptInput.value || "").trim() : "";
  if (!text) {
    setStatus("Prompt is required.");
    return;
  }

  setOutput("Running query...");
  waitingForAnswer = true;

  const sent = sendFrame("turn_start", {
    sessionId: recapSessionId,
    text,
    approvalPolicy: RECAP_APPROVAL_POLICY,
    sandbox: RECAP_SANDBOX
  });

  if (!sent) {
    waitingForAnswer = false;
  }
}

async function loadTimeline() {
  if (!recapThreadId) {
    setStatus("No recap thread available yet.");
    return;
  }

  if (recapTimelineTitle) {
    recapTimelineTitle.textContent = `Timeline: ${recapThreadId}`;
  }
  if (recapTimelineStatus) {
    recapTimelineStatus.textContent = "Loading timeline...";
  }

  try {
    const url = new URL("api/turns/watch", document.baseURI);
    url.searchParams.set("threadId", recapThreadId);
    url.searchParams.set("initial", "true");
    url.searchParams.set("maxEntries", "12000");

    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`timeline load failed (${response.status}): ${detail}`);
    }

    const data = await response.json();
    if (timeline && typeof timeline.setServerTurns === "function") {
      timeline.setServerTurns(Array.isArray(data.turns) ? data.turns : []);
    } else if (timeline && typeof timeline.clear === "function") {
      timeline.clear();
    }

    recapTimelineStatus.textContent = `Loaded ${Number(data.turnCountInMemory || 0)} turns.`;
  } catch (error) {
    if (timeline && typeof timeline.clear === "function") {
      timeline.clear();
    }
    recapTimelineStatus.textContent = trimText(String(error), 300);
  }
}

function isMobileViewport() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(max-width: 900px)").matches
    : false;
}

function isMobileNavigationOpen() {
  return !!layoutRoot && layoutRoot.classList.contains("mobile-projects-open");
}

function isSidebarCollapsed() {
  return !!layoutRoot && layoutRoot.classList.contains("sidebar-collapsed");
}

function updateNavigationButtons() {
  const mobile = isMobileViewport();
  const open = mobile && isMobileNavigationOpen();

  if (mobileProjectsBtn) {
    mobileProjectsBtn.setAttribute("aria-expanded", open ? "true" : "false");
    mobileProjectsBtn.title = open ? "Hide navigation" : "Show navigation";
    mobileProjectsBtn.setAttribute("aria-label", mobileProjectsBtn.title);
  }

  if (sidebarToggleBtn) {
    const icon = sidebarToggleBtn.querySelector("i");
    if (mobile) {
      sidebarToggleBtn.title = "Close navigation";
      sidebarToggleBtn.setAttribute("aria-label", "Close navigation");
      sidebarToggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
      if (icon) {
        icon.className = "bi bi-x-lg";
      }
      return;
    }

    const collapsed = isSidebarCollapsed();
    sidebarToggleBtn.title = collapsed ? "Show navigation" : "Hide navigation";
    sidebarToggleBtn.setAttribute("aria-label", sidebarToggleBtn.title);
    if (icon) {
      icon.className = collapsed ? "bi bi-layout-sidebar-inset" : "bi bi-layout-sidebar-inset-reverse";
    }
  }
}

function setMobileNavigationOpen(isOpen) {
  if (!layoutRoot) {
    return;
  }

  const mobile = isMobileViewport();
  const open = mobile ? !!isOpen : false;
  layoutRoot.classList.toggle("mobile-projects-open", open);
  if (sidebarBackdrop) {
    sidebarBackdrop.classList.toggle("hidden", !open);
  }

  updateNavigationButtons();
}

function applySidebarCollapsed(isCollapsed) {
  if (!layoutRoot) {
    return;
  }

  if (isMobileViewport()) {
    layoutRoot.classList.remove("sidebar-collapsed");
    updateNavigationButtons();
    return;
  }

  layoutRoot.classList.toggle("sidebar-collapsed", !!isCollapsed);
  localStorage.setItem(STORAGE_SIDEBAR_COLLAPSED_KEY, isCollapsed ? "1" : "0");
  updateNavigationButtons();
}

function wireEvents() {
  if (recapStartBtn) {
    recapStartBtn.addEventListener("click", () => {
      startRecapSession();
    });
  }

  if (recapAskBtn) {
    recapAskBtn.addEventListener("click", () => {
      askRecap();
    });
  }

  if (recapOpenTimelineBtn) {
    recapOpenTimelineBtn.addEventListener("click", () => {
      loadTimeline();
    });
  }

  if (recapPromptInput) {
    recapPromptInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        askRecap();
      }
    });
  }

  if (recapRootInput) {
    recapRootInput.addEventListener("change", () => {
      const root = String(recapRootInput.value || "").trim();
      localStorage.setItem(STORAGE_RECAP_ROOT_KEY, root);
    });
  }

  if (mobileProjectsBtn) {
    mobileProjectsBtn.addEventListener("click", () => {
      setMobileNavigationOpen(!isMobileNavigationOpen());
    });
  }

  if (sidebarBackdrop) {
    sidebarBackdrop.addEventListener("click", () => {
      setMobileNavigationOpen(false);
    });
  }

  if (sidebarToggleBtn) {
    sidebarToggleBtn.addEventListener("click", () => {
      if (isMobileViewport()) {
        setMobileNavigationOpen(false);
        return;
      }

      applySidebarCollapsed(!isSidebarCollapsed());
    });
  }

  window.addEventListener("resize", () => {
    if (!isMobileViewport()) {
      setMobileNavigationOpen(false);
      applySidebarCollapsed(localStorage.getItem(STORAGE_SIDEBAR_COLLAPSED_KEY) === "1");
    }

    updateNavigationButtons();
  });
}

async function initializePage() {
  const savedCollapsed = localStorage.getItem(STORAGE_SIDEBAR_COLLAPSED_KEY) === "1";
  applySidebarCollapsed(savedCollapsed);
  setMobileNavigationOpen(false);
  wireEvents();
  updateSessionMeta();
  await loadDefaultRoot();
  connectSocket();
}

initializePage();
