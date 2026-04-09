
import React, { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Globe, Shield, PhoneCall } from 'lucide-react';
import { getSocketUrl } from './runtimeConfig';
import { supabase } from './supabase';
import { uploadFileToCompanyStorage } from './features/media/uploadToCompanyStorage';

const SOCKET_URL = getSocketUrl();

type QuickReply = {
    id?: string;
    shortcut: string;
    text: string;
};

type TeamRole = 'owner' | 'admin' | 'agent';
type TeamDepartment = 'finance' | 'sales' | 'marketing' | 'production' | 'custom';

type TeamUser = {
    id: string;
    email?: string | null;
    name: string;
    role: TeamRole;
    department?: TeamDepartment;
    customDepartment?: string | null;
    color?: string | null;
    createdAt?: string | null;
    lastSignInAt?: string | null;
};

type ConversationalCommand = {
    command_name: string;
    command_description: string;
};

type CallStatus = 'ENABLED' | 'DISABLED';
type CallIconVisibility = 'DEFAULT' | 'DISABLE_ALL';
type CallbackPermissionStatus = 'ENABLED' | 'DISABLED';

type CallSettingsFormState = {
    status: CallStatus;
    callIconVisibility: CallIconVisibility;
    callbackPermissionStatus: CallbackPermissionStatus;
    restrictToUserCountries: string;
};

type BusinessProfileFormState = {
    about: string;
    address: string;
    description: string;
    email: string;
    websites: string;
    vertical: string;
    profilePictureUrl: string;
};

const TEAM_DEPARTMENT_OPTIONS: Array<{ value: TeamDepartment; label: string }> = [
    { value: 'finance', label: 'Finance' },
    { value: 'sales', label: 'Sales' },
    { value: 'marketing', label: 'Marketing' },
    { value: 'production', label: 'Production' },
    { value: 'custom', label: 'Custom' }
];

const normalizeTeamDepartment = (value: unknown): TeamDepartment => {
    const lower = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (lower === 'finance' || lower === 'sales' || lower === 'marketing' || lower === 'production' || lower === 'custom') {
        return lower;
    }
    return 'custom';
};

const COMMAND_MAX_COUNT = 30;
const COMMAND_NAME_MAX_LENGTH = 32;
const COMMAND_DESCRIPTION_MAX_LENGTH = 256;
const COMMAND_NAME_REGEX = /^[a-z0-9_-]+$/;
const EMOJI_REGEX = /\p{Extended_Pictographic}/u;
const DEFAULT_APP_LOGO_MAX_BYTES = 2 * 1024 * 1024;

const normalizeCommandName = (value: unknown): string =>
    (typeof value === 'string' ? value.trim() : '').replace(/^\/+/, '').toLowerCase();

const normalizeCommandDescription = (value: unknown): string =>
    typeof value === 'string' ? value.trim() : '';

const readTrimmed = (value: unknown): string =>
    typeof value === 'string' ? value.trim() : '';

const normalizeAppLogoMaxBytes = (value: unknown): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_APP_LOGO_MAX_BYTES;
    const normalized = Math.max(1, Math.floor(parsed));
    return normalized;
};

const normalizeAppLogoSizeBytes = (value: unknown): number | null => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    const normalized = Math.max(0, Math.floor(parsed));
    return normalized || null;
};

