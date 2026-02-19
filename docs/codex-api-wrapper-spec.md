# Codex API Wrapper Spec

## 1. Purpose

Expose Codex (`codex app-server`) behind a stable web API so external clients can submit changes/prompts, wait for completion, and receive streamed output/events.

## 2. Scope

In scope:
- Stateful server-side session management backed by long-lived Codex worker processes.
- API endpoints for session lifecycle, turn execution, streaming, status, and cancellation.
- Approval/tool-request handling strategy suitable for service operation.
- Operational concerns: logging, timeout behavior, and observability.

Out of scope (phase 1):
- Complex multi-region deployment.
- Full workflow orchestration beyond Codex turn execution.

## 3. Current Baseline (Already Implemented)

Repository currently includes:
- CLI harness that starts `codex app-server`, performs `initialize -> thread/start -> turn/start`, and handles server requests/notifications.
- WebSocket web wrapper with per-connection session and turn loop.

This means protocol integration is proven; missing work is API productization and service hardening.

## 4. Target Architecture

Components:
1. API Gateway Layer (`Buffaly.CodexEmbedded.Web`): REST + SSE/WebSocket endpoints, auth, validation.
2. Session Orchestrator: maps `apiSessionId` to Codex thread/process state.
3. Worker Runtime: long-lived `codex app-server` child processes.
4. State Store: session + turn metadata (initially in-memory; phase 2 persistent store).
5. Event Streamer: forwards `item/agentMessage/delta`, status, and completion events.

Core pattern:
- Do not spawn one Codex process per HTTP request.
- Keep worker/session state alive across turns.
- Serialize turns per session (`max 1` in-flight turn per thread).

## 5. API Contract (MVP)

### 5.1 Sessions

- `POST /sessions`
  - Creates API session, initializes Codex worker+thread.
  - Response: `{ sessionId, threadId, createdAt, model, cwd }`.

- `DELETE /sessions/{sessionId}`
  - Stops session and releases worker/process resources.

### 5.2 Turns

- `POST /sessions/{sessionId}/turns`
  - Starts turn with text input and optional model override.
  - Response:
    - Sync mode (short timeout): final result when completed.
    - Async mode: `202 Accepted` + `{ turnId }`.

- `GET /sessions/{sessionId}/turns/{turnId}`
  - Returns state: `queued|inProgress|completed|failed|cancelled|timedOut`.

- `POST /sessions/{sessionId}/turns/{turnId}/cancel`
  - Requests cancellation/interruption.

### 5.3 Streaming

- `GET /sessions/{sessionId}/turns/{turnId}/stream`
  - SSE or WebSocket stream for deltas/events:
    - `assistant_delta`
    - `approval_request`
    - `turn_complete`
    - `error`

## 6. Session and Turn Lifecycle

1. Create session:
   - start process (`codex app-server`)
   - send `initialize`
   - send `thread/start`
   - persist mapping `sessionId -> threadId + process handle`

2. Start turn:
   - validate no active turn for session
   - send `turn/start`
   - stream notifications
   - complete on `turn/completed`

3. Stop session:
   - close stdin, wait for process exit, then kill if needed
   - mark session terminated and release resources

## 7. Approval and Tool Request Policy

Modes:
1. `auto-approve` (internal trusted environments only).
2. `manual-approve` via callback/API endpoint.
3. `deny-by-default` for unimplemented dynamic tool calls.

MVP recommendation:
- Keep existing explicit approval event model.
- Add API response path for `approval_request` so turns do not deadlock.

## 8. Reliability and Observability

Required:
- Per-turn timeout and cancellation tokens.
- Structured logs per session/turn.
- Persist raw JSON-RPC frames for diagnostics.
- Health endpoint(s): process liveness and worker/session counts.
- Metrics: active sessions, turn latency, timeout/error rates.

## 9. Security and Isolation

Required before production:
- API authentication and authorization.
- Tenant-scoped session ownership checks.
- CWD/path constraints for command/file actions.
- Rate limiting and quotas.
- Secrets handling for Codex auth tokens.

## 10. Implementation Plan

## Phase 1: Internal API MVP (1-2 weeks)

1. Add REST endpoints listed in section 5.
2. Add in-memory session registry and turn state model.
3. Reuse existing Codex runtime logic from harness/websocket session class.
4. Add SSE stream endpoint for deltas.
5. Add deterministic timeout and cancellation behavior.
6. Add integration tests for happy path + timeout + approval flow.

## Phase 2: Hardening (1-2 additional weeks)

1. Add authn/authz and tenant isolation.
2. Add persistent state store (session/turn metadata).
3. Add worker pool/backpressure controls.
4. Add metrics/health/readiness and alertable logs.
5. Add restart/recovery handling for in-progress turns.

## Phase 3: Production Readiness (1-2 additional weeks)

1. Load and soak testing.
2. Retry and failure-injection validation.
3. Operational runbook and deployment templates.
4. Security review of tool approvals and filesystem boundaries.

## 11. Acceptance Criteria

1. A client can create a session, run multiple turns, and receive streamed output.
2. Turn completion status is queryable and durable for at least process lifetime (phase 1) and across restarts (phase 2).
3. Approval requests can be resolved via API without hanging the turn.
4. Timeouts and cancellation terminate turns deterministically.
5. Logs are sufficient to diagnose whether failure is:
   - Codex process startup/exit issue,
   - protocol/RPC correlation issue,
   - upstream API connectivity issue.


