import React from 'react';
import { Bell, Download, Smartphone, X } from 'lucide-react';
import type { InstallPlatform, NotificationPermissionState } from '../pwa/installUtils';

type MobileInstallOnboardingProps = {
    open: boolean;
    platform: InstallPlatform;
    canTriggerNativeInstall: boolean;
    notificationPermission: NotificationPermissionState;
    onInstall: () => void;
    onDone: () => void;
    onNotNow: () => void;
    onDismiss: () => void;
    onRequestNotifications: () => void;
};

const PlatformHint = ({ platform }: { platform: InstallPlatform }) => {
    if (platform === 'ios') {
        return (
            <ol className="text-[12px] text-[#54656f] leading-relaxed list-decimal pl-4 space-y-1">
                <li>Open this app in Safari.</li>
                <li>Tap the Share button.</li>
                <li>Tap Add to Home Screen.</li>
            </ol>
        );
    }
    if (platform === 'android') {
        return (
            <p className="text-[12px] text-[#54656f] leading-relaxed">
                Install for faster launch, app-like navigation, and better message alert handling.
            </p>
        );
    }
    return (
        <p className="text-[12px] text-[#54656f] leading-relaxed">
            Add this app to your home screen for faster access and a smoother chat workflow.
        </p>
    );
};

export default function MobileInstallOnboarding({
    open,
    platform,
    canTriggerNativeInstall,
    notificationPermission,
    onInstall,
    onDone,
    onNotNow,
    onDismiss,
    onRequestNotifications
}: MobileInstallOnboardingProps) {
    const canRequestNotifications = notificationPermission === 'default';
    const [showNotificationPrompt, setShowNotificationPrompt] = React.useState(false);

    React.useEffect(() => {
        if (!open) {
            setShowNotificationPrompt(false);
            return;
        }
        setShowNotificationPrompt(canRequestNotifications);
    }, [canRequestNotifications, open]);

    if (!open) return null;

    return (
        <div className="fixed inset-0 z-[290] bg-black/40 backdrop-blur-[2px] flex items-end" onClick={onDismiss}>
            <div
                role="dialog"
                aria-modal="true"
                className="w-full rounded-t-[26px] bg-white border-t border-[#e6ecef] shadow-[0_-12px_40px_rgba(0,0,0,0.2)] p-4 pb-[max(16px,env(safe-area-inset-bottom))]"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="flex items-start justify-between gap-3 mb-2">
                    <div>
                        <h3 className="text-[17px] font-black text-[#111b21]">Install QMessage</h3>
                        <p className="text-[12px] text-[#54656f]">Mobile app-like experience for team inbox workflows.</p>
                    </div>
                    <button
                        type="button"
                        onClick={onDismiss}
                        className="p-2 rounded-lg text-[#6a7b87] hover:bg-[#f0f2f5]"
                        aria-label="Dismiss install prompt"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                <div className="rounded-2xl border border-[#e8edf1] bg-[#f8fafb] px-3 py-2.5 space-y-2">
                    <div className="flex items-center gap-2 text-[12px] font-bold text-[#111b21]">
                        <Smartphone className="w-4 h-4 text-[#00a884]" />
                        Why install?
                    </div>
                    <ul className="text-[12px] text-[#54656f] leading-relaxed space-y-1">
                        <li>Faster access from your home screen</li>
                        <li>Cleaner chat experience on mobile</li>
                        <li>Better support for incoming alert notifications</li>
                    </ul>
                </div>

                <div className="mt-3">
                    <PlatformHint platform={platform} />
                </div>

                {showNotificationPrompt && canRequestNotifications && (
                    <div className="mt-3 rounded-2xl border border-[#d8e5ec] bg-[#f2fbf8] px-3 py-3">
                        <div className="flex items-start gap-2">
                            <Bell className="w-4 h-4 text-[#00a884] mt-0.5" />
                            <div className="flex-1 min-w-0">
                                <p className="text-[12px] font-black text-[#111b21]">Allow notifications?</p>
                                <p className="text-[11px] text-[#54656f] mt-0.5">
                                    Get instant incoming chat alerts when your app is open or in the background.
                                </p>
                            </div>
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => {
                                    onRequestNotifications();
                                    setShowNotificationPrompt(false);
                                }}
                                className="flex-1 h-9 rounded-lg bg-[#00a884] text-white text-[12px] font-black"
                            >
                                Allow
                            </button>
                            <button
                                type="button"
                                onClick={() => setShowNotificationPrompt(false)}
                                className="flex-1 h-9 rounded-lg border border-[#dce4e8] bg-white text-[#54656f] text-[12px] font-bold"
                            >
                                Later
                            </button>
                        </div>
                    </div>
                )}

                {canRequestNotifications && (
                    <button
                        type="button"
                        onClick={onRequestNotifications}
                        className="mt-3 w-full h-10 rounded-xl border border-[#dce4e8] bg-[#f8fafb] text-[#111b21] font-bold text-[12px] flex items-center justify-center gap-2"
                    >
                        <Bell className="w-4 h-4 text-[#00a884]" />
                        Enable notifications
                    </button>
                )}

                <div className="mt-3 flex items-center gap-2">
                    {platform === 'android' && canTriggerNativeInstall && (
                        <button
                            type="button"
                            onClick={onInstall}
                            className="flex-1 h-11 rounded-xl bg-[#00a884] text-white font-black text-[13px] flex items-center justify-center gap-2"
                        >
                            <Download className="w-4 h-4" />
                            Install app
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={onDone}
                        className="flex-1 h-11 rounded-xl border border-[#dce4e8] bg-white text-[#111b21] font-bold text-[13px]"
                    >
                        Done
                    </button>
                    <button
                        type="button"
                        onClick={onNotNow}
                        className="flex-1 h-11 rounded-xl border border-[#dce4e8] bg-[#f8fafb] text-[#54656f] font-bold text-[13px]"
                    >
                        Not now
                    </button>
                </div>
            </div>
        </div>
    );
}
