<#
.SYNOPSIS
    Build and install the self-contained `envmux` binary a release ships.

.DESCRIPTION
    The other half of scripts/dev-install.ps1. That one packs this tree as a
    .NET global tool called `devenvmux`, which is right for iterating and wrong
    for the last check before a release: a global tool runs on the SDK that is
    already on the machine, under a command name nothing in the documentation
    mentions.

    This publishes exactly what the canary job publishes — self-contained,
    single file, compressed, stamped with the UTC minute — for this machine's
    platform, and drops it in ~/.envmux/bin as `envmux`. So what you test is
    the artifact somebody downloads, under the name every page tells them to
    type, with no .NET install standing behind it.

    It lives beside the rest of envmux's state on purpose. Uninstalling envmux
    is deleting ~/.envmux, and a binary somewhere else would survive that and
    keep answering.

.PARAMETER Rid
    The runtime identifier to publish for. This machine's, by default. The
    canary builds win-x64, win-arm64, linux-x64, linux-arm64, osx-x64 and
    osx-arm64; naming another one here is for reproducing a platform-specific
    report, and the result will not run here.

.PARAMETER Version
    The version stamp, which is what `envmux --version` answers. Defaults to
    the UTC minute, in the same format the canary uses, so a binary can always
    be matched back to when it was built.

.PARAMETER Archive
    Also write the zip or tarball the canary attaches to the release, and a
    SHA256SUMS.txt beside it, under artifacts/dist. For checking what people
    download rather than what you installed.

.PARAMETER Path
    Add ~/.envmux/bin to this account's PATH without asking. Without it the
    script asks, and prints the one line to add if you decline.

.PARAMETER Uninstall
    Remove the binary, and the PATH entry if this script added one.

.EXAMPLE
    .\scripts\release-install.ps1
    envmux --version

.EXAMPLE
    .\scripts\release-install.ps1 -Archive
    # artifacts/dist/envmux-2026.08.27.0604-win-x64.zip

.EXAMPLE
    .\scripts\release-install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string]$Rid,
    [string]$Version,
    [switch]$Archive,
    [switch]$Path,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$project = Join-Path $root 'src/Envmux/Envmux.csproj'
$stage = Join-Path $root 'artifacts/stage'
$dist = Join-Path $root 'artifacts/dist'

$home_ = [Environment]::GetFolderPath('UserProfile')
$prefix = if ($env:ENVMUX_HOME) { $env:ENVMUX_HOME } else { Join-Path $home_ '.envmux' }
$bin = Join-Path $prefix 'bin'
$exe = if ($IsLinux -or $IsMacOS) { 'envmux' } else { 'envmux.exe' }
$installed = Join-Path $bin $exe

# This machine, spelled the way `dotnet publish --runtime` spells it.
function Get-HostRid {
    $os =
        if ($IsLinux) { 'linux' }
        elseif ($IsMacOS) { 'osx' }
        else { 'win' }

    # PROCESSOR_ARCHITECTURE rather than RuntimeInformation, because this script
    # has to parse under Windows PowerShell 5.1 as well as pwsh, and the two
    # disagree about which of these types are loaded.
    $architecture =
        if ($IsLinux -or $IsMacOS) {
            switch (uname -m) {
                'arm64' { 'arm64' }
                'aarch64' { 'arm64' }
                default { 'x64' }
            }
        }
        else {
            switch ($env:PROCESSOR_ARCHITECTURE) {
                'ARM64' { 'arm64' }
                default { 'x64' }
            }
        }

    return "$os-$architecture"
}

# A running copy holds its own file open on Windows, and the publish then fails
# several minutes in with an access denied that names a path and nothing else.
# The same trap dev-install.ps1 carries a comment about, from the other side.
function Assert-NotRunning {
    $running = @(Get-Process -Name 'envmux' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -eq $installed })

    if ($running.Count -eq 0) { return }

    $pids = ($running | ForEach-Object { $_.Id }) -join ', '
    throw "$installed is running (pid $pids). Quit it and run this again."
}

# The user PATH, read and written whole. Windows only: editing a shell's rc file
# is that shell's business and somebody else's opinion, so elsewhere this prints
# the line instead.
function Add-ToPath {
    if ($IsLinux -or $IsMacOS) { return $false }

    $current = [Environment]::GetEnvironmentVariable('PATH', 'User')
    $entries = @($current -split ';' | Where-Object { $_ })

    if ($entries -contains $bin) { return $true }

    [Environment]::SetEnvironmentVariable('PATH', (@($entries) + $bin) -join ';', 'User')
    return $true
}

function Remove-FromPath {
    if ($IsLinux -or $IsMacOS) { return }

    $current = [Environment]::GetEnvironmentVariable('PATH', 'User')
    $entries = @($current -split ';' | Where-Object { $_ })

    if ($entries -notcontains $bin) { return }

    [Environment]::SetEnvironmentVariable(
        'PATH', (@($entries | Where-Object { $_ -ne $bin })) -join ';', 'User')
}

if ($Uninstall) {
    Assert-NotRunning
    if (Test-Path $installed) { Remove-Item -Force $installed }
    Remove-FromPath

    # The directory only, never the one above it: that holds host.json, the
    # certificates and the VM's disks, and this script did not put them there.
    if ((Test-Path $bin) -and -not (Get-ChildItem $bin -Force)) { Remove-Item -Force $bin }

    Write-Host "removed $installed" -ForegroundColor Cyan
    exit 0
}

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw 'dotnet is not on PATH. Install the .NET 10 SDK.'
}

