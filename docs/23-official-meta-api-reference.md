# Official Meta Runtime API Reference

This guide documents the current **official Meta-only** runtime surface for the Express backend.

It focuses on:

- health and runtime inspection
- API key and webhook integration endpoints
- Meta WhatsApp onboarding and connection management
- coexistence and recent webhook diagnostics
- signaling-first calling endpoints
- addon webhook admin endpoints

## Base URLs

- Local backend: `http://localhost:3000`
- Frontend dev proxy: `http://localhost:5173`
- Versioned compatibility alias: `/api/v1/*` is supported and rewrites to `/api/*`

Examples:

- `GET /api/public/config`
- `GET /api/v1/public/config`

Both resolve to the same handler.

## Response Conventions

Most routes return:

```json
{
  "success": true,
  "data": {}
}
```

Common error shape:

```json
{
  "success": false,
  "error": "Human readable message"
}
```

Some Meta and signaling endpoints also return:

```json
{
  "success": false,
  "error": "CALL_MEDIA_BACKEND_NOT_CONFIGURED",
  "details": ["Live call media is not configured yet."]
}
```

## Authentication Modes

### Bearer session token

Used by dashboard routes and tenant-scoped admin actions.

```http
Authorization: Bearer <supabase_access_token>
```

### API key

Used by integration endpoints:

```http
X-API-Key: <api_key>
```

### Admin password

Used only by legacy API key management routes:

```json
{
  "adminPassword": "admin123"
}
```

Current default comes from `ADMIN_PASSWORD` and falls back to `admin123` if not set.

## 1. Health and Runtime Inspection

### GET `/health`

Returns a JSON health probe.

No authentication required.

Response fields:

| Field | Type | Description |
|---|---|---|
| `ok` | boolean | Database-backed health result |
| `service` | string | Current service name |
| `environment` | string | `local`, `docker`, or `production` |
| `mode` | string | `official_meta_only` or `mixed` |
| `database` | string | `connected` or `disconnected` |
| `timestamp` | string | ISO timestamp |
| `request_id` | string \| null | Request correlation ID |

Example:

```http
GET /health
```

### GET `/api/system/config-check`

### GET `/api/v1/system/config-check`

Returns runtime, deployment, database, and Meta config status.

Authentication:

- Bearer token
- caller must resolve as tenant admin

Query parameters:

None.

Response highlights:

| Field | Type | Description |
|---|---|---|
| `data.backend.framework` | string | Current backend framework |
| `data.backend.official_meta_only_mode` | boolean | Official-only runtime flag |
| `data.database.connected` | boolean | Supabase health |
| `data.meta.embedded_signup_config_found` | boolean | Embedded signup config present |
| `data.meta.coexistence_config_found` | boolean | Coexistence config present |
| `data.api_engine.api_v1_alias_enabled` | boolean | `/api/v1` compatibility alias enabled |
| `data.deployment.cloudflare_tunnel_detected` | boolean | Tunnel indicators found |
| `data.issues` | string[] | Current setup warnings |

### GET `/api/public/config`

### GET `/api/v1/public/config`

Public runtime metadata for frontend/bootstrap use.

No authentication required.

Response fields:

| Field | Type | Description |
|---|---|---|
| `data.app_name` | string | Public app label |
| `data.api_version` | string | Current API version label |
| `data.features` | object | Public feature flags |
| `data.meta.app_id` | string \| null | Public Meta App ID |
| `data.api.base_path` | string | Configured API base path |
| `data.api.aliases` | string[] | Supported API base aliases |
| `data.official_mode.enabled` | boolean | Official Meta-only runtime state |

## 2. Legacy API Key Management

These routes manage integration API keys used by legacy API-key endpoints.

### POST `/api/admin/api-keys`

Create a new API key.

Authentication:

- `adminPassword` in request body

Request body:

| Field | Type | Required | Description |
|---|---|---|---|
| `adminPassword` | string | yes | Legacy admin password |
| `profileId` | string | yes | Profile to bind the key to |
| `name` | string | no | Human-readable key label |

Example:

```json
{
  "adminPassword": "admin123",
  "profileId": "default",
  "name": "crm-integration"
}
```

Success response:

