import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import {
    PushNotifications,
    type ActionPerformed,
    type Channel,
    type PushNotificationSchema,
    type Token
} from '@capacitor/push-notifications';
import { LocalNotifications } from '@capacitor/local-notifications';

export const NATIVE_PUSH_CHANNEL_ID = 'qmessage-chat-v4';
export const NATIVE_PUSH_TOKEN_EVENT = 'qmessage:native-push-token';
export const NATIVE_PUSH_RECEIVED_EVENT = 'qmessage:native-push-received';
export const NATIVE_PUSH_ACTION_EVENT = 'qmessage:native-push-action';
export const NATIVE_PUSH_CHANNEL_STATUS_EVENT = 'qmessage:native-push-channel-status';

const ANDROID_HEADS_UP_MIN_IMPORTANCE = 4;
const LEGACY_ANDROID_CHANNEL_IDS = ['qmessage-chat', 'qmessage-chat-v3'] as const;
const FOREGROUND_HEADS_UP_DEDUPE_WINDOW_MS = 2500;

export type NativePushTokenEventDetail = {
    value: string;
    platform: 'android' | 'ios' | '';
};

export type NativePushReceivedEventDetail = {
    title: string;
    body: string;
    payload: PushNotificationSchema;
    appVisibility: 'visible' | 'hidden' | 'unknown';
    payloadKind: 'notification-only' | 'data-only' | 'mixed';
};

export type NativePushActionEventDetail = {
    actionId: string;
    title: string;
    body: string;
    payload: ActionPerformed;
    appVisibility: 'visible' | 'hidden' | 'unknown';
};

export type NativePushChannelStatusEventDetail = {
    id: string;
    exists: boolean;
    importance: number | null;
    headsUpEnabled: boolean;
};

let initialized = false;
let listeners: PluginListenerHandle[] = [];
let foregroundHeadsUpLastKey = '';
let foregroundHeadsUpLastAt = 0;

const dispatchWindowEvent = <T>(eventName: string, detail: T) => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent<T>(eventName, { detail }));
};

const resolveAppVisibility = (): 'visible' | 'hidden' | 'unknown' => {
    if (typeof document === 'undefined') return 'unknown';
    if (document.visibilityState === 'visible') return 'visible';
    if (document.visibilityState === 'hidden') return 'hidden';
    return 'unknown';
};

const inferPayloadKind = (notification: PushNotificationSchema): 'notification-only' | 'data-only' | 'mixed' => {
    const hasTitle = typeof notification?.title === 'string' && notification.title.trim().length > 0;
    const hasBody = typeof notification?.body === 'string' && notification.body.trim().length > 0;
    const data = notification?.data && typeof notification.data === 'object'
        ? notification.data as Record<string, unknown>
        : null;
    const hasData = Boolean(data && Object.keys(data).length > 0);
    if ((hasTitle || hasBody) && hasData) return 'mixed';
    if (hasData) return 'data-only';
    return 'notification-only';
};

const buildForegroundHeadsUpKey = (notification: PushNotificationSchema): string => {
    const data = notification?.data && typeof notification.data === 'object'
        ? notification.data as Record<string, unknown>
        : {};
    const candidateId = typeof data?.messageId === 'string'
        ? data.messageId.trim()
        : typeof data?.id === 'string'
            ? data.id.trim()
            : '';
    const title = typeof notification?.title === 'string' ? notification.title.trim() : '';
    const body = typeof notification?.body === 'string' ? notification.body.trim() : '';
    const chat = typeof data?.chat === 'string' ? data.chat.trim() : '';
    return [candidateId || '-', chat || '-', title || '-', body || '-'].join('|');
};

const canEmitForegroundHeadsUp = (notification: PushNotificationSchema): boolean => {
    const now = Date.now();
    const key = buildForegroundHeadsUpKey(notification);
    if (foregroundHeadsUpLastKey === key && (now - foregroundHeadsUpLastAt) <= FOREGROUND_HEADS_UP_DEDUPE_WINDOW_MS) {
        return false;
    }
    foregroundHeadsUpLastKey = key;
    foregroundHeadsUpLastAt = now;
    return true;
};

