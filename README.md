# Buffaly.CodexEmbedded

Simple desktop-friendly harness for `codex app-server` with:

- A terminal app: `Buffaly.CodexEmbedded.Cli`
- A web app: `Buffaly.CodexEmbedded.Web`
- A reusable .NET library: `Buffaly.CodexEmbedded.Core`

This repository is set up so people can either:

1. Install and run it without Visual Studio.
2. Build and modify the source code.

## Quick Install (Windows, no Visual Studio)

### 1. Prerequisites

- Windows 10/11
- `codex` CLI installed and authenticated
- Internet access (for updates)

Confirm Codex is ready:

```powershell
codex --version
```

### 2. Download and install

1. Open the project **Releases** page.
2. Download the latest `Buffaly.CodexEmbedded-win-x64-<version>.zip`.
3. Extract the zip.
4. Open PowerShell in the extracted folder.
5. Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

### 3. Start using it

After install, open a new terminal:

```powershell
buffaly run --prompt "Say hello in one sentence"
buffaly-web
```

Useful commands:

- `buffaly`: interactive REPL mode.
- `buffaly run --prompt "<text>"`: one-shot prompt.
- `buffaly-update`: download and install latest release.
- `buffaly-uninstall`: remove the local install.

## Configure After Install

You can edit defaults in:

- `%LOCALAPPDATA%\Buffaly.CodexEmbedded\versions\<active-version>\apps\cli\appsettings.json`
- `%LOCALAPPDATA%\Buffaly.CodexEmbedded\versions\<active-version>\apps\web\appsettings.json`

Most common settings:

- `CodexPath`: command/path for Codex executable (default: `codex`)
- `DefaultCwd`: default working folder
- `TimeoutSeconds` or `TurnTimeoutSeconds`
- log paths (`LogFilePath`, `LogRootPath`)

When you update, installer keeps your existing `appsettings.json` files.

## Build From Source (Developer)

### Prerequisites

- .NET SDK 9.x
- Git
- `codex` CLI installed/authenticated

### Build, test, run

```powershell
dotnet restore
dotnet build
dotnet test
```

Run CLI:

```powershell
dotnet run --project Buffaly.CodexEmbedded.Cli -- run --prompt "Say hello in one sentence"
```

Run Web host:

```powershell
dotnet run --project Buffaly.CodexEmbedded.Web
```

## Release Build and Packaging

Manual release commands:

```powershell
./scripts/release/build.ps1 -Configuration Release
./scripts/release/publish.ps1 -Runtime win-x64 -Configuration Release -OutputRoot artifacts/publish
./scripts/release/package.ps1 -Runtime win-x64 -Version v1.0.0 -Repository <owner/repo> -PublishRoot artifacts/publish -OutputRoot artifacts/release
```

Generated files:

- `artifacts/release/Buffaly.CodexEmbedded-win-x64-<version>.zip`
- `artifacts/release/SHA256SUMS-win-x64-<version>.txt`

## GitHub Release Automation

Workflow: `.github/workflows/release.yml`

- Push tag `v*` to build/test/publish/package automatically.
- Assets are attached to the GitHub release for non-technical users to download.

## Project Layout

- `Buffaly.CodexEmbedded.Cli`: terminal harness
- `Buffaly.CodexEmbedded.Web`: browser-based multi-session UI
- `Buffaly.CodexEmbedded.Core`: reusable client library
- `scripts/release`: maintainer build/publish/package scripts
- `install/package`: installer/update/uninstall scripts bundled into release zip