| Field | Type | Description |
|---|---|---|
| `data.apiKey` | string | Newly generated API key |
| `data.profileId` | string | Bound profile |
| `data.name` | string | Saved label |

### GET `/api/admin/api-keys`

List existing API keys.

Authentication:

- `adminPassword` query parameter

Query parameters:

| Name | Type | Required | Description |
|---|---|---|---|
| `adminPassword` | string | yes | Legacy admin password |

Response:

- object keyed by raw API key string
- each value contains `profileId`, `companyId`, and optional `name`

## 3. Outbound Integration Webhook Config

These routes manage the single outbound webhook config used by `/api/send-message`, `/api/send-image`, `/api/status`, and related API-key integration flows.

### POST `/api/webhook`

Set or replace the outbound webhook config for the API key’s profile.

Authentication:

- `X-API-Key`

Request body:

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | string | yes | Destination URL |
| `events` | string[] | no | Event names to send; defaults to `["message","status"]` |

Example:

```json
{
  "url": "https://example.com/hooks/qmessage",
  "events": ["message", "status", "call"]
}
```

Success response:

| Field | Type | Description |
|---|---|---|
| `data.profileId` | string | API key profile |
| `data.webhook.url` | string | Stored destination URL |
| `data.webhook.events` | string[] | Stored events |

### GET `/api/webhook`

Read the outbound webhook config for the API key’s profile.

Authentication:

- `X-API-Key`

Response:

| Field | Type | Description |
|---|---|---|
| `data.url` | string | Stored webhook URL |
| `data.events` | string[] | Stored event list |

### DELETE `/api/webhook`

Remove the outbound webhook config for the API key’s profile.

Authentication:

- `X-API-Key`

Request body:

Optional. Current implementation removes the profile-scoped webhook regardless of body content.

## 4. Meta Webhook Verification and Delivery

### GET `/webhook`

### GET `/api/webhooks/meta/whatsapp`

Meta webhook verification endpoint.

No authentication required.

Query parameters from Meta:

| Name | Type | Required | Description |
|---|---|---|---|
| `hub.mode` | string | yes | Verification mode |
| `hub.verify_token` | string | yes | Must match configured verify token |
| `hub.challenge` | string | yes | Echo challenge |

### POST `/webhook`

### POST `/api/webhooks/meta/whatsapp`

Meta inbound WhatsApp webhook delivery endpoint.

Security:

- validates `X-Hub-Signature-256`

Behavior:

- stores raw webhook events
- processes messages, statuses, calls, coexistence history, and call permission replies

## 5. WhatsApp Embedded Signup and Connection APIs

Preferred backend-owned namespace:

- `GET /api/v1/whatsapp/connections`
- `POST /api/v1/whatsapp/connections/refresh`
- `POST /api/v1/whatsapp/connections/disconnect`
- `GET /api/v1/whatsapp/conversations`
- `GET /api/v1/whatsapp/conversations/:conversationId/messages`
- `POST /api/v1/whatsapp/messages/send`
- `POST /api/v1/whatsapp/connect/start`
- `POST /api/v1/whatsapp/connect/complete`
- `GET /api/v1/whatsapp/onboarding/status`

Compatibility routes under `/api/whatsapp/*`, `/api/meta/whatsapp/*`, and `/api/waba/*` still work. When a backend-owned replacement exists, those older routes return:

- `X-Deprecated-Route: true`
- `X-Preferred-Route: /api/v1/...`

### GET `/api/waba/registration/config`

Returns registration/bootstrap config for the dashboard.

Authentication:

- Bearer token
- tenant/profile access required

Response highlights:

| Field | Type | Description |
|---|---|---|
| `companyId` | string | Active company |
| `profileId` | string | Active profile |
| `officialMetaOnly` | boolean | Official-only mode flag |
| `apiBasePath` | string | Base path currently advertised |
| `appId` | string \| null | Meta app ID |
| `configurationId` | string \| null | Embedded signup configuration ID |

### GET `/api/v1/whatsapp/connections`

Lists stored WhatsApp business connections for the current tenant.

Authentication:

- Bearer token

Query parameters:

| Name | Type | Required | Description |
|---|---|---|---|
| `profile_id` | string | no | Restrict to one sender profile |
| `company_id` | string | no | Optional validated company override |

Success response:

