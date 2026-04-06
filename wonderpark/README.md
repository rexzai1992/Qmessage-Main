# Wonderpark WABA Runtime

This module runs a Wonderpark-specific WABA server in a separate process.

## Run

1. Copy/update root `.env.wonderpark` with Wonderpark credentials.
2. Start runtime:

```bash
npm run start:wonderpark
```

Default port is `3101`.

## Isolation

- Local runtime data goes to `data-wonderpark/` via `WONDERPARK_DATA_DIR`.
- Company access can be hard-locked using `WONDERPARK_COMPANY_ID`.
- Recommended: use a dedicated Supabase project/key set for Wonderpark.

## Meta App Checklist

In Wonderpark's Meta app (Facebook Login for Business):

- Enable:
  - Client OAuth Login
  - Web OAuth Login
  - Enforce HTTPS
  - Embedded Browser OAuth Login
  - Strict Mode for redirect URIs
  - Login with JavaScript SDK
- Add Wonderpark domains to:
  - Allowed domains for the JavaScript SDK
  - Valid OAuth Redirect URIs
- Ensure redirect matches `WABA_OAUTH_REDIRECT_URI` exactly.
- Use Wonderpark-specific `WABA_EMBEDDED_SIGNUP_CONFIG_ID`.

## Callback URL

- `GET /auth/waba/callback`

This must match the configured OAuth redirect URI host/path.
