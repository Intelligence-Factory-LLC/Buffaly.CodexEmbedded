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
const buildInfoLine = document.getElementById("buildInfoLine");
const codexAuthRefreshBtn = document.getElementById("codexAuthRefreshBtn");
const codexAuthStatus = document.getElementById("codexAuthStatus");
const codexAuthDetails = document.getElementById("codexAuthDetails");
const codexUsageStatus = document.getElementById("codexUsageStatus");
const codexUsageDetails = document.getElementById("codexUsageDetails");

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

function renderBuildInfo(payload) {
  if (!buildInfoLine) {
    return;
  }

  const buildNumber = payload && typeof payload.buildNumber === "string"
    ? payload.buildNumber.trim()
    : "";
  const buildTimestamp = payload && typeof payload.buildTimestampUtc === "string"
    ? payload.buildTimestampUtc.trim()
    : "";

  if (!buildNumber) {
    buildInfoLine.textContent = "Build: unavailable";
    return;
  }

  const updated = buildTimestamp ? formatUpdatedAt(buildTimestamp) : "";
  buildInfoLine.textContent = `Build: ${buildNumber}` + (updated ? ` (${updated})` : "");
}

function setCodexAuthUiBusy(isBusy) {
  if (codexAuthRefreshBtn) {
    codexAuthRefreshBtn.disabled = isBusy;
  }
}

function setCodexAuthStatusText(text, status = "") {
  if (!codexAuthStatus) {
    return;
  }

  codexAuthStatus.textContent = text || "";
  codexAuthStatus.classList.toggle("error", status === "error");
  codexAuthStatus.classList.toggle("success", status === "success");
}

function setCodexAuthDetailsText(text) {
  if (!codexAuthDetails) {
    return;
  }

  codexAuthDetails.textContent = text || "";
}

function setCodexUsageStatusText(text, status = "") {
  if (!codexUsageStatus) {
    return;
  }

  codexUsageStatus.textContent = text || "";
  codexUsageStatus.classList.toggle("error", status === "error");
  codexUsageStatus.classList.toggle("success", status === "success");
}

function setCodexUsageDetailsText(text) {
  if (!codexUsageDetails) {
    return;
  }

  codexUsageDetails.textContent = text || "";
}

function renderCodexAuthStatus(payload) {
  const hasIdentity = payload && payload.hasIdentity === true;
  const label = payload && typeof payload.label === "string" ? payload.label.trim() : "";
  const authMode = payload && typeof payload.authMode === "string" ? payload.authMode.trim() : "";
  const email = payload && typeof payload.email === "string" ? payload.email.trim() : "";
  const accountId = payload && typeof payload.accountId === "string" ? payload.accountId.trim() : "";
  const plan = payload && typeof payload.chatgptPlanType === "string" ? payload.chatgptPlanType.trim() : "";
  const lastRefresh = formatUpdatedAt(payload?.lastRefreshUtc);
  const fileUpdated = formatUpdatedAt(payload?.fileUpdatedAtUtc);
  const message = payload && typeof payload.message === "string" ? payload.message.trim() : "";
  const recommendation = payload && typeof payload.recommendation === "string" ? payload.recommendation.trim() : "";

  if (hasIdentity) {
    const display = label || email || accountId || "available";
    setCodexAuthStatusText(`Active account: ${display}`, "success");
  } else {
    setCodexAuthStatusText(message || "No active Codex account identity detected.", "error");
  }

  const details = [];
  if (authMode) details.push(`Mode: ${authMode}`);
  if (email) details.push(`Email: ${email}`);
  if (accountId) details.push(`Account ID: ${accountId}`);
  if (plan) details.push(`Plan: ${plan}`);
  if (lastRefresh) details.push(`Last refresh: ${lastRefresh}`);
  if (fileUpdated) details.push(`Auth file updated: ${fileUpdated}`);
  if (recommendation) details.push(recommendation);
  setCodexAuthDetailsText(details.join(" | "));
}

function formatUsageNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "";
  }

  if (Math.abs(numeric - Math.round(numeric)) < 0.0001) {
    return Math.round(numeric).toLocaleString();
  }

  return numeric.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function formatUsagePercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "";
  }

  if (Math.abs(numeric - Math.round(numeric)) < 0.05) {
    return `${Math.round(numeric)}%`;
  }

  return `${numeric.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

function formatUsageWindowLabel(windowMinutes, fallbackLabel) {
  const numeric = Number(windowMinutes);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallbackLabel;
  }

  const rounded = Math.round(numeric);
  if (Math.abs(rounded - 300) <= 1) {
    return "5h";
  }
  if (Math.abs(rounded - 10080) <= 1) {
    return "weekly";
  }
  if (rounded % 1440 === 0) {
    const days = rounded / 1440;
    return days === 1 ? "1d" : `${days}d`;
  }
  if (rounded % 60 === 0) {
    const hours = rounded / 60;
    return hours === 1 ? "1h" : `${hours}h`;
  }

  return rounded === 1 ? "1m" : `${rounded}m`;
}

function summarizeUsageWindow(windowPayload, fallbackLabel) {
  if (!windowPayload || typeof windowPayload !== "object") {
    return "";
  }

  const label = formatUsageWindowLabel(windowPayload.windowMinutes, fallbackLabel);
  let remainingPercent = formatUsagePercent(windowPayload.remainingPercent);
  const usedPercent = Number(windowPayload.usedPercent);
  if (!remainingPercent && Number.isFinite(usedPercent)) {
    remainingPercent = formatUsagePercent(Math.max(0, Math.min(100, 100 - usedPercent)));
  }

  if (remainingPercent) {
    return `${label} ${remainingPercent} remaining`;
  }

  const usedText = formatUsagePercent(windowPayload.usedPercent);
  if (usedText) {
    return `${label} ${usedText} used`;
  }

  return "";
}

function renderCodexUsageStatus(payload) {
  const hasUsage = payload && payload.hasUsage === true;
  const latest = payload && payload.latest && typeof payload.latest === "object" ? payload.latest : null;
  const message = payload && typeof payload.message === "string" ? payload.message.trim() : "";
  if (!hasUsage || !latest) {
    setCodexUsageStatusText(message || "Usage data unavailable.", "error");
    setCodexUsageDetailsText("No rate limit signal has been observed yet for any loaded session.");
    return;
  }

  const summary = typeof latest.summary === "string" ? latest.summary.trim() : "";
  const primarySummary = summarizeUsageWindow(latest.primary, "primary");
  const secondarySummary = summarizeUsageWindow(latest.secondary, "secondary");
  const rateWindowSummary = [primarySummary, secondarySummary].filter((x) => !!x);
  if (rateWindowSummary.length > 0) {
    setCodexUsageStatusText(`Usage: ${rateWindowSummary.join(" | ")}`, "success");
  } else if (summary) {
    setCodexUsageStatusText(`Usage: ${summary}`, "success");
  } else {
    const remaining = formatUsageNumber(latest.remaining);
    const limit = formatUsageNumber(latest.limit);
    const used = formatUsageNumber(latest.used);
    const pieces = [];
    if (remaining && limit) {
      pieces.push(`${remaining}/${limit} remaining`);
    } else if (remaining) {
      pieces.push(`${remaining} remaining`);
    }
    if (used) {
      pieces.push(`${used} used`);
    }

    setCodexUsageStatusText(
      pieces.length > 0 ? `Usage: ${pieces.join(" | ")}` : "Usage update received.",
      "success");
  }

  const details = [];
  const updated = formatUpdatedAt(latest.updatedAtUtc);
  const resetAt = formatUpdatedAt(latest.resetAtUtc);
  const primaryLabel = formatUsageWindowLabel(latest?.primary?.windowMinutes, "primary");
  const secondaryLabel = formatUsageWindowLabel(latest?.secondary?.windowMinutes, "secondary");
  const primaryResetAt = formatUpdatedAt(latest?.primary?.resetsAtUtc);
  const secondaryResetAt = formatUpdatedAt(latest?.secondary?.resetsAtUtc);
  const planType = typeof latest.planType === "string" ? latest.planType.trim() : "";
  const credits = latest && typeof latest.credits === "object" ? latest.credits : null;
  const quotaRemaining = formatUsageNumber(latest.remaining);
  const quotaLimit = formatUsageNumber(latest.limit);
  const quotaUsed = formatUsageNumber(latest.used);
  if (quotaRemaining && quotaLimit) details.push(`Quota: ${quotaRemaining}/${quotaLimit} remaining`);
  if (quotaUsed) details.push(`Used: ${quotaUsed}`);
  if (planType) details.push(`Plan: ${planType}`);
  if (credits) {
    const hasCredits = credits.hasCredits === true;
    const unlimited = credits.unlimited === true;
    const creditBalance = formatUsageNumber(credits.balance);
    if (unlimited) {
      details.push("Credits: unlimited");
    } else if (hasCredits && creditBalance) {
      details.push(`Credits balance: ${creditBalance}`);
    } else if (hasCredits) {
      details.push("Credits: available");
    } else if (credits.hasCredits === false) {
      details.push("Credits: none");
    }
  }
  if (primaryResetAt) details.push(`${primaryLabel} resets: ${primaryResetAt}`);
  if (secondaryResetAt) details.push(`${secondaryLabel} resets: ${secondaryResetAt}`);
  if (latest.sessionId) details.push(`Session: ${latest.sessionId}`);
  if (latest.threadId) details.push(`Thread: ${latest.threadId}`);
  if (latest.scope) details.push(`Scope: ${latest.scope}`);
  if (resetAt) details.push(`Resets: ${resetAt}`);
  if (updated) details.push(`Updated: ${updated}`);
  if (latest.source) details.push(`Source: ${latest.source}`);
  setCodexUsageDetailsText(details.join(" | "));
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

async function loadBuildInfo() {
  if (!buildInfoLine) {
    return;
  }

  try {
    const response = await fetch(new URL("api/security/config", document.baseURI), { cache: "no-store" });
    const payload = await readJsonOrThrow(response);
    renderBuildInfo(payload);
  } catch {
    buildInfoLine.textContent = "Build: unavailable";
  }
}

async function loadCodexAuthStatus() {
  if (!codexAuthStatus) {
    return;
  }

  setCodexAuthUiBusy(true);
  setCodexAuthStatusText("Checking Codex auth status...");
  setCodexAuthDetailsText("");
  try {
    const response = await fetch(new URL("api/settings/codex-auth/status", document.baseURI), { cache: "no-store" });
    const payload = await readJsonOrThrow(response);
    renderCodexAuthStatus(payload);
  } catch (error) {
    setCodexAuthStatusText(`Failed to load Codex auth status: ${error}`, "error");
    setCodexAuthDetailsText("");
  } finally {
    setCodexAuthUiBusy(false);
  }
}

async function loadCodexUsageStatus() {
  if (!codexUsageStatus) {
    return;
  }

  setCodexUsageStatusText("Checking usage status...");
  setCodexUsageDetailsText("");
  try {
    const response = await fetch(new URL("api/settings/codex-usage/status", document.baseURI), { cache: "no-store" });
    const payload = await readJsonOrThrow(response);
    renderCodexUsageStatus(payload);
  } catch (error) {
    setCodexUsageStatusText(`Failed to load usage status: ${error}`, "error");
    setCodexUsageDetailsText("");
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

function applyOpenAiKeyQueryHints() {
  const query = new URLSearchParams(window.location.search || "");
  if (query.get("focusOpenAiKey") !== "1") {
    return;
  }

  if (query.get("reason") === "voice") {
    setKeyStatusText("Speech-to-text requires an OpenAI API key. Add one below.", "error");
  }

  if (!openAiKeyInput) {
    return;
  }

  openAiKeyInput.focus();
  openAiKeyInput.select();
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

if (codexAuthRefreshBtn) {
  codexAuthRefreshBtn.addEventListener("click", () => {
    Promise.all([
      loadCodexAuthStatus(),
      loadCodexUsageStatus()
    ]).catch(() => {});
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
loadOpenAiKeyStatus()
  .catch((error) => setKeyStatusText(`Failed to load key status: ${error}`, "error"))
  .finally(() => applyOpenAiKeyQueryHints());
loadBuildInfo().catch(() => {});
loadCodexAuthStatus().catch((error) => {
  setCodexAuthStatusText(`Failed to load Codex auth status: ${error}`, "error");
  setCodexAuthDetailsText("");
});
loadCodexUsageStatus().catch((error) => {
  setCodexUsageStatusText(`Failed to load usage status: ${error}`, "error");
  setCodexUsageDetailsText("");
});
