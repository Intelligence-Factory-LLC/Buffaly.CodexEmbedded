[CmdletBinding()]
param(
    [ValidateSet("win-x64", "linux-x64", "osx-x64", "osx-arm64")]
    [string]$Runtime = "win-x64",

    [Parameter(Mandatory = $true)]
    [string]$Version,

    [string]$PublishRoot = "artifacts/publish",

    [string]$OutputRoot = "artifacts/release"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-RepoRoot {
    # Use script-scoped path variables; inside a function, $MyInvocation.MyCommand is a FunctionInfo (no .Path).
    $scriptRoot = $PSScriptRoot
    if ([string]::IsNullOrWhiteSpace($scriptRoot)) {
        $scriptRoot = Split-Path -Parent $PSCommandPath
    }
    return (Resolve-Path (Join-Path $scriptRoot "..\\..")).Path
}

function Get-Md5Hex([string]$Value) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    $md5 = [Security.Cryptography.MD5]::Create()
    try {
        $hash = $md5.ComputeHash($bytes)
    }
    finally {
        $md5.Dispose()
    }
    return ([BitConverter]::ToString($hash)).Replace("-", "").ToLowerInvariant()
}

function New-DeterministicGuid([string]$Seed) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Seed)
    $md5 = [Security.Cryptography.MD5]::Create()
    try {
        $hash = $md5.ComputeHash($bytes)
    }
    finally {
        $md5.Dispose()
    }
    return [Guid]::new($hash)
}

function Convert-TagToMsiVersion([string]$Tag) {
    $m = [Regex]::Match($Tag.Trim(), '^v(?<year>\d{4})\.(?<month>\d{2})\.(?<day>\d{2})\.(?<seq>\d{2})$')
    if (-not $m.Success) {
        throw "MSI version conversion expects a tag like v2026.03.01.01. Got: '$Tag'"
    }

    $year = [int]$m.Groups["year"].Value
    $month = [int]$m.Groups["month"].Value
    $day = [int]$m.Groups["day"].Value
    $seq = [int]$m.Groups["seq"].Value

    if ($seq -ge 100) {
        throw "Sequence must be < 100 for MSI version mapping. Got: $seq"
    }

    $major = $year % 100
    $minor = $month
    $build = ($day * 100) + $seq

    if ($major -gt 255 -or $minor -gt 255 -or $build -gt 65535) {
        throw "MSI version out of range after mapping: $major.$minor.$build"
    }

    return "$major.$minor.$build"
}

