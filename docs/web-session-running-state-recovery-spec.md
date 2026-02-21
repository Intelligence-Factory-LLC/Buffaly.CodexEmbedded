# Web Session Running-State Recovery Spec

Date: 2026-02-21

## Goals

1. Web server keeps Codex sessions alive independently of browser websocket lifetime.
2. Browser reconnect receives accurate running-state for active turns.
3. After web server restart, running-state is reconstructed from Codex session JSONL logs.
4. Sidebar uses one runtime indicator for work-in-progress state: spinner only.

## Runtime Model

1. Managed sessions are process-global in the web host, not per websocket connection.
2. `session_list` represents live managed sessions, including `isTurnInFlight`.
3. `session_catalog` represents stored thread catalog from `CODEX_HOME`.
4. Both `session_list` and `session_catalog` include a `processingByThread` map.
5. Catalog entries include `isProcessing`.

## Processing-State Sources

1. Live source:
- For managed sessions, `isTurnInFlight` is authoritative.

2. Recovered source:
- For catalog threads without a live managed session, running-state is inferred from recent JSONL lines.
- `event_msg.payload.type == task_started` increments open-task depth.
- `event_msg.payload.type == task_complete` decrements open-task depth, floored at zero.
- Thread is considered processing when open-task depth is greater than zero and the last task event is within freshness window.

## Recovery Limits and Defaults

Configuration keys in `Buffaly.CodexEmbedded.Web/appsettings.json`:

1. `RunningRecoveryRefreshSeconds` (default `5`)
2. `RunningRecoveryActiveWindowMinutes` (default `120`)
3. `RunningRecoveryTailLineLimit` (default `3000`)
4. `RunningRecoveryScanMaxSessions` (default `200`)

Notes:

1. Recovery is bounded to recent catalog sessions and tail lines for performance.
2. If logs are extremely long and a matching `task_started` is outside the tail window, recovered state can be under-reported.
3. Freshness window prevents stale spinners after abrupt Codex or host termination.

## Websocket Reconnect Behavior

1. Disconnect no longer hard-clears sidebar/session runtime state in the browser.
2. On reconnect, client requests `session_list` and `session_catalog`.
3. Incoming payloads reconcile state and overwrite thread processing map idempotently.

## UI Indicator Behavior

1. Sidebar runtime indicator is spinner only.
2. `Live` badge is removed.
3. Spinner is shown when either:
- Attached session has `isTurnInFlight == true`, or
- Catalog thread has server-reported processing state.

## Acceptance Criteria

1. Start a turn, reload browser, spinner remains accurate after reconnect sync.
2. Start a turn, disconnect websocket, reconnect, spinner remains accurate.
3. Restart web host during an active Codex thread, catalog shows recovered processing spinner within recovery refresh interval.
4. Spinner clears after `task_complete` or freshness timeout.
