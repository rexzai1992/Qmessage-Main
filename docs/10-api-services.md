# API & Services

## Base URLs

- Backend local: `http://localhost:3000`
- Frontend dev proxy: `http://localhost:5173` (proxies API to backend)

## Auth Modes

### 1) Bearer Supabase token (primary dashboard APIs)

```http
Authorization: Bearer <access_token>
```

### 2) API Key (integration endpoints)

```http
X-API-Key: <api_key>
```

Used by legacy/public integration endpoints and addon APIs.

## Response Shape (typical)

Most routes return:

```json
{
  "success": true,
  "data": { }
}
```

Errors usually return:

```json
{
  "success": false,
  "error": "..."
}
```

Some validation/migration cases also return `code` and `details`.

## Endpoint Groups

## Health / Flow / Analytics

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Health probe |
| GET | `/api/flows` | List workflows for profile company |
| POST | `/api/flows` | Upsert workflows list |
| GET | `/api/analytics` | Aggregate metrics for date range/tag |

## Public Auth and Info

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/public/signup-company` | Create tenant owner account |
| GET | `/support` | Public support page |
| GET | `/privacy`, `/privacy-policy` | Privacy page |
| GET | `/terms`, `/terms-and-conditions` | Terms page |

## Company Settings

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/company/fallback-settings` | Get fallback automation text/limit |
| POST | `/api/company/fallback-settings` | Update fallback settings |
| GET | `/api/company/ui-controls` | Get hidden UI features + logo metadata |
| GET | `/api/company/app-logo` | Get app logo storage metadata and URL |
| POST | `/api/company/app-logo` | Save/clear app logo asset metadata |
| POST | `/api/company/media/upload-url` | Signed upload URL for company media |
| GET | `/api/company/quick-replies` | List quick replies |
| POST | `/api/company/quick-replies` | Replace quick replies set |
| GET | `/api/company/team-users` | List team users and roles |
| POST | `/api/company/team-users/invite` | Invite team member |
| PATCH | `/api/company/team-users/:userId/role` | Change team role |
| PATCH | `/api/company/team-users/:userId/department` | Change department metadata |

## Webstore

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/company/webstore-settings` | Get webstore settings |
| POST | `/api/company/webstore-settings` | Update webstore settings |
| GET | `/api/store/products` | List products |
| POST | `/api/store/products` | Create product |
| PUT | `/api/store/products/:productId` | Update product |
| DELETE | `/api/store/products/:productId` | Soft delete (set inactive) |
| POST | `/api/store/products/demo-seed` | Seed demo products |
| GET | `/:companyId/store.json` | Public store JSON |
| GET | `/:companyId/store` | Public store HTML |
| GET | `/customixie` | Public custom landing |

## AI

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/company/ai/settings` | Read company AI settings |
| POST | `/api/company/ai/settings` | Save company AI settings |
| POST | `/api/company/ai/generate` | Generate AI reply from prompt/history |

## WABA Configuration and Operations

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/waba/embedded-signup/url` | Build FB embedded signup URL |
| POST | `/api/waba/manual-config` | Save manual WABA config |
| GET | `/auth/waba/callback` | OAuth callback handler |
| GET | `/api/waba/registration/config` | Registration config |
| GET | `/api/waba/registration/phone-numbers` | Fetch phone numbers |
| POST | `/api/waba/registration/request-code` | Request verification code |
| POST | `/api/waba/registration/verify-code` | Verify code |
| POST | `/api/waba/registration/register` | Register number |
| POST | `/api/waba/registration/profile` | Update profile during registration |
| GET | `/api/waba/business-profile` | Fetch business profile |
| POST | `/api/waba/business-profile` | Update business profile |
| GET | `/api/waba/call-settings` | Fetch phone call settings |
| POST | `/api/waba/call-settings` | Update phone call settings |
| GET | `/api/waba/call-permissions` | Check call permissions for WA ID |
| POST | `/api/waba/calls` | Connect/accept/reject/terminate calls |
| GET | `/api/waba/conversational-automation` | Read conversational automation |
| POST | `/api/waba/conversational-automation` | Update conversational automation |
| GET | `/api/waba/window-reminder` | Read reminder settings |
| POST | `/api/waba/window-reminder` | Update reminder settings |
| GET | `/api/waba/templates` | List templates |
| POST | `/api/waba/templates/utility` | Create utility template |
| POST | `/api/waba/templates/marketing` | Create marketing template |
| POST | `/api/waba/templates/authentication` | Create auth template |
| POST | `/api/waba/templates/authentication/upsert` | Upsert auth template |
| GET | `/api/waba/templates/:templateId/status` | Poll template status |
| POST | `/api/waba/templates/authentication/send` | Send auth template |
| POST | `/api/waba/templates/send` | Send template message |
| POST | `/api/waba/marketing-messages/send` | Send marketing template message |
| POST | `/api/waba/template-media/upload-handle` | Upload media for template header handle |
| POST | `/api/waba/media/upload` | Upload media to WABA media store |
| GET | `/api/waba/scheduled-broadcasts` | List scheduled broadcasts |
| POST | `/api/waba/scheduled-broadcasts` | Create scheduled broadcast |
| DELETE | `/api/waba/scheduled-broadcasts/:id` | Cancel scheduled broadcast |
| GET | `/api/waba/clients` | List connected WABA clients |
| POST | `/api/waba/clients/disconnect` | Disconnect WABA client |
| GET | `/api/waba/connected-client-businesses` | List connected client businesses (superadmin) |
| GET/POST/DELETE | `/api/waba/preverified-*` | Preverified number workflows |

## Webhooks

| Method | Path | Purpose |
|---|---|---|
| GET | `/webhook` | Meta webhook verification |
| POST | `/webhook` | Meta inbound webhook delivery |

## API Key / Addon Integration APIs

### Legacy API key routes

| Method | Path |
|---|---|
| POST | `/api/send-message` |
| POST | `/api/send-image` |
| GET | `/api/status` |
| GET/POST/DELETE | `/api/webhook` |

### Addon router (`/addon` mounted)

| Method | Path |
|---|---|
| POST | `/addon/api/send-message` |
| GET | `/addon/api/messages` |
| POST | `/addon/webhook/incoming` |
| GET/POST/DELETE | `/addon/admin/webhooks` |

## Superadmin APIs

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/setup-status` | Check if first-time setup is open |
| POST | `/api/admin/setup` | Create first superadmin |
| POST | `/api/admin/login` | Superadmin login |
| GET | `/api/admin/summary` | Tenant summary metrics |
| POST | `/api/admin/company-ui` | Toggle company hidden UI features |
| GET | `/my` | Backward-compatible summary endpoint |

## Socket.IO Service

Namespace: default socket at `/socket.io`

Important inbound events:

- `switchProfile`, `refreshMessages`
- `sendMessage`, `sendTemplate`, `downloadMedia`
- `contact.update`, `contact.assign`, `contact.human_takeover`
- `startWorkflow`, `clearChat`
- `admin.getStats`, `admin.profileAction`

Important outbound events:

- `profiles.update`, `connection.update`
- `messages.history`, `messages.upsert`, `messages.cleared`
- `message.status`, `contacts.update`, `mediaDownloaded`
- `calls.update`, `server.stats`, `profile.error`

## Error Handling Patterns

- Validation errors -> `400`
- Auth failures -> `401` / `403`
- Missing setup/migration -> `503` with migration-specific message
- Upstream Graph errors -> mapped through helper (`toHttpErrorPayload`) with status/details when available
- Global fallback -> Express error middleware (`dashboard-server/middleware/error.ts`)
