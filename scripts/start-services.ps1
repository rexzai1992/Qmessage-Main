[CmdletBinding()]
param(
    [string]$CloudflaredPath = "",
    [string]$CloudflaredConfig = "cloudflared-2fast.yml",
    [string]$NodeDir = "",
    [switch]$ForceRestart,
    [switch]$IncludeFrontend
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runtimeDir = Join-Path $repoRoot ".codex-logs\runtime"
$pidDir = Join-Path $runtimeDir "pids"

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
New-Item -ItemType Directory -Force -Path $pidDir | Out-Null

function Resolve-NodeDirectory {
    param(
        [string]$RequestedNodeDir
    )

    $candidates = New-Object System.Collections.Generic.List[string]

    if (-not [string]::IsNullOrWhiteSpace($RequestedNodeDir)) {
        if ([System.IO.Path]::IsPathRooted($RequestedNodeDir)) {
            $candidates.Add($RequestedNodeDir)
        } else {
            $candidates.Add((Join-Path $repoRoot $RequestedNodeDir))
        }
    }

    $toolsDir = Join-Path $repoRoot ".tools"
    if (Test-Path $toolsDir) {
        Get-ChildItem -Path $toolsDir -Directory -Filter "node-v*-win-x64" -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { $candidates.Add($_.FullName) }
    }

    $pathNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -ne $pathNode -and -not [string]::IsNullOrWhiteSpace($pathNode.Source)) {
        $candidates.Add((Split-Path -Parent $pathNode.Source))
    }

    $seen = @{}
    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) {
            continue
        }

        $resolvedCandidate = $candidate
        try {
            if (Test-Path $candidate) {
                $resolvedCandidate = (Resolve-Path $candidate).Path
            }
        } catch {
            $resolvedCandidate = $candidate
        }

        $key = $resolvedCandidate.ToLowerInvariant()
        if ($seen.ContainsKey($key)) {
            continue
        }
        $seen[$key] = $true

        if ((Test-Path (Join-Path $resolvedCandidate "node.exe")) -and (Test-Path (Join-Path $resolvedCandidate "npm.cmd"))) {
            return $resolvedCandidate
        }
    }

    return $null
}

$resolvedNodeDir = Resolve-NodeDirectory -RequestedNodeDir $NodeDir
if ($null -ne $resolvedNodeDir) {
    $env:Path = "$resolvedNodeDir;$env:Path"
    $env:npm_config_cache = Join-Path $repoRoot ".tools\npm-cache"
    Write-Output "Using Node runtime: $resolvedNodeDir"
} else {
    Write-Output "No bundled Node runtime found; using node/npm from system PATH."
}

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

    $processId = 0
    if (-not [int]::TryParse($pidText, [ref]$processId)) {
        return $null
    }

    try {
        return Get-Process -Id $processId -ErrorAction Stop
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
        & taskkill.exe /PID $proc.Id /T /F | Out-Null
        Start-Sleep -Milliseconds 400
    }

    if (Test-Path $PidFile) {
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    }
}

function Stop-RepoListenerOnPort {
    param(
        [Parameter(Mandatory = $true)]
        [int]$Port
    )

    $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($listener in $listeners) {
        $processId = [int]$listener.OwningProcess
        if ($processId -le 0) {
            continue
        }

        $procInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
        if ($null -eq $procInfo -or [string]::IsNullOrWhiteSpace($procInfo.CommandLine)) {
            continue
        }

        if ($procInfo.CommandLine -like "*$repoRoot*") {
            & taskkill.exe /PID $processId /T /F | Out-Null
            Start-Sleep -Milliseconds 400
        }
    }
}

$backendPidFile = Join-Path $pidDir "dev.pid"
$frontendPidFile = Join-Path $pidDir "dashboard.pid"
$cloudflaredPidFile = Join-Path $pidDir "cloudflared.pid"

if ($ForceRestart) {
    Stop-ExistingByPidFile -PidFile $backendPidFile
    Stop-ExistingByPidFile -PidFile $frontendPidFile
    Stop-ExistingByPidFile -PidFile $cloudflaredPidFile
    Stop-RepoListenerOnPort -Port 3000
    Stop-RepoListenerOnPort -Port 5173
}

$backendOut = Join-Path $runtimeDir "dev.out.log"
$backendErr = Join-Path $runtimeDir "dev.err.log"
$frontendOut = Join-Path $runtimeDir "dashboard.out.log"
$frontendErr = Join-Path $runtimeDir "dashboard.err.log"
$tunnelOut = Join-Path $runtimeDir "cloudflared.out.log"
$tunnelErr = Join-Path $runtimeDir "cloudflared.err.log"

