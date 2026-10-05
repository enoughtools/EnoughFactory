<#
.SYNOPSIS
    Build a platform beta archive without installing it or changing PATH.
.DESCRIPTION
    Requires .NET 10 and Node 24. The version is explicit so an immutable beta
    tag, filename and binary can agree. Output is a new directory under ignored
    artifacts/releases/; an existing version is refused rather than overwritten.
    This packages only published files, LICENSE and the product skills.
    Run beta-verify and secret-audit first. This script does not publish a release.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$')][string]$Version,
    [ValidateSet('win-x64', 'win-arm64', 'linux-x64', 'linux-arm64', 'osx-arm64')][string]$Rid = 'win-x64'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$release = Join-Path $root "artifacts/releases/$Version-$Rid"
if (Test-Path -LiteralPath $release) { throw "Output exists; use a new version or review it manually: $release" }
Get-Command dotnet, node, tar -ErrorAction Stop | Out-Null
$nodeVersion = & node --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v24\.') { throw 'A beta build requires Node 24' }
$sdk = & dotnet --version
if ($LASTEXITCODE -ne 0 -or $sdk -notmatch '^10\.') { throw 'A beta build requires the .NET 10 SDK' }

$stage = Join-Path $release 'stage'
$published = Join-Path $release 'published'
$dist = Join-Path $release 'dist'
New-Item -ItemType Directory -Force $dist, $stage | Out-Null
Push-Location $root
try {
    # Force the portal build rather than accepting yesterday's incremental zip.
    & npm ci --no-audit --no-fund --prefix src/Envmux/Portal/ui
    if ($LASTEXITCODE -ne 0) { throw 'Portal dependency restore failed' }
    & npm run build --prefix src/Envmux/Portal/ui
    if ($LASTEXITCODE -ne 0) { throw 'Portal build failed' }
    & dotnet publish src/Envmux/Envmux.csproj --configuration Release --runtime $Rid --self-contained true `
        -p:BuildPortal=true -p:Version=$Version -p:InformationalVersion=$Version `
        -p:IncludeSourceRevisionInInformationalVersion=false -p:PublishAot=true -p:PublishSingleFile=false `
        -p:OptimizationPreference=Size -p:StripSymbols=true -p:DebugType=none --output $published --nologo
    if ($LASTEXITCODE -ne 0) { throw 'Publish failed' }
    $binaryName = if ($Rid.StartsWith('win-', [StringComparison]::Ordinal)) { 'envmux.exe' } else { 'envmux' }
    if (-not (Test-Path -LiteralPath (Join-Path $published $binaryName))) { throw 'Publish produced no executable' }
    # The Web SDK also publishes IIS hosting and portal source manifests. The
    # beta is the standalone executable and the explicit product assets only.
    Copy-Item -LiteralPath (Join-Path $published $binaryName) -Destination $stage
    Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination $stage
    $extension = if ($Rid.StartsWith('win-', [StringComparison]::Ordinal)) { 'zip' } else { 'tar.gz' }
    $readme = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'release-readme.md')).Replace('@@VERSION@@', $Version).Replace('@@RID@@', $Rid).Replace('@@ARCHIVE@@', "envmux-$Version-$Rid.$extension")
    [IO.File]::WriteAllText((Join-Path $stage 'README.md'), $readme, [Text.UTF8Encoding]::new($false))
    Copy-Item -LiteralPath (Join-Path $root 'skills') -Destination $stage -Recurse
    $skillScripts = New-Item -ItemType Directory -Path (Join-Path $stage 'scripts')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install-project-skills.ps1') -Destination $skillScripts.FullName
    if ($Rid.StartsWith('win-', [StringComparison]::Ordinal)) {
        $archive = Join-Path $dist "envmux-$Version-$Rid.zip"
        & tar -a -cf $archive -C $stage .
    }
    else {
        if ($IsWindows) { throw 'Build Unix archives on a Unix runner to preserve executable permissions' }
        & chmod +x (Join-Path $stage $binaryName)
        if ($LASTEXITCODE -ne 0) { throw 'Could not set executable permissions' }
        $archive = Join-Path $dist "envmux-$Version-$Rid.tar.gz"
        & tar -czf $archive -C $stage .
    }
    if ($LASTEXITCODE -ne 0) { throw 'Archive failed' }
    $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText((Join-Path $dist 'SHA256SUMS.txt'), "$hash  $([IO.Path]::GetFileName($archive))`n", [Text.UTF8Encoding]::new($false))
    $commit = & git rev-parse HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Could not record the source commit' }
    $dirty = @(& git status --porcelain).Count -gt 0
    [IO.File]::WriteAllText((Join-Path $dist 'build.json'), (@{
        version = $Version; rid = $Rid; commit = $commit; dirty = $dirty
        nativeAot = $true; binaryBytes = (Get-Item -LiteralPath (Join-Path $stage $binaryName)).Length; archiveBytes = (Get-Item -LiteralPath $archive).Length
        sdk = $sdk; node = $nodeVersion; builtUtc = [DateTime]::UtcNow.ToString('O', [Globalization.CultureInfo]::InvariantCulture)
    } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    $binaryBytes = (Get-Item -LiteralPath (Join-Path $stage $binaryName)).Length
    $archiveBytes = (Get-Item -LiteralPath $archive).Length
    Write-Host "Native AOT $Rid`: binary $binaryBytes bytes; archive $archiveBytes bytes"
    if ($env:GITHUB_ACTIONS -eq 'true') {
        Write-Output "::notice title=Native AOT sizes::$Rid binary=$binaryBytes bytes archive=$archiveBytes bytes"
    }
    Write-Host "Candidate built: $dist"
    if ($dirty) { Write-Host 'Working tree has changes; this is a review candidate, not a reproducible tagged release.' }
}
finally { Pop-Location }
