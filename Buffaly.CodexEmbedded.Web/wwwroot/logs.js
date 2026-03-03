const STORAGE_SELECTED_THREAD_KEY = "codex.logs.selectedThread.v1";
const STORAGE_SELECTED_PROJECT_KEY = "codex.logs.selectedProject.v1";
const STORAGE_COLLAPSED_PROJECTS_KEY = "codex.logs.collapsedProjects.v1";
const STORAGE_SIDEBAR_COLLAPSED_KEY = "codex.logs.sidebarCollapsed.v1";

const layoutRoot = document.querySelector(".layout");
const sessionSidebar = document.getElementById("sessionSidebar");
const sidebarToggleBtn = document.getElementById("sidebarToggleBtn");
const mobileProjectsBtn = document.getElementById("mobileProjectsBtn");
const sidebarBackdrop = document.getElementById("sidebarBackdrop");
const projectList = document.getElementById("projectList");

const logsStatus = document.getElementById("logsStatus");
const logsRefreshBtn = document.getElementById("logsRefreshBtn");
const messagesSummary = document.getElementById("messagesSummary");
const messagesList = document.getElementById("messagesList");

let sessions = [];
let projectGroups = [];
let sessionsByProjectKey = new Map();

let activeProjectKey = null;
let activeThreadId = null;
let collapsedProjectKeys = new Set();

let messageRows = [];

let pollInFlight = false;

function setStatus(text) {
  if (!logsStatus) {
    return;
  }

  logsStatus.textContent = text;
}

function normalizePath(path) {
  if (!path || typeof path !== "string") {
    return "";
  }

  return path.replace(/\\/g, "/");
}

function normalizeProjectCwd(cwd) {
  return normalizePath(cwd || "").replace(/\/+$/g, "");
}

function getProjectKeyFromCwd(cwd) {
  const normalized = normalizeProjectCwd(cwd);
  return normalized ? normalized.toLowerCase() : "(unknown)";
}

function pathLeaf(path) {
  const normalized = normalizeProjectCwd(path);
  if (!normalized) {
    return "";
  }

  const parts = normalized.split("/");
  return parts.length > 0 ? parts[parts.length - 1] : normalized;
}

function getProjectDisplayName(project) {
  if (!project) {
    return "(unknown project)";
  }

  return pathLeaf(project.cwd) || "(unknown project)";
}

function getSessionUpdatedTick(session) {
  if (!session || !session.updatedAtUtc) {
    return 0;
  }

  const tick = Date.parse(session.updatedAtUtc);
  return Number.isFinite(tick) ? tick : 0;
}

function formatSessionSubtitle(session) {
  const parts = [];
  const tick = getSessionUpdatedTick(session);
  if (tick > 0) {
    parts.push(new Date(tick).toLocaleString());
  }

  if (session.model) {
    parts.push(session.model);
  }

  return parts.join(" | ");
}

function valueText(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function extractMessagePreviewText(row) {
  if (!row || typeof row !== "object") {
    return "";
  }
  const role = valueText(row.Role || row.role).trim().toLowerCase();
  if (role === "event") {
    const name = valueText(row.Name || row.name).trim();
    const status = valueText((row.Event && row.Event.Status) || (row.event && row.event.status)).trim();
    return status ? `${name} (${status})` : name;
  }

  const content = row.Content ?? row.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (content && typeof content === "object") {
    const direct = content.message || content.text || content.summary || content.output_text || content.outputText || "";
    if (typeof direct === "string" && direct.trim()) {
      text = direct;
    } else {
      try {
        text = JSON.stringify(content);
      } catch {
        text = "";
      }
    }
  } else {
    text = valueText(content);
  }

  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(no message text)";
  }
  return normalized.length > 180 ? `${normalized.slice(0, 180)}...` : normalized;
}

function clearMessageRows() {
  messageRows = [];
  if (messagesSummary) {
    messagesSummary.textContent = "No message rows loaded.";
  }
  if (messagesList) {
    messagesList.textContent = "";
  }
}

function renderMessageRows() {
  if (!messagesSummary || !messagesList) {
    return;
  }

  const rows = Array.isArray(messageRows) ? messageRows : [];
  messagesSummary.textContent = `Messages: ${rows.length.toLocaleString()}`;
  messagesList.textContent = "";
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "logs-message-empty";
    empty.textContent = "No timeline messages for this session yet.";
    messagesList.appendChild(empty);
    return;
  }

  const output = rows.map((row, index) => {
    const role = valueText(row && (row.Role || row.role)).trim() || "message";
    const preview = extractMessagePreviewText(row);
    let jsonText = "";
    try {
      jsonText = JSON.stringify(row, null, 2);
    } catch {
      jsonText = valueText(row);
    }

    return `#${index + 1} ${role} - ${preview}\n${jsonText}`;
  }).join("\n\n");

  const body = document.createElement("pre");
  body.className = "logs-message-json";
  body.textContent = output;
  messagesList.appendChild(body);
}

