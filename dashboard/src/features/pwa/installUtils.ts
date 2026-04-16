export type InstallPlatform = 'android' | 'ios' | 'other';

export type InstallOnboardingDecision = 'done' | 'not_now' | 'dismissed';

export type NotificationPermissionState = NotificationPermission | 'unsupported';

export interface BeforeInstallPromptEvent extends Event {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export const INSTALL_ONBOARDING_STORAGE_KEY = 'pwaInstallOnboardingDecision:v1';

const readUserAgent = (): string => {
    if (typeof navigator === 'undefined') return '';
    return (navigator.userAgent || '').toLowerCase();
};

const isIpadOsDesktopUa = (): boolean => {
    if (typeof navigator === 'undefined') return false;
    return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
};

export const isStandaloneMode = (): boolean => {
    if (typeof window === 'undefined') return false;
    const navigatorStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
    const displayModeStandalone = window.matchMedia?.('(display-mode: standalone)')?.matches === true;
    return navigatorStandalone || displayModeStandalone;
};

export const detectInstallPlatform = (): InstallPlatform => {
    const ua = readUserAgent();
    if (/android/.test(ua)) return 'android';
    if (/iphone|ipad|ipod/.test(ua) || isIpadOsDesktopUa()) return 'ios';
    return 'other';
};

export const isMobileDevice = (): boolean => {
    if (typeof navigator === 'undefined') return false;
    const navigatorWithUaData = navigator as Navigator & {
        userAgentData?: { mobile?: boolean };
    };
    if (typeof navigatorWithUaData.userAgentData?.mobile === 'boolean') {
        return navigatorWithUaData.userAgentData.mobile;
    }
    const ua = readUserAgent();
    if (/android|iphone|ipad|ipod|mobile/.test(ua)) return true;
    return isIpadOsDesktopUa();
};

export const isIosSafari = (): boolean => {
    const ua = readUserAgent();
    const isIos = /iphone|ipad|ipod/.test(ua);
    const isSafari = /safari/.test(ua) && !/crios|fxios|edgios|opr\//.test(ua);
    return isIos && isSafari;
};

export const readInstallOnboardingDecision = (): InstallOnboardingDecision | null => {
    if (typeof window === 'undefined') return null;
    try {
        const raw = window.localStorage.getItem(INSTALL_ONBOARDING_STORAGE_KEY);
        if (raw === 'done' || raw === 'not_now' || raw === 'dismissed') {
            return raw;
        }
        return null;
    } catch {
        return null;
    }
};

export const persistInstallOnboardingDecision = (decision: InstallOnboardingDecision): void => {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(INSTALL_ONBOARDING_STORAGE_KEY, decision);
    } catch {
        // ignore
    }
};

export const clearInstallOnboardingDecision = (): void => {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.removeItem(INSTALL_ONBOARDING_STORAGE_KEY);
    } catch {
        // ignore
    }
};

export const getNotificationPermissionState = (): NotificationPermissionState => {
    if (typeof window === 'undefined') return 'unsupported';
    if (!('Notification' in window)) return 'unsupported';
    return Notification.permission;
};
