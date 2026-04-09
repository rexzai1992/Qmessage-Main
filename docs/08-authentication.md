# Authentication

## Identity Provider

- Supabase Auth is the sole identity provider.
- Frontend uses `dashboard/src/supabase.ts` client.
- Backend validates bearer tokens via `supabaseAuth.auth.getUser(token)`.

## Login and Signup Flows

### Email/Password Login

1. User submits email/password in `Login.tsx`.
2. Frontend calls `supabase.auth.signInWithPassword`.
3. Session is returned and stored in frontend state.
4. App initializes socket with `auth.token`.

### Company Signup

1. User submits company ID + credentials.
2. Frontend calls `POST /api/public/signup-company`.
3. Backend creates:
   - Auth user
   - `company` row
   - `user_roles` owner membership
   - initial `profiles` row
4. Frontend immediately signs in with same credentials.

### Google OAuth Sign-In

- Triggered from `Login.tsx` in login mode.
- Uses `supabase.auth.signInWithOAuth({ provider: 'google' })`.
- Company ID validation is enforced after session is returned.

## Session Handling

- Frontend stores session in React state (`App.tsx`).
- On load, app checks `supabase.auth.getSession()` and listens to `onAuthStateChange`.
- If session missing/expired, login view renders.

## Protected API Access

Most tenant APIs require:

- `Authorization: Bearer <supabase_access_token>`
- `requireSupabaseUserMiddleware` wrapping
- Profile/company ownership checks via:
  - `resolveProfileAccess(req,res)` (profile-scoped routes)
  - `resolveCompanyAccess(req,res, minimumRole)` (company/role-scoped routes)

## Role Model

### Tenant roles (`user_roles.role`)

- `owner` (highest)
- `admin`
- `agent`

Role checks use `hasRoleAtLeast()` ordering.

### Superadmin

Superadmin is identified from Supabase user/app metadata flags:

- `role` in `{super_admin, superadmin, super-admin}`
- or boolean-ish flags (`super_admin`, `is_super_admin`)

Superadmin is required for `/api/admin/*`, `/my`, and privileged connected-businesses access.

## Socket Authentication

Socket middleware (`registerSocketHandlers.ts`):

1. Reads `socket.handshake.auth.token`.
2. Validates with Supabase Auth.
3. Enforces company constraints:
   - user company assignment
   - host/subdomain company match when applicable
4. Joins rooms:
   - user room: `<userId>`
   - company room: `company:<companyId>`

## Route Guard Behavior

- Unauthorized token -> `401`
- Valid token but no tenant/scope/role -> `403` or `400` with explicit error message
- Missing migration columns -> often `503` with migration guidance

## Multi-Tenant Domain Guard

Both frontend and backend derive company from host (`*.2fast.xyz`) and reject mismatched sessions.

- Frontend: `dashboard/src/runtimeConfig.ts`
- Backend: `resolveCompanyIdFromHostname()` in `dashboard-server.ts`
