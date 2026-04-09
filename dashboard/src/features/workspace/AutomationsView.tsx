import React from 'react';
import { Check, Copy, MessageSquare, Plus, Settings2, Workflow, X } from 'lucide-react';
import { uploadFileToCompanyStorage } from '../media/uploadToCompanyStorage';

type AutomationsViewProps = {
    workflows: any[];
    workflowsLoading: boolean;
    isMobileView?: boolean;
    profileId: string | null;
    sessionToken: string | null;
    apiBaseUrl: string;
    onOpenBuilder: (workflowId: string | null) => void;
    onCreateWorkflow: () => void;
    onToggleWorkflowEnabled: (workflowId: string, nextEnabled: boolean) => void;
    onCopyWorkflow: (workflowId: string) => void;
    onQuickRepliesUpdated: () => void;
    onSaveWorkflowTrigger: (workflowId: string, triggerKeyword: string, runOnNewChat: boolean) => Promise<void>;
};

type ConversationalCommand = {
    command_name: string;
    command_description: string;
};

type QuickReply = {
    id?: string;
    shortcut: string;
    text: string;
    message_type?: 'text' | 'image' | 'video' | 'document';
    media_storage?: 'external' | 'r2';
    media_asset_key?: string;
    media_mime_type?: string;
    media_size_bytes?: number | null;
    media_url?: string;
    media_filename?: string;
    ui_uploading?: boolean;
    ui_upload_error?: string | null;
};

const COMMAND_MAX_COUNT = 30;
const COMMAND_NAME_MAX_LENGTH = 32;
const COMMAND_DESCRIPTION_MAX_LENGTH = 256;
const COMMAND_NAME_REGEX = /^[a-z0-9_-]+$/;
const EMOJI_REGEX = /\p{Extended_Pictographic}/u;

const normalizeCommandName = (value: unknown): string =>
    (typeof value === 'string' ? value.trim() : '').replace(/^\/+/, '').toLowerCase();

const normalizeCommandDescription = (value: unknown): string =>
    typeof value === 'string' ? value.trim() : '';

const normalizeQuickReplyMessageType = (value: unknown): 'text' | 'image' | 'video' | 'document' => {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (normalized === 'image' || normalized === 'video' || normalized === 'document') return normalized;
    return 'text';
};

const normalizeQuickReplyMediaUrl = (value: unknown): string =>
    typeof value === 'string' ? value.trim() : '';

const normalizeQuickReplyMediaStorage = (value: unknown): 'external' | 'r2' => {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (normalized === 'r2') return 'r2';
    return 'external';
};

const normalizeQuickReplyMediaAssetKey = (value: unknown): string =>
    typeof value === 'string' ? value.trim() : '';

const normalizeQuickReplyMediaMimeType = (value: unknown): string =>
    typeof value === 'string' ? value.trim().toLowerCase() : '';

const normalizeQuickReplyMediaSizeBytes = (value: unknown): number | null => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return Math.max(0, Math.floor(parsed)) || null;
};

const normalizeQuickReplyMediaFilename = (value: unknown): string =>
    typeof value === 'string' ? value.trim() : '';

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

