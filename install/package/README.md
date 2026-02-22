# Buffaly.CodexEmbedded Windows Package

This folder is a portable release package.

## Install (no Visual Studio needed)

1. Open PowerShell 7 in this folder.
2. Run:

```powershell
pwsh -ExecutionPolicy Bypass -File .\install.ps1
```

This installs wrapper commands on your PATH, including `buffaly-codex-web`.

If you prefer the launcher script, use:

```powershell
.\install.cmd
```

If PowerShell 7 is not available, use one of these:

```powershell
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

Installer runs non-blocking Codex preflight checks and prints warnings if Codex is missing or auth artifacts are not detected.

After install, open a new terminal and use:

```powershell
buffaly-codex-web
```

When web starts, open the URL shown after `Now listening on:`.

## Troubleshooting quick checks

If web does not start correctly, run these checks in a new terminal:

1. Test that Codex is installed:

```powershell
codex --version
```

2. Try the non-web command to confirm the CLI wrapper works:

```powershell
buffaly-codex run --prompt "Say hello in one sentence"
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
