# Buffaly.CodexEmbedded

## Overview
This repository hosts a Codex App-Server harness plus a multi-session web UI.
Primary goals are stable Codex protocol integration, reliable session and thread state, and fast UI feedback for long-running tasks.

## Solution Map
- `Buffaly.CodexEmbedded.Core`: shared runtime and session abstractions plus catalog helpers.
- `Buffaly.CodexEmbedded.Web`: web host, websocket session bridge, and browser UI.
- `Buffaly.CodexEmbedded.Cli`: CLI harness for direct protocol testing.
- `documentation/`: protocol notes, specs, and JSON schema references.

## Key Runtime Behaviors
- Web client and websocket server must stay in sync for visible session state: `sessionId`, `threadId`, `cwd`, `model`, and turn-in-flight.
- Session model is per-thread/per-session state. UI model changes must update both client state and server managed session state.
- Timeline may hide noisy transport lines (`turn_context`, etc.), but important metadata should still be surfaced in concise UI summaries.

## Development Commands
- JS syntax check: `node --check Buffaly.CodexEmbedded.Web/wwwroot/app.js`
- Timeline syntax check: `node --check Buffaly.CodexEmbedded.Web/wwwroot/sessionTimeline.js`
- Web build (safe when app is running): `dotnet build Buffaly.CodexEmbedded.Web/Buffaly.CodexEmbedded.Web.csproj -p:BaseOutputPath=artifacts/build/`
- Full solution build (when files are not locked): `dotnet build`

## UI / Websocket Guardrails
- Prefer immediate visual responsiveness:
- Select session row before attach completes.
- Show loading and processing badges while awaiting state.
- Persist per-thread UI state in localStorage with explicit versioned keys.
- Keep polling idempotent. Incoming `session_list` and `session_catalog` should reconcile state, not clobber in-progress user intent.
- For new client->server websocket actions, add:
- Message case in `MultiSessionWebCliSocketSession`.
- Status/error logging.
- Session list refresh if sidebar/header-visible state changed.

## Source Control Workflow
- Commit changes after every significant group of updates.
- Commit current work before making any major change.
- Commit current work before starting a new task.
- Keep commits focused and use clear commit messages that describe the scope of grouped updates.
- Do not mix unrelated refactors in the same checkpoint commit.
- If a feature touches UI and websocket protocol, complete both sides before checkpointing.

## Done Criteria
- Relevant JS files pass `node --check`.
- Web project builds successfully (use `BaseOutputPath=artifacts/build/` when `bin/Debug` is locked).
- No obvious regressions in:
- Session attach/select behavior.
- Per-session model selection persistence.
- Queue/send/cancel controls.
- Timeline task start/complete rendering.

## Writing Rule
- Never use em dash or en dash characters in any repository text.
- Use the plain ASCII hyphen-minus (`-`) instead.
