# Create New App/Web From This Repo

Use this guide when you want to reuse `Qmessage-Main` as a base and launch a new branded app/web with its own domain, Supabase project, and credentials.

## Outcome

After this guide:

- You have a new codebase copy/fork.
- The app points to a new Supabase project.
- Domain and branding are switched from default `QMessage`/`2fast.xyz`.
- Backend, frontend, and cloudflared run for the new app.

## 1) Create Your New Repo

Choose one:

- Fork this repository and rename it.
- Clone this repository and push to a new GitHub repo.

Example:

```bash
git clone https://github.com/rexzai1992/Qmessage-Main.git my-new-app
cd my-new-app
git remote set-url origin https://github.com/<you>/<new-repo>.git
```

## 2) Install Dependencies

```bash
npm install
npm install --prefix dashboard
```

## 3) Create New Supabase Project

Use the clone script runbook:

- [Supabase Clone Migration Runbook](./18-supabase-clone-migration.md)

Fast path:

1. Fill required clone vars in `.env`:
   - `SUPABASE_ACCESS_TOKEN`
   - `SOURCE_SUPABASE_DB_URL`
   - `TARGET_SUPABASE_PROJECT_NAME`
   - `TARGET_SUPABASE_ORG_ID`
   - `TARGET_SUPABASE_REGION`
   - `TARGET_SUPABASE_DB_PASSWORD`
2. Run:

```bash
npm run supabase:clone
```

3. Apply target keys to `.env`:

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/supabase-clone.ps1 -ApplyToDotEnv
```

## 4) Switch Core Environment Values

Update `.env` at minimum:

- `TENANT_ROOT_DOMAIN=<your-domain>`
- `SUPABASE_URL=<new-project-url>`
- `SUPABASE_KEY=<new-anon-key>`
- `SUPABASE_SERVICE_ROLE_KEY=<new-service-role-key>`
- `VITE_SUPABASE_URL=<new-project-url>`
- `VITE_SUPABASE_ANON_KEY=<new-anon-key>`
- `WABA_VERIFY_TOKEN=<new-token>`
- `WABA_APP_ID=<new-meta-app-id>`
- `WABA_APP_SECRET=<new-meta-app-secret>`
- `WABA_TOKEN_ENCRYPTION_KEY=<new-random-secret>`

## 5) Replace Branding + Domain References

Search and replace the defaults:

- `QMessage` -> your product name
- `2fast.xyz` -> your root domain
- `qmessage` -> your app slug (when relevant)

Recommended files to update first:

- `README.md`
- `dashboard/index.html`
- `dashboard/public/manifest.webmanifest`
- `dashboard/src/Login.tsx`
- `dashboard/src/App.tsx`
- `dashboard-server.ts` (default title/domain fallbacks)
- `dashboard/vite.config.ts` (`allowedHosts`)
- `.env.example`

## 6) If Using Capacitor Native App

Update Android app identity:

- `dashboard/capacitor.config.ts`:
  - `appId`
  - `appName`
- `dashboard/android/app/build.gradle`:
  - `namespace`
  - `applicationId`
- `dashboard/android/app/src/main/res/values/strings.xml`:
  - `app_name`
  - package/scheme strings

Then re-sync:

```bash
npm run cap:sync
```

## 7) Configure Tunnel (Optional)

If using cloudflared, update:

- `cloudflared-2fast.yml`
  - `tunnel` id
  - `credentials-file`
  - ingress hostnames

## 8) Run Locally

```bash
npm run dev
```

Or managed services script:

```bash
npm run services:start:all
```

Default local URLs:

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3000`

## 9) Verify Before Going Live

1. Login/signup works.
2. Socket connects and chat/inbox loads.
3. Workflow execution works.
4. WABA webhook verification succeeds.
5. Template send works from target Meta app/profile.
6. All old domains/branding strings are removed from UI and API responses.

## 10) Security Cleanup (Required)

Before launch:

1. Rotate any previously exposed PAT/API keys.
2. Ensure no generated build artifacts with secrets are tracked (`dashboard/android/.gradle-build*` should stay ignored).
3. Ensure service account files are not committed.
4. Re-check with:


```