function buildActionIcon(kind) {
  const icon = document.createElement("i");
  icon.setAttribute("aria-hidden", "true");

  const iconClass = kind === "chevronRight" ? "bi-chevron-right" : "bi-chevron-down";
  icon.className = `bi ${iconClass}`;
  return icon;
}

function persistCollapsedProjectKeys() {
  localStorage.setItem(STORAGE_COLLAPSED_PROJECTS_KEY, JSON.stringify(Array.from(collapsedProjectKeys)));
}

function loadUiState() {
  const selectedThread = localStorage.getItem(STORAGE_SELECTED_THREAD_KEY);
  activeThreadId = selectedThread && selectedThread.trim() ? selectedThread.trim() : null;

  const selectedProject = localStorage.getItem(STORAGE_SELECTED_PROJECT_KEY);
  activeProjectKey = selectedProject && selectedProject.trim() ? selectedProject.trim() : null;

  let collapsed = [];
  try {
    collapsed = JSON.parse(localStorage.getItem(STORAGE_COLLAPSED_PROJECTS_KEY) || "[]");
  } catch {
    collapsed = [];
  }

  collapsedProjectKeys = new Set(Array.isArray(collapsed) ? collapsed.filter((x) => typeof x === "string") : []);
}

function rebuildProjectGroups() {
  const map = new Map();
  for (const session of sessions) {
    if (!session || !session.threadId) {
      continue;
    }

    const cwd = normalizeProjectCwd(session.cwd || "");
    const key = getProjectKeyFromCwd(cwd);
    if (!map.has(key)) {
      map.set(key, {
        key,
        cwd,
        sessions: [],
        latestTick: 0
      });
    }

    const group = map.get(key);
    group.sessions.push(session);
    const tick = getSessionUpdatedTick(session);
    if (tick > group.latestTick) {
      group.latestTick = tick;
    }
  }

  const groups = Array.from(map.values());
  for (const group of groups) {
    group.sessions.sort((a, b) => {
      const tickCompare = getSessionUpdatedTick(b) - getSessionUpdatedTick(a);
      if (tickCompare !== 0) return tickCompare;
      return (a.threadId || "").localeCompare(b.threadId || "");
    });
  }

  groups.sort((a, b) => {
    const tickCompare = b.latestTick - a.latestTick;
    if (tickCompare !== 0) return tickCompare;
    return getProjectDisplayName(a).localeCompare(getProjectDisplayName(b));
  });

  projectGroups = groups;
  sessionsByProjectKey = new Map(groups.map((group) => [group.key, group.sessions]));
}

function findProjectKeyByThreadId(threadId) {
  if (!threadId) {
    return null;
  }

  for (const group of projectGroups) {
    if (group.sessions.some((x) => x.threadId === threadId)) {
      return group.key;
    }
  }

  return null;
}

function updateSelectionAfterSessionRefresh() {
  if (projectGroups.length === 0) {
    activeProjectKey = null;
    activeThreadId = null;
    return;
  }

  if (activeThreadId) {
    const projectForThread = findProjectKeyByThreadId(activeThreadId);
    if (projectForThread) {
      activeProjectKey = projectForThread;
      return;
    }
  }

  if (activeProjectKey && sessionsByProjectKey.has(activeProjectKey)) {
    const projectSessions = sessionsByProjectKey.get(activeProjectKey) || [];
    activeThreadId = projectSessions.length > 0 ? projectSessions[0].threadId || null : null;
    return;
  }

  const firstProject = projectGroups[0];
  activeProjectKey = firstProject.key;
  activeThreadId = firstProject.sessions.length > 0 ? firstProject.sessions[0].threadId || null : null;
}

