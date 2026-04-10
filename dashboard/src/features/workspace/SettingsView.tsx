import React, { Suspense } from 'react';
import { LogOut, Settings, X } from 'lucide-react';

type SettingsNavItem = {
    id: string;
    label: string;
};

type SettingsNavSection = {
    group: string;
    items: SettingsNavItem[];
};

type SettingsViewProps = {
    settingsNav: SettingsNavSection[];
    onScrollToSettingsSection: (id: string) => void;
    onSignOut: () => void;
    onClose: () => void;
    profileId: string;
    sessionToken: string | null;
    isAdmin: boolean;
    isSuperAdmin?: boolean;
    quickReplies: any[];
    quickRepliesLoading: boolean;
    quickRepliesSaving: boolean;
    quickRepliesError: string | null;
    onRefreshQuickReplies: () => void;
    onSaveQuickReplies: (items: any[]) => void;
    onRefreshUiControls: () => void;
    showCallSettings?: boolean;
    notificationPermission: NotificationPermission | 'unsupported';
    notificationSoundEnabled: boolean;
    onToggleNotificationSound: (enabled: boolean) => void;
    onRequestNotifications: () => void;
    onTestNotificationSound: () => void;
    WebhookViewComponent: React.ComponentType<any>;
};

export default function SettingsView({
    settingsNav,
    onScrollToSettingsSection,
    onSignOut,
    onClose,
    profileId,
    sessionToken,
    isAdmin,
    isSuperAdmin = false,
    quickReplies,
    quickRepliesLoading,
    quickRepliesSaving,
    quickRepliesError,
    onRefreshQuickReplies,
    onSaveQuickReplies,
    onRefreshUiControls,
    showCallSettings,
    notificationPermission,
    notificationSoundEnabled,
    onToggleNotificationSound,
    onRequestNotifications,
    onTestNotificationSound,
    WebhookViewComponent
}: SettingsViewProps) {
    return (
        <div className="fixed inset-0 bg-[#f8f9fa] z-[150] flex flex-col">
            <header className="h-[64px] lg:h-[70px] bg-[#f0f2f5] px-3 sm:px-4 lg:px-6 flex items-center justify-between border-b border-[#eceff1]">
                <div className="flex items-center gap-4">
                    <Settings className="text-[#00a884] w-6 h-6 lg:w-8 lg:h-8" />
                    <h1 className="text-lg lg:text-xl font-bold text-[#111b21]">Settings</h1>
                </div>
                <div className="flex items-center gap-3">
                    <button
                        onClick={onSignOut}
                        className="px-3 lg:px-4 py-2 rounded-xl bg-white text-rose-500 font-bold border border-[#eceff1] hover:bg-rose-50 transition-all flex items-center gap-2"
                    >
                        <LogOut className="w-4 h-4" />
                        <span className="hidden sm:inline">Log Out</span>
                    </button>
                    <button onClick={onClose} className="p-2 hover:bg-white rounded-xl transition-all">
                        <X className="w-6 h-6 text-[#54656f]" />
                    </button>
                </div>
            </header>
            <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
                <aside className="w-full lg:w-64 bg-white border-b lg:border-b-0 lg:border-r border-[#eceff1] px-3 lg:px-5 py-3 lg:py-6 overflow-x-auto lg:overflow-y-auto">
                    <p className="text-[10px] font-black uppercase tracking-widest text-[#54656f] mb-4">Settings</p>
                    <div className="space-y-4 lg:space-y-6">
                        {settingsNav.map((section) => (
                            <div key={section.group}>
                                <p className="text-[10px] font-black uppercase tracking-widest text-[#8696a0] mb-2">{section.group}</p>
                                <div className="flex lg:flex-col gap-2 overflow-x-auto lg:overflow-visible pb-1 lg:pb-0">
                                    {section.items.map((item) => (
                                        <button
                                            key={item.id}
                                            onClick={() => onScrollToSettingsSection(item.id)}
                                            className="text-left whitespace-nowrap px-3 py-2 rounded-xl text-sm font-bold text-[#111b21] hover:bg-[#f0f2f5] transition-all"
                                        >
                                            {item.label}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </aside>
                <div className="flex-1 overflow-y-auto">
                    <Suspense fallback={
                        <div className="p-6 md:p-8 animate-pulse space-y-4">
                            <div className="h-4 w-40 rounded bg-[#e8edf1]" />
                            <div className="h-24 rounded-2xl bg-white border border-[#eceff1]" />
                            <div className="h-24 rounded-2xl bg-white border border-[#eceff1]" />
                            <div className="h-24 rounded-2xl bg-white border border-[#eceff1]" />
                        </div>
                    }>
                        <WebhookViewComponent
                            profileId={profileId}
                            sessionToken={sessionToken}
                            isAdmin={isAdmin}
                            isSuperAdmin={isSuperAdmin}
                            quickReplies={quickReplies}
                            quickRepliesLoading={quickRepliesLoading}
                            quickRepliesSaving={quickRepliesSaving}
                            quickRepliesError={quickRepliesError}
                            onRefreshQuickReplies={onRefreshQuickReplies}
                            onSaveQuickReplies={onSaveQuickReplies}
                            onRefreshUiControls={onRefreshUiControls}
                            showCallSettings={showCallSettings}
                            notificationPermission={notificationPermission}
                            notificationSoundEnabled={notificationSoundEnabled}
                            onToggleNotificationSound={onToggleNotificationSound}
                            onRequestNotifications={onRequestNotifications}
                            onTestNotificationSound={onTestNotificationSound}
                        />
                    </Suspense>
                </div>
            </div>
        </div>
    );
}