function Build-DirectoryTree([string[]]$DirectoryPaths) {
    $tree = @{}
    foreach ($dir in $DirectoryPaths) {
        if ([string]::IsNullOrWhiteSpace($dir)) { continue }
        $parts = @($dir -split '[\\\\/]' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        $cursor = $tree
        foreach ($part in $parts) {
            if (-not $cursor.ContainsKey($part)) {
                $cursor[$part] = @{}
            }
            $cursor = $cursor[$part]
        }
    }
    return $tree
}

function Write-DirectoryElements([hashtable]$Tree, [string]$SeedPrefix, [string]$ParentRelPath, [System.Text.StringBuilder]$Sb, [int]$Indent, [hashtable]$DirIdByRelPath) {
    $indentText = (" " * $Indent)
    foreach ($name in @($Tree.Keys | Sort-Object)) {
        $relPath = if ([string]::IsNullOrWhiteSpace($ParentRelPath)) { $name } else { Join-Path $ParentRelPath $name }
        $normalizedRel = $relPath.Replace("/", "\\")

        $hex = Get-Md5Hex("$SeedPrefix|$normalizedRel")
        if ([string]::IsNullOrWhiteSpace($hex) -or $hex.Length -lt 24) {
            throw "MD5 hex was unexpectedly short for '$SeedPrefix|$normalizedRel'. Value: '$hex'"
        }
        $id = "dir_" + $hex.Substring(0, 24)
        $DirIdByRelPath[$normalizedRel] = $id

        [void]$Sb.AppendLine("$indentText<Directory Id=""$id"" Name=""$name"">")
        Write-DirectoryElements -Tree $Tree[$name] -SeedPrefix $SeedPrefix -ParentRelPath $normalizedRel -Sb $Sb -Indent ($Indent + 2) -DirIdByRelPath $DirIdByRelPath
        [void]$Sb.AppendLine("$indentText</Directory>")
    }
}

function Write-WixFragmentsForPublishRoot([string]$SourceRoot, [string]$RootDirId, [string]$GroupId, [string]$SeedPrefix, [string]$OutDirWxs, [string]$OutFilesWxs) {
    if (-not (Test-Path $SourceRoot)) {
        throw "Publish folder not found: $SourceRoot"
    }

    $files = @(Get-ChildItem -Path $SourceRoot -Recurse -File)
    if ($files.Count -eq 0) {
        throw "No files found under: $SourceRoot"
    }

    $allRelDirs = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in $files) {
        $relative = [IO.Path]::GetRelativePath($SourceRoot, $file.FullName).Replace("/", "\\")
        $relDir = Split-Path -Parent $relative
        if (-not [string]::IsNullOrWhiteSpace($relDir) -and $relDir -ne ".") {
            # Add this directory and all parents so the tree is complete.
            $cursor = $relDir
            while (-not [string]::IsNullOrWhiteSpace($cursor) -and $cursor -ne ".") {
                $allRelDirs.Add($cursor) | Out-Null
                $cursor = Split-Path -Parent $cursor
            }
        }
    }

    $dirPaths = @($allRelDirs | ForEach-Object { $_ })
    $dirTree = Build-DirectoryTree -DirectoryPaths $dirPaths
    $dirIdByRelPath = @{}

    $dirSb = [System.Text.StringBuilder]::new()
    [void]$dirSb.AppendLine("<?xml version=""1.0"" encoding=""utf-8""?>")
    [void]$dirSb.AppendLine("<Wix xmlns=""http://wixtoolset.org/schemas/v4/wxs"">")
    [void]$dirSb.AppendLine("  <Fragment>")
    [void]$dirSb.AppendLine("    <DirectoryRef Id=""$RootDirId"">")
    Write-DirectoryElements -Tree $dirTree -SeedPrefix $SeedPrefix -ParentRelPath "" -Sb $dirSb -Indent 6 -DirIdByRelPath $dirIdByRelPath
    [void]$dirSb.AppendLine("    </DirectoryRef>")
    [void]$dirSb.AppendLine("  </Fragment>")
    [void]$dirSb.AppendLine("</Wix>")
    Set-Content -Path $OutDirWxs -Value $dirSb.ToString() -Encoding utf8

    $groupSb = [System.Text.StringBuilder]::new()
    $componentsSb = [System.Text.StringBuilder]::new()

    [void]$groupSb.AppendLine("<?xml version=""1.0"" encoding=""utf-8""?>")
    [void]$groupSb.AppendLine("<Wix xmlns=""http://wixtoolset.org/schemas/v4/wxs"">")
    [void]$groupSb.AppendLine("  <Fragment>")
    [void]$groupSb.AppendLine("    <ComponentGroup Id=""$GroupId"">")

    [void]$componentsSb.AppendLine("  <Fragment>")

    foreach ($file in $files | Sort-Object FullName) {
        $relative = [IO.Path]::GetRelativePath($SourceRoot, $file.FullName).Replace("/", "\\")
        $relDir = Split-Path -Parent $relative
        $normalizedRelDir = if ([string]::IsNullOrWhiteSpace($relDir) -or $relDir -eq ".") { "" } else { $relDir.Replace("/", "\\") }

        $directoryId = $RootDirId
        if (-not [string]::IsNullOrWhiteSpace($normalizedRelDir)) {
            $directoryId = $dirIdByRelPath[$normalizedRelDir]
            if ([string]::IsNullOrWhiteSpace($directoryId)) {
                throw "Missing directory id mapping for '$normalizedRelDir' under '$SourceRoot'."
            }
        }

        $seed = "$SeedPrefix|$relative"
        $cmpHex = Get-Md5Hex("cmp|$seed")
        if ([string]::IsNullOrWhiteSpace($cmpHex) -or $cmpHex.Length -lt 24) {
            throw "MD5 hex was unexpectedly short for component seed '$seed'. Value: '$cmpHex'"
        }
        $fileHex = Get-Md5Hex("fil|$seed")
        if ([string]::IsNullOrWhiteSpace($fileHex) -or $fileHex.Length -lt 24) {
            throw "MD5 hex was unexpectedly short for file seed '$seed'. Value: '$fileHex'"
        }

        $cmpId = "cmp_" + $cmpHex.Substring(0, 24)
        $fileId = "fil_" + $fileHex.Substring(0, 24)
        $guid = New-DeterministicGuid("guid|$seed")

        [void]$groupSb.AppendLine("      <ComponentRef Id=""$cmpId"" />")

        [void]$componentsSb.AppendLine("    <Component Id=""$cmpId"" Guid=""$guid"" Directory=""$directoryId"">")
        [void]$componentsSb.AppendLine("      <File Id=""$fileId"" Source=""$($file.FullName)"" KeyPath=""yes"" />")
        [void]$componentsSb.AppendLine("    </Component>")
    }

    [void]$componentsSb.AppendLine("  </Fragment>")

    [void]$groupSb.AppendLine("    </ComponentGroup>")
    [void]$groupSb.AppendLine("  </Fragment>")
    [void]$groupSb.AppendLine($componentsSb.ToString().TrimEnd())
    [void]$groupSb.AppendLine("</Wix>")

    Set-Content -Path $OutFilesWxs -Value $groupSb.ToString() -Encoding utf8
}

