# Supabase Clone Runbook

This runbook clones the current app database/auth/storage metadata into a new Supabase project in another account/org (project-copy path, not project transfer).

## Why This Repo Uses Dump/Restore

- `supabase/migrations/` does **not** contain full base schema creation for core tables (`company`, `users`, `messages`, etc.).
- Because of that, migrations-only bootstrap is not enough for a full clone.
- Recommended path here is:
  1. create new project
  2. dump source (`public` schema + `auth`/`storage` data)
  3. restore to target
  4. deploy edge function and secrets
  5. switch app env

## Prerequisites

1. Supabase personal access token in `SUPABASE_ACCESS_TOKEN`.
2. Target org id (`TARGET_SUPABASE_ORG_ID`).
3. Source DB URL (`SOURCE_SUPABASE_DB_URL`) from source project DB settings.
4. Target DB password (`TARGET_SUPABASE_DB_PASSWORD`) for project creation.
5. Node.js and `npx` available.

Copy `.env.example` to `.env` and fill required values before running.

## One-Command Clone

```powershell
npm run supabase:clone
```

What this script does (`scripts/supabase-clone.ps1`):

1. Creates target project (if `TARGET_SUPABASE_PROJECT_REF` not provided).
2. Dumps source:
   - roles (best-effort)
   - `public` schema
   - `auth` data
   - `public` data
   - `storage` data (best-effort)
3. Restores dump to target.
4. Deploys edge function `waba-webhook`.
5. Sets edge secrets (`WABA_VERIFY_TOKEN`, `WABA_APP_SECRET`, `WABA_FORWARD_URL` when available).
6. Writes discovered target env values to `supabase/migration-output/new-project.env`.

## Apply New Supabase Credentials to App

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/supabase-update-env.ps1 `
  -InputFile .env `
  -OutputFile .env `
  -SupabaseUrl "https://<new-project-ref>.supabase.co" `
  -AnonKey "<new-anon-key>" `
  -ServiceRoleKey "<new-service-role-key>"
```

Or run clone with auto-apply:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/supabase-clone.ps1 -ApplyToDotEnv
```

## Verification Checklist

1. `npm run dev` starts backend + frontend.
2. Login works (`supabase.auth.signInWithPassword`).
3. Company/workflow/messages APIs read/write successfully.
4. Superadmin endpoints that need service-role key work.
5. Edge function is deployed:
   - `supabase functions deploy waba-webhook --project-ref <ref> --use-api`
6. Edge secrets are present:
   - `WABA_VERIFY_TOKEN`
   - `WABA_APP_SECRET` (or `WABA_APP_SECRETS`)
   - `WABA_FORWARD_URL`

## Manual Follow-Ups (Cannot Be Fully Cloned From Repo Alone)

1. Supabase Auth provider dashboard config (Google OAuth client/secret).
2. Auth redirect URLs for the new project domain.
3. Any dashboard-only project settings not represented in SQL/migrations.
4. Physical storage objects if you depend on bucket files beyond DB metadata.
5. Rotating old leaked/hardcoded keys and decommissioning old project access.
