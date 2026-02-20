[CmdletBinding()]
param(
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Release"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptRoot "..\..")).Path

Push-Location $repoRoot
try {
    Write-Host "Restoring solution packages..."
    dotnet restore "Buffaly.CodexEmbedded.sln"
    if ($LASTEXITCODE -ne 0) { throw "dotnet restore failed." }

    Write-Host "Building solution ($Configuration)..."
    dotnet build "Buffaly.CodexEmbedded.sln" -c $Configuration --no-restore
    if ($LASTEXITCODE -ne 0) { throw "dotnet build failed." }

    Write-Host "Running tests..."
    dotnet test "Buffaly.CodexEmbedded.Core.Tests\Buffaly.CodexEmbedded.Core.Tests.csproj" -c $Configuration --no-build
    if ($LASTEXITCODE -ne 0) { throw "dotnet test failed." }
}
finally {
    Pop-Location
}

Write-Host "Build script completed successfully."
