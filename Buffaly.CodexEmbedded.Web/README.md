# Buffaly.CodexEmbedded.Web

Web-based CLI for Codex App Server.

## Run

```powershell
dotnet run --project Buffaly.CodexEmbedded.Web
```

Then open `http://localhost:5000` (or the URL shown in console).

## How It Works

- Browser connects to `/ws`.
- Click **New Session** to start `codex app-server`, run `initialize`, and open a thread.
- Use **Existing + Attach** to load a previously saved thread from `CODEX_HOME/sessions`.
- Send prompts from the input box to run `turn/start`.
- Assistant text streams in the conversation pane.
- Set **Logs** verbosity (`errors|normal|verbose|trace`) to control how much core transport data is streamed to the browser.
- Logs (connection + core events) stream into the logs pane and are also written to local files.
- Approval requests are shown in the approval panel with action buttons.

## Config

`appsettings.json`:
- `CodexPath`
- `DefaultCwd`
- `CodexHomePath` (optional)
- `TurnTimeoutSeconds`
- `LogRootPath`