| Field | Type | Description |
|---|---|---|
| `data.connected` | boolean | Whether at least one connection is active |
| `data.connection_count` | number | Total stored connections in scope |
| `data.active_connection` | object \| null | Most recent or requested connection |
| `data.connections[]` | object[] | Backend-owned connection records |

Connection object highlights:

| Field | Type | Description |
|---|---|---|
| `connection_id` | string \| null | Stored connection row ID |
| `business_account_id` | string \| null | Meta WABA ID |
| `phone_number_id` | string \| null | Meta phone number ID |
| `display_phone_number` | string \| null | Human-readable phone number |
| `display_name` | string \| null | Current display name |
| `verified_name` | string \| null | Verified name |
| `status` | string \| null | Current platform status |
| `flow_type` | string \| null | Stored connection flow/source marker |
| `onboarding_type` | string \| null | `normal` or `coexistence` |
| `coexistence_enabled` | boolean | Whether coexistence is active for this number |
| `is_on_biz_app` | boolean \| null | Whether Meta still reports the number on the WhatsApp Business App |
| `sync_status` | string \| null | Coexistence sync lifecycle (`pending`, `in_progress`, `complete`, `history_declined`, etc.) |
| `history_sync_progress` | number \| null | Coexistence history import progress from `0` to `100` |
| `messaging_paused` | boolean | Whether Cloud API sends are paused for this connection |
| `last_account_update_event` | string \| null | Last coexistence `account_update` lifecycle event received |

### GET `/api/v1/whatsapp/connections/:connectionId`

Returns one stored connection by connection row id, profile id, or phone number id.

Authentication:

- Bearer token

### POST `/api/v1/whatsapp/connections/refresh`

Refreshes stored connection metadata from Meta.

Authentication:

- Bearer token

Request body:

| Field | Type | Required | Description |
|---|---|---|---|
| `profile_id` | string | no | Refresh only one sender profile |
| `company_id` | string | no | Optional validated company override |

### POST `/api/v1/whatsapp/connections/disconnect`

Disables a local connection and optionally unsubscribes the app from Meta.

Authentication:

- Bearer token
- tenant admin required

Request body:

| Field | Type | Required | Description |
|---|---|---|---|
| `profile_id` | string | yes | Sender profile to disconnect |
| `company_id` | string | no | Optional validated company override |
| `revoke` | boolean | no | When `true`, also attempts to unsubscribe app from Meta |

### GET `/api/v1/whatsapp/conversations`

Lists customer conversations for the active profile.

Authentication:

- Bearer token

Query parameters:

| Name | Type | Required | Description |
|---|---|---|---|
| `limit` | number | no | Page size, default `25`, max `100` |
| `offset` | number | no | Row offset for pagination |
| `search` | string | no | Match alias, WhatsApp name, phone number, or tags |

Success response highlights:

| Field | Type | Description |
|---|---|---|
| `data.conversations[]` | object[] | Conversation summaries |
| `data.total` | number | Total matching conversations |
| `data.limit` | number | Applied page size |
| `data.offset` | number | Applied offset |

Conversation summary highlights:

| Field | Type | Description |
|---|---|---|
| `id` | string | Conversation/user record ID |
| `jid` | string | WhatsApp chat identifier |
| `phone_number` | string \| null | Normalized recipient phone number |
| `display_name` | string | Alias, WhatsApp name, or phone fallback |
| `latest_message` | object \| null | Most recent stored message summary |
| `human_takeover` | boolean | Current takeover state |

### GET `/api/v1/whatsapp/conversations/:conversationId/messages`

Returns stored messages for one conversation.

Authentication:

- Bearer token

Path parameters:

| Name | Type | Required | Description |
|---|---|---|---|
| `conversationId` | string | yes | Conversation/user record ID |

Query parameters:

| Name | Type | Required | Description |
|---|---|---|---|
| `limit` | number | no | Max messages, default `100`, max `500` |
| `since_timestamp` | number | no | Unix timestamp for incremental fetch |

Success response highlights:

| Field | Type | Description |
|---|---|---|
| `data.conversation` | object | Conversation summary |
| `data.messages[]` | object[] | Ordered message list |
| `data.count` | number | Message count in this response |

Message object highlights:

