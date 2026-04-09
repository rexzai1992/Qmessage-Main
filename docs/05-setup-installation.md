# Setup & Installation

## Prerequisites

- Node.js `20.x`
- npm or Yarn (repo is configured for Yarn 4, but npm scripts are also used)
- Supabase project (URL + keys)
- Meta app + WhatsApp Cloud API credentials
- Optional: Cloudflare R2 credentials

## 1) Install Dependencies

### Option A: npm

```bash
npm install
npm install --prefix dashboard
```

### Option B: Yarn 4 (project default)

```bash
corepack enable
corepack prepare yarn@4.9.2 --activate
yarn install
```

## 2) Configure Environment

Copy `.env.example` to `.env` and fill your real values.

Minimum local dev variables:

```env
PORT=3000
SUPABASE_URL=...
SUPABASE_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
WABA_VERIFY_TOKEN=...
WABA_APP_ID=...
WABA_APP_SECRET=...
WABA_TOKEN_ENCRYPTION_KEY=...
```

Frontend reads Vite env values if provided:

```env
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
VITE_SOCKET_URL=http://localhost:3000
```

Supabase clone/move helpers:

```bash
npm run supabase:clone
npm run supabase:update-env
```

## 3) Apply Database Migrations

Run all SQL migrations in `supabase/migrations/` in order.

Important: several features return `503` until migrations are present (UI controls, quick reply media, app logo storage, products, scheduled broadcasts).

## 4) Run Local Development

```bash
npm run dev
```

This launches:

- Backend: `tsx watch dashboard-server.ts` on `http://localhost:3000`
- Frontend: Vite on `http://localhost:5173`

Vite proxies `/api`, `/socket.io`, `/addon`, `/webhook` to backend.

## 5) Production Build

### Build backend library artifacts

```bash
npm run build
```

### Build frontend bundle

```bash
npm run build --prefix dashboard
```

### Start server

```bash
npm start
```

Backend serves `dashboard/dist` when available.

## 6) Docker

```bash
docker compose up --build
```

Notes:

- Multi-stage Dockerfile builds frontend then runs backend via `tsx`.
- `docker-compose.yml` maps host `3001` -> container `3001` currently, while server default is `3000` unless `PORT` is set.
- Align `PORT` and compose mappings before production use.

## 7) Optional: Wonderpark Runtime

```bash
npm run start:wonderpark
```

Defaults to port `3101` and uses `WONDERPARK_DATA_DIR`/`WONDERPARK_COMPANY_ID`.

## 8) Optional: Cloudflared Tunnel

`cloudflared-2fast.yml` routes:

- `2fast.xyz` -> `http://localhost:3000`
- `*.2fast.xyz` -> `http://localhost:3000`

Start with your local cloudflared installation and matching credentials file.
