[CmdletBinding()]
param(
    [ValidateSet("win-x64", "linux-x64", "osx-x64", "osx-arm64")]
    [string]$Runtime = "win-x64",

    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Release",

    [string]$OutputRoot = "artifacts/publish"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptRoot "..\..")).Path
$publishRoot = Join-Path $repoRoot $OutputRoot
$runtimeRoot = Join-Path $publishRoot $Runtime
$cliOut = Join-Path $runtimeRoot "cli"
$webOut = Join-Path $runtimeRoot "web"

if (Test-Path $runtimeRoot) {
    Remove-Item -Recurse -Force $runtimeRoot
}

New-Item -ItemType Directory -Force -Path $cliOut | Out-Null
New-Item -ItemType Directory -Force -Path $webOut | Out-Null

Push-Location $repoRoot
try {
    Write-Host "Publishing CLI ($Runtime, $Configuration)..."
    dotnet publish "Buffaly.CodexEmbedded.Cli\Buffaly.CodexEmbedded.Cli.csproj" `
        -c $Configuration `
        -r $Runtime `
        --self-contained true `
        -o $cliOut `
        /p:PublishSingleFile=true `
        /p:IncludeNativeLibrariesForSelfExtract=true `
        /p:EnableCompressionInSingleFile=true `
        /p:PublishTrimmed=false
    if ($LASTEXITCODE -ne 0) { throw "CLI publish failed." }

    Write-Host "Publishing Web host ($Runtime, $Configuration)..."
    dotnet publish "Buffaly.CodexEmbedded.Web\Buffaly.CodexEmbedded.Web.csproj" `
        -c $Configuration `
        -r $Runtime `
        --self-contained true `
        -o $webOut `
        /p:PublishTrimmed=false
    if ($LASTEXITCODE -ne 0) { throw "Web publish failed." }
}
finally {
    Pop-Location
}

Write-Host "Publish output root: $runtimeRoot"