| Field | Type | Description |
|---|---|---|
| `id` | string \| null | Provider message id when available |
| `record_id` | string \| null | Internal DB row id |
| `direction` | string \| null | `in` or `out` |
| `type` | string | `text`, `image`, `video`, `document`, etc. |
| `text` | string \| null | Best-effort text/caption preview |
| `status` | string \| null | Stored delivery state |
| `media` | object | Media identifiers and links if present |

### POST `/api/v1/whatsapp/messages/send`

Sends a message through the active profile.

Authentication:

- Bearer token

Request body:

| Field | Type | Required | Description |
|---|---|---|---|
| `conversation_id` | string | no | Existing conversation/user record ID |
| `to` | string | no | Recipient phone number when no conversation exists yet |
| `text` | string | no | Text body |
| `media.type` | string | no | `image`, `video`, or `document` |
| `media.id` | string | no | Existing uploaded Meta media id |
| `media.link` | string | no | Public media URL when no media id is supplied |
| `media.filename` | string | no | Filename for document sends |

Rules:

- provide either `conversation_id` or `to`
- provide at least one of `text` or `media`
- sender routing stays locked to the resolved `profile_id`

Success response highlights:

| Field | Type | Description |
|---|---|---|
| `data.conversation_id` | string | Conversation/user record ID |
| `data.profile_id` | string | Sender profile used |
| `data.message` | object | Stored outbound message summary |

### POST `/api/v1/whatsapp/connect/start`

Creates a backend-owned Embedded Signup start session for new phone onboarding.

Authentication:

- Bearer token
- tenant admin required

Request body:

| Field | Type | Required | Description |
|---|---|---|---|
| `profile_id` | string | no | Profile context if not already active |
| `business_id` | string | no | Existing Meta business portfolio ID |
| `business_account_id` | string | no | Existing WABA ID if preselected |
| `phone_number_id` | string | no | Existing phone number ID if preselected |
| `return_url` | string | no | Explicit return URL after Meta completes |
| `preverified_ids` | string[] | no | Preverified phone ids to inject into signup |

Success response highlights:

| Field | Type | Description |
|---|---|---|
| `data.start_url` | string | URL to open for signup |
| `data.configuration_id` | string | Meta Embedded Signup configuration ID |
| `data.onboarding_type` | string | `new_phone_onboarding` |

### POST `/api/v1/whatsapp/connect/complete`

Completes backend-owned Meta Embedded Signup after the frontend receives the signup result.

Authentication:

- Bearer token
- tenant admin required

Request body:

| Field | Type | Required | Description |
|---|---|---|---|
| `code` | string | yes | Authorization code from Meta |
| `business_account_id` | string | yes | Meta WABA ID |
| `phone_number_id` | string | yes | Meta phone number ID |
| `business_id` | string | no | Meta business portfolio ID |
| `company_id` | string | no | Optional company override; must match tenant unless superadmin |
| `pin` | string | no | 6-digit phone registration PIN if Meta requires one |

Success response:

| Field | Type | Description |
|---|---|---|
| `data.connection` | object | Stored backend-owned connection record |

## 6. Official Meta Coexistence and Diagnostics

### GET `/api/v1/whatsapp/onboarding/status`

Returns readiness info for the tenant's onboarding surface.

Authentication:

- Bearer token
- admin/company-scoped access

Response highlights:

| Field | Type | Description |
|---|---|---|
| `data.tech_provider_ready` | boolean | Basic provider readiness |
| `data.embedded_signup_config_found` | boolean | New-number config present |
| `data.permissions_ready` | boolean | Required Meta permissions/status snapshot |
| `data.webhook_configured` | boolean | Webhook basics present |
| `data.customers_connected` | number | Connected WhatsApp assets count |
| `data.calling_media_ready` | boolean | Live media backend readiness |
| `data.issues` | string[] | Blocking or warning items |

### POST `/api/v1/whatsapp/coexistence/start`

Starts coexistence onboarding for an existing WhatsApp Business App / Meta asset.

The frontend should launch Meta login with the coexistence configuration ID and:

- `response_type: "code"`
- `override_default_response_type: true`
- `extras.featureType = "whatsapp_business_app_onboarding"`
- `extras.sessionInfoVersion = "3"`

Authentication:

- Bearer token
- admin/company-scoped access

Request body:

