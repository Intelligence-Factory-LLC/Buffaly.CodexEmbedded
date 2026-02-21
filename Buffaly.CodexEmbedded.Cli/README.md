# Buffaly.CodexEmbedded.Cli

CLI harness for Codex App Server over JSON-RPC JSONL.

## Install-and-run users

If you installed from a GitHub release package, use:

```powershell
buffaly-codex run --prompt "list top 5 largest files"
```

REPL mode:

```powershell
buffaly-codex
```

## Source developers

Build:

```powershell
dotnet build
```

Run:

```powershell
dotnet run -- run --prompt "list top 5 largest files"
```

Run REPL:

```powershell
dotnet run -- run
```

## Options

- `--thread-id <id>` Resume an existing thread via `thread/resume`.
- `--model <name>` Optional model override.
- `--cwd <path>` Optional working directory.
- `--auto-approve <mode>` `ask|accept|acceptForSession|decline|cancel`.
- `--timeout-seconds <n>` Overall timeout in seconds.
- `--json-events` Mirror raw JSONL from app-server.
- `--codex-path <path>` Codex executable path.
- `--codex-home <path>` Optional writable Codex home (`CODEX_HOME`).

## Defaults

- `appsettings.json` provides defaults for `CodexPath`, `DefaultCwd`, `TimeoutSeconds`, and `LogFilePath`.
- Portable defaults use `codex` on PATH and relative log paths.
- `%USERPROFILE%\.codex\config.toml` is read for default model when `--model` is not provided.
- The CLI prints `threadId=...` after each run for resume.


