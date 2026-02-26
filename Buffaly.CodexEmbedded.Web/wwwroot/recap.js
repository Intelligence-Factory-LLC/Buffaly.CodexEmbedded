const STORAGE_SIDEBAR_COLLAPSED_KEY = "codex.recap.sidebarCollapsed.v1";

const layoutRoot = document.querySelector(".layout");
const sidebarToggleBtn = document.getElementById("sidebarToggleBtn");
const mobileProjectsBtn = document.getElementById("mobileProjectsBtn");
const sidebarBackdrop = document.getElementById("sidebarBackdrop");

const recapStartDate = document.getElementById("recapStartDate");
const recapEndDate = document.getElementById("recapEndDate");
const recapDetailLevel = document.getElementById("recapDetailLevel");
const recapAllProjectsToggle = document.getElementById("recapAllProjectsToggle");
const recapProjectList = document.getElementById("recapProjectList");
const recapRefreshProjectsBtn = document.getElementById("recapRefreshProjectsBtn");
const recapReportsRootPath = document.getElementById("recapReportsRootPath");
const recapSaveReportsRootBtn = document.getElementById("recapSaveReportsRootBtn");
const recapUseDefaultReportsRootBtn = document.getElementById("recapUseDefaultReportsRootBtn");
const recapReportsRootMeta = document.getElementById("recapReportsRootMeta");
const recapReportsRootSidebar = document.getElementById("recapReportsRootSidebar");
const recapRefreshReportsBtn = document.getElementById("recapRefreshReportsBtn");
const recapReportsList = document.getElementById("recapReportsList");
const recapGenerateBtn = document.getElementById("recapGenerateBtn");
const recapDownloadLink = document.getElementById("recapDownloadLink");
const recapRunState = document.getElementById("recapRunState");
const recapRunStateIcon = document.getElementById("recapRunStateIcon");
const recapRunStateText = document.getElementById("recapRunStateText");
const recapStatus = document.getElementById("recapStatus");
const recapSummary = document.getElementById("recapSummary");
const recapPreview = document.getElementById("recapPreview");
let recapReports = [];
let activeReportFileName = "";
let recapSettings = null;

function setStatus(text) {
  if (recapStatus) {
    recapStatus.textContent = text || "";
  }
}

function setSummary(text) {
  if (recapSummary) {
    recapSummary.textContent = text || "";
  }
}

function setPreview(text) {
  if (recapPreview) {
    recapPreview.textContent = text || "";
  }
}

function setExportState(state) {
  if (!recapRunState) {
    return;
  }

  recapRunState.classList.remove("idle", "busy", "ready");
  recapRunState.classList.add(state);

  if (recapRunStateText) {
    recapRunStateText.textContent = state === "busy"
      ? "Exporting"
      : (state === "ready" ? "Ready" : "Idle");
  }

  if (recapRunStateIcon) {
    recapRunStateIcon.className = "bi";
    if (state === "busy") {
      recapRunStateIcon.classList.add("bi-arrow-repeat", "recap-spin");
      return;
    }

    if (state === "ready") {
      recapRunStateIcon.classList.add("bi-check-circle");
      return;
    }

    recapRunStateIcon.classList.add("bi-hourglass-split");
  }
}

function todayIsoDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toUtcRange(startDateValue, endDateValue) {
  const startLocal = new Date(`${startDateValue}T00:00:00`);
  const endLocal = new Date(`${endDateValue}T23:59:59.999`);
  return {
    startUtc: startLocal.toISOString(),
    endUtc: endLocal.toISOString()
  };
}

function getSelectedProjects() {
  if (!recapProjectList) {
    return [];
  }

  return Array.from(recapProjectList.querySelectorAll('input[type="checkbox"][data-cwd]:checked'))
    .map((input) => input.getAttribute("data-cwd") || "")
    .filter((value) => !!value);
}

