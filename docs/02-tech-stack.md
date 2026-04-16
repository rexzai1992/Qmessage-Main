# Tech Stack

## Frontend

- React `19.2.x`
- Vite `7.x`
- TypeScript `5.9.x`
- Socket.IO client `4.8.x`
- UI libs: `lucide-react`, `framer-motion`, `@xyflow/react`

Relevant files:

- `dashboard/package.json`
- `dashboard/src/App.tsx`
- `dashboard/vite.config.ts`

## Backend

- Node.js `20.x` (required by `package.json` engines)
- Express `5.2.x`
- Socket.IO server `4.8.x`
- TypeScript + `tsx` runtime

Relevant files:

- `package.json`
- `dashboard-server.ts`
- `dashboard-server/routes/*.ts`
- `dashboard-server/socket/registerSocketHandlers.ts`

## Database and Auth

- Supabase Postgres (multi-tenant app data)
- Supabase Auth (session + user identity)
- Supabase service role usage for admin/system operations

Relevant files:

- `src/supabase.ts`
- `dashboard/src/supabase.ts`
- `supabase/migrations/*.sql`

## External Integrations

- Meta Graph API / WhatsApp Cloud API
- Optional Cloudflare R2 object storage (media/logo)
- Optional Supabase Edge Function for webhook forwarding (`supabase/functions/waba-webhook/index.ts`)

## Tooling

- Test: Jest + ts-jest (ESM)
- Lint: ESLint flat config + Prettier plugin
- Build: TypeScript compile + Vite build
- CI: GitHub Actions workflows for build/lint/test
- Containerization: Dockerfile + docker-compose

## Package Manager

- Primary: Yarn 4 (`packageManager: yarn@4.9.2`)
- Also present: npm lockfiles (`package-lock.json`) and npm scripts are used in local workflows.

## Hosting Model (as implemented)

- Backend serves SPA build from `dashboard/dist` when present.
- Vite dev server proxies API/socket calls to backend.
- Cloudflared tunnel config points `2fast.xyz` and `*.2fast.xyz` to local backend port 3000.