if (-not $Rid) { $Rid = Get-HostRid }
if (-not $Version) { $Version = [DateTime]::UtcNow.ToString('yyyy.MM.dd.HHmm') }

# A release always has the portal page in it, because the release job always has
# Node. Without one here the binary still builds, still runs and still routes —
# and its portal answers "built without Node", which is exactly the thing a
# release must never be. Said before the five minutes rather than after.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'no Node on PATH - the portal page will not be in this binary.' -ForegroundColor Yellow
    Write-Host 'A real release always has one. Install Node and run this again to match it.' -ForegroundColor Yellow
    Write-Host ''
}

Assert-NotRunning

Write-Host "publishing $Rid..." -ForegroundColor Cyan

$output = Join-Path $stage $Rid
if (Test-Path $output) { Remove-Item -Recurse -Force $output }

# Every flag here is the canary job's, and they are here to be identical rather
# than merely similar: --self-contained so it needs no runtime, single file and
# compression from the csproj and the flag below, and DebugType=none so what
# ships is one file and not a file with a .pdb beside it.
dotnet publish $project `
    --configuration Release `
    --runtime $Rid `
    --self-contained true `
    -p:Version=$Version `
    -p:InformationalVersion=$Version `
    -p:EnableCompressionInSingleFile=true `
    -p:DebugType=none `
    --output $output `
    --nologo

if ($LASTEXITCODE -ne 0) { throw 'publish failed' }

$published = Join-Path $output $exe
if (-not (Test-Path $published)) { throw "publish produced no $exe in $output" }

New-Item -ItemType Directory -Force -Path $bin | Out-Null
Copy-Item -Force $published $installed

if ($IsLinux -or $IsMacOS) { chmod +x $installed }

$size = [Math]::Round((Get-Item $installed).Length / 1MB, 1)

if ($Archive) {
    New-Item -ItemType Directory -Force -Path $dist | Out-Null

    # Named for the platform and the stamp, the way the release names them, so a
    # directory of these is readable a week later.
    $name = "envmux-$Version-$Rid"
    $package = Join-Path $dist $(if ($Rid -like 'win-*') { "$name.zip" } else { "$name.tar.gz" })

    if (Test-Path $package) { Remove-Item -Force $package }

    # tar for the zip too, rather than Compress-Archive. bsdtar ships with
    # Windows and writes zip entries separated by '/', which is what the format
    # says and what the release job's `zip -qr` produces; Compress-Archive writes
    # '\', and an extractor on Linux then makes one file called
    # `Portal\ui\package.json`. -a picks the compression from the extension.
    tar -a -cf $package -C $output .
    if ($LASTEXITCODE -ne 0) { throw 'tar failed' }

    # Over every archive in the directory, so a sums file lists what is actually
    # there rather than only the one just built.
    #
    # Written through .NET rather than Set-Content, because Windows PowerShell
    # writes UTF-8 with a byte order mark and `sha256sum -c` reads that mark as
    # part of the first filename.
    $sums = Join-Path $dist 'SHA256SUMS.txt'
    $lines = Get-ChildItem $dist -File -Filter 'envmux-*' |
        ForEach-Object { "$((Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $($_.Name)" }

    [IO.File]::WriteAllLines($sums, [string[]]$lines, [Text.UTF8Encoding]::new($false))
}

Write-Host ''
Write-Host "envmux $Version ($Rid, ${size} MB)" -ForegroundColor Green
Write-Host "  -> $installed"
if ($Archive) { Write-Host "  -> $package" }
Write-Host ''

# The one thing this writes outside envmux's own directory, so it is the one
# thing it asks about — the same treatment `envmux ssh` gives ~/.ssh/config and
# `envmux ca` gives the trust store.
# This process's PATH, and — on Windows — the stored one it was built from. A
# run that added the entry a minute ago did not change the shell it ran in, so
# checking only $env:PATH says "not on PATH" about an entry that is, and asks to
# add it again every time.
$onPath = ($env:PATH -split [IO.Path]::PathSeparator) -contains $bin

$stored = if ($IsLinux -or $IsMacOS) { $false } else {
    @([Environment]::GetEnvironmentVariable('PATH', 'User') -split ';') -contains $bin
}

if ($onPath) {
    Write-Host '  Already on PATH. `envmux --version` should answer with the stamp above.'
}
elseif ($stored) {
    Write-Host "  $bin is on this account's PATH, but not in this terminal's."
    Write-Host '  Open a new one, or for this session:'
    Write-Host ''
    Write-Host "    `$env:PATH += `";$bin`""
}
elseif ($IsLinux -or $IsMacOS) {
    Write-Host '  Not on PATH. Add it to your shell:'
    Write-Host ''
    Write-Host "    export PATH=`"${bin}:`$PATH`""
}
else {
    $add = $Path

    if (-not $add -and -not [Console]::IsInputRedirected) {
        $answer = Read-Host "  add $bin to this account's PATH? [Y/n]"
        $add = $answer -eq '' -or $answer -match '^[Yy]'
    }

    if ($add -and (Add-ToPath)) {
        Write-Host "  Added $bin to this account's PATH. Open a new terminal for it."
    }
    else {
        Write-Host '  Not on PATH. Add it with:'
        Write-Host ''
        Write-Host "    `$env:PATH += `";$bin`""
    }
}

Write-Host ''
Write-Host "  This is the real command name, so it shadows - and is shadowed by - any"
Write-Host "  other envmux on PATH. ``$PSCommandPath -Uninstall`` takes it back off."