| Field | Type | Required | Description |
|---|---|---|---|
| `profile_id` | string | no | Profile to bind the result to |
| `business_id` | string | no | Existing Meta business ID |
| `business_account_id` | string | no | Existing WABA ID |
| `phone_number_id` | string | no | Existing phone number ID |
| `return_url` | string | no | Explicit return URL |

Success response:

| Field | Type | Description |
|---|---|---|
| `data.start_url` | string | Meta signup URL to redirect/open |
| `data.onboarding_type` | string | `coexistence` |
| `data.configuration_id` | string | Meta config ID used for the flow |

### POST `/api/v1/whatsapp/coexistence/complete`

Completes coexistence onboarding after Meta returns the authorization `code` and the embedded-signup window reports `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` (or fallback `FINISH` with `is_wa_login_user`).

Authentication:

- Bearer token
- admin/company-scoped access

Request body:

| Field | Type | Required | Description |
|---|---|---|---|
| `company_id` | string | yes | Company that owns the connection |
| `code` | string | yes | Meta authorization code from `FB.login` |
| `waba_id` | string | yes | Selected or returned WABA ID |
| `phone_number_id` | string | no | Optional phone number ID. If omitted, backend discovers numbers under the WABA |
| `business_id` | string | no | Optional Meta business ID |
| `flow_type` | string | no | Should be `coexistence` |

Success response highlights:

| Field | Type | Description |
|---|---|---|
| `data.flow_type` | string | `coexistence` |
| `data.connection.id` | string | Stored connection row ID |
| `data.connection.waba_id` | string | Meta WABA ID |
| `data.connection.phone_number_id` | string | Resolved business phone number ID |
| `data.connection.phone_number` | string \| null | Human-readable phone number |
| `data.connection.platform_type` | string \| null | Expected `CLOUD_API` after successful coexistence |
| `data.connection.is_on_biz_app` | boolean \| null | Expected `true` for coexistence |
| `data.connection.status` | string \| null | Stored connection status |

Conflict response:

- `409 COEXISTENCE_PHONE_SELECTION_REQUIRED` when Meta returns only a WABA and the backend discovers multiple phone numbers under it.

Runtime behavior:

- skips `POST /{phone_number_id}/register`
- subscribes the app to the WABA
- starts `smb_app_state_sync` and `history` sync requests only once per connection
- stores `contacts_sync_request_id`, `history_sync_request_id`, `sync_started_at`, and `sync_status`

Meta setup note:

- The Meta App webhook fields must include `messages`, `message_status`, `account_update`, `history`, `smb_app_state_sync`, and `smb_message_echoes`.

### GET `/api/v1/whatsapp/coexistence/status/:customerId`

Returns stored coexistence/onboarding status for the target customer/connection.

Authentication:

- Bearer token
- admin/company-scoped access

Path parameters:

| Name | Type | Required | Description |
|---|---|---|---|
| `customerId` | string | yes | Stored connection/customer identifier |

### GET `/api/v1/whatsapp/webhooks/recent`

Returns recent stored raw webhook events.

Authentication:

- Bearer token
- admin/company-scoped access

Query parameters:

| Name | Type | Required | Description |
|---|---|---|---|
| `type` | string | no | `history`, `coexistence`, `call`, or `permission_reply` |
| `limit` | number | no | Max rows to return |
| `profile_id` | string | no | Optional profile filter |

## 7. Signaling-First Calling APIs

### GET `/api/v1/whatsapp/calls/settings`

Read call settings for the active phone number.

Authentication:

- Bearer token

Query parameters:

| Name | Type | Required | Description |
|---|---|---|---|
| `profileId` | string | no | Explicit profile |

### POST `/api/v1/whatsapp/calls/settings/enable`

Enable call settings for the active profile.

Authentication:

- Bearer token

Request body:

| Field | Type | Required | Description |
|---|---|---|---|
| `profileId` | string | no | Explicit profile |

### GET `/api/v1/whatsapp/calls/permissions`

Checks current customer call permission status.

Authentication:

- Bearer token

Query parameters:

| Name | Type | Required | Description |
|---|---|---|---|
| `customer_id` | string | yes | Customer WhatsApp ID |
| `phone_number_id` | string | no | Override current sender number |

