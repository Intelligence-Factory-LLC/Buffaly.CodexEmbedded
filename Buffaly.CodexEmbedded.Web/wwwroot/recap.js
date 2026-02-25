const STORAGE_SIDEBAR_COLLAPSED_KEY = "codex.recap.sidebarCollapsed.v1";
const MAX_SESSIONS = 900;
const MAX_RESULTS = 120;
const MAX_FIND_RESULTS = 80;

const layoutRoot = document.querySelector(".layout");
const sessionSidebar = document.getElementById("sessionSidebar");
const sidebarToggleBtn = document.getElementById("sidebarToggleBtn");
const mobileProjectsBtn = document.getElementById("mobileProjectsBtn");
const sidebarBackdrop = document.getElementById("sidebarBackdrop");

const recapDateInput = document.getElementById("recapDateInput");
const recapRefreshBtn = document.getElementById("recapRefreshBtn");
const recapQueryInput = document.getElementById("recapQueryInput");
const recapAskBtn = document.getElementById("recapAskBtn");
const recapFindInput = document.getElementById("recapFindInput");
const recapFindBtn = document.getElementById("recapFindBtn");

const recapStatus = document.getElementById("recapStatus");
const recapAnswer = document.getElementById("recapAnswer");
const recapSummary = document.getElementById("recapSummary");
const recapReport = document.getElementById("recapReport");
const recapProjects = document.getElementById("recapProjects");
const recapSessions = document.getElementById("recapSessions");
const recapFindResults = document.getElementById("recapFindResults");
const recapThreads = document.getElementById("recapThreads");
const recapMatches = document.getElementById("recapMatches");
const recapTimelineTitle = document.getElementById("recapTimelineTitle");
const recapTimelineStatus = document.getElementById("recapTimelineStatus");
const recapTimeline = document.getElementById("recapTimeline");

const timeline = new window.CodexSessionTimeline({
  container: recapTimeline,
  maxRenderedEntries: 1500,
  systemTitle: "Recap"
});

let currentDayPayload = null;
let activeTimelineThreadId = "";

