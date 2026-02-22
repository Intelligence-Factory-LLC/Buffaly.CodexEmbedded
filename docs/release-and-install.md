# Release and Install Guide

This file documents the end-to-end flow for maintainers and end users.

## Maintainer: build, publish, package

From repository root:

```powershell
./scripts/release/build.ps1 -Configuration Release
./scripts/release/publish.ps1 -Runtime win-x64 -Configuration Release -OutputRoot artifacts/publish
./scripts/release/package.ps1 -Runtime win-x64 -Version v1.0.0 -Repository <owner/repo> -PublishRoot artifacts/publish -OutputRoot artifacts/release
```

Output:

- `artifacts/release/Buffaly.CodexEmbedded-win-x64-v1.0.0.zip`
- `artifacts/release/SHA256SUMS-win-x64-v1.0.0.txt`

## Maintainer: GitHub release

Recommended:

1. Commit and push.
2. Tag and push:

```powershell
git tag v1.0.0
git push origin v1.0.0
```

3. Workflow `.github/workflows/release.yml` builds, tests, packages, and uploads release assets.

## End user: install and run

1. Download latest release zip from GitHub Releases.
2. Extract zip.
3. Run:

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

4. Open a new terminal and use:

```powershell
buffaly-codex run --prompt "Say hello in one sentence"
buffaly-codex-web
```

## End user: update and uninstall

Update:

```powershell
buffaly-codex-update
```

Uninstall:

```powershell
buffaly-codex-uninstall
```
