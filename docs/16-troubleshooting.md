# Troubleshooting

## Common Issues

| Symptom | Likely Cause | What to Check | Fix |
|---|---|---|---|
| `Maximum update depth exceeded` in frontend | repeated state update loop (often size/ref effects) | `dashboard/src/hooks/useElementSize.ts`, recent component ref wiring | Ensure state setter only runs on real value changes and avoid ref churn |
| Socket connects to wrong host/port (`ws://localhost:5173` fail) | incorrect `VITE_SOCKET_URL` or proxy assumptions | browser debug state, `runtimeConfig.ts`, Vite proxy config | Set `VITE_SOCKET_URL=http://localhost:3000` (or deploy origin), restart frontend |
| `/api/waba/connected-client-businesses` returns `500` | missing superadmin privileges, missing appId, or Meta permission/token issue | request auth token role, WABA config app ID, Graph API error payload | Use superadmin account + valid app/system-user token and required business permissions |
| MyAdmin shows zero companies | service role missing, or no data in expected tables, or auth role mismatch | `SUPABASE_SERVICE_ROLE_KEY`, `/api/admin/setup-status`, `/api/admin/summary` | configure service role key and ensure superadmin metadata flags are set |
| Settings show migration warning (`503 ... MISSING`) | required SQL migration not applied | API response `code` field and message | apply named migration from `supabase/migrations/` |
| Call settings/button not visible | feature hidden via `ui_hidden_features` or calling disabled in WABA | `/api/company/ui-controls`, `/api/waba/call-settings` | unhide feature from MyAdmin and enable calling settings |
| `WABA not configured for this profile` | no enabled `waba_configs` row for profile | `waba_configs` table and profile/company mapping | add/enable config via embedded signup/manual config |
| Login succeeds but no workspace data | user metadata missing `company_id` or subdomain mismatch | user metadata + host domain + profile company | update metadata/company membership and use matching subdomain |

## Migration-Specific Troubles

### UI controls missing

- Error code: `UI_CONTROLS_MISSING`
- Run: `20260407_company_ui_hidden_features.sql`

### Quick replies media columns missing

- Error code: `QUICK_REPLIES_MEDIA_MISSING`
- Run:
  - `20260408_quick_replies_media_support.sql`
  - `20260408_quick_replies_r2_storage.sql`
  - `20260414_quick_replies_multi_media.sql`

### App logo fields missing

- Error code: `APP_LOGO_FIELDS_MISSING`
- Run: `20260408_company_app_logo_storage.sql`

### Products table missing

- Error code: `PRODUCTS_TABLE_MISSING`
- Run: `20260307_webstore_products.sql`

## Runtime Debug Checklist

1. Confirm backend is up: `GET /health`.
2. Confirm frontend proxy target is correct (`dashboard/vite.config.ts`).
3. Confirm Supabase service role availability for admin/team operations.
4. Confirm WABA config for active profile (`waba_configs.enabled = true`).
5. Check server logs for Graph API error payload details.

## Screenshot Capture Checklist (if docs screenshots are needed)

Use this exact set for release docs:

1. **Login screen** (`/`):
   - state A: Sign In tab
   - state B: Create Company tab
2. **Team Inbox**:
   - state A: contact list + selected chat
   - state B: media message preview
3. **Automations**:
   - workflow list and quick replies section visible
4. **Broadcast**:
   - template builder page
   - scheduled broadcasts list
5. **Settings**:
   - Connect WhatsApp section
   - Business Profile section
   - Team Users section
6. **MyAdmin** (`/myadmin`):
   - totals cards + companies table
7. **Public store** (`/:companyId/store`):
   - product cards visible

Capture in desktop width (~1440px) and mobile width (~390px) for Team Inbox + Login.

## Suggested Log Collection for Bug Reports

- Browser console output
- Network tab request/response for failed endpoint
- Backend terminal logs around same timestamp
- Relevant profile ID / company ID / phone number ID (masked as needed)
