# Program.cs Change History

## Initial Web CLI Bridge (2026-02-18)
- Implemented an ASP.NET Core web app with a `/ws` endpoint that wraps `codex app-server` communication per browser connection.
- Added session lifecycle commands (`start_session`, `prompt`, `approval_response`, `stop_session`) and mapped server events for assistant deltas, approvals, turn completion, and errors.
- Added per-session server-side logging to local files and streamed log events to a dedicated log panel in the browser.
- Design: keep the web transport simple (single websocket) while preserving codex JSON-RPC behavior and approval flow.
