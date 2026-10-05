<#
.SYNOPSIS
    Run the branch gates, requiring live Docker coverage when requested.
.DESCRIPTION
    -Docker enables the disposable Docker fixtures, golden image build and
    browser end-to-end test. It creates test containers and networks and may
    pull images; it leaves the golden image cached. No Incus target is enabled.
    ENVMUX_HOME and ENVMUX_SSH_HOME point to this run's scratch directories.
    A successful test command with skipped Docker tests is a failed beta gate.
#>
[CmdletBinding()]
param([switch]$Docker)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$run = Join-Path $root ('artifacts/beta-verify/' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $run | Out-Null
$names = @('ENVMUX_HOME', 'ENVMUX_SSH_HOME', 'ENVMUX_DOCKER_LIVE', 'ENVMUX_DOCKER_LIVE_IMAGE', 'ENVMUX_GOLDEN_LIVE', 'ENVMUX_E2E', 'ENVMUX_E2E_BINARY', 'BuildPortal')
$previous = @{}
foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }

function Invoke-Check([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed (exit $LASTEXITCODE)" }
}

Push-Location $root
try {
    $env:ENVMUX_HOME = Join-Path $run 'home'
    $env:ENVMUX_SSH_HOME = Join-Path $run 'ssh'
    $env:ENVMUX_DOCKER_LIVE = if ($Docker) { '1' } else { '0' }
    $env:ENVMUX_GOLDEN_LIVE = if ($Docker) { '1' } else { '0' }
    $env:ENVMUX_E2E = if ($Docker) { 'docker' } else { '' }
    $env:ENVMUX_E2E_BINARY = $null
    $env:BuildPortal = 'true'
    Invoke-Check 'dotnet' @('build', '--configuration', 'Release', '--nologo')
    Invoke-Check 'dotnet' @('test', '--no-build', '--configuration', 'Release',
        '--logger', 'trx;LogFileName=tests.trx', '--results-directory', $run, '--verbosity', 'minimal')
    [xml]$results = Get-Content -LiteralPath (Join-Path $run 'tests.trx')
    if ($Docker) {
        $live = @($results.TestRun.Results.UnitTestResult | Where-Object {
            $_.testName -match '(DockerEngineLiveTests|EngineExecLiveTests|EngineRelayLiveTests|GoldenLiveTests|ProofOfLifeTests|KitchenWireTests)'
        })
        $skipped = @($live | Where-Object outcome -eq 'NotExecuted')
        # The exec fixture's default image lacks tmux. Re-run its latch proof
        # on the golden image that this run just proved, rather than waive it.
        $latch = @($skipped | Where-Object testName -Match 'ALatchedTaskOutlives')
        if ($latch.Count) {
            $golden = $live | Where-Object testName -Match 'GoldenLiveTests'
            $image = [regex]::Match([string]$golden.Output.StdOut, 'envmux-golden:[a-z0-9]+').Value
            if (-not $image) { throw 'Could not identify the golden image for the latch proof' }
            $env:ENVMUX_DOCKER_LIVE_IMAGE = $image
            Invoke-Check 'dotnet' @('test', '--no-build', '--configuration', 'Release',
                '--filter', 'FullyQualifiedName~EngineExecLiveTests.ALatchedTaskOutlivesTheExecThatLaunchedItAndTheOneThatAttached',
                '--logger', 'trx;LogFileName=latch.trx', '--results-directory', $run, '--verbosity', 'minimal')
            [xml]$latchResults = Get-Content -LiteralPath (Join-Path $run 'latch.trx')
            if ($latchResults.TestRun.Results.UnitTestResult.outcome -ne 'Passed') { throw 'Latch proof did not pass' }
        }
        $missing = @($skipped | Where-Object testName -NotMatch 'ALatchedTaskOutlives')
        if (-not $live.Count -or $missing.Count) {
            $missing | ForEach-Object { Write-Host "missing live coverage: $($_.testName)" }
            throw 'Live Docker coverage is incomplete'
        }
    }
    Invoke-Check 'dotnet' @('src/Envmux/bin/Release/net10.0/envmux.dll', '--directory', $root, '--dry-run', '--backend', 'docker')
    $env:BuildPortal = 'false'
    Invoke-Check 'dotnet' @('format', '--verify-no-changes', '--no-restore')
    Write-Host "Beta checks passed. Evidence: $run"
}
finally {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
    Pop-Location
}
