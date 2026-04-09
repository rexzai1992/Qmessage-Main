# Edge Functions & Backend Logic

## Supabase Edge Function

File: `supabase/functions/waba-webhook/index.ts`

Purpose:

- Handles Meta webhook verification (`GET` with `hub.challenge`).
- Validates POST signatures (`X-Hub-Signature-256`) against one or more app secrets.
- Optionally forwards payloads to configured backend URL (`WABA_FORWARD_URL`).

Required edge secrets:

- `WABA_VERIFY_TOKEN`
- `WABA_APP_SECRET` (or `WABA_APP_SECRETS` list)
- `WABA_FORWARD_URL` (optional)

## Core Backend Logic (Node Server)

## 1) Webhook Handling

`dashboard-server.ts`:

- `GET /webhook`: verification against active verify tokens in registry.
- `POST /webhook`: signature check + payload parsing + downstream processing.

`src/waba/webhook.ts`:

- `verifyWabaSignature(rawBody, signature, appSecrets)`
- `parseWabaWebhook(payload)` -> normalized `messages`, `statuses`, `calls` arrays.

## 2) WABA Client/Registry

- `src/waba/registry.ts`: refreshes enabled configs from `waba_configs`; falls back to env config when DB empty.
- `src/waba/client.ts`: wraps Graph API endpoints for messaging, templates, media, calls, business profile, phone settings, connected businesses.

## 3) Workflow Engine

- `src/workflow/engine.ts`: automation execution for inbound events.
- Trigger models:
  - keyword-based
  - first message
  - run-on-new-chat
- Action models include text/buttons/list/cta/media/template sends, conditions, assignment, tags, nested workflow triggers.

## 4) Scheduled Broadcast Worker

In `dashboard-server/routes/wabaRoutes.ts`:

- `runScheduledBroadcastTick()` runs every 30 seconds.
- Claims due rows (`status=scheduled`) and sets `processing`.
- Sends template to recipients and updates row with final status/counters/error.

This is an in-process worker (not external queue service).

## 5) Socket Realtime Layer

`dashboard-server/socket/registerSocketHandlers.ts`:

- Authenticates socket using Supabase token.
- Joins user + company rooms.
- Handles operational events (message send, contact management, workflow start, media download).
- Emits updates to all sockets in same company room.

## 6) Addon Webhook Extension

`src/addon/webhook-service.ts`:

- Stores per-profile outgoing webhook targets.
- Queues events with retry/backoff and persists queue to disk.
- Exposed management APIs under `/addon/admin/webhooks`.

## Backend Trigger Matrix

| Trigger | Logic |
|---|---|
| Meta webhook POST | parse + store + socket fanout + workflow processing |
| Socket `sendMessage` | validate + send via WABA + persist + emit |
| REST `POST /api/flows` | upsert workflow definitions |
| Interval 30s | scheduled broadcast processing |
| Addon event dispatch | queued delivery to external URLs |
