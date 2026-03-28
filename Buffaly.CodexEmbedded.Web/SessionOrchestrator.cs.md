# SessionOrchestrator.cs Change History

## Turn Boundary Repair For Truncated Timeline Windows (2026-03-28)
- Updated turn consolidation to start a new inferred turn when task context changes and non-user entries arrive without a captured user prompt.
- Added a synthetic user anchor entry text: `(turn prompt not present in current history window)` so timeline remains structurally accurate when older prompt rows are outside the loaded tail window.
- Design Decision: task context (`TaskId`) is a more reliable boundary than last-seen user message when the watch cache truncates history; this avoids attaching tool calls to the wrong prior user turn.

## Restrict Inferred Turn Splits To Top-Level Task Starts (2026-03-28)
- Narrowed inferred-turn creation to only top-level `task_started` boundaries instead of any task-id change.
- Added anchor replacement so if a real user message arrives after an inferred anchor in the same turn, the anchor is replaced instead of creating an extra synthetic turn.
- Changed inferred anchor rows to use title `Turn` with empty text to avoid confusing placeholder user text in timeline cards.
- Design Decision: nested task-id changes are common within a single user turn, so split heuristics must key on top-level task start markers to avoid phantom turns and dropped visible messages.
