# Release Notes - March 1, 2026

## New Features

This is a working draft for today's release notes and will be refined as additional changes land.

### Visual Studio Bridge and Editor Integration

Today's work significantly improves the hosted Visual Studio bridge experience and makes editor context part of the normal prompting flow.

- Added build APIs and build event handling to the hosted Visual Studio bridge.
- Added visual build notification receipt in the bridge UI.
- Added support for showing selected VS code in the composer and including that selection in prompts.
- Added file-link interception so matching links can open directly in the Visual Studio bridge.
- Improved VS selection refresh on focus and reduced stale indicator lag.
- Added a two-line code preview in the VS selection indicator.

### Reliability and Session Stability

The session pipeline was tightened so timeline and turn state stay consistent under higher activity.

- Stabilized timeline watch snapshots and reduced in-flight session churn.
- Treated empty full timeline snapshots as authoritative clears.
- Refactored session attachment and turn management logic to reduce state drift.
- Simplified turn submit routing and input plumbing.
- Simplified turn gate recovery and websocket session message handling.

### Refactors and Cleanup

A broad cleanup pass removed dead paths and reduced complexity in both server and web layers.

- Refactored `SessionOrchestrator` bootstrap flow for create and attach paths.
- Added event parser scaffolding and removed dead APIs and duplicate override paths.
- Refactored endpoint mappings and split shared `app.js` helpers.
- Pruned dead `app.js` helpers and removed unreachable timeline and recap branches.
- Removed a dead websocket session path in `Program.cs` and extracted shared helpers.

### Debuggability and Developer Experience

Bridge and runtime diagnostics are easier to inspect during development and troubleshooting.

- Added an in-page bridge debug panel toggle.
- Added bridge script source display and auto fingerprint output in the debug panel.

### Candidate Screenshots For This Draft

These are the best current screenshots to pair with this release draft:

- `../screenshots/diff-preview.png`
- `../screenshots/dictate.png`
- `../screenshots/recap.png`

