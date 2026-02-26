const STORAGE_SIDEBAR_COLLAPSED_KEY = "codex.recap.sidebarCollapsed.v1";

const layoutRoot = document.querySelector(".layout");
const sidebarToggleBtn = document.getElementById("sidebarToggleBtn");
const mobileProjectsBtn = document.getElementById("mobileProjectsBtn");
const sidebarBackdrop = document.getElementById("sidebarBackdrop");

const recapStartDate = document.getElementById("recapStartDate");
const recapEndDate = document.getElementById("recapEndDate");
const recapDetailLevel = document.getElementById("recapDetailLevel");
const recapAllProjectsToggle = document.getElementById("recapAllProjectsToggle");
const recapProjectsSelect = document.getElementById("recapProjectsSelect");
const recapRefreshProjectsBtn = document.getElementById("recapRefreshProjectsBtn");
const recapGenerateBtn = document.getElementById("recapGenerateBtn");
const recapDownloadLink = document.getElementById("recapDownloadLink");
const recapBusyBadge = document.getElementById("recapBusyBadge");
const recapReadyBadge = document.getElementById("recapReadyBadge");
const recapStatus = document.getElementById("recapStatus");
const recapSummary = document.getElementById("recapSummary");
const recapPreview = document.getElementById("recapPreview");

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
  const busy = state === "busy";
  const ready = state === "ready";

  if (recapBusyBadge) {
    recapBusyBadge.classList.toggle("hidden", !busy);
  }
  if (recapReadyBadge) {
    recapReadyBadge.classList.toggle("hidden", !ready);
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
  if (!recapProjectsSelect) {
    return [];
  }

  return Array.from(recapProjectsSelect.selectedOptions)
    .map((option) => option.value)
    .filter((value) => !!value);
}

function setProjectSelectEnabled(enabled) {
  if (recapProjectsSelect) {
    recapProjectsSelect.disabled = !enabled;
  }
}

function formatProjectLabel(project) {
  const cwd = project?.cwd || "(unknown)";
  const sessions = Number(project?.sessionCount || 0);
  const updated = project?.lastUpdatedUtc
    ? new Date(project.lastUpdatedUtc).toLocaleString()
    : "unknown";
  return `${cwd} (${sessions} sessions, last ${updated})`;
}

async function loadProjects() {
  if (!recapProjectsSelect) {
    return;
  }

  setStatus("Loading projects...");
  recapProjectsSelect.textContent = "";

  try {
    const response = await fetch("api/recap/projects", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`failed loading projects (${response.status})`);
    }

    const data = await response.json();
    const projects = Array.isArray(data?.projects) ? data.projects : [];
    for (const project of projects) {
      const option = document.createElement("option");
      option.value = String(project?.cwd || "(unknown)");
      option.textContent = formatProjectLabel(project);
      recapProjectsSelect.appendChild(option);
    }

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
  setProjectSelectEnabled(!(recapAllProjectsToggle && recapAllProjectsToggle.checked));
  setExportState("idle");
  setPreview("No preview yet.");

  const savedCollapsed = localStorage.getItem(STORAGE_SIDEBAR_COLLAPSED_KEY) === "1";
  applySidebarCollapsed(savedCollapsed);
  setMobileNavigationOpen(false);
  wireEvents();

  await loadProjects();
}

void initializePage();
