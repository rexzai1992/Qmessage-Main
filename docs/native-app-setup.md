# Native App Setup (React Native Migration Plan)

This document captures the Phase 1 audit and the safest migration path to add a React Native mobile app without breaking the existing web app.

## Goal

- Keep existing web app working.
- Add a new React Native app for true native behavior.
- Reuse backend contracts where possible.
- Extract shared logic incrementally and safely.

## Current Architecture Summary

- Frontend web app: React + Vite in `dashboard/`.
- Frontend navigation: state-based in `dashboard/src/App.tsx` (no React Router).
- Backend: Express + Socket.IO in `dashboard-server.ts` with route modules in `dashboard-server/routes`.
- Auth: Supabase session token (Bearer) for REST and Socket auth.
- Realtime: Socket events for profiles, contacts, messages, status, and admin stats.
- Push:
  - Web push (service worker + Notification API).
  - Native push token register/unregister endpoints already exist.
  - FCM sender exists on backend.
- Existing mobile path: Capacitor wrapper of web app (Android project present), not React Native.

## Keep As Web-Only

- Service worker and PWA install/update flow.
- Browser Notification permission UX and browser-only fallback notifications.
- DOM/browser API logic (`window`, `document`, `localStorage`, `sessionStorage`).
- Tailwind/CSS web presentation and web-only layout/virtualization behavior.
- Existing Capacitor wrapper can remain temporarily during RN rollout.

## Extract As Shared

- Shared domain types/models:
  - profile, contact, message, workflow, quick reply, push payload DTOs.
- Shared API service layer:
  - authenticated request wrapper, timeout/retry/error normalization.
- Shared chat data logic:
  - JID normalization, message dedupe/merge, unread calculations, chat list derivation.
- Shared auth/session helpers (platform-agnostic core).
- Shared socket event payload typings (server->client and client->server).

## Build As Mobile-Specific (React Native)

- RN app shell/navigation and screens.
- Native push handling (FCM/APNs), foreground/background/tap handling.
- Native local cache strategy and reconnect/background sync strategy.
- Native media pick/camera/document flows.
- RN-optimized inbox/chat UI.

## Recommended Target Structure

Use additive structure first, without moving current web app immediately:

```text
dashboard/                 # existing web app (keep unchanged initially)
apps/mobile/               # new React Native app
packages/shared/           # shared contracts + services + pure chat logic
dashboard-server.ts        # existing backend entrypoint (preserve)
dashboard-server/          # existing backend modules (preserve)
src/                       # existing core services (preserve)
```

Optional later cleanup (after stability): move `dashboard/` to `apps/web/` and backend into `apps/server/`.

## Migration Risks and Blockers

- Very large monolith files increase regression risk:
  - `dashboard/src/App.tsx`
  - `dashboard-server.ts`
- Frontend API/socket contracts are not centralized in one typed client package.
- Browser-coupled logic is widespread in web app.
- Some runtime stores are file-based JSON (push subscriptions, native tokens, webhook queue), which is a scale/deployment risk for multi-instance setups.
- Frontend automated test coverage is limited for this migration surface.

## Incremental Plan (Safe Order)

1. Add `packages/shared` and `apps/mobile` scaffolding (additive only).
2. Define shared types/contracts from current REST/socket payloads.
3. Create shared API client/services package.
4. Extract auth/session utilities into shared core + platform adapters.
5. Extract chat list data logic into shared pure module.
6. Extract chat detail merge/unread logic into shared pure module.
7. Add shared notification models/deep-link payload parsing.
8. Scaffold first working RN login flow.
9. Implement first RN inbox flow using existing backend/socket contracts.
10. Add native push token sync and notification deep-link open-chat flow.
11. Add local cache + reconnect + background sync hardening.

## First Safe Implementation Step

Start with type-only extraction:

- Create `packages/shared/src/contracts/*` for existing API/socket payload shapes.
- Import those types in web code incrementally (type-only usage).
- Do not change runtime behavior in this step.

Success criteria for this step:

- Web app behavior unchanged.
- Backend contracts unchanged.
- Build still passes for existing app.