function setProjectSelectEnabled(enabled) {
  if (!recapProjectList) {
    return;
  }

  const allowSelection = !!enabled;
  for (const input of recapProjectList.querySelectorAll('input[type="checkbox"][data-cwd]')) {
    input.disabled = !allowSelection;
  }
  for (const node of recapProjectList.querySelectorAll(".recap-project-option")) {
    node.classList.toggle("recap-project-option-disabled", !allowSelection);
  }
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${Math.max(0, Math.floor(bytes))} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function setReportsRootSidebarPath(pathValue) {
  if (!recapReportsRootSidebar) {
    return;
  }

  const pathText = typeof pathValue === "string" && pathValue.trim()
    ? pathValue.trim()
    : "(unknown)";
  recapReportsRootSidebar.textContent = `Reports folder: ${pathText}`;
}

function applyRecapSettings(settings) {
  recapSettings = settings && typeof settings === "object" ? settings : null;
  const effectiveRoot = recapSettings && typeof recapSettings.reportsRootPath === "string"
    ? recapSettings.reportsRootPath
    : "";
  const defaultRoot = recapSettings && typeof recapSettings.defaultReportsRootPath === "string"
    ? recapSettings.defaultReportsRootPath
    : "";
  const usingDefault = recapSettings ? recapSettings.isDefault === true : false;

  if (recapReportsRootPath) {
    recapReportsRootPath.value = effectiveRoot || "";
  }

  if (recapReportsRootMeta) {
    if (!recapSettings) {
      recapReportsRootMeta.textContent = "Report location unavailable.";
    } else {
      const sourceText = usingDefault ? "Using default location." : "Using custom location.";
      recapReportsRootMeta.textContent = `${sourceText} Default: ${defaultRoot || "(unknown)"}`;
    }
  }

  setReportsRootSidebarPath(effectiveRoot);
}

function setReportsRootButtonsDisabled(isDisabled) {
  const disabled = !!isDisabled;
  if (recapSaveReportsRootBtn) {
    recapSaveReportsRootBtn.disabled = disabled;
  }
  if (recapUseDefaultReportsRootBtn) {
    recapUseDefaultReportsRootBtn.disabled = disabled;
  }
  if (recapReportsRootPath) {
    recapReportsRootPath.disabled = disabled;
  }
}

async function loadRecapSettings() {
  try {
    const response = await fetch("api/settings/recap", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`failed loading recap settings (${response.status})`);
    }

    const payload = await response.json();
    applyRecapSettings(payload);
  } catch (error) {
    applyRecapSettings(null);
    setStatus(String(error));
  }
}

async function saveRecapSettings(options = {}) {
  const useDefault = options.useDefault === true;
  const reportsRootPath = useDefault
    ? ""
    : (recapReportsRootPath ? recapReportsRootPath.value.trim() : "");

  setReportsRootButtonsDisabled(true);
  try {
    const response = await fetch("api/settings/recap", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reportsRootPath,
        useDefault
      })
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`failed saving recap settings (${response.status}): ${detail}`);
    }

    const payload = await response.json();
    applyRecapSettings(payload);
    setStatus("Recap report location saved.");
    await loadReports({ preserveSelection: true });
  } catch (error) {
    setStatus(String(error));
  } finally {
    setReportsRootButtonsDisabled(false);
  }
}

function renderReportsList() {
  if (!recapReportsList) {
    return;
  }

  recapReportsList.textContent = "";
  if (!Array.isArray(recapReports) || recapReports.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "No recap reports yet.";
    recapReportsList.appendChild(empty);
    return;
  }

  for (const report of recapReports) {
    const fileName = String(report?.fileName || "");
    if (!fileName) {
      continue;
    }

    const row = document.createElement("div");
    row.className = "session-row";
    if (fileName === activeReportFileName) {
      row.classList.add("active");
    }

    const head = document.createElement("div");
    head.className = "session-row-head";

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "session-open-btn";
    openBtn.title = fileName;

    const title = document.createElement("div");
    title.className = "session-title";
    title.textContent = fileName;
    openBtn.appendChild(title);

    const subtitle = document.createElement("div");
    subtitle.className = "session-subtitle";
    const updated = report?.lastWriteUtc ? new Date(report.lastWriteUtc).toLocaleString() : "unknown";
    subtitle.textContent = `${updated} | ${formatBytes(report?.sizeBytes)}`;
    openBtn.appendChild(subtitle);
    openBtn.addEventListener("click", () => {
      activeReportFileName = fileName;
      renderReportsList();
      if (recapDownloadLink && typeof report?.downloadUrl === "string" && report.downloadUrl.trim()) {
        recapDownloadLink.href = report.downloadUrl;
        recapDownloadLink.textContent = `Download ${fileName}`;
        recapDownloadLink.classList.remove("hidden");
      }
      setSummary([
        `Created: ${fileName}`,
        `Path: ${report?.filePath || "(unknown)"}`,
        `Updated: ${updated}`,
        `Size: ${formatBytes(report?.sizeBytes)}`
      ].join("\n"));
    });
    head.appendChild(openBtn);

    const actions = document.createElement("div");
    actions.className = "project-actions";
    if (typeof report?.downloadUrl === "string" && report.downloadUrl.trim()) {
      const downloadBtn = document.createElement("button");
      downloadBtn.type = "button";
      downloadBtn.className = "icon-btn";
      downloadBtn.title = "Download report";
      downloadBtn.setAttribute("aria-label", "Download report");
      const icon = document.createElement("i");
      icon.className = "bi bi-download";
      icon.setAttribute("aria-hidden", "true");
      downloadBtn.appendChild(icon);
      downloadBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        const anchor = document.createElement("a");
        anchor.href = report.downloadUrl;
        anchor.download = fileName;
        anchor.click();
      });
      actions.appendChild(downloadBtn);
    }
    head.appendChild(actions);

    row.appendChild(head);
    recapReportsList.appendChild(row);
  }
}

