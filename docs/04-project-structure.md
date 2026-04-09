# Project Structure

## Root Layout

```text
Qmessage-Main/
+- dashboard/                 # React + Vite frontend
+- dashboard-server/          # Backend route modules, middleware, services, socket handlers
+- src/                       # Core messaging, WABA client/registry, workflow engine, addon system
+- supabase/                  # SQL migrations and edge function(s)
+- wonderpark/                # Alternate runtime variant (separate server entry)
+- data/                      # Local JSON/runtime artifacts
+- .github/workflows/         # CI workflows
+- dashboard-server.ts        # Main backend entrypoint
+- package.json               # Root scripts/dependencies
+- Dockerfile / docker-compose.yml
```

## Frontend (`dashboard/`)

- `src/main.tsx`: SPA bootstrap.
- `src/App.tsx`: main workspace shell, socket lifecycle, global state.
- `src/Login.tsx`: sign in/sign up and Google OAuth flow.
- `src/WebhookView.tsx`: settings panels (WABA setup, business profile, call settings, etc.).
- `src/features/workspace/*`: workspace sections (`AutomationsView`, `BroadcastView`, `ChatbotsView`, `ContactsView`, `SettingsView`, `ChatflowView`).
- `src/features/media/*`: file upload helpers for WABA media and company storage.

## Backend (`dashboard-server/` + `dashboard-server.ts`)

- `dashboard-server.ts`: server wiring, auth helpers, route registration, webhook entrypoints, myadmin HTML/API, static serving.
- `routes/flowRoutes.ts`: health, workflows CRUD, analytics.
- `routes/publicAuthRoutes.ts`: tenant/company sign-up.
- `routes/publicInfoRoutes.ts`: support/privacy/terms pages.
- `routes/companyRoutes.ts`: company fallback settings, UI controls, app logo, media upload URL, quick replies, team users.
- `routes/storeRoutes.ts`: webstore settings/products/public store pages.
- `routes/aiRoutes.ts`: AI settings + text generation endpoints.
- `routes/wabaRoutes.ts`: WABA onboarding/config/templates/media/calls/broadcasts/business profile/etc.
- `socket/registerSocketHandlers.ts`: all realtime handlers and socket auth.
- `middleware/auth.ts`, `middleware/error.ts`: auth wrappers and global error handler.

## Core Services (`src/`)

- `src/waba/client.ts`: typed wrapper around Graph API endpoints.
- `src/waba/registry.ts`: loads enabled WABA configs from Supabase (fallback env support).
- `src/waba/webhook.ts`: signature verification + payload parser.
- `src/services/wa-store.ts`: data access helpers for company/users/messages/workflows.
- `src/services/whatsapp.ts`: outbound send abstraction.
- `src/services/r2-storage.ts`: signed URL generation and asset key policy.
- `src/workflow/engine.ts`: workflow execution engine.
- `src/addon/*`: addon webhook subsystem + API routes.

## Database Assets (`supabase/`)

- `migrations/*.sql`: schema evolutions and RLS/policy/index setup.
- `functions/waba-webhook/index.ts`: edge function for webhook verification + forwarding.

## Alternate Runtime (`wonderpark/`)

Contains a parallel server entry and route variant for Wonderpark deployment isolation:

- `wonderpark/dashboard-server.ts`
- `wonderpark/routes/wabaRoutes.ts`
- `wonderpark/config.ts`

## Important Configuration Files

- `dashboard/vite.config.ts`: dev proxy and allowed hosts.
- `tsconfig.json`, `tsconfig.build.json`, `dashboard/tsconfig.json`
- `eslint.config.mts`
- `jest.config.ts`
- `cloudflared-2fast.yml`
