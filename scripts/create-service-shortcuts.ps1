[CmdletBinding()]
param(
    [string]$ShortcutName = "Qmessage Main Services",
    [string]$CloudflaredPath = "",
    [string]$CloudflaredConfig = "cloudflared-2fast.yml"
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$startScriptPath = (Resolve-Path (Join-Path $PSScriptRoot "start-services.ps1")).Path

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

$powerShellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScriptPath`" -CloudflaredPath `"$resolvedCloudflaredPath`" -CloudflaredConfig `"$resolvedConfig`""

$startupFolder = [Environment]::GetFolderPath("Startup")
$desktopFolder = [Environment]::GetFolderPath("Desktop")
$shortcutFileName = "$ShortcutName.lnk"

$startupShortcutPath = Join-Path $startupFolder $shortcutFileName
$desktopShortcutPath = Join-Path $desktopFolder $shortcutFileName

function New-OrUpdateShortcut {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ShortcutPath
    )

    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($ShortcutPath)
    $shortcut.TargetPath = $powerShellPath
    $shortcut.Arguments = $arguments
    $shortcut.WorkingDirectory = $repoRoot
    $shortcut.IconLocation = "$powerShellPath,0"
    $shortcut.Save()
}

New-OrUpdateShortcut -ShortcutPath $desktopShortcutPath
New-OrUpdateShortcut -ShortcutPath $startupShortcutPath

Write-Output "Created desktop shortcut: $desktopShortcutPath"
Write-Output "Created startup shortcut: $startupShortcutPath"
Write-Output "Launch command: $powerShellPath $arguments"