async function loadReports(options = {}) {
  if (!recapReportsList) {
    return;
  }

  const preserveSelection = options.preserveSelection !== false;
  const previous = activeReportFileName;
  try {
    const response = await fetch("api/recap/reports?limit=500", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`failed loading reports (${response.status})`);
    }

    const data = await response.json();
    if (typeof data?.reportsRoot === "string" && data.reportsRoot.trim()) {
      setReportsRootSidebarPath(data.reportsRoot);
    }
    recapReports = Array.isArray(data?.reports) ? data.reports : [];
    if (preserveSelection && previous && recapReports.some((x) => String(x?.fileName || "") === previous)) {
      activeReportFileName = previous;
    } else {
      activeReportFileName = recapReports.length > 0 ? String(recapReports[0]?.fileName || "") : "";
    }
    renderReportsList();
  } catch {
    recapReports = [];
    activeReportFileName = "";
    renderReportsList();
  }
}

function formatProjectLabel(project, options = {}) {
  const includeCwd = options.includeCwd !== false;
  const cwd = project?.cwd || "(unknown)";
  const sessions = Number(project?.sessionCount || 0);
  const updated = project?.lastUpdatedUtc
    ? new Date(project.lastUpdatedUtc).toLocaleString()
    : "unknown";
  if (!includeCwd) {
    return `${sessions} sessions, last ${updated}`;
  }
  return `${cwd} (${sessions} sessions, last ${updated})`;
}

async function loadProjects() {
  if (!recapProjectList) {
    return;
  }

  setStatus("Loading projects...");
  const previousSelection = new Set(getSelectedProjects());
  recapProjectList.textContent = "";

  try {
    const response = await fetch("api/recap/projects", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`failed loading projects (${response.status})`);
    }

    const data = await response.json();
    const projects = Array.isArray(data?.projects) ? data.projects : [];
    if (projects.length === 0) {
      const empty = document.createElement("div");
      empty.className = "sidebar-empty";
      empty.textContent = "No projects found.";
      recapProjectList.appendChild(empty);
      setStatus(`Loaded 0 projects from ${data?.codexHomePath || "Codex home"}.`);
      return;
    }

    for (const project of projects) {
      const cwd = String(project?.cwd || "(unknown)");
      const row = document.createElement("div");
      row.className = "session-row";

      const head = document.createElement("div");
      head.className = "session-row-head";

      const option = document.createElement("label");
      option.className = "recap-project-option session-open-btn";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.setAttribute("data-cwd", cwd);
      checkbox.checked = previousSelection.has(cwd);
      option.appendChild(checkbox);

      const body = document.createElement("div");
      body.className = "recap-project-option-body";
      const title = document.createElement("div");
      title.className = "session-title";
      title.textContent = cwd;
      body.appendChild(title);
      const subtitle = document.createElement("div");
      subtitle.className = "session-subtitle";
      subtitle.textContent = formatProjectLabel(project, { includeCwd: false });
      body.appendChild(subtitle);
      option.appendChild(body);

      head.appendChild(option);
      row.appendChild(head);
      recapProjectList.appendChild(row);
    }

    setProjectSelectEnabled(!(recapAllProjectsToggle && recapAllProjectsToggle.checked));
    setStatus(`Loaded ${projects.length} projects from ${data?.codexHomePath || "Codex home"}.`);
  } catch (error) {
    setStatus(String(error));
  }
}

