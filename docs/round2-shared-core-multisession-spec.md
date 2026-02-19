# Round 2 Spec: Shared Core + Multi-Session + UX

Date: 2026-02-19

## 1. Goals

1. Share a common protocol/runtime codebase between:
   - `Buffaly.CodexEmbedded.Cli` (CLI)
   - `Buffaly.CodexEmbedded.Web` (web UI + server)
   - Embedded usage from other .NET agents (new wrapper library)
2. Improve usability for `cwd` and model selection:
   - CLI: keep `--cwd` and `--model` first-class and consistent.
   - Web: add a visual working-directory picker and a model dropdown (with refresh).
3. Add multi-session management:
   - Web server can run and manage multiple Codex sessions concurrently.
   - CLI can resume an existing session/thread.
4. Provide a simple, ergonomic C# API to:
   - create or attach to a session programmatically
   - send a message
   - optionally receive streaming updates via callbacks
   - await a final result (minutes-long turns)

## 2. Non-Goals (Round 2)

- Implementing a full external/public multi-tenant API (see `docs/codex-api-wrapper-spec.md`).
- Implementing durable persistence for sessions/turns across machine restarts (optional stretch).
- Implementing full approval policy UX beyond what exists (keep current flow, make it reliable).

## 3. Current State (Baseline)

- CLI and web both embed `codex app-server` via child process and speak JSON-RPC JSONL.
- Both contain independent implementations of:
  - process lifecycle
  - JSON-RPC request/response correlation
  - notification routing
  - approval request handling
  - streaming assistant deltas

## 4. Shared Core Design

### 4.1 New Project

Add a shared class library:

- Project: `Buffaly.CodexEmbedded.Core` (new)
- Framework: match existing (net9.0)
- References: `System.Text.Json`, no ASP.NET dependencies

Responsibilities:
- Start/stop `codex app-server` with safe defaults:
  - `StandardInputEncoding = new UTF8Encoding(false)` (no BOM)
  - UTF-8 stdout/stderr
  - correct `WorkingDirectory`
- Provide JSON-RPC transport:
  - `SendRequestAsync(method, params)` with typed/untyped payloads
  - pending request map keyed by RequestId
  - stdout/stderr pumps and structured events
- Provide a session abstraction:
  - initialize
  - thread start/resume
  - turn start/interrupt
  - approval/tool request handler hooks
 - Provide an embedding wrapper API (section 4.4)

Non-responsibilities:
- UI formatting
- HTTP/WebSocket concerns
- logging frameworks (core emits events; host decides where to write)

### 4.2 Core API (Proposed)

Types:
- `Buffaly.CodexEmbeddedProcessOptions`
  - `CodexPath`, `WorkingDirectory`, `CodexHomePath?`, `Env`, timeouts
- `CodexSessionOptions`
  - `Model?`, `Cwd?`, `ApprovalMode`, `JsonEventMirror`
- `CodexSession` (IDisposable/IAsyncDisposable)
  - `InitializeAsync()`
  - `StartThreadAsync(model?, cwd?) -> threadId`
  - `ResumeThreadAsync(threadId) -> threadId` (or thread object)
  - `StartTurnAsync(threadId, inputItems, modelOverride?) -> turnId`
  - `InterruptTurnAsync(turnId?)`
  - events/callbacks:
    - `OnAgentDelta(text)`
    - `OnTurnCompleted(status, error?)`
    - `OnServerError(error)`
    - `OnApprovalRequest(...) -> decision`

Key policy:
- One in-flight turn per `CodexSession` (serialize).

### 4.3 Shared Logging Shape

Core emits structured event objects:
- `CodexCoreEvent`
  - `Timestamp`
  - `Level`
  - `Type` (`stdout_json`, `stderr_line`, `rpc_sent`, `rpc_response`, `notification`, `server_request`, `turn_state`)
  - `Data` (JsonElement/string)

Hosts decide:
- write to file
- mirror to console
- stream to browser

### 4.4 Embedded C# Wrapper API

Goal: embedding Codex into other agents should feel like calling a normal async C# service.

#### 4.4.1 Primary Abstractions

- `CodexClient` (process owner)
  - starts/stops `codex app-server`
  - owns JSON-RPC connection and pumps
- `CodexSession` (logical thread binding)
  - wraps a `threadId`
  - serializes turns per session

#### 4.4.2 Factory Methods

- `CodexClient.StartAsync(CodexClientOptions, CancellationToken) -> CodexClient`
- `CodexClient.CreateSessionAsync(CodexSessionCreateOptions, CancellationToken) -> CodexSession`
- `CodexClient.AttachToSessionAsync(CodexSessionAttachOptions, CancellationToken) -> CodexSession`
  - uses `thread/resume` when supported
  - fallback behavior: treat as error with clear message (Round 2); extend later if needed

#### 4.4.3 Sending Messages

- `CodexSession.SendMessageAsync(string text, CodexTurnOptions? opts, IProgress<CodexDelta>? progress, CancellationToken ct) -> CodexTurnResult`
  - progress callback receives streaming deltas (`item/agentMessage/delta` with `params.delta` string)
  - `CodexTurnResult` includes:
    - `Status` (`completed|failed|cancelled|timedOut|unknown`)
    - `ErrorMessage?`
    - `Text` (aggregated assistant deltas for convenience)
    - `ThreadId`, `TurnId`

