<#
.SYNOPSIS
    Export a clean, audited commit for a new repository with one initial commit.
.DESCRIPTION
    Writes a new source directory under ignored artifacts/initial-export/.
    By default only git archive's HEAD tree travels: no .git, refs, reflogs, local state or
    credentials. The original repository is unchanged. Review the export, then
    initialise and commit it yourself. -WorkingTree exports the audited candidate
    snapshot when preparing changes that are not committed yet. Nothing is pushed or committed here.
#>
[CmdletBinding()]
param([string]$Betterleaks = 'betterleaks', [switch]$WorkingTree)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    $status = @(git status --porcelain)
    if ($LASTEXITCODE -ne 0) { throw 'Could not read git status' }
    if ($status.Count -and -not $WorkingTree) { throw 'Commit and review the intended source tree before exporting HEAD' }
    $audit = & (Join-Path $PSScriptRoot 'secret-audit.ps1') -Betterleaks $Betterleaks -PassThru
    $run = Join-Path $root ('artifacts/initial-export/' + [Guid]::NewGuid().ToString('N'))
    $tree = Join-Path $run 'source'
    New-Item -ItemType Directory -Force $tree | Out-Null
    if ($WorkingTree) {
        # Copy the snapshot the scanner actually inspected, not a second read
        # of a working tree that another process could have changed meanwhile.
        Get-ChildItem -LiteralPath $audit.Tree -Force | Copy-Item -Destination $tree -Recurse
    }
    else {
        $archive = Join-Path $run 'source.zip'
        & git archive --format=zip --output=$archive HEAD
        if ($LASTEXITCODE -ne 0) { throw 'git archive failed' }
        Expand-Archive -LiteralPath $archive -DestinationPath $tree
    }
    if (Test-Path -LiteralPath (Join-Path $tree '.git')) { throw 'Export unexpectedly contains git metadata' }
    Write-Host "Audited source exported to $tree"
    Write-Host 'After reviewing it: git init -b main; git add --all; git commit -m "initial commit"'
    Write-Host 'Add only the envmux/envmux remote to that new repository. Keep this original clone private.'
}
finally { Pop-Location }
