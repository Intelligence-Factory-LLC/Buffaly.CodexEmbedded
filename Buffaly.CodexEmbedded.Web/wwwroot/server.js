const POLL_INTERVAL_MS = 2000;

const STORAGE_SIDEBAR_COLLAPSED_KEY = "codex.server.sidebarCollapsed.v1";

const layoutRoot = document.querySelector(".layout");
const sessionSidebar = document.getElementById("sessionSidebar");
const sidebarToggleBtn = document.getElementById("sidebarToggleBtn");
const mobileProjectsBtn = document.getElementById("mobileProjectsBtn");
const sidebarBackdrop = document.getElementById("sidebarBackdrop");
const projectList = document.getElementById("projectList");

const serverStatus = document.getElementById("serverStatus");
const serverMeta = document.getElementById("serverMeta");
const serverSessionsBody = document.getElementById("serverSessionsBody");
const serverRawSnapshot = document.getElementById("serverRawSnapshot");
const serverRefreshBtn = document.getElementById("serverRefreshBtn");

let pollTimer = null;
let refreshInFlight = false;

function setStatus(text) {
  if (!serverStatus) {
    return;
  }

  serverStatus.textContent = text;
}

function normalizeString(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}

function getSessionThreadName(session) {
  return normalizeString(session && session.threadName);
}

function getSessionThreadId(session) {
  return normalizeString(session && session.threadId);
}

function getSessionDisplayName(session) {
  const threadName = getSessionThreadName(session);
  if (threadName) {
    return threadName;
  }

  const threadId = getSessionThreadId(session);
  if (threadId) {
    return threadId;
  }

  const sessionId = normalizeString(session && session.sessionId);
  return sessionId || "(unknown)";
}

function formatDate(value) {
  const text = normalizeString(value);
  if (!text) {
    return "-";
  }

  const tick = Date.parse(text);
  if (!Number.isFinite(tick)) {
    return text;
  }

  return new Date(tick).toLocaleString();
}

function formatNumber(value) {
  if (!Number.isFinite(value)) {
    return "0";
  }

  return String(value);
}