const showForegroundHeadsUpNotification = async (notification: PushNotificationSchema): Promise<void> => {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return;
    if (resolveAppVisibility() !== 'visible') return;
    if (!canEmitForegroundHeadsUp(notification)) return;

    try {
        const permissions = await LocalNotifications.checkPermissions();
        if (permissions.display !== 'granted') {
            const requested = await LocalNotifications.requestPermissions();
            if (requested.display !== 'granted') return;
        }

        const title = typeof notification?.title === 'string' && notification.title.trim()
            ? notification.title.trim()
            : 'QMessage';
        const body = typeof notification?.body === 'string' && notification.body.trim()
            ? notification.body.trim()
            : 'New message';
        const data = notification?.data && typeof notification.data === 'object'
            ? notification.data as Record<string, unknown>
            : {};

        await LocalNotifications.schedule({
            notifications: [
                {
                    id: Number(Date.now() % 2147480000),
                    title,
                    body,
                    channelId: NATIVE_PUSH_CHANNEL_ID,
                    smallIcon: 'ic_launcher',
                    extra: data
                }
            ]
        });
    } catch (error) {
        console.warn('[native-push] Unable to show foreground heads-up notification.', error);
    }
};

const getAndroidChannel = async (): Promise<Channel | null> => {
    const listed = await PushNotifications.listChannels();
    const channels = Array.isArray(listed?.channels) ? listed.channels : [];
    return channels.find((entry: Channel) => entry?.id === NATIVE_PUSH_CHANNEL_ID) || null;
};

const emitAndroidChannelStatus = async () => {
    if (Capacitor.getPlatform() !== 'android') return;
    try {
        const channel = await getAndroidChannel();
        const importance = typeof channel?.importance === 'number' ? channel.importance : null;
        const headsUpEnabled = importance !== null && importance >= ANDROID_HEADS_UP_MIN_IMPORTANCE;
        console.info(
            `[native-push] Channel status id=${NATIVE_PUSH_CHANNEL_ID} exists=${Boolean(channel)} importance=${importance ?? 'n/a'} headsUp=${headsUpEnabled ? 'on' : 'off'}`
        );

        dispatchWindowEvent<NativePushChannelStatusEventDetail>(NATIVE_PUSH_CHANNEL_STATUS_EVENT, {
            id: NATIVE_PUSH_CHANNEL_ID,
            exists: Boolean(channel),
            importance,
            headsUpEnabled
        });
    } catch (error) {
        console.warn('[native-push] Unable to inspect Android notification channel status.', error);
        dispatchWindowEvent<NativePushChannelStatusEventDetail>(NATIVE_PUSH_CHANNEL_STATUS_EVENT, {
            id: NATIVE_PUSH_CHANNEL_ID,
            exists: false,
            importance: null,
            headsUpEnabled: false
        });
    }
};

export const refreshNativePushChannelStatus = async () => {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return;
    await emitAndroidChannelStatus();
};

const ensureAndroidNotificationChannel = async () => {
    if (Capacitor.getPlatform() !== 'android') return;
    try {
        const listed = await PushNotifications.listChannels();
        const channels = Array.isArray(listed?.channels) ? listed.channels : [];
        for (const legacyId of LEGACY_ANDROID_CHANNEL_IDS) {
            if (!channels.some((entry: Channel) => entry?.id === legacyId)) continue;
            try {
                await PushNotifications.deleteChannel({ id: legacyId });
                console.info(`[native-push] Removed legacy channel ${legacyId}.`);
            } catch (error) {
                console.warn(`[native-push] Unable to remove legacy channel ${legacyId}.`, error);
            }
        }

        const existing = await getAndroidChannel();
        if (!existing) {
            await PushNotifications.createChannel({
                id: NATIVE_PUSH_CHANNEL_ID,
                name: 'Chat Messages',
                description: 'Incoming QMessage chat alerts (heads-up).',
                importance: 5,
                visibility: 1
            });
            console.info(`[native-push] Created channel ${NATIVE_PUSH_CHANNEL_ID} with IMPORTANCE_HIGH.`);
        }

        try {
            await LocalNotifications.createChannel({
                id: NATIVE_PUSH_CHANNEL_ID,
                name: 'Chat Messages',
                description: 'Incoming QMessage chat alerts (heads-up).',
                importance: 5,
                visibility: 1,
                vibration: true
            });
        } catch {
            // Keep push initialization resilient even if local notification channel creation fails.
        }
    } catch (error) {
        console.warn('[native-push] Unable to create Android notification channel.', error);
    }

    await emitAndroidChannelStatus();
};

