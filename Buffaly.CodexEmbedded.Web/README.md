# Buffaly.CodexEmbedded.Web

Web UI for Codex App Server.

## Install-and-run users

If you installed from a GitHub release package, run:

```powershell
buffaly-web
```

Then open the URL shown in the terminal (usually `http://localhost:5000`).

## Source developers

Run directly from source:

```powershell
dotnet run --project Buffaly.CodexEmbedded.Web
```

## How It Works

- Browser connects to `/ws`.
- **New Session** starts `codex app-server`, runs `initialize`, and opens a thread.
- **Existing + Attach** loads a saved thread from `CODEX_HOME/sessions`.
- Prompts are sent with `turn/start`.
- Assistant deltas stream into the conversation pane.
- Approval/tool requests are surfaced in the UI.

## Config

`appsettings.json` keys:

- `CodexPath`
- `DefaultCwd`
- `CodexHomePath` (optional)
- `TurnTimeoutSeconds`
- `LogRootPath`

