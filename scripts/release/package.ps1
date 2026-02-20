[CmdletBinding()]
param(
    [ValidateSet("win-x64", "linux-x64", "osx-x64", "osx-arm64")]
    [string]$Runtime = "win-x64",

    [Parameter(Mandatory = $true)]
    [string]$Version,

    [string]$Repository = "",

    [string]$PublishRoot = "artifacts/publish",

    [string]$OutputRoot = "artifacts/release"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptRoot "..\..")).Path
$publishRuntimeRoot = Join-Path (Join-Path $repoRoot $PublishRoot) $Runtime
$cliSource = Join-Path $publishRuntimeRoot "cli"
$webSource = Join-Path $publishRuntimeRoot "web"

if (-not (Test-Path $cliSource)) { throw "CLI publish output not found: $cliSource" }
if (-not (Test-Path $webSource)) { throw "Web publish output not found: $webSource" }

$outputRootFull = Join-Path $repoRoot $OutputRoot
$stageRoot = Join-Path $outputRootFull (Join-Path "stage" $Runtime)
$appsStage = Join-Path $stageRoot "apps"
$cliStage = Join-Path $appsStage "cli"
$webStage = Join-Path $appsStage "web"

if (Test-Path $stageRoot) {
    Remove-Item -Recurse -Force $stageRoot
}

New-Item -ItemType Directory -Force -Path $cliStage | Out-Null
New-Item -ItemType Directory -Force -Path $webStage | Out-Null

Write-Host "Staging publish outputs..."
Copy-Item -Recurse -Force (Join-Path $cliSource "*") $cliStage
Copy-Item -Recurse -Force (Join-Path $webSource "*") $webStage

$installerSourceRoot = Join-Path $repoRoot "install\package"
if (-not (Test-Path $installerSourceRoot)) {
    throw "Installer script folder not found: $installerSourceRoot"
}

Write-Host "Staging installer scripts..."
Copy-Item -Recurse -Force (Join-Path $installerSourceRoot "*") $stageRoot

$packageFileName = "Buffaly.CodexEmbedded-$Runtime-$Version.zip"
$packagePath = Join-Path $outputRootFull $packageFileName
if (Test-Path $packagePath) {
    Remove-Item -Force $packagePath
}

$manifest = [ordered]@{
    productName      = "Buffaly.CodexEmbedded"
    version          = $Version
    runtime          = $Runtime
    repository       = $Repository
    packageFileName  = $packageFileName
    generatedUtc     = (Get-Date).ToUniversalTime().ToString("O")
}

$manifestPath = Join-Path $stageRoot "release-manifest.json"
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $manifestPath -Encoding UTF8

Write-Host "Creating package zip..."
New-Item -ItemType Directory -Force -Path $outputRootFull | Out-Null
Compress-Archive -Path (Join-Path $stageRoot "*") -DestinationPath $packagePath -Force

$hash = (Get-FileHash -Path $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
$checksumPath = Join-Path $outputRootFull "SHA256SUMS-$Runtime-$Version.txt"
"$hash  $packageFileName" | Set-Content -Path $checksumPath -Encoding ascii

Write-Host "Package created:"
Write-Host "  $packagePath"
Write-Host "Checksum file:"
Write-Host "  $checksumPath"
