(function () {
  const STORAGE_THEME_KEY = "codex-web-theme";
  const THEME_LIGHT = "light";
  const THEME_DARK = "dark";

  function normalizeTheme(value) {
    return value === THEME_DARK ? THEME_DARK : THEME_LIGHT;
  }

  function applyTheme(theme) {
    const nextTheme = normalizeTheme(theme);
    document.documentElement.setAttribute("data-theme", nextTheme);
    return nextTheme;
  }

  function getStoredTheme() {
    try {
      return normalizeTheme(localStorage.getItem(STORAGE_THEME_KEY) || THEME_LIGHT);
    } catch {
      return THEME_LIGHT;
    }
  }

  function getTheme() {
    const fromAttribute = document.documentElement.getAttribute("data-theme");
    if (fromAttribute === THEME_DARK || fromAttribute === THEME_LIGHT) {
      return fromAttribute;
    }

    return getStoredTheme();
  }

  function setTheme(theme) {
    const nextTheme = applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_THEME_KEY, nextTheme);
    } catch {
      // Ignore storage failures and keep the in-memory selection.
    }
    return nextTheme;
  }

  applyTheme(getStoredTheme());

  window.CodexTheme = {
    getTheme,
    setTheme
  };
})();
