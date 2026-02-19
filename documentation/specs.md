# Codex App-Server CLI Harness Plan

## Goal
Build a local CLI test harness that embeds Codex through `codex app-server` so we can validate protocol integration now and reuse the harness for later product integrations.

## Scope
- Implement a minimal but production-shaped command-line client.
- Use generated schema as the protocol contract source.
- Support one full prompt/response turn plus approval round-trips.
- Keep transport dynamic (`System.Text.Json`) for v0; type generation is optional follow-up.

## Protocol Contract Notes (From Generated JSON)
- Transport is JSON-RPC messages over JSON lines on stdin/stdout.
- Required request sequence:
1. `initialize` with `params.clientInfo` (required).
2. `thread/start` (no required params; `model`, `cwd`, etc are optional).
3. `turn/start` with required `threadId` and `input`.
- Important notifications to handle:
1. `thread/started`
2. `turn/started`
3. `item/started`
4. `item/agentMessage/delta`
5. `item/completed`
6. `turn/completed`
7. `error`
- Server-initiated requests that must be answered:
1. `item/commandExecution/requestApproval` -> respond with `CommandExecutionRequestApprovalResponse`
2. `item/fileChange/requestApproval` -> respond with `FileChangeRequestApprovalResponse`
3. `item/tool/requestUserInput` -> respond with `ToolRequestUserInputResponse`
4. `item/tool/call` -> respond with `DynamicToolCallResponse`

## CLI v0 Surface
- `codex-harness run --prompt "..." [--model ...] [--cwd ...] [--auto-approve ...] [--timeout-seconds ...] [--json-events]`
- `--auto-approve` values:
1. `ask` (default interactive prompt)
2. `accept`
3. `acceptForSession`
4. `decline`
5. `cancel`
- Output modes:
1. Human-readable stream (default)
2. Raw JSONL mirror when `--json-events` is set

## Implementation Plan

### Phase 1: Project Setup
1. Create `.NET` console project under `documentation/codex-app-server/Buffaly.CodexEmbedded.Cli`.
2. Add lightweight CLI parsing (`System.CommandLine`) or minimal manual parsing.
3. Add `README.md` with run instructions and prerequisites (`codex` available on PATH).

### Phase 2: Transport + RPC Core
1. Start `codex app-server` as child process with redirected stdin/stdout/stderr.
2. Implement JSONL writer and stdout read pump.
3. Add request ID allocator and pending-request map for correlation.
4. Implement request timeout + cancellation handling.
5. Route incoming frames into:
- JSON-RPC response (`id` + `result`/`error`)
- server request (`id` + `method`)
- notification (`method` without `id`)

### Phase 3: Session Flow
1. Send `initialize`.
2. Send `thread/start` and capture returned `thread.id`.
3. Send `turn/start` with `input: [{ "type": "text", "text": "<prompt>" }]`.
4. Continue processing events until `turn/completed` (or timeout/error).

### Phase 4: Event Rendering
1. Stream `item/agentMessage/delta` incrementally to stdout.
2. Track `threadId`, `turnId`, and item IDs for diagnostics.
3. Print concise status for turn/item started/completed notifications.
4. Preserve full raw payload in debug mode for schema-drift troubleshooting.

### Phase 5: Approval + Tool Request Handling
1. On `item/commandExecution/requestApproval`, return decision from `--auto-approve` or prompt user.
2. On `item/fileChange/requestApproval`, same policy behavior.
3. On `item/tool/requestUserInput`, prompt interactively and map answers by question ID.
4. On `item/tool/call`, return a stubbed `DynamicToolCallResponse`:
- default v0 behavior: `success=false` with explanatory text content.
- follow-up: optional local dynamic tool registry.

### Phase 6: Reliability + Diagnostics
1. Pump stderr to console/log for protocol and runtime diagnostics.
2. Exit non-zero on startup failure, handshake failure, timeout, or transport break.
3. Add structured error messages that include method name and request ID when present.
4. Gracefully terminate child process on CTRL+C and completion.

### Phase 7: Test Matrix
1. Smoke test: prompt-only turn with no approvals.
2. Approval test: prompt that triggers command approval; verify response unblocks turn.
3. File-change approval test.
4. Timeout test with short timeout.
5. Invalid payload resilience test (unknown notification fields should not crash client).

## Acceptance Criteria
1. `run --prompt "hello"` completes end-to-end and prints agent output.
2. Client correctly handles at least one approval request round-trip.
3. `turn/completed` reliably terminates session flow.
4. CLI returns deterministic exit codes for success, protocol error, timeout, and startup failure.
5. `--json-events` emits raw frames to help future integrations debug protocol issues.

## Follow-Up (Post v0)
1. Generate DTOs from schema for request/notification types while keeping tolerant parsing at boundaries.
2. Add `run --thread-id` resume mode using `thread/resume`.
3. Add snapshot transcripts (input/output/events) for reproducible integration tests.

