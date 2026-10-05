<#
.SYNOPSIS
    Scan the candidate source tree and reachable git history without printing secrets.
.DESCRIPTION
    Requires Betterleaks 1.9.0. The tree is the tracked working files plus
    non-ignored new files, including archive/ and spikes/. Ignored local state
    is never walked. History includes every local branch and tag; it is evidence
    for rotation, not a claim that squashing revokes an exposed credential.
    Reports stay under ignored artifacts/. This does not rewrite or publish git.
#>
[CmdletBinding()]
param([string]$Betterleaks = 'betterleaks', [switch]$TreeOnly, [switch]$Strict, [switch]$PassThru)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$run = Join-Path $root ('artifacts/secret-audit/' + [Guid]::NewGuid().ToString('N'))
$tree = Join-Path $run 'tree'
New-Item -ItemType Directory -Force $tree | Out-Null

Push-Location $root
try {
    $scanner = (Get-Command $Betterleaks -ErrorAction Stop).Source
    $files = @(git -c core.quotepath=false ls-files --cached --others --exclude-standard)
    if ($LASTEXITCODE -ne 0) { throw 'git could not enumerate the candidate tree' }

    # Refuse private-state filenames before opening or copying any file. A
    # scanner finding a token in ordinary source will redact it separately.
    $private = @($files | Where-Object {
        $_ -match '(?i)(^|/)(\.context|\.hive|\.envmux|\.aws)(/|$)' -or
        $_ -match '(?i)(^|/)(\.env($|\.(?!example$|sample$|template$))|[^/]*\.(key|pfx|p12|pem)$|[^/]*kubeconfig[^/]*|credentials[^/]*|host\.json$|id_rsa|id_ed25519)$'
    })
    if ($private.Count) {
        $private | ForEach-Object { Write-Host "private-state filename: $_" }
        throw 'Remove private-state files from the candidate tree before scanning or packaging'
    }

    foreach ($file in $files) {
        $source = Join-Path $root $file
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
        $item = Get-Item -LiteralPath $source -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Candidate contains a link; review its target before exporting: $file"
        }
        $target = [IO.Path]::GetFullPath((Join-Path $tree $file))
        if (-not $target.StartsWith($tree + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Candidate filename escapes the audit tree'
        }
        New-Item -ItemType Directory -Force (Split-Path -Parent $target) | Out-Null
        Copy-Item -LiteralPath $source -Destination $target
    }

    # Only the reviewed exact fixture values below are exempted. Strict mode
    # removes even these exemptions, preserving an independent raw inventory.
    $config = Join-Path $PSScriptRoot 'secret-audit.toml'
    if ($Strict) {
        $config = Join-Path $run 'betterleaks.toml'
        [IO.File]::WriteAllText($config, "[extend]`nuseDefault = true`n", [Text.UTF8Encoding]::new($false))
    }
    $missingIgnore = Join-Path $run 'no-ignore-file'
    $scans = [Collections.Generic.List[object]]::new()
    $scans.Add(@('dir', $tree, 'tree'))
    if (-not $TreeOnly) { $scans.Add(@('git', $root, 'history')) }
    $failed = $false
    foreach ($scan in $scans) {
        $report = Join-Path $run ($scan[2] + '.json')
        $arguments = @($scan[0], $scan[1], '--validation=false', '--redact=100', '--no-banner', '--no-color',
            '--log-level', 'error', '--config', $config, '--ignore-gitleaks-allow',
            '--gitleaks-ignore-path', $missingIgnore, '--report-format', 'json', '--report-path', $report)
        if ($scan[0] -eq 'git') { $arguments += '--log-opts=--all' }
        & $scanner @arguments
        $code = $LASTEXITCODE
        if ($code -notin 0, 1) { throw "Betterleaks $($scan[2]) scan failed (exit $code)" }
        if (-not (Test-Path -LiteralPath $report)) { throw 'Scanner produced no report' }
        $findings = @(Get-Content -LiteralPath $report -Raw | ConvertFrom-Json)
        Write-Host "$($scan[2]): $($findings.Count) finding(s)"
        foreach ($finding in $findings) {
            # Never write Match, Secret or commit messages to the terminal.
            Write-Host "  $($finding.RuleID) | $($finding.File):$($finding.StartLine) | $($finding.Commit)"
        }
        if ($code -eq 1) { $failed = $true }
    }
    Write-Host "Redacted evidence: $run"
    if ($failed) { throw 'Secret audit needs triage; do not publish this candidate yet' }
    if ($PassThru) { [pscustomobject]@{ Tree = $tree; Evidence = $run } }
}
finally { Pop-Location }
