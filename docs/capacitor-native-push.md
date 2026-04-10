# Capacitor Native Push Setup (APK/IPA)

This repo now includes a Capacitor scaffold inside `dashboard/` so you can ship native notifications with FCM (Android) and APNs (iOS).

## What is already added

- Capacitor dependencies in `dashboard/package.json`
- Capacitor config: `dashboard/capacitor.config.ts`
- Native push bridge: `dashboard/src/features/native/nativePushBridge.ts`
- App wiring for:
  - native push registration
  - foreground native push fallback toast (when socket is disconnected)
  - tap-to-open chat from native notification payload (`data.url` or `data.chat`)

## NPM scripts

From repo root:

```bash
npm run cap:doctor --prefix dashboard
npm run cap:add:android --prefix dashboard
npm run cap:add:ios --prefix dashboard
npm run cap:sync --prefix dashboard
npm run cap:open:android --prefix dashboard
npm run cap:open:ios --prefix dashboard
```

## Firebase + APNs requirements

1. Create Firebase project and app entries for Android + iOS.
2. Android:
   - Download `google-services.json`
   - Place in `dashboard/android/app/google-services.json`
3. iOS:
   - Download `GoogleService-Info.plist`
   - Add it to Xcode target from `dashboard/ios/App/App/GoogleService-Info.plist`
4. In Apple Developer + Firebase:
   - Configure APNs key/certificate for the iOS app bundle ID.

## Custom native notification sound

This project uses Android notification channel id `qmessage-chat` and sound name `iphone_glass`.

### Android

- Put sound file at:
  - `dashboard/android/app/src/main/res/raw/iphone_glass.wav`
- Channel is created in `nativePushBridge.ts` with:
  - `id: "qmessage-chat"`
  - `sound: "iphone_glass"`

### iOS

- Add sound file in Xcode (target membership enabled), for example:
  - `dashboard/ios/App/App/iphone_glass.caf`
- Include sound in APNs payload:
  - `"sound": "iphone_glass.caf"`

## Push payload format for deep-linking to chat

Send `data.url` or `data.chat`:

```json
{
  "notification": {
    "title": "Alice",
    "body": "New message"
  },
  "data": {
    "url": "/?chat=60123456789@s.whatsapp.net",
    "chat": "60123456789@s.whatsapp.net"
  },
  "android": {
    "notification": {
      "channel_id": "qmessage-chat"
    }
  }
}
```

## Next backend step (required for production)

Current bridge logs native token in-app.  
To deliver native push, add backend endpoints for device token registration and push fan-out via:

- Firebase Admin SDK (Android/iOS via FCM)
- APNs directly (optional if not using FCM for iOS)
