[CmdletBinding()]
param(
    [string]$InstallRoot = "",
    [switch]$SkipPathUpdate,
    [switch]$Force,
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
        throw "Could not determine a writable user profile folder for installation."
    }

    return Join-Path $userProfile "AppData\Local\Buffaly.CodexEmbedded"
}

function Normalize-PathEntry([string]$Value) {
    return $Value.Trim().TrimEnd('\')
}

function Ensure-UserPathContains([string]$PathEntry) {
    $normalizedNew = Normalize-PathEntry $PathEntry
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $entries = @()
    if (-not [string]::IsNullOrWhiteSpace($userPath)) {
        $entries = @($userPath.Split(';', [System.StringSplitOptions]::RemoveEmptyEntries))
    }

    foreach ($entry in $entries) {
        if ([string]::Equals((Normalize-PathEntry $entry), $normalizedNew, [StringComparison]::OrdinalIgnoreCase)) {
            return $false
        }
    }

    $newUserPath = if ($entries.Count -eq 0) { $PathEntry } else { ($entries + $PathEntry) -join ';' }
    [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
    $env:Path = "$PathEntry;$env:Path"
    return $true
}

function Copy-ConfigIfPresent([string]$SourcePath, [string]$TargetPath) {
    if ((Test-Path $SourcePath) -and (Test-Path $TargetPath)) {
        Copy-Item -Force $SourcePath $TargetPath
    }
}

function Write-ExecutableWrapper([string]$WrapperPath, [string]$ExecutableRelativePath) {
    $content = @"
@echo off
setlocal
set "ROOT=%~dp0.."
if not exist "%ROOT%\active-version.txt" (
  echo Buffaly.CodexEmbedded is not installed. Run install.ps1 again.
  exit /b 1
)
set /p VERSION=<"%ROOT%\active-version.txt"
set "TARGET=%ROOT%\versions\%VERSION%\$ExecutableRelativePath"
if not exist "%TARGET%" (
  echo Missing executable: "%TARGET%"
  exit /b 1
)
for %%I in ("%TARGET%") do set "APPDIR=%%~dpI"
pushd "%APPDIR%" >nul
"%TARGET%" %*
set "EXITCODE=%ERRORLEVEL%"
popd >nul
exit /b %EXITCODE%
"@

    Set-Content -Path $WrapperPath -Value $content -Encoding ascii
}

function Write-ScriptWrapper([string]$WrapperPath, [string]$ScriptFileName) {
    $content = @"
@echo off
setlocal
set "ROOT=%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\$ScriptFileName" %*
exit /b %ERRORLEVEL%
"@

    Set-Content -Path $WrapperPath -Value $content -Encoding ascii
}

if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    $InstallRoot = Get-DefaultInstallRoot
}

$scriptRoot = (Resolve-Path (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$manifestPath = Join-Path $scriptRoot "release-manifest.json"
$appsSourceRoot = Join-Path $scriptRoot "apps"
$cliSourceRoot = Join-Path $appsSourceRoot "cli"
$webSourceRoot = Join-Path $appsSourceRoot "web"

if (-not (Test-Path $manifestPath)) {
    throw "release-manifest.json was not found. Run this script from the extracted release package folder."
}

if (-not (Test-Path $cliSourceRoot)) {
    throw "apps\cli folder was not found in this package."
}

if (-not (Test-Path $webSourceRoot)) {
    throw "apps\web folder was not found in this package."
}

$manifest = Get-Content -Raw -Path $manifestPath | ConvertFrom-Json
$version = [string]$manifest.version
if ([string]::IsNullOrWhiteSpace($version)) {
    throw "Invalid release-manifest.json: missing version."
}

if (-not $NoPrompt) {
    Write-Host "Buffaly.CodexEmbedded installer" -ForegroundColor Cyan
    Write-Host "  Version: $version"
    Write-Host "  Install folder: $InstallRoot"
    $answer = Read-Host "Continue? (Y/N)"
    if ($answer -notmatch '^(?i)y(es)?$') {
        throw "Installation cancelled."
    }
}

$versionsRoot = Join-Path $InstallRoot "versions"
$newVersionRoot = Join-Path $versionsRoot $version
$newAppsRoot = Join-Path $newVersionRoot "apps"
$activeVersionPath = Join-Path $InstallRoot "active-version.txt"
$binRoot = Join-Path $InstallRoot "bin"

$previousVersion = $null
if (Test-Path $activeVersionPath) {
    $previousVersion = (Get-Content -Raw -Path $activeVersionPath).Trim()
}

New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
New-Item -ItemType Directory -Force -Path $versionsRoot | Out-Null
New-Item -ItemType Directory -Force -Path $binRoot | Out-Null

if ((Test-Path $newVersionRoot) -and $Force) {
    Remove-Item -Recurse -Force $newVersionRoot
}

if (-not (Test-Path $newVersionRoot)) {
    New-Item -ItemType Directory -Force -Path $newAppsRoot | Out-Null
    $newCliRoot = Join-Path $newAppsRoot "cli"
    $newWebRoot = Join-Path $newAppsRoot "web"
    New-Item -ItemType Directory -Force -Path $newCliRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $newWebRoot | Out-Null
    Copy-Item -Recurse -Force (Join-Path $cliSourceRoot "*") $newCliRoot
    Copy-Item -Recurse -Force (Join-Path $webSourceRoot "*") $newWebRoot
    Copy-Item -Force $manifestPath (Join-Path $newVersionRoot "release-manifest.json")
}

if (-not [string]::IsNullOrWhiteSpace($previousVersion) -and
    -not [string]::Equals($previousVersion, $version, [StringComparison]::OrdinalIgnoreCase)) {
    $previousRoot = Join-Path $versionsRoot $previousVersion

    Copy-ConfigIfPresent `
        (Join-Path $previousRoot "apps\cli\appsettings.json") `
        (Join-Path $newVersionRoot "apps\cli\appsettings.json")
    Copy-ConfigIfPresent `
        (Join-Path $previousRoot "apps\web\appsettings.json") `
        (Join-Path $newVersionRoot "apps\web\appsettings.json")
}

Set-Content -Path $activeVersionPath -Value $version -Encoding ascii
Copy-Item -Force $manifestPath (Join-Path $InstallRoot "release-manifest.json")
Copy-Item -Force (Join-Path $scriptRoot "update.ps1") (Join-Path $InstallRoot "update.ps1")
Copy-Item -Force (Join-Path $scriptRoot "uninstall.ps1") (Join-Path $InstallRoot "uninstall.ps1")

Write-ExecutableWrapper `
    (Join-Path $binRoot "buffaly.cmd") `
    "apps\cli\Buffaly.CodexEmbedded.Cli.exe"
Write-ExecutableWrapper `
    (Join-Path $binRoot "buffaly-web.cmd") `
    "apps\web\Buffaly.CodexEmbedded.Web.exe"
Write-ScriptWrapper `
    (Join-Path $binRoot "buffaly-update.cmd") `
    "update.ps1"
Write-ScriptWrapper `
    (Join-Path $binRoot "buffaly-uninstall.cmd") `
    "uninstall.ps1"

$pathChanged = $false
if (-not $SkipPathUpdate) {
    $pathChanged = Ensure-UserPathContains $binRoot
}

Write-Host ""
Write-Host "Installation complete." -ForegroundColor Green
Write-Host "  Installed version: $version"
Write-Host "  Install folder: $InstallRoot"
Write-Host "  Commands:"
Write-Host "    buffaly"
Write-Host "    buffaly-web"
Write-Host "    buffaly-update"
Write-Host "    buffaly-uninstall"

if ($pathChanged) {
    Write-Host ""
    Write-Host "PATH was updated for your user account. Open a new terminal before running commands."
}
elseif ($SkipPathUpdate) {
    Write-Host ""
    Write-Host "PATH update was skipped. Add this folder to PATH manually:"
    Write-Host "  $binRoot"
}