function toLocalDateValue(date) {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function browserTimezone() {
  try {
    const value = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof value === "string" && value.trim() ? value.trim() : "";
  } catch {
    return "";
  }
}

function setStatus(message) {
  if (recapStatus) {
    recapStatus.textContent = message;
  }
}

function clearNode(node) {
  if (node) {
    node.textContent = "";
  }
}

function appendLine(node, label, value) {
  const row = document.createElement("div");
  row.className = "recap-kv";

  const key = document.createElement("span");
  key.className = "recap-k";
  key.textContent = `${label}:`;
  row.appendChild(key);

  const val = document.createElement("span");
  val.className = "recap-v";
  val.textContent = value || "";
  row.appendChild(val);

  node.appendChild(row);
}

function createActionButton(label, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "recap-action-btn";
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

function trimText(text, maxChars = 220) {
  const normalized = typeof text === "string" ? text.replace(/\r/g, "").trim() : "";
  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars)}...`;
}

function formatTimestamp(utcValue) {
  if (typeof utcValue !== "string" || !utcValue.trim()) {
    return "";
  }

  const tick = Date.parse(utcValue);
  if (!Number.isFinite(tick)) {
    return utcValue;
  }

  return new Date(tick).toLocaleString();
}

function projectNameFromPath(pathValue) {
  const path = typeof pathValue === "string" ? pathValue.replace(/\\/g, "/").replace(/\/+$/, "") : "";
  if (!path || path === "(unknown project)") {
    return "(unknown project)";
  }

  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

function renderSummary(payload) {
  clearNode(recapSummary);
  if (!payload || !payload.summary) {
    return;
  }

  const wrap = document.createElement("div");
  wrap.className = "recap-card";
  appendLine(wrap, "Events", String(payload.summary.eventCount || 0));
  appendLine(wrap, "Sessions", String(payload.summary.activeThreadCount || 0));
  appendLine(wrap, "User prompts", String(payload.summary.userPromptCount || 0));
  appendLine(wrap, "Assistant messages", String(payload.summary.assistantMessageCount || 0));
  appendLine(wrap, "Tool calls", String(payload.summary.toolCallCount || 0));

  const topCommands = Array.isArray(payload.summary.topCommands)
    ? payload.summary.topCommands.slice(0, 6).map((x) => `${x.value} (${x.count})`)
    : [];
  if (topCommands.length > 0) {
    appendLine(wrap, "Top commands", topCommands.join(", "));
  }

  const topTopics = Array.isArray(payload.summary.topTopics)
    ? payload.summary.topTopics.slice(0, 8).map((x) => `${x.value} (${x.count})`)
    : [];
  if (topTopics.length > 0) {
    appendLine(wrap, "Top topics", topTopics.join(", "));
  }

  recapSummary.appendChild(wrap);
}

function renderReport(payload) {
  if (!recapReport) {
    return;
  }

  const reportText = payload && typeof payload.reportMarkdown === "string"
    ? payload.reportMarkdown.trim()
    : "";
  recapReport.textContent = reportText || "No project report available.";
}

function renderProjects(payload) {
  clearNode(recapProjects);
  const projects = payload && Array.isArray(payload.projects) ? payload.projects : [];
  if (projects.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "No project activity found for this day.";
    recapProjects.appendChild(empty);
    return;
  }

  for (const project of projects) {
    const card = document.createElement("div");
    card.className = "recap-card";

    const title = document.createElement("div");
    title.className = "recap-card-title";
    title.textContent = project.projectName || projectNameFromPath(project.projectPath || "");
    card.appendChild(title);

    appendLine(card, "Path", project.projectPath || "");
    appendLine(card, "Sessions", String(project.sessionCount || 0));
    appendLine(card, "Events", String(project.eventCount || 0));
    appendLine(card, "Prompts", String(project.userPromptCount || 0));
    appendLine(card, "Tool calls", String(project.toolCallCount || 0));
    appendLine(card, "Last", formatTimestamp(project.lastEventUtc));

    if (Array.isArray(project.topTopics) && project.topTopics.length > 0) {
      const topics = project.topTopics.slice(0, 4).map((x) => `${x.value} (${x.count})`).join(", ");
      appendLine(card, "Topics", topics);
    }

    if (Array.isArray(project.sessions) && project.sessions.length > 0) {
      const topSession = project.sessions[0];
      const actions = document.createElement("div");
      actions.className = "recap-actions";
      actions.appendChild(createActionButton("Open Top Session Timeline", () => {
        loadTimeline(topSession.threadId, topSession.threadName || topSession.threadId);
      }));
      card.appendChild(actions);
    }

    recapProjects.appendChild(card);
  }
}

function renderSessionList(payload) {
  clearNode(recapSessions);
  const sessions = payload && Array.isArray(payload.sessions) ? payload.sessions : [];
  if (sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "No session activity found for this day.";
    recapSessions.appendChild(empty);
    return;
  }

  for (const session of sessions) {
    const card = document.createElement("div");
    card.className = "recap-card";

    const title = document.createElement("div");
    title.className = "recap-card-title";
    title.textContent = session.threadName || session.threadId || "(unknown thread)";
    card.appendChild(title);

    appendLine(card, "Thread", session.threadId || "");
    appendLine(card, "Project", projectNameFromPath(session.cwd || ""));
    appendLine(card, "Events", String(session.eventCount || 0));
    appendLine(card, "Prompts", String(session.userPromptCount || 0));
    appendLine(card, "Tool calls", String(session.toolCallCount || 0));
    appendLine(card, "Last", formatTimestamp(session.lastEventUtc));

    if (Array.isArray(session.promptSamples) && session.promptSamples.length > 0) {
      appendLine(card, "Prompt", trimText(session.promptSamples[0], 180));
    }

    const actions = document.createElement("div");
    actions.className = "recap-actions";
    actions.appendChild(createActionButton("Open Timeline", () => {
      loadTimeline(session.threadId, session.threadName || session.threadId);
    }));
    card.appendChild(actions);

    recapSessions.appendChild(card);
  }
}

function renderFindSessionResults(payload) {
  clearNode(recapFindResults);
  const results = payload && Array.isArray(payload.results) ? payload.results : [];
  if (results.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "No session finder results.";
    recapFindResults.appendChild(empty);
    return;
  }

  for (const result of results) {
    const card = document.createElement("div");
    card.className = "recap-card recap-match-card";

    const header = document.createElement("div");
    header.className = "recap-match-header";

    const title = document.createElement("div");
    title.className = "recap-card-title";
    title.textContent = result.threadName || result.threadId || "(unknown thread)";
    header.appendChild(title);

    const score = document.createElement("div");
    score.className = "recap-score";
    score.textContent = `score ${result.score || 0}`;
    header.appendChild(score);
    card.appendChild(header);

    appendLine(card, "Thread", result.threadId || "");
    appendLine(card, "Project", result.projectName || projectNameFromPath(result.cwd || ""));
    appendLine(card, "Events", String(result.eventCount || 0));
    appendLine(card, "Last", formatTimestamp(result.lastEventUtc));

    if (Array.isArray(result.sampleMatches) && result.sampleMatches.length > 0) {
      appendLine(card, "Sample", trimText(result.sampleMatches[0], 220));
    }

    const actions = document.createElement("div");
    actions.className = "recap-actions";
    actions.appendChild(createActionButton("Open Timeline", () => {
      loadTimeline(result.threadId, result.threadName || result.threadId);
    }));
    card.appendChild(actions);

    recapFindResults.appendChild(card);
  }
}

function renderThreadMatches(payload) {
  clearNode(recapThreads);
  const threads = payload && Array.isArray(payload.threads) ? payload.threads : [];
  if (threads.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "No matching sessions yet.";
    recapThreads.appendChild(empty);
    return;
  }

  for (const thread of threads) {
    const card = document.createElement("div");
    card.className = "recap-card";

    const title = document.createElement("div");
    title.className = "recap-card-title";
    title.textContent = thread.threadName || thread.threadId || "(unknown thread)";
    card.appendChild(title);

    appendLine(card, "Thread", thread.threadId || "");
    appendLine(card, "Project", projectNameFromPath(thread.cwd || ""));
    appendLine(card, "Matches", String(thread.matchCount || 0));
    appendLine(card, "Top score", String(thread.topScore || 0));
    appendLine(card, "Last match", formatTimestamp(thread.lastMatchUtc));

    if (Array.isArray(thread.sampleMatches) && thread.sampleMatches.length > 0) {
      appendLine(card, "Sample", trimText(thread.sampleMatches[0], 180));
    }

    const actions = document.createElement("div");
    actions.className = "recap-actions";
    actions.appendChild(createActionButton("Open Timeline", () => {
      loadTimeline(thread.threadId, thread.threadName || thread.threadId);
    }));
    card.appendChild(actions);

    recapThreads.appendChild(card);
  }
}

function renderEventMatches(payload) {
  clearNode(recapMatches);
  const matches = payload && Array.isArray(payload.matches) ? payload.matches : [];
  if (matches.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "No matching events.";
    recapMatches.appendChild(empty);
    return;
  }

  for (const match of matches) {
    const card = document.createElement("div");
    card.className = "recap-card recap-match-card";

    const header = document.createElement("div");
    header.className = "recap-match-header";

    const title = document.createElement("div");
    title.className = "recap-card-title";
    title.textContent = match.threadName || match.threadId || "(unknown thread)";
    header.appendChild(title);

    const score = document.createElement("div");
    score.className = "recap-score";
    score.textContent = `score ${match.score || 0}`;
    header.appendChild(score);
    card.appendChild(header);

    appendLine(card, "When", formatTimestamp(match.timestampUtc));
    appendLine(card, "Type", match.eventType || "");
    appendLine(card, "Project", projectNameFromPath(match.cwd || ""));
    appendLine(card, "Text", trimText(match.command || match.text || "", 260));

    const actions = document.createElement("div");
    actions.className = "recap-actions";
    actions.appendChild(createActionButton("Open Timeline", () => {
      loadTimeline(match.threadId, match.threadName || match.threadId);
    }));
    card.appendChild(actions);

    recapMatches.appendChild(card);
  }
}

function renderAnswer(text) {
  if (recapAnswer) {
    recapAnswer.textContent = trimText(text || "", 4000);
  }
}

async function requestDayRecap() {
  const dateValue = recapDateInput && recapDateInput.value ? recapDateInput.value : toLocalDateValue(new Date());
  const timezone = browserTimezone();
  const url = new URL("api/recap/day", document.baseURI);
  url.searchParams.set("date", dateValue);
  url.searchParams.set("maxSessions", String(MAX_SESSIONS));
  if (timezone) {
    url.searchParams.set("timezone", timezone);
  }

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`recap day failed (${response.status}): ${detail}`);
  }

  return await response.json();
}

async function loadDayRecap() {
  setStatus("Loading day recap...");
  try {
    const payload = await requestDayRecap();
    currentDayPayload = payload;

    renderSummary(payload);
    renderReport(payload);
    renderProjects(payload);
    renderSessionList(payload);
    renderFindSessionResults({ results: [] });
    renderThreadMatches({ threads: [] });
    renderEventMatches({ matches: [] });
    renderAnswer(payload.reportMarkdown || `Daily recap loaded for ${payload.localDate} (${payload.timezone}).`);

    const projectCount = Array.isArray(payload.projects) ? payload.projects.length : 0;
    setStatus(`Loaded ${payload.summary?.eventCount || 0} events across ${payload.summary?.activeThreadCount || 0} sessions in ${projectCount} projects.`);

    if (!activeTimelineThreadId && Array.isArray(payload.sessions) && payload.sessions.length > 0) {
      const first = payload.sessions[0];
      if (first && first.threadId) {
        loadTimeline(first.threadId, first.threadName || first.threadId);
      }
    }
  } catch (error) {
    setStatus("Failed to load day recap.");
    renderAnswer(String(error));
  }
}

async function requestQuery() {
  const queryText = recapQueryInput ? (recapQueryInput.value || "").trim() : "";
  const dateValue = recapDateInput && recapDateInput.value ? recapDateInput.value : toLocalDateValue(new Date());
  const timezone = browserTimezone();

  const body = {
    query: queryText,
    localDate: dateValue,
    timezone,
    maxResults: MAX_RESULTS,
    maxSessions: MAX_SESSIONS
  };

  const response = await fetch("api/recap/query", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`recap query failed (${response.status}): ${detail}`);
  }

  return await response.json();
}

async function runQuery() {
  setStatus("Running recap query...");
  try {
    const payload = await requestQuery();
    renderAnswer(payload.answer || "");
    renderSummary(payload);
    renderReport(payload);
    renderProjects(payload);
    renderThreadMatches(payload);
    renderEventMatches(payload);

    if (currentDayPayload && Array.isArray(currentDayPayload.sessions)) {
      renderSessionList(currentDayPayload);
    }

    setStatus(`Query returned ${Array.isArray(payload.matches) ? payload.matches.length : 0} matching events.`);

    if (Array.isArray(payload.threads) && payload.threads.length > 0) {
      const first = payload.threads[0];
      if (first && first.threadId) {
        loadTimeline(first.threadId, first.threadName || first.threadId);
      }
    }
  } catch (error) {
    setStatus("Recap query failed.");
    renderAnswer(String(error));
  }
}

async function requestSessionFinder() {
  const queryText = recapFindInput ? (recapFindInput.value || "").trim() : "";
  const dateValue = recapDateInput && recapDateInput.value ? recapDateInput.value : toLocalDateValue(new Date());
  const timezone = browserTimezone();
  const url = new URL("api/recap/find-sessions", document.baseURI);
  url.searchParams.set("query", queryText);
  url.searchParams.set("date", dateValue);
  url.searchParams.set("maxResults", String(MAX_FIND_RESULTS));
  url.searchParams.set("maxSessions", String(MAX_SESSIONS));
  if (timezone) {
    url.searchParams.set("timezone", timezone);
  }

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`session finder failed (${response.status}): ${detail}`);
  }

  return await response.json();
}

async function runSessionFinder() {
  setStatus("Finding sessions...");
  try {
    const payload = await requestSessionFinder();
    renderFindSessionResults(payload);
    renderAnswer(payload.answer || "");
    if (payload && Array.isArray(payload.projects)) {
      renderProjects(payload);
    }

    const resultCount = Array.isArray(payload.results) ? payload.results.length : 0;
    setStatus(`Session finder returned ${resultCount} sessions.`);

    if (resultCount > 0) {
      const top = payload.results[0];
      if (top && top.threadId) {
        loadTimeline(top.threadId, top.threadName || top.threadId);
      }
    }
  } catch (error) {
    setStatus("Session finder failed.");
    renderAnswer(String(error));
  }
}

async function loadTimeline(threadId, displayName) {
  if (!threadId) {
    return;
  }

  activeTimelineThreadId = threadId;
  if (recapTimelineTitle) {
    recapTimelineTitle.textContent = `Timeline: ${displayName || threadId}`;
  }
  if (recapTimelineStatus) {
    recapTimelineStatus.textContent = "Loading timeline...";
  }

  try {
    const url = new URL("api/turns/watch", document.baseURI);
    url.searchParams.set("threadId", threadId);
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

    const turnCount = Number(data.turnCountInMemory || 0);
    recapTimelineStatus.textContent = `Loaded ${turnCount} turns from thread ${threadId}.`;
  } catch (error) {
    if (timeline && typeof timeline.clear === "function") {
      timeline.clear();
    }
    recapTimelineStatus.textContent = `Timeline error: ${error}`;
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
  if (recapRefreshBtn) {
    recapRefreshBtn.addEventListener("click", () => {
      loadDayRecap();
    });
  }

  if (recapAskBtn) {
    recapAskBtn.addEventListener("click", () => {
      runQuery();
    });
  }

  if (recapFindBtn) {
    recapFindBtn.addEventListener("click", () => {
      runSessionFinder();
    });
  }

  if (recapQueryInput) {
    recapQueryInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        runQuery();
      }
    });
  }

  if (recapFindInput) {
    recapFindInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        runSessionFinder();
      }
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

function initializePage() {
  if (recapDateInput && !recapDateInput.value) {
    recapDateInput.value = toLocalDateValue(new Date());
  }

  const savedCollapsed = localStorage.getItem(STORAGE_SIDEBAR_COLLAPSED_KEY) === "1";
  applySidebarCollapsed(savedCollapsed);
  setMobileNavigationOpen(false);
  wireEvents();
  loadDayRecap();
}

initializePage();