$repoRoot = Get-RepoRoot

if ($Runtime -ne "win-x64") {
    throw "MSI packaging is only supported for win-x64. Got: $Runtime"
}

if (-not (Get-Command wix -ErrorAction SilentlyContinue)) {
    throw "WiX tool not found. Install with: dotnet tool install --global wix"
}

$publishRuntimeRoot = Join-Path (Join-Path $repoRoot $PublishRoot) $Runtime
$cliSource = Join-Path $publishRuntimeRoot "cli"
$webSource = Join-Path $publishRuntimeRoot "web"
if (-not (Test-Path $cliSource)) { throw "CLI publish output not found: $cliSource" }
if (-not (Test-Path $webSource)) { throw "Web publish output not found: $webSource" }

$msiVersion = Convert-TagToMsiVersion $Version

$outputRootFull = Join-Path $repoRoot $OutputRoot
New-Item -ItemType Directory -Force -Path $outputRootFull | Out-Null

$msiName = "Buffaly.CodexEmbedded-$Runtime-$Version.msi"
$msiPath = Join-Path $outputRootFull $msiName
if (Test-Path $msiPath) { Remove-Item -Force $msiPath }

$stageRoot = Join-Path $repoRoot "artifacts\\installer\\msi\\$Runtime"
if (Test-Path $stageRoot) {
    Remove-Item -Recurse -Force $stageRoot
}
New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null

$cliDirsWxs = Join-Path $stageRoot "Directories.Cli.wxs"
$cliFilesWxs = Join-Path $stageRoot "Files.Cli.wxs"
$webDirsWxs = Join-Path $stageRoot "Directories.Web.wxs"
$webFilesWxs = Join-Path $stageRoot "Files.Web.wxs"

$productTemplate = Join-Path $repoRoot "installer\\wix\\Product.wxs"
$productGenerated = Join-Path $stageRoot "Product.generated.wxs"
$binWxs = Join-Path $repoRoot "installer\\wix\\Bin.wxs"

if (-not (Test-Path $productTemplate)) { throw "Missing WiX template: $productTemplate" }
if (-not (Test-Path $binWxs)) { throw "Missing WiX file: $binWxs" }

$productXml = Get-Content -Raw -Path $productTemplate
if ($productXml -notmatch "__PRODUCT_VERSION__") {
    throw "Product.wxs does not contain __PRODUCT_VERSION__ placeholder."
}
$productXml = $productXml.Replace("__PRODUCT_VERSION__", $msiVersion)
Set-Content -Path $productGenerated -Value $productXml -Encoding utf8

Write-Host "Generating WiX fragments for CLI..."
Write-WixFragmentsForPublishRoot -SourceRoot $cliSource -RootDirId "CLIDIR" -GroupId "CliFiles" -SeedPrefix "cli" -OutDirWxs $cliDirsWxs -OutFilesWxs $cliFilesWxs

Write-Host "Generating WiX fragments for Web host..."
Write-WixFragmentsForPublishRoot -SourceRoot $webSource -RootDirId "WEBDIR" -GroupId "WebFiles" -SeedPrefix "web" -OutDirWxs $webDirsWxs -OutFilesWxs $webFilesWxs

Write-Host "Building MSI..."
Push-Location $repoRoot
try {
    wix build `
        $productGenerated `
        $binWxs `
        $cliDirsWxs `
        $cliFilesWxs `
        $webDirsWxs `
        $webFilesWxs `
        -arch x64 `
        -o $msiPath
    if ($LASTEXITCODE -ne 0) { throw "wix build failed with exit code $LASTEXITCODE" }
}
finally {
    Pop-Location
}

Write-Host "MSI created:"
Write-Host "  $msiPath"
