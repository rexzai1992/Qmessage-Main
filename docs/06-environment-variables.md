# Environment Variables

## Security Note

The repository currently has a root `.env` file. Treat all values as secrets and rotate any credential that has ever been committed/shared.

## Server Variables (`process.env.*`)

| Variable | Required | Purpose | Used In |
|---|---|---|---|
| `PORT` | Optional (default `3000`) | Backend listen port | `dashboard-server.ts`, `wonderpark/dashboard-server.ts` |
| `TENANT_ROOT_DOMAIN` | Optional (default `2fast.xyz`) | Subdomain-to-company resolution | `dashboard-server.ts` |
| `DASHBOARD_URL` | Optional | OAuth return URL fallback | `dashboard-server.ts` |
| `ADMIN_PASSWORD` | Optional (legacy fallback) | Legacy admin HTML flow fallback password | `dashboard-server.ts`, `wonderpark/dashboard-server.ts` |

### Supabase

| Variable | Required | Purpose |
|---|---|---|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_KEY` / `SUPABASE_ANON_KEY` | Yes | Publishable key for auth/user-scoped calls |
| `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_SERVICE_KEY` | Strongly recommended (required for admin flows) | Service-role DB and auth admin operations |
| `SUPABASE_PROJECT_REF` | Optional | Used by helper scripts (`ngrok-forward`) |

### WABA / Meta

| Variable | Required | Purpose |
|---|---|---|
| `WABA_VERIFY_TOKEN` | Yes | Webhook verification token |
| `WABA_APP_ID` | Yes | Meta app ID |
| `WABA_APP_SECRET` | Yes | Meta app secret / signature validation |
| `WABA_API_VERSION` | Optional (default `v19.0`) | Graph API version |
| `WABA_PHONE_NUMBER_ID` | Optional | Single-profile env fallback mode |
| `WABA_ACCESS_TOKEN` / `WABA_TOKEN` | Optional | Single-profile env fallback token |
| `WABA_PROFILE_ID` | Optional | Env fallback profile ID |
| `WABA_COMPANY_ID` | Optional | Env fallback company ID |
| `WABA_BUSINESS_ACCOUNT_ID` | Optional | Env fallback WABA account ID |
| `WABA_SYSTEM_USER_ID` | Optional | System-user token creation support |
| `WABA_EMBEDDED_SIGNUP_CONFIG_ID` | Optional | Embedded signup config |
| `WABA_EMBEDDED_SIGNUP_PREVERIFIED_IDS` / `WABA_PREVERIFIED_PHONE_IDS` | Optional | Preverified number IDs |
| `WABA_OAUTH_MODE` | Optional | OAuth mode selection (`user` / `business_integration`) |
| `WABA_OAUTH_REDIRECT_URI` | Optional | OAuth callback URL |
| `WABA_OAUTH_RETURN_URL` | Optional | OAuth post-completion return URL |
| `APP_ID`, `APP_SECRET`, `VERIFY_TOKEN` | Optional legacy aliases | Backward compatibility |

### Token Encryption

| Variable | Required | Purpose |
|---|---|---|
| `WABA_TOKEN_ENCRYPTION_KEY` / `TOKEN_ENCRYPTION_KEY` | Recommended | Encrypt/decrypt WABA tokens in DB |

### Cloudflare R2 (optional storage)

| Variable | Required | Purpose |
|---|---|---|
| `R2_ACCOUNT_ID` | Optional (required only if using R2) | R2 account |
| `R2_BUCKET` | Optional | Bucket name |
| `R2_ACCESS_KEY_ID` | Optional | S3-compatible key |
| `R2_SECRET_ACCESS_KEY` | Optional | S3-compatible secret |
| `R2_UPLOAD_URL_TTL_SECONDS` | Optional | Presigned upload URL TTL |
| `R2_DOWNLOAD_URL_TTL_SECONDS` | Optional | Presigned download URL TTL |
| `R2_MAX_UPLOAD_BYTES` | Optional | Generic upload max size |
| `R2_MAX_IMAGE_BYTES` | Optional | Image upload max |
| `R2_MAX_VIDEO_BYTES` | Optional | Video upload max |
| `R2_MAX_DOCUMENT_BYTES` | Optional | Document upload max |
| `APP_LOGO_MAX_BYTES` | Optional | Maximum app-logo upload size |

### Workflow Runtime

| Variable | Required | Purpose |
|---|---|---|
| `WORKFLOW_FALLBACK_TEXT` | Optional | Default fallback automation message |
| `WORKFLOW_FALLBACK_LIMIT` | Optional | Max fallback retries |

### Wonderpark Runtime

| Variable | Required | Purpose |
|---|---|---|
| `WONDERPARK_DATA_DIR` | Optional | Alternate runtime data folder |
| `WONDERPARK_COMPANY_ID` | Optional | Hard-lock runtime to one company |

### Script/CI Helpers

| Variable | Purpose |
|---|---|
| `NGROK_PORT`, `NGROK_FORWARD_PATH`, `NGROK_API_URL`, `NGROK_AUTOSTART` | ngrok helper script behavior |
| `SOCKET_URL` | Example runtime sample usage |
| `ADV_SECRET_KEY` | Example file (`Example/example.ts`) |
| `GITHUB_OUTPUT` | CI workflow script output |

### Supabase Clone Script Inputs

Used by `scripts/supabase-clone.ps1` and `scripts/supabase-update-env.ps1`.

| Variable | Required | Purpose |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | Yes (for create project / keys / functions / secrets) | Supabase management API access |
| `TARGET_SUPABASE_ORG_ID` | Yes (when creating target project) | Destination org/account |
| `TARGET_SUPABASE_PROJECT_NAME` | Yes (when creating target project) | New project name |
| `TARGET_SUPABASE_REGION` | Yes (when creating target project) | New project region |
| `TARGET_SUPABASE_DB_PASSWORD` | Yes (when creating target project) | New project DB password |
| `SOURCE_SUPABASE_DB_URL` | Yes (for dump) | Source DB connection URL |
| `TARGET_SUPABASE_DB_URL` | Optional (if `TARGET_SUPABASE_PROJECT_REF` + password are set) | Target DB connection URL |
| `TARGET_SUPABASE_PROJECT_REF` | Optional | Existing target project ref; skips create step |

## Frontend Variables (`import.meta.env.*`)

| Variable | Required | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL` | Recommended | Frontend Supabase URL |
| `VITE_SUPABASE_ANON_KEY` / `VITE_SUPABASE_KEY` | Recommended | Frontend Supabase key |
| `VITE_SOCKET_URL` | Optional | API/socket origin override |
| `MODE`, `DEV` | Built-in | Vite runtime flags |

## Suggested `.env` Baseline

```env
PORT=3000
TENANT_ROOT_DOMAIN=2fast.xyz

SUPABASE_URL=
SUPABASE_KEY=
SUPABASE_SERVICE_ROLE_KEY=

WABA_VERIFY_TOKEN=
WABA_APP_ID=
WABA_APP_SECRET=
WABA_TOKEN_ENCRYPTION_KEY=
WABA_API_VERSION=v25.0

# Optional
VITE_SOCKET_URL=http://localhost:3000
R2_ACCOUNT_ID=
R2_BUCKET=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
```
