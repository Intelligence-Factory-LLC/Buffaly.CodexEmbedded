# Web Session Catalog + Full Verbosity (Shared Core) Spec

Date: 2026-02-19

## Goals

1. Web can load any existing Codex session/thread from `CODEX_HOME`.
2. Web logs can show complete protocol/runtime events when verbosity is high.
3. Implementation is reusable in Core so CLI/Web do not reimplement behavior.

## Design

### 1. Shared Core Session Catalog

Add reusable APIs in `Buffaly.CodexEmbedded.Core`:

- `CodexHomePaths`
  - resolves effective Codex home (`configured path` -> `CODEX_HOME env` -> `%USERPROFILE%\.codex`).
  - resolves `session_index.jsonl` and `sessions/` paths.
- `CodexSessionCatalog`
  - reads `session_index.jsonl` for thread IDs + names + updated timestamps.
  - scans `sessions/**/*.jsonl` for `session_meta` to recover `threadId/cwd/model`.
  - merges sources into `CodexStoredSessionInfo`.

### 2. Shared Core Event Verbosity

Add reusable logging helpers:

- `CodexEventVerbosity` (`errors|normal|verbose|trace`)
- `CodexEventLogging.TryParseVerbosity(...)`
- `CodexEventLogging.ShouldInclude(...)`
- `CodexEventLogging.Format(...)`

Rules:
- `trace`: all events
- `verbose`: all except raw `stdout_jsonl`
- `normal`: warnings/errors + key transport failures + stderr lines
- `errors`: warnings/errors only

### 3. Web Server Changes

In `MultiSessionWebCliSocketSession`:

- New WS messages:
  - `session_catalog_list`
  - `session_attach` (attach by `threadId` using `thread/resume`)
  - `log_verbosity_set`
- New WS events:
  - `session_catalog`
  - `session_attached`
  - `log_verbosity`
- Stream core `CodexClient.OnEvent` to browser `log` frames using shared verbosity filter.
- Continue writing full per-session log files.

### 4. Web UI Changes

Add controls:

- Existing-session dropdown + attach button
- Log-verbosity dropdown

Behavior:

- auto-load session catalog on connect
- allow attaching selected thread as a managed in-memory session
- persist selected verbosity + cwd in `localStorage`

### 5. CLI Reuse

CLI event output uses shared `CodexEventLogging` filter/formatter rather than ad-hoc checks.

## Acceptance Criteria

1. Web can discover and attach to previously saved thread IDs from `CODEX_HOME`.
2. Web log panel can show full event stream (`trace`).
3. Shared Core APIs are consumed by Web and CLI.
