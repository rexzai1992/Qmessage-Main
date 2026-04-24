# Meta App Review Readiness

Use this runbook to prepare and demonstrate WhatsApp/WABA permissions during Meta App Review.

## Goal

Show a reviewer a short, deterministic flow with explicit UI proof for:

- `whatsapp_business_management`
- `business_management`
- `whatsapp_business_messaging`

## Required Runtime Configuration

Set these server env vars before testing:

- `WABA_APP_ID`
- `WABA_APP_SECRET`
- `WABA_VERIFY_TOKEN`
- `WABA_TOKEN_ENCRYPTION_KEY`
- `WABA_OAUTH_REDIRECT_URI` (recommended for production)
- `WABA_OAUTH_RETURN_URL` (strongly recommended when frontend/backend are split)

## Reviewer-Friendly In-App Flow

1. Sign in with an admin/owner account.
2. Open `Settings` -> `App Review Check`.
3. Click `Run Readiness + Permission Checks`.
4. Verify precheck badges are `PASS`.
5. In `Connect WhatsApp`, click `Connect WhatsApp Business` and complete Embedded Signup.
6. Back in `App Review Check`, run:
   - `whatsapp_business_management` check
   - `business_management` check
7. Enter reviewer test number and run `Send Test Message` for `whatsapp_business_messaging`.
8. Capture PASS/FAIL badges and timestamps for screencast/review notes.

## Manual Fallback (If Embedded Signup Is Not Available)

Use `Manual WABA Setup` in settings:

- WABA ID
- Phone Number ID
- Access Token (system user token)
- Optional Business ID / App ID / App Secret / API Version

After save, the app now auto-refreshes connection/readiness state so reviewer can immediately see updated status.

## Manual Meta Dashboard Items (Not Solved by Code)

You still must configure these in Meta:

1. Valid OAuth redirect URI(s) in Meta App settings.
2. Correct Embedded Signup configuration ID (if using Business Integration mode).
3. Test users or tester role assignments in the Meta app/business.
4. WhatsApp product enabled and phone number connected in the target business.
5. Webhook callback URL + verify token registered in Meta if required for your scenario.
