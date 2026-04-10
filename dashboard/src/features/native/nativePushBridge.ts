import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import {
    PushNotifications,
    type ActionPerformed,
    type PushNotificationSchema,
    type Token
} from '@capacitor/push-notifications';

export const NATIVE_PUSH_CHANNEL_ID = 'qmessage-chat';
export const NATIVE_PUSH_TOKEN_EVENT = 'qmessage:native-push-token';
export const NATIVE_PUSH_RECEIVED_EVENT = 'qmessage:native-push-received';
export const NATIVE_PUSH_ACTION_EVENT = 'qmessage:native-push-action';

export type NativePushTokenEventDetail = {
    value: string;
    platform: 'android' | 'ios' | '';
};

export type NativePushReceivedEventDetail = {
    title: string;
    body: string;
    payload: PushNotificationSchema;
};

export type NativePushActionEventDetail = {
    actionId: string;
    title: string;
    body: string;
    payload: ActionPerformed;
};

let initialized = false;
let listeners: PluginListenerHandle[] = [];

const dispatchWindowEvent = <T>(eventName: string, detail: T) => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent<T>(eventName, { detail }));
};

const ensureAndroidNotificationChannel = async () => {
    if (Capacitor.getPlatform() !== 'android') return;
    try {
        // Recreate the channel so updated custom sound assets are picked up.
        await PushNotifications.deleteChannel({ id: NATIVE_PUSH_CHANNEL_ID }).catch(() => undefined);
        await PushNotifications.createChannel({
            id: NATIVE_PUSH_CHANNEL_ID,
            name: 'Chat Messages',
            description: 'Incoming QMessage chat alerts.',
            importance: 5,
            visibility: 1,
            sound: 'iphone_glass'
        });
    } catch (error) {
        console.warn('[native-push] Unable to create Android notification channel.', error);
    }
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
            dispatchWindowEvent<NativePushReceivedEventDetail>(NATIVE_PUSH_RECEIVED_EVENT, {
                title,
                body,
                payload: notification
            });
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
            dispatchWindowEvent<NativePushActionEventDetail>(NATIVE_PUSH_ACTION_EVENT, {
                actionId,
                title,
                body,
                payload
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
        if (permissions.receive !== 'granted') {
            const requested = await PushNotifications.requestPermissions();
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
