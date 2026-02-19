# Program.cs Change History

## Initial Harness Implementation (2026-02-18)
- Implemented a CLI harness that starts `codex app-server`, performs `initialize`, `thread/start`, and `turn/start`, and streams turn output.
- Added JSON-RPC request/response correlation, server request handlers for approval and tool flows, and graceful shutdown behavior.
- Design: kept protocol handling dynamic with `System.Text.Json` to stay resilient against schema evolution while preserving clear extension points for future typed DTOs.

## Nullability Cleanup (2026-02-18)
- Updated option assignment defaults for `Cwd` and `CodexPath` to avoid nullable flow warnings in `dotnet build`.
- Design: retained the same runtime behavior while making output assignments explicitly non-null for stricter compile-time safety.

## Turn Completion Robustness Fix (2026-02-18)
- Hardened JSON path traversal to safely handle non-object nodes (including `null`) when reading nested notification fields.
- Design: prevents runtime exceptions on optional nested payloads while preserving existing behavior for valid object paths.

## Runtime Defaults And REPL Mode (2026-02-18)
- Added runtime default loading from `appsettings.json` for codex executable path and timeout, with fallback to `codex`.
- Added `.codex/config.toml` parsing to use the user's default model when `--model` is not provided.
- Made `--prompt` optional and added REPL mode when no prompt is provided, with per-prompt execution and `/exit` support.
- Design: preserves single-prompt behavior while enabling local interactive testing and configuration-driven startup defaults.

## Optional Subcommand Parsing (2026-02-18)
- Updated argument parsing so `run` is optional; launching with no args or only option flags now works.
- Design: supports debugger/no-argument startup directly into REPL while preserving `run` as a valid explicit command.

## Console/Log Output Split (2026-02-18)
- Added a local file logger and routed non-user operational output (thread/turn/item lifecycle, stderr, and JSONL frames) into `LogFilePath`.
- Kept user-facing console output focused on assistant responses, approval prompts, and actionable error messages.
- Design: separates UX-facing conversation content from diagnostic telemetry while preserving traceability for debugging.
- Updated error notification parsing to read nested `error.message` payloads so retry/disconnect messages are shown correctly to users.

## Approval Prompt Formatting + UTF-8 Fix (2026-02-18)
- Added line-boundary handling so streamed assistant text is terminated before interactive/system lines are printed.
- Reformatted command approval display into separate lines (`[approval:command]` header + command text body) for readability.
- Forced UTF-8 process stream encodings and console output encoding to reduce mojibake in assistant text (for example, `I’m`).

## Sanitized Command Approval Display (2026-02-18)
- Removed raw command blocks from user console approval prompts.
- Added parsed command metadata display (reason, working directory, command actions) and directed full command text to internal logs only.
- Design: keeps approval UX readable while preserving full audit/debug detail in local log files.

## Startup/Timeout Diagnostics + Optional CODEX_HOME (2026-02-18)
- Added explicit startup console line showing the active internal log path.
- Added timeout diagnostics snapshot output including process PID/exit info, protocol phase, last RPC method, and last stderr/stdout content.
- Added richer internal log events for outbound RPCs and startup context (`cwd`, `codexPath`, optional `codexHome`).
- Added optional `--codex-home` argument and `CodexHomePath` appsettings support to set `CODEX_HOME` for the child process when needed.
- Design: make IPC/startup failures diagnosable in one run and support environments where default codex home paths are not writable.

## Working-Root Defaults + CLI Stderr Visibility (2026-02-18)
- Added `DefaultCwd` appsettings support and switched `--cwd` fallback from current process directory to configured defaults.
- Updated default harness settings to use `C:\dev\CodexAppServer\working` for execution root, log file location, and Codex home path.
- Ensured the configured working directory is created before launching Codex.
- Mirrored Codex `stderr` lines to CLI output (while still writing full lines to the internal log file) so startup failures are immediately visible.

## Fixed Stdin UTF-8 BOM Handshake Bug (2026-02-18)
- Switched `ProcessStartInfo.StandardInputEncoding` from `Encoding.UTF8` to `new UTF8Encoding(false)` so the first JSON-RPC frame does not get prefixed with a UTF-8 BOM.
- Result: `initialize` reliably receives a response again, unblocking the end-to-end flow.

