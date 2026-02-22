[CmdletBinding()]
param(
    [string]$InstallRoot = "",
    [switch]$KeepVersions,
    [switch]$NoPrompt
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-DefaultInstallRoot {
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        return Join-Path $env:LOCALAPPDATA "Buffaly.CodexEmbedded"
    }

    $userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    if ([string]::IsNullOrWhiteSpace($userProfile)) {
        throw "Could not determine installation folder."
    }

    return Join-Path $userProfile "AppData\Local\Buffaly.CodexEmbedded"
}

function Normalize-PathEntry([string]$Value) {
    return $Value.Trim().TrimEnd('\')
}

function Remove-UserPathEntry([string]$PathEntry) {
    $normalizedTarget = Normalize-PathEntry $PathEntry
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ([string]::IsNullOrWhiteSpace($userPath)) {
        return
    }

    $entries = @($userPath.Split(';', [System.StringSplitOptions]::RemoveEmptyEntries))
    $remaining = @()
    foreach ($entry in $entries) {
        if (-not [string]::Equals((Normalize-PathEntry $entry), $normalizedTarget, [StringComparison]::OrdinalIgnoreCase)) {
            $remaining += $entry
        }
    }

    try {
        [Environment]::SetEnvironmentVariable("Path", ($remaining -join ';'), "User")
    }
    catch {
        Write-Warning "Could not update user PATH automatically. You may need to remove this entry manually: $PathEntry"
    }
}

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Get-DefaultInstallRoot
}

if (-not (Test-Path $InstallRoot)) {
    Write-Host "Nothing to uninstall. Folder does not exist: $InstallRoot"
    return
}

if (-not $NoPrompt) {
    Write-Host "Buffaly.CodexEmbedded uninstall" -ForegroundColor Yellow
    Write-Host "  Install folder: $InstallRoot"
    if ($KeepVersions) {
        Write-Host "  Keeping versioned binaries."
    }
    $answer = Read-Host "Continue? (Y/N)"
    if ($answer -notmatch '^(?i)y(es)?$') {
        throw "Uninstall cancelled."
    }
}

$binRoot = Join-Path $InstallRoot "bin"
Remove-UserPathEntry $binRoot

$targets = @(
    (Join-Path $InstallRoot "active-version.txt"),
    (Join-Path $InstallRoot "release-manifest.json"),
    (Join-Path $InstallRoot "update.ps1"),
    $binRoot
)

foreach ($target in $targets) {
    if (Test-Path $target) {
        Remove-Item -Recurse -Force $target
    }
}

if (-not $KeepVersions) {
    $versionsRoot = Join-Path $InstallRoot "versions"
    if (Test-Path $versionsRoot) {
        Remove-Item -Recurse -Force $versionsRoot
    }
}

try {
    $remaining = @(Get-ChildItem -Force -Path $InstallRoot -ErrorAction Stop)
    if ($remaining.Count -eq 0) {
        Remove-Item -Force $InstallRoot
    }
}
catch {
    # Best effort: installation root may contain files unrelated to Buffaly.CodexEmbedded.
}

Write-Host "Uninstall complete."
Write-Host "Open a new terminal so PATH changes are picked up."