async function generateMarkdownExport() {
  const startDateValue = recapStartDate ? recapStartDate.value : "";
  const endDateValue = recapEndDate ? recapEndDate.value : "";
  if (!startDateValue || !endDateValue) {
    setStatus("Start date and end date are required.");
    return;
  }

  if (endDateValue < startDateValue) {
    setStatus("End date must be on or after start date.");
    return;
  }

  const range = toUtcRange(startDateValue, endDateValue);
  const useAllProjects = !recapAllProjectsToggle || recapAllProjectsToggle.checked;
  const projects = useAllProjects ? [] : getSelectedProjects();
  if (!useAllProjects && projects.length === 0) {
    setStatus("Select at least one project or enable All projects.");
    return;
  }

  const detailLevel = recapDetailLevel ? recapDetailLevel.value : "messages";
  const payload = {
    startUtc: range.startUtc,
    endUtc: range.endUtc,
    projects,
    detailLevel
  };

  setStatus("Generating markdown report...");
  setExportState("busy");
  if (recapGenerateBtn) {
    recapGenerateBtn.disabled = true;
  }
  if (recapDownloadLink) {
    recapDownloadLink.classList.add("hidden");
    recapDownloadLink.removeAttribute("href");
  }
  setPreview("Generating preview...");

  try {
    const response = await fetch("api/recap/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`export failed (${response.status}): ${detail}`);
    }

    const result = await response.json();
    const summary = [
      `Created: ${result.fileName || "(unknown)"}`,
      `Path: ${result.filePath || "(unknown)"}`,
      `Projects: ${Number(result.projectCount || 0)}`,
      `Sessions: ${Number(result.sessionCount || 0)}`,
      `Entries: ${Number(result.entryCount || 0)}`,
      `Preview bytes: ${Number(result.previewBytes || 0)}`,
      `Total bytes: ${Number(result.totalBytes || 0)}`,
      `Preview truncated: ${result.previewTruncated === true ? "yes" : "no"}`
    ].join("\n");
    setSummary(summary);
    setStatus("Markdown export created.");
    setExportState("ready");

    if (recapDownloadLink && typeof result.downloadUrl === "string" && result.downloadUrl.trim()) {
      recapDownloadLink.href = result.downloadUrl;
      recapDownloadLink.textContent = `Download ${result.fileName || "report.md"}`;
      recapDownloadLink.classList.remove("hidden");
    }

    const previewText = typeof result.previewMarkdown === "string"
      ? result.previewMarkdown
      : "(No preview returned)";
    setPreview(previewText || "(Preview is empty)");
    activeReportFileName = String(result.fileName || "");
    await loadReports({ preserveSelection: true });
  } catch (error) {
    setStatus(String(error));
    setPreview(`Failed to generate preview.\n\n${String(error)}`);
    setExportState("idle");
  } finally {
    if (recapGenerateBtn) {
      recapGenerateBtn.disabled = false;
    }
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
  if (recapRefreshProjectsBtn) {
    recapRefreshProjectsBtn.addEventListener("click", () => {
      void loadProjects();
    });
  }

  if (recapRefreshReportsBtn) {
    recapRefreshReportsBtn.addEventListener("click", () => {
      void loadReports({ preserveSelection: true });
    });
  }

  if (recapSaveReportsRootBtn) {
    recapSaveReportsRootBtn.addEventListener("click", () => {
      void saveRecapSettings({ useDefault: false });
    });
  }

  if (recapUseDefaultReportsRootBtn) {
    recapUseDefaultReportsRootBtn.addEventListener("click", () => {
      void saveRecapSettings({ useDefault: true });
    });
  }

  if (recapReportsRootPath) {
    recapReportsRootPath.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      void saveRecapSettings({ useDefault: false });
    });
  }

  if (recapGenerateBtn) {
    recapGenerateBtn.addEventListener("click", () => {
      void generateMarkdownExport();
    });
  }

  if (recapAllProjectsToggle) {
    recapAllProjectsToggle.addEventListener("change", () => {
      setProjectSelectEnabled(!recapAllProjectsToggle.checked);
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
  const today = todayIsoDate();
  if (recapStartDate && !recapStartDate.value) {
    recapStartDate.value = today;
  }
  if (recapEndDate && !recapEndDate.value) {
    recapEndDate.value = today;
  }
  setExportState("idle");
  setPreview("No preview yet.");

  const savedCollapsed = localStorage.getItem(STORAGE_SIDEBAR_COLLAPSED_KEY) === "1";
  applySidebarCollapsed(savedCollapsed);
  setMobileNavigationOpen(false);
  wireEvents();

  await loadRecapSettings();
  await loadProjects();
  await loadReports({ preserveSelection: false });
}

void initializePage();
