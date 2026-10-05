<#
.SYNOPSIS
    Check an extracted beta archive, including its Docker end-to-end behaviour.
.DESCRIPTION
    Requires the source checkout's Release test build. Version and checksum
    must match; the E2E harness then launches the extracted executable, not dotnet.
    Test state and extraction stay under artifacts/. -Docker creates disposable
    Docker fixtures via the existing proof-of-life test. This does not install.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Archive,
    [Parameter(Mandatory)][string]$Version,
    [switch]$Docker
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$archivePath = (Resolve-Path -LiteralPath $Archive).Path
$sums = Join-Path (Split-Path -Parent $archivePath) 'SHA256SUMS.txt'
$expected = @(Get-Content -LiteralPath $sums | Where-Object {
    $_ -match ('^[a-f0-9]{64}\s+' + [regex]::Escape([IO.Path]::GetFileName($archivePath)) + '$')
})
if ($expected.Count -ne 1 -or
    (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne ($expected[0] -split '\s+')[0]) {
    throw 'Archive checksum is missing, ambiguous or wrong'
}
$run = Join-Path $root ('artifacts/release-check/' + [Guid]::NewGuid().ToString('N'))
$extract = Join-Path $run 'extracted'
New-Item -ItemType Directory -Force $extract | Out-Null
if ($archivePath.EndsWith('.zip', [StringComparison]::Ordinal)) {
    $zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        foreach ($entry in $zip.Entries) {
            $target = [IO.Path]::GetFullPath((Join-Path $extract $entry.FullName))
            if ($target.Equals($extract, [StringComparison]::OrdinalIgnoreCase) -and $entry.FullName.EndsWith('/')) { continue }
            if (-not $target.StartsWith($extract + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Archive entry escapes its extraction directory'
            }
            if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Archive contains a symbolic link' }
        }
    }
    finally { $zip.Dispose() }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $extract
    $binary = Join-Path $extract 'envmux.exe'
}
elseif ($archivePath.EndsWith('.tar.gz', [StringComparison]::Ordinal)) {
    # Check names and types before tar writes anything. Links and special files
    # have no place in a package containing one executable and product skills.
    $file = [IO.File]::OpenRead($archivePath)
    $gzip = [IO.Compression.GZipStream]::new($file, [IO.Compression.CompressionMode]::Decompress)
    $tar = [System.Formats.Tar.TarReader]::new($gzip)
    try {
        while ($null -ne ($entry = $tar.GetNextEntry())) {
            if ($entry.EntryType -notin [System.Formats.Tar.TarEntryType]::RegularFile,
                [System.Formats.Tar.TarEntryType]::V7RegularFile, [System.Formats.Tar.TarEntryType]::Directory) {
                throw 'Archive contains a link or special file'
            }
            $target = [IO.Path]::GetFullPath((Join-Path $extract $entry.Name))
            if ($target.Equals($extract, [StringComparison]::Ordinal) -and $entry.EntryType -eq [System.Formats.Tar.TarEntryType]::Directory) { continue }
            if (-not $target.StartsWith($extract + [IO.Path]::DirectorySeparatorChar, [StringComparison]::Ordinal)) {
                throw 'Archive entry escapes its extraction directory'
            }
        }
    }
    finally { $tar.Dispose(); $gzip.Dispose(); $file.Dispose() }
    & tar -xzf $archivePath -C $extract
    if ($LASTEXITCODE -ne 0) { throw 'Archive extraction failed' }
    $binary = Join-Path $extract 'envmux'
}
else { throw 'Expected a .zip or .tar.gz release archive' }
$readmePath = Join-Path $extract 'README.md'
if (-not (Test-Path -LiteralPath $readmePath)) { throw 'Archive contains no getting-started README' }
$readme = Get-Content -LiteralPath $readmePath -Raw
if ($readme.Contains('@@', [StringComparison]::Ordinal) -or -not $readme.Contains("# envmux $Version", [StringComparison]::Ordinal)) {
    throw 'Archive README has an incorrect version or unexpanded placeholders'
}
& $binary install --help | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Extracted binary failed install help' }
$answer = & $binary --version
if ($LASTEXITCODE -ne 0 -or ($answer.Trim() -ne $Version -and $answer.Trim() -ne "envmux $Version")) {
    throw 'Extracted binary does not report the requested version'
}
$names = @('ENVMUX_HOME', 'ENVMUX_SSH_HOME', 'ENVMUX_E2E', 'ENVMUX_E2E_BINARY')
$previous = @{}
foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
Push-Location $root
try {
    $env:ENVMUX_HOME = Join-Path $run 'home'
    $env:ENVMUX_SSH_HOME = Join-Path $run 'ssh'
    $env:ENVMUX_E2E = 'docker'
    $env:ENVMUX_E2E_BINARY = $binary
    $project = Join-Path $run 'project'
    New-Item -ItemType Directory -Path $project | Out-Null
    & $binary --directory $project --dry-run --backend docker
    if ($LASTEXITCODE -ne 0) { throw 'Extracted binary failed its dry-run' }
    # Exercise generated configuration metadata and embedded skills in the
    # executable itself; managed unit tests cannot detect missing native roots.
    & $binary --directory $project init --skills both
    if ($LASTEXITCODE -ne 0) { throw 'Extracted binary failed setup with local skills' }
    foreach ($command in @('validate', 'show', 'schema')) {
        & $binary --directory $project config $command | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Extracted binary failed config $command" }
    }
    if ($Docker) {
        & dotnet test --no-build --configuration Release --filter 'FullyQualifiedName~ProofOfLifeTests|FullyQualifiedName~KitchenWireTests' `
            --logger 'trx;LogFileName=release.trx' --results-directory $run --verbosity minimal
        if ($LASTEXITCODE -ne 0) { throw 'Extracted binary failed its Docker proof' }
        [xml]$results = Get-Content -LiteralPath (Join-Path $run 'release.trx')
        $cases = @($results.TestRun.Results.UnitTestResult)
        if (-not $cases.Count -or @($cases | Where-Object outcome -ne 'Passed').Count) {
            throw 'Extracted binary did not complete its Docker proof'
        }
    }
    Write-Host "Archive checks passed. Evidence: $run"
}
finally {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
    Pop-Location
}
