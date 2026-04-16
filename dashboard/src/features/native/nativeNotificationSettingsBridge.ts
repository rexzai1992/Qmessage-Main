import { Capacitor, registerPlugin } from '@capacitor/core';

type OpenSettingsResult = {
    opened?: boolean;
};

type NativeNotificationSettingsPlugin = {
    openAppNotificationSettings(): Promise<OpenSettingsResult>;
    openChannelNotificationSettings(options: { channelId: string }): Promise<OpenSettingsResult>;
};

const NativeNotificationSettings = registerPlugin<NativeNotificationSettingsPlugin>('NativeNotificationSettings');

const isAndroidNative = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

export const openAndroidAppNotificationSettings = async (): Promise<boolean> => {
    if (!isAndroidNative()) return false;
    try {
        const result = await NativeNotificationSettings.openAppNotificationSettings();
        return Boolean(result?.opened);
    } catch {
        return false;
    }
};

export const openAndroidChannelNotificationSettings = async (channelId: string): Promise<boolean> => {
    if (!isAndroidNative()) return false;
    const normalized = typeof channelId === 'string' ? channelId.trim() : '';
    if (!normalized) return false;
    try {
        const result = await NativeNotificationSettings.openChannelNotificationSettings({ channelId: normalized });
        return Boolean(result?.opened);
    } catch {
        return false;
    }
};