### POST `/api/v1/whatsapp/calls/request-permission`

Send a call-permission request through the official Meta messages API.

Authentication:

- Bearer token

Request body:

| Field | Type | Required | Description |
|---|---|---|---|
| `profileId` | string | no | Explicit profile |
| `customer_id` | string | yes | Customer WhatsApp ID |
| `text` | string | no | Optional request body text |

### POST `/api/v1/whatsapp/calls/connect`

Attempt outbound calling setup.

Authentication:

- Bearer token

Current behavior:

- validates permission first
- then returns `CALL_MEDIA_BACKEND_NOT_CONFIGURED` until real WebRTC/SIP is implemented

Request body:

| Field | Type | Required | Description |
|---|---|---|---|
| `profileId` | string | no | Explicit profile |
| `customer_id` | string | yes | Customer WhatsApp ID |
| `session.sdp_type` | string | yes | Must be `offer` |
| `session.sdp` | string | yes | SDP offer |

### POST `/api/v1/whatsapp/calls/:callId/pre-accept`

### POST `/api/v1/whatsapp/calls/:callId/accept`

Authentication:

- Bearer token

Path parameters:

| Name | Type | Required | Description |
|---|---|---|---|
| `callId` | string | yes | Stored Meta call ID |

Current behavior:

- always returns `CALL_MEDIA_BACKEND_NOT_CONFIGURED`

### POST `/api/v1/whatsapp/calls/:callId/reject`

### POST `/api/v1/whatsapp/calls/:callId/terminate`

Authentication:

- Bearer token

Path parameters:

| Name | Type | Required | Description |
|---|---|---|---|
| `callId` | string | yes | Stored Meta call ID |

Behavior:

- sends the official Meta signaling action
- persists request/response into stored call history

## 8. Addon Admin Webhooks

These routes manage the addon webhook fan-out configuration stored in `addon_webhooks.json` and, after migration, `public.addon_webhooks`.

Mounted under `/addon`.

### GET `/addon/admin/webhooks`

Authentication:

- Bearer token with profile access
- or `X-API-Key`

Query parameters:

Optional. Profile context is derived from auth.

Response:

Array of webhook configs:

```json
[
  {
    "url": "https://example.com/hooks/messages",
    "events": ["message_received", "message_sent"],
    "enabled": true,
    "secret": "optional-secret-if-present-in-memory"
  }
]
```

### POST `/addon/admin/webhooks`

Authentication:

- Bearer token with profile access
- or `X-API-Key`

Request body:

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | string | yes | Destination URL |
| `events` | string[] | yes | Addon event names |
| `enabled` | boolean | no | Defaults to `true` |
| `secret` | string | no | Optional HMAC signing secret |

Success response:

- returns the updated webhook list for the profile

### DELETE `/addon/admin/webhooks`

Authentication:

- Bearer token with profile access
- or `X-API-Key`

Request body:

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | string | yes | Exact webhook URL to delete |

Success response:

- returns the remaining webhook list for the profile

### Addon delivery signatures

When `secret` is present, the addon delivery worker sends:

```http
X-Hub-Signature: sha256=<hex_hmac>
X-Barley-Event: <event_name>
```

## 9. Common Error Codes

| Error | Meaning |
|---|---|
| `Invalid API key` | API key was missing or not found |
| `Invalid admin password` | Legacy admin password mismatch |
| `CALL_MEDIA_BACKEND_NOT_CONFIGURED` | Signaling endpoint reached, but live call media backend is not implemented |
| `CALL_PERMISSION_REQUIRED` | Customer has not granted permission for WhatsApp calling |
| `WABA not configured for this profile` | Profile exists but has no active Meta connection |
| `Company not found` | Profile/company mapping could not be resolved |

## 10. Recommended Test Order

1. `GET /health`
2. `GET /api/v1/public/config`
3. `POST /api/admin/api-keys`
4. `POST /api/webhook`
5. `GET /api/v1/whatsapp/onboarding/status`
6. `GET /api/v1/whatsapp/connections`
7. `POST /api/v1/whatsapp/coexistence/start`
8. `GET /api/v1/whatsapp/calls/settings`
9. `POST /api/v1/whatsapp/calls/request-permission`
10. `POST /api/v1/whatsapp/calls/:callId/reject`


