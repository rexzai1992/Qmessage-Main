[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$pidDir = Join-Path $repoRoot ".codex-logs\runtime\pids"

function Stop-FromPidFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PidFile,
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    if (-not (Test-Path $PidFile)) {
        Write-Output "$Name not running (no pid file)."
        return
    }

    $pidText = (Get-Content $PidFile -Raw).Trim()
    $processId = 0
    $parsed = [int]::TryParse($pidText, [ref]$processId)

    if ($parsed) {
        try {
            Stop-Process -Id $processId -Force -ErrorAction Stop
            Write-Output "Stopped $Name PID: $processId"
        } catch {
            Write-Output "$Name PID $processId already stopped."
        }
    } else {
        Write-Output "$Name pid file was invalid: $PidFile"
    }

    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

Stop-FromPidFile -PidFile (Join-Path $pidDir "dev.pid") -Name "dev server"
Stop-FromPidFile -PidFile (Join-Path $pidDir "dashboard.pid") -Name "dashboard frontend"
Stop-FromPidFile -PidFile (Join-Path $pidDir "cloudflared.pid") -Name "cloudflared"