const formatBytes = (value: number): string => {
    if (!Number.isFinite(value) || value <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let amount = value;
    let unitIndex = 0;
    while (amount >= 1024 && unitIndex < units.length - 1) {
        amount /= 1024;
        unitIndex += 1;
    }
    const digits = amount >= 10 || unitIndex === 0 ? 0 : 1;
    return `${amount.toFixed(digits)} ${units[unitIndex]}`;
};

const sanitizeCommandInput = (value: unknown): ConversationalCommand[] => {
    if (!Array.isArray(value)) return [];
    const next: ConversationalCommand[] = [];
    value.forEach((item: any) => {
        const command_name = normalizeCommandName(item?.command_name);
        const command_description = normalizeCommandDescription(item?.command_description);
        if (!command_name && !command_description) return;
        next.push({ command_name, command_description });
    });
    return next.slice(0, COMMAND_MAX_COUNT);
};

const validateCommandsForSave = (commands: ConversationalCommand[]): { commands: ConversationalCommand[]; error: string | null } => {
    if (commands.length > COMMAND_MAX_COUNT) {
        return { commands: [], error: `Maximum ${COMMAND_MAX_COUNT} commands are allowed.` };
    }

    const seen = new Set<string>();
    const cleaned: ConversationalCommand[] = [];

    for (let i = 0; i < commands.length; i += 1) {
        const command_name = normalizeCommandName(commands[i]?.command_name);
        const command_description = normalizeCommandDescription(commands[i]?.command_description);
        const label = `Command ${i + 1}`;

        if (!command_name && !command_description) continue;
        if (!command_name || !command_description) {
            return { commands: [], error: `${label}: both command and hint are required.` };
        }
        if (command_name.length > COMMAND_NAME_MAX_LENGTH) {
            return { commands: [], error: `${label}: command must be at most ${COMMAND_NAME_MAX_LENGTH} characters.` };
        }
        if (command_description.length > COMMAND_DESCRIPTION_MAX_LENGTH) {
            return { commands: [], error: `${label}: hint must be at most ${COMMAND_DESCRIPTION_MAX_LENGTH} characters.` };
        }
        if (!COMMAND_NAME_REGEX.test(command_name)) {
            return { commands: [], error: `${label}: command supports a-z, 0-9, underscore, and hyphen only.` };
        }
        if (EMOJI_REGEX.test(command_name) || EMOJI_REGEX.test(command_description)) {
            return { commands: [], error: `${label}: emojis are not supported.` };
        }
        if (seen.has(command_name)) {
            return { commands: [], error: `${label}: duplicate command "/${command_name}" is not allowed.` };
        }

        seen.add(command_name);
        cleaned.push({ command_name, command_description });
    }

    return { commands: cleaned, error: null };
};

type WebhookViewProps = {
    profileId: string;
    sessionToken?: string | null;
    isAdmin?: boolean;
    isSuperAdmin?: boolean;
    quickReplies: QuickReply[];
    quickRepliesLoading: boolean;
    quickRepliesSaving: boolean;
    quickRepliesError: string | null;
    onRefreshQuickReplies: () => void;
    onSaveQuickReplies: (items: QuickReply[]) => void;
    onRefreshUiControls: () => void;
    showCallSettings?: boolean;
};

export default function WebhookView({
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
    showCallSettings = true
}: WebhookViewProps) {
    const [webhooks, setWebhooks] = useState<any[]>([]);
    const [webhookError, setWebhookError] = useState<string | null>(null);
    const [webhookLoading, setWebhookLoading] = useState(true);
    const [webhooksLoaded, setWebhooksLoaded] = useState(false);
    const [newUrl, setNewUrl] = useState('');
    const [newEvents, setNewEvents] = useState<string[]>(['message_received']);
    const [loading, setLoading] = useState(false);
    const [autoConfig, setAutoConfig] = useState<{
        enable_welcome_message: boolean;
        prompts: string[];
        commands: ConversationalCommand[];
    }>({
        enable_welcome_message: false,
        prompts: [],
        commands: []
    });
    const [autoLoading, setAutoLoading] = useState(Boolean(sessionToken));
    const [autoSaving, setAutoSaving] = useState(false);
    const [autoError, setAutoError] = useState<string | null>(null);
    const [reminderConfig, setReminderConfig] = useState<{
        enabled: boolean;
        minutes: number | '';
        text: string;
    }>({
        enabled: false,
        minutes: 30,
        text: ''
    });
    const [reminderLoading, setReminderLoading] = useState(Boolean(sessionToken));
    const [reminderSaving, setReminderSaving] = useState(false);
    const [connectedBusinesses, setConnectedBusinesses] = useState<any[]>([]);
    const [connectedPaging, setConnectedPaging] = useState<any | null>(null);
    const [connectedLoading, setConnectedLoading] = useState(Boolean(isSuperAdmin));
    const [connectedError, setConnectedError] = useState<string | null>(null);
    const [connectedAppId, setConnectedAppId] = useState('');
    const [callSettingsLoading, setCallSettingsLoading] = useState(Boolean(sessionToken));
    const [callSettingsSaving, setCallSettingsSaving] = useState(false);
    const [callSettingsError, setCallSettingsError] = useState<string | null>(null);
    const [callSettingsNotice, setCallSettingsNotice] = useState<string | null>(null);
    const [callSettingsPhoneNumberId, setCallSettingsPhoneNumberId] = useState('');
    const [includeSipCredentials, setIncludeSipCredentials] = useState(false);
    const [callSettingsRaw, setCallSettingsRaw] = useState<any | null>(null);
    const [callSettingsForm, setCallSettingsForm] = useState<CallSettingsFormState>({
        status: 'DISABLED',
        callIconVisibility: 'DEFAULT',
        callbackPermissionStatus: 'DISABLED',
        restrictToUserCountries: ''
    });
    const [businessProfileLoading, setBusinessProfileLoading] = useState(Boolean(sessionToken));
    const [businessProfileSaving, setBusinessProfileSaving] = useState(false);
    const [businessProfileUploading, setBusinessProfileUploading] = useState(false);
    const [businessProfileError, setBusinessProfileError] = useState<string | null>(null);
    const [businessProfileNotice, setBusinessProfileNotice] = useState<string | null>(null);
    const [businessProfilePhoneNumberId, setBusinessProfilePhoneNumberId] = useState('');
    const [businessProfileForm, setBusinessProfileForm] = useState<BusinessProfileFormState>({
        about: '',
        address: '',
        description: '',
        email: '',
        websites: '',
        vertical: '',
        profilePictureUrl: ''
    });
    const [quickRepliesDraft, setQuickRepliesDraft] = useState<QuickReply[]>([]);
    const [connectLoading, setConnectLoading] = useState(false);
    const [connectError, setConnectError] = useState<string | null>(null);
    const [clientConnections, setClientConnections] = useState<any[]>([]);
    const [clientLoading, setClientLoading] = useState(Boolean(isSuperAdmin));
    const [clientError, setClientError] = useState<string | null>(null);
    const [teamUsers, setTeamUsers] = useState<TeamUser[]>([]);
    const [teamLoading, setTeamLoading] = useState(Boolean(sessionToken));
    const [teamError, setTeamError] = useState<string | null>(null);
    const [teamCurrentRole, setTeamCurrentRole] = useState<TeamRole>('agent');
    const [teamCurrentUserId, setTeamCurrentUserId] = useState<string | null>(null);
    const [inviteEmail, setInviteEmail] = useState('');
    const [invitePassword, setInvitePassword] = useState('');
    const [inviteRole, setInviteRole] = useState<TeamRole>('agent');
    const [inviteDepartment, setInviteDepartment] = useState<TeamDepartment>('sales');
    const [inviteCustomDepartment, setInviteCustomDepartment] = useState('');
    const [inviteLoading, setInviteLoading] = useState(false);
    const [inviteError, setInviteError] = useState<string | null>(null);
    const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);
    const [roleSavingUserId, setRoleSavingUserId] = useState<string | null>(null);
    const [departmentSavingUserId, setDepartmentSavingUserId] = useState<string | null>(null);
    const [selfPassword, setSelfPassword] = useState('');
    const [selfPasswordConfirm, setSelfPasswordConfirm] = useState('');
    const [selfPasswordSaving, setSelfPasswordSaving] = useState(false);
    const [selfPasswordError, setSelfPasswordError] = useState<string | null>(null);
    const [selfPasswordSuccess, setSelfPasswordSuccess] = useState<string | null>(null);
    const [manualConfig, setManualConfig] = useState({
        wabaId: '',
        phoneNumberId: '',
        accessToken: '',
        businessId: '',
        verifyToken: '',
        appId: '',
        appSecret: '',
        apiVersion: ''
    });
    const [manualLoading, setManualLoading] = useState(false);
    const [manualError, setManualError] = useState<string | null>(null);
    const [manualSuccess, setManualSuccess] = useState<string | null>(null);
    const [registrationConfig, setRegistrationConfig] = useState<any | null>(null);
    const [registrationLoading, setRegistrationLoading] = useState(false);
    const [registrationError, setRegistrationError] = useState<string | null>(null);
    const [registrationNumbers, setRegistrationNumbers] = useState<any[]>([]);
    const [registrationNumbersLoading, setRegistrationNumbersLoading] = useState(false);
    const [registrationNumbersError, setRegistrationNumbersError] = useState<string | null>(null);
    const [showRegistrationWizard, setShowRegistrationWizard] = useState(false);
    const [registrationStep, setRegistrationStep] = useState<1 | 2 | 3 | 4>(1);
    const [registrationRequestSent, setRegistrationRequestSent] = useState(false);
    const [registrationVerified, setRegistrationVerified] = useState(false);
    const [registrationRegistered, setRegistrationRegistered] = useState(false);
    const [registrationProfileUpdated, setRegistrationProfileUpdated] = useState(false);
    const [registrationWabaId, setRegistrationWabaId] = useState('');
    const [registrationPhoneNumberId, setRegistrationPhoneNumberId] = useState('');
    const [registrationCodeMethod, setRegistrationCodeMethod] = useState<'SMS' | 'VOICE'>('SMS');
    const [registrationLocale, setRegistrationLocale] = useState('en_US');
    const [registrationCode, setRegistrationCode] = useState('');
    const [registrationPin, setRegistrationPin] = useState('');
    const [registrationProfileJson, setRegistrationProfileJson] = useState(`{
  "about": "Tell customers about your business",
  "address": "123 Main Street",
  "description": "Fast support via WhatsApp",
  "email": "support@example.com",
  "websites": ["https://example.com"],
  "vertical": "OTHER"
}`);
    const [registrationBusy, setRegistrationBusy] = useState<null | 'request' | 'verify' | 'register' | 'profile'>(null);
    const businessProfileFileInputRef = useRef<HTMLInputElement>(null);
    const appLogoFileInputRef = useRef<HTMLInputElement>(null);
    const [appLogoLoading, setAppLogoLoading] = useState(Boolean(sessionToken));
    const [appLogoUploading, setAppLogoUploading] = useState(false);
    const [appLogoSaving, setAppLogoSaving] = useState(false);
    const [appLogoError, setAppLogoError] = useState<string | null>(null);
    const [appLogoNotice, setAppLogoNotice] = useState<string | null>(null);
    const [appLogoUrl, setAppLogoUrl] = useState('');
    const [appLogoAssetKey, setAppLogoAssetKey] = useState('');
    const [appLogoMimeType, setAppLogoMimeType] = useState('');
    const [appLogoFilename, setAppLogoFilename] = useState('');
    const [appLogoSizeBytes, setAppLogoSizeBytes] = useState<number | null>(null);
    const [appLogoMaxBytes, setAppLogoMaxBytes] = useState(DEFAULT_APP_LOGO_MAX_BYTES);
    const showLegacyAutomationSettings = false;

    useEffect(() => {
        if (!profileId) return;
        fetchWebhooks();
        fetchAutomation();
        fetchWindowReminder();
        if (isSuperAdmin) {
            fetchConnectedBusinesses();
            fetchClientConnections();
        }
        if (sessionToken) {
            fetchRegistrationConfig();
            fetchTeamUsers();
            if (showCallSettings) {
                fetchCallSettings();
            }
            fetchBusinessProfile();
        }
        onRefreshQuickReplies();
    }, [profileId, onRefreshQuickReplies, isSuperAdmin, sessionToken, showCallSettings]);

    useEffect(() => {
        if (!sessionToken) return;
        const params = new URLSearchParams(window.location.search);
        if (params.get('waba') === 'connected') {
            openRegistrationWizard();
            params.delete('waba');
            const next = params.toString();
            const nextUrl = `${window.location.pathname}${next ? `?${next}` : ''}`;
            window.history.replaceState({}, '', nextUrl);
        }
    }, [sessionToken]);

    useEffect(() => {
        setQuickRepliesDraft(quickReplies.map(item => ({ ...item })));
    }, [quickReplies]);

    const handleAddQuickReply = () => {
        setQuickRepliesDraft(prev => ([
            ...prev,
            { shortcut: '', text: '' }
        ]));
    };

    const handleUpdateQuickReply = (index: number, field: 'shortcut' | 'text', value: string) => {
        setQuickRepliesDraft(prev => {
            const next = [...prev];
            next[index] = { ...next[index], [field]: value };
            return next;
        });
    };

    const handleRemoveQuickReply = (index: number) => {
        setQuickRepliesDraft(prev => prev.filter((_, idx) => idx !== index));
    };

    const handleSaveQuickReplies = () => {
        onSaveQuickReplies(quickRepliesDraft);
    };

    const applyAppLogoPayload = (payload: any) => {
        setAppLogoUrl(readTrimmed(payload?.logo_url));
        setAppLogoAssetKey(readTrimmed(payload?.logo_asset_key));
        setAppLogoMimeType(readTrimmed(payload?.logo_mime_type).toLowerCase());
        setAppLogoFilename(readTrimmed(payload?.logo_filename));
        setAppLogoSizeBytes(normalizeAppLogoSizeBytes(payload?.logo_size_bytes));
        setAppLogoMaxBytes(normalizeAppLogoMaxBytes(payload?.logo_max_bytes));
    };

    const fetchAppLogoSettings = async () => {
        if (!sessionToken) {
            setAppLogoUrl('');
            setAppLogoAssetKey('');
            setAppLogoMimeType('');
            setAppLogoFilename('');
            setAppLogoSizeBytes(null);
            setAppLogoError(null);
            setAppLogoNotice(null);
            setAppLogoMaxBytes(DEFAULT_APP_LOGO_MAX_BYTES);
            setAppLogoLoading(false);
            return;
        }

        setAppLogoLoading(true);
        setAppLogoError(null);
        try {
            const res = await fetch(`${SOCKET_URL}/api/company/app-logo`, {
                headers: {
                    Authorization: `Bearer ${sessionToken}`
                }
            });
            const text = await res.text();
            let data: any = null;
            try {
                data = text ? JSON.parse(text) : null;
            } catch {
                data = null;
            }
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to load app logo settings.');
            }
            applyAppLogoPayload(data?.data || {});
        } catch (error: any) {
            setAppLogoUrl('');
            setAppLogoAssetKey('');
            setAppLogoMimeType('');
            setAppLogoFilename('');
            setAppLogoSizeBytes(null);
            setAppLogoError(error?.message || 'Failed to load app logo settings.');
        } finally {
            setAppLogoLoading(false);
        }
    };

    const saveAppLogoAsset = async (uploaded: { assetKey: string; mimeType: string; sizeBytes: number; fileName: string }) => {
        if (!sessionToken) throw new Error('You must be logged in to update app logo.');
        setAppLogoSaving(true);
        const res = await fetch(`${SOCKET_URL}/api/company/app-logo`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${sessionToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                app_logo_asset_key: uploaded.assetKey,
                app_logo_mime_type: uploaded.mimeType,
                app_logo_size_bytes: uploaded.sizeBytes,
                app_logo_filename: uploaded.fileName
            })
        });
        const text = await res.text();
        let data: any = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            data = null;
        }
        if (!res.ok || !data?.success) {
            throw new Error(data?.error || 'Failed to save app logo.');
        }
        applyAppLogoPayload(data?.data || {});
    };

    const handleUploadAppLogo = async (file: File | null) => {
        if (!file) return;
        if (!profileId || !sessionToken) {
            setAppLogoError('Select an active profile and login before uploading app logo.');
            return;
        }
        if (!file.type || !file.type.toLowerCase().startsWith('image/')) {
            setAppLogoError('App logo must be an image file.');
            return;
        }
        if (file.size > appLogoMaxBytes) {
            setAppLogoError(`App logo is too large. Max size is ${formatBytes(appLogoMaxBytes)}.`);
            return;
        }

        setAppLogoNotice(null);
        setAppLogoError(null);
        setAppLogoUploading(true);
        try {
            const uploaded = await uploadFileToCompanyStorage({
                apiBaseUrl: SOCKET_URL,
                profileId,
                sessionToken,
                purpose: 'app_logo',
                messageType: 'image',
                file
            });
            await saveAppLogoAsset(uploaded);
            setAppLogoNotice('App logo updated.');
            void onRefreshUiControls();
        } catch (error: any) {
            setAppLogoError(error?.message || 'Failed to upload app logo.');
        } finally {
            setAppLogoUploading(false);
            setAppLogoSaving(false);
            if (appLogoFileInputRef.current) {
                appLogoFileInputRef.current.value = '';
            }
        }
    };

    const handleRemoveAppLogo = async () => {
        if (!sessionToken) {
            setAppLogoError('You must be logged in to remove app logo.');
            return;
        }
        setAppLogoNotice(null);
        setAppLogoError(null);
        setAppLogoSaving(true);
        try {
            const res = await fetch(`${SOCKET_URL}/api/company/app-logo`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${sessionToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ clear: true })
            });
            const text = await res.text();
            let data: any = null;
            try {
                data = text ? JSON.parse(text) : null;
            } catch {
                data = null;
            }
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to remove app logo.');
            }
            applyAppLogoPayload(data?.data || {});
            setAppLogoNotice('App logo removed.');
            void onRefreshUiControls();
        } catch (error: any) {
            setAppLogoError(error?.message || 'Failed to remove app logo.');
        } finally {
            setAppLogoSaving(false);
        }
    };

    useEffect(() => {
        fetchAppLogoSettings();
    }, [sessionToken]);

    const handleConnectWhatsapp = async () => {
        if (!sessionToken) {
            setConnectError('You must be logged in to connect WhatsApp.');
            return;
        }
        setConnectLoading(true);
        setConnectError(null);
        try {
            const res = await fetch(`${SOCKET_URL}/api/waba/embedded-signup/url?profileId=${encodeURIComponent(profileId)}`, {
                headers: {
                    Authorization: `Bearer ${sessionToken}`
                }
            });
            const data = await res.json();
            if (!res.ok || !data?.success || !data?.url) {
                throw new Error(data?.error || 'Failed to start embedded signup');
            }
            window.location.href = data.url;
        } catch (err: any) {
            setConnectError(err?.message || 'Failed to start embedded signup');
        } finally {
            setConnectLoading(false);
        }
    };

    const handleManualConfigSave = async () => {
        if (!sessionToken) {
            setManualError('You must be logged in to save a manual configuration.');
            return;
        }
        setManualLoading(true);
        setManualError(null);
        setManualSuccess(null);
        try {
            const res = await fetch(`${SOCKET_URL}/api/waba/manual-config`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${sessionToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    profileId,
                    wabaId: manualConfig.wabaId.trim(),
                    phoneNumberId: manualConfig.phoneNumberId.trim(),
                    accessToken: manualConfig.accessToken.trim(),
                    businessId: manualConfig.businessId.trim() || null,
                    verifyToken: manualConfig.verifyToken.trim() || null,
                    appId: manualConfig.appId.trim() || null,
                    appSecret: manualConfig.appSecret.trim() || null,
                    apiVersion: manualConfig.apiVersion.trim() || null
                })
            });
            const data = await res.json();
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Manual config failed');
            }
            setManualSuccess(data?.subscribeError ? `Saved. Webhook subscription failed: ${data.subscribeError}` : 'Saved and subscribed.');
        } catch (err: any) {
            setManualError(err?.message || 'Manual config failed');
        } finally {
            setManualLoading(false);
        }
    };

    const openRegistrationWizard = () => {
        setRegistrationStep(1);
        setRegistrationRequestSent(false);
        setRegistrationVerified(false);
        setRegistrationRegistered(false);
        setRegistrationProfileUpdated(false);
        setRegistrationError(null);
        setRegistrationNumbersError(null);
        setRegistrationCode('');
        setRegistrationPin('');
        setShowRegistrationWizard(true);
        if (sessionToken) {
            fetchRegistrationConfig();
            fetchRegistrationNumbers();
        }
    };

    const closeRegistrationWizard = () => {
        setShowRegistrationWizard(false);
    };

    const fetchRegistrationConfig = () => {
        if (!sessionToken || !profileId) return;
        setRegistrationLoading(true);
        setRegistrationError(null);
        fetch(`${SOCKET_URL}/api/waba/registration/config?profileId=${encodeURIComponent(profileId)}`, {
            headers: { Authorization: `Bearer ${sessionToken}` }
        })
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    return null;
                }
            })
            .then(data => {
                if (data?.success) {
                    const cfg = data.data || {};
                    setRegistrationConfig(cfg);
                    setRegistrationWabaId(cfg.wabaId || '');
                    setRegistrationPhoneNumberId(cfg.phoneNumberId || '');
                    setRegistrationError(null);
                } else {
                    setRegistrationConfig(null);
                    setRegistrationError(data?.error || 'Failed to load registration config');
                }
            })
            .finally(() => setRegistrationLoading(false));
    };

    const fetchRegistrationNumbers = () => {
        if (!sessionToken || !profileId) return;
        setRegistrationNumbersLoading(true);
        setRegistrationNumbersError(null);
        const params = new URLSearchParams();
        params.set('profileId', profileId);
        if (registrationWabaId.trim()) params.set('wabaId', registrationWabaId.trim());
        fetch(`${SOCKET_URL}/api/waba/registration/phone-numbers?${params.toString()}`, {
            headers: { Authorization: `Bearer ${sessionToken}` }
        })
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    return null;
                }
            })
            .then(data => {
                if (data?.success) {
                    const payload = data.data?.data || data.data || {};
                    const list = Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : [];
                    setRegistrationNumbers(list);
                    if (!registrationPhoneNumberId && list[0]?.id) {
                        setRegistrationPhoneNumberId(list[0].id);
                    }
                    setRegistrationNumbersError(null);
                } else {
                    setRegistrationNumbers([]);
                    setRegistrationNumbersError(data?.error || 'Failed to load phone numbers');
                }
            })
            .finally(() => setRegistrationNumbersLoading(false));
    };

    const handleRequestVerificationCode = async () => {
        if (!sessionToken || !profileId) return;
        setRegistrationBusy('request');
        setRegistrationError(null);
        try {
            const res = await fetch(`${SOCKET_URL}/api/waba/registration/request-code`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${sessionToken}`
                },
                body: JSON.stringify({
                    profileId,
                    phoneNumberId: registrationPhoneNumberId.trim(),
                    codeMethod: registrationCodeMethod,
                    locale: registrationLocale.trim() || 'en_US'
                })
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to request verification code');
            }
            setRegistrationRequestSent(true);
        } catch (err: any) {
            setRegistrationError(err?.message || 'Failed to request verification code');
        } finally {
            setRegistrationBusy(null);
        }
    };

    const handleVerifyCode = async () => {
        if (!sessionToken || !profileId) return;
        setRegistrationBusy('verify');
        setRegistrationError(null);
        try {
            const res = await fetch(`${SOCKET_URL}/api/waba/registration/verify-code`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${sessionToken}`
                },
                body: JSON.stringify({
                    profileId,
                    phoneNumberId: registrationPhoneNumberId.trim(),
                    code: registrationCode.trim()
                })
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to verify code');
            }
            setRegistrationVerified(true);
        } catch (err: any) {
            setRegistrationError(err?.message || 'Failed to verify code');
        } finally {
            setRegistrationBusy(null);
        }
    };

    const handleRegisterNumber = async () => {
        if (!sessionToken || !profileId) return;
        setRegistrationBusy('register');
        setRegistrationError(null);
        try {
            const res = await fetch(`${SOCKET_URL}/api/waba/registration/register`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${sessionToken}`
                },
                body: JSON.stringify({
                    profileId,
                    phoneNumberId: registrationPhoneNumberId.trim(),
                    pin: registrationPin.trim()
                })
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to register number');
            }
            setRegistrationRegistered(true);
        } catch (err: any) {
            setRegistrationError(err?.message || 'Failed to register number');
        } finally {
            setRegistrationBusy(null);
        }
    };

    const handleUpdateProfile = async () => {
        if (!sessionToken || !profileId) return;
        setRegistrationBusy('profile');
        setRegistrationError(null);
        try {
            const parsed = JSON.parse(registrationProfileJson);
            const res = await fetch(`${SOCKET_URL}/api/waba/registration/profile`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${sessionToken}`
                },
                body: JSON.stringify({
                    profileId,
                    phoneNumberId: registrationPhoneNumberId.trim(),
                    profile: parsed
                })
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to update business profile');
            }
            setRegistrationProfileUpdated(true);
        } catch (err: any) {
            setRegistrationError(err?.message || 'Failed to update business profile');
        } finally {
            setRegistrationBusy(null);
        }
    };

    const parseBusinessProfileError = (data: any, fallback: string): string => {
        const message = readTrimmed(data?.error) || fallback;
        const details = Array.isArray(data?.details)
            ? data.details.map((item: any) => readTrimmed(item)).filter(Boolean)
            : [];
        if (!details.length) return message;
        return `${message} (${details.join(', ')})`;
    };

    const applyBusinessProfilePayload = (payload: any) => {
        const root = payload && typeof payload === 'object' ? payload : {};
        const candidates = Array.isArray(root?.data)
            ? root.data
            : Array.isArray(root)
                ? root
                : [];
        const first = candidates.length > 0 && candidates[0] && typeof candidates[0] === 'object'
            ? candidates[0]
            : root;
        const websites = Array.isArray(first?.websites)
            ? first.websites.map((item: any) => readTrimmed(item)).filter(Boolean)
            : typeof first?.websites === 'string'
                ? first.websites.split(/[\n,;]+/).map((item: string) => readTrimmed(item)).filter(Boolean)
                : [];

        setBusinessProfileForm({
            about: readTrimmed(first?.about),
            address: readTrimmed(first?.address),
            description: readTrimmed(first?.description),
            email: readTrimmed(first?.email),
            websites: websites.join('\n'),
            vertical: readTrimmed(first?.vertical),
            profilePictureUrl: readTrimmed(first?.profile_picture_url)
        });
    };

    const fetchBusinessProfile = async () => {
        if (!sessionToken || !profileId) {
            setBusinessProfileForm({
                about: '',
                address: '',
                description: '',
                email: '',
                websites: '',
                vertical: '',
                profilePictureUrl: ''
            });
            setBusinessProfileError(null);
            setBusinessProfileNotice(null);
            setBusinessProfileLoading(false);
            return;
        }

        setBusinessProfileLoading(true);
        setBusinessProfileError(null);
        try {
            const params = new URLSearchParams();
            params.set('profileId', profileId);
            if (businessProfilePhoneNumberId.trim()) {
                params.set('phoneNumberId', businessProfilePhoneNumberId.trim());
            }
            params.set('fields', 'about,address,description,email,profile_picture_url,websites,vertical');

            const res = await fetch(`${SOCKET_URL}/api/waba/business-profile?${params.toString()}`, {
                headers: {
                    Authorization: `Bearer ${sessionToken}`
                }
            });
            const text = await res.text();
            let data: any = null;
            try {
                data = text ? JSON.parse(text) : null;
            } catch {
                data = null;
            }

            if (!res.ok || !data?.success) {
                throw new Error(parseBusinessProfileError(data, 'Failed to load business profile.'));
            }

            applyBusinessProfilePayload(data?.data || {});
        } catch (error: any) {
            setBusinessProfileError(error?.message || 'Failed to load business profile.');
        } finally {
            setBusinessProfileLoading(false);
        }
    };

    const handleSaveBusinessProfile = async () => {
        if (!sessionToken || !profileId) return;
        setBusinessProfileSaving(true);
        setBusinessProfileError(null);
        setBusinessProfileNotice(null);
        try {
            const websites = businessProfileForm.websites
                .split(/[\n,;]+/)
                .map((item) => readTrimmed(item))
                .filter(Boolean);
            const payload: any = {};

            const about = readTrimmed(businessProfileForm.about);
            const address = readTrimmed(businessProfileForm.address);
            const description = readTrimmed(businessProfileForm.description);
            const email = readTrimmed(businessProfileForm.email);
            const vertical = readTrimmed(businessProfileForm.vertical).toUpperCase();

            if (about) payload.about = about;
            if (address) payload.address = address;
            if (description) payload.description = description;
            if (email) payload.email = email;
            if (vertical) payload.vertical = vertical;
            payload.websites = websites;

            const body: any = {
                profileId,
                ...payload
            };
            if (businessProfilePhoneNumberId.trim()) {
                body.phoneNumberId = businessProfilePhoneNumberId.trim();
            }

            const res = await fetch(`${SOCKET_URL}/api/waba/business-profile`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${sessionToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });
            const text = await res.text();
            let data: any = null;
            try {
                data = text ? JSON.parse(text) : null;
            } catch {
                data = null;
            }

            if (!res.ok || !data?.success) {
                throw new Error(parseBusinessProfileError(data, 'Failed to update business profile.'));
            }

            setBusinessProfileNotice('Business profile updated.');
            await fetchBusinessProfile();
        } catch (error: any) {
            setBusinessProfileError(error?.message || 'Failed to update business profile.');
        } finally {
            setBusinessProfileSaving(false);
        }
    };

    const uploadBusinessProfilePictureHandle = async (file: File): Promise<string> => {
        if (!sessionToken) {
            throw new Error('You must be logged in to upload profile picture.');
        }
        const params = new URLSearchParams();
        params.set('profileId', profileId);
        params.set('kind', 'image');
        const res = await fetch(`${SOCKET_URL}/api/waba/template-media/upload-handle?${params.toString()}`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${sessionToken}`,
                'Content-Type': 'application/octet-stream',
                'x-file-name': file.name || 'profile_picture',
                'x-file-type': file.type || 'application/octet-stream'
            },
            body: file
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) {
            throw new Error(data?.error || 'Failed to upload profile picture.');
        }
        const handle = readTrimmed(data?.data?.headerHandle);
        if (!handle) {
            throw new Error('Upload completed but profile picture handle was not returned.');
        }
        return handle;
    };

    const handleUploadBusinessProfilePicture = async (file: File | null) => {
        if (!file || !sessionToken || !profileId) return;
        if (!file.type || !file.type.toLowerCase().startsWith('image/')) {
            setBusinessProfileError('Please select an image file.');
            return;
        }
        const maxBytes = 10 * 1024 * 1024;
        if (file.size > maxBytes) {
            setBusinessProfileError('Profile picture must be 10MB or smaller.');
            return;
        }

        setBusinessProfileUploading(true);
        setBusinessProfileError(null);
        setBusinessProfileNotice(null);
        try {
            const profilePictureHandle = await uploadBusinessProfilePictureHandle(file);
            const body: any = {
                profileId,
                profile_picture_handle: profilePictureHandle
            };
            if (businessProfilePhoneNumberId.trim()) {
                body.phoneNumberId = businessProfilePhoneNumberId.trim();
            }

            const res = await fetch(`${SOCKET_URL}/api/waba/business-profile`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${sessionToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(parseBusinessProfileError(data, 'Failed to update profile picture.'));
            }

            setBusinessProfileNotice('Profile picture updated.');
            await fetchBusinessProfile();
        } catch (error: any) {
            setBusinessProfileError(error?.message || 'Failed to upload profile picture.');
        } finally {
            setBusinessProfileUploading(false);
            if (businessProfileFileInputRef.current) {
                businessProfileFileInputRef.current.value = '';
            }
        }
    };

    const parseCallSettingsError = (data: any, fallback: string): string => {
        const message = readTrimmed(data?.error) || fallback;
        const details = Array.isArray(data?.details)
            ? data.details.map((item: any) => readTrimmed(item)).filter(Boolean)
            : [];
        if (!details.length) return message;
        return `${message} (${details.join(', ')})`;
    };

    const normalizeCallStatus = (value: unknown): CallStatus => {
        const normalized = readTrimmed(value).toUpperCase();
        return normalized === 'ENABLED' ? 'ENABLED' : 'DISABLED';
    };

    const normalizeCallIconVisibility = (value: unknown): CallIconVisibility => {
        const normalized = readTrimmed(value).toUpperCase();
        return normalized === 'DISABLE_ALL' ? 'DISABLE_ALL' : 'DEFAULT';
    };

    const normalizeCallbackPermissionStatus = (value: unknown): CallbackPermissionStatus => {
        const normalized = readTrimmed(value).toUpperCase();
        return normalized === 'ENABLED' ? 'ENABLED' : 'DISABLED';
    };

    const parseRestrictedCountries = (value: unknown): string[] => {
        if (!Array.isArray(value)) return [];
        return value
            .map((item) => readTrimmed(item).toUpperCase())
            .filter(Boolean);
    };

    const applyCallSettingsPayload = (payload: any) => {
        const data = payload && typeof payload === 'object' ? payload : {};
        const calling = data?.calling && typeof data.calling === 'object' && !Array.isArray(data.calling)
            ? data.calling
            : {};
        const countries = parseRestrictedCountries(calling?.call_icons?.restrict_to_user_countries);

        setCallSettingsRaw(data);
        setCallSettingsForm({
            status: normalizeCallStatus(calling?.status),
            callIconVisibility: normalizeCallIconVisibility(calling?.call_icon_visibility),
            callbackPermissionStatus: normalizeCallbackPermissionStatus(calling?.callback_permission_status),
            restrictToUserCountries: countries.join(', ')
        });
    };

    const fetchCallSettings = async () => {
        if (!sessionToken || !profileId) {
            setCallSettingsRaw(null);
            setCallSettingsForm({
                status: 'DISABLED',
                callIconVisibility: 'DEFAULT',
                callbackPermissionStatus: 'DISABLED',
                restrictToUserCountries: ''
            });
            setCallSettingsError(null);
            setCallSettingsNotice(null);
            setCallSettingsLoading(false);
            return;
        }

        setCallSettingsLoading(true);
        setCallSettingsError(null);
        try {
            const params = new URLSearchParams();
            params.set('profileId', profileId);
            if (callSettingsPhoneNumberId.trim()) {
                params.set('phoneNumberId', callSettingsPhoneNumberId.trim());
            }
            if (includeSipCredentials) {
                params.set('include_sip_credentials', 'true');
            }

            const res = await fetch(`${SOCKET_URL}/api/waba/call-settings?${params.toString()}`, {
                headers: {
                    Authorization: `Bearer ${sessionToken}`
                }
            });
            const text = await res.text();
            let data: any = null;
            try {
                data = text ? JSON.parse(text) : null;
            } catch {
                data = null;
            }
            if (!res.ok || !data?.success) {
                throw new Error(parseCallSettingsError(data, 'Failed to load call settings.'));
            }

            applyCallSettingsPayload(data?.data || {});
        } catch (error: any) {
            setCallSettingsError(error?.message || 'Failed to load call settings.');
            setCallSettingsRaw(null);
        } finally {
            setCallSettingsLoading(false);
        }
    };

    const handleSaveCallSettings = async () => {
        if (!sessionToken || !profileId) return;
        setCallSettingsSaving(true);
        setCallSettingsError(null);
        setCallSettingsNotice(null);
        try {
            const countries = callSettingsForm.restrictToUserCountries
                .split(/[\n,;\s]+/)
                .map((item) => readTrimmed(item).toUpperCase())
                .filter(Boolean);
            const existingCalling = callSettingsRaw?.calling && typeof callSettingsRaw.calling === 'object' && !Array.isArray(callSettingsRaw.calling)
                ? callSettingsRaw.calling
                : {};
            const existingCallIcons = existingCalling?.call_icons && typeof existingCalling.call_icons === 'object' && !Array.isArray(existingCalling.call_icons)
                ? existingCalling.call_icons
                : {};

            const payload = {
                ...existingCalling,
                status: callSettingsForm.status,
                call_icon_visibility: callSettingsForm.callIconVisibility,
                callback_permission_status: callSettingsForm.callbackPermissionStatus,
                call_icons: {
                    ...existingCallIcons,
                    restrict_to_user_countries: countries
                }
            };

            const body: any = {
                profileId,
                calling: payload
            };
            if (callSettingsPhoneNumberId.trim()) {
                body.phoneNumberId = callSettingsPhoneNumberId.trim();
            }

            const res = await fetch(`${SOCKET_URL}/api/waba/call-settings`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${sessionToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });
            const text = await res.text();
            let data: any = null;
            try {
                data = text ? JSON.parse(text) : null;
            } catch {
                data = null;
            }
            if (!res.ok || !data?.success) {
                throw new Error(parseCallSettingsError(data, 'Failed to save call settings.'));
            }

            setCallSettingsNotice('Call settings updated.');
            await fetchCallSettings();
        } catch (error: any) {
            setCallSettingsError(error?.message || 'Failed to save call settings.');
        } finally {
            setCallSettingsSaving(false);
        }
    };

    const fetchClientConnections = () => {
        if (!sessionToken) {
            setClientConnections([]);
            return;
        }
        setClientLoading(true);
        setClientError(null);
        fetch(`${SOCKET_URL}/api/waba/clients`, {
            headers: { Authorization: `Bearer ${sessionToken}` }
        })
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    console.error('Client connections fetch failed:', text);
                    return null;
                }
            })
            .then(data => {
                if (data?.success) {
                    setClientConnections(Array.isArray(data.data) ? data.data : []);
                    setClientError(null);
                } else {
                    setClientConnections([]);
                    setClientError(data?.error || 'Failed to load connected clients');
                }
            })
            .finally(() => setClientLoading(false));
    };

    const handleDisconnectClient = async (targetProfileId: string, revoke = false) => {
        if (!sessionToken) {
            setClientError('You must be logged in.');
            return;
        }
        if (!confirm(`Disconnect this client${revoke ? ' and revoke webhook subscription' : ''}?`)) return;
        setClientLoading(true);
        setClientError(null);
        try {
            const res = await fetch(`${SOCKET_URL}/api/waba/clients/disconnect`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${sessionToken}`
                },
                body: JSON.stringify({ profileId: targetProfileId, revoke })
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to disconnect client');
            }
            fetchClientConnections();
        } catch (err: any) {
            setClientError(err?.message || 'Failed to disconnect client');
        } finally {
            setClientLoading(false);
        }
    };

    const formatTokenExpiry = (value?: string) => {
        if (!value) return '—';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        return date.toLocaleString();
    };

    const fetchWebhooks = () => {
        if (!sessionToken || !profileId) {
            setWebhooks([]);
            setWebhookLoading(false);
            setWebhooksLoaded(false);
            return;
        }
        setWebhookLoading(true);
        setWebhookError(null);
        fetch(`${SOCKET_URL}/addon/admin/webhooks?profileId=${profileId}`, {
            headers: {
                Authorization: `Bearer ${sessionToken}`
            }
        })
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    console.error('Webhook fetch failed:', text);
                    return null;
                }
            })
            .then(data => {
                if (data?.success) {
                    setWebhooks(data.data || []);
                    return;
                }
                setWebhooks([]);
                setWebhookError(data?.error || 'Failed to load webhooks');
            })
            .catch(error => {
                setWebhooks([]);
                setWebhookError(error?.message || 'Failed to load webhooks');
            })
            .finally(() => {
                setWebhookLoading(false);
                setWebhooksLoaded(true);
            });
    };

    const handleAddWebhook = () => {
        if (!sessionToken || !newUrl) return;
        setLoading(true);
        setWebhookError(null);
        fetch(`${SOCKET_URL}/addon/admin/webhooks`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${sessionToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                profileId,
                url: newUrl,
                events: newEvents
            })
        })
            .then(async res => {
                const text = await res.text();
                let parsed: any = null;
                try {
                    parsed = JSON.parse(text);
                } catch {
                    console.error('Add webhook failed:', text);
                    throw new Error('Failed to save webhook');
                }

                if (!res.ok || !parsed?.success) {
                    throw new Error(parsed?.error || 'Failed to save webhook');
                }

                return parsed;
            })
            .then(() => {
                setLoading(false);
                setNewUrl('');
                fetchWebhooks();
            })
            .catch((error: any) => {
                setLoading(false);
                setWebhookError(error?.message || 'Failed to save webhook');
            });
    };

    const handleDeleteWebhook = (url: string) => {
        if (!sessionToken) return;
        if (!confirm('Delete webhook?')) return;
        setWebhookError(null);
        fetch(`${SOCKET_URL}/addon/admin/webhooks`, {
            method: 'DELETE',
            headers: {
                Authorization: `Bearer ${sessionToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                profileId,
                url
            })
        })
            .then(async res => {
                const text = await res.text();
                let parsed: any = null;
                try {
                    parsed = JSON.parse(text);
                } catch {
                    console.error('Delete webhook failed:', text);
                    throw new Error('Failed to delete webhook');
                }

                if (!res.ok || !parsed?.success) {
                    throw new Error(parsed?.error || 'Failed to delete webhook');
                }

                return parsed;
            })
            .then(() => fetchWebhooks())
            .catch((error: any) => {
                setWebhookError(error?.message || 'Failed to delete webhook');
            });
    };

    const fetchAutomation = () => {
        if (!sessionToken || !profileId) return;
        setAutoLoading(true);
        setAutoError(null);
        fetch(`${SOCKET_URL}/api/waba/conversational-automation?profileId=${profileId}`, {
            headers: {
                Authorization: `Bearer ${sessionToken}`
            }
        })
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    console.error('Conversational automation fetch failed:', text);
                    return null;
                }
            })
            .then(data => {
                const ca = data?.data?.conversational_automation || {};
                setAutoConfig({
                    enable_welcome_message: Boolean(ca.enable_welcome_message),
                    prompts: Array.isArray(ca.prompts) ? ca.prompts : [],
                    commands: sanitizeCommandInput(ca.commands)
                });
            })
            .finally(() => setAutoLoading(false));
    };

    const fetchWindowReminder = () => {
        if (!sessionToken || !profileId) return;
        setReminderLoading(true);
        fetch(`${SOCKET_URL}/api/waba/window-reminder?profileId=${profileId}`, {
            headers: {
                Authorization: `Bearer ${sessionToken}`
            }
        })
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    console.error('Window reminder fetch failed:', text);
                    return null;
                }
            })
            .then(data => {
                const config = data?.data || {};
                setReminderConfig({
                    enabled: Boolean(config.window_reminder_enabled),
                    minutes: typeof config.window_reminder_minutes === 'number' ? config.window_reminder_minutes : '',
                    text: typeof config.window_reminder_text === 'string' ? config.window_reminder_text : ''
                });
            })
            .finally(() => setReminderLoading(false));
    };

    const handleSaveAutomation = () => {
        if (!sessionToken) return;
        setAutoError(null);
        const validatedCommands = validateCommandsForSave(autoConfig.commands || []);
        if (validatedCommands.error) {
            setAutoError(validatedCommands.error);
            return;
        }

        const prompts = (autoConfig.prompts || []).map(p => p.trim()).filter(Boolean);
        const commands = validatedCommands.commands;

        setAutoConfig(prev => ({
            ...prev,
            prompts,
            commands
        }));
        setAutoSaving(true);
        const payload = {
            enable_welcome_message: autoConfig.enable_welcome_message,
            prompts,
            commands,
            profileId
        };
        fetch(`${SOCKET_URL}/api/waba/conversational-automation`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${sessionToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        })
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    console.error('Conversational automation save failed:', text);
                    return null;
                }
            })
            .then(data => {
                if (data?.success) {
                    setAutoError(null);
                    alert('Conversational components saved.');
                } else {
                    setAutoError(data?.error || 'Failed to save conversational components');
                    alert(data?.error || 'Failed to save conversational components');
                }
            })
            .finally(() => setAutoSaving(false));
    };

    const handleSaveReminder = () => {
        if (!sessionToken) return;
        setReminderSaving(true);
        const payload = {
            enabled: reminderConfig.enabled,
            minutes: reminderConfig.minutes === '' ? null : Number(reminderConfig.minutes),
            text: reminderConfig.text
        };
        fetch(`${SOCKET_URL}/api/waba/window-reminder`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${sessionToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                profileId,
                ...payload
            })
        })
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    console.error('Window reminder save failed:', text);
                    return null;
                }
            })
            .then(data => {
                if (data?.success) {
                    alert('Window reminder settings saved.');
                } else {
                    alert(data?.error || 'Failed to save window reminder settings');
                }
            })
            .finally(() => setReminderSaving(false));
    };

    const formatConnectedDate = (value?: string) => {
        if (!value) return '--';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        return date.toLocaleString();
    };

    const statusBadgeClass = (value?: string) => {
        const normalized = (value || '').toUpperCase();
        if (normalized === 'ACTIVE' || normalized === 'VERIFIED') {
            return 'bg-emerald-50 text-emerald-700 border-emerald-200';
        }
        if (normalized === 'PENDING' || normalized === 'PENDING_APPROVAL') {
            return 'bg-amber-50 text-amber-700 border-amber-200';
        }
        if (normalized === 'SUSPENDED' || normalized === 'REJECTED') {
            return 'bg-rose-50 text-rose-600 border-rose-200';
        }
        return 'bg-[#f0f2f5] text-[#54656f] border-[#eceff1]';
    };

    const fetchConnectedBusinesses = (opts: { after?: string; before?: string } = {}) => {
        if (!sessionToken || !profileId) return;
        setConnectedLoading(true);
        setConnectedError(null);

        const params = new URLSearchParams();
        params.set('profileId', profileId);
        params.set('fields', 'id,name,verification_status,business_status,created_time,updated_time');
        params.set('limit', '50');
        if (connectedAppId.trim()) params.set('appId', connectedAppId.trim());
        if (opts.after) params.set('after', opts.after);
        if (opts.before) params.set('before', opts.before);

        fetch(`${SOCKET_URL}/api/waba/connected-client-businesses?${params.toString()}`, {
            headers: {
                Authorization: `Bearer ${sessionToken}`
            }
        })
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    console.error('Connected businesses fetch failed:', text);
                    return null;
                }
            })
            .then(data => {
                if (data?.success) {
                    const payload = data?.data || {};
                    setConnectedBusinesses(Array.isArray(payload.data) ? payload.data : []);
                    setConnectedPaging(payload.paging || null);
                    setConnectedError(null);
                } else {
                    setConnectedBusinesses([]);
                    setConnectedPaging(null);
                    setConnectedError(data?.error || 'Failed to load connected businesses');
                }
            })
            .finally(() => setConnectedLoading(false));
    };

    const fetchTeamUsers = async () => {
        if (!sessionToken) return;
        setTeamLoading(true);
        setTeamError(null);
        try {
            const res = await fetch(`${SOCKET_URL}/api/company/team-users`, {
                headers: {
                    Authorization: `Bearer ${sessionToken}`
                }
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to load team users');
            }
            const users = Array.isArray(data?.data?.users) ? data.data.users : [];
            setTeamUsers(users.map((item: any) => ({
                ...item,
                department: normalizeTeamDepartment(item?.department),
                customDepartment: typeof item?.customDepartment === 'string' ? item.customDepartment : null
            })));
            setTeamCurrentRole((data?.data?.currentUserRole || 'agent') as TeamRole);
            setTeamCurrentUserId(data?.data?.currentUserId || null);
        } catch (err: any) {
            setTeamError(err?.message || 'Failed to load team users');
            setTeamUsers([]);
        } finally {
            setTeamLoading(false);
        }
    };

    const canManageTeam = teamCurrentRole === 'owner' || teamCurrentRole === 'admin';
    const callRestrictions = Array.isArray(callSettingsRaw?.calling?.restrictions?.restrictions_list)
        ? callSettingsRaw.calling.restrictions.restrictions_list
        : [];

    const handleInviteTeamUser = async () => {
        if (!sessionToken) return;
        setInviteLoading(true);
        setInviteError(null);
        setInviteSuccess(null);
        try {
            const email = inviteEmail.trim().toLowerCase();
            const password = invitePassword;
            const customDepartment = inviteDepartment === 'custom' ? inviteCustomDepartment.trim() : '';
            if (!email) throw new Error('Email is required');
            if (password.length < 8) throw new Error('Password must be at least 8 characters');
            if (inviteDepartment === 'custom' && !customDepartment) throw new Error('Custom department label is required');

            const res = await fetch(`${SOCKET_URL}/api/company/team-users/invite`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${sessionToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    email,
                    password,
                    role: inviteRole,
                    department: inviteDepartment,
                    customDepartment: inviteDepartment === 'custom' ? customDepartment : null
                })
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to invite user');
            }
            setInviteSuccess(`User created for ${email}`);
            setInviteEmail('');
            setInvitePassword('');
            setInviteDepartment('sales');
            setInviteCustomDepartment('');
            await fetchTeamUsers();
        } catch (err: any) {
            setInviteError(err?.message || 'Failed to invite user');
        } finally {
            setInviteLoading(false);
        }
    };

    const handleUpdateTeamRole = async (userId: string, role: TeamRole) => {
        if (!sessionToken) return;
        setRoleSavingUserId(userId);
        setTeamError(null);
        try {
            const res = await fetch(`${SOCKET_URL}/api/company/team-users/${encodeURIComponent(userId)}/role`, {
                method: 'PATCH',
                headers: {
                    Authorization: `Bearer ${sessionToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ role })
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to update role');
            }
            await fetchTeamUsers();
        } catch (err: any) {
            setTeamError(err?.message || 'Failed to update role');
        } finally {
            setRoleSavingUserId(null);
        }
    };

    const handleUpdateTeamDepartment = async (
        userId: string,
        department: TeamDepartment,
        customDepartment?: string | null
    ) => {
        if (!sessionToken) return;
        setDepartmentSavingUserId(userId);
        setTeamError(null);
        try {
            const payload = {
                department,
                customDepartment: department === 'custom' ? (customDepartment || '').trim() : null
            };
            if (department === 'custom' && !payload.customDepartment) {
                throw new Error('Custom department label is required');
            }
            const res = await fetch(`${SOCKET_URL}/api/company/team-users/${encodeURIComponent(userId)}/department`, {
                method: 'PATCH',
                headers: {
                    Authorization: `Bearer ${sessionToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to update department');
            }
            await fetchTeamUsers();
        } catch (err: any) {
            setTeamError(err?.message || 'Failed to update department');
        } finally {
            setDepartmentSavingUserId(null);
        }
    };

    const handleChangeOwnPassword = async () => {
        setSelfPasswordError(null);
        setSelfPasswordSuccess(null);
        if (selfPassword.length < 8) {
            setSelfPasswordError('New password must be at least 8 characters.');
            return;
        }
        if (selfPassword !== selfPasswordConfirm) {
            setSelfPasswordError('Password confirmation does not match.');
            return;
        }

        setSelfPasswordSaving(true);
        try {
            const { error } = await supabase.auth.updateUser({ password: selfPassword });
            if (error) throw error;
            setSelfPassword('');
            setSelfPasswordConfirm('');
            setSelfPasswordSuccess('Password updated successfully.');
        } catch (err: any) {
            setSelfPasswordError(err?.message || 'Failed to update password.');
        } finally {
            setSelfPasswordSaving(false);
        }
    };

    return (
        <div className="flex-1 bg-[#fcfdfd] p-10 overflow-y-auto text-[#111b21] h-full font-sans">
            <h2 className="text-3xl font-black mb-10 flex items-center gap-4 tracking-tight">
                <Globe className="text-[#00a884] w-8 h-8" /> API & Connectivity
                <span className="text-xs bg-[#f0f2f5] px-4 py-1.5 rounded-full text-[#54656f] font-bold border border-[#eceff1] uppercase tracking-widest">Active profile: {profileId}</span>
            </h2>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
                {/* Embedded Signup Section */}
                <div id="settings-connect" className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
                    <div className="flex items-center gap-3 mb-4">
                        <Shield className="w-6 h-6 text-[#00a884]" />
                        <h3 className="text-xl text-[#111b21] font-bold">Connect WhatsApp Business</h3>
                    </div>
                    <p className="text-sm text-[#54656f] mb-6 font-medium">
                        Link a client’s WhatsApp Business account using Meta Embedded Signup. You’ll be redirected to Facebook Login.
                    </p>
                    <button
                        onClick={handleConnectWhatsapp}
                        disabled={connectLoading || !sessionToken}
                        className="w-full bg-[#111b21] hover:bg-[#202c33] text-white font-black py-4 rounded-2xl transition-all flex items-center justify-center gap-3 shadow-[0_8px_20px_rgba(17,27,33,0.18)] disabled:opacity-50 active:scale-95"
                    >
                        {connectLoading ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Globe className="w-5 h-5" />}
                        Connect WhatsApp Business
                    </button>
                    {connectError && (
                        <p className="text-sm text-rose-600 mt-4 font-semibold">{connectError}</p>
                    )}
                    {!sessionToken && (
                        <p className="text-xs text-[#aebac1] mt-3">Login required to connect a client account.</p>
                    )}
                </div>

                {/* Manual Setup Section */}
                <div id="settings-manual" className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
                    <div className="flex items-center gap-3 mb-4">
                        <Shield className="w-6 h-6 text-[#00a884]" />
                        <h3 className="text-xl text-[#111b21] font-bold">Manual WABA Setup</h3>
                    </div>
                    <p className="text-sm text-[#54656f] mb-6 font-medium">
                        Self‑service fallback when Embedded Signup permissions are not available. Paste WABA IDs and token from Meta UI.
                    </p>
                    <div className="space-y-4">
                        <div>
                            <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">WABA ID</label>
                            <input
                                className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20 focus:border-[#00a884] text-[#111b21] font-bold placeholder-[#aebac1]"
                                placeholder="WhatsApp Business Account ID"
                                value={manualConfig.wabaId}
                                onChange={e => setManualConfig(prev => ({ ...prev, wabaId: e.target.value }))}
                            />
                        </div>
                        <div>
                            <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Phone Number ID</label>
                            <input
                                className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20 focus:border-[#00a884] text-[#111b21] font-bold placeholder-[#aebac1]"
                                placeholder="Business phone number ID"
                                value={manualConfig.phoneNumberId}
                                onChange={e => setManualConfig(prev => ({ ...prev, phoneNumberId: e.target.value }))}
                            />
                        </div>
                        <div>
                            <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Access Token</label>
                            <textarea
                                className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-4 text-xs focus:outline-none focus:ring-2 focus:ring-[#00a884]/20 focus:border-[#00a884] text-[#111b21] font-mono placeholder-[#aebac1] min-h-[120px]"
                                placeholder="System user access token"
                                value={manualConfig.accessToken}
                                onChange={e => setManualConfig(prev => ({ ...prev, accessToken: e.target.value }))}
                            />
                        </div>
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                            <div>
                                <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Business ID (optional)</label>
                                <input
                                    className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20 focus:border-[#00a884] text-[#111b21] font-bold placeholder-[#aebac1]"
                                    placeholder="Meta business ID"
                                    value={manualConfig.businessId}
                                    onChange={e => setManualConfig(prev => ({ ...prev, businessId: e.target.value }))}
                                />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Verify Token (optional)</label>
                                <input
                                    className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20 focus:border-[#00a884] text-[#111b21] font-bold placeholder-[#aebac1]"
                                    placeholder="Webhook verify token"
                                    value={manualConfig.verifyToken}
                                    onChange={e => setManualConfig(prev => ({ ...prev, verifyToken: e.target.value }))}
                                />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">App ID (optional)</label>
                                <input
                                    className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20 focus:border-[#00a884] text-[#111b21] font-bold placeholder-[#aebac1]"
                                    placeholder="Meta App ID"
                                    value={manualConfig.appId}
                                    onChange={e => setManualConfig(prev => ({ ...prev, appId: e.target.value }))}
                                />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">App Secret (optional)</label>
                                <input
                                    className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20 focus:border-[#00a884] text-[#111b21] font-bold placeholder-[#aebac1]"
                                    placeholder="Meta App Secret"
                                    value={manualConfig.appSecret}
                                    onChange={e => setManualConfig(prev => ({ ...prev, appSecret: e.target.value }))}
                                />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">API Version (optional)</label>
                                <input
                                    className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20 focus:border-[#00a884] text-[#111b21] font-bold placeholder-[#aebac1]"
                                    placeholder="v19.0"
                                    value={manualConfig.apiVersion}
                                    onChange={e => setManualConfig(prev => ({ ...prev, apiVersion: e.target.value }))}
                                />
                            </div>
                        </div>
                        <button
                            onClick={handleManualConfigSave}
                            disabled={manualLoading || !sessionToken}
                            className="w-full bg-[#111b21] hover:bg-[#202c33] text-white font-black py-4 rounded-2xl transition-all flex items-center justify-center gap-3 shadow-[0_8px_20px_rgba(17,27,33,0.18)] disabled:opacity-50 active:scale-95"
                        >
                            {manualLoading ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> : 'Save Manual Config'}
                        </button>
                        {manualError && <p className="text-sm text-rose-600 font-semibold">{manualError}</p>}
                        {manualSuccess && <p className="text-sm text-emerald-600 font-semibold">{manualSuccess}</p>}
                    </div>
                </div>

                {/* Number Registration Section */}
                <div id="settings-register" className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
                    <div className="flex items-center gap-3 mb-4">
                        <Shield className="w-6 h-6 text-[#00a884]" />
                        <h3 className="text-xl text-[#111b21] font-bold">Register WhatsApp Number</h3>
                    </div>
                    <p className="text-sm text-[#54656f] mb-6 font-medium">
                        Complete verification and registration in one guided flow. Display name changes must be handled in Meta Business Manager.
                    </p>
                    <button
                        onClick={openRegistrationWizard}
                        disabled={!sessionToken}
                        className="w-full bg-[#111b21] hover:bg-[#202c33] text-white font-black py-4 rounded-2xl transition-all flex items-center justify-center gap-3 shadow-[0_8px_20px_rgba(17,27,33,0.18)] disabled:opacity-50 active:scale-95"
                    >
                        Launch Guided Setup
                    </button>
                    {(registrationError || registrationNumbersError) && (
                        <p className="text-sm text-rose-600 mt-4 font-semibold">
                            {registrationError || registrationNumbersError}
                        </p>
                    )}
                </div>

                {/* Webhooks Section */}
                <div id="settings-webhooks" className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
                    <h3 className="text-xl mb-2 text-[#111b21] font-bold">Outgoing Webhooks</h3>
                    <p className="text-sm text-[#54656f] mb-2 font-medium">Configure endpoints to receive real-time updates from this profile.</p>
                    <p className="text-xs text-[#8696a0] mb-6 font-semibold">Active profile: {profileId}</p>
                    {webhookError && (
                        <div className="mb-6 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 font-semibold">
                            {webhookError}
                        </div>
                    )}

                    <div className="space-y-4 mb-8">
                        {(webhookLoading || !webhooksLoaded) && (
                            <div className="animate-pulse space-y-3">
                                <div className="h-16 rounded-2xl bg-[#eef2f5]" />
                                <div className="h-16 rounded-2xl bg-[#eef2f5]" />
                                <div className="h-16 rounded-2xl bg-[#eef2f5]" />
                            </div>
                        )}
                        {!webhookLoading && webhooksLoaded && webhooks.length === 0 && (
                            <div className="bg-[#f8f9fa] border-2 border-dashed border-[#eceff1] p-10 rounded-2xl text-center">
                                <p className="text-sm text-[#aebac1] font-bold uppercase tracking-widest italic">No endpoints configured</p>
                            </div>
                        )}
                        {!webhookLoading && webhooksLoaded && webhooks.map((hook, i) => (
                            <div key={i} className="bg-[#fcfdfd] p-5 rounded-2xl flex items-start justify-between border border-[#eceff1] group hover:border-[#00a884]/30 transition-all">
                                <div className="min-w-0 pr-4">
                                    <div className="font-mono text-sm break-all mb-2 text-[#111b21] font-bold leading-relaxed">{hook.url}</div>
                                    <div className="flex gap-2 flex-wrap">
                                        {hook.events.map((e: string) => (
                                            <span key={e} className="text-[10px] bg-[#f0f2f5] px-3 py-1 rounded-full text-[#54656f] font-bold uppercase tracking-tight border border-[#eceff1]">{e}</span>
                                        ))}
                                    </div>
                                </div>
                                <button onClick={() => handleDeleteWebhook(hook.url)} className="p-2 text-[#aebac1] hover:text-rose-500 hover:bg-rose-50 rounded-xl transition-all h-fit">
                                    <Trash2 className="w-5 h-5" />
                                </button>
                            </div>
                        ))}
                    </div>

                    <div className="border-t border-[#eceff1] pt-8 space-y-4">
                        <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Endpoint URL</label>
                        <input
                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20 focus:border-[#00a884] text-[#111b21] font-bold placeholder-[#aebac1]"
                            placeholder="https://your-api.com/v1/webhook"
                            value={newUrl}
                            onChange={e => setNewUrl(e.target.value)}
                        />
                        <div className="flex flex-col gap-3 py-2">
                            <span className="text-[11px] font-bold text-[#54656f] uppercase tracking-widest">Select Events</span>
                            <div className="flex gap-3 flex-wrap">
                                {['message_received', 'message_sent', 'session_opened'].map(evt => (
                                    <label key={evt} className={`flex items-center gap-3 cursor-pointer px-4 py-2.5 rounded-xl border-2 transition-all font-bold text-xs uppercase tracking-tighter ${newEvents.includes(evt) ? 'bg-[#00a884]/5 border-[#00a884] text-[#00a884]' : 'bg-white border-[#eceff1] text-[#54656f] hover:border-[#aebac1]'}`}>
                                        <input
                                            type="checkbox"
                                            checked={newEvents.includes(evt)}
                                            onChange={e => {
                                                if (e.target.checked) setNewEvents([...newEvents, evt]);
                                                else setNewEvents(newEvents.filter(x => x !== evt));
                                            }}
                                            className="hidden"
                                        />
                                        {evt.replace('_', ' ')}
                                    </label>
                                ))}
                            </div>
                        </div>
                        <button
                            onClick={handleAddWebhook}
                            disabled={loading || webhookLoading || !newUrl}
                            className="w-full bg-[#00a884] hover:bg-[#008f6f] text-white font-black py-4 rounded-2xl transition-all flex items-center justify-center gap-3 shadow-[0_8px_20px_rgba(0,168,132,0.2)] disabled:opacity-50 active:scale-95"
                        >
                            {loading ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Plus className="w-5 h-5" />}
                            Register Webhook
                        </button>
                    </div>
                </div>

                {showCallSettings && (
                <div id="settings-calls" className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
                    <div className="flex items-center justify-between gap-3 mb-5">
                        <div className="flex items-center gap-3">
                            <PhoneCall className="w-6 h-6 text-[#00a884]" />
                            <div>
                                <h3 className="text-xl text-[#111b21] font-bold">Call Settings</h3>
                                <p className="text-sm text-[#54656f] font-medium mt-1">
                                    Configure WhatsApp Calling API behavior for this profile.
                                </p>
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={fetchCallSettings}
                            disabled={callSettingsLoading || callSettingsSaving || !sessionToken}
                            className="text-xs font-bold uppercase tracking-widest text-[#00a884] border border-[#00a884]/30 px-3 py-2 rounded-xl hover:bg-[#00a884]/5 transition-all disabled:opacity-50"
                        >
                            Refresh
                        </button>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        <div className="lg:col-span-2">
                            <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Phone Number ID (optional)</label>
                            <input
                                className="mt-3 w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20 focus:border-[#00a884] text-[#111b21] font-bold placeholder-[#aebac1]"
                                placeholder="Leave empty to use phoneNumberId from profile config"
                                value={callSettingsPhoneNumberId}
                                onChange={e => setCallSettingsPhoneNumberId(e.target.value)}
                                disabled={callSettingsSaving}
                            />
                        </div>

                        <div>
                            <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Calling Status</label>
                            <select
                                className="mt-3 w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-4 py-3 text-sm font-bold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                value={callSettingsForm.status}
                                onChange={e => setCallSettingsForm(prev => ({ ...prev, status: (e.target.value as CallStatus) || 'DISABLED' }))}
                                disabled={callSettingsLoading || callSettingsSaving}
                            >
                                <option value="ENABLED">ENABLED</option>
                                <option value="DISABLED">DISABLED</option>
                            </select>
                        </div>

                        <div>
                            <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Call Icon Visibility</label>
                            <select
                                className="mt-3 w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-4 py-3 text-sm font-bold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                value={callSettingsForm.callIconVisibility}
                                onChange={e => setCallSettingsForm(prev => ({ ...prev, callIconVisibility: (e.target.value as CallIconVisibility) || 'DEFAULT' }))}
                                disabled={callSettingsLoading || callSettingsSaving}
                            >
                                <option value="DEFAULT">DEFAULT</option>
                                <option value="DISABLE_ALL">DISABLE_ALL</option>
                            </select>
                        </div>

                        <div>
                            <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Callback Permission</label>
                            <select
                                className="mt-3 w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-4 py-3 text-sm font-bold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                value={callSettingsForm.callbackPermissionStatus}
                                onChange={e => setCallSettingsForm(prev => ({ ...prev, callbackPermissionStatus: (e.target.value as CallbackPermissionStatus) || 'DISABLED' }))}
                                disabled={callSettingsLoading || callSettingsSaving}
                            >
                                <option value="ENABLED">ENABLED</option>
                                <option value="DISABLED">DISABLED</option>
                            </select>
                        </div>

                        <div>
                            <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Restrict Call Icons To Countries</label>
                            <input
                                className="mt-3 w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20 focus:border-[#00a884] text-[#111b21] font-bold placeholder-[#aebac1]"
                                placeholder="US, BR"
                                value={callSettingsForm.restrictToUserCountries}
                                onChange={e => setCallSettingsForm(prev => ({ ...prev, restrictToUserCountries: e.target.value }))}
                                disabled={callSettingsLoading || callSettingsSaving}
                            />
                        </div>
                    </div>

                    <div className="mt-4 flex items-center gap-3">
                        <label className="inline-flex items-center gap-2 text-xs font-bold text-[#54656f] uppercase tracking-widest cursor-pointer">
                            <input
                                type="checkbox"
                                checked={includeSipCredentials}
                                onChange={e => setIncludeSipCredentials(e.target.checked)}
                                disabled={callSettingsLoading || callSettingsSaving}
                                className="w-4 h-4 accent-[#00a884]"
                            />
                            Include SIP Credentials On Refresh
                        </label>
                    </div>

                    <p className="mt-3 text-[11px] text-[#8696a0] leading-relaxed">
                        Save sends the <code className="font-mono">calling</code> object and preserves existing unknown fields from the latest fetch.
                    </p>

                    {callRestrictions.length > 0 && (
                        <div className="mt-4 bg-amber-50 border border-amber-200 rounded-2xl p-4">
                            <p className="text-xs font-bold uppercase tracking-widest text-amber-700 mb-2">Current Restrictions</p>
                            <div className="space-y-2">
                                {callRestrictions.map((item: any, index: number) => (
                                    <div key={`${item?.type || 'restriction'}-${index}`} className="text-xs text-amber-800">
                                        <span className="font-bold">{readTrimmed(item?.type) || 'Restriction'}:</span> {readTrimmed(item?.reason) || 'No reason provided'}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {callSettingsError && (
                        <div className="mt-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-2xl px-4 py-3 text-sm font-medium">
                            {callSettingsError}
                        </div>
                    )}
                    {callSettingsNotice && (
                        <div className="mt-4 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-2xl px-4 py-3 text-sm font-medium">
                            {callSettingsNotice}
                        </div>
                    )}

                    <div className="mt-5 flex items-center gap-3">
                        <button
                            type="button"
                            onClick={handleSaveCallSettings}
                            disabled={!sessionToken || callSettingsLoading || callSettingsSaving}
                            className="bg-[#111b21] hover:bg-[#202c33] text-white px-5 py-3 rounded-2xl font-bold transition-all disabled:opacity-50"
                        >
                            {callSettingsSaving ? 'Saving...' : 'Save Call Settings'}
                        </button>
                        {callSettingsLoading && (
                            <span className="text-xs text-[#8696a0] font-semibold uppercase tracking-widest">Loading current settings...</span>
                        )}
                    </div>
                </div>
                )}

                <div id="settings-business-profile" className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
                    <div className="flex items-center justify-between gap-3 mb-5">
                        <div>
                            <h3 className="text-xl text-[#111b21] font-bold">Business Profile</h3>
                            <p className="text-sm text-[#54656f] font-medium mt-1">
                                Edit your WhatsApp business status/about, address, description, email, websites and category.
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={fetchBusinessProfile}
                            disabled={businessProfileLoading || businessProfileSaving || businessProfileUploading || !sessionToken}
                            className="text-xs font-bold uppercase tracking-widest text-[#00a884] border border-[#00a884]/30 px-3 py-2 rounded-xl hover:bg-[#00a884]/5 transition-all disabled:opacity-50"
                        >
                            Refresh
                        </button>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        <div className="lg:col-span-2">
                            <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Phone Number ID (optional)</label>
                            <input
                                className="mt-3 w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20 focus:border-[#00a884] text-[#111b21] font-bold placeholder-[#aebac1]"
                                placeholder="Leave empty to use phoneNumberId from profile config"
                                value={businessProfilePhoneNumberId}
                                onChange={e => setBusinessProfilePhoneNumberId(e.target.value)}
                                disabled={businessProfileSaving || businessProfileUploading}
                            />
                        </div>

                        <div>
                            <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Status / About</label>
                            <input
                                className="mt-3 w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-4 py-3 text-sm font-medium text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                placeholder="Available now"
                                value={businessProfileForm.about}
                                onChange={e => setBusinessProfileForm(prev => ({ ...prev, about: e.target.value }))}
                                disabled={businessProfileLoading || businessProfileSaving || businessProfileUploading}
                            />
                        </div>

                        <div>
                            <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Email</label>
                            <input
                                className="mt-3 w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-4 py-3 text-sm font-medium text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                placeholder="support@company.com"
                                value={businessProfileForm.email}
                                onChange={e => setBusinessProfileForm(prev => ({ ...prev, email: e.target.value }))}
                                disabled={businessProfileLoading || businessProfileSaving || businessProfileUploading}
                            />
                        </div>

                        <div className="lg:col-span-2">
                            <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Address</label>
                            <input
                                className="mt-3 w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-4 py-3 text-sm font-medium text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                placeholder="1 Hacker Way, Menlo Park, CA"
                                value={businessProfileForm.address}
                                onChange={e => setBusinessProfileForm(prev => ({ ...prev, address: e.target.value }))}
                                disabled={businessProfileLoading || businessProfileSaving || businessProfileUploading}
                            />
                        </div>

                        <div className="lg:col-span-2">
                            <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Description</label>
                            <textarea
                                className="mt-3 w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-4 py-3 text-sm font-medium text-[#111b21] focus:outline-none focus:border-[#00a884] min-h-[96px]"
                                placeholder="Tell customers about your business."
                                value={businessProfileForm.description}
                                onChange={e => setBusinessProfileForm(prev => ({ ...prev, description: e.target.value }))}
                                disabled={businessProfileLoading || businessProfileSaving || businessProfileUploading}
                            />
                        </div>

                        <div>
                            <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Vertical</label>
                            <input
                                className="mt-3 w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-4 py-3 text-sm font-medium text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                placeholder="RETAIL"
                                value={businessProfileForm.vertical}
                                onChange={e => setBusinessProfileForm(prev => ({ ...prev, vertical: e.target.value.toUpperCase() }))}
                                disabled={businessProfileLoading || businessProfileSaving || businessProfileUploading}
                            />
                        </div>

                        <div className="lg:col-span-2">
                            <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Current Profile Picture</label>
                            <div className="mt-3 h-40 w-full rounded-2xl border border-[#eceff1] bg-[#f8f9fa] flex items-center justify-center overflow-hidden">
                                {businessProfileForm.profilePictureUrl ? (
                                    <img
                                        src={businessProfileForm.profilePictureUrl}
                                        alt="Current WhatsApp profile picture"
                                        className="h-full w-auto max-w-full object-contain"
                                        loading="lazy"
                                    />
                                ) : (
                                    <span className="text-[11px] font-bold uppercase tracking-widest text-[#8696a0]">No Profile Picture</span>
                                )}
                            </div>
                            <input
                                ref={businessProfileFileInputRef}
                                type="file"
                                accept="image/*"
                                className="hidden"
                                onChange={(event) => {
                                    const file = event.target.files?.[0] || null;
                                    void handleUploadBusinessProfilePicture(file);
                                }}
                            />
                            <div className="mt-3 flex items-center gap-3">
                                <button
                                    type="button"
                                    onClick={() => businessProfileFileInputRef.current?.click()}
                                    disabled={!sessionToken || businessProfileLoading || businessProfileSaving || businessProfileUploading}
                                    className="bg-[#00a884] hover:bg-[#008f6f] text-white px-4 py-2.5 rounded-xl font-bold transition-all disabled:opacity-50"
                                >
                                    {businessProfileUploading ? 'Uploading...' : 'Upload Picture'}
                                </button>
                                <span className="text-[11px] text-[#8696a0] font-medium">JPG/PNG/WebP, max 10MB</span>
                            </div>
                            <p className="mt-2 text-[11px] text-[#8696a0] break-all">
                                URL: <span className="font-mono">{businessProfileForm.profilePictureUrl || '—'}</span>
                            </p>
                        </div>

                        <div className="lg:col-span-2">
                            <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Websites (one per line)</label>
                            <textarea
                                className="mt-3 w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-4 py-3 text-sm font-medium text-[#111b21] focus:outline-none focus:border-[#00a884] min-h-[90px]"
                                placeholder="https://company.com"
                                value={businessProfileForm.websites}
                                onChange={e => setBusinessProfileForm(prev => ({ ...prev, websites: e.target.value }))}
                                disabled={businessProfileLoading || businessProfileSaving || businessProfileUploading}
                            />
                        </div>
                    </div>

                    <p className="mt-3 text-[11px] text-[#8696a0] leading-relaxed">
                        Display/verified name is managed in WhatsApp Manager (Meta), not from this form.
                    </p>

                    {businessProfileError && (
                        <div className="mt-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-2xl px-4 py-3 text-sm font-medium">
                            {businessProfileError}
                        </div>
                    )}
                    {businessProfileNotice && (
                        <div className="mt-4 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-2xl px-4 py-3 text-sm font-medium">
                            {businessProfileNotice}
                        </div>
                    )}

                    <div className="mt-5 flex items-center gap-3">
                        <button
                            type="button"
                            onClick={handleSaveBusinessProfile}
                            disabled={!sessionToken || businessProfileLoading || businessProfileSaving || businessProfileUploading}
                            className="bg-[#111b21] hover:bg-[#202c33] text-white px-5 py-3 rounded-2xl font-bold transition-all disabled:opacity-50"
                        >
                            {businessProfileSaving ? 'Saving...' : 'Save Business Profile'}
                        </button>
                        {businessProfileLoading && (
                            <span className="text-xs text-[#8696a0] font-semibold uppercase tracking-widest">Loading profile...</span>
                        )}
                    </div>
                </div>

                <div id="settings-branding" className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
                    <div className="flex items-center justify-between gap-3 mb-5">
                        <div>
                            <h3 className="text-xl text-[#111b21] font-bold">App Logo</h3>
                            <p className="text-sm text-[#54656f] font-medium mt-1">
                                Set the logo shown in the dashboard header.
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={fetchAppLogoSettings}
                            className="text-xs font-bold uppercase tracking-widest text-[#00a884] border border-[#00a884]/30 px-3 py-2 rounded-xl hover:bg-[#00a884]/5 transition-all"
                            disabled={appLogoLoading || appLogoUploading || appLogoSaving}
                        >
                            Refresh
                        </button>
                    </div>

                    <div className="bg-[#fcfdfd] border border-[#eceff1] rounded-2xl p-4 mb-4">
                        <div className="text-[11px] font-bold uppercase tracking-widest text-[#54656f] mb-2">
                            Preview
                        </div>
                        <div className="h-16 rounded-xl border border-[#eceff1] bg-white flex items-center justify-center px-3 overflow-hidden">
                            {appLogoLoading ? (
                                <div className="w-28 h-6 rounded bg-[#eef2f5] animate-pulse" />
                            ) : appLogoUrl ? (
                                <img
                                    src={appLogoUrl}
                                    alt="App logo preview"
                                    className="h-10 w-auto max-w-full object-contain"
                                    loading="lazy"
                                />
                            ) : (
                                <span className="text-[10px] font-black uppercase tracking-widest text-[#8696a0]">No Logo</span>
                            )}
                        </div>
                        <p className="text-[11px] text-[#8696a0] mt-3">
                            Max size: <span className="font-bold text-[#54656f]">{formatBytes(appLogoMaxBytes)}</span>. Supported: image files only.
                        </p>
                        {appLogoFilename && (
                            <p className="text-[11px] text-[#54656f] mt-1 break-all">
                                File: {appLogoFilename}
                                {appLogoSizeBytes ? ` (${formatBytes(appLogoSizeBytes)})` : ''}
                            </p>
                        )}
                    </div>

                    <input
                        ref={appLogoFileInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(event) => {
                            const file = event.target.files?.[0] || null;
                            handleUploadAppLogo(file);
                        }}
                    />

                    <div className="flex items-center gap-3">
                        <button
                            type="button"
                            onClick={() => appLogoFileInputRef.current?.click()}
                            disabled={!sessionToken || !profileId || appLogoLoading || appLogoUploading || appLogoSaving}
                            className="bg-[#00a884] hover:bg-[#008f6f] text-white px-4 py-2.5 rounded-xl font-bold transition-all disabled:opacity-50"
                        >
                            {appLogoUploading || appLogoSaving ? 'Uploading…' : 'Upload Logo'}
                        </button>
                        <button
                            type="button"
                            onClick={handleRemoveAppLogo}
                            disabled={!sessionToken || !appLogoAssetKey || appLogoUploading || appLogoSaving}
                            className="border border-[#eceff1] hover:bg-[#f8f9fa] text-[#111b21] px-4 py-2.5 rounded-xl font-bold transition-all disabled:opacity-50"
                        >
                            Remove
                        </button>
                    </div>

                    {appLogoError && (
                        <div className="mt-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-2xl px-4 py-3 text-sm font-medium">
                            {appLogoError}
                        </div>
                    )}
                    {appLogoNotice && (
                        <div className="mt-4 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-2xl px-4 py-3 text-sm font-medium">
                            {appLogoNotice}
                        </div>
                    )}
                </div>

                {/* Conversational Components */}
                <div id="settings-conversational" className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)] lg:col-span-2">
                    <div className="flex items-center justify-between mb-6">
                        <div>
                            <h3 className="text-xl text-[#111b21] font-bold">Conversational Components</h3>
                            <p className="text-sm text-[#54656f] font-medium mt-1">
                                Configure welcome message, ice breakers, and commands for this phone number.
                            </p>
                        </div>
                        <button
                            onClick={fetchAutomation}
                            className="text-xs font-bold uppercase tracking-widest text-[#00a884] border border-[#00a884]/30 px-3 py-2 rounded-xl hover:bg-[#00a884]/5 transition-all"
                        >
                            Refresh
                        </button>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                        <div className="bg-[#fcfdfd] p-5 rounded-2xl border border-[#eceff1]">
                            <div className="flex items-center justify-between mb-3">
                                <span className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Welcome Message</span>
                                <input
                                    type="checkbox"
                                    checked={autoConfig.enable_welcome_message}
                                    onChange={(e) => setAutoConfig(prev => ({ ...prev, enable_welcome_message: e.target.checked }))}
                                    disabled={autoLoading}
                                    className="w-4 h-4 accent-[#00a884]"
                                />
                            </div>
                            <p className="text-[11px] text-[#8696a0] leading-relaxed">
                                When enabled, Meta sends a <code className="font-mono">request_welcome</code> webhook for first‑time chats.
                                Create a workflow with trigger keyword <code className="font-mono">request_welcome</code> to reply.
                            </p>
                        </div>

                        <div className="bg-[#fcfdfd] p-5 rounded-2xl border border-[#eceff1]">
                            <div className="flex items-center justify-between mb-3">
                                <span className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Ice Breakers</span>
                                <button
                                    onClick={() => {
                                        setAutoConfig(prev => ({
                                            ...prev,
                                            prompts: [...(prev.prompts || []), '']
                                        }))
                                    }}
                                    disabled={autoLoading}
                                    className="text-[11px] font-bold text-[#00a884] hover:underline disabled:opacity-50 disabled:no-underline"
                                >
                                    + Add
                                </button>
                            </div>
                            <div className="space-y-3">
                                {(autoConfig.prompts || []).map((prompt, idx) => (
                                    <div key={idx} className="flex items-center gap-2">
                                        <input
                                            className="flex-1 bg-white border border-[#eceff1] rounded-xl px-3 py-2 text-xs font-bold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                            value={prompt}
                                            onChange={(e) => {
                                                const next = [...(autoConfig.prompts || [])];
                                                next[idx] = e.target.value;
                                                setAutoConfig(prev => ({ ...prev, prompts: next }));
                                            }}
                                            placeholder="Plan a trip"
                                        />
                                        <button
                                            onClick={() => {
                                                const next = (autoConfig.prompts || []).filter((_, i) => i !== idx);
                                                setAutoConfig(prev => ({ ...prev, prompts: next }));
                                            }}
                                            className="text-rose-500 text-xs font-bold"
                                        >
                                            Remove
                                        </button>
                                    </div>
                                ))}
                                {!autoLoading && autoConfig.prompts.length === 0 && (
                                    <p className="text-[11px] text-[#aebac1]">No ice breakers configured.</p>
                                )}
                            </div>
                        </div>

                        <div className="bg-[#fcfdfd] p-5 rounded-2xl border border-[#eceff1]">
                            <div className="flex items-center justify-between mb-3">
                                <span className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Commands</span>
                                <button
                                    onClick={() => {
                                        if ((autoConfig.commands || []).length >= COMMAND_MAX_COUNT) {
                                            setAutoError(`Maximum ${COMMAND_MAX_COUNT} commands are allowed.`);
                                            return;
                                        }
                                        setAutoError(null);
                                        setAutoConfig(prev => ({
                                            ...prev,
                                            commands: [...(prev.commands || []), { command_name: '', command_description: '' }]
                                        }))
                                    }}
                                    disabled={autoLoading || (autoConfig.commands || []).length >= COMMAND_MAX_COUNT}
                                    className="text-[11px] font-bold text-[#00a884] hover:underline"
                                >
                                    + Add
                                </button>
                            </div>
                            <p className="text-[11px] text-[#8696a0] leading-relaxed mb-3">
                                Add up to {COMMAND_MAX_COUNT} slash commands. Users type <code className="font-mono">/command</code> in WhatsApp.
                                Command max {COMMAND_NAME_MAX_LENGTH} chars and hint max {COMMAND_DESCRIPTION_MAX_LENGTH} chars. Emojis are not supported.
                            </p>
                            <div className="space-y-3">
                                {(autoConfig.commands || []).map((cmd, idx) => (
                                    <div key={idx} className="space-y-2 bg-white p-3 rounded-xl border border-[#eceff1]">
                                        <div className="flex items-center gap-2">
                                            <span className="text-xs font-bold text-[#54656f] w-4 text-center">/</span>
                                            <input
                                                className="flex-1 bg-[#f8f9fa] border border-[#eceff1] rounded-lg px-3 py-2 text-xs font-bold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                                value={cmd.command_name}
                                                maxLength={COMMAND_NAME_MAX_LENGTH}
                                                onChange={(e) => {
                                                    const next = [...(autoConfig.commands || [])];
                                                    next[idx] = { ...next[idx], command_name: e.target.value };
                                                    setAutoConfig(prev => ({ ...prev, commands: next }));
                                                }}
                                                placeholder="tickets"
                                            />
                                            <span className="text-[10px] text-[#8696a0] w-14 text-right">
                                                {normalizeCommandName(cmd.command_name).length}/{COMMAND_NAME_MAX_LENGTH}
                                            </span>
                                        </div>
                                        <input
                                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-lg px-3 py-2 text-xs text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                            value={cmd.command_description}
                                            maxLength={COMMAND_DESCRIPTION_MAX_LENGTH}
                                            onChange={(e) => {
                                                const next = [...(autoConfig.commands || [])];
                                                next[idx] = { ...next[idx], command_description: e.target.value };
                                                setAutoConfig(prev => ({ ...prev, commands: next }));
                                            }}
                                            placeholder="Book flight tickets"
                                        />
                                        <div className="flex items-center justify-between">
                                            <p className="text-[10px] text-[#8696a0]">
                                                Hint shown in WhatsApp command menu.
                                            </p>
                                            <span className="text-[10px] text-[#8696a0]">
                                                {normalizeCommandDescription(cmd.command_description).length}/{COMMAND_DESCRIPTION_MAX_LENGTH}
                                            </span>
                                        </div>
                                        <button
                                            onClick={() => {
                                                const next = (autoConfig.commands || []).filter((_, i) => i !== idx);
                                                setAutoConfig(prev => ({ ...prev, commands: next }));
                                            }}
                                            className="text-rose-500 text-[11px] font-bold"
                                        >
                                            Remove
                                        </button>
                                    </div>
                                ))}
                                {!autoLoading && autoConfig.commands.length === 0 && (
                                    <p className="text-[11px] text-[#aebac1]">No commands configured.</p>
                                )}
                            </div>
                        </div>
                    </div>

                    {autoError && (
                        <div className="mt-5 bg-rose-50 border border-rose-200 text-rose-700 rounded-2xl px-4 py-3 text-sm font-medium">
                            {autoError}
                        </div>
                    )}

                    <div className="mt-6 flex items-center justify-end gap-3">
                        <button
                            onClick={handleSaveAutomation}
                            disabled={autoSaving || autoLoading}
                            className="bg-[#00a884] hover:bg-[#008f6f] text-white px-5 py-3 rounded-2xl font-bold transition-all shadow-[0_8px_20px_rgba(0,168,132,0.2)] disabled:opacity-50"
                        >
                            {autoSaving ? 'Saving…' : 'Save Conversational Components'}
                        </button>
                    </div>
                </div>

                {showLegacyAutomationSettings && (
                    <>
                {/* 24h Window Reminder */}
                <div id="settings-reminder" className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)] lg:col-span-2">
                    <div className="flex items-center justify-between mb-6">
                        <div>
                            <h3 className="text-xl text-[#111b21] font-bold">24h Window Reminder</h3>
                            <p className="text-sm text-[#54656f] font-medium mt-1">
                                Send a reminder message before the 24h reply window closes. Use <code className="font-mono">{'{minutes}'}</code> in the text.
                            </p>
                        </div>
                        <button
                            onClick={fetchWindowReminder}
                            className="text-xs font-bold uppercase tracking-widest text-[#00a884] border border-[#00a884]/30 px-3 py-2 rounded-xl hover:bg-[#00a884]/5 transition-all"
                        >
                            Refresh
                        </button>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                        <div className="bg-[#fcfdfd] p-5 rounded-2xl border border-[#eceff1] flex items-center justify-between">
                            <span className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Enabled</span>
                            <input
                                type="checkbox"
                                checked={reminderConfig.enabled}
                                onChange={(e) => setReminderConfig(prev => ({ ...prev, enabled: e.target.checked }))}
                                className="w-4 h-4 accent-[#00a884]"
                            />
                        </div>

                        <div className="bg-[#fcfdfd] p-5 rounded-2xl border border-[#eceff1]">
                            <span className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Minutes Before Close</span>
                            <input
                                type="number"
                                min={1}
                                className="mt-3 w-full bg-white border border-[#eceff1] rounded-xl px-3 py-2 text-sm font-bold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                value={reminderConfig.minutes}
                                onChange={(e) => {
                                    const next = e.target.value === '' ? '' : Number(e.target.value);
                                    setReminderConfig(prev => ({ ...prev, minutes: next }));
                                }}
                                placeholder="30"
                            />
                            <p className="text-[11px] text-[#8696a0] mt-2">Set to the number of minutes before the window ends.</p>
                        </div>

                        <div className="bg-[#fcfdfd] p-5 rounded-2xl border border-[#eceff1] lg:col-span-1">
                            <span className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Reminder Text</span>
                            <textarea
                                className="mt-3 w-full bg-white border border-[#eceff1] rounded-xl px-3 py-2 text-sm font-medium text-[#111b21] focus:outline-none focus:border-[#00a884] h-24 resize-none"
                                value={reminderConfig.text}
                                onChange={(e) => setReminderConfig(prev => ({ ...prev, text: e.target.value }))}
                                placeholder="Heads up! Our 24h reply window closes in {minutes} minutes."
                            />
                        </div>
                    </div>

                    <div className="mt-6 flex items-center justify-end gap-3">
                        <button
                            onClick={handleSaveReminder}
                            disabled={reminderSaving || reminderLoading}
                            className="bg-[#00a884] hover:bg-[#008f6f] text-white px-5 py-3 rounded-2xl font-bold transition-all shadow-[0_8px_20px_rgba(0,168,132,0.2)] disabled:opacity-50"
                        >
                            {reminderSaving ? 'Saving…' : 'Save Window Reminder'}
                        </button>
                    </div>
                </div>

                {/* Quick Replies */}
                <div id="settings-quick-replies" className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)] lg:col-span-2">
                    <div className="flex items-center justify-between mb-6">
                        <div>
                            <h3 className="text-xl text-[#111b21] font-bold">Quick Replies</h3>
                            <p className="text-sm text-[#54656f] font-medium mt-1">
                                Type <code className="font-mono">/shortcut</code> in chat to send the full message.
                            </p>
                        </div>
                        <button
                            onClick={onRefreshQuickReplies}
                            className="text-xs font-bold uppercase tracking-widest text-[#00a884] border border-[#00a884]/30 px-3 py-2 rounded-xl hover:bg-[#00a884]/5 transition-all"
                        >
                            Refresh
                        </button>
                    </div>

                    {quickRepliesError && (
                        <div className="mb-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-2xl px-4 py-3 text-sm font-medium">
                            {quickRepliesError}
                        </div>
                    )}

                    <div className="space-y-4">
                        {quickRepliesLoading && quickRepliesDraft.length === 0 ? (
                            <div className="animate-pulse space-y-3">
                                <div className="h-24 rounded-2xl bg-[#eef2f5]" />
                                <div className="h-24 rounded-2xl bg-[#eef2f5]" />
                            </div>
                        ) : quickRepliesDraft.length === 0 ? (
                            <div className="bg-[#fcfdfd] border border-dashed border-[#d7dfe2] rounded-2xl p-6 text-sm text-[#8696a0]">
                                No quick replies yet. Add one below.
                            </div>
                        ) : (
                            quickRepliesDraft.map((item, index) => (
                                <div key={`${item.id || 'new'}-${index}`} className="bg-[#fcfdfd] border border-[#eceff1] rounded-2xl p-5">
                                    <div className="grid grid-cols-1 lg:grid-cols-6 gap-4 items-start">
                                        <div className="lg:col-span-1">
                                            <span className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Shortcut</span>
                                            <input
                                                className="mt-3 w-full bg-white border border-[#eceff1] rounded-xl px-3 py-2 text-sm font-bold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                                value={item.shortcut}
                                                onChange={(e) => handleUpdateQuickReply(index, 'shortcut', e.target.value)}
                                                placeholder="/hi"
                                            />
                                        </div>
                                        <div className="lg:col-span-4">
                                            <span className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Message</span>
                                            <textarea
                                                className="mt-3 w-full bg-white border border-[#eceff1] rounded-xl px-3 py-2 text-sm font-medium text-[#111b21] focus:outline-none focus:border-[#00a884] h-20 resize-none"
                                                value={item.text}
                                                onChange={(e) => handleUpdateQuickReply(index, 'text', e.target.value)}
                                                placeholder="Hello! How can we help you today?"
                                            />
                                        </div>
                                        <div className="lg:col-span-1 flex items-end justify-end">
                                            <button
                                                onClick={() => handleRemoveQuickReply(index)}
                                                className="mt-6 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-rose-500 hover:text-rose-600"
                                            >
                                                <Trash2 className="w-4 h-4" /> Remove
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>

                    <div className="mt-6 flex items-center justify-between gap-3">
                        <button
                            onClick={handleAddQuickReply}
                            className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-[#111b21] border border-[#d7dfe2] px-4 py-3 rounded-2xl hover:bg-[#f6f8f9] transition-all"
                        >
                            <Plus className="w-4 h-4" /> Add Quick Reply
                        </button>
                        <button
                            onClick={handleSaveQuickReplies}
                            disabled={quickRepliesSaving || quickRepliesLoading}
                            className="bg-[#00a884] hover:bg-[#008f6f] text-white px-5 py-3 rounded-2xl font-bold transition-all shadow-[0_8px_20px_rgba(0,168,132,0.2)] disabled:opacity-50"
                        >
                            {quickRepliesSaving ? 'Saving…' : 'Save Quick Replies'}
                        </button>
                    </div>
                </div>
                    </>
                )}

                <div id="settings-team-users" className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)] lg:col-span-2">
                    <div className="flex items-center justify-between mb-6">
                        <div>
                            <h3 className="text-xl text-[#111b21] font-bold">Team Users</h3>
                            <p className="text-sm text-[#54656f] font-medium mt-1">
                                Invite teammates with their own login to the same team inbox.
                            </p>
                        </div>
                        <button
                            onClick={fetchTeamUsers}
                            disabled={teamLoading || !sessionToken}
                            className="text-xs font-bold uppercase tracking-widest text-[#00a884] border border-[#00a884]/30 px-3 py-2 rounded-xl hover:bg-[#00a884]/5 transition-all disabled:opacity-50"
                        >
                            Refresh
                        </button>
                    </div>

                    {teamError && (
                        <div className="mb-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-2xl px-4 py-3 text-sm font-medium">
                            {teamError}
                        </div>
                    )}

                    {canManageTeam && (
                        <div className="mb-6 grid grid-cols-1 lg:grid-cols-6 gap-3 bg-[#fcfdfd] border border-[#eceff1] rounded-2xl p-4">
                            <input
                                className="lg:col-span-2 bg-white border border-[#eceff1] rounded-xl px-4 py-3 text-sm font-medium text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                placeholder="agent@company.com"
                                value={inviteEmail}
                                onChange={e => setInviteEmail(e.target.value)}
                            />
                            <input
                                className="lg:col-span-2 bg-white border border-[#eceff1] rounded-xl px-4 py-3 text-sm font-medium text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                type="password"
                                placeholder="Temporary password (min 8 chars)"
                                value={invitePassword}
                                onChange={e => setInvitePassword(e.target.value)}
                            />
                            <select
                                className="lg:col-span-1 bg-white border border-[#eceff1] rounded-xl px-3 py-3 text-sm font-bold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                value={inviteRole}
                                onChange={e => setInviteRole((e.target.value as TeamRole) || 'agent')}
                            >
                                <option value="agent">Agent</option>
                                <option value="admin">Admin</option>
                            </select>
                            <select
                                className="lg:col-span-1 bg-white border border-[#eceff1] rounded-xl px-3 py-3 text-sm font-bold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                value={inviteDepartment}
                                onChange={e => setInviteDepartment(normalizeTeamDepartment(e.target.value))}
                            >
                                {TEAM_DEPARTMENT_OPTIONS.map(option => (
                                    <option key={option.value} value={option.value}>{option.label}</option>
                                ))}
                            </select>
                            {inviteDepartment === 'custom' && (
                                <input
                                    className="lg:col-span-5 bg-white border border-[#eceff1] rounded-xl px-4 py-3 text-sm font-medium text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                    placeholder="Custom department label"
                                    value={inviteCustomDepartment}
                                    onChange={e => setInviteCustomDepartment(e.target.value)}
                                />
                            )}
                            <button
                                onClick={handleInviteTeamUser}
                                disabled={inviteLoading || !inviteEmail.trim() || !invitePassword}
                                className={`${inviteDepartment === 'custom' ? 'lg:col-span-1' : 'lg:col-span-2'} bg-[#00a884] hover:bg-[#008f6f] text-white rounded-xl px-4 py-3 text-xs font-bold uppercase tracking-widest disabled:opacity-50`}
                            >
                                {inviteLoading ? 'Creating…' : 'Create User'}
                            </button>
                            {inviteError && (
                                <div className="lg:col-span-6 text-sm text-rose-600 font-medium">
                                    {inviteError}
                                </div>
                            )}
                            {inviteSuccess && (
                                <div className="lg:col-span-6 text-sm text-emerald-600 font-medium">
                                    {inviteSuccess}
                                </div>
                            )}
                        </div>
                    )}

                    <div className="mb-6 grid grid-cols-1 lg:grid-cols-5 gap-3 bg-[#fcfdfd] border border-[#eceff1] rounded-2xl p-4">
                        <input
                            type="password"
                            className="lg:col-span-2 bg-white border border-[#eceff1] rounded-xl px-4 py-3 text-sm font-medium text-[#111b21] focus:outline-none focus:border-[#00a884]"
                            placeholder="New password"
                            value={selfPassword}
                            onChange={e => setSelfPassword(e.target.value)}
                        />
                        <input
                            type="password"
                            className="lg:col-span-2 bg-white border border-[#eceff1] rounded-xl px-4 py-3 text-sm font-medium text-[#111b21] focus:outline-none focus:border-[#00a884]"
                            placeholder="Confirm new password"
                            value={selfPasswordConfirm}
                            onChange={e => setSelfPasswordConfirm(e.target.value)}
                        />
                        <button
                            onClick={handleChangeOwnPassword}
                            disabled={selfPasswordSaving || !selfPassword || !selfPasswordConfirm}
                            className="lg:col-span-1 bg-[#111b21] hover:bg-[#202c33] text-white rounded-xl px-4 py-3 text-xs font-bold uppercase tracking-widest disabled:opacity-50"
                        >
                            {selfPasswordSaving ? 'Saving…' : 'Change My Password'}
                        </button>
                        {selfPasswordError && (
                            <div className="lg:col-span-5 text-sm text-rose-600 font-medium">
                                {selfPasswordError}
                            </div>
                        )}
                        {selfPasswordSuccess && (
                            <div className="lg:col-span-5 text-sm text-emerald-600 font-medium">
                                {selfPasswordSuccess}
                            </div>
                        )}
                    </div>

                    <div className="bg-[#fcfdfd] rounded-2xl border border-[#eceff1] overflow-hidden">
                        <table className="w-full text-left">
                            <thead className="bg-white text-[#54656f] text-[10px] uppercase font-black tracking-widest border-b border-[#eceff1]">
                                <tr>
                                    <th className="px-4 py-3">User</th>
                                    <th className="px-4 py-3">Role</th>
                                    <th className="px-4 py-3">Department</th>
                                    <th className="px-4 py-3">Last Sign-In</th>
                                    <th className="px-4 py-3">Joined</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-[#f0f2f5]">
                                {teamLoading ? (
                                    <tr>
                                        <td className="px-4 py-4" colSpan={5}>
                                            <div className="animate-pulse space-y-2">
                                                <div className="h-10 rounded-xl bg-[#eef2f5]" />
                                                <div className="h-10 rounded-xl bg-[#eef2f5]" />
                                                <div className="h-10 rounded-xl bg-[#eef2f5]" />
                                            </div>
                                        </td>
                                    </tr>
                                ) : teamUsers.length === 0 ? (
                                    <tr>
                                        <td className="px-4 py-4 text-sm text-[#8696a0]" colSpan={5}>
                                            No team users found.
                                        </td>
                                    </tr>
                                ) : (
                                    teamUsers.map(item => {
                                        const canChangeRole =
                                            canManageTeam &&
                                            item.id !== teamCurrentUserId &&
                                            !(item.role === 'owner' && teamCurrentRole !== 'owner');
                                        const currentDepartment = normalizeTeamDepartment(item.department);
                                        const departmentLabel = currentDepartment === 'custom'
                                            ? (item.customDepartment || 'Custom')
                                            : currentDepartment;
                                        return (
                                            <tr key={item.id} className="hover:bg-white transition-all">
                                                <td className="px-4 py-3">
                                                    <div className="text-sm font-bold text-[#111b21]">{item.name || item.email || item.id}</div>
                                                    <div className="text-xs text-[#54656f] font-medium">{item.email || item.id}</div>
                                                </td>
                                                <td className="px-4 py-3">
                                                    {canChangeRole ? (
                                                        <select
                                                            value={item.role}
                                                            disabled={roleSavingUserId === item.id}
                                                            onChange={(e) => handleUpdateTeamRole(item.id, (e.target.value as TeamRole) || 'agent')}
                                                            className="bg-white border border-[#eceff1] rounded-lg px-2 py-1 text-xs font-bold text-[#111b21] focus:outline-none focus:border-[#00a884] disabled:opacity-50"
                                                        >
                                                            <option value="agent">Agent</option>
                                                            <option value="admin">Admin</option>
                                                            {teamCurrentRole === 'owner' && <option value="owner">Owner</option>}
                                                        </select>
                                                    ) : (
                                                        <span className="text-xs font-bold uppercase tracking-widest text-[#54656f]">{item.role}</span>
                                                    )}
                                                </td>
                                                <td className="px-4 py-3">
                                                    {canManageTeam ? (
                                                        <div className="flex items-center gap-2">
                                                            <select
                                                                value={currentDepartment}
                                                                disabled={departmentSavingUserId === item.id}
                                                                onChange={async (e) => {
                                                                    const nextDepartment = normalizeTeamDepartment(e.target.value);
                                                                    if (nextDepartment === 'custom') {
                                                                        const currentLabel = item.customDepartment || '';
                                                                        const nextLabel = window.prompt('Custom department label', currentLabel);
                                                                        if (nextLabel === null) return;
                                                                        await handleUpdateTeamDepartment(item.id, 'custom', nextLabel);
                                                                        return;
                                                                    }
                                                                    await handleUpdateTeamDepartment(item.id, nextDepartment, null);
                                                                }}
                                                                className="bg-white border border-[#eceff1] rounded-lg px-2 py-1 text-xs font-bold text-[#111b21] focus:outline-none focus:border-[#00a884] disabled:opacity-50"
                                                            >
                                                                {TEAM_DEPARTMENT_OPTIONS.map(option => (
                                                                    <option key={option.value} value={option.value}>{option.label}</option>
                                                                ))}
                                                            </select>
                                                            {currentDepartment === 'custom' && (
                                                                <span className="text-xs text-[#54656f] font-medium">
                                                                    {item.customDepartment || 'Custom'}
                                                                </span>
                                                            )}
                                                        </div>
                                                    ) : (
                                                        <span className="text-xs font-bold uppercase tracking-widest text-[#54656f]">
                                                            {departmentLabel}
                                                        </span>
                                                    )}
                                                </td>
                                                <td className="px-4 py-3 text-xs text-[#54656f]">
                                                    {item.lastSignInAt ? new Date(item.lastSignInAt).toLocaleString() : 'Never'}
                                                </td>
                                                <td className="px-4 py-3 text-xs text-[#54656f]">
                                                    {item.createdAt ? new Date(item.createdAt).toLocaleDateString() : '—'}
                                                </td>
                                            </tr>
                                        );
                                    })
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

                {isSuperAdmin && (
                    <div id="settings-connected-clients" className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)] lg:col-span-2">
                        <div className="flex items-center justify-between mb-6">
                            <div>
                                <h3 className="text-xl text-[#111b21] font-bold">Connected Clients</h3>
                                <p className="text-sm text-[#54656f] font-medium mt-1">
                                    Clients connected via Embedded Signup for your company.
                                </p>
                            </div>
                            <button
                                onClick={() => fetchClientConnections()}
                                disabled={clientLoading}
                                className="text-xs font-bold uppercase tracking-widest text-[#00a884] border border-[#00a884]/30 px-3 py-2 rounded-xl hover:bg-[#00a884]/5 transition-all disabled:opacity-50"
                            >
                                Refresh
                            </button>
                        </div>

                        {clientError && (
                            <div className="mb-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-2xl px-4 py-3 text-sm font-medium">
                                {clientError}
                            </div>
                        )}

                        <div className="bg-[#fcfdfd] rounded-2xl border border-[#eceff1] overflow-hidden">
                            <table className="w-full text-left">
                                <thead className="bg-white text-[#54656f] text-[10px] uppercase font-black tracking-widest border-b border-[#eceff1]">
                                    <tr>
                                        <th className="px-6 py-4">Profile</th>
                                        <th className="px-6 py-4">Phone Number ID</th>
                                        <th className="px-6 py-4">WABA ID</th>
                                        <th className="px-6 py-4">Status</th>
                                        <th className="px-6 py-4">Token Source</th>
                                        <th className="px-6 py-4">Token Expiry</th>
                                        <th className="px-6 py-4">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-[#f0f2f5]">
                                    {clientLoading ? (
                                        <tr>
                                            <td className="px-6 py-6" colSpan={7}>
                                                <div className="animate-pulse space-y-2">
                                                    <div className="h-10 rounded-xl bg-[#eef2f5]" />
                                                    <div className="h-10 rounded-xl bg-[#eef2f5]" />
                                                    <div className="h-10 rounded-xl bg-[#eef2f5]" />
                                                </div>
                                            </td>
                                        </tr>
                                    ) : clientConnections.length === 0 ? (
                                        <tr>
                                            <td className="px-6 py-6 text-sm text-[#8696a0]" colSpan={7}>
                                                No connected clients found.
                                            </td>
                                        </tr>
                                    ) : (
                                        clientConnections.map((client: any) => {
                                            const status = client.enabled ? 'ACTIVE' : 'DISABLED';
                                            return (
                                                <tr key={client.profile_id} className="hover:bg-white transition-all">
                                                    <td className="px-6 py-4">
                                                        <div className="text-sm font-bold text-[#111b21]">{client.profile_id}</div>
                                                    </td>
                                                    <td className="px-6 py-4 text-xs font-mono text-[#54656f]">
                                                        {client.phone_number_id || '—'}
                                                    </td>
                                                    <td className="px-6 py-4 text-xs font-mono text-[#54656f]">
                                                        {client.waba_id || client.business_account_id || '—'}
                                                    </td>
                                                    <td className="px-6 py-4">
                                                        <span className={`text-[10px] px-3 py-1 rounded-full border font-bold uppercase tracking-widest ${statusBadgeClass(status)}`}>
                                                            {status}
                                                        </span>
                                                    </td>
                                                    <td className="px-6 py-4 text-xs text-[#54656f] uppercase font-bold tracking-widest">
                                                        {client.token_source || 'user'}
                                                    </td>
                                                    <td className="px-6 py-4 text-xs text-[#54656f]">
                                                        {formatTokenExpiry(client.access_token_expires_at)}
                                                    </td>
                                                    <td className="px-6 py-4">
                                                        <div className="flex items-center gap-2">
                                                            <button
                                                                onClick={() => handleDisconnectClient(client.profile_id, false)}
                                                                disabled={!client.enabled || clientLoading}
                                                                className="px-3 py-2 rounded-xl border border-[#eceff1] text-[11px] font-bold uppercase tracking-widest text-[#54656f] hover:border-[#aebac1] disabled:opacity-50"
                                                            >
                                                                Disable
                                                            </button>
                                                            <button
                                                                onClick={() => handleDisconnectClient(client.profile_id, true)}
                                                                disabled={!client.enabled || clientLoading}
                                                                className="px-3 py-2 rounded-xl border border-rose-200 text-[11px] font-bold uppercase tracking-widest text-rose-600 hover:border-rose-300 disabled:opacity-50"
                                                            >
                                                                Revoke
                                                            </button>
                                                        </div>
                                                    </td>
                                                </tr>
                                            );
                                        })
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {isSuperAdmin && (
                    <div id="settings-connected-businesses" className="bg-white p-8 rounded-3xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)] lg:col-span-2">
                    <div className="flex items-center justify-between mb-6">
                        <div>
                            <h3 className="text-xl text-[#111b21] font-bold">Connected Businesses</h3>
                            <p className="text-sm text-[#54656f] font-medium mt-1">
                                Fetch client businesses connected to your Meta app for this profile.
                            </p>
                        </div>
                        <button
                            onClick={() => fetchConnectedBusinesses()}
                            className="text-xs font-bold uppercase tracking-widest text-[#00a884] border border-[#00a884]/30 px-3 py-2 rounded-xl hover:bg-[#00a884]/5 transition-all"
                        >
                            Refresh
                        </button>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
                        <div className="lg:col-span-2">
                            <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Application ID (optional)</label>
                            <input
                                className="mt-3 w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a884]/20 focus:border-[#00a884] text-[#111b21] font-bold placeholder-[#aebac1]"
                                placeholder="Uses waba_configs.app_id if left empty"
                                value={connectedAppId}
                                onChange={e => setConnectedAppId(e.target.value)}
                            />
                            <p className="text-[11px] text-[#8696a0] mt-2">
                                Leave blank to use the stored <code className="font-mono">app_id</code> from Supabase or <code className="font-mono">WABA_APP_ID</code>.
                            </p>
                        </div>
                        <button
                            onClick={() => fetchConnectedBusinesses()}
                            disabled={connectedLoading}
                            className="h-[58px] mt-[24px] bg-[#111b21] text-white px-5 rounded-2xl flex items-center justify-center gap-2 font-bold hover:bg-[#202c33] transition-all shadow-lg text-xs disabled:opacity-50"
                        >
                            {connectedLoading ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : 'Fetch'}
                        </button>
                    </div>

                    {connectedError && (
                        <div className="mb-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-2xl px-4 py-3 text-sm font-medium">
                            {connectedError}
                        </div>
                    )}

                    <div className="bg-[#fcfdfd] rounded-2xl border border-[#eceff1] overflow-hidden">
                        <table className="w-full text-left">
                            <thead className="bg-white text-[#54656f] text-[10px] uppercase font-black tracking-widest border-b border-[#eceff1]">
                                <tr>
                                    <th className="px-6 py-4">Business</th>
                                    <th className="px-6 py-4">Business ID</th>
                                    <th className="px-6 py-4">Verification</th>
                                    <th className="px-6 py-4">Status</th>
                                    <th className="px-6 py-4">Updated</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-[#f0f2f5]">
                                {connectedLoading ? (
                                    <tr>
                                        <td className="px-6 py-6" colSpan={5}>
                                            <div className="animate-pulse space-y-2">
                                                <div className="h-10 rounded-xl bg-[#eef2f5]" />
                                                <div className="h-10 rounded-xl bg-[#eef2f5]" />
                                                <div className="h-10 rounded-xl bg-[#eef2f5]" />
                                            </div>
                                        </td>
                                    </tr>
                                ) : connectedBusinesses.length === 0 ? (
                                    <tr>
                                        <td className="px-6 py-6 text-sm text-[#8696a0]" colSpan={5}>
                                            No connected businesses found.
                                        </td>
                                    </tr>
                                ) : (
                                    connectedBusinesses.map((biz: any) => (
                                        <tr key={biz.id} className="hover:bg-white transition-all">
                                            <td className="px-6 py-4">
                                                <div className="text-sm font-bold text-[#111b21]">{biz.name || 'Unnamed Business'}</div>
                                            </td>
                                            <td className="px-6 py-4 text-xs font-mono text-[#54656f]">{biz.id}</td>
                                            <td className="px-6 py-4">
                                                <span className={`text-[10px] px-3 py-1 rounded-full border font-bold uppercase tracking-widest ${statusBadgeClass(biz.verification_status)}`}>
                                                    {biz.verification_status || 'UNKNOWN'}
                                                </span>
                                            </td>
                                            <td className="px-6 py-4">
                                                <span className={`text-[10px] px-3 py-1 rounded-full border font-bold uppercase tracking-widest ${statusBadgeClass(biz.business_status)}`}>
                                                    {biz.business_status || 'UNKNOWN'}
                                                </span>
                                            </td>
                                            <td className="px-6 py-4 text-xs text-[#54656f]">
                                                {formatConnectedDate(biz.updated_time || biz.created_time)}
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>

                    <div className="mt-4 flex items-center justify-between">
                        <div className="text-[11px] text-[#8696a0] font-bold uppercase tracking-widest">
                            {connectedBusinesses.length} results
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => fetchConnectedBusinesses({ before: connectedPaging?.cursors?.before })}
                                disabled={!connectedPaging?.cursors?.before || connectedLoading}
                                className="px-3 py-2 rounded-xl border border-[#eceff1] text-[11px] font-bold uppercase tracking-widest text-[#54656f] hover:border-[#aebac1] disabled:opacity-50"
                            >
                                Previous
                            </button>
                            <button
                                onClick={() => fetchConnectedBusinesses({ after: connectedPaging?.cursors?.after })}
                                disabled={!connectedPaging?.cursors?.after || connectedLoading}
                                className="px-3 py-2 rounded-xl border border-[#eceff1] text-[11px] font-bold uppercase tracking-widest text-[#54656f] hover:border-[#aebac1] disabled:opacity-50"
                            >
                                Next
                            </button>
                        </div>
                    </div>
                    </div>
                )}
            </div>

            {showRegistrationWizard && (
                <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6">
                    <div className="bg-white w-full max-w-3xl rounded-3xl shadow-2xl border border-[#eceff1] overflow-hidden">
                        <div className="flex items-center justify-between px-6 py-5 border-b border-[#eceff1]">
                            <div>
                                <p className="text-xs font-bold uppercase tracking-widest text-[#54656f]">Step {registrationStep} of 4</p>
                                <h3 className="text-xl font-bold text-[#111b21]">WhatsApp Number Setup</h3>
                            </div>
                            <button onClick={closeRegistrationWizard} className="text-[#54656f] hover:text-[#111b21] font-bold text-sm">Close</button>
                        </div>

                        <div className="p-6 space-y-5">
                            {registrationStep === 1 && (
                                <>
                                    <p className="text-sm text-[#54656f] font-medium">
                                        Confirm the WABA and phone number you want to register.
                                    </p>
                                    <div className="grid grid-cols-1 gap-4">
                                        <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">WABA ID</label>
                                        <input
                                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-3 text-sm font-bold text-[#111b21]"
                                            value={registrationWabaId}
                                            onChange={e => setRegistrationWabaId(e.target.value)}
                                            placeholder="WhatsApp Business Account ID"
                                            readOnly={Boolean(registrationWabaId)}
                                        />
                                        {registrationWabaId && (
                                            <p className="text-[11px] text-[#8696a0] -mt-2">Auto-selected from Meta Embedded Signup.</p>
                                        )}
                                        <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Phone Number ID</label>
                                        <input
                                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-3 text-sm font-bold text-[#111b21]"
                                            value={registrationPhoneNumberId}
                                            onChange={e => setRegistrationPhoneNumberId(e.target.value)}
                                            placeholder="Phone Number ID"
                                        />
                                    </div>
                                    <div className="flex flex-wrap gap-3">
                                        <button
                                            onClick={fetchRegistrationNumbers}
                                            disabled={registrationNumbersLoading || !sessionToken}
                                            className="bg-[#00a884] hover:bg-[#008f6f] text-white font-black py-2.5 px-4 rounded-xl transition-all text-xs uppercase tracking-widest disabled:opacity-50"
                                        >
                                            {registrationNumbersLoading ? 'Loading...' : 'Fetch Phone Numbers'}
                                        </button>
                                        {registrationNumbers.length > 0 && (
                                            <span className="text-xs text-[#54656f] font-semibold">
                                                Found {registrationNumbers.length} number(s)
                                            </span>
                                        )}
                                    </div>
                                    {registrationNumbers.length > 0 && (
                                        <div className="space-y-2 max-h-40 overflow-y-auto">
                                            {registrationNumbers.map((num: any) => (
                                                <button
                                                    key={num.id}
                                                    onClick={() => setRegistrationPhoneNumberId(num.id)}
                                                    className={`w-full text-left p-3 rounded-2xl border text-xs font-mono ${registrationPhoneNumberId === num.id ? 'border-[#00a884] bg-[#00a884]/5 text-[#00a884]' : 'border-[#eceff1] bg-[#fcfdfd] text-[#54656f]'}`}
                                                >
                                                    {num.display_phone_number || '—'} · {num.verified_name || '—'} · {num.quality_rating || '—'} · {num.id}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </>
                            )}

                            {registrationStep === 2 && (
                                <>
                                    <p className="text-sm text-[#54656f] font-medium">
                                        Send a verification code to the phone number via SMS or Voice.
                                    </p>
                                    <div className="grid grid-cols-1 gap-4">
                                        <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Code Method</label>
                                        <select
                                            value={registrationCodeMethod}
                                            onChange={e => setRegistrationCodeMethod(e.target.value as 'SMS' | 'VOICE')}
                                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-3 text-sm font-bold text-[#111b21]"
                                        >
                                            <option value="SMS">SMS</option>
                                            <option value="VOICE">VOICE</option>
                                        </select>
                                        <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Locale</label>
                                        <input
                                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-3 text-sm font-bold text-[#111b21]"
                                            value={registrationLocale}
                                            onChange={e => setRegistrationLocale(e.target.value)}
                                            placeholder="en_US"
                                        />
                                    </div>
                                    <button
                                        onClick={handleRequestVerificationCode}
                                        disabled={registrationBusy !== null || !sessionToken}
                                        className="w-full bg-[#111b21] hover:bg-[#202c33] text-white font-black py-3 rounded-2xl transition-all text-xs uppercase tracking-widest disabled:opacity-50"
                                    >
                                        {registrationBusy === 'request' ? 'Requesting...' : 'Request Code'}
                                    </button>
                                    {registrationRequestSent && (
                                        <p className="text-xs text-[#00a884] font-bold uppercase tracking-widest">Code sent</p>
                                    )}
                                </>
                            )}

                            {registrationStep === 3 && (
                                <>
                                    <p className="text-sm text-[#54656f] font-medium">
                                        Enter the verification code received by the client.
                                    </p>
                                    <div className="grid grid-cols-1 gap-4">
                                        <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Verification Code</label>
                                        <input
                                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-3 text-sm font-bold text-[#111b21]"
                                            value={registrationCode}
                                            onChange={e => setRegistrationCode(e.target.value)}
                                            placeholder="123456"
                                        />
                                    </div>
                                    <button
                                        onClick={handleVerifyCode}
                                        disabled={registrationBusy !== null || !sessionToken}
                                        className="w-full bg-[#00a884] hover:bg-[#008f6f] text-white font-black py-3 rounded-2xl transition-all text-xs uppercase tracking-widest disabled:opacity-50"
                                    >
                                        {registrationBusy === 'verify' ? 'Verifying...' : 'Verify Code'}
                                    </button>
                                    {registrationVerified && (
                                        <p className="text-xs text-[#00a884] font-bold uppercase tracking-widest">Verified</p>
                                    )}
                                </>
                            )}

                            {registrationStep === 4 && (
                                <>
                                    <p className="text-sm text-[#54656f] font-medium">
                                        Register the number with a 6-digit PIN and optionally set the business profile.
                                    </p>
                                    <div className="grid grid-cols-1 gap-4">
                                        <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Two-Step PIN</label>
                                        <input
                                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-3 text-sm font-bold text-[#111b21]"
                                            value={registrationPin}
                                            onChange={e => setRegistrationPin(e.target.value)}
                                            placeholder="6 digits"
                                        />
                                        <label className="text-xs font-bold text-[#54656f] uppercase tracking-widest">Business Profile JSON</label>
                                        <textarea
                                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-2xl px-5 py-3 text-xs font-mono text-[#111b21] min-h-[140px]"
                                            value={registrationProfileJson}
                                            onChange={e => setRegistrationProfileJson(e.target.value)}
                                        />
                                    </div>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                        <button
                                            onClick={handleRegisterNumber}
                                            disabled={registrationBusy !== null || !sessionToken}
                                            className="bg-[#111b21] hover:bg-[#202c33] text-white font-black py-3 rounded-2xl transition-all text-xs uppercase tracking-widest disabled:opacity-50"
                                        >
                                            {registrationBusy === 'register' ? 'Registering...' : 'Register Number'}
                                        </button>
                                        <button
                                            onClick={handleUpdateProfile}
                                            disabled={registrationBusy !== null || !sessionToken}
                                            className="bg-[#00a884] hover:bg-[#008f6f] text-white font-black py-3 rounded-2xl transition-all text-xs uppercase tracking-widest disabled:opacity-50"
                                        >
                                            {registrationBusy === 'profile' ? 'Saving...' : 'Update Profile'}
                                        </button>
                                    </div>
                                    <div className="flex flex-wrap gap-3 text-xs font-bold uppercase tracking-widest text-[#54656f]">
                                        {registrationRegistered && <span className="text-[#00a884]">Registered</span>}
                                        {registrationProfileUpdated && <span className="text-[#00a884]">Profile Updated</span>}
                                    </div>
                                </>
                            )}

                            {(registrationError || registrationNumbersError) && (
                                <p className="text-sm text-rose-600 font-semibold">
                                    {registrationError || registrationNumbersError}
                                </p>
                            )}
                        </div>

                        <div className="flex items-center justify-between px-6 py-5 border-t border-[#eceff1]">
                            <button
                                onClick={() => setRegistrationStep(prev => (prev > 1 ? (prev - 1) as 1 | 2 | 3 | 4 : prev))}
                                disabled={registrationStep === 1}
                                className="text-xs font-bold uppercase tracking-widest text-[#54656f] disabled:opacity-40"
                            >
                                Back
                            </button>
                            <div className="flex gap-3">
                                <button
                                    onClick={() => setRegistrationStep(prev => (prev < 4 ? (prev + 1) as 1 | 2 | 3 | 4 : prev))}
                                    disabled={
                                        (registrationStep === 1 && !registrationPhoneNumberId) ||
                                        (registrationStep === 2 && !registrationRequestSent) ||
                                        (registrationStep === 3 && !registrationVerified) ||
                                        registrationStep === 4
                                    }
                                    className="bg-[#111b21] hover:bg-[#202c33] text-white font-black py-3 px-6 rounded-2xl transition-all text-xs uppercase tracking-widest disabled:opacity-50"
                                >
                                    {registrationStep === 4 ? 'Done' : 'Next'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
