[CmdletBinding()]
param(
    [string]$CloudflaredPath = "$env:USERPROFILE\cloudflared.exe",
    [string]$CloudflaredConfig = "cloudflared-2fast.yml",
    [switch]$ForceRestart
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runtimeDir = Join-Path $repoRoot ".codex-logs\runtime"
$pidDir = Join-Path $runtimeDir "pids"

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
New-Item -ItemType Directory -Force -Path $pidDir | Out-Null

function Get-RunningProcessFromPidFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PidFile
    )

    if (-not (Test-Path $PidFile)) {
        return $null
    }

    $pidText = (Get-Content $PidFile -Raw).Trim()
    if ([string]::IsNullOrWhiteSpace($pidText)) {
        return $null
    }

    $pid = 0
    if (-not [int]::TryParse($pidText, [ref]$pid)) {
        return $null
    }

    try {
        return Get-Process -Id $pid -ErrorAction Stop
    } catch {
        return $null
    }
}

function Stop-ExistingByPidFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PidFile
    )

    $proc = Get-RunningProcessFromPidFile -PidFile $PidFile
    if ($null -ne $proc) {
        Stop-Process -Id $proc.Id -Force
        Start-Sleep -Milliseconds 400
    }

    if (Test-Path $PidFile) {
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    }
}

$devPidFile = Join-Path $pidDir "dev.pid"
$cloudflaredPidFile = Join-Path $pidDir "cloudflared.pid"

if ($ForceRestart) {
    Stop-ExistingByPidFile -PidFile $devPidFile
    Stop-ExistingByPidFile -PidFile $cloudflaredPidFile
}

$devOut = Join-Path $runtimeDir "dev.out.log"
$devErr = Join-Path $runtimeDir "dev.err.log"
$tunnelOut = Join-Path $runtimeDir "cloudflared.out.log"
$tunnelErr = Join-Path $runtimeDir "cloudflared.err.log"

$devProc = Get-RunningProcessFromPidFile -PidFile $devPidFile
if ($null -eq $devProc) {
    $devProc = Start-Process `
        -FilePath "cmd.exe" `
        -ArgumentList "/c", "npm.cmd run dev" `
        -WorkingDirectory $repoRoot `
        -RedirectStandardOutput $devOut `
        -RedirectStandardError $devErr `
        -PassThru

    Set-Content -Path $devPidFile -Value $devProc.Id
    Write-Output "Started dev server PID: $($devProc.Id)"
} else {
    Write-Output "Dev server already running PID: $($devProc.Id)"
}

$resolvedConfig = if ([System.IO.Path]::IsPathRooted($CloudflaredConfig)) {
    $CloudflaredConfig
} else {
    Join-Path $repoRoot $CloudflaredConfig
}

if (-not (Test-Path $CloudflaredPath)) {
    throw "cloudflared executable not found: $CloudflaredPath"
}

if (-not (Test-Path $resolvedConfig)) {
    throw "cloudflared config not found: $resolvedConfig"
}

$cloudProc = Get-RunningProcessFromPidFile -PidFile $cloudflaredPidFile
if ($null -eq $cloudProc) {
    $cloudProc = Start-Process `
        -FilePath $CloudflaredPath `
        -ArgumentList "tunnel", "--config", $resolvedConfig, "run" `
        -WorkingDirectory $repoRoot `
        -RedirectStandardOutput $tunnelOut `
        -RedirectStandardError $tunnelErr `
        -PassThru

    Set-Content -Path $cloudflaredPidFile -Value $cloudProc.Id
    Write-Output "Started cloudflared PID: $($cloudProc.Id)"
} else {
    Write-Output "Cloudflared already running PID: $($cloudProc.Id)"
}

Write-Output "Logs:"
Write-Output "  $devOut"
Write-Output "  $devErr"
Write-Output "  $tunnelOut"
Write-Output "  $tunnelErr"
