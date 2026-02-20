[CmdletBinding()]
param(
    [string]$InstallRoot = "",
    [string]$Repository = "",
    [switch]$Force
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

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Get-DefaultInstallRoot
}

$activeVersionPath = Join-Path $InstallRoot "active-version.txt"
if (-not (Test-Path $activeVersionPath)) {
    throw "No active installation found at '$InstallRoot'."
}

$currentVersion = (Get-Content -Raw -Path $activeVersionPath).Trim()
$currentManifestPath = Join-Path $InstallRoot "versions\$currentVersion\release-manifest.json"
if (-not (Test-Path $currentManifestPath)) {
    $currentManifestPath = Join-Path $InstallRoot "release-manifest.json"
}

if (-not (Test-Path $currentManifestPath)) {
    throw "Cannot locate release metadata for the current installation."
}

$manifest = Get-Content -Raw -Path $currentManifestPath | ConvertFrom-Json
$runtime = [string]$manifest.runtime

if ([string]::IsNullOrWhiteSpace($runtime)) {
    $runtime = "win-x64"
}

if ([string]::IsNullOrWhiteSpace($Repository)) {
    $Repository = [string]$manifest.repository
}

if ([string]::IsNullOrWhiteSpace($Repository)) {
    throw "Repository is required for automatic updates. Re-run with -Repository owner/repo."
}

$headers = @{
    "Accept" = "application/vnd.github+json"
    "User-Agent" = "Buffaly.CodexEmbedded-Updater"
}

$latestReleaseUri = "https://api.github.com/repos/$Repository/releases/latest"
Write-Host "Checking latest release from $Repository..."
$latestRelease = Invoke-RestMethod -Uri $latestReleaseUri -Headers $headers -Method Get

$latestVersion = [string]$latestRelease.tag_name
if (-not $Force -and [string]::Equals($currentVersion, $latestVersion, [StringComparison]::OrdinalIgnoreCase)) {
    Write-Host "Already on latest version ($currentVersion)."
    return
}

$runtimePattern = "^Buffaly\.CodexEmbedded-$([Regex]::Escape($runtime))-.+\.zip$"
$asset = $latestRelease.assets | Where-Object { $_.name -match $runtimePattern } | Select-Object -First 1
if ($null -eq $asset) {
    throw "No release asset found for runtime '$runtime'."
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("buffaly-update-" + [Guid]::NewGuid().ToString("N"))
$downloadPath = Join-Path $tempRoot $asset.name
$extractRoot = Join-Path $tempRoot "extracted"

New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null

try {
    Write-Host "Downloading $($asset.name)..."
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $downloadPath -Headers $headers

    Write-Host "Extracting package..."
    Expand-Archive -Path $downloadPath -DestinationPath $extractRoot -Force

    $installerPath = Join-Path $extractRoot "install.ps1"
    if (-not (Test-Path $installerPath)) {
        throw "The release package is missing install.ps1."
    }

    Write-Host "Installing version $latestVersion..."
    & powershell -NoProfile -ExecutionPolicy Bypass -File $installerPath -InstallRoot $InstallRoot -NoPrompt
    if ($LASTEXITCODE -ne 0) {
        throw "Install script failed with exit code $LASTEXITCODE."
    }
}
finally {
    if (Test-Path $tempRoot) {
        Remove-Item -Recurse -Force $tempRoot
    }
}

Write-Host "Update complete. Current version: $latestVersion"