export default function AutomationsView({
    workflows,
    workflowsLoading,
    isMobileView = false,
    profileId,
    sessionToken,
    apiBaseUrl,
    onOpenBuilder,
    onCreateWorkflow,
    onToggleWorkflowEnabled,
    onCopyWorkflow,
    onQuickRepliesUpdated,
    onSaveWorkflowTrigger
}: AutomationsViewProps) {
    const lastActionAtRef = React.useRef(0);
    const [showFallbackModal, setShowFallbackModal] = React.useState(false);
    const [showTriggerModal, setShowTriggerModal] = React.useState(false);
    const [showConversationalModal, setShowConversationalModal] = React.useState(false);
    const [showReminderModal, setShowReminderModal] = React.useState(false);
    const [showQuickRepliesModal, setShowQuickRepliesModal] = React.useState(false);
    const [triggerWorkflowId, setTriggerWorkflowId] = React.useState('');
    const [triggerKeywordDraft, setTriggerKeywordDraft] = React.useState('');
    const [triggerRunOnNewChat, setTriggerRunOnNewChat] = React.useState(false);
    const [triggerSaving, setTriggerSaving] = React.useState(false);
    const [triggerError, setTriggerError] = React.useState<string | null>(null);
    const [triggerNotice, setTriggerNotice] = React.useState<string | null>(null);
    const [autoConfig, setAutoConfig] = React.useState<{
        enable_welcome_message: boolean;
        prompts: string[];
        commands: ConversationalCommand[];
    }>({
        enable_welcome_message: false,
        prompts: [],
        commands: []
    });
    const [autoLoading, setAutoLoading] = React.useState(false);
    const [autoSaving, setAutoSaving] = React.useState(false);
    const [autoError, setAutoError] = React.useState<string | null>(null);
    const [autoNotice, setAutoNotice] = React.useState<string | null>(null);
    const [reminderConfig, setReminderConfig] = React.useState<{
        enabled: boolean;
        minutes: number | '';
        text: string;
    }>({
        enabled: false,
        minutes: 30,
        text: ''
    });
    const [reminderLoading, setReminderLoading] = React.useState(false);
    const [reminderSaving, setReminderSaving] = React.useState(false);
    const [reminderError, setReminderError] = React.useState<string | null>(null);
    const [reminderNotice, setReminderNotice] = React.useState<string | null>(null);
    const [quickRepliesDraft, setQuickRepliesDraft] = React.useState<QuickReply[]>([]);
    const [quickRepliesLoading, setQuickRepliesLoading] = React.useState(false);
    const [quickRepliesSaving, setQuickRepliesSaving] = React.useState(false);
    const [quickRepliesError, setQuickRepliesError] = React.useState<string | null>(null);
    const [quickRepliesNotice, setQuickRepliesNotice] = React.useState<string | null>(null);
    const [fallbackConfig, setFallbackConfig] = React.useState<{
        text: string;
        limit: number | '';
    }>({
        text: '',
        limit: 3
    });
    const [fallbackLoading, setFallbackLoading] = React.useState(false);
    const [fallbackSaving, setFallbackSaving] = React.useState(false);
    const [fallbackError, setFallbackError] = React.useState<string | null>(null);
    const [fallbackNotice, setFallbackNotice] = React.useState<string | null>(null);

    const getWorkflowId = (value: unknown): string => {
        if (typeof value === 'string') return value.trim();
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
        return '';
    };
    const getWorkflowName = (value: unknown): string => {
        if (typeof value === 'string') return value.trim();
        return '';
    };

    const runOncePerTap = (fn: () => void) => {
        const now = Date.now();
        if (now - lastActionAtRef.current < 220) return;
        lastActionAtRef.current = now;
        fn();
    };

    const bindOpenHandlers = (fn: () => void) => ({
        onClick: () => runOncePerTap(fn),
        onMouseDown: () => runOncePerTap(fn),
        onTouchStart: () => runOncePerTap(fn)
    });
    const workflowSkeletonRows = [0, 1, 2, 3, 4];

    const triggerWorkflowChoices = React.useMemo(() => {
        return workflows
            .map((wf: any) => {
                const id = getWorkflowId(wf?.id);
                if (!id) return null;
                const name = getWorkflowName(wf?.name);
                const trigger = (wf?.trigger_keyword || '').toString().trim();
                return {
                    id,
                    label: name || id,
                    trigger,
                    runOnNewChat: wf?.run_on_new_chat === true
                };
            })
            .filter(Boolean) as Array<{ id: string; label: string; trigger: string; runOnNewChat: boolean }>;
    }, [workflows]);

    const handleOpenTriggerModal = React.useCallback(() => {
        setTriggerError(null);
        setTriggerNotice(null);
        if (triggerWorkflowChoices.length > 0) {
            const seed = triggerWorkflowChoices.find((item) => item.runOnNewChat) || triggerWorkflowChoices[0];
            setTriggerWorkflowId(seed.id);
            setTriggerKeywordDraft(seed.trigger);
            setTriggerRunOnNewChat(seed.runOnNewChat);
        } else {
            setTriggerWorkflowId('');
            setTriggerKeywordDraft('');
            setTriggerRunOnNewChat(false);
        }
        setShowTriggerModal(true);
    }, [triggerWorkflowChoices]);

    const handleTriggerWorkflowChange = React.useCallback((nextWorkflowId: string) => {
        setTriggerWorkflowId(nextWorkflowId);
        const picked = triggerWorkflowChoices.find((item) => item.id === nextWorkflowId);
        setTriggerKeywordDraft(picked?.trigger || '');
        setTriggerRunOnNewChat(picked?.runOnNewChat === true);
        setTriggerError(null);
        setTriggerNotice(null);
    }, [triggerWorkflowChoices]);

    const handleSaveTrigger = React.useCallback(async () => {
        if (!triggerWorkflowId) {
            setTriggerError('Select a workflow first.');
            return;
        }
        setTriggerSaving(true);
        setTriggerError(null);
        setTriggerNotice(null);
        try {
            await onSaveWorkflowTrigger(triggerWorkflowId, triggerKeywordDraft, triggerRunOnNewChat);
            setTriggerNotice('Trigger saved.');
        } catch (error: any) {
            setTriggerError(error?.message || 'Failed to save trigger.');
        } finally {
            setTriggerSaving(false);
        }
    }, [onSaveWorkflowTrigger, triggerKeywordDraft, triggerRunOnNewChat, triggerWorkflowId]);

    const fetchConversationalSettings = React.useCallback(() => {
        if (!profileId || !sessionToken) return;
        setAutoLoading(true);
        setAutoError(null);
        setAutoNotice(null);
        fetch(`${apiBaseUrl}/api/waba/conversational-automation?profileId=${encodeURIComponent(profileId)}`, {
            headers: {
                Authorization: `Bearer ${sessionToken}`
            }
        })
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    console.error('Conversational components fetch failed:', text);
                    return null;
                }
            })
            .then(data => {
                if (data?.success === false) {
                    setAutoError(data?.error || 'Failed to load conversational components.');
                    return;
                }
                const config = data?.data?.conversational_automation || {};
                setAutoConfig({
                    enable_welcome_message: Boolean(config.enable_welcome_message),
                    prompts: Array.isArray(config.prompts) ? config.prompts : [],
                    commands: sanitizeCommandInput(config.commands)
                });
            })
            .finally(() => setAutoLoading(false));
    }, [apiBaseUrl, profileId, sessionToken]);

    const handleOpenConversationalModal = React.useCallback(() => {
        setAutoError(null);
        setAutoNotice(null);
        setShowConversationalModal(true);
        fetchConversationalSettings();
    }, [fetchConversationalSettings]);

    const handleSaveConversationalSettings = React.useCallback(() => {
        if (!profileId || !sessionToken) return;

        const validated = validateCommandsForSave(autoConfig.commands || []);
        if (validated.error) {
            setAutoError(validated.error);
            return;
        }

        const prompts = (autoConfig.prompts || []).map((item) => item.trim()).filter(Boolean);
        const commands = validated.commands;

        setAutoSaving(true);
        setAutoError(null);
        setAutoNotice(null);
        fetch(`${apiBaseUrl}/api/waba/conversational-automation`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${sessionToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                profileId,
                enable_welcome_message: autoConfig.enable_welcome_message,
                prompts,
                commands
            })
        })
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    console.error('Conversational components save failed:', text);
                    return null;
                }
            })
            .then(data => {
                if (data?.success) {
                    setAutoConfig((prev) => ({
                        ...prev,
                        prompts,
                        commands
                    }));
                    setAutoNotice('Conversational components saved.');
                } else {
                    setAutoError(data?.error || 'Failed to save conversational components.');
                }
            })
            .finally(() => setAutoSaving(false));
    }, [apiBaseUrl, autoConfig, profileId, sessionToken]);

    const fetchWindowReminderSettings = React.useCallback(() => {
        if (!profileId || !sessionToken) return;
        setReminderLoading(true);
        setReminderError(null);
        setReminderNotice(null);
        fetch(`${apiBaseUrl}/api/waba/window-reminder?profileId=${encodeURIComponent(profileId)}`, {
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
                if (data?.success === false) {
                    setReminderError(data?.error || 'Failed to load window reminder settings.');
                    return;
                }
                const config = data?.data || {};
                setReminderConfig({
                    enabled: Boolean(config.window_reminder_enabled),
                    minutes: typeof config.window_reminder_minutes === 'number' ? config.window_reminder_minutes : '',
                    text: typeof config.window_reminder_text === 'string' ? config.window_reminder_text : ''
                });
            })
            .finally(() => setReminderLoading(false));
    }, [apiBaseUrl, profileId, sessionToken]);

    const handleOpenReminderModal = React.useCallback(() => {
        setReminderError(null);
        setReminderNotice(null);
        setShowReminderModal(true);
        fetchWindowReminderSettings();
    }, [fetchWindowReminderSettings]);

    const handleSaveReminderSettings = React.useCallback(() => {
        if (!profileId || !sessionToken) return;
        setReminderSaving(true);
        setReminderError(null);
        setReminderNotice(null);
        fetch(`${apiBaseUrl}/api/waba/window-reminder`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${sessionToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                profileId,
                enabled: reminderConfig.enabled,
                minutes: reminderConfig.minutes === '' ? null : Number(reminderConfig.minutes),
                text: reminderConfig.text
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
                    setReminderNotice('Window reminder settings saved.');
                } else {
                    setReminderError(data?.error || 'Failed to save window reminder settings.');
                }
            })
            .finally(() => setReminderSaving(false));
    }, [apiBaseUrl, profileId, reminderConfig, sessionToken]);

    const normalizeQuickReplyShortcut = React.useCallback((value: string) => {
        if (!value) return '';
        const trimmed = value.trim();
        if (!trimmed) return '';
        const withoutSlash = trimmed.replace(/^\/+/, '');
        const token = withoutSlash.split(/\s+/)[0];
        return token.toLowerCase();
    }, []);

    const normalizeQuickReplyRecord = React.useCallback((item: any): QuickReply => {
        const message_type = normalizeQuickReplyMessageType(item?.message_type);
        const media_asset_key = normalizeQuickReplyMediaAssetKey(item?.media_asset_key);
        const media_storage = media_asset_key ? 'r2' : normalizeQuickReplyMediaStorage(item?.media_storage);
        return {
            id: typeof item?.id === 'string' ? item.id : undefined,
            shortcut: typeof item?.shortcut === 'string' ? item.shortcut : '',
            text: typeof item?.text === 'string' ? item.text : '',
            message_type,
            media_storage,
            media_asset_key,
            media_mime_type: normalizeQuickReplyMediaMimeType(item?.media_mime_type),
            media_size_bytes: normalizeQuickReplyMediaSizeBytes(item?.media_size_bytes),
            media_url: normalizeQuickReplyMediaUrl(item?.media_url),
            media_filename: message_type === 'document' ? normalizeQuickReplyMediaFilename(item?.media_filename) : '',
            ui_uploading: false,
            ui_upload_error: null
        };
    }, []);

    const fetchQuickReplies = React.useCallback(() => {
        if (!profileId || !sessionToken) {
            setQuickRepliesDraft([]);
            return;
        }
        setQuickRepliesLoading(true);
        setQuickRepliesError(null);
        setQuickRepliesNotice(null);
        fetch(`${apiBaseUrl}/api/company/quick-replies?profileId=${encodeURIComponent(profileId)}`, {
            headers: {
                Authorization: `Bearer ${sessionToken}`
            }
        })
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    console.error('Quick replies fetch failed:', text);
                    return null;
                }
            })
            .then(data => {
                if (data?.success) {
                    setQuickRepliesDraft(Array.isArray(data.data) ? data.data.map((item: any) => normalizeQuickReplyRecord(item)) : []);
                } else {
                    setQuickRepliesError(data?.error || 'Failed to load quick replies.');
                }
            })
            .finally(() => setQuickRepliesLoading(false));
    }, [apiBaseUrl, normalizeQuickReplyRecord, profileId, sessionToken]);

    const handleOpenQuickRepliesModal = React.useCallback(() => {
        setQuickRepliesError(null);
        setQuickRepliesNotice(null);
        setShowQuickRepliesModal(true);
        fetchQuickReplies();
    }, [fetchQuickReplies]);

    const handleAddQuickReply = React.useCallback(() => {
        setQuickRepliesNotice(null);
        setQuickRepliesDraft(prev => ([
            ...prev,
            {
                shortcut: '',
                text: '',
                message_type: 'text',
                media_storage: 'external',
                media_asset_key: '',
                media_mime_type: '',
                media_size_bytes: null,
                media_url: '',
                media_filename: '',
                ui_uploading: false,
                ui_upload_error: null
            }
        ]));
    }, []);

    const handleUpdateQuickReply = React.useCallback((
        index: number,
        field: 'shortcut' | 'text' | 'message_type' | 'media_filename',
        value: string
    ) => {
        setQuickRepliesNotice(null);
        setQuickRepliesDraft(prev => {
            const next = [...prev];
            const current = next[index] || {
                shortcut: '',
                text: '',
                message_type: 'text',
                media_storage: 'external',
                media_asset_key: '',
                media_mime_type: '',
                media_size_bytes: null,
                media_url: '',
                media_filename: '',
                ui_uploading: false,
                ui_upload_error: null
            };
            const updated = { ...current, [field]: value };
            if (field === 'message_type') {
                const messageType = normalizeQuickReplyMessageType(value);
                updated.message_type = messageType;
                if (messageType === 'text') {
                    updated.media_storage = 'external';
                    updated.media_asset_key = '';
                    updated.media_mime_type = '';
                    updated.media_size_bytes = null;
                    updated.media_url = '';
                    updated.media_filename = '';
                } else if (normalizeQuickReplyMessageType(current.message_type) !== messageType) {
                    updated.media_storage = 'external';
                    updated.media_asset_key = '';
                    updated.media_mime_type = '';
                    updated.media_size_bytes = null;
                    updated.media_url = '';
                } else if (messageType !== 'document') {
                    updated.media_filename = '';
                }
            }
            if (field === 'media_filename') {
                updated.media_filename = value;
            }
            updated.ui_upload_error = null;
            next[index] = updated;
            return next;
        });
    }, []);

    const handleUploadQuickReplyMedia = React.useCallback(async (index: number, file: File | null) => {
        if (!file) return;
        if (!profileId || !sessionToken) {
            setQuickRepliesError('Select a profile and log in before uploading media.');
            return;
        }
        const draft = quickRepliesDraft[index];
        const messageType = normalizeQuickReplyMessageType(draft?.message_type);
        if (messageType === 'text') {
            setQuickRepliesError('Set the quick reply type to image, video, or document before uploading.');
            return;
        }

        setQuickRepliesNotice(null);
        setQuickRepliesDraft((prev) => prev.map((item, idx) => (
            idx === index
                ? { ...item, ui_uploading: true, ui_upload_error: null }
                : item
        )));
        try {
            const uploaded = await uploadFileToCompanyStorage({
                apiBaseUrl,
                profileId,
                sessionToken,
                purpose: 'quick_reply',
                messageType,
                file
            });
            setQuickRepliesDraft((prev) => prev.map((item, idx) => (
                idx === index
                    ? {
                        ...item,
                        media_storage: 'r2',
                        media_asset_key: uploaded.assetKey,
                        media_mime_type: uploaded.mimeType,
                        media_size_bytes: uploaded.sizeBytes,
                        media_url: '',
                        media_filename: messageType === 'document' ? (uploaded.fileName || item.media_filename || '') : '',
                        ui_uploading: false,
                        ui_upload_error: null
                    }
                    : item
            )));
        } catch (error: any) {
            setQuickRepliesDraft((prev) => prev.map((item, idx) => (
                idx === index
                    ? { ...item, ui_uploading: false, ui_upload_error: error?.message || 'Upload failed.' }
                    : item
            )));
        }
    }, [apiBaseUrl, profileId, quickRepliesDraft, sessionToken]);

    const handleRemoveQuickReply = React.useCallback((index: number) => {
        setQuickRepliesNotice(null);
        setQuickRepliesDraft(prev => prev.filter((_, idx) => idx !== index));
    }, []);

    const handleSaveQuickReplies = React.useCallback(async () => {
        if (!profileId || !sessionToken) return;
        setQuickRepliesSaving(true);
        setQuickRepliesError(null);
        setQuickRepliesNotice(null);

        const seen = new Set<string>();
        const cleaned: Array<{
            shortcut: string;
            text: string;
            message_type: 'text' | 'image' | 'video' | 'document';
            media_storage: 'external' | 'r2';
            media_asset_key: string | null;
            media_mime_type: string | null;
            media_size_bytes: number | null;
            media_url: string | null;
            media_filename: string | null;
        }> = [];

        for (const item of quickRepliesDraft) {
            const shortcut = normalizeQuickReplyShortcut(item.shortcut);
            const text = typeof item.text === 'string' ? item.text.trim() : '';
            const messageType = normalizeQuickReplyMessageType(item.message_type);
            const mediaStorage = normalizeQuickReplyMediaStorage(item.media_storage);
            const mediaAssetKey = normalizeQuickReplyMediaAssetKey(item.media_asset_key);
            const resolvedMediaStorage: 'external' | 'r2' = mediaAssetKey ? 'r2' : mediaStorage;
            const mediaMimeType = normalizeQuickReplyMediaMimeType(item.media_mime_type);
            const mediaSizeBytes = normalizeQuickReplyMediaSizeBytes(item.media_size_bytes);
            const mediaUrl = normalizeQuickReplyMediaUrl(item.media_url);
            const mediaFilename = normalizeQuickReplyMediaFilename(item.media_filename);
            if (!shortcut) continue;
            if (seen.has(shortcut)) {
                setQuickRepliesError(`Duplicate shortcut: /${shortcut}`);
                setQuickRepliesSaving(false);
                return;
            }
            if (messageType === 'text') {
                if (!text) continue;
            } else if (resolvedMediaStorage === 'r2') {
                if (!mediaAssetKey) continue;
            } else if (!mediaUrl) {
                continue;
            }
            seen.add(shortcut);
            cleaned.push({
                shortcut,
                text,
                message_type: messageType,
                media_storage: messageType === 'text' ? 'external' : resolvedMediaStorage,
                media_asset_key: messageType === 'text' || resolvedMediaStorage !== 'r2' ? null : mediaAssetKey,
                media_mime_type: messageType === 'text' || resolvedMediaStorage !== 'r2' ? null : (mediaMimeType || null),
                media_size_bytes: messageType === 'text' || resolvedMediaStorage !== 'r2' ? null : mediaSizeBytes,
                media_url: messageType === 'text' || resolvedMediaStorage === 'r2' ? null : mediaUrl,
                media_filename: messageType === 'document' && mediaFilename ? mediaFilename : null
            });
        }

        try {
            const res = await fetch(`${apiBaseUrl}/api/company/quick-replies?profileId=${encodeURIComponent(profileId)}`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${sessionToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ items: cleaned })
            });
            const text = await res.text();
            let data: any = null;
            try {
                data = JSON.parse(text);
            } catch {
                console.error('Quick replies save failed:', text);
            }
            if (!res.ok || !data?.success) {
                setQuickRepliesError(data?.error || 'Failed to save quick replies');
                return;
            }
            const updated = Array.isArray(data.data) ? data.data.map((item: any) => normalizeQuickReplyRecord(item)) : [];
            setQuickRepliesDraft(updated);
            onQuickRepliesUpdated();
            setQuickRepliesNotice('Quick replies saved.');
        } catch (err: any) {
            setQuickRepliesError(err?.message || 'Failed to save quick replies');
        } finally {
            setQuickRepliesSaving(false);
        }
    }, [apiBaseUrl, normalizeQuickReplyRecord, normalizeQuickReplyShortcut, onQuickRepliesUpdated, profileId, quickRepliesDraft, sessionToken]);

    const canManageFallback = Boolean(profileId && sessionToken);
    const quickRepliesHasPendingUpload = React.useMemo(
        () => quickRepliesDraft.some((item) => item.ui_uploading),
        [quickRepliesDraft]
    );

    const fetchFallbackSettings = React.useCallback(() => {
        if (!profileId || !sessionToken) return;
        setFallbackLoading(true);
        setFallbackError(null);
        setFallbackNotice(null);
        fetch(`${apiBaseUrl}/api/company/fallback-settings?profileId=${encodeURIComponent(profileId)}`, {
            headers: {
                Authorization: `Bearer ${sessionToken}`
            }
        })
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    console.error('Fallback settings fetch failed:', text);
                    return null;
                }
            })
            .then(data => {
                if (data?.success) {
                    const cfg = data?.data || {};
                    setFallbackConfig({
                        text: typeof cfg.fallback_text === 'string' ? cfg.fallback_text : '',
                        limit: typeof cfg.fallback_limit === 'number' ? cfg.fallback_limit : 3
                    });
                } else {
                    setFallbackError(data?.error || 'Failed to load fallback settings');
                }
            })
            .finally(() => setFallbackLoading(false));
    }, [apiBaseUrl, profileId, sessionToken]);

    const handleSaveFallbackSettings = React.useCallback(() => {
        if (!profileId || !sessionToken) return;
        setFallbackSaving(true);
        setFallbackError(null);
        setFallbackNotice(null);
        const payload = {
            fallback_text: fallbackConfig.text,
            fallback_limit: fallbackConfig.limit === '' ? null : Number(fallbackConfig.limit)
        };
        fetch(`${apiBaseUrl}/api/company/fallback-settings`, {
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
                    console.error('Fallback settings save failed:', text);
                    return null;
                }
            })
            .then(data => {
                if (data?.success) {
                    setFallbackNotice('Fallback settings saved.');
                } else {
                    setFallbackError(data?.error || 'Failed to save fallback settings');
                }
            })
            .finally(() => setFallbackSaving(false));
    }, [apiBaseUrl, fallbackConfig.limit, fallbackConfig.text, profileId, sessionToken]);

    const handleOpenWorkflowBuilder = () => {
        const hasAnyWorkflow = workflows.some((wf: any) => Boolean(getWorkflowId(wf?.id)));
        if (hasAnyWorkflow) {
            // Let parent choose the currently selected workflow first.
            onOpenBuilder(null);
            return;
        }
        // If no workflow exists yet, create one and open builder immediately.
        onCreateWorkflow();
    };

    return (
        <div className="h-screen pt-[64px] lg:pt-[72px] pb-[76px] lg:pb-0 bg-[#f8f9fa] text-[#111b21] font-sans">
            <div className={`h-full max-w-6xl mx-auto flex flex-col p-3 sm:p-4 md:p-6 gap-3 ${isMobileView ? 'overflow-y-auto custom-scrollbar' : 'overflow-hidden'}`}>
                <div className={isMobileView ? 'px-1 py-1' : 'bg-white border border-[#e6ebef] rounded-2xl p-4 md:p-5'}>
                    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                        <div>
                            <h2 className="text-lg md:text-xl font-semibold text-[#111b21] tracking-tight">Automations</h2>
                            <p className="text-[11px] text-[#54656f] mt-1">
                                Your saved workflows for this company profile.
                            </p>
                        </div>
                        {!isMobileView && (
                            <div className="flex items-center gap-1.5">
                                <button
                                    type="button"
                                    {...bindOpenHandlers(onCreateWorkflow)}
                                    className="h-8 px-3 rounded-lg bg-[#00a884] text-white text-[10px] font-semibold uppercase tracking-wide hover:bg-[#008f6f] transition-all inline-flex items-center gap-1 cursor-pointer"
                                >
                                    <Plus className="w-3 h-3" />
                                    New Automation
                                </button>
                                <button
                                    type="button"
                                    {...bindOpenHandlers(handleOpenWorkflowBuilder)}
                                    className="h-8 px-3 rounded-lg border border-[#d8dee4] bg-white text-[#1f2a33] text-[10px] font-semibold uppercase tracking-wide hover:bg-[#f7f9fb] transition-all inline-flex items-center gap-1 cursor-pointer pointer-events-auto"
                                >
                                    <Workflow className="w-3 h-3" />
                                    Open Workflow Builder
                                </button>
                            </div>
                        )}
                    </div>
                </div>

                <div className={isMobileView ? 'px-1 py-1' : 'bg-white border border-[#e6ebef] rounded-2xl p-4 md:p-5'}>
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <h3 className="text-base md:text-lg font-semibold text-[#111b21] tracking-tight">Automation Tools</h3>
                            <p className="text-[11px] text-[#54656f] mt-1">
                                Open each tool in its own window.
                            </p>
                        </div>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                        <button
                            type="button"
                            onClick={() => {
                                setShowFallbackModal(true);
                                fetchFallbackSettings();
                            }}
                            className="h-8 px-3 rounded-lg border border-[#d8dee4] bg-white text-[#1f2a33] text-[10px] font-semibold uppercase tracking-wide hover:bg-[#f7f9fb] transition-all inline-flex items-center gap-1.5"
                        >
                            <MessageSquare className="w-3.5 h-3.5" />
                            Fallback Message
                        </button>
                        <button
                            type="button"
                            {...bindOpenHandlers(handleOpenTriggerModal)}
                            className="h-8 px-3 rounded-lg border border-[#d8dee4] bg-white text-[#1f2a33] text-[10px] font-semibold uppercase tracking-wide hover:bg-[#f7f9fb] transition-all inline-flex items-center gap-1.5"
                        >
                            <Workflow className="w-3.5 h-3.5" />
                            Trigger
                        </button>
                        <button
                            type="button"
                            {...bindOpenHandlers(handleOpenConversationalModal)}
                            className="h-8 px-3 rounded-lg border border-[#d8dee4] bg-white text-[#1f2a33] text-[10px] font-semibold uppercase tracking-wide hover:bg-[#f7f9fb] transition-all inline-flex items-center gap-1.5"
                        >
                            <Settings2 className="w-3.5 h-3.5" />
                            Conversational Components
                        </button>
                        <button
                            type="button"
                            {...bindOpenHandlers(handleOpenReminderModal)}
                            className="h-8 px-3 rounded-lg border border-[#d8dee4] bg-white text-[#1f2a33] text-[10px] font-semibold uppercase tracking-wide hover:bg-[#f7f9fb] transition-all inline-flex items-center gap-1.5"
                        >
                            <Settings2 className="w-3.5 h-3.5" />
                            24h Window Reminder
                        </button>
                        <button
                            type="button"
                            {...bindOpenHandlers(handleOpenQuickRepliesModal)}
                            className="h-8 px-3 rounded-lg border border-[#d8dee4] bg-white text-[#1f2a33] text-[10px] font-semibold uppercase tracking-wide hover:bg-[#f7f9fb] transition-all inline-flex items-center gap-1.5"
                        >
                            <Settings2 className="w-3.5 h-3.5" />
                            Quick Reply
                        </button>
                    </div>
                </div>

                <div className={isMobileView ? 'pb-3' : 'flex-1 min-h-0 bg-white border border-[#e6ebef] rounded-2xl overflow-hidden'}>
                    {workflowsLoading ? (
                        <div className={isMobileView ? 'p-2' : 'h-full overflow-y-auto custom-scrollbar p-4 md:p-5'}>
                            <div className="animate-pulse space-y-3">
                                {workflowSkeletonRows.map((row) => (
                                    <div
                                        key={`automation-skeleton-${row}`}
                                        className="grid grid-cols-12 gap-2 px-2 md:px-0 py-2 border-b border-[#eef2f5] last:border-b-0"
                                    >
                                        <div className="col-span-12 md:col-span-3 space-y-2">
                                            <div className="h-3 w-32 rounded bg-[#e8edf1]" />
                                            <div className="h-2.5 w-20 rounded bg-[#eef2f5]" />
                                        </div>
                                        <div className="col-span-7 md:col-span-3">
                                            <div className="h-3 w-24 rounded bg-[#eef2f5]" />
                                        </div>
                                        <div className="col-span-2 md:col-span-1">
                                            <div className="h-3 w-8 rounded bg-[#eef2f5]" />
                                        </div>
                                        <div className="col-span-3 md:col-span-1">
                                            <div className="h-5 w-14 rounded-full bg-[#eef2f5]" />
                                        </div>
                                        <div className="col-span-12 md:col-span-4 flex md:justify-end gap-2">
                                            <div className="h-7 w-16 rounded-md bg-[#e8edf1]" />
                                            <div className="h-7 w-14 rounded-md bg-[#eef2f5]" />
                                            <div className="h-7 w-12 rounded-md bg-[#eef2f5]" />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ) : workflows.length === 0 ? (
                        <div className="h-full flex flex-col items-center justify-center text-center px-6">
                            <Workflow className="w-12 h-12 text-[#aebac1] mb-3" />
                            <p className="text-[#111b21] font-bold">No workflows yet</p>
                            <p className="text-xs text-[#8696a0] mt-1 mb-4">
                                {isMobileView
                                    ? 'No automations configured yet.'
                                    : 'Create your first automation workflow in Chatflow builder.'}
                            </p>
                            {!isMobileView && (
                                <button
                                    type="button"
                                    {...bindOpenHandlers(onCreateWorkflow)}
                                    className="h-8 px-3 rounded-lg bg-[#00a884] text-white text-[10px] font-semibold uppercase tracking-wide hover:bg-[#008f6f] transition-all inline-flex items-center gap-1 cursor-pointer"
                                >
                                    Create Workflow
                                </button>
                            )}
                        </div>
                    ) : (
                        <div className={isMobileView ? '' : 'h-full overflow-y-auto custom-scrollbar'}>
                            <div className="hidden md:grid grid-cols-12 gap-2 px-4 py-2 border-b border-[#eef2f5] bg-[#fcfdfe]">
                                <span className="col-span-3 text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97]">Workflow</span>
                                <span className="col-span-3 text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97]">Trigger</span>
                                <span className="col-span-1 text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97]">Steps</span>
                                <span className="col-span-1 text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97]">Status</span>
                                <span className="col-span-4 text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97] text-right">Actions</span>
                            </div>

                            <div className="divide-y divide-[#eef2f5]">
                                {workflows.map((wf: any, idx: number) => {
                                    const workflowId = getWorkflowId(wf?.id);
                                    const workflowName = getWorkflowName(wf?.name);
                                    const workflowLabel = workflowName || 'Untitled workflow';
                                    const actionCount = Array.isArray(wf?.actions) ? wf.actions.length : 0;
                                    const triggerKeyword = (wf?.trigger_keyword || '').toString().trim();
                                    const isEnabled = wf?.enabled !== false;
                                    const openRowBuilder = () => {
                                        if (workflowId) onOpenBuilder(workflowId);
                                        else handleOpenWorkflowBuilder();
                                    };
                                    const rowHandlers = isMobileView ? {} : bindOpenHandlers(openRowBuilder);
                                    return (
                                        <div
                                            key={`automation-workflow-${workflowLabel}-${idx}`}
                                            {...rowHandlers}
                                            className={`grid grid-cols-12 gap-2 px-4 py-3 transition-colors ${isMobileView ? '' : 'hover:bg-[#fafcfd] cursor-pointer'}`}
                                        >
                                            <div className="col-span-12 md:col-span-3 min-w-0">
                                                <p className="text-[12px] font-semibold text-[#111b21] truncate">{workflowLabel}</p>
                                                {!workflowName && !isMobileView && (
                                                    <p className="text-[10px] text-[#8c9aa4] mt-0.5">Set name in workflow builder</p>
                                                )}
                                            </div>

                                            <div className="col-span-8 md:col-span-3 min-w-0">
                                                <p className="text-[11px] text-[#4b5c68] truncate">{triggerKeyword || 'manual only'}</p>
                                            </div>

                                            <div className="col-span-4 md:col-span-1">
                                                <span className="inline-flex items-center text-[11px] text-[#4b5c68] font-medium">
                                                    {actionCount}
                                                </span>
                                            </div>

                                            <div className="col-span-6 md:col-span-1">
                                                <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[9px] font-semibold uppercase tracking-wide ${isEnabled
                                                    ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                                                    : 'bg-slate-50 border-slate-200 text-slate-600'
                                                    }`}>
                                                    {isEnabled ? 'On' : 'Off'}
                                                </span>
                                            </div>

                                            <div className="col-span-6 md:col-span-4 flex items-center justify-start md:justify-end gap-1.5">
                                                {!isMobileView && (
                                                    <>
                                                        <button
                                                            type="button"
                                                            disabled={!workflowId}
                                                            onClick={(event) => {
                                                                event.stopPropagation();
                                                                if (!workflowId) return;
                                                                runOncePerTap(() => onOpenBuilder(workflowId));
                                                            }}
                                                            onMouseDown={(event) => {
                                                                event.stopPropagation();
                                                                if (!workflowId) return;
                                                                runOncePerTap(() => onOpenBuilder(workflowId));
                                                            }}
                                                            onTouchStart={(event) => {
                                                                event.stopPropagation();
                                                                if (!workflowId) return;
                                                                runOncePerTap(() => onOpenBuilder(workflowId));
                                                            }}
                                                            className="h-7 px-2.5 rounded-md bg-[#00a884] text-white text-[9px] font-semibold uppercase tracking-wide hover:bg-[#008f6f] transition-all cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                                                        >
                                                            Builder
                                                        </button>
                                                        <button
                                                            type="button"
                                                            disabled={!workflowId}
                                                            onClick={(event) => {
                                                                event.stopPropagation();
                                                                if (!workflowId) return;
                                                                runOncePerTap(() => onCopyWorkflow(workflowId));
                                                            }}
                                                            onMouseDown={(event) => {
                                                                event.stopPropagation();
                                                                if (!workflowId) return;
                                                                runOncePerTap(() => onCopyWorkflow(workflowId));
                                                            }}
                                                            onTouchStart={(event) => {
                                                                event.stopPropagation();
                                                                if (!workflowId) return;
                                                                runOncePerTap(() => onCopyWorkflow(workflowId));
                                                            }}
                                                            className="h-7 px-2.5 rounded-md border border-[#dbe2e8] bg-white text-[#334155] text-[9px] font-semibold uppercase tracking-wide transition-all inline-flex items-center justify-center gap-1 hover:bg-[#f8fafc] disabled:opacity-60 disabled:cursor-not-allowed"
                                                        >
                                                            <Copy className="w-3 h-3" />
                                                            Copy
                                                        </button>
                                                    </>
                                                )}
                                                <button
                                                    type="button"
                                                    disabled={!workflowId}
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                        if (!workflowId) return;
                                                        runOncePerTap(() => onToggleWorkflowEnabled(workflowId, !isEnabled));
                                                    }}
                                                    onMouseDown={(event) => {
                                                        event.stopPropagation();
                                                        if (!workflowId) return;
                                                        runOncePerTap(() => onToggleWorkflowEnabled(workflowId, !isEnabled));
                                                    }}
                                                    onTouchStart={(event) => {
                                                        event.stopPropagation();
                                                        if (!workflowId) return;
                                                        runOncePerTap(() => onToggleWorkflowEnabled(workflowId, !isEnabled));
                                                    }}
                                                    className={`h-7 px-2.5 rounded-md border text-[9px] font-semibold uppercase tracking-wide transition-all inline-flex items-center justify-center gap-1 disabled:opacity-60 disabled:cursor-not-allowed ${isEnabled
                                                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                                                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                                                        } cursor-pointer`}
                                                >
                                                    <Check className="w-3 h-3" />
                                                    {isEnabled ? 'Untick To Off' : 'Tick To Run'}
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>

                {showConversationalModal && (
                    <div className="fixed inset-0 z-[170] bg-[#111b21]/45 backdrop-blur-[1px] flex items-center justify-center p-4">
                        <div className="w-full max-w-5xl bg-white border border-[#e6ebef] rounded-2xl p-4 md:p-5 shadow-[0_24px_70px_rgba(0,0,0,0.2)] max-h-[90vh] overflow-y-auto custom-scrollbar">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <h3 className="text-base md:text-lg font-semibold text-[#111b21] tracking-tight">Conversational Components</h3>
                                    <p className="text-[11px] text-[#54656f] mt-1">
                                        Configure welcome message, ice breakers, and slash commands.
                                    </p>
                                </div>
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={fetchConversationalSettings}
                                        disabled={!canManageFallback || autoLoading || autoSaving}
                                        className="h-8 px-3 rounded-lg border border-[#d8dee4] bg-white text-[#1f2a33] text-[10px] font-semibold uppercase tracking-wide hover:bg-[#f7f9fb] transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                                    >
                                        {autoLoading ? 'Refreshing…' : 'Refresh'}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setShowConversationalModal(false)}
                                        className="h-8 w-8 rounded-lg border border-[#d8dee4] bg-white text-[#6b7280] hover:bg-[#f7f9fb] transition-all inline-flex items-center justify-center"
                                        aria-label="Close conversational components window"
                                    >
                                        <X className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>

                            {!canManageFallback && (
                                <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
                                    Select a profile and make sure you are logged in to manage conversational components.
                                </div>
                            )}

                            {autoError && (
                                <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700">
                                    {autoError}
                                </div>
                            )}

                            {autoNotice && (
                                <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-700">
                                    {autoNotice}
                                </div>
                            )}

                            {autoLoading ? (
                                <div className="mt-4 animate-pulse grid grid-cols-1 lg:grid-cols-3 gap-3">
                                    <div className="h-40 rounded-2xl bg-[#eef2f5]" />
                                    <div className="h-40 rounded-2xl bg-[#eef2f5]" />
                                    <div className="h-40 rounded-2xl bg-[#eef2f5]" />
                                </div>
                            ) : (
                                <div className="mt-3 grid grid-cols-1 lg:grid-cols-3 gap-3">
                                    <div className="rounded-2xl border border-[#dfe6eb] bg-[#f8f9fa] p-3">
                                        <div className="flex items-center justify-between">
                                            <span className="text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97]">Welcome Message</span>
                                            <input
                                                type="checkbox"
                                                className="h-4 w-4 rounded border-[#c8d2da] text-[#00a884] focus:ring-[#00a884]"
                                                checked={autoConfig.enable_welcome_message}
                                                onChange={(e) => {
                                                    setAutoNotice(null);
                                                    setAutoConfig((prev) => ({ ...prev, enable_welcome_message: e.target.checked }));
                                                }}
                                                disabled={!canManageFallback || autoSaving}
                                            />
                                        </div>
                                        <p className="text-[11px] text-[#7a8b97] mt-2 leading-relaxed">
                                            Enable to receive <code className="font-mono">request_welcome</code> trigger from Meta for first-time chats.
                                        </p>
                                    </div>

                                    <div className="rounded-2xl border border-[#dfe6eb] bg-[#f8f9fa] p-3">
                                        <div className="flex items-center justify-between">
                                            <span className="text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97]">Ice Breakers</span>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setAutoNotice(null);
                                                    setAutoConfig((prev) => ({
                                                        ...prev,
                                                        prompts: [...(prev.prompts || []), '']
                                                    }));
                                                }}
                                                disabled={!canManageFallback || autoSaving}
                                                className="text-[11px] font-semibold text-[#00a884] hover:underline disabled:opacity-60 disabled:no-underline"
                                            >
                                                + Add
                                            </button>
                                        </div>
                                        <div className="mt-2 space-y-2">
                                            {(autoConfig.prompts || []).map((prompt, idx) => (
                                                <div key={`ice-breaker-${idx}`} className="flex items-center gap-2">
                                                    <input
                                                        type="text"
                                                        className="flex-1 bg-white border border-[#dfe6eb] rounded-lg px-3 py-2 text-xs text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                                        value={prompt}
                                                        onChange={(e) => {
                                                            setAutoNotice(null);
                                                            const next = [...(autoConfig.prompts || [])];
                                                            next[idx] = e.target.value;
                                                            setAutoConfig((prev) => ({ ...prev, prompts: next }));
                                                        }}
                                                        placeholder="Ask for support"
                                                        disabled={!canManageFallback || autoSaving}
                                                    />
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            setAutoNotice(null);
                                                            const next = (autoConfig.prompts || []).filter((_, i) => i !== idx);
                                                            setAutoConfig((prev) => ({ ...prev, prompts: next }));
                                                        }}
                                                        disabled={!canManageFallback || autoSaving}
                                                        className="text-[11px] font-semibold text-rose-600 disabled:opacity-60"
                                                    >
                                                        Remove
                                                    </button>
                                                </div>
                                            ))}
                                            {(autoConfig.prompts || []).length === 0 && (
                                                <p className="text-[11px] text-[#7a8b97]">No ice breakers configured.</p>
                                            )}
                                        </div>
                                    </div>

                                    <div className="rounded-2xl border border-[#dfe6eb] bg-[#f8f9fa] p-3">
                                        <div className="flex items-center justify-between">
                                            <span className="text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97]">Commands</span>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    if ((autoConfig.commands || []).length >= COMMAND_MAX_COUNT) {
                                                        setAutoError(`Maximum ${COMMAND_MAX_COUNT} commands are allowed.`);
                                                        return;
                                                    }
                                                    setAutoError(null);
                                                    setAutoNotice(null);
                                                    setAutoConfig((prev) => ({
                                                        ...prev,
                                                        commands: [...(prev.commands || []), { command_name: '', command_description: '' }]
                                                    }));
                                                }}
                                                disabled={!canManageFallback || autoSaving || (autoConfig.commands || []).length >= COMMAND_MAX_COUNT}
                                                className="text-[11px] font-semibold text-[#00a884] hover:underline disabled:opacity-60 disabled:no-underline"
                                            >
                                                + Add
                                            </button>
                                        </div>
                                        <p className="text-[11px] text-[#7a8b97] mt-2">
                                            Use slash commands like <code className="font-mono">/help</code>.
                                        </p>
                                        <div className="mt-2 space-y-2">
                                            {(autoConfig.commands || []).map((cmd, idx) => (
                                                <div key={`conversation-command-${idx}`} className="rounded-xl border border-[#dfe6eb] bg-white p-2">
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-xs font-semibold text-[#7a8b97]">/</span>
                                                        <input
                                                            type="text"
                                                            className="flex-1 bg-[#f8f9fa] border border-[#dfe6eb] rounded-lg px-2.5 py-1.5 text-xs text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                                            value={cmd.command_name}
                                                            maxLength={COMMAND_NAME_MAX_LENGTH}
                                                            onChange={(e) => {
                                                                setAutoNotice(null);
                                                                const next = [...(autoConfig.commands || [])];
                                                                next[idx] = {
                                                                    ...next[idx],
                                                                    command_name: e.target.value
                                                                };
                                                                setAutoConfig((prev) => ({ ...prev, commands: next }));
                                                            }}
                                                            placeholder="help"
                                                            disabled={!canManageFallback || autoSaving}
                                                        />
                                                        <span className="text-[10px] text-[#7a8b97] w-14 text-right">
                                                            {normalizeCommandName(cmd.command_name).length}/{COMMAND_NAME_MAX_LENGTH}
                                                        </span>
                                                    </div>
                                                    <input
                                                        type="text"
                                                        className="mt-2 w-full bg-[#f8f9fa] border border-[#dfe6eb] rounded-lg px-2.5 py-1.5 text-xs text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                                        value={cmd.command_description}
                                                        maxLength={COMMAND_DESCRIPTION_MAX_LENGTH}
                                                        onChange={(e) => {
                                                            setAutoNotice(null);
                                                            const next = [...(autoConfig.commands || [])];
                                                            next[idx] = {
                                                                ...next[idx],
                                                                command_description: e.target.value
                                                            };
                                                            setAutoConfig((prev) => ({ ...prev, commands: next }));
                                                        }}
                                                        placeholder="Show support options"
                                                        disabled={!canManageFallback || autoSaving}
                                                    />
                                                    <div className="mt-2 flex items-center justify-between">
                                                        <span className="text-[10px] text-[#7a8b97]">
                                                            {normalizeCommandDescription(cmd.command_description).length}/{COMMAND_DESCRIPTION_MAX_LENGTH}
                                                        </span>
                                                        <button
                                                            type="button"
                                                            onClick={() => {
                                                                setAutoNotice(null);
                                                                const next = (autoConfig.commands || []).filter((_, i) => i !== idx);
                                                                setAutoConfig((prev) => ({ ...prev, commands: next }));
                                                            }}
                                                            disabled={!canManageFallback || autoSaving}
                                                            className="text-[11px] font-semibold text-rose-600 disabled:opacity-60"
                                                        >
                                                            Remove
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                            {(autoConfig.commands || []).length === 0 && (
                                                <p className="text-[11px] text-[#7a8b97]">No commands configured.</p>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )}

                            <div className="mt-4 flex justify-end">
                                <button
                                    type="button"
                                    onClick={handleSaveConversationalSettings}
                                    disabled={!canManageFallback || autoLoading || autoSaving}
                                    className="h-8 px-3 rounded-lg bg-[#00a884] text-white text-[10px] font-semibold uppercase tracking-wide hover:bg-[#008f6f] transition-all inline-flex items-center gap-1 disabled:opacity-60 disabled:cursor-not-allowed"
                                >
                                    {autoSaving ? 'Saving…' : 'Save Conversational Components'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {showReminderModal && (
                    <div className="fixed inset-0 z-[170] bg-[#111b21]/45 backdrop-blur-[1px] flex items-center justify-center p-4">
                        <div className="w-full max-w-3xl bg-white border border-[#e6ebef] rounded-2xl p-4 md:p-5 shadow-[0_24px_70px_rgba(0,0,0,0.2)]">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <h3 className="text-base md:text-lg font-semibold text-[#111b21] tracking-tight">24h Window Reminder</h3>
                                    <p className="text-[11px] text-[#54656f] mt-1">
                                        Send reminder before 24h reply window closes. Use <code className="font-mono">{'{minutes}'}</code> in text.
                                    </p>
                                </div>
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={fetchWindowReminderSettings}
                                        disabled={!canManageFallback || reminderLoading || reminderSaving}
                                        className="h-8 px-3 rounded-lg border border-[#d8dee4] bg-white text-[#1f2a33] text-[10px] font-semibold uppercase tracking-wide hover:bg-[#f7f9fb] transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                                    >
                                        {reminderLoading ? 'Refreshing…' : 'Refresh'}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setShowReminderModal(false)}
                                        className="h-8 w-8 rounded-lg border border-[#d8dee4] bg-white text-[#6b7280] hover:bg-[#f7f9fb] transition-all inline-flex items-center justify-center"
                                        aria-label="Close 24h window reminder window"
                                    >
                                        <X className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>

                            {!canManageFallback && (
                                <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
                                    Select a profile and make sure you are logged in to manage window reminder settings.
                                </div>
                            )}

                            {reminderError && (
                                <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700">
                                    {reminderError}
                                </div>
                            )}

                            {reminderNotice && (
                                <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-700">
                                    {reminderNotice}
                                </div>
                            )}

                            {reminderLoading ? (
                                <div className="mt-4 animate-pulse grid grid-cols-1 lg:grid-cols-3 gap-3">
                                    <div className="h-28 rounded-2xl bg-[#eef2f5]" />
                                    <div className="h-28 rounded-2xl bg-[#eef2f5]" />
                                    <div className="h-28 rounded-2xl bg-[#eef2f5]" />
                                </div>
                            ) : (
                                <div className="mt-3 grid grid-cols-1 lg:grid-cols-3 gap-3">
                                    <div className="rounded-2xl border border-[#dfe6eb] bg-[#f8f9fa] p-3 flex items-center justify-between">
                                        <span className="text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97]">Enabled</span>
                                        <input
                                            type="checkbox"
                                            className="h-4 w-4 rounded border-[#c8d2da] text-[#00a884] focus:ring-[#00a884]"
                                            checked={reminderConfig.enabled}
                                            onChange={(e) => {
                                                setReminderNotice(null);
                                                setReminderConfig((prev) => ({ ...prev, enabled: e.target.checked }));
                                            }}
                                            disabled={!canManageFallback || reminderSaving}
                                        />
                                    </div>

                                    <div className="rounded-2xl border border-[#dfe6eb] bg-[#f8f9fa] p-3">
                                        <label className="text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97]">Reminder Minutes</label>
                                        <input
                                            type="number"
                                            min={1}
                                            className="mt-2 w-full bg-white border border-[#dfe6eb] rounded-lg px-3 py-2 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                            value={reminderConfig.minutes}
                                            onChange={(e) => {
                                                setReminderNotice(null);
                                                const next = e.target.value === '' ? '' : Number(e.target.value);
                                                setReminderConfig((prev) => ({ ...prev, minutes: next }));
                                            }}
                                            placeholder="30"
                                            disabled={!canManageFallback || reminderSaving}
                                        />
                                    </div>

                                    <div className="rounded-2xl border border-[#dfe6eb] bg-[#f8f9fa] p-3">
                                        <label className="text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97]">Reminder Text</label>
                                        <textarea
                                            className="mt-2 w-full min-h-[92px] bg-white border border-[#dfe6eb] rounded-lg px-3 py-2 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884] resize-none"
                                            value={reminderConfig.text}
                                            onChange={(e) => {
                                                setReminderNotice(null);
                                                setReminderConfig((prev) => ({ ...prev, text: e.target.value }));
                                            }}
                                            placeholder="Heads up! Our 24h reply window closes in {minutes} minutes."
                                            disabled={!canManageFallback || reminderSaving}
                                        />
                                    </div>
                                </div>
                            )}

                            <div className="mt-4 flex justify-end">
                                <button
                                    type="button"
                                    onClick={handleSaveReminderSettings}
                                    disabled={!canManageFallback || reminderLoading || reminderSaving}
                                    className="h-8 px-3 rounded-lg bg-[#00a884] text-white text-[10px] font-semibold uppercase tracking-wide hover:bg-[#008f6f] transition-all inline-flex items-center gap-1 disabled:opacity-60 disabled:cursor-not-allowed"
                                >
                                    {reminderSaving ? 'Saving…' : 'Save Window Reminder'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {showQuickRepliesModal && (
                    <div className="fixed inset-0 z-[170] bg-[#111b21]/45 backdrop-blur-[1px] flex items-center justify-center p-4">
                        <div className="w-full max-w-4xl bg-white border border-[#e6ebef] rounded-2xl p-4 md:p-5 shadow-[0_24px_70px_rgba(0,0,0,0.2)] max-h-[90vh] overflow-y-auto custom-scrollbar">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <h3 className="text-base md:text-lg font-semibold text-[#111b21] tracking-tight">Quick Replies</h3>
                                    <p className="text-[11px] text-[#54656f] mt-1">
                                        Type <code className="font-mono">/shortcut</code> in chat to send text or media (image, video, document).
                                    </p>
                                </div>
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={fetchQuickReplies}
                                        disabled={!canManageFallback || quickRepliesLoading || quickRepliesSaving}
                                        className="h-8 px-3 rounded-lg border border-[#d8dee4] bg-white text-[#1f2a33] text-[10px] font-semibold uppercase tracking-wide hover:bg-[#f7f9fb] transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                                    >
                                        {quickRepliesLoading ? 'Refreshing…' : 'Refresh'}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setShowQuickRepliesModal(false)}
                                        className="h-8 w-8 rounded-lg border border-[#d8dee4] bg-white text-[#6b7280] hover:bg-[#f7f9fb] transition-all inline-flex items-center justify-center"
                                        aria-label="Close quick reply window"
                                    >
                                        <X className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>

                            {!canManageFallback && (
                                <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
                                    Select a profile and make sure you are logged in to manage quick replies.
                                </div>
                            )}

                            {quickRepliesError && (
                                <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700">
                                    {quickRepliesError}
                                </div>
                            )}

                            {quickRepliesNotice && (
                                <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-700">
                                    {quickRepliesNotice}
                                </div>
                            )}

                            {quickRepliesLoading ? (
                                <div className="mt-4 animate-pulse space-y-3">
                                    <div className="h-20 rounded-2xl bg-[#eef2f5]" />
                                    <div className="h-20 rounded-2xl bg-[#eef2f5]" />
                                    <div className="h-20 rounded-2xl bg-[#eef2f5]" />
                                </div>
                            ) : (
                                <div className="mt-3 space-y-3">
                                    {quickRepliesDraft.length === 0 ? (
                                        <div className="rounded-2xl border border-dashed border-[#d7dfe2] bg-[#f8f9fa] px-4 py-5 text-[11px] text-[#7a8b97]">
                                            No quick replies yet. Add one below.
                                        </div>
                                    ) : (
                                        quickRepliesDraft.map((item, index) => {
                                            const messageType = normalizeQuickReplyMessageType(item.message_type);
                                            return (
                                                <div key={`quick-reply-${item.id || 'new'}-${index}`} className="rounded-2xl border border-[#dfe6eb] bg-[#f8f9fa] p-3">
                                                    <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                                                        <div className="md:col-span-4">
                                                            <label className="text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97]">Shortcut</label>
                                                            <input
                                                                type="text"
                                                                className="mt-2 w-full bg-white border border-[#dfe6eb] rounded-lg px-3 py-2 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                                                value={item.shortcut}
                                                                onChange={(e) => handleUpdateQuickReply(index, 'shortcut', e.target.value)}
                                                                placeholder="/hi"
                                                                disabled={!canManageFallback || quickRepliesSaving}
                                                            />
                                                        </div>

                                                        <div className="md:col-span-3">
                                                            <label className="text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97]">Type</label>
                                                            <select
                                                                className="mt-2 w-full bg-white border border-[#dfe6eb] rounded-lg px-3 py-2 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                                                value={messageType}
                                                                onChange={(e) => handleUpdateQuickReply(index, 'message_type', e.target.value)}
                                                                disabled={!canManageFallback || quickRepliesSaving}
                                                            >
                                                                <option value="text">Text</option>
                                                                <option value="image">Image</option>
                                                                <option value="video">Video</option>
                                                                <option value="document">Document</option>
                                                            </select>
                                                        </div>

                                                        <div className="md:col-span-5 flex md:items-end md:justify-end">
                                                            <button
                                                                type="button"
                                                                onClick={() => handleRemoveQuickReply(index)}
                                                                disabled={!canManageFallback || quickRepliesSaving}
                                                                className="h-8 px-3 rounded-lg border border-rose-200 bg-rose-50 text-rose-600 text-[10px] font-semibold uppercase tracking-wide hover:bg-rose-100 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                                                            >
                                                                Remove
                                                            </button>
                                                        </div>

                                                        {messageType === 'text' ? (
                                                            <div className="md:col-span-12">
                                                                <label className="text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97]">Message</label>
                                                                <textarea
                                                                    className="mt-2 w-full min-h-[88px] bg-white border border-[#dfe6eb] rounded-lg px-3 py-2 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884] resize-none"
                                                                    value={item.text}
                                                                    onChange={(e) => handleUpdateQuickReply(index, 'text', e.target.value)}
                                                                    placeholder="Hello! How can we help you today?"
                                                                    disabled={!canManageFallback || quickRepliesSaving}
                                                                />
                                                            </div>
                                                        ) : (
                                                            <>
                                                                <div className="md:col-span-12">
                                                                    <label className="text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97]">Upload Media</label>
                                                                    <input
                                                                        type="file"
                                                                        accept={messageType === 'image' ? 'image/*' : messageType === 'video' ? 'video/*' : '*/*'}
                                                                        className="mt-2 block w-full text-xs text-[#111b21] file:mr-3 file:rounded-lg file:border-0 file:bg-[#00a884] file:px-3 file:py-2 file:text-[11px] file:font-semibold file:text-white hover:file:bg-[#008f6f]"
                                                                        onChange={(e) => {
                                                                            const file = e.target.files?.[0] || null;
                                                                            e.target.value = '';
                                                                            void handleUploadQuickReplyMedia(index, file);
                                                                        }}
                                                                        disabled={!canManageFallback || quickRepliesSaving || item.ui_uploading}
                                                                    />
                                                                    <div className="mt-2 space-y-2">
                                                                        {item.ui_uploading && (
                                                                            <div className="rounded-xl border border-[#dfe6eb] bg-white px-3 py-2 text-[11px] text-[#54656f]">
                                                                                Uploading media…
                                                                            </div>
                                                                        )}
                                                                        {item.ui_upload_error && (
                                                                            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700">
                                                                                {item.ui_upload_error}
                                                                            </div>
                                                                        )}
                                                                        {item.media_asset_key && (
                                                                            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-700">
                                                                                Media uploaded to secure storage.
                                                                            </div>
                                                                        )}
                                                                        {!item.media_asset_key && item.media_url && (
                                                                            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
                                                                                Legacy external media URL is still active.
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                                {messageType === 'document' && (
                                                                    <div className="md:col-span-12">
                                                                        <label className="text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97]">Document Filename (optional)</label>
                                                                        <input
                                                                            type="text"
                                                                            className="mt-2 w-full bg-white border border-[#dfe6eb] rounded-lg px-3 py-2 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                                                            value={item.media_filename || ''}
                                                                            onChange={(e) => handleUpdateQuickReply(index, 'media_filename', e.target.value)}
                                                                            placeholder="brochure.pdf"
                                                                            disabled={!canManageFallback || quickRepliesSaving}
                                                                        />
                                                                    </div>
                                                                )}
                                                                <div className="md:col-span-12">
                                                                    <label className="text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97]">Caption (optional)</label>
                                                                    <textarea
                                                                        className="mt-2 w-full min-h-[72px] bg-white border border-[#dfe6eb] rounded-lg px-3 py-2 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884] resize-none"
                                                                        value={item.text}
                                                                        onChange={(e) => handleUpdateQuickReply(index, 'text', e.target.value)}
                                                                        placeholder="Optional text sent with media"
                                                                        disabled={!canManageFallback || quickRepliesSaving}
                                                                    />
                                                                </div>
                                                            </>
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })
                                    )}
                                </div>
                            )}

                            <div className="mt-4 flex items-center justify-between gap-3">
                                <button
                                    type="button"
                                    onClick={handleAddQuickReply}
                                    disabled={!canManageFallback || quickRepliesSaving}
                                    className="h-8 px-3 rounded-lg border border-[#d8dee4] bg-white text-[#1f2a33] text-[10px] font-semibold uppercase tracking-wide hover:bg-[#f7f9fb] transition-all inline-flex items-center gap-1 disabled:opacity-60 disabled:cursor-not-allowed"
                                >
                                    <Plus className="w-3 h-3" />
                                    Add Quick Reply
                                </button>
                                <button
                                    type="button"
                                    onClick={handleSaveQuickReplies}
                                    disabled={!canManageFallback || quickRepliesLoading || quickRepliesSaving || quickRepliesHasPendingUpload}
                                    className="h-8 px-3 rounded-lg bg-[#00a884] text-white text-[10px] font-semibold uppercase tracking-wide hover:bg-[#008f6f] transition-all inline-flex items-center gap-1 disabled:opacity-60 disabled:cursor-not-allowed"
                                >
                                    {quickRepliesSaving ? 'Saving…' : quickRepliesHasPendingUpload ? 'Uploading…' : 'Save Quick Replies'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {showFallbackModal && (
                    <div className="fixed inset-0 z-[170] bg-[#111b21]/45 backdrop-blur-[1px] flex items-center justify-center p-4">
                        <div className="w-full max-w-3xl bg-white border border-[#e6ebef] rounded-2xl p-4 md:p-5 shadow-[0_24px_70px_rgba(0,0,0,0.2)]">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <h3 className="text-base md:text-lg font-semibold text-[#111b21] tracking-tight">Fallback Message</h3>
                                    <p className="text-[11px] text-[#54656f] mt-1">
                                        Default reply when users press an invalid button or option.
                                    </p>
                                </div>
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={fetchFallbackSettings}
                                        disabled={!canManageFallback || fallbackLoading}
                                        className="h-8 px-3 rounded-lg border border-[#d8dee4] bg-white text-[#1f2a33] text-[10px] font-semibold uppercase tracking-wide hover:bg-[#f7f9fb] transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                                    >
                                        {fallbackLoading ? 'Refreshing…' : 'Refresh'}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setShowFallbackModal(false)}
                                        className="h-8 w-8 rounded-lg border border-[#d8dee4] bg-white text-[#6b7280] hover:bg-[#f7f9fb] transition-all inline-flex items-center justify-center"
                                        aria-label="Close fallback message window"
                                    >
                                        <X className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>

                            {!canManageFallback && (
                                <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
                                    Select a profile and make sure you are logged in to manage fallback settings.
                                </div>
                            )}

                            {fallbackError && (
                                <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700">
                                    {fallbackError}
                                </div>
                            )}

                            {fallbackNotice && (
                                <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-700">
                                    {fallbackNotice}
                                </div>
                            )}

                            <div className="mt-3 grid grid-cols-1 lg:grid-cols-3 gap-3">
                                <div className="lg:col-span-2">
                                    <label className="text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97]">Fallback Text</label>
                                    <textarea
                                        className="mt-2 w-full min-h-[92px] bg-[#f8f9fa] border border-[#dfe6eb] rounded-xl px-3 py-2 text-sm text-[#111b21] focus:outline-none focus:border-[#00a884] disabled:opacity-70"
                                        value={fallbackConfig.text}
                                        onChange={(e) => setFallbackConfig(prev => ({ ...prev, text: e.target.value }))}
                                        placeholder="automation not in setting"
                                        disabled={!canManageFallback || fallbackLoading || fallbackSaving}
                                    />
                                    <p className="text-[11px] text-[#7a8b97] mt-2">
                                        Leave empty to stop sending fallback replies.
                                    </p>
                                </div>
                                <div>
                                    <label className="text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97]">Max Times</label>
                                    <input
                                        type="number"
                                        min={0}
                                        className="mt-2 w-full bg-[#f8f9fa] border border-[#dfe6eb] rounded-xl px-3 py-2 text-sm font-semibold text-[#111b21] focus:outline-none focus:border-[#00a884] disabled:opacity-70"
                                        value={fallbackConfig.limit}
                                        onChange={(e) => {
                                            const next = e.target.value === '' ? '' : Number(e.target.value);
                                            setFallbackConfig(prev => ({ ...prev, limit: next }));
                                        }}
                                        placeholder="3"
                                        disabled={!canManageFallback || fallbackLoading || fallbackSaving}
                                    />
                                    <p className="text-[11px] text-[#7a8b97] mt-2">
                                        Set to <code className="font-mono">0</code> for unlimited replies.
                                    </p>
                                </div>
                            </div>

                            <div className="mt-4 flex justify-end">
                                <button
                                    type="button"
                                    onClick={handleSaveFallbackSettings}
                                    disabled={!canManageFallback || fallbackLoading || fallbackSaving}
                                    className="h-8 px-3 rounded-lg bg-[#00a884] text-white text-[10px] font-semibold uppercase tracking-wide hover:bg-[#008f6f] transition-all inline-flex items-center gap-1 disabled:opacity-60 disabled:cursor-not-allowed"
                                >
                                    {fallbackSaving ? 'Saving…' : 'Save Fallback Settings'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {showTriggerModal && (
                    <div className="fixed inset-0 z-[170] bg-[#111b21]/45 backdrop-blur-[1px] flex items-center justify-center p-4">
                        <div className="w-full max-w-xl bg-white border border-[#e6ebef] rounded-2xl p-4 md:p-5 shadow-[0_24px_70px_rgba(0,0,0,0.2)]">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <h3 className="text-base md:text-lg font-semibold text-[#111b21] tracking-tight">Workflow Trigger</h3>
                                    <p className="text-[11px] text-[#54656f] mt-1">
                                        Choose a workflow and set the trigger keyword.
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setShowTriggerModal(false)}
                                    className="h-8 w-8 rounded-lg border border-[#d8dee4] bg-white text-[#6b7280] hover:bg-[#f7f9fb] transition-all inline-flex items-center justify-center"
                                    aria-label="Close trigger window"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            </div>

                            {workflowsLoading ? (
                                <div className="mt-4 animate-pulse space-y-3">
                                    <div className="h-3 w-28 rounded bg-[#e8edf1]" />
                                    <div className="h-10 w-full rounded-xl bg-[#eef2f5]" />
                                    <div className="h-3 w-32 rounded bg-[#e8edf1]" />
                                    <div className="h-10 w-full rounded-xl bg-[#eef2f5]" />
                                    <div className="h-12 w-full rounded-xl bg-[#eef2f5]" />
                                    <div className="h-8 w-28 rounded-lg bg-[#e8edf1] ml-auto" />
                                </div>
                            ) : triggerWorkflowChoices.length === 0 ? (
                                <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-[11px] text-amber-700">
                                    No workflow available yet. Create a workflow first.
                                    <div className="mt-2">
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setShowTriggerModal(false);
                                                onCreateWorkflow();
                                            }}
                                            className="h-8 px-3 rounded-lg bg-[#00a884] text-white text-[10px] font-semibold uppercase tracking-wide hover:bg-[#008f6f] transition-all inline-flex items-center gap-1"
                                        >
                                            <Plus className="w-3 h-3" />
                                            Create Workflow
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    {triggerError && (
                                        <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700">
                                            {triggerError}
                                        </div>
                                    )}

                                    {triggerNotice && (
                                        <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-700">
                                            {triggerNotice}
                                        </div>
                                    )}

                                    <div className="mt-3 grid grid-cols-1 gap-3">
                                        <div>
                                            <label className="text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97]">Workflow</label>
                                            <select
                                                className="mt-2 w-full bg-[#f8f9fa] border border-[#dfe6eb] rounded-xl px-3 py-2 text-sm font-semibold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                                value={triggerWorkflowId}
                                                onChange={(e) => handleTriggerWorkflowChange(e.target.value)}
                                            >
                                                {triggerWorkflowChoices.map((item) => (
                                                    <option key={`trigger-workflow-${item.id}`} value={item.id}>
                                                        {item.label}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                        <div>
                                            <label className="text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97]">Trigger Keyword</label>
                                            <input
                                                type="text"
                                                className="mt-2 w-full bg-[#f8f9fa] border border-[#dfe6eb] rounded-xl px-3 py-2 text-sm font-semibold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                                value={triggerKeywordDraft}
                                                onChange={(e) => setTriggerKeywordDraft(e.target.value)}
                                                placeholder="e.g. hai or first_message"
                                                disabled={triggerSaving}
                                            />
                                            <p className="text-[11px] text-[#7a8b97] mt-2">
                                                Use <code className="font-mono">first_message</code> to trigger on first inbound chat.
                                                Leave empty for manual-only workflow.
                                            </p>
                                        </div>
                                        <label className="flex items-start gap-2 rounded-xl border border-[#dfe6eb] bg-[#f8f9fa] px-3 py-2.5 cursor-pointer">
                                            <input
                                                type="checkbox"
                                                className="mt-0.5 h-4 w-4 rounded border-[#c8d2da] text-[#00a884] focus:ring-[#00a884]"
                                                checked={triggerRunOnNewChat}
                                                onChange={(e) => setTriggerRunOnNewChat(e.target.checked)}
                                                disabled={triggerSaving}
                                            />
                                            <span>
                                                <span className="block text-[11px] font-semibold text-[#111b21] uppercase tracking-wide">
                                                    Run for every new chat (no keyword match)
                                                </span>
                                                <span className="block text-[11px] text-[#7a8b97] mt-1">
                                                    Only one workflow can use this at a time.
                                                </span>
                                            </span>
                                        </label>
                                    </div>

                                    <div className="mt-4 flex justify-end">
                                        <button
                                            type="button"
                                            onClick={handleSaveTrigger}
                                            disabled={triggerSaving}
                                            className="h-8 px-3 rounded-lg bg-[#00a884] text-white text-[10px] font-semibold uppercase tracking-wide hover:bg-[#008f6f] transition-all inline-flex items-center gap-1 disabled:opacity-60 disabled:cursor-not-allowed"
                                        >
                                            {triggerSaving ? 'Saving…' : 'Save Trigger'}
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
