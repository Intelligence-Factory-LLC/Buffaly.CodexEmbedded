# Buffaly.CodexEmbedded.Cli

Small CLI harness for testing Codex App Server integration over JSON-RPC JSONL.
The CLI uses the shared `Buffaly.CodexEmbedded.Core` client library (also used by the web server).

## Build

```powershell
dotnet build
```

## Run

```powershell
dotnet run -- run --prompt "list top 5 largest files"
```

If you omit `--prompt`, the app starts a REPL loop:

```powershell
dotnet run -- run
```

## Options

- `--thread-id <id>` Resume an existing thread via `thread/resume`.
- `--model <name>` Optional model override.
- `--cwd <path>` Optional working directory (defaults to `DefaultCwd` from appsettings).
- `--auto-approve <mode>` `ask|accept|acceptForSession|decline|cancel`.
- `--timeout-seconds <n>` Overall timeout for the harness run.
- `--json-events` Mirror raw JSONL frames from the app-server.
- `--codex-path <path>` Codex executable path if not on PATH.
- `--codex-home <path>` Optional writable Codex home directory passed via `CODEX_HOME`.

## Defaults

- `Buffaly.CodexEmbedded.Cli/appsettings.json` supplies defaults for `CodexPath`, `DefaultCwd`, and `TimeoutSeconds`.
- `Buffaly.CodexEmbedded.Cli/appsettings.json` can set `CodexHomePath` when you want to isolate Codex state (auth, sessions, skills) to a specific directory.
- Current defaults are pinned to `C:\dev\CodexAppServer\working` for working directory and harness logs.
- `%USERPROFILE%\.codex\config.toml` is read for default `model` when `--model` is not provided.
- The CLI prints `threadId=...` after each run so it can be passed to `--thread-id` for resume.


