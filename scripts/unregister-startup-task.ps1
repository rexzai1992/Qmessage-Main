[CmdletBinding()]
param(
    [string]$TaskName = "QmessageMainStartup"
)

$ErrorActionPreference = "Stop"

$deleteOutput = (& schtasks.exe /Delete /F /TN $TaskName 2>&1) | Out-String
if ($LASTEXITCODE -ne 0) {
    throw "Failed to remove startup task '$TaskName':`n$deleteOutput"
}

Write-Output "Startup task removed: $TaskName"