Thread-safety:
- allow concurrent sessions per process
- disallow concurrent turns per session (serialize with a lock)

Timeouts:
- `SendMessageAsync` supports minutes-long turns; caller controls `CancellationToken`

Approvals:
- embedding API exposes an optional delegate for approvals; default is `decline`

## 5. Working Directory UX

### 5.1 CLI

Requirements:
- Keep `--cwd <path>` behavior.
- Add `--cwd` default resolution from config (already exists); ensure it is visible in `--help`.

Stretch:
- Validate directory exists or create it when safe (opt-in).

### 5.2 Web UI

Requirements:
- Replace free-text `cwd` input with a clearer UI:
  - text box + "Browse" button (directory picker in browser if available)
  - show resolved/active `cwd` per session
  - persist last-used `cwd` in `localStorage`
- Server should enforce `WorkingDirectory = cwd` when launching the Codex process.

Notes:
- Browser directory picking is limited; implement as:
  - text input + recent list (most reliable)
  - optional `<input type="file" webkitdirectory>` when supported to read a directory path

## 6. Model Flag + Dropdown

### 6.1 CLI

Requirements:
- Ensure `--model` is passed into `thread/start` and/or `turn/start` consistently.
- Ensure CLI shows the resolved model in internal logs.

### 6.2 Web

Requirements:
- Add a model dropdown:
  - default to "auto" (use Codex default)
  - allow custom model entry
  - add "refresh models" button
- Populate options by calling app-server model list if available:
  - `model/list` (v2 schema) or equivalent
  - fallback: allow manual entry only

## 7. Multi-Session Web Server

### 7.1 Desired Behavior

- A single web server instance can manage multiple sessions concurrently.
- A single browser tab can create/select multiple sessions.
- Each session has:
  - independent Codex process
  - independent thread ID
  - independent logs
  - independent in-flight turn lock

### 7.2 Server Architecture

Add a `SessionManager` singleton in `Buffaly.CodexEmbedded.Web`:
- `CreateSession(options) -> sessionId`
- `StopSession(sessionId)`
- `GetSession(sessionId)`
- `ListSessions()`

Each `ManagedSession` wraps:
- `CodexSession` (from shared core)
- `SessionMetadata` (createdAt, model, cwd, status)
- `TurnQueue` or per-session `SemaphoreSlim`

Resource controls:
- cap max sessions (config)
- idle timeout cleanup (config)
- per-session max log size / retention

### 7.3 Transport

Continue using WebSocket for UI, but add session scoping:
- client message includes `sessionId`
- server responses include `sessionId`

Add new WS message types:
- `session/create { model?, cwd? } -> session_created { sessionId, threadId }`
- `session/list -> session_list { sessions[...] }`
- `session/stop { sessionId } -> session_stopped`
- `turn/start { sessionId, text }`
- `turn/cancel { sessionId, turnId? }`

Backwards compatibility:
- keep `start_session` mapping to `session/create` for a transition period.

## 8. CLI Resume Sessions

### 8.1 Requirements

Add a CLI surface to resume a previous thread:
- `Buffaly.CodexEmbedded.Cli run --thread-id <id> [--prompt ...] [--model ...] [--cwd ...]`

Behavior:
- Start a new Codex process as usual.
- `initialize`
- `thread/resume` (preferred) or fallback `thread/read` if supported.
- Start a new `turn/start` on the resumed thread.

### 8.2 Discovery Helpers (Optional)

- `Buffaly.CodexEmbedded.Cli list-sessions`
  - list recent thread IDs from `CODEX_HOME\\sessions\\...`
- `Buffaly.CodexEmbedded.Cli resume --latest`

## 9. Testing / Verification

### 9.1 Shared Core

- unit: JSON-RPC correlation (responses match correct awaiting task)
- integration: start process, `initialize`, `thread/start`, `turn/start`, `turn/completed`
- regression: verify no stdin BOM breaks initialize

### 9.2 Web Multi-Session

- create 2 sessions, run turns concurrently, verify deltas and completions are routed correctly
- stop one session while other continues
- verify per-session logs are written to distinct files

### 9.3 CLI Resume

- start a session, capture thread ID, exit
- run `--thread-id` and verify a new turn completes on the same thread

### 9.4 Embedded Wrapper

- unit: a fake in-memory app-server drives:
  - `initialize` response
  - `thread/start` response
  - `turn/start` response + streaming deltas + `turn/completed`
- integration (optional, opt-in env var):
  - run against real `codex app-server` only when `RUN_CODEX_INTEGRATION_TESTS=1`

## 10. Rollout Plan

1. Create `Buffaly.CodexEmbedded.Core` and move shared logic from CLI + web into it.
2. Update CLI to use core.
3. Update web to use core.
4. Implement web multi-session manager + UI.
5. Implement CLI resume (`--thread-id`) and optional listing.

## 11. Acceptance Criteria

1. CLI and web share a single runtime/protocol implementation (no copy/paste forks).
2. Web supports multiple concurrent sessions in one UI.
3. Web working directory and model selection are first-class and persisted.
4. CLI can resume an existing thread and run new turns.

