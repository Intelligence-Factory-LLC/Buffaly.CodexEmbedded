(function () {
  const WORKSPACE_TASKS = "tasks";
  const WORKSPACE_CODE_REVIEWS = "code_reviews";
  const PAGE_LIST = "list";
  const PAGE_DETAIL = "detail";

  let workspaceMode = WORKSPACE_TASKS;
  let reviewPageMode = PAGE_LIST;

  function normalizeWorkspaceMode(mode) {
    return mode === WORKSPACE_CODE_REVIEWS ? WORKSPACE_CODE_REVIEWS : WORKSPACE_TASKS;
  }

  function normalizeReviewPageMode(mode) {
    return mode === PAGE_DETAIL ? PAGE_DETAIL : PAGE_LIST;
  }

  window.codexCodeReviewsBridge = {
    getWorkspaceMode() {
      return workspaceMode;
    },
    setWorkspaceMode(mode) {
      workspaceMode = normalizeWorkspaceMode(mode);
      if (workspaceMode !== WORKSPACE_CODE_REVIEWS) {
        reviewPageMode = PAGE_LIST;
      }
      return workspaceMode;
    },
    isCodeReviewsWorkspace() {
      return workspaceMode === WORKSPACE_CODE_REVIEWS;
    },
    getReviewPageMode() {
      return reviewPageMode;
    },
    setReviewPageMode(mode) {
      reviewPageMode = normalizeReviewPageMode(mode);
      return reviewPageMode;
    }
  };
})();
