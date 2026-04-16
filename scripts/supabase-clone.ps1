param(
    [string]$SourceDbUrl = $env:SOURCE_SUPABASE_DB_URL,
    [string]$TargetDbUrl = $env:TARGET_SUPABASE_DB_URL,
    [string]$TargetProjectRef = $env:TARGET_SUPABASE_PROJECT_REF,
    [string]$TargetProjectName = $env:TARGET_SUPABASE_PROJECT_NAME,
    [string]$TargetOrgId = $env:TARGET_SUPABASE_ORG_ID,
    [string]$TargetRegion = $env:TARGET_SUPABASE_REGION,
    [string]$TargetDbPassword = $env:TARGET_SUPABASE_DB_PASSWORD,
    [switch]$SkipCreateProject,
    [switch]$SkipDump,
    [switch]$SkipRestore,
    [switch]$SkipFunctions,
    [switch]$SkipSecrets,
    [switch]$ApplyToDotEnv
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Invoke-Supabase {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [switch]$AllowFailure
    )

    $output = & npx supabase @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0 -and -not $AllowFailure) {
        throw "supabase $($Arguments -join ' ') failed.`n$($output -join "`n")"
    }
    return ,$output
}

function ConvertFrom-CliJson {
    param([Parameter(Mandatory = $true)][string[]]$Lines)

    $raw = ($Lines -join "`n").Trim()
    if ([string]::IsNullOrWhiteSpace($raw)) {
        throw 'Expected JSON output from Supabase CLI, but output was empty.'
    }

    $jsonStart = $raw.IndexOf('{')
    $arrayStart = $raw.IndexOf('[')
    if ($arrayStart -ge 0 -and ($jsonStart -lt 0 -or $arrayStart -lt $jsonStart)) {
        $jsonStart = $arrayStart
    }
    if ($jsonStart -gt 0) {
        $raw = $raw.Substring($jsonStart)
    }

    return $raw | ConvertFrom-Json
}

function Read-Prop {
    param(
        [Parameter(Mandatory = $true)]$Object,
        [Parameter(Mandatory = $true)][string]$Name
    )
    if ($null -ne $Object.PSObject.Properties[$Name]) {
        return $Object.$Name
    }
    return $null
}

function First-NonEmpty {
    param([Parameter(Mandatory = $true)][object[]]$Values)
    foreach ($value in $Values) {
        if ($null -ne $value) {
            $text = [string]$value
            if (-not [string]::IsNullOrWhiteSpace($text)) {
                return $text
            }
        }
    }
    return $null
}

function Require-Value {
    param(
        [AllowEmptyString()][string]$Value,
        [Parameter(Mandatory = $true)][string]$Name
    )
    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "Missing required value: $Name"
    }
}

function Build-DirectDbUrl {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectRef,
        [Parameter(Mandatory = $true)][string]$DbPassword
    )

    $encodedPassword = [Uri]::EscapeDataString($DbPassword)
    return "postgresql://postgres:$encodedPassword@db.$ProjectRef.supabase.co:5432/postgres"
}

if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
    throw 'npx is required but was not found in PATH.'
}

$migrationOutputDir = Join-Path $script:RepoRoot 'supabase\migration-output'
if (-not (Test-Path $migrationOutputDir)) {
    New-Item -Path $migrationOutputDir -ItemType Directory -Force | Out-Null
}

