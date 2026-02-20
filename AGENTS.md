# Codex App-Server Harness Overview

This repository contains a basic test harness for integrating with Codex through `codex app-server`.

## What This Solution Does

- Starts `codex app-server` as a child process.
- Communicates over JSON-RPC JSONL (`stdin`/`stdout`).
- Executes the required flow:
1. `initialize`
2. `thread/start`
3. `turn/start`
- Streams assistant deltas from `item/agentMessage/delta`.
- Handles server-initiated approval/tool requests so turns can continue.

## Main Implementation

- Harness project: `Buffaly.CodexEmbedded.Cli`
- Entry point: `Buffaly.CodexEmbedded.Cli/Program.cs`
- Usage guide: `Buffaly.CodexEmbedded.Cli/README.md`
- Planning/spec notes: `documentation/specs.md`
- Protocol schema bundle: `documentation/*.json` and `documentation/v1`, `documentation/v2`

## Why It Is Structured This Way

- The harness keeps transport dynamic (`System.Text.Json`) to stay resilient as the app-server protocol evolves.
- Schema files are used as a contract reference for method names and payload shapes.
- The project is intended as a smoke-test and integration baseline for future production clients.

## How To Run

From `Buffaly.CodexEmbedded.Cli`:

```powershell
dotnet build
dotnet run -- run --prompt "Say hello in one sentence" --codex-path "C:\Users\Administrator\AppData\Roaming\npm\codex.cmd"
```

Optional flags:
- `--model`
- `--cwd`
- `--auto-approve`
- `--timeout-seconds`
- `--json-events`

## Current Status

- The harness has been validated to complete an end-to-end turn (`turn/completed` with `completed` status) when `codex` can reach the OpenAI API.

## Commit Workflow Rule

- After each completed feature group (or when switching to a new feature), roll up the finished changes and create a checkpoint commit before starting the next feature.


