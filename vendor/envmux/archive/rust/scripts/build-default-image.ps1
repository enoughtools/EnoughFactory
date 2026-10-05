<#
.SYNOPSIS
    Build the default envmux image and tag it as the reference generated
    configurations point at.

.DESCRIPTION
    `envmux config generate` writes

        [image]
        reference = "ghcr.io/strigops-io/envmux-default:0.1.0"

    and the daemon pulls a reference only when no image with that tag exists
    locally. Until that tag is published, a fresh project in a sibling
    directory fails at `envmux up` with a registry error.

    Building images/default.Dockerfile under exactly that tag makes the pull
    unnecessary: every adjacent project using the generated default finds the
    image already on this machine, with plain `docker build` and no registry,
    credentials, or buildx involved.

    The tag is read out of the starter template so the two cannot drift.

.PARAMETER Reference
    Tag to build instead of the one the starter template declares.

.PARAMETER Force
    Rebuild even when the tag is already present.

.EXAMPLE
    .\scripts\build-default-image.ps1
    .\scripts\build-default-image.ps1 -Force
#>
[CmdletBinding()]
param(
    [string]$Reference,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# PowerShell 7.4 turns a non-zero exit from a native command into a
# terminating error under `Stop`. Every docker call here is checked through
# $LASTEXITCODE, and "image not present" is an answer rather than a failure.
$PSNativeCommandUseErrorActionPreference = $false

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Dockerfile = Join-Path $RepoRoot 'images\default.Dockerfile'
$FallbackReference = 'ghcr.io/strigops-io/envmux-default:0.1.0'

function Write-Step { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Note { param([string]$Message) Write-Host "    $Message" -ForegroundColor DarkGray }

function Get-StarterReference {
    # The one place the default is written down for users.
    $generate = Join-Path $RepoRoot 'crates\envmux-config\src\generate.rs'
    if (Test-Path $generate) {
        $match = Select-String -Path $generate -Pattern 'reference = "([^"]*envmux-default:[^"]+)"' |
            Select-Object -First 1
        if ($match) { return $match.Matches[0].Groups[1].Value }
    }
    return $FallbackReference
}

function Test-ImagePresent {
    param([string]$Tag)
    try { docker image inspect $Tag 2>$null | Out-Null } catch { return $false }
    return $LASTEXITCODE -eq 0
}

if (-not $Reference) {
    if ($env:ENVMUX_DEFAULT_IMAGE) { $Reference = $env:ENVMUX_DEFAULT_IMAGE }
    else { $Reference = Get-StarterReference }
}

if (-not (Test-Path $Dockerfile)) { throw "missing $Dockerfile" }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'docker not found. Install Docker Desktop (Linux containers) and try again.'
}
docker version --format '{{.Server.Version}}' 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'the Docker engine is not reachable. Start Docker Desktop and try again.'
}

if (-not $Force -and (Test-ImagePresent $Reference)) {
    Write-Note "image $Reference already present (-Force rebuilds)"
    exit 0
}

Write-Step "Building $Reference"
Write-Note 'first build pulls a Debian/Node base and several toolchains; expect minutes'
docker build --tag $Reference --file $Dockerfile $RepoRoot
if ($LASTEXITCODE -ne 0) {
    Write-Error "docker build failed (exit $LASTEXITCODE)"
    exit 1
}

Write-Host ''
Write-Host "$Reference is ready locally." -ForegroundColor Green
Write-Host 'Projects whose .envmux.toml declares it will use this image without a pull.'
# Explicit, so a caller reading $LASTEXITCODE sees this script's result rather
# than whatever the last native command in it happened to leave behind.
exit 0
