# Buffaly.CodexEmbedded Windows Package

This folder is a portable release package.

## Install (no Visual Studio needed)

1. Open PowerShell in this folder.
2. Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

After install, open a new terminal and use:

```powershell
buffaly-codex run --prompt "Say hello in one sentence"
buffaly-codex-web
```

## Update

```powershell
buffaly-codex-update
```

## Configure defaults

Edit:

- `%LOCALAPPDATA%\Buffaly.CodexEmbedded\versions\<active-version>\apps\cli\appsettings.json`
- `%LOCALAPPDATA%\Buffaly.CodexEmbedded\versions\<active-version>\apps\web\appsettings.json`

## Uninstall

```powershell
buffaly-codex-uninstall
```