const attachPushListeners = async () => {
    listeners.push(
        await PushNotifications.addListener('registration', (token: Token) => {
            const value = typeof token?.value === 'string' ? token.value.trim() : '';
            if (!value) return;
            const platformRaw = Capacitor.getPlatform();
            const platform = platformRaw === 'android' || platformRaw === 'ios' ? platformRaw : '';
            dispatchWindowEvent<NativePushTokenEventDetail>(NATIVE_PUSH_TOKEN_EVENT, { value, platform });
        })
    );

    listeners.push(
        await PushNotifications.addListener('registrationError', (error) => {
            console.warn('[native-push] Registration failed:', error);
        })
    );

    listeners.push(
        await PushNotifications.addListener('pushNotificationReceived', (notification) => {
            const title = typeof notification?.title === 'string' ? notification.title : 'QMessage';
            const body = typeof notification?.body === 'string' ? notification.body : 'New message';
            const appVisibility = resolveAppVisibility();
            const payloadKind = inferPayloadKind(notification);
            console.info(
                `[native-push] Received push channel=${NATIVE_PUSH_CHANNEL_ID} app=${appVisibility} payload=${payloadKind} title="${title.slice(0, 80)}"`
            );
            dispatchWindowEvent<NativePushReceivedEventDetail>(NATIVE_PUSH_RECEIVED_EVENT, {
                title,
                body,
                payload: notification,
                appVisibility,
                payloadKind
            });
            void showForegroundHeadsUpNotification(notification);
        })
    );

    listeners.push(
        await PushNotifications.addListener('pushNotificationActionPerformed', (payload) => {
            const actionId = typeof payload?.actionId === 'string' ? payload.actionId : 'tap';
            const title = typeof payload?.notification?.title === 'string'
                ? payload.notification.title
                : 'QMessage';
            const body = typeof payload?.notification?.body === 'string'
                ? payload.notification.body
                : 'New message';
            const appVisibility = resolveAppVisibility();
            console.info(
                `[native-push] Action performed channel=${NATIVE_PUSH_CHANNEL_ID} action=${actionId} app=${appVisibility} title="${title.slice(0, 80)}"`
            );
            dispatchWindowEvent<NativePushActionEventDetail>(NATIVE_PUSH_ACTION_EVENT, {
                actionId,
                title,
                body,
                payload,
                appVisibility
            });
        })
    );
};

export const teardownNativePushBridge = async () => {
    if (listeners.length > 0) {
        await Promise.all(listeners.map((listener) => listener.remove()));
    }
    listeners = [];
    initialized = false;
};

export const initializeNativePushBridge = async (): Promise<boolean> => {
    if (!Capacitor.isNativePlatform()) return false;
    if (initialized) return true;

    try {
        await attachPushListeners();
        await ensureAndroidNotificationChannel();

        const permissions = await PushNotifications.checkPermissions();
        console.info(`[native-push] POST_NOTIFICATIONS status(check)=${permissions.receive}.`);
        if (permissions.receive !== 'granted') {
            const requested = await PushNotifications.requestPermissions();
            console.info(`[native-push] POST_NOTIFICATIONS status(request)=${requested.receive}.`);
            if (requested.receive !== 'granted') {
                console.warn('[native-push] Notification permission was not granted.');
                return false;
            }
        }

        await PushNotifications.register();
        initialized = true;
        return true;
    } catch (error) {
        console.warn('[native-push] Initialization failed.', error);
        await teardownNativePushBridge();
        return false;
    }
};
