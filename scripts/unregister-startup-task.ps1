[CmdletBinding()]
param(
    [string]$TaskName = "QmessageMainStartup"
)

$ErrorActionPreference = "Stop"

$deleteOutput = (& schtasks.exe /Delete /F /TN $TaskName 2>&1) | Out-String
if ($LASTEXITCODE -ne 0) {
    throw "Failed to remove startup task '$TaskName':`n$deleteOutput"
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$safeTaskName = ($TaskName -replace '[^A-Za-z0-9_.-]', '_')
$startupScriptPath = Join-Path $repoRoot ".codex-logs\runtime\startup\$safeTaskName.ps1"
if (Test-Path $startupScriptPath) {
    Remove-Item $startupScriptPath -Force
}

Write-Output "Startup task removed: $TaskName"
