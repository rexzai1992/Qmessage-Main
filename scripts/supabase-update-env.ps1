param(
    [string]$InputFile = '.env',
    [string]$OutputFile = '.env',
    [string]$SupabaseUrl = $env:NEW_SUPABASE_URL,
    [string]$AnonKey = $env:NEW_SUPABASE_ANON_KEY,
    [string]$ServiceRoleKey = $env:NEW_SUPABASE_SERVICE_ROLE_KEY
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Require-Value {
    param(
        [AllowEmptyString()][string]$Value,
        [Parameter(Mandatory = $true)][string]$Name
    )
    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "Missing required value: $Name"
    }
}

function Set-Or-AppendKey {
    param(
        [Parameter(Mandatory = $true)][System.Collections.IList]$Lines,
        [Parameter(Mandatory = $true)][string]$Key,
        [Parameter(Mandatory = $true)][string]$Value
    )

    $updated = $false
    for ($i = 0; $i -lt $Lines.Count; $i += 1) {
        if ($Lines[$i] -match "^\s*$([Regex]::Escape($Key))\s*=") {
            $Lines[$i] = "$Key=$Value"
            $updated = $true
            break
        }
    }

    if (-not $updated) {
        $Lines.Add("$Key=$Value") | Out-Null
    }
}

Require-Value -Value $SupabaseUrl -Name 'SupabaseUrl'
Require-Value -Value $AnonKey -Name 'AnonKey'
Require-Value -Value $ServiceRoleKey -Name 'ServiceRoleKey'

$resolvedInput = $InputFile
if (-not [System.IO.Path]::IsPathRooted($resolvedInput)) {
    $resolvedInput = (Join-Path (Get-Location) $resolvedInput)
}
$resolvedOutput = $OutputFile
if (-not [System.IO.Path]::IsPathRooted($resolvedOutput)) {
    $resolvedOutput = (Join-Path (Get-Location) $resolvedOutput)
}

$lines = New-Object System.Collections.ArrayList
if (Test-Path $resolvedInput) {
    foreach ($line in (Get-Content -Path $resolvedInput)) {
        $lines.Add($line) | Out-Null
    }
}

Set-Or-AppendKey -Lines $lines -Key 'SUPABASE_URL' -Value $SupabaseUrl
Set-Or-AppendKey -Lines $lines -Key 'SUPABASE_KEY' -Value $AnonKey
Set-Or-AppendKey -Lines $lines -Key 'SUPABASE_ANON_KEY' -Value $AnonKey
Set-Or-AppendKey -Lines $lines -Key 'SUPABASE_SERVICE_ROLE_KEY' -Value $ServiceRoleKey
Set-Or-AppendKey -Lines $lines -Key 'VITE_SUPABASE_URL' -Value $SupabaseUrl
Set-Or-AppendKey -Lines $lines -Key 'VITE_SUPABASE_ANON_KEY' -Value $AnonKey
Set-Or-AppendKey -Lines $lines -Key 'VITE_SUPABASE_KEY' -Value $AnonKey
Set-Or-AppendKey -Lines $lines -Key 'NEXT_PUBLIC_SUPABASE_URL' -Value $SupabaseUrl
Set-Or-AppendKey -Lines $lines -Key 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY' -Value $AnonKey

if ($resolvedInput -eq $resolvedOutput -and (Test-Path $resolvedInput)) {
    $backupPath = "$resolvedInput.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item -Path $resolvedInput -Destination $backupPath -Force
    Write-Host "Created backup: $backupPath"
}

Set-Content -Path $resolvedOutput -Value ($lines -join "`n")
Write-Host "Updated Supabase env values: $resolvedOutput"
