# Deployment

## Deployment Modes

## 1) Single Node Process (recommended baseline)

Backend serves API + socket + built frontend.

### Steps

```bash
npm install
npm run build --prefix dashboard
npm start
```

Environment:

- Ensure Supabase and WABA env variables are present.
- Set `PORT` for host environment.

## 2) Docker

Files:

- `Dockerfile` (multi-stage build)
- `docker-compose.yml`

### Dockerfile behavior

1. Build frontend in stage 1 (`dashboard` build).
2. Install backend deps in stage 2.
3. Copy repo + frontend dist.
4. Start server with `npx tsx dashboard-server.ts`.

### Compose behavior

- Service name: `wsbarly`
- Host mapping: `3001:3001` (verify app `PORT` value to avoid mismatch)
- Mounts persistent local volume `./app_data:/app/data`

## 3) Tunnel-based External Access

Config: `cloudflared-2fast.yml`

Ingress routes:

- `2fast.xyz` -> `http://localhost:3000`
- `*.2fast.xyz` -> `http://localhost:3000`

## 4) Wonderpark Runtime

Command:

```bash
npm run start:wonderpark
```

- Separate process entry: `wonderpark/dashboard-server.ts`
- Default port: `3101`
- Optional company lock: `WONDERPARK_COMPANY_ID`

## CI/CD

GitHub Actions workflows:

- `.github/workflows/build.yml` -> `yarn build`
- `.github/workflows/lint.yml` -> `yarn lint`
- `.github/workflows/test.yml` -> `yarn test`

Node target in CI: `20.x` with Yarn 4 via Corepack.

## Environment Setup Checklist

1. Supabase URL + keys configured.
2. Service role key configured for admin/setup/team invite flows.
3. WABA app credentials + verify token configured.
4. Token encryption key configured.
5. Migrations applied.
6. Optional R2 credentials configured for file/logo storage.

## Production Hardening Recommendations

- Replace `cors({ origin: '*' })` with allowed origins list.
- Ensure no default credentials remain (e.g., `ADMIN_PASSWORD` fallback usage).
- Enforce TLS termination in front proxy/load balancer.
- Add process supervisor (PM2/systemd/K8s) and health checks.
- Externalize background jobs if horizontal scaling is planned.
