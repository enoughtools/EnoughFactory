<#
.SYNOPSIS
    Copy the packaged envmux skills into a project's Claude and Codex skill folders.
.DESCRIPTION
    A prototype for init's skill delivery. It writes only envmux-named skill
    files in the explicitly selected project, needs no marketplace, copies no
    credentials, and refuses to replace a different existing file.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Directory,
    [ValidateSet('Both', 'Claude', 'Codex')][string]$Agent = 'Both'
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $Directory).Path
$source = Join-Path (Split-Path -Parent $PSScriptRoot) 'skills'
$roots = @()
if ($Agent -in 'Both', 'Claude') { $roots += '.claude/skills' }
if ($Agent -in 'Both', 'Codex') { $roots += '.agents/skills' }
$copies = @()
foreach ($skill in Get-ChildItem -LiteralPath $source -Directory) {
    if ($skill.Name -notlike 'envmux-*') { continue }
    foreach ($relative in $roots) {
        $target = Join-Path $project "$relative/$($skill.Name)/SKILL.md"
        $original = Join-Path $skill.FullName 'SKILL.md'
        $ancestor = Split-Path -Parent $target
        while ($ancestor.Length -ge $project.Length) {
            if (Test-Path -LiteralPath $ancestor) {
                if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                    throw "Skill destination passes through a link; choose a physical project directory: $ancestor"
                }
            }
            if ($ancestor.Equals($project, [StringComparison]::OrdinalIgnoreCase)) { break }
            $ancestor = Split-Path -Parent $ancestor
        }
        if (Test-Path -LiteralPath $target) {
            if ((Get-FileHash -LiteralPath $target).Hash -ne (Get-FileHash -LiteralPath $original).Hash) {
                throw "Existing skill differs; review it before replacing: $target"
            }
        }
        else { $copies += @{ Source = $original; Target = $target } }
    }
}
foreach ($copy in $copies) {
    New-Item -ItemType Directory -Force (Split-Path -Parent $copy.Target) | Out-Null
    Copy-Item -LiteralPath $copy.Source -Destination $copy.Target
    Write-Host "wrote $($copy.Target)"
}
if (-not $copies.Count) { Write-Host 'Project skills are already current.' }
