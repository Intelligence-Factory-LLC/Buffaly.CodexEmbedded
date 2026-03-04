const POLL_INTERVAL_MS = 2000;
const FLUSH_INTERVAL_MS = 350;
const SESSION_LIST_REFRESH_MS = 15000;

const STORAGE_SELECTED_THREAD_KEY = "codex.watcher.selectedThread.v1";
const STORAGE_SELECTED_PROJECT_KEY = "codex.watcher.selectedProject.v1";
const STORAGE_COLLAPSED_PROJECTS_KEY = "codex.watcher.collapsedProjects.v1";
const STORAGE_SIDEBAR_COLLAPSED_KEY = "codex.watcher.sidebarCollapsed.v1";

const layoutRoot = document.querySelector(".layout");
const sessionSidebar = document.getElementById("sessionSidebar");
const sidebarToggleBtn = document.getElementById("sidebarToggleBtn");
const mobileProjectsBtn = document.getElementById("mobileProjectsBtn");
const sidebarBackdrop = document.getElementById("sidebarBackdrop");
const projectList = document.getElementById("projectList");

const watcherStatus = document.getElementById("watcherStatus");
const watcherTimeline = document.getElementById("watcherTimeline");

const timeline = new window.CodexSessionTimeline({
  container: watcherTimeline,
  maxRenderedEntries: 1500,
  systemTitle: "Watcher"
});

let sessions = [];
let projectGroups = [];
let sessionsByProjectKey = new Map();

let activeProjectKey = null;
let activeThreadId = null;
let collapsedProjectKeys = new Set();

let cursor = null;
let flushTimer = null;
let pollTimer = null;
let sessionRefreshTimer = null;
let pollGeneration = 0;
let pollInFlight = false;

function setStatus(text) {
  if (!watcherStatus) {
    return;
  }

  watcherStatus.textContent = text;
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
          cursor = null;
          timeline.clear();
          restartPolling();
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

async function pollOnce(initial, generation) {
  if (pollInFlight) {
    return;
  }

  pollInFlight = true;
  try {
    if (!activeThreadId) {
      setStatus("Watcher (Disk): select a session to monitor its on-disk logs.");
      return;
    }

    const url = new URL("api/logs/watch", document.baseURI);
    url.searchParams.set("threadId", activeThreadId);
    url.searchParams.set("maxLines", "200");
    if (initial || cursor === null) {
      url.searchParams.set("initial", "true");
    } else {
      url.searchParams.set("cursor", String(cursor));
    }

    const response = await fetch(url, { cache: "no-store" });
    if (generation !== pollGeneration) {
      return;
    }

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`watch failed (${response.status}): ${detail}`);
    }

    const data = await response.json();
    if (generation !== pollGeneration) {
      return;
    }

    if (initial || data.reset === true) {
      timeline.clear();
      if (data.reset === true) {
        timeline.enqueueSystem("session file was reset or rotated");
      }
    }

    cursor = typeof data.nextCursor === "number" ? data.nextCursor : cursor;
    timeline.enqueueParsedLines(Array.isArray(data.lines) ? data.lines : []);

    if (data.truncated === true) {
      timeline.enqueueInlineNotice("older lines are omitted, showing latest lines");
    }

    const label = pollContextLabel();
    setStatus(`Watcher (Disk): ${label || "(unknown)"} | update every 2 seconds`);
  } finally {
    pollInFlight = false;
  }
}

function restartPolling() {
  pollGeneration += 1;
  const generation = pollGeneration;

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  pollOnce(true, generation).catch((error) => {
    timeline.enqueueSystem(`[error] ${error}`);
    setStatus("Watcher error.");
  });

  pollTimer = setInterval(() => {
    pollOnce(false, generation).catch((error) => {
      timeline.enqueueSystem(`[error] ${error}`);
      setStatus("Watcher error.");
    });
  }, POLL_INTERVAL_MS);
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

function startBackgroundRefresh() {
  if (sessionRefreshTimer) {
    clearInterval(sessionRefreshTimer);
    sessionRefreshTimer = null;
  }

  sessionRefreshTimer = setInterval(() => {
    refreshSessionList().catch((error) => {
      timeline.enqueueSystem(`[error] ${error}`);
    });
  }, SESSION_LIST_REFRESH_MS);
}

function initializeSidebarState() {
  const savedCollapsed = localStorage.getItem(STORAGE_SIDEBAR_COLLAPSED_KEY) === "1";
  applySidebarCollapsed(savedCollapsed);
  setMobileProjectsOpen(false);
  updateMobileProjectsButton();
}

flushTimer = setInterval(() => timeline.flush(), FLUSH_INTERVAL_MS);
loadUiState();
wireUiEvents();
initializeSidebarState();

(async () => {
  setStatus("Loading recent sessions...");
  try {
    await refreshSessionList();
    restartPolling();
    startBackgroundRefresh();
  } catch (error) {
    timeline.enqueueSystem(`[error] ${error}`);
    setStatus("Watcher initialization failed.");
  }
})();
