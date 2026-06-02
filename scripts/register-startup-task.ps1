[CmdletBinding()]
param(
    [string]$TaskName = "QmessageMainStartup",
    [string]$CloudflaredPath = "",
    [string]$CloudflaredConfig = "cloudflared-2fast.yml",
    [string]$Delay = "0000:30",
    [bool]$IncludeFrontend = $true
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$startScriptPath = (Resolve-Path (Join-Path $PSScriptRoot "start-services.ps1")).Path
$startupScriptDir = Join-Path $repoRoot ".codex-logs\runtime\startup"

New-Item -ItemType Directory -Force -Path $startupScriptDir | Out-Null

function ConvertTo-SingleQuotedPowerShellString {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    return "'" + $Value.Replace("'", "''") + "'"
}

if ([string]::IsNullOrWhiteSpace($CloudflaredPath)) {
    $repoCloudflared = Join-Path $repoRoot "cloudflared.exe"
    $homeCloudflared = Join-Path $env:USERPROFILE "cloudflared.exe"

    if (Test-Path $repoCloudflared) {
        $CloudflaredPath = $repoCloudflared
    } else {
        $CloudflaredPath = $homeCloudflared
    }
}

$resolvedCloudflaredPath = if ([System.IO.Path]::IsPathRooted($CloudflaredPath)) {
    $CloudflaredPath
} else {
    Join-Path $repoRoot $CloudflaredPath
}

$resolvedConfig = if ([System.IO.Path]::IsPathRooted($CloudflaredConfig)) {
    $CloudflaredConfig
} else {
    Join-Path $repoRoot $CloudflaredConfig
}

if (-not (Test-Path $resolvedCloudflaredPath)) {
    throw "cloudflared executable not found: $resolvedCloudflaredPath"
}

if (-not (Test-Path $resolvedConfig)) {
    throw "cloudflared config not found: $resolvedConfig"
}

$safeTaskName = ($TaskName -replace '[^A-Za-z0-9_.-]', '_')
$startupScriptPath = Join-Path $startupScriptDir "$safeTaskName.ps1"
$includeFrontendArg = if ($IncludeFrontend) { " -IncludeFrontend" } else { "" }
$startupScript = @(
    '$ErrorActionPreference = "Stop"',
    "& $(ConvertTo-SingleQuotedPowerShellString $startScriptPath) -CloudflaredPath $(ConvertTo-SingleQuotedPowerShellString $resolvedCloudflaredPath) -CloudflaredConfig $(ConvertTo-SingleQuotedPowerShellString $resolvedConfig)$includeFrontendArg"
)
Set-Content -Path $startupScriptPath -Value $startupScript -Encoding ASCII

$taskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startupScriptPath`""

$createOutput = (& schtasks.exe /Create /F /SC ONLOGON /TN $TaskName /TR $taskCommand /DELAY $Delay 2>&1) | Out-String
if ($LASTEXITCODE -ne 0) {
    throw "Failed to create startup task '$TaskName':`n$createOutput"
}

Write-Output "Startup task created: $TaskName"
Write-Output "Task command: $taskCommand"
Write-Output "Startup wrapper: $startupScriptPath"