function formatDurationSeconds(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const hh = String(h).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function isMobileViewport() {
  return window.matchMedia("(max-width: 960px)").matches;
}

function isSidebarCollapsed() {
  return layoutRoot ? layoutRoot.classList.contains("sidebar-collapsed") : false;
}

function isMobileProjectsOpen() {
  return layoutRoot ? layoutRoot.classList.contains("mobile-projects-open") : false;
}

function updateMobileProjectsButton() {
  if (!mobileProjectsBtn || !layoutRoot) {
    return;
  }

  const mobile = isMobileViewport();
  const open = mobile && isMobileProjectsOpen();
  mobileProjectsBtn.classList.toggle("hidden", !mobile);
  mobileProjectsBtn.setAttribute("aria-expanded", open ? "true" : "false");
  mobileProjectsBtn.title = open ? "Hide projects" : "Show projects";
  mobileProjectsBtn.setAttribute("aria-label", mobileProjectsBtn.title);

  if (!sidebarToggleBtn) {
    return;
  }

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

function normalizePath(path) {
  const value = normalizeString(path);
  if (!value) {
    return "(unknown)";
  }

  const normalized = value.replace(/\\/g, "/").replace(/\/+$/g, "");
  return normalized || "(unknown)";
}

function getPathLeaf(path) {
  const normalized = normalizePath(path);
  if (!normalized || normalized === "(unknown)") {
    return "(unknown)";
  }

  const parts = normalized.split("/");
  return parts.length ? parts[parts.length - 1] : normalized;
}

function clearElement(element) {
  if (!element) {
    return;
  }

  element.textContent = "";
}

function createMetaChip(label, value) {
  const chip = document.createElement("div");
  chip.className = "server-meta-chip";

  const labelNode = document.createElement("span");
  labelNode.className = "server-meta-label";
  labelNode.textContent = label;

  const valueNode = document.createElement("span");
  valueNode.className = "server-meta-value";
  valueNode.textContent = value;

  chip.append(labelNode, valueNode);
  return chip;
}

function renderMeta(snapshot) {
  if (!serverMeta) {
    return;
  }

  clearElement(serverMeta);

  const totals = snapshot && snapshot.totals && typeof snapshot.totals === "object" ? snapshot.totals : {};
  const server = snapshot && snapshot.server && typeof snapshot.server === "object" ? snapshot.server : {};

  const chips = [
    createMetaChip("Active Projects", formatNumber(Number(totals.activeProjects || 0))),
    createMetaChip("Active Sessions", formatNumber(Number(totals.activeSessions || 0))),
    createMetaChip("Turns In Flight", formatNumber(Number(totals.turnsInFlight || 0))),
    createMetaChip("Pending Approvals", formatNumber(Number(totals.pendingApprovals || 0))),
    createMetaChip("Queued Messages", formatNumber(Number(totals.queuedMessages || 0))),
    createMetaChip("WS Connections", formatNumber(Number(server.activeWebSocketConnections || 0))),
    createMetaChip("WS Accepted Total", formatNumber(Number(server.totalWebSocketConnectionsAccepted || 0))),
    createMetaChip("Uptime", formatDurationSeconds(Number(server.uptimeSeconds || 0))),
    createMetaChip("Captured", formatDate(snapshot ? snapshot.capturedAtUtc : ""))
  ];

  for (const chip of chips) {
    serverMeta.appendChild(chip);
  }
}

function renderProjectSidebar(snapshot) {
  if (!projectList) {
    return;
  }

  clearElement(projectList);
  const projects = snapshot && Array.isArray(snapshot.projects) ? snapshot.projects : [];
  if (projects.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "No active projects in memory.";
    projectList.appendChild(empty);
    return;
  }

  for (const project of projects) {
    const wrap = document.createElement("div");
    wrap.className = "project-group";

    const header = document.createElement("div");
    header.className = "project-header";

    const titleWrap = document.createElement("div");
    titleWrap.className = "project-title-wrap";

    const name = document.createElement("div");
    name.className = "project-name";
    name.textContent = getPathLeaf(project.cwd || project.normalizedCwd || "");

    const path = document.createElement("div");
    path.className = "project-path";
    path.textContent = normalizePath(project.cwd || project.normalizedCwd || "");

    titleWrap.append(name, path);

    const badge = document.createElement("div");
    badge.className = "project-count";
    badge.textContent = String(Number(project.sessionCount || 0));

    header.append(titleWrap, badge);
    wrap.appendChild(header);

    const sessions = Array.isArray(project.sessions) ? project.sessions : [];
    for (const session of sessions) {
      const item = document.createElement("div");
      item.className = "session-item";

      const row = document.createElement("div");
      row.className = "session-item-row";
      row.textContent = getSessionDisplayName(session);
      row.title = `thread=${getSessionThreadId(session) || "unknown"} session=${normalizeString(session.sessionId) || "unknown"}`;

      const meta = document.createElement("div");
      meta.className = "session-item-meta";
      const state = normalizeString(session.state) || "unknown";
      const model = normalizeString(session.model) || "(default)";
      const effort = normalizeString(session.reasoningEffort) || "(default)";
      meta.textContent = `${state} | ${model} | ${effort} | thread=${getSessionThreadId(session) || "-"}`;

      item.append(row, meta);
      wrap.appendChild(item);
    }

    projectList.appendChild(wrap);
  }
}

function normalizeStateClass(state) {
  const value = normalizeString(state).toLowerCase();
  if (!value) {
    return "unknown";
  }

  return value.replace(/[^a-z0-9]+/g, "-");
}

function renderSessionsTable(snapshot) {
  if (!serverSessionsBody) {
    return;
  }

  clearElement(serverSessionsBody);
  const sessions = snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  if (sessions.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 10;
    cell.className = "server-table-empty";
    cell.textContent = "No active sessions are loaded in the server orchestrator.";
    row.appendChild(cell);
    serverSessionsBody.appendChild(row);
    return;
  }

  for (const session of sessions) {
    const row = document.createElement("tr");
    const state = normalizeString(session.state) || "unknown";
    const pendingApproval = session.pendingApproval && typeof session.pendingApproval === "object" ? session.pendingApproval : null;

    const stateCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `server-state-badge state-${normalizeStateClass(state)}`;
    badge.textContent = state;
    stateCell.appendChild(badge);

    const sessionCell = document.createElement("td");
    sessionCell.textContent = normalizeString(session.sessionId) || "-";

    const nameCell = document.createElement("td");
    nameCell.textContent = getSessionThreadName(session) || "-";

    const threadCell = document.createElement("td");
    threadCell.textContent = getSessionThreadId(session) || "-";

    const projectCell = document.createElement("td");
    projectCell.textContent = normalizePath(session.cwd || session.normalizedCwd || "");

    const modelCell = document.createElement("td");
    modelCell.textContent = normalizeString(session.model) || "(default)";

    const effortCell = document.createElement("td");
    effortCell.textContent = normalizeString(session.reasoningEffort) || "(default)";

    const inFlightCell = document.createElement("td");
    inFlightCell.textContent = session.isTurnInFlight === true ? "true" : "false";

    const queuedCell = document.createElement("td");
    queuedCell.textContent = formatNumber(Number(session.queuedTurnCount || 0));

    const approvalCell = document.createElement("td");
    approvalCell.textContent = pendingApproval ? normalizeString(pendingApproval.approvalId) || "(pending)" : "-";

    row.append(
      stateCell,
      sessionCell,
      nameCell,
      threadCell,
      projectCell,
      modelCell,
      effortCell,
      inFlightCell,
      queuedCell,
      approvalCell
    );

    serverSessionsBody.appendChild(row);
  }
}

function renderRawSnapshot(snapshot) {
  if (!serverRawSnapshot) {
    return;
  }

  if (!snapshot) {
    serverRawSnapshot.textContent = "";
    return;
  }

  serverRawSnapshot.textContent = JSON.stringify(snapshot, null, 2);
}

function applySnapshot(snapshot) {
  renderMeta(snapshot);
  renderProjectSidebar(snapshot);
  renderSessionsTable(snapshot);
  renderRawSnapshot(snapshot);

  const capturedAt = formatDate(snapshot ? snapshot.capturedAtUtc : "");
  setStatus(`Server snapshot loaded | Captured ${capturedAt} | Auto refresh every ${Math.floor(POLL_INTERVAL_MS / 1000)} seconds`);
}

async function refreshSnapshot() {
  if (refreshInFlight) {
    return;
  }

  refreshInFlight = true;
  try {
    const url = new URL("api/server/state/current", document.baseURI);
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`failed loading server state (${response.status}): ${detail}`);
    }

    const data = await response.json();
    applySnapshot(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Server state error: ${message}`);
  } finally {
    refreshInFlight = false;
  }
}

function startPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
  }

  pollTimer = setInterval(() => {
    refreshSnapshot().catch(() => {});
  }, POLL_INTERVAL_MS);
}

function wireUiEvents() {
  if (serverRefreshBtn) {
    serverRefreshBtn.addEventListener("click", () => {
      refreshSnapshot().catch(() => {});
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
      applySidebarCollapsed(localStorage.getItem(STORAGE_SIDEBAR_COLLAPSED_KEY) === "1");
    }
    updateMobileProjectsButton();
  });
}

function initializeSidebarState() {
  applySidebarCollapsed(localStorage.getItem(STORAGE_SIDEBAR_COLLAPSED_KEY) === "1");
  setMobileProjectsOpen(false);
  updateMobileProjectsButton();
}

wireUiEvents();
initializeSidebarState();
setStatus("Loading server state...");
refreshSnapshot().catch(() => {});
startPolling();
