const STORAGE_SIDEBAR_COLLAPSED_KEY = "codex.settings.sidebarCollapsed.v1";

const layoutRoot = document.querySelector(".layout");
const sidebarToggleBtn = document.getElementById("sidebarToggleBtn");
const mobileProjectsBtn = document.getElementById("mobileProjectsBtn");
const sidebarBackdrop = document.getElementById("sidebarBackdrop");

const themeModeToggle = document.getElementById("themeModeToggle");
const themeModeValue = document.getElementById("themeModeValue");

function isMobileViewport() {
  return window.matchMedia("(max-width: 900px)").matches;
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

  layoutRoot.classList.toggle("sidebar-collapsed", !!isCollapsed);
  localStorage.setItem(STORAGE_SIDEBAR_COLLAPSED_KEY, isCollapsed ? "1" : "0");
  updateMobileProjectsButton();
}

function getCurrentTheme() {
  if (window.CodexTheme && typeof window.CodexTheme.getTheme === "function") {
    return window.CodexTheme.getTheme();
  }

  const value = document.documentElement.getAttribute("data-theme");
  return value === "dark" ? "dark" : "light";
}

function setCurrentTheme(nextTheme) {
  if (window.CodexTheme && typeof window.CodexTheme.setTheme === "function") {
    return window.CodexTheme.setTheme(nextTheme);
  }

  const normalized = nextTheme === "dark" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", normalized);
  return normalized;
}

function refreshThemeModeUi() {
  const darkModeEnabled = getCurrentTheme() === "dark";
  if (themeModeToggle) {
    themeModeToggle.checked = darkModeEnabled;
  }
  if (themeModeValue) {
    themeModeValue.textContent = darkModeEnabled ? "Dark mode enabled" : "Light mode enabled";
  }
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

if (themeModeToggle) {
  themeModeToggle.addEventListener("change", () => {
    setCurrentTheme(themeModeToggle.checked ? "dark" : "light");
    refreshThemeModeUi();
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") {
    return;
  }

  if (isMobileProjectsOpen()) {
    event.preventDefault();
    setMobileProjectsOpen(false);
  }
});

window.addEventListener("resize", () => {
  if (!isMobileViewport()) {
    setMobileProjectsOpen(false);
  }
  updateMobileProjectsButton();
});

const sidebarCollapsed = localStorage.getItem(STORAGE_SIDEBAR_COLLAPSED_KEY) === "1";
applySidebarCollapsed(sidebarCollapsed);
setMobileProjectsOpen(false);
refreshThemeModeUi();
