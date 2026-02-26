const STORAGE_SIDEBAR_COLLAPSED_KEY = "codex.settings.sidebarCollapsed.v1";
const STORAGE_RENDER_ASSISTANT_MARKDOWN_KEY = "codex.settings.renderAssistantMarkdown.v1";

const layoutRoot = document.querySelector(".layout");
const sidebarToggleBtn = document.getElementById("sidebarToggleBtn");
const mobileProjectsBtn = document.getElementById("mobileProjectsBtn");
const sidebarBackdrop = document.getElementById("sidebarBackdrop");

const themeModeToggle = document.getElementById("themeModeToggle");
const themeModeValue = document.getElementById("themeModeValue");
const assistantMarkdownToggle = document.getElementById("assistantMarkdownToggle");
const assistantMarkdownValue = document.getElementById("assistantMarkdownValue");

const openAiKeyInput = document.getElementById("openAiKeyInput");
const openAiKeySaveBtn = document.getElementById("openAiKeySaveBtn");
const openAiKeyClearBtn = document.getElementById("openAiKeyClearBtn");
const openAiKeyStatus = document.getElementById("openAiKeyStatus");

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

function isAssistantMarkdownEnabled() {
  try {
    const stored = localStorage.getItem(STORAGE_RENDER_ASSISTANT_MARKDOWN_KEY);
    if (stored === null) {
      return true;
    }

    return stored === "1";
  } catch {
    return true;
  }
}

function setAssistantMarkdownEnabled(enabled) {
  try {
    localStorage.setItem(STORAGE_RENDER_ASSISTANT_MARKDOWN_KEY, enabled ? "1" : "0");
  } catch {
    // no-op
  }
}

function refreshAssistantMarkdownUi() {
  const enabled = isAssistantMarkdownEnabled();
  if (assistantMarkdownToggle) {
    assistantMarkdownToggle.checked = enabled;
  }
  if (assistantMarkdownValue) {
    assistantMarkdownValue.textContent = enabled
      ? "Assistant Markdown rendering enabled"
      : "Assistant Markdown rendering disabled";
  }
}

function setKeyUiBusy(isBusy) {
  if (openAiKeyInput) {
    openAiKeyInput.disabled = isBusy;
  }
  if (openAiKeySaveBtn) {
    openAiKeySaveBtn.disabled = isBusy;
  }
  if (openAiKeyClearBtn) {
    openAiKeyClearBtn.disabled = isBusy;
  }
}

function setKeyStatusText(text, status = "") {
  if (!openAiKeyStatus) {
    return;
  }

  openAiKeyStatus.textContent = text || "";
  openAiKeyStatus.classList.toggle("error", status === "error");
  openAiKeyStatus.classList.toggle("success", status === "success");
}

function formatUpdatedAt(value) {
  if (!value || typeof value !== "string") {
    return "";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  return parsed.toLocaleString();
}

function renderKeyStatus(payload, prefix = "") {
  const hasKey = payload && payload.hasKey === true;
  if (!hasKey) {
    setKeyStatusText(prefix ? `${prefix} No key saved.` : "No key saved.");
    return;
  }

  const hint = typeof payload.maskedKeyHint === "string" ? payload.maskedKeyHint : "****";
  const updated = formatUpdatedAt(payload.updatedAtUtc);
  const details = updated ? ` Updated ${updated}.` : "";
  const start = prefix ? `${prefix} ` : "";
  setKeyStatusText(`${start}Saved key: ${hint}.${details}`, prefix ? "success" : "");
}

async function readJsonOrThrow(response) {
  if (response.ok) {
    return response.json();
  }

  let message = `HTTP ${response.status}`;
  try {
    const text = (await response.text()).trim();
    if (text) {
      message = text;
    }
  } catch {
  }

  throw new Error(message);
}

async function loadOpenAiKeyStatus() {
  if (!openAiKeyStatus) {
    return;
  }

  setKeyStatusText("Checking key status...");
  try {
    const response = await fetch(new URL("api/settings/openai-key/status", document.baseURI), { cache: "no-store" });
    const payload = await readJsonOrThrow(response);
    renderKeyStatus(payload);
  } catch (error) {
    setKeyStatusText(`Failed to load key status: ${error}`, "error");
  }
}

async function saveOpenAiKey() {
  if (!openAiKeyInput) {
    return;
  }

  const apiKey = openAiKeyInput.value.trim();
  if (!apiKey) {
    setKeyStatusText("Enter an OpenAI key before saving.", "error");
    openAiKeyInput.focus();
    return;
  }

  setKeyUiBusy(true);
  setKeyStatusText("Saving key...");
  try {
    const response = await fetch(new URL("api/settings/openai-key", document.baseURI), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey })
    });
    const payload = await readJsonOrThrow(response);
    openAiKeyInput.value = "";
    renderKeyStatus(payload, "Key saved.");
  } catch (error) {
    setKeyStatusText(`Failed to save key: ${error}`, "error");
  } finally {
    setKeyUiBusy(false);
  }
}

async function clearOpenAiKey() {
  setKeyUiBusy(true);
  setKeyStatusText("Clearing key...");
  try {
    const response = await fetch(new URL("api/settings/openai-key", document.baseURI), { method: "DELETE" });
    await readJsonOrThrow(response);
    if (openAiKeyInput) {
      openAiKeyInput.value = "";
    }
    setKeyStatusText("Key cleared.", "success");
  } catch (error) {
    setKeyStatusText(`Failed to clear key: ${error}`, "error");
  } finally {
    setKeyUiBusy(false);
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

if (assistantMarkdownToggle) {
  assistantMarkdownToggle.addEventListener("change", () => {
    setAssistantMarkdownEnabled(assistantMarkdownToggle.checked);
    refreshAssistantMarkdownUi();
  });
}

if (openAiKeySaveBtn) {
  openAiKeySaveBtn.addEventListener("click", () => {
    saveOpenAiKey().catch((error) => setKeyStatusText(`Failed to save key: ${error}`, "error"));
  });
}

if (openAiKeyClearBtn) {
  openAiKeyClearBtn.addEventListener("click", () => {
    clearOpenAiKey().catch((error) => setKeyStatusText(`Failed to clear key: ${error}`, "error"));
  });
}

if (openAiKeyInput) {
  openAiKeyInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      saveOpenAiKey().catch((error) => setKeyStatusText(`Failed to save key: ${error}`, "error"));
    }
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
refreshAssistantMarkdownUi();
loadOpenAiKeyStatus().catch((error) => setKeyStatusText(`Failed to load key status: ${error}`, "error"));
