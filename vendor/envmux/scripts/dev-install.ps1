<#
.SYNOPSIS
    Install this working tree as the `devenvmux` global command.

.DESCRIPTION
    Packs src/Envmux as a .NET global tool and installs it from a local folder,
    so you can exercise envmux from anywhere without a release, and without a
    half-built binary shadowing a real `envmux` on your PATH. The command is
    deliberately named differently for that reason.

    Re-run it after any change; it replaces whatever was installed before.

.PARAMETER Uninstall
    Remove the tool and the packed artifacts.

.PARAMETER Configuration
    Release by default. Debug is worth it when you want a usable stack trace.

.EXAMPLE
    .\scripts\dev-install.ps1
    devenvmux --dry-run

.EXAMPLE
    .\scripts\dev-install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$project = Join-Path $root 'src/Envmux/Envmux.csproj'
$output = Join-Path $root 'artifacts/tool'
$tool = 'devenvmux'

function Test-ToolInstalled {
    $listed = dotnet tool list --global 2>$null
    return [bool]($listed | Select-String -SimpleMatch -Pattern $tool -Quiet)
}

function Remove-Tool {
    # An install over an existing tool fails rather than replacing it, so the
    # uninstall is unconditional and its failure — "not found" on a first run —
    # is the expected case. Native stderr would otherwise be fatal under
    # ErrorActionPreference = Stop, which is why this is relaxed here and only
    # here.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        dotnet tool uninstall --global $tool *>$null
    }
    finally {
        $ErrorActionPreference = $previous
        $global:LASTEXITCODE = 0
    }

    if (-not (Test-ToolInstalled)) { return }

    # The uninstall failed and said so only into $null. The reason is almost
    # always a running copy holding its own dll: `dotnet tool install` then
    # prints "already installed", exits 0, and leaves the previous build in
    # place — so the next run tests code that was never installed. That cost an
    # evening once; it is a hard failure now.
    $running = @(Get-Process -Name $tool -ErrorAction SilentlyContinue)

    if ($running.Count -gt 0) {
        $pids = ($running | ForEach-Object { $_.Id }) -join ', '
        throw "$tool is still installed and $($running.Count) copy is running (pid $pids). Stop it and run this again."
    }

    throw "$tool could not be uninstalled, and installing over it would silently keep the old build."
}

if ($Uninstall) {
    Remove-Tool
    if (Test-Path $output) { Remove-Item -Recurse -Force $output }
    Write-Host "removed $tool" -ForegroundColor Cyan
    exit 0
}

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw 'dotnet is not on PATH. Install the .NET 10 SDK.'
}

Write-Host "packing $Configuration..." -ForegroundColor Cyan
if (Test-Path $output) { Remove-Item -Recurse -Force $output }

dotnet pack $project -c $Configuration -o $output --nologo
if ($LASTEXITCODE -ne 0) { throw 'pack failed' }

Remove-Tool

# Same trap from the other side: NuGet keeps a copy of every package it has seen
# under ~/.nuget/packages, keyed by id and version, and this package's version
# never changes. An install that resolves from there is an install of whatever
# was packed the first time.
$cached = Join-Path $env:USERPROFILE ".nuget\packages\$tool"
if (Test-Path $cached) { Remove-Item -Recurse -Force $cached -ErrorAction SilentlyContinue }

Write-Host "installing $tool..." -ForegroundColor Cyan
dotnet tool install --global --add-source $output --prerelease $tool
if ($LASTEXITCODE -ne 0) { throw 'install failed' }

Write-Host ''
Write-Host "$tool installed from $Configuration" -ForegroundColor Green
Write-Host ''
Write-Host '  devenvmux --dry-run          what a session here would be'
Write-Host '  devenvmux my-task            start one'
Write-Host '  devenvmux prune --dry-run    what is left lying around'
Write-Host ''

# A fresh tools directory is not on PATH until the shell is restarted, and the
# symptom is "command not found" straight after a successful install.
$toolsPath = Join-Path $env:USERPROFILE '.dotnet\tools'
if ($env:PATH -notlike "*$toolsPath*") {
    Write-Host "Add $toolsPath to PATH, or open a new terminal." -ForegroundColor Yellow
}
