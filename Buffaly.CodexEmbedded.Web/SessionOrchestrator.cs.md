# SessionOrchestrator.cs Change History

## Turn Boundary Repair For Truncated Timeline Windows (2026-03-28)
- Updated turn consolidation to start a new inferred turn when task context changes and non-user entries arrive without a captured user prompt.
- Added a synthetic user anchor entry text: `(turn prompt not present in current history window)` so timeline remains structurally accurate when older prompt rows are outside the loaded tail window.
- Design Decision: task context (`TaskId`) is a more reliable boundary than last-seen user message when the watch cache truncates history; this avoids attaching tool calls to the wrong prior user turn.