function renderProjectSidebar() {
  if (!projectList) {
    return;
  }

  projectList.textContent = "";
  if (projectGroups.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "No session logs found.";
    projectList.appendChild(empty);
    return;
  }

  for (const group of projectGroups) {
    const groupEl = document.createElement("div");
    groupEl.className = "project-group";
    if (collapsedProjectKeys.has(group.key)) {
      groupEl.classList.add("collapsed");
    }

    const header = document.createElement("div");
    header.className = "project-header";

    const isCollapsed = collapsedProjectKeys.has(group.key);
    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "project-toggle";
    toggleBtn.title = isCollapsed ? "Expand project" : "Collapse project";
    toggleBtn.setAttribute("aria-label", toggleBtn.title);
    toggleBtn.appendChild(buildActionIcon(isCollapsed ? "chevronRight" : "chevronDown"));
    toggleBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (collapsedProjectKeys.has(group.key)) {
        collapsedProjectKeys.delete(group.key);
      } else {
        collapsedProjectKeys.add(group.key);
      }
      persistCollapsedProjectKeys();
      renderProjectSidebar();
    });
    header.appendChild(toggleBtn);

    const nameWrap = document.createElement("div");
    nameWrap.className = "project-name-wrap";
    nameWrap.addEventListener("click", () => {
      activeProjectKey = group.key;
      localStorage.setItem(STORAGE_SELECTED_PROJECT_KEY, activeProjectKey);
      renderProjectSidebar();
    });

    const name = document.createElement("div");
    name.className = "project-name";
    name.textContent = `${getProjectDisplayName(group)} (${group.sessions.length})`;
    nameWrap.appendChild(name);

    const path = document.createElement("div");
    path.className = "project-path";
    path.textContent = group.cwd || "(unknown cwd)";
    nameWrap.appendChild(path);
    header.appendChild(nameWrap);

    groupEl.appendChild(header);

    const sessionsWrap = document.createElement("div");
    sessionsWrap.className = "project-sessions";
    for (const session of group.sessions) {
      const row = document.createElement("div");
      row.className = "session-row";
      if (session.threadId === activeThreadId) {
        row.classList.add("active");
      }

      const head = document.createElement("div");
      head.className = "session-row-head";

      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "session-open-btn";
      openBtn.title = session.threadId || "session";
      openBtn.addEventListener("click", () => {
        if (!session.threadId) {
          return;
        }

        const changed = activeThreadId !== session.threadId;
        activeThreadId = session.threadId;
        activeProjectKey = group.key;
        localStorage.setItem(STORAGE_SELECTED_THREAD_KEY, activeThreadId);
        localStorage.setItem(STORAGE_SELECTED_PROJECT_KEY, activeProjectKey);
        renderProjectSidebar();
        if (changed) {
          clearMessageRows();
          refreshSelectedMessages().catch((error) => {
            setStatus(`Timeline refresh error: ${error}`);
          });
        }

        if (isMobileViewport()) {
          setMobileProjectsOpen(false);
        }
      });

      const title = document.createElement("div");
      title.className = "session-title";
      title.textContent = session.threadName || session.threadId || "(unknown thread)";
      openBtn.appendChild(title);

      const subtitle = document.createElement("div");
      subtitle.className = "session-subtitle";
      subtitle.textContent = formatSessionSubtitle(session);
      openBtn.appendChild(subtitle);
      head.appendChild(openBtn);

      row.appendChild(head);
      sessionsWrap.appendChild(row);
    }

    if (group.sessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "sidebar-empty";
      empty.textContent = "No sessions in this project.";
      sessionsWrap.appendChild(empty);
    }

    groupEl.appendChild(sessionsWrap);
    projectList.appendChild(groupEl);
  }
}

function isMobileViewport() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(max-width: 900px)").matches
    : false;
}

function isMobileProjectsOpen() {
  return !!layoutRoot && layoutRoot.classList.contains("mobile-projects-open");
}

function isSidebarCollapsed() {
  return !!layoutRoot && layoutRoot.classList.contains("sidebar-collapsed");
}

function updateMobileProjectsButton() {
  const mobile = isMobileViewport();
  const open = mobile && isMobileProjectsOpen();

  if (mobileProjectsBtn) {
    mobileProjectsBtn.setAttribute("aria-expanded", open ? "true" : "false");
    mobileProjectsBtn.title = open ? "Hide projects" : "Show projects";
    mobileProjectsBtn.setAttribute("aria-label", mobileProjectsBtn.title);
  }

  if (sidebarToggleBtn) {
    const icon = sidebarToggleBtn.querySelector("i");
    if (mobile) {
      sidebarToggleBtn.title = "Close projects";
      sidebarToggleBtn.setAttribute("aria-label", "Close projects");
      sidebarToggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
      if (icon) {
        icon.className = "bi bi-x-lg";
      }
      return;
    }

    const collapsed = isSidebarCollapsed();
    const label = collapsed ? "Show projects" : "Hide projects";
    sidebarToggleBtn.title = label;
    sidebarToggleBtn.setAttribute("aria-label", label);
    sidebarToggleBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    if (icon) {
      icon.className = collapsed ? "bi bi-layout-sidebar-inset" : "bi bi-layout-sidebar-inset-reverse";
    }
  }
}

function setMobileProjectsOpen(isOpen) {
  if (!layoutRoot) {
    return;
  }

  const mobile = isMobileViewport();
  const open = mobile ? !!isOpen : false;
  layoutRoot.classList.toggle("mobile-projects-open", open);
  if (sidebarBackdrop) {
    sidebarBackdrop.classList.toggle("hidden", !open);
  }

  updateMobileProjectsButton();
}