if (-not $SkipCreateProject -and [string]::IsNullOrWhiteSpace($TargetProjectRef)) {
    Require-Value -Value $env:SUPABASE_ACCESS_TOKEN -Name 'SUPABASE_ACCESS_TOKEN'
    Require-Value -Value $TargetProjectName -Name 'TARGET_SUPABASE_PROJECT_NAME'
    Require-Value -Value $TargetOrgId -Name 'TARGET_SUPABASE_ORG_ID'
    Require-Value -Value $TargetRegion -Name 'TARGET_SUPABASE_REGION'
    Require-Value -Value $TargetDbPassword -Name 'TARGET_SUPABASE_DB_PASSWORD'

    Write-Host "Creating target Supabase project '$TargetProjectName' in org '$TargetOrgId'..."
    $createOutput = Invoke-Supabase -Arguments @(
        'projects',
        'create',
        $TargetProjectName,
        '--org-id',
        $TargetOrgId,
        '--db-password',
        $TargetDbPassword,
        '--region',
        $TargetRegion,
        '-o',
        'json'
    )
    $createJson = ConvertFrom-CliJson -Lines $createOutput

    $candidateRef =
        (Read-Prop -Object $createJson -Name 'id'),
        (Read-Prop -Object $createJson -Name 'project_ref'),
        (Read-Prop -Object $createJson -Name 'ref') |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        Select-Object -First 1

    if ([string]::IsNullOrWhiteSpace($candidateRef)) {
        throw 'Could not determine target project ref from project creation output.'
    }

    $TargetProjectRef = [string]$candidateRef
    Write-Host "Created target project ref: $TargetProjectRef"
}

