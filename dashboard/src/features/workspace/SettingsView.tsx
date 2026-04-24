import React, { Suspense, useEffect, useMemo, useState } from 'react';
import { LogOut, Settings, ChevronRight } from 'lucide-react';

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
    showPermissionVerificationConsole?: boolean;
    showManualWabaSetup?: boolean;
    showRegisterWhatsAppNumber?: boolean;
    showOutgoingWebhooks?: boolean;
    showAdsShootMode?: boolean;
    notificationPermission: NotificationPermission | 'unsupported';
    notificationSoundEnabled: boolean;
    onToggleNotificationSound: (enabled: boolean) => void;
    onRequestNotifications: () => void;
    onTestNotificationSound: () => void;
    WebhookViewComponent: React.ComponentType<any>;
    isMobileView?: boolean;
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
    showPermissionVerificationConsole,
    showManualWabaSetup,
    showRegisterWhatsAppNumber,
    showOutgoingWebhooks,
    showAdsShootMode,
    notificationPermission,
    notificationSoundEnabled,
    onToggleNotificationSound,
    onRequestNotifications,
    onTestNotificationSound,
    WebhookViewComponent,
    isMobileView = false
}: SettingsViewProps) {
    const firstNavItemId = useMemo(() => settingsNav.flatMap((section) => section.items)[0]?.id || '', [settingsNav]);
    const mobileNavItems = useMemo(() => settingsNav.flatMap((section) => section.items), [settingsNav]);
    const [activeItemId, setActiveItemId] = useState(firstNavItemId);

    useEffect(() => {
        if (!activeItemId && firstNavItemId) {
            setActiveItemId(firstNavItemId);
        }
    }, [activeItemId, firstNavItemId]);

    const handleScrollToSection = (id: string) => {
        setActiveItemId(id);
        onScrollToSettingsSection(id);
    };

    return (
        <div
            className="fixed inset-x-0 bottom-0 z-[110] flex flex-col qm-app-gradient top-[calc(64px+env(safe-area-inset-top))] lg:top-[72px]"
            style={{
                paddingLeft: 'max(env(safe-area-inset-left), 0px)',
                paddingRight: 'max(env(safe-area-inset-right), 0px)'
            }}
        >
            <div className="min-h-0 flex-1 p-2 pb-[max(env(safe-area-inset-bottom),0px)] sm:p-4 lg:p-5">
                <div className="mx-auto flex h-full w-full max-w-[1480px] min-h-0 flex-col gap-3">
                    <div className={isMobileView ? 'px-2 py-2' : 'qm-shell px-3 py-3 sm:px-5 sm:py-4'}>
                        <div className="flex items-center justify-between gap-3">
                            <div className="flex min-w-0 items-center gap-3">
                                <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-[var(--qm-border)] bg-[var(--qm-brand-soft)] text-[var(--qm-brand)]">
                                    <Settings className="h-5 w-5" />
                                </div>
                                <div className="min-w-0">
                                    <p className="qm-eyebrow">Workspace Control</p>
                                    <h1 className="truncate text-lg font-extrabold text-[var(--qm-text)]">Settings and Configuration</h1>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={onSignOut}
                                    className="qm-btn qm-btn-danger h-10 px-4"
                                >
                                    <LogOut className="h-4 w-4" />
                                    <span className="hidden sm:inline">Log Out</span>
                                </button>
                            </div>
                        </div>
                    </div>

                    <div className={`min-h-0 flex flex-1 flex-col overflow-hidden ${isMobileView ? '' : 'qm-shell'} lg:grid lg:grid-cols-[288px_minmax(0,1fr)] lg:gap-0`}>
                    <aside className={`shrink-0 p-4 ${isMobileView ? '' : 'border-b border-[var(--qm-border)] bg-white'} lg:min-h-0 lg:overflow-y-auto lg:border-b-0 lg:border-r lg:p-5`}>
                        <div className="mb-2 flex items-center justify-between lg:mb-4">
                            <p className="qm-eyebrow">Sections</p>
                            <span className="qm-badge qm-badge-info">{mobileNavItems.length} Items</span>
                        </div>

                        <div className="flex gap-2 overflow-x-auto pb-1 lg:hidden">
                            {mobileNavItems.map((item) => {
                                const isActive = activeItemId === item.id;
                                return (
                                    <button
                                        key={`mobile-settings-nav-${item.id}`}
                                        type="button"
                                        onClick={() => handleScrollToSection(item.id)}
                                        className={`shrink-0 rounded-full border px-3 py-1.5 text-[11px] font-extrabold transition-all ${isActive
                                            ? 'border-[var(--qm-border-strong)] bg-[#edf5ff] text-[var(--qm-brand)]'
                                            : 'border-[var(--qm-border)] bg-white text-[var(--qm-text-muted)]'
                                            }`}
                                    >
                                        {item.label}
                                    </button>
                                );
                            })}
                        </div>

                        <div className="hidden space-y-5 lg:block">
                            {settingsNav.map((section) => (
                                <div key={section.group}>
                                    <p className="mb-2 text-[11px] font-extrabold uppercase tracking-[0.16em] text-[var(--qm-text-soft)]">{section.group}</p>
                                    <div className="grid gap-1.5">
                                        {section.items.map((item) => {
                                            const isActive = activeItemId === item.id;
                                            return (
                                                <button
                                                    key={item.id}
                                                    type="button"
                                                    onClick={() => handleScrollToSection(item.id)}
                                                    className={`group flex w-full items-center justify-between rounded-[12px] border px-3 py-2.5 text-left text-sm font-bold transition-all ${isActive
                                                        ? 'border-[var(--qm-border-strong)] bg-[#edf5ff] text-[var(--qm-text)] shadow-[var(--qm-shadow-sm)]'
                                                        : 'border-transparent bg-transparent text-[var(--qm-text-muted)] hover:border-[var(--qm-border)] hover:bg-[#f4f8ff] hover:text-[var(--qm-text)]'
                                                        }`}
                                                >
                                                    <span className="truncate">{item.label}</span>
                                                    <ChevronRight className={`h-4 w-4 shrink-0 transition-transform ${isActive ? 'text-[var(--qm-brand)]' : 'text-[var(--qm-text-soft)] group-hover:translate-x-0.5'}`} />
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </aside>

                    <div className={`min-h-0 flex-1 overflow-y-auto ${isMobileView ? '' : 'bg-[var(--qm-surface-soft)]/60'}`}>
                        <Suspense
                            fallback={
                                <div className="space-y-4 p-5 sm:p-7">
                                    <div className="qm-loading-block h-4 w-44" />
                                    <div className="qm-loading-block h-24 w-full rounded-[18px]" />
                                    <div className="qm-loading-block h-24 w-full rounded-[18px]" />
                                    <div className="qm-loading-block h-24 w-full rounded-[18px]" />
                                </div>
                            }
                        >
                            <div className="p-4 sm:p-6 lg:p-7">
                                <WebhookViewComponent
                                    profileId={profileId}
                                    sessionToken={sessionToken}
                                    isAdmin={isAdmin}
                                    isSuperAdmin={isSuperAdmin}
                                    isMobileView={isMobileView}
                                    quickReplies={quickReplies}
                                    quickRepliesLoading={quickRepliesLoading}
                                    quickRepliesSaving={quickRepliesSaving}
                                    quickRepliesError={quickRepliesError}
                                    onRefreshQuickReplies={onRefreshQuickReplies}
                                    onSaveQuickReplies={onSaveQuickReplies}
                                    onRefreshUiControls={onRefreshUiControls}
                                    showCallSettings={showCallSettings}
                                    showPermissionVerificationConsole={showPermissionVerificationConsole}
                                    showManualWabaSetup={showManualWabaSetup}
                                    showRegisterWhatsAppNumber={showRegisterWhatsAppNumber}
                                    showOutgoingWebhooks={showOutgoingWebhooks}
                                    showAdsShootMode={showAdsShootMode}
                                    notificationPermission={notificationPermission}
                                    notificationSoundEnabled={notificationSoundEnabled}
                                    onToggleNotificationSound={onToggleNotificationSound}
                                    onRequestNotifications={onRequestNotifications}
                                    onTestNotificationSound={onTestNotificationSound}
                                />
                            </div>
                        </Suspense>
                    </div>
                </div>
                </div>
            </div>
        </div>
    );
}