function applySidebarCollapsed(isCollapsed) {
  if (!layoutRoot) {
    return;
  }

  if (isMobileViewport()) {
    layoutRoot.classList.remove("sidebar-collapsed");
    updateMobileProjectsButton();
    return;
  }

  layoutRoot.classList.toggle("sidebar-collapsed", isCollapsed);
  localStorage.setItem(STORAGE_SIDEBAR_COLLAPSED_KEY, isCollapsed ? "1" : "0");
  updateMobileProjectsButton();
}

function pollContextLabel() {
  if (!activeThreadId) {
    return "";
  }

  for (const group of projectGroups) {
    for (const session of group.sessions) {
      if (session.threadId === activeThreadId) {
        const projectName = getProjectDisplayName(group);
        const sessionName = session.threadName || session.threadId;
        return `${projectName} / ${sessionName}`;
      }
    }
  }

  return activeThreadId;
}

async function refreshSelectedMessages() {
  if (pollInFlight) {
    return;
  }

  pollInFlight = true;
  try {
  if (!activeThreadId) {
    setStatus("Select a session to view timeline messages.");
    clearMessageRows();
    return;
  }

  const url = new URL("api/turns/bootstrap", document.baseURI);
  url.searchParams.set("threadId", activeThreadId);
  url.searchParams.set("maxEntries", "6000");

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`messages bootstrap failed (${response.status}): ${await response.text()}`);
  }

  const data = await response.json();
  messageRows = Array.isArray(data.messages) ? data.messages : [];

  renderMessageRows();
  const label = pollContextLabel();
  setStatus(`Session Logs: ${label || "(unknown)"} | manual refresh`);
  } finally {
    pollInFlight = false;
  }
}

async function refreshEverything() {
  setStatus("Refreshing sessions...");
  await refreshSessionList();
  await refreshSelectedMessages();
}

async function refreshSessionList() {
  const priorThread = activeThreadId;
  const priorProject = activeProjectKey;

  const url = new URL("api/logs/sessions", document.baseURI);
  url.searchParams.set("limit", "200");
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`failed loading sessions (${response.status})`);
  }

  const data = await response.json();
  sessions = Array.isArray(data.sessions) ? data.sessions : [];
  rebuildProjectGroups();

  activeThreadId = priorThread;
  activeProjectKey = priorProject;
  updateSelectionAfterSessionRefresh();
  renderProjectSidebar();

  if (activeThreadId) {
    localStorage.setItem(STORAGE_SELECTED_THREAD_KEY, activeThreadId);
  } else {
    localStorage.removeItem(STORAGE_SELECTED_THREAD_KEY);
  }

  if (activeProjectKey) {
    localStorage.setItem(STORAGE_SELECTED_PROJECT_KEY, activeProjectKey);
  } else {
    localStorage.removeItem(STORAGE_SELECTED_PROJECT_KEY);
  }
}

function wireUiEvents() {
  if (logsRefreshBtn) {
    logsRefreshBtn.addEventListener("click", () => {
      refreshEverything().catch((error) => {
        setStatus(`Refresh failed: ${error}`);
      });
    });
  }

  if (mobileProjectsBtn) {
    mobileProjectsBtn.addEventListener("click", () => {
      setMobileProjectsOpen(!isMobileProjectsOpen());
    });
  }

  if (sidebarBackdrop) {
    sidebarBackdrop.addEventListener("click", () => {
      setMobileProjectsOpen(false);
    });
  }

  if (sidebarToggleBtn) {
    sidebarToggleBtn.addEventListener("click", () => {
      if (isMobileViewport()) {
        setMobileProjectsOpen(false);
        return;
      }

      applySidebarCollapsed(!isSidebarCollapsed());
    });
  }

  window.addEventListener("resize", () => {
    if (isMobileViewport()) {
      layoutRoot?.classList.remove("sidebar-collapsed");
    } else {
      setMobileProjectsOpen(false);
      const saved = localStorage.getItem(STORAGE_SIDEBAR_COLLAPSED_KEY) === "1";
      applySidebarCollapsed(saved);
    }
    updateMobileProjectsButton();
  });
}

function initializeSidebarState() {
  const savedCollapsed = localStorage.getItem(STORAGE_SIDEBAR_COLLAPSED_KEY) === "1";
  applySidebarCollapsed(savedCollapsed);
  setMobileProjectsOpen(false);
  updateMobileProjectsButton();
}

loadUiState();
wireUiEvents();
initializeSidebarState();
renderMessageRows();

(async () => {
  setStatus("Loading sessions...");
  try {
    await refreshEverything();
  } catch (error) {
    setStatus(`Logs page initialization failed: ${error}`);
  }
})();
