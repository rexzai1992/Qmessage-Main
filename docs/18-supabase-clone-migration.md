# Supabase Clone Migration Runbook

This runbook is for cloning this app's Supabase project into another project/account using dump/restore (project-copy flow, not ownership transfer).

## Why This Repo Uses Dump/Restore

- `supabase/migrations/` is not a complete base bootstrap for all production tables.
- A migrations-only fresh project will miss required app data/state.
- The supported path in this repo is:
  1. create or choose target project
  2. dump source DB schema/data
  3. restore to target DB
  4. deploy Edge Function + secrets
  5. update app `.env` to target keys

## Required Inputs

### Tools

- Node.js + `npx`
- Supabase CLI (invoked via `npx supabase`)

### Environment Variables

Set these in `.env` (or export in shell before running):

- `SUPABASE_ACCESS_TOKEN` (required for project create, function deploy, secrets set, api key fetch)
- `SOURCE_SUPABASE_DB_URL` (required unless using `-SkipDump`)
- `TARGET_SUPABASE_DB_PASSWORD` (required when creating target project or building target DB URL from project ref)
- `TARGET_SUPABASE_PROJECT_NAME` (required when creating target project)
- `TARGET_SUPABASE_ORG_ID` (required when creating target project)
- `TARGET_SUPABASE_REGION` (required when creating target project)

Optional:

- `TARGET_SUPABASE_PROJECT_REF` (skip project creation when provided)
- `TARGET_SUPABASE_DB_URL` (explicit target DB URL; bypass derived URL logic)

## Quick Start

```powershell
npm run supabase:clone
```

This runs `scripts/supabase-clone.ps1`, which will:

1. Create target project (if `TARGET_SUPABASE_PROJECT_REF` is empty).
2. Dump source DB into `supabase/backups/<timestamp>/`:
   - `00_roles.sql` (best-effort)
   - `01_public_schema.sql`
   - `02_auth_data.sql`
   - `03_public_data.sql`
   - `04_storage_data.sql` (best-effort)
3. Restore those files into target DB.
4. Deploy Edge Function: `waba-webhook`.
5. Set function secrets from local env/.env when present:
   - `WABA_VERIFY_TOKEN`
   - `WABA_APP_SECRET`
   - `WABA_FORWARD_URL`
6. Write discovered target env template to:
   - `supabase/migration-output/new-project.env`

## Common Run Modes

### A) Create new target project + clone

```powershell
npm run supabase:clone
```

### B) Clone into existing target project

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/supabase-clone.ps1 `
  -TargetProjectRef "<target-project-ref>" `
  -TargetDbPassword "<target-db-password>"
```

### C) Skip selected stages

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/supabase-clone.ps1 `
  -SkipFunctions -SkipSecrets
```

Available skip flags:

- `-SkipCreateProject`
- `-SkipDump`
- `-SkipRestore`
- `-SkipFunctions`
- `-SkipSecrets`

## Update App Env to Target Project

### Auto apply during clone

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/supabase-clone.ps1 -ApplyToDotEnv
```

### Manual apply

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/supabase-update-env.ps1 `
  -InputFile .env `
  -OutputFile .env `
  -SupabaseUrl "https://<target-ref>.supabase.co" `
  -AnonKey "<anon-key>" `
  -ServiceRoleKey "<service-role-key>"
```

Notes:

- When `InputFile == OutputFile`, the script creates `.env.bak-<timestamp>` automatically.
- It updates/adds:
  - `SUPABASE_URL`
  - `SUPABASE_KEY`
  - `SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_ANON_KEY`
  - `VITE_SUPABASE_KEY`
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`

## Verification Checklist

1. `npm run dev` starts backend/frontend successfully.
2. Auth login works against target project.
3. Core data paths (company/users/messages/workflows) read/write correctly.
4. `waba-webhook` is deployed to target project.
5. Edge secrets exist in target project.
6. `supabase/migration-output/new-project.env` contains expected target URL/keys.

## Manual Follow-Ups (Not Fully Cloned by Script)

1. Auth provider settings (Google OAuth client/secret, etc.).
2. Auth redirect URLs and site URL in Supabase dashboard.
3. Storage file objects (script clones storage metadata; object files may require separate copy).
4. Any dashboard-only project settings outside DB/function/secrets.
5. Rotate/decommission old keys and old project access after cutover.

## Security Notes

- Backup SQL files can contain sensitive data. Handle `supabase/backups/` as sensitive artifacts.
- Do not commit temporary/generated files with credentials (for example Android generated build folders).