if ([string]::IsNullOrWhiteSpace($TargetDbUrl) -and
    -not [string]::IsNullOrWhiteSpace($TargetProjectRef) -and
    -not [string]::IsNullOrWhiteSpace($TargetDbPassword)) {
    $TargetDbUrl = Build-DirectDbUrl -ProjectRef $TargetProjectRef -DbPassword $TargetDbPassword
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $script:RepoRoot ("supabase\backups\$timestamp")
if (-not $SkipDump) {
    Require-Value -Value $SourceDbUrl -Name 'SOURCE_SUPABASE_DB_URL'
    New-Item -Path $backupDir -ItemType Directory -Force | Out-Null

    $rolesPath = Join-Path $backupDir '00_roles.sql'
    $schemaPath = Join-Path $backupDir '01_public_schema.sql'
    $authDataPath = Join-Path $backupDir '02_auth_data.sql'
    $publicDataPath = Join-Path $backupDir '03_public_data.sql'
    $storageDataPath = Join-Path $backupDir '04_storage_data.sql'

    Write-Host "Dumping source roles (best-effort): $rolesPath"
    Invoke-Supabase -Arguments @(
        'db',
        'dump',
        '--db-url',
        $SourceDbUrl,
        '--role-only',
        '--file',
        $rolesPath
    ) -AllowFailure | Out-Null

    Write-Host "Dumping source public schema: $schemaPath"
    Invoke-Supabase -Arguments @(
        'db',
        'dump',
        '--db-url',
        $SourceDbUrl,
        '--schema',
        'public',
        '--file',
        $schemaPath
    ) | Out-Null

    Write-Host "Dumping source auth data: $authDataPath"
    Invoke-Supabase -Arguments @(
        'db',
        'dump',
        '--db-url',
        $SourceDbUrl,
        '--data-only',
        '--schema',
        'auth',
        '--use-copy',
        '--file',
        $authDataPath
    ) | Out-Null

    Write-Host "Dumping source public data: $publicDataPath"
    Invoke-Supabase -Arguments @(
        'db',
        'dump',
        '--db-url',
        $SourceDbUrl,
        '--data-only',
        '--schema',
        'public',
        '--use-copy',
        '--file',
        $publicDataPath
    ) | Out-Null

    Write-Host "Dumping source storage data (best-effort): $storageDataPath"
    Invoke-Supabase -Arguments @(
        'db',
        'dump',
        '--db-url',
        $SourceDbUrl,
        '--data-only',
        '--schema',
        'storage',
        '--use-copy',
        '--file',
        $storageDataPath
    ) -AllowFailure | Out-Null

    Write-Host "Source dump complete: $backupDir"
}

if (-not $SkipRestore) {
    Require-Value -Value $TargetDbUrl -Name 'TARGET_SUPABASE_DB_URL or TARGET_SUPABASE_PROJECT_REF + TARGET_SUPABASE_DB_PASSWORD'
    if (-not (Test-Path $backupDir)) {
        throw "Backup directory not found for restore: $backupDir"
    }

    $rolesPath = Join-Path $backupDir '00_roles.sql'
    $schemaPath = Join-Path $backupDir '01_public_schema.sql'
    $authDataPath = Join-Path $backupDir '02_auth_data.sql'
    $publicDataPath = Join-Path $backupDir '03_public_data.sql'
    $storageDataPath = Join-Path $backupDir '04_storage_data.sql'

    if (Test-Path $rolesPath) {
        Write-Host "Restoring roles (best-effort): $rolesPath"
        Invoke-Supabase -Arguments @(
            'db',
            'query',
            '--db-url',
            $TargetDbUrl,
            '--file',
            $rolesPath
        ) -AllowFailure | Out-Null
    }

    Write-Host "Restoring public schema: $schemaPath"
    Invoke-Supabase -Arguments @(
        'db',
        'query',
        '--db-url',
        $TargetDbUrl,
        '--file',
        $schemaPath
    ) | Out-Null

    if (Test-Path $authDataPath) {
        Write-Host "Restoring auth data: $authDataPath"
        Invoke-Supabase -Arguments @(
            'db',
            'query',
            '--db-url',
            $TargetDbUrl,
            '--file',
            $authDataPath
        ) -AllowFailure | Out-Null
    }

    Write-Host "Restoring public data: $publicDataPath"
    Invoke-Supabase -Arguments @(
        'db',
        'query',
        '--db-url',
        $TargetDbUrl,
        '--file',
        $publicDataPath
    ) | Out-Null

    if (Test-Path $storageDataPath) {
        Write-Host "Restoring storage metadata data (best-effort): $storageDataPath"
        Invoke-Supabase -Arguments @(
            'db',
            'query',
            '--db-url',
            $TargetDbUrl,
            '--file',
            $storageDataPath
        ) -AllowFailure | Out-Null
    }

    Write-Host 'Restore complete.'
}

if (-not $SkipFunctions -and -not [string]::IsNullOrWhiteSpace($TargetProjectRef)) {
    Require-Value -Value $env:SUPABASE_ACCESS_TOKEN -Name 'SUPABASE_ACCESS_TOKEN (required for function deployment)'
    Write-Host 'Deploying Edge Function: waba-webhook'
    Invoke-Supabase -Arguments @(
        'functions',
        'deploy',
        'waba-webhook',
        '--project-ref',
        $TargetProjectRef,
        '--use-api'
    ) | Out-Null
}

if (-not $SkipSecrets -and -not [string]::IsNullOrWhiteSpace($TargetProjectRef)) {
    Require-Value -Value $env:SUPABASE_ACCESS_TOKEN -Name 'SUPABASE_ACCESS_TOKEN (required for secrets set)'
    $envFilePath = Join-Path $script:RepoRoot '.env'
    if (Test-Path $envFilePath) {
        $secretNames = @('WABA_VERIFY_TOKEN', 'WABA_APP_SECRET', 'WABA_FORWARD_URL')
        $pairs = @()
        foreach ($secretName in $secretNames) {
            $value = (Get-Item "Env:$secretName" -ErrorAction SilentlyContinue).Value
            if ([string]::IsNullOrWhiteSpace($value)) {
                $line = Select-String -Path $envFilePath -Pattern "^\s*$secretName\s*=\s*(.*)$" | Select-Object -First 1
                if ($line) {
                    $value = $line.Matches[0].Groups[1].Value.Trim().Trim('"').Trim("'")
                }
            }
            if (-not [string]::IsNullOrWhiteSpace($value)) {
                $pairs += "$secretName=$value"
            }
        }

        if ($pairs.Count -gt 0) {
            Write-Host 'Setting edge function secrets (WABA_VERIFY_TOKEN, WABA_APP_SECRET, WABA_FORWARD_URL when present)...'
            $secretArgs = @(
                'secrets',
                'set',
                '--project-ref',
                $TargetProjectRef
            ) + $pairs
            Invoke-Supabase -Arguments $secretArgs | Out-Null
        } else {
            Write-Host 'No matching WABA secrets were found locally; skipping secrets set.'
        }
    }
}

$newSupabaseUrl = $null
$newAnonKey = $null
$newServiceRoleKey = $null

if (-not [string]::IsNullOrWhiteSpace($TargetProjectRef)) {
    $newSupabaseUrl = "https://$TargetProjectRef.supabase.co"
}

if (-not [string]::IsNullOrWhiteSpace($TargetProjectRef) -and -not [string]::IsNullOrWhiteSpace($env:SUPABASE_ACCESS_TOKEN)) {
    Write-Host 'Fetching target API keys...'
    $keysOutput = Invoke-Supabase -Arguments @(
        'projects',
        'api-keys',
        '--project-ref',
        $TargetProjectRef,
        '-o',
        'json'
    )
    $keysJson = ConvertFrom-CliJson -Lines $keysOutput
    $keysArray = @()
    if ($keysJson -is [System.Array]) {
        $keysArray = $keysJson
    } else {
        $keysArray = @($keysJson)
    }

    foreach ($keyObj in $keysArray) {
        $nameValue = First-NonEmpty -Values @(
            (Read-Prop -Object $keyObj -Name 'name'),
            (Read-Prop -Object $keyObj -Name 'type')
        )
        $apiKeyValue = First-NonEmpty -Values @(
            (Read-Prop -Object $keyObj -Name 'api_key'),
            (Read-Prop -Object $keyObj -Name 'key'),
            (Read-Prop -Object $keyObj -Name 'value')
        )

        if ([string]::IsNullOrWhiteSpace($apiKeyValue)) {
            continue
        }

        $normalizedName = ([string]$nameValue).ToLowerInvariant()
        if (-not $newAnonKey -and ($normalizedName -like '*anon*' -or $normalizedName -like '*publishable*')) {
            $newAnonKey = $apiKeyValue
            continue
        }
        if (-not $newServiceRoleKey -and $normalizedName -like '*service_role*') {
            $newServiceRoleKey = $apiKeyValue
            continue
        }
    }
}

$outputEnvPath = Join-Path $migrationOutputDir 'new-project.env'
$outputLines = @()
if ($newSupabaseUrl) { $outputLines += "SUPABASE_URL=$newSupabaseUrl" }
if ($newAnonKey) {
    $outputLines += "SUPABASE_KEY=$newAnonKey"
    $outputLines += "SUPABASE_ANON_KEY=$newAnonKey"
    $outputLines += "VITE_SUPABASE_ANON_KEY=$newAnonKey"
    $outputLines += "VITE_SUPABASE_KEY=$newAnonKey"
    $outputLines += "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=$newAnonKey"
}
if ($newServiceRoleKey) { $outputLines += "SUPABASE_SERVICE_ROLE_KEY=$newServiceRoleKey" }
if ($newSupabaseUrl) {
    $outputLines += "VITE_SUPABASE_URL=$newSupabaseUrl"
    $outputLines += "NEXT_PUBLIC_SUPABASE_URL=$newSupabaseUrl"
}
if ($TargetProjectRef) { $outputLines += "TARGET_SUPABASE_PROJECT_REF=$TargetProjectRef" }

if ($outputLines.Count -gt 0) {
    Set-Content -Path $outputEnvPath -Value ($outputLines -join "`n")
    Write-Host "Wrote target project env template: $outputEnvPath"
}

if ($ApplyToDotEnv) {
    if (-not $newSupabaseUrl -or -not $newAnonKey -or -not $newServiceRoleKey) {
        throw 'Cannot apply to .env because URL/anon/service_role keys were not all discovered.'
    }
    $updateScriptPath = Join-Path $PSScriptRoot 'supabase-update-env.ps1'
    if (-not (Test-Path $updateScriptPath)) {
        throw "Update script not found: $updateScriptPath"
    }
    & $updateScriptPath `
        -InputFile (Join-Path $script:RepoRoot '.env') `
        -OutputFile (Join-Path $script:RepoRoot '.env') `
        -SupabaseUrl $newSupabaseUrl `
        -AnonKey $newAnonKey `
        -ServiceRoleKey $newServiceRoleKey
}

Write-Host 'Supabase clone workflow script finished.'
if (-not [string]::IsNullOrWhiteSpace($TargetProjectRef)) {
    Write-Host "Target project ref: $TargetProjectRef"
}
if (-not $SkipDump) {
    Write-Host "Backup folder: $backupDir"
}