function Start-ManagedProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$PidFile,
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(Mandatory = $true)]
        [string[]]$ArgumentList,
        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory,
        [Parameter(Mandatory = $true)]
        [string]$StdOutLog,
        [Parameter(Mandatory = $true)]
        [string]$StdErrLog
    )

    $existing = Get-RunningProcessFromPidFile -PidFile $PidFile
    if ($null -ne $existing) {
        Write-Output "$Name already running PID: $($existing.Id)"
        return
    }

    $proc = Start-Process `
        -FilePath $FilePath `
        -ArgumentList $ArgumentList `
        -WorkingDirectory $WorkingDirectory `
        -RedirectStandardOutput $StdOutLog `
        -RedirectStandardError $StdErrLog `
        -WindowStyle Hidden `
        -PassThru

    Start-Sleep -Milliseconds 700
    $running = $null
    try {
        $running = Get-Process -Id $proc.Id -ErrorAction Stop
    } catch {
        $running = $null
    }

    if ($null -eq $running) {
        $tail = ""
        if (Test-Path $StdErrLog) {
            $tail = (Get-Content $StdErrLog -Tail 30 | Out-String).Trim()
        }

        if ([string]::IsNullOrWhiteSpace($tail)) {
            throw "$Name failed to start. See logs:`n  $StdOutLog`n  $StdErrLog"
        }

        throw "$Name failed to start. Recent stderr:`n$tail"
    }

    Set-Content -Path $PidFile -Value $proc.Id
    Write-Output "Started $Name PID: $($proc.Id)"
}

Start-ManagedProcess `
    -Name "backend (port 3000)" `
    -PidFile $backendPidFile `
    -FilePath "cmd.exe" `
    -ArgumentList @("/c", "`"$repoRoot\node_modules\.bin\tsx.cmd`" watch dashboard-server.ts") `
    -WorkingDirectory $repoRoot `
    -StdOutLog $backendOut `
    -StdErrLog $backendErr

if ($IncludeFrontend) {
    Start-ManagedProcess `
        -Name "dashboard frontend (port 5173)" `
        -PidFile $frontendPidFile `
        -FilePath "cmd.exe" `
        -ArgumentList @("/c", "npm.cmd run dev --prefix dashboard") `
        -WorkingDirectory $repoRoot `
        -StdOutLog $frontendOut `
        -StdErrLog $frontendErr
} else {
    Stop-ExistingByPidFile -PidFile $frontendPidFile
    Write-Output "Skipping dashboard frontend process (use -IncludeFrontend to enable)."
}

$resolvedConfig = if ([System.IO.Path]::IsPathRooted($CloudflaredConfig)) {
    $CloudflaredConfig
} else {
    Join-Path $repoRoot $CloudflaredConfig
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

if (-not (Test-Path $resolvedCloudflaredPath)) {
    throw "cloudflared executable not found: $resolvedCloudflaredPath"
}

if (-not (Test-Path $resolvedConfig)) {
    throw "cloudflared config not found: $resolvedConfig"
}

$cloudProc = Get-RunningProcessFromPidFile -PidFile $cloudflaredPidFile
if ($null -eq $cloudProc) {
    $cloudProc = Start-Process `
        -FilePath $resolvedCloudflaredPath `
        -ArgumentList "tunnel", "--config", $resolvedConfig, "run" `
        -WorkingDirectory $repoRoot `
        -RedirectStandardOutput $tunnelOut `
        -RedirectStandardError $tunnelErr `
        -WindowStyle Hidden `
        -PassThru

    Start-Sleep -Milliseconds 700
    $cloudRunning = $null
    try {
        $cloudRunning = Get-Process -Id $cloudProc.Id -ErrorAction Stop
    } catch {
        $cloudRunning = $null
    }

    if ($null -eq $cloudRunning) {
        $tail = ""
        if (Test-Path $tunnelErr) {
            $tail = (Get-Content $tunnelErr -Tail 30 | Out-String).Trim()
        }

        if ([string]::IsNullOrWhiteSpace($tail)) {
            throw "Cloudflared failed to start. See logs:`n  $tunnelOut`n  $tunnelErr"
        }

        throw "Cloudflared failed to start. Recent stderr:`n$tail"
    }

    Set-Content -Path $cloudflaredPidFile -Value $cloudProc.Id
    Write-Output "Started cloudflared PID: $($cloudProc.Id)"
} else {
    Write-Output "Cloudflared already running PID: $($cloudProc.Id)"
}

Write-Output "Logs:"
Write-Output "  $backendOut"
Write-Output "  $backendErr"
Write-Output "  $frontendOut"
Write-Output "  $frontendErr"
Write-Output "  $tunnelOut"
Write-Output "  $tunnelErr"
