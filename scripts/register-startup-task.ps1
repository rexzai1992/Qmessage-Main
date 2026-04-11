[CmdletBinding()]
param(
    [string]$TaskName = "QmessageMainStartup",
    [string]$CloudflaredPath = "$env:USERPROFILE\cloudflared.exe",
    [string]$CloudflaredConfig = "cloudflared-2fast.yml",
    [string]$Delay = "0000:30"
)

$ErrorActionPreference = "Stop"

$startScriptPath = (Resolve-Path (Join-Path $PSScriptRoot "start-services.ps1")).Path
$taskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$startScriptPath`" -CloudflaredPath `"$CloudflaredPath`" -CloudflaredConfig `"$CloudflaredConfig`""

$createOutput = (& schtasks.exe /Create /F /SC ONLOGON /TN $TaskName /TR $taskCommand /DELAY $Delay 2>&1) | Out-String
if ($LASTEXITCODE -ne 0) {
    throw "Failed to create startup task '$TaskName':`n$createOutput"
}

Write-Output "Startup task created: $TaskName"
Write-Output "Task command: $taskCommand"
