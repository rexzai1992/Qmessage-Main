
import React, { Suspense, lazy, useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { List, useDynamicRowHeight, useListRef } from 'react-window';
import { io, Socket } from 'socket.io-client';
import {
    Search,
    MoreVertical,
    MessageSquare,
    FileText,
    File as FileIcon,
    Image as ImageIcon,
    Paperclip,
    Smile,
    Mic,
    Send,
    Check,
    CheckCheck,
    CircleDashed,
    BarChart3,
    Filter,
    User,
    ArrowLeft,
    Settings,
    Phone,
    Video,
    Shield,
    LogOut,
    Users,
    X,
    GitBranch,
    Play,
    Plus,
    Trash2,
    Save,

    Workflow,
    ShieldCheck,
    Bug,
    Bot
} from 'lucide-react';
import Login from './Login';
import DebugButton from './DebugButton';
import { supabase } from './supabase';
import type { Session } from '@supabase/supabase-js';
import { getSocketUrl, resolveCompanyIdFromLocation } from './runtimeConfig';
import { useElementSize } from './hooks/useElementSize';
import { buildActionsFromBuilder, buildBuilderFromActions } from './features/workflows/builderConverters';
import BroadcastView from './features/workspace/BroadcastView';
import AutomationsView from './features/workspace/AutomationsView';
import ContactsView from './features/workspace/ContactsView';
import ChatbotsView from './features/workspace/ChatbotsView';
import SettingsView from './features/workspace/SettingsView';
import ChatflowView from './features/workspace/ChatflowView';
import AddProfileModal from './features/workspace/modals/AddProfileModal';
import EditProfileModal from './features/workspace/modals/EditProfileModal';
import NewChatModal from './features/workspace/modals/NewChatModal';
import OnboardingTutorialModal from './features/workspace/modals/OnboardingTutorialModal';
import {
    formatBps,
    formatBytes,
    formatDateLabel,
    formatLogTime,
    formatPhoneNumber,
    formatRemaining,
    getCleanId,
    getInitials,
    getLastInboundTs,
    getMessagePreviewText,
    pickContactName,
    redactSecret,
    textColor,
    withHexAlpha
} from './features/chat/utils';
import { uploadFileToWabaMedia } from './features/media/uploadToWabaMedia';
import qmessageLogo from './assets/qmessage-logo.jpg';


const SOCKET_URL = getSocketUrl();
const SINGLE_PROFILE_MODE = true;
const OAUTH_PENDING_COMPANY_KEY = 'pendingOAuthCompanyId';

const LazyWebhookView = lazy(() => import('./WebhookView'));
const LazyBroadcastTemplateBuilder = lazy(() => import('./BroadcastTemplateBuilder'));
const LazyBroadcastTemplatesList = lazy(() => import('./BroadcastTemplatesList'));
const LazyFlowCanvas = lazy(() => import('./FlowCanvas'));

interface Message {
    key: {
        id: string;
        remoteJid: string;
        fromMe?: boolean;
    };
    status?: 'sent' | 'delivered' | 'read' | 'failed' | 'pending';
    message?: {
        conversation?: string;
        extendedTextMessage?: {
            text: string;
        };
        buttonsMessage?: {
            contentText?: string;
            footerText?: string;
            buttons?: Array<{
                buttonId?: string;
                buttonText?: {
                    displayText?: string;
                };
            }>;
        };
        listMessage?: {
            title?: string;
            description?: string;
            buttonText?: string;
            footerText?: string;
            sections?: Array<{
                title?: string;
                rows?: Array<{
                    rowId?: string;
                    title?: string;
                    description?: string;
                }>;
            }>;
        };
        imageMessage?: any;
        documentMessage?: any;
        audioMessage?: any;
        videoMessage?: any;
    };
    agent?: {
        user_id?: string;
        name?: string;
        color?: string;
    } | null;
    pushName?: string;
    messageTimestamp?: number;
    workflowState?: any | null;
}

interface Chat {
    id: string;
    name: string;
    lastMessage?: string;
    timestamp?: number;
    unreadCount: number;
}

interface MediaData {
    data: string;
    mimetype: string;
}

type MediaDownloadStatus = 'requesting' | 'downloading' | 'processing' | 'error';

interface MediaDownloadProgressState {
    percent: number;
    status: MediaDownloadStatus;
}

interface QuickReply {
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
}

type TeamUserLite = {
    id: string;
    name: string;
    role: 'owner' | 'admin' | 'agent';
    color: string;
};

type WorkflowTemplateOption = {
    id: string;
    name: string;
    language: string;
};

type TemplateComposerOption = {
    id: string;
    name: string;
    language: string;
    category: string;
    status: string;
    parameterFormat: string;
    components: any[];
};

type ContactTemplateAttribute = {
    templateName: string;
    language: string;
    scope: 'body' | 'header';
    index: number;
    key: string;
    value: string;
    savedAt: string;
};

type LogEntry = {
    id: string;
    ts: number;
    level: 'info' | 'error';
    message: string;
};

type ServerStats = {
    cpu?: number;
    memUsed?: number;
    memTotal?: number;
    memPct?: number;
    bandwidth?: {
        inBps?: number;
        outBps?: number;
        inBytes?: number;
        outBytes?: number;
    };
    timestamp?: number;
};

type AppToast = {
    id: number;
    message: string;
    tone: 'success' | 'error';
};

type OnboardingStepId = 'welcome' | 'waba_id' | 'phone_number_id' | 'access_token' | 'verify_token' | 'connect';

type OnboardingFieldKey = 'wabaId' | 'phoneNumberId' | 'accessToken' | 'verifyToken';

type OnboardingStepConfig = {
    id: OnboardingStepId;
    title: string;
    description: string;
    details: string[];
    fieldKey?: OnboardingFieldKey;
    fieldLabel?: string;
    fieldPlaceholder?: string;
    fieldType?: 'text' | 'password';
    whereToGet?: string[];
    guideLinks?: Array<{
        label: string;
        href: string;
    }>;
};

type ContactMeta = {
    name?: string;
    lastInboundAt?: string | null;
    tags?: string[];
    humanTakeover?: boolean;
    assigneeUserId?: string | null;
    assigneeName?: string | null;
    assigneeColor?: string | null;
    ctaReferralAt?: string | null;
    ctaFreeWindowStartedAt?: string | null;
    ctaFreeWindowExpiresAt?: string | null;
    templateAttributes?: ContactTemplateAttribute[];
};

type AnalyticsTotals = {
    messages_total: number;
    messages_sent: number;
    workflow_runs: number;
    expired_messages: number;
};

type AnalyticsPerDayRow = {
    date: string;
    total: number;
    inbound: number;
    sent: number;
};

type AnalyticsStaffRow = {
    user_id: string;
    name: string;
    color: string | null;
    sent: number;
    workflow_runs: number;
    expired_messages: number;
    contacts_messaged: number;
    inbound_contacts: number;
    replied_contacts: number;
    reply_rate: number;
};

type AnalyticsPayload = {
    totals: AnalyticsTotals;
    per_day: AnalyticsPerDayRow[];
    per_staff: AnalyticsStaffRow[];
    tags: string[];
};

type MessageVirtualRow =
    | { kind: 'date'; id: string; label: string }
    | { kind: 'message'; id: string; msg: Message };

const CHAT_ROW_HEIGHT = 102;
const MESSAGE_DRAFT_STORAGE_PREFIX = 'draftMessage:';
const ONBOARDING_TOUR_STORAGE_PREFIX = 'onboardingTourSeen:';
const ONBOARDING_TOUR_VERSION = 'v1';
const ENABLE_FIRST_TIME_SETUP = false;
const ONBOARDING_SETUP_DEFAULTS: Record<OnboardingFieldKey, string> = {
    wabaId: '',
    phoneNumberId: '',
    accessToken: '',
    verifyToken: ''
};

const UI_FEATURE_KEY_BY_WORKSPACE_SECTION: Record<
    'team-inbox' | 'broadcast' | 'chatbots' | 'contacts' | 'ads' | 'automations' | 'more',
    string
> = {
    'team-inbox': 'team-inbox',
    'broadcast': 'broadcast',
    'chatbots': 'chatbots',
    'contacts': 'contacts',
    'ads': 'ads',
    'automations': 'automations',
    'more': 'analytics'
};

const SETTINGS_UI_FEATURE_KEY = 'settings';

const SYSTEM_CONTACT_TAGS = new Set(['human_takeover']);

const normalizeContactTags = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return Array.from(
        new Set(
            value
                .map((tag) => (typeof tag === 'string' ? tag.trim() : ''))
                .filter(Boolean)
        )
    );
};

const normalizeTagKey = (tag: string): string => tag.trim().toLowerCase().replace(/\s+/g, '_');

const splitContactTags = (value: unknown): { labelTags: string[]; systemTags: string[] } => {
    const normalized = normalizeContactTags(value);
    const labelTags: string[] = [];
    const systemTags: string[] = [];
    normalized.forEach((tag) => {
        if (SYSTEM_CONTACT_TAGS.has(normalizeTagKey(tag))) {
            systemTags.push(tag);
            return;
        }
        labelTags.push(tag);
    });
    return { labelTags, systemTags };
};

const buildContactJidVariants = (jid: string | null | undefined): string[] => {
    const value = typeof jid === 'string' ? jid.trim() : '';
    if (!value) return [];
    if (value.endsWith('@g.us')) {
        const cleanGroupId = getCleanId(value);
        const variants = [value, cleanGroupId ? `${cleanGroupId}@g.us` : '', cleanGroupId].filter(Boolean);
        return Array.from(new Set(variants));
    }
    const clean = getCleanId(value);
    if (clean.includes(':') || clean.toLowerCase().startsWith('y2fwav9ncm91cd')) {
        const variants = [value, `${clean}@g.us`, clean].filter(Boolean);
        return Array.from(new Set(variants));
    }
    const digits = clean.replace(/\D/g, '');
    const normalized = (digits.length >= 6 ? digits : clean.toLowerCase()).trim();
    const variants = [
        value,
        clean ? `${clean}@s.whatsapp.net` : '',
        clean ? `${clean}@lid` : '',
        clean,
        normalized ? `${normalized}@s.whatsapp.net` : '',
        normalized ? `${normalized}@lid` : '',
        normalized
    ].filter(Boolean);
    return Array.from(new Set(variants));
};

const canonicalContactJid = (jid: string | null | undefined): string => {
    const value = typeof jid === 'string' ? jid.trim() : '';
    if (!value) return '';
    if (value.endsWith('@g.us')) return value;
    const clean = getCleanId(value);
    if (clean.includes(':') || clean.toLowerCase().startsWith('y2fwav9ncm91cd')) {
        return `${clean}@g.us`;
    }
    const digits = clean.replace(/\D/g, '');
    if (digits.length >= 6) return `${digits}@s.whatsapp.net`;
    const normalized = clean.toLowerCase().trim();
    return normalized ? `${normalized}@s.whatsapp.net` : value.toLowerCase();
};

const pickContactMetaByJid = (
    contactMap: Record<string, ContactMeta>,
    jid: string | null | undefined
): ContactMeta | null => {
    const variants = buildContactJidVariants(jid);
    for (const key of variants) {
        if (contactMap[key]) return contactMap[key];
    }
    return null;
};



const renderMessageStatus = (msg: Message) => {
    if (!msg.key?.fromMe) return null;
    const status = msg.status;
    if (status === 'read') return <CheckCheck className="w-3.5 h-3.5 text-[#53bdeb]" />;
    if (status === 'delivered') return <CheckCheck className="w-3.5 h-3.5 text-[#7a8a97]" />;
    if (status === 'failed') return <X className="w-3.5 h-3.5 text-[#d93025]" />;
    if (status === 'pending') return <CircleDashed className="w-3.5 h-3.5 text-[#7a8a97]" />;
    return <Check className="w-3.5 h-3.5 text-[#7a8a97]" />;
};

const normalizeTemplateComponentType = (value: unknown): string => {
    if (typeof value !== 'string') return '';
    return value.trim().toUpperCase();
};

const extractTemplateVariableCount = (text: unknown): number => {
    if (typeof text !== 'string') return 0;
    const regex = /\{\{\s*(\d+)\s*\}\}/g;
    let maxIndex = 0;
    let match: RegExpExecArray | null = regex.exec(text);
    while (match) {
        const idx = Number.parseInt(match[1] || '0', 10);
        if (Number.isFinite(idx)) maxIndex = Math.max(maxIndex, idx);
        match = regex.exec(text);
    }
    return maxIndex;
};

const inferTemplateVariableLabel = (text: unknown, index: number, scope: 'body' | 'header' = 'body'): string => {
    if (typeof text === 'string' && text.trim()) {
        const pattern = new RegExp(`([^{}\\n]{0,34})\\{\\{\\s*${index}\\s*\\}\\}([^{}\\n]{0,18})`, 'i');
        const match = pattern.exec(text);
        const cleanContext = (value: string): string =>
            value
                .replace(/[\n\r]+/g, ' ')
                .replace(/[_\-]/g, ' ')
                .replace(/[.,;:!?()[\]{}]+/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
        const before = cleanContext(match?.[1] || '').split(' ').slice(-3).join(' ');
        const after = cleanContext(match?.[2] || '').split(' ').slice(0, 3).join(' ');
        const candidate = before || after;
        if (candidate) {
            return candidate.charAt(0).toUpperCase() + candidate.slice(1);
        }
    }
    return `${scope === 'header' ? 'Header' : 'Body'} {{${index}}}`;
};

const normalizeContactTemplateAttributes = (value: unknown): ContactTemplateAttribute[] => {
    if (!Array.isArray(value)) return [];
    return value
        .map((entry: any) => {
            const templateName = typeof entry?.templateName === 'string' ? entry.templateName.trim() : '';
            const key = typeof entry?.key === 'string' ? entry.key.trim() : '';
            const itemValue = typeof entry?.value === 'string' ? entry.value.trim() : '';
            if (!templateName || !key || !itemValue) return null;
            const language = typeof entry?.language === 'string' && entry.language.trim() ? entry.language.trim() : 'en_US';
            const parsedIndex = Number.parseInt(String(entry?.index ?? ''), 10);
            const index = Number.isFinite(parsedIndex) && parsedIndex > 0 ? Math.min(parsedIndex, 99) : 1;
            const scope: 'body' | 'header' = typeof entry?.scope === 'string' && entry.scope.toLowerCase() === 'header'
                ? 'header'
                : 'body';
            const parsedSavedAt = typeof entry?.savedAt === 'string' ? new Date(entry.savedAt).getTime() : Number.NaN;
            const savedAt = Number.isNaN(parsedSavedAt) ? '' : new Date(parsedSavedAt).toISOString();
            return {
                templateName: templateName.slice(0, 128),
                language: language.slice(0, 24),
                scope,
                index,
                key: key.slice(0, 120),
                value: itemValue.slice(0, 400),
                savedAt
            };
        })
        .filter((entry): entry is ContactTemplateAttribute => Boolean(entry))
        .slice(0, 80);
};

const findTemplateComponent = (components: any[] | undefined, type: string): any | null => {
    if (!Array.isArray(components)) return null;
    const normalized = type.trim().toUpperCase();
    return components.find((component) => normalizeTemplateComponentType(component?.type) === normalized) || null;
};

const toSafeAnalyticsCount = (value: unknown): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, Math.floor(parsed));
};

const toSafeAnalyticsRate = (value: unknown): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, Math.min(100, parsed));
};

const normalizeAnalyticsPayload = (payload: any): AnalyticsPayload => {
    const perDay: AnalyticsPerDayRow[] = Array.isArray(payload?.per_day)
        ? payload.per_day.map((row: any) => ({
            date: typeof row?.date === 'string' ? row.date : '',
            total: toSafeAnalyticsCount(row?.total),
            inbound: toSafeAnalyticsCount(row?.inbound),
            sent: toSafeAnalyticsCount(row?.sent)
        })).filter((row: AnalyticsPerDayRow) => Boolean(row.date))
        : [];

    const perDayTotals = perDay.reduce(
        (acc, row) => ({
            total: acc.total + row.total,
            sent: acc.sent + row.sent
        }),
        { total: 0, sent: 0 }
    );
    const perStaff: AnalyticsStaffRow[] = Array.isArray(payload?.per_staff)
        ? payload.per_staff
            .map((row: any) => ({
                user_id: typeof row?.user_id === 'string' ? row.user_id : '',
                name: typeof row?.name === 'string' ? row.name : '',
                color: typeof row?.color === 'string' ? row.color : null,
                sent: toSafeAnalyticsCount(row?.sent),
                workflow_runs: toSafeAnalyticsCount(row?.workflow_runs),
                expired_messages: toSafeAnalyticsCount(row?.expired_messages),
                contacts_messaged: toSafeAnalyticsCount(row?.contacts_messaged),
                inbound_contacts: toSafeAnalyticsCount(row?.inbound_contacts),
                replied_contacts: toSafeAnalyticsCount(row?.replied_contacts),
                reply_rate: toSafeAnalyticsRate(row?.reply_rate)
            }))
            .filter((row: AnalyticsStaffRow) => Boolean(row.user_id))
        : [];
    const totalsRaw = payload?.totals || {};
    const messagesTotal = toSafeAnalyticsCount(totalsRaw.messages_total ?? perDayTotals.total);
    const messagesSent = toSafeAnalyticsCount(totalsRaw.messages_sent ?? perDayTotals.sent);

    return {
        totals: {
            messages_total: messagesTotal,
            messages_sent: messagesSent,
            workflow_runs: toSafeAnalyticsCount(totalsRaw.workflow_runs),
            expired_messages: toSafeAnalyticsCount(totalsRaw.expired_messages)
        },
        per_day: perDay,
        per_staff: perStaff,
        tags: Array.isArray(payload?.tags)
            ? payload.tags.map((tag: unknown) => (typeof tag === 'string' ? tag.trim() : '')).filter(Boolean)
            : []
    };
};

const formatAnalyticsDateShort = (value: string): string => {
    const parsed = new Date(`${value}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};


export default function App() {
    // Auth State
    const [session, setSession] = useState<Session | null>(null);
    const [authChecking, setAuthChecking] = useState(true);
    const [hostAuthError, setHostAuthError] = useState<string | null>(null);

    const [socket, setSocket] = useState<Socket | null>(null);
    const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'open' | 'close'>('connecting');
    const [allMessages, setAllMessages] = useState<Message[]>([]);
    const [contacts, setContacts] = useState<Record<string, ContactMeta>>({});
    const [selectedChatId, setSelectedChatId] = useState<string | null>(() => {
        if (typeof window === 'undefined') return null;
        try {
            return window.localStorage.getItem('lastChatId');
        } catch {
            return null;
        }
    });
    const [chatOpenNonce, setChatOpenNonce] = useState(0);
    const [messageText, setMessageText] = useState('');
    const [composerMediaType, setComposerMediaType] = useState<'none' | 'image' | 'video' | 'document'>('none');
    const [composerMediaUrl, setComposerMediaUrl] = useState('');
    const [composerMediaId, setComposerMediaId] = useState('');
    const [composerMediaAssetKey, setComposerMediaAssetKey] = useState('');
    const [composerMediaMimeType, setComposerMediaMimeType] = useState('');
    const [composerMediaSizeBytes, setComposerMediaSizeBytes] = useState<number | null>(null);
    const [composerMediaFilename, setComposerMediaFilename] = useState('');
    const [composerMediaUploading, setComposerMediaUploading] = useState(false);
    const [composerDragActive, setComposerDragActive] = useState(false);
    const [composerMediaError, setComposerMediaError] = useState<string | null>(null);
    const [showMediaComposer, setShowMediaComposer] = useState(false);
    const [templateName, setTemplateName] = useState('');
    const [templateLanguage, setTemplateLanguage] = useState('en_US');
    const [templateComponents, setTemplateComponents] = useState('');
    const [templateComposerOptions, setTemplateComposerOptions] = useState<TemplateComposerOption[]>([]);
    const [templateComposerLoading, setTemplateComposerLoading] = useState(false);
    const [templateComposerError, setTemplateComposerError] = useState<string | null>(null);
    const [selectedTemplateOptionId, setSelectedTemplateOptionId] = useState('');
    const [templateBodyAttributes, setTemplateBodyAttributes] = useState<string[]>([]);
    const [templateBodyAttributeNames, setTemplateBodyAttributeNames] = useState<string[]>([]);
    const [templateHeaderAttributes, setTemplateHeaderAttributes] = useState<string[]>([]);
    const [templateHeaderMediaUrl, setTemplateHeaderMediaUrl] = useState('');
    const [templateHeaderDocumentFilename, setTemplateHeaderDocumentFilename] = useState('');
    const [startWorkflowId, setStartWorkflowId] = useState('');
    const [startingWorkflow, setStartingWorkflow] = useState(false);
    const [showWorkflowStarter, setShowWorkflowStarter] = useState(false);
    const [showTemplateComposer, setShowTemplateComposer] = useState(false);
    const [forceTemplateMode, setForceTemplateMode] = useState(false);
    const [lastProfileError, setLastProfileError] = useState<string | null>(null);
    const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
    const [logOpen, setLogOpen] = useState(false);
    const [appToast, setAppToast] = useState<AppToast | null>(null);
    const [loadingChats, setLoadingChats] = useState(false);
    const [serverStats, setServerStats] = useState<ServerStats | null>(null);
    const [contactDraftName, setContactDraftName] = useState('');
    const [contactTagsDraft, setContactTagsDraft] = useState<string[]>([]);
    const [contactTagInput, setContactTagInput] = useState('');
    const [contactDirty, setContactDirty] = useState(false);
    const [showAnalytics, setShowAnalytics] = useState(false);
    const [analyticsStart, setAnalyticsStart] = useState(() => {
        const d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        return d.toISOString().slice(0, 10);
    });
    const [analyticsEnd, setAnalyticsEnd] = useState(() => new Date().toISOString().slice(0, 10));
    const [analyticsTag, setAnalyticsTag] = useState('');
    const [analyticsData, setAnalyticsData] = useState<AnalyticsPayload | null>(null);
    const [analyticsLoading, setAnalyticsLoading] = useState(false);
    const [analyticsError, setAnalyticsError] = useState<string | null>(null);
    const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
    const [quickRepliesLoading, setQuickRepliesLoading] = useState(false);
    const [quickRepliesSaving, setQuickRepliesSaving] = useState(false);
    const [quickRepliesError, setQuickRepliesError] = useState<string | null>(null);

    const [searchQuery, setSearchQuery] = useState('');
    const [chatListFilter, setChatListFilter] = useState<'all' | 'tagged' | 'untagged' | 'assigned' | 'unassigned'>('all');
    const [contactsSearchQuery, setContactsSearchQuery] = useState('');
    const [teamUsers, setTeamUsers] = useState<TeamUserLite[]>([]);
    const [teamUsersLoading, setTeamUsersLoading] = useState(false);
    const [workflowTemplateOptions, setWorkflowTemplateOptions] = useState<WorkflowTemplateOption[]>([]);
    const [assignMenuContactId, setAssignMenuContactId] = useState<string | null>(null);
    const [assigningContactId, setAssigningContactId] = useState<string | null>(null);
    const [humanTakeoverSaving, setHumanTakeoverSaving] = useState(false);
    const [callActionLoading, setCallActionLoading] = useState<'voice' | 'video' | null>(null);
    const [mediaCache, setMediaCache] = useState<Record<string, MediaData>>({});
    const [mediaDownloadProgress, setMediaDownloadProgress] = useState<Record<string, MediaDownloadProgressState>>({});
    const [unreadMessagesByChat, setUnreadMessagesByChat] = useState<Record<string, number>>({});
    const [showContactInfo, setShowContactInfo] = useState(false);
    const [showNewChatModal, setShowNewChatModal] = useState(false);
    const [newPhoneNumber, setNewPhoneNumber] = useState('');
    const [showOnboardingTutorial, setShowOnboardingTutorial] = useState(false);
    const [onboardingStep, setOnboardingStep] = useState(0);
    const [onboardingSetup, setOnboardingSetup] = useState<Record<OnboardingFieldKey, string>>({ ...ONBOARDING_SETUP_DEFAULTS });
    const [onboardingValidationError, setOnboardingValidationError] = useState<string | null>(null);
    const [onboardingConnectLoading, setOnboardingConnectLoading] = useState(false);
    const [onboardingConnectError, setOnboardingConnectError] = useState<string | null>(null);
    const [onboardingConnectSuccess, setOnboardingConnectSuccess] = useState<string | null>(null);
    const [showMenu, setShowMenu] = useState(false);
    const [now, setNow] = useState(Date.now());
    const [isOffline, setIsOffline] = useState(() => {
        if (typeof window === 'undefined') return false;
        return !window.navigator.onLine;
    });

    const [activeView, setActiveView] = useState<'dashboard' | 'chatflow' | 'settings' | 'admin'>('dashboard');
    const [workspaceSection, setWorkspaceSection] = useState<
        'team-inbox' | 'broadcast' | 'chatbots' | 'contacts' | 'ads' | 'automations' | 'more'
    >('team-inbox');
    const [hiddenUiFeatures, setHiddenUiFeatures] = useState<string[]>([]);
    const [appLogoUrl, setAppLogoUrl] = useState('');
    const [uiControlsLoading, setUiControlsLoading] = useState(true);
    const [broadcastSection, setBroadcastSection] = useState<
        'template-library' | 'my-templates' | 'broadcast-history' | 'scheduled-broadcasts'
    >('template-library');
    const [isAdmin, setIsAdmin] = useState(false);
    const [profiles, setProfiles] = useState<any[]>([]);
    const [profilesLoaded, setProfilesLoaded] = useState(false);

    const [activeProfileId, setActiveProfileId] = useState<string | null>(() => {
        if (typeof window === 'undefined') return null;
        try {
            return window.localStorage.getItem('lastActiveProfileId');
        } catch {
            return null;
        }
    });
    const [showProfileMenu, setShowProfileMenu] = useState(false);
    const [showAddProfileModal, setShowAddProfileModal] = useState(false);
    const [showEditProfileModal, setShowEditProfileModal] = useState(false);
    const [newProfileName, setNewProfileName] = useState('');
    const [editingProfileId, setEditingProfileId] = useState('');
    const [editingProfileName, setEditingProfileName] = useState('');
    const [isCreatingProfile, setIsCreatingProfile] = useState(false);
    const [workflows, setWorkflows] = useState<any[]>([]);
    const [workflowsLoading, setWorkflowsLoading] = useState(false);
    const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
    const [workflowDrafts, setWorkflowDrafts] = useState<Record<string, string>>({});
    const [workflowEditorMode, setWorkflowEditorMode] = useState<'visual' | 'json'>('visual');
    const menuRef = useRef<HTMLDivElement>(null);
    const profileMenuRef = useRef<HTMLDivElement>(null);
    const messageInputRef = useRef<HTMLTextAreaElement>(null);
    const composerFileInputRef = useRef<HTMLInputElement>(null);
    const activeProfileIdRef = useRef<string | null>(null);
    const selectedChatIdRef = useRef<string | null>(null);
    const lastRecoverAtRef = useRef(0);
    const lastInboundRef = useRef<number | null>(null);
    const requestedMediaRef = useRef<Set<string>>(new Set());
    const seenIncomingMessageKeysRef = useRef<Set<string>>(new Set());
    const mediaDownloadProgressRef = useRef<Record<string, MediaDownloadProgressState>>({});
    const mediaProgressTimerRef = useRef<Record<string, number>>({});
    const mediaProgressTimeoutRef = useRef<Record<string, number>>({});
    const { ref: chatListViewportRef, size: chatListViewport } = useElementSize<HTMLDivElement>();
    const { ref: messageViewportRef, size: messageViewport } = useElementSize<HTMLDivElement>();
    const messageListRef = useListRef(null);
    const messageRowHeight = useDynamicRowHeight({
        defaultRowHeight: 120,
        key: selectedChatId || 'all'
    });

    useEffect(() => {
        mediaDownloadProgressRef.current = mediaDownloadProgress;
    }, [mediaDownloadProgress]);

    const settingsNav = [
        {
            group: 'Onboarding',
            items: [
                { id: 'settings-connect', label: 'Connect WhatsApp' },
                { id: 'settings-manual', label: 'Manual Setup' },
                { id: 'settings-register', label: 'Register Number' }
            ]
        },
        {
            group: 'Connectivity',
            items: [
                { id: 'settings-webhooks', label: 'Outgoing Webhooks' },
                ...(
                    hiddenUiFeatures.some((feature) => String(feature).trim().toLowerCase() === 'calls')
                        ? []
                        : [{ id: 'settings-calls', label: 'Call Settings' }]
                ),
                { id: 'settings-business-profile', label: 'Business Profile' },
                { id: 'settings-branding', label: 'App Logo' }
            ]
        },
        {
            group: 'Workspace',
            items: [
                { id: 'settings-team-users', label: 'Team Users' }
            ]
        },
        ...(isAdmin ? [{
            group: 'Admin',
            items: [
                { id: 'settings-connected-clients', label: 'Connected Clients' },
                { id: 'settings-connected-businesses', label: 'Connected Businesses' }
            ]
        }] : [])
    ];

    const hiddenUiFeatureSet = useMemo(() => {
        const next = new Set<string>();
        hiddenUiFeatures.forEach((feature) => {
            const normalized = typeof feature === 'string' ? feature.trim().toLowerCase() : '';
            if (normalized) next.add(normalized);
        });
        return next;
    }, [hiddenUiFeatures]);

    const isUiFeatureHidden = useCallback((feature: string) => {
        const normalized = typeof feature === 'string' ? feature.trim().toLowerCase() : '';
        if (!normalized) return false;
        return hiddenUiFeatureSet.has(normalized);
    }, [hiddenUiFeatureSet]);

    const isWabaProviderAdmin = useMemo(() => {
        const userMeta: any = (session?.user?.user_metadata as any) || {};
        const appMeta: any = (session?.user?.app_metadata as any) || {};
        const candidates = [
            userMeta.waba_admin,
            userMeta.is_waba_admin,
            appMeta.waba_admin,
            appMeta.is_waba_admin,
            userMeta.role,
            appMeta.role
        ];
        return candidates.some((value) => {
            if (typeof value === 'boolean') return value;
            if (typeof value === 'string') {
                const normalized = value.trim().toLowerCase();
                return normalized === 'true' || normalized === 'waba_admin' || normalized === 'super_admin';
            }
            return false;
        });
    }, [session?.user?.app_metadata, session?.user?.user_metadata]);

    const onboardingSteps = useMemo<OnboardingStepConfig[]>(() => ([
        {
            id: 'welcome',
            title: 'Required first-time setup',
            description: 'Complete these steps to activate your WhatsApp workspace.',
            details: [
                'This setup is required for company admins and cannot be skipped.',
                'You will enter real Meta credentials and verify connection before continuing.'
            ]
        },
        {
            id: 'waba_id',
            title: 'Step 1: WhatsApp Business Account ID',
            description: 'Enter the WABA ID for the account you want to connect.',
            details: [
                'Use numbers only (example: 102290129340398).',
                'Make sure this WABA belongs to the same Meta Business that owns the phone number.'
            ],
            fieldKey: 'wabaId',
            fieldLabel: 'WABA ID',
            fieldPlaceholder: 'e.g. 102290129340398',
            fieldType: 'text',
            whereToGet: [
                'Meta App Dashboard > WhatsApp > API Setup > WhatsApp Business Account ID.',
                'Or Meta Business Manager > WhatsApp Accounts > select account > copy ID.'
            ],
            guideLinks: [
                { label: 'Cloud API Get Started', href: 'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started' }
            ]
        },
        {
            id: 'phone_number_id',
            title: 'Step 2: Business Phone Number ID',
            description: 'Enter the phone number ID linked to your WABA.',
            details: [
                'Use numbers only (example: 106540352242922).',
                'This is NOT your display phone number; it is the Meta phone number ID.'
            ],
            fieldKey: 'phoneNumberId',
            fieldLabel: 'Phone Number ID',
            fieldPlaceholder: 'e.g. 106540352242922',
            fieldType: 'text',
            whereToGet: [
                'Meta App Dashboard > WhatsApp > API Setup > Phone number ID.',
                'Use the ID from the number you want this workspace to send from.'
            ],
            guideLinks: [
                { label: 'WhatsApp API Setup', href: 'https://developers.facebook.com/docs/whatsapp/cloud-api/phone-numbers' }
            ]
        },
        {
            id: 'access_token',
            title: 'Step 3: Access Token',
            description: 'Enter a valid token with WhatsApp permissions.',
            details: [
                'Use a system user long-lived token in production.',
                'Token must allow WhatsApp Business messaging and management.'
            ],
            fieldKey: 'accessToken',
            fieldLabel: 'Access Token',
            fieldPlaceholder: 'Paste access token',
            fieldType: 'password',
            whereToGet: [
                'Meta App Dashboard > WhatsApp > API Setup > temporary token (testing).',
                'For production, use Business Settings > System Users > generate long-lived token.'
            ],
            guideLinks: [
                { label: 'System User Access Tokens', href: 'https://developers.facebook.com/docs/whatsapp/business-management-api/get-started' }
            ]
        },
        {
            id: 'verify_token',
            title: 'Step 4: Webhook Verify Token',
            description: 'Create a verify token you can remember and use in Meta webhook settings.',
            details: [
                'This is your own secret string, not issued by Meta.',
                'Use at least 8 characters with letters and numbers.'
            ],
            fieldKey: 'verifyToken',
            fieldLabel: 'Verify Token',
            fieldPlaceholder: 'e.g. mycompany_verify_2026',
            fieldType: 'password',
            whereToGet: [
                'Create your own token value, then reuse the exact same value in Meta webhook verify token field.'
            ],
            guideLinks: [
                { label: 'Webhook Verification', href: 'https://developers.facebook.com/docs/graph-api/webhooks/getting-started' }
            ]
        },
        {
            id: 'connect',
            title: 'Step 5: Save and verify setup',
            description: 'We will save config and verify it by subscribing your app to this WABA.',
            details: [
                'Click "Save and verify connection".',
                'If verification fails, fix the value(s) and retry before continuing.'
            ]
        }
    ]), []);

    const scrollToSettingsSection = useCallback((id: string) => {
        const element = document.getElementById(id);
        if (element) {
            element.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }, []);

    const openSettingsSection = useCallback((id: string) => {
        setActiveView('settings');
        window.setTimeout(() => {
            scrollToSettingsSection(id);
        }, 120);
    }, [scrollToSettingsSection]);

    const onboardingStorageKey = session?.user?.id
        ? `${ONBOARDING_TOUR_STORAGE_PREFIX}${ONBOARDING_TOUR_VERSION}:${session.user.id}`
        : null;

    const resetOnboardingWizard = useCallback(() => {
        setOnboardingStep(0);
        setOnboardingSetup({ ...ONBOARDING_SETUP_DEFAULTS });
        setOnboardingValidationError(null);
        setOnboardingConnectError(null);
        setOnboardingConnectSuccess(null);
        setOnboardingConnectLoading(false);
    }, []);

    const completeOnboardingTutorial = useCallback(() => {
        if (!onboardingStorageKey) return;
        try {
            window.localStorage.setItem(onboardingStorageKey, '1');
        } catch {
            // ignore storage errors
        }
    }, [onboardingStorageKey]);

    const closeOnboardingTutorial = useCallback((markAsComplete: boolean) => {
        if (markAsComplete) {
            completeOnboardingTutorial();
        }
        setShowOnboardingTutorial(false);
        resetOnboardingWizard();
    }, [completeOnboardingTutorial, resetOnboardingWizard]);

    const updateOnboardingField = useCallback((field: OnboardingFieldKey, value: string) => {
        setOnboardingSetup(prev => ({ ...prev, [field]: value }));
        setOnboardingValidationError(null);
        setOnboardingConnectError(null);
        setOnboardingConnectSuccess(null);
    }, []);

    const isNumericMetaId = useCallback((value: string) => /^\d{6,25}$/.test(value.trim()), []);
    const isAccessTokenValid = useCallback((value: string) => value.trim().length >= 30, []);
    const isVerifyTokenValid = useCallback((value: string) => value.trim().length >= 8, []);

    const currentOnboardingStep = onboardingSteps[Math.min(onboardingStep, onboardingSteps.length - 1)] || onboardingSteps[0];
    const isFinalOnboardingStep = onboardingStep >= onboardingSteps.length - 1;

    const isCurrentOnboardingStepValid = useMemo(() => {
        switch (currentOnboardingStep.id) {
            case 'waba_id':
                return isNumericMetaId(onboardingSetup.wabaId);
            case 'phone_number_id':
                return isNumericMetaId(onboardingSetup.phoneNumberId);
            case 'access_token':
                return isAccessTokenValid(onboardingSetup.accessToken);
            case 'verify_token':
                return isVerifyTokenValid(onboardingSetup.verifyToken);
            case 'connect':
                return Boolean(onboardingConnectSuccess);
            default:
                return true;
        }
    }, [
        currentOnboardingStep.id,
        isAccessTokenValid,
        isNumericMetaId,
        isVerifyTokenValid,
        onboardingConnectSuccess,
        onboardingSetup.accessToken,
        onboardingSetup.phoneNumberId,
        onboardingSetup.verifyToken,
        onboardingSetup.wabaId
    ]);

    const validateCurrentOnboardingStep = useCallback((): string | null => {
        switch (currentOnboardingStep.id) {
            case 'waba_id':
                return isNumericMetaId(onboardingSetup.wabaId) ? null : 'WABA ID must be numeric.';
            case 'phone_number_id':
                return isNumericMetaId(onboardingSetup.phoneNumberId) ? null : 'Phone Number ID must be numeric.';
            case 'access_token':
                return isAccessTokenValid(onboardingSetup.accessToken) ? null : 'Access token looks incomplete. Paste full token.';
            case 'verify_token':
                return isVerifyTokenValid(onboardingSetup.verifyToken) ? null : 'Verify token must be at least 8 characters.';
            case 'connect':
                return onboardingConnectSuccess ? null : 'Save and verify connection before continuing.';
            default:
                return null;
        }
    }, [
        currentOnboardingStep.id,
        isAccessTokenValid,
        isNumericMetaId,
        isVerifyTokenValid,
        onboardingConnectSuccess,
        onboardingSetup.accessToken,
        onboardingSetup.phoneNumberId,
        onboardingSetup.verifyToken,
        onboardingSetup.wabaId
    ]);

    const handleOnboardingConnect = useCallback(async () => {
        if (!session?.access_token) {
            setOnboardingConnectError('You must be logged in to save setup.');
            return;
        }
        if (!activeProfileId) {
            setOnboardingConnectError('No active profile selected yet. Wait for profile to load and retry.');
            return;
        }
        setOnboardingConnectLoading(true);
        setOnboardingConnectError(null);
        setOnboardingConnectSuccess(null);
        try {
            const res = await fetch(`${SOCKET_URL}/api/waba/manual-config`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${session.access_token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    profileId: activeProfileId,
                    wabaId: onboardingSetup.wabaId.trim(),
                    phoneNumberId: onboardingSetup.phoneNumberId.trim(),
                    accessToken: onboardingSetup.accessToken.trim(),
                    verifyToken: onboardingSetup.verifyToken.trim(),
                    businessId: null,
                    appId: null,
                    appSecret: null,
                    apiVersion: null
                })
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to save setup');
            }
            if (data?.subscribeError) {
                throw new Error(`Saved, but Meta verification failed: ${data.subscribeError}`);
            }
            setOnboardingConnectSuccess('Connection verified successfully. You can continue.');
        } catch (err: any) {
            setOnboardingConnectError(err?.message || 'Failed to verify connection');
        } finally {
            setOnboardingConnectLoading(false);
        }
    }, [
        activeProfileId,
        onboardingSetup.accessToken,
        onboardingSetup.phoneNumberId,
        onboardingSetup.verifyToken,
        onboardingSetup.wabaId,
        session?.access_token
    ]);

    const handleOnboardingNext = useCallback(() => {
        const validationError = validateCurrentOnboardingStep();
        if (validationError) {
            setOnboardingValidationError(validationError);
            return;
        }
        setOnboardingValidationError(null);
        if (onboardingStep >= onboardingSteps.length - 1) {
            closeOnboardingTutorial(true);
            return;
        }
        setOnboardingStep((prev) => prev + 1);
    }, [closeOnboardingTutorial, onboardingStep, onboardingSteps.length, validateCurrentOnboardingStep]);

    const handleOnboardingBack = useCallback(() => {
        setOnboardingValidationError(null);
        setOnboardingConnectError(null);
        setOnboardingStep((prev) => Math.max(prev - 1, 0));
    }, []);

    const pushLog = useCallback((message: string, level: 'info' | 'error' = 'error') => {
        if (!message) return;
        setLogEntries(prev => {
            const next = [
                ...prev,
                {
                    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    ts: Date.now(),
                    level,
                    message
                }
            ];
            return next.slice(-200);
        });
    }, []);

    const showToast = useCallback((message: string, tone: 'success' | 'error' = 'success') => {
        if (!message) return;
        setAppToast({
            id: Date.now(),
            message,
            tone
        });
    }, []);

    useEffect(() => {
        if (!appToast) return;
        const timer = window.setTimeout(() => {
            setAppToast((current) => (current?.id === appToast.id ? null : current));
        }, 2400);
        return () => window.clearTimeout(timer);
    }, [appToast]);

    const getDraftStorageKey = useCallback((profileId?: string | null, chatId?: string | null) => {
        if (!profileId || !chatId) return null;
        return `${MESSAGE_DRAFT_STORAGE_PREFIX}${profileId}:${chatId}`;
    }, []);

    const persistDraft = useCallback(
        (value: string, profileId?: string | null, chatId?: string | null) => {
            const key = getDraftStorageKey(profileId, chatId);
            if (!key) return;
            try {
                const trimmed = value || '';
                if (trimmed.length === 0) {
                    window.localStorage.removeItem(key);
                } else {
                    window.localStorage.setItem(key, trimmed);
                }
            } catch {
                // ignore storage errors
            }
        },
        [getDraftStorageKey]
    );

    const clearAllDrafts = useCallback(() => {
        try {
            const keysToDelete: string[] = [];
            for (let i = 0; i < window.localStorage.length; i += 1) {
                const key = window.localStorage.key(i);
                if (key && key.startsWith(MESSAGE_DRAFT_STORAGE_PREFIX)) {
                    keysToDelete.push(key);
                }
            }
            keysToDelete.forEach((key) => window.localStorage.removeItem(key));
        } catch {
            // ignore storage errors
        }
    }, []);

    const setMessageTextWithDraft = useCallback(
        (value: string) => {
            setMessageText(value);
            persistDraft(value, activeProfileIdRef.current, selectedChatId);
        },
        [persistDraft, selectedChatId]
    );

    const fetchTeamUsers = useCallback(async () => {
        if (!session?.access_token) return;
        setTeamUsersLoading(true);
        try {
            const res = await fetch(`${SOCKET_URL}/api/company/team-users`, {
                headers: {
                    Authorization: `Bearer ${session.access_token}`
                }
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to load team users');
            }
            const users = Array.isArray(data?.data?.users) ? data.data.users : [];
            setTeamUsers(
                users.map((user: any) => ({
                    id: String(user.id || ''),
                    name: String(user.name || user.email || user.id || 'Agent'),
                    role: (String(user.role || 'agent').toLowerCase() as TeamUserLite['role']),
                    color: String(user.color || '#6b7280')
                })).filter((user: TeamUserLite) => Boolean(user.id))
            );
        } catch (err) {
            console.error('Failed to load team users:', err);
            setTeamUsers([]);
        } finally {
            setTeamUsersLoading(false);
        }
    }, [session?.access_token]);

    const fetchWorkflowTemplateOptions = useCallback(async () => {
        if (!activeProfileId || !session?.access_token) {
            setWorkflowTemplateOptions([]);
            return;
        }

        try {
            const params = new URLSearchParams();
            params.set('profileId', activeProfileId);
            params.set('limit', '100');
            params.set('status', 'APPROVED');
            const res = await fetch(`${SOCKET_URL}/api/waba/templates?${params.toString()}`, {
                headers: {
                    Authorization: `Bearer ${session.access_token}`
                }
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to load templates');
            }
            const rows = Array.isArray(data?.data?.data) ? data.data.data : [];
            const mapped: WorkflowTemplateOption[] = rows
                .map((row: any) => ({
                    id: typeof row?.id === 'string' ? row.id : '',
                    name: typeof row?.name === 'string' ? row.name : '',
                    language: typeof row?.language === 'string' ? row.language : 'en_US'
                }))
                .filter((tpl: WorkflowTemplateOption) => Boolean(tpl.name))
                .sort((a: WorkflowTemplateOption, b: WorkflowTemplateOption) => {
                    const nameCmp = a.name.localeCompare(b.name);
                    if (nameCmp !== 0) return nameCmp;
                    return a.language.localeCompare(b.language);
                });
            setWorkflowTemplateOptions(mapped);
        } catch (err) {
            console.error('Failed to load workflow template options:', err);
            setWorkflowTemplateOptions([]);
        }
    }, [activeProfileId, session?.access_token]);

    const fetchTemplateComposerOptions = useCallback(async () => {
        if (!activeProfileId || !session?.access_token) {
            setTemplateComposerOptions([]);
            return;
        }
        setTemplateComposerLoading(true);
        setTemplateComposerError(null);
        try {
            const params = new URLSearchParams();
            params.set('profileId', activeProfileId);
            params.set('limit', '150');
            params.set('status', 'APPROVED');
            params.set('fields', 'id,name,status,category,language,parameter_format,components');
            const res = await fetch(`${SOCKET_URL}/api/waba/templates?${params.toString()}`, {
                headers: {
                    Authorization: `Bearer ${session.access_token}`
                }
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || 'Failed to load approved templates');
            }
            const rows = Array.isArray(data?.data?.data) ? data.data.data : [];
            const mapped: TemplateComposerOption[] = rows
                .map((row: any) => ({
                    id: typeof row?.id === 'string' ? row.id : '',
                    name: typeof row?.name === 'string' ? row.name : '',
                    language: typeof row?.language === 'string' ? row.language : 'en_US',
                    category: typeof row?.category === 'string' ? row.category : '',
                    status: typeof row?.status === 'string' ? row.status : '',
                    parameterFormat: typeof row?.parameter_format === 'string' ? row.parameter_format : '',
                    components: Array.isArray(row?.components) ? row.components : []
                }))
                .filter((tpl: TemplateComposerOption) => Boolean(tpl.id && tpl.name))
                .sort((a: TemplateComposerOption, b: TemplateComposerOption) => a.name.localeCompare(b.name));
            setTemplateComposerOptions(mapped);
            setSelectedTemplateOptionId((prev) => {
                if (prev && mapped.some((item) => item.id === prev)) return prev;
                return mapped[0]?.id || '';
            });
        } catch (err: any) {
            setTemplateComposerError(err?.message || 'Failed to load approved templates');
            setTemplateComposerOptions([]);
        } finally {
            setTemplateComposerLoading(false);
        }
    }, [activeProfileId, session?.access_token]);

    const handleAssignContact = useCallback(
        async (jid: string, assigneeUserId: string | null) => {
            if (!socket || !activeProfileId || !jid || jid.endsWith('@g.us')) return;
            setAssigningContactId(jid);
            try {
                const response: any = await new Promise((resolve) => {
                    const timeout = window.setTimeout(() => {
                        resolve({ success: false, error: 'Assignment timed out. Please try again.' });
                    }, 8000);
                    socket.emit(
                        'contact.assign',
                        {
                            profileId: activeProfileId,
                            jid,
                            assigneeUserId
                        },
                        (ack: any) => {
                            window.clearTimeout(timeout);
                            resolve(ack);
                        }
                    );
                });

                if (!response?.success) {
                    throw new Error(response?.error || 'Failed to assign contact');
                }

                const contact = response?.data?.contact;
                if (contact?.id) {
                    setContacts((prev) => {
                        const next = { ...prev };
                        const aliasKeys = Array.from(new Set([
                            ...buildContactJidVariants(jid),
                            ...buildContactJidVariants(contact.id)
                        ]));
                        const canonicalKey = canonicalContactJid(contact.id || jid) || contact.id || jid;
                        const prevMeta = pickContactMetaByJid(next, canonicalKey) || {};
                        aliasKeys.forEach((key) => {
                            if (key !== canonicalKey) delete next[key];
                        });
                        next[canonicalKey] = {
                            ...prevMeta,
                            name: contact.name || prevMeta.name || getCleanId(canonicalKey),
                            lastInboundAt: contact.lastInboundAt ?? prevMeta.lastInboundAt ?? null,
                            tags: Array.isArray(contact.tags) ? contact.tags : (prevMeta.tags || []),
                            assigneeUserId: contact.assigneeUserId ?? null,
                            assigneeName: contact.assigneeName ?? null,
                            assigneeColor: contact.assigneeColor ?? null,
                            ctaReferralAt: contact.ctaReferralAt ?? prevMeta.ctaReferralAt ?? null,
                            ctaFreeWindowStartedAt: contact.ctaFreeWindowStartedAt ?? prevMeta.ctaFreeWindowStartedAt ?? null,
                            ctaFreeWindowExpiresAt: contact.ctaFreeWindowExpiresAt ?? prevMeta.ctaFreeWindowExpiresAt ?? null
                        };
                        return next;
                    });
                }
            } catch (err: any) {
                alert(err?.message || 'Failed to assign contact');
            } finally {
                setAssigningContactId(null);
                setAssignMenuContactId(null);
            }
        },
        [socket, activeProfileId]
    );

    const recoverSocketConnection = useCallback(
        (reason: string) => {
            const nowMs = Date.now();
            if (nowMs - lastRecoverAtRef.current < 30_000) return;
            lastRecoverAtRef.current = nowMs;
            pushLog(reason, 'error');
            setConnectionStatus('connecting');
            if (!socket) return;
            try {
                if (socket.connected) socket.disconnect();
                socket.connect();
            } catch (err: any) {
                pushLog(`Reconnect failed: ${err?.message || err}`, 'error');
            }
        },
        [pushLog, socket]
    );

    const fetchAnalytics = useCallback(() => {
        if (!activeProfileId) return;
        setAnalyticsLoading(true);
        setAnalyticsError(null);
        const params = new URLSearchParams({
            profileId: activeProfileId,
            start: analyticsStart,
            end: analyticsEnd
        });
        if (analyticsTag.trim()) params.set('tag', analyticsTag.trim());
        fetch(`${SOCKET_URL}/api/analytics?${params.toString()}`)
            .then(async res => {
                const text = await res.text();
                try {
                    return JSON.parse(text);
                } catch {
                    console.error('Analytics fetch failed:', text);
                    return null;
                }
            })
            .then(data => {
                if (data?.success) {
                    setAnalyticsData(normalizeAnalyticsPayload(data.data || {}));
                } else {
                    setAnalyticsError(data?.error || 'Failed to load analytics');
                }
            })
            .catch((err) => {
                setAnalyticsError(err?.message || 'Failed to load analytics');
            })
            .finally(() => setAnalyticsLoading(false));
    }, [activeProfileId, analyticsStart, analyticsEnd, analyticsTag]);

    const analyticsRows = useMemo<AnalyticsPerDayRow[]>(() => analyticsData?.per_day || [], [analyticsData]);
    const analyticsStaffRows = useMemo<AnalyticsStaffRow[]>(() => analyticsData?.per_staff || [], [analyticsData]);

    const analyticsInsights = useMemo(() => {
        const totals: AnalyticsTotals = analyticsData?.totals || {
            messages_total: 0,
            messages_sent: 0,
            workflow_runs: 0,
            expired_messages: 0
        };
        const inboundFromRows = analyticsRows.reduce((sum, row) => sum + toSafeAnalyticsCount(row.inbound), 0);
        const fallbackInbound = Math.max(0, toSafeAnalyticsCount(totals.messages_total) - toSafeAnalyticsCount(totals.messages_sent));
        const inboundCount = inboundFromRows > 0 ? inboundFromRows : fallbackInbound;
        const activeDays = analyticsRows.length;
        const averagePerActiveDay = activeDays > 0 ? totals.messages_total / activeDays : 0;
        const peakDay = analyticsRows.reduce<AnalyticsPerDayRow | null>((best, row) => {
            if (!best || row.total > best.total) return row;
            return best;
        }, null);
        const dailyMax = Math.max(1, ...analyticsRows.map((row) => row.total));
        const responseRate = inboundCount > 0 ? (totals.messages_sent / inboundCount) * 100 : 0;
        const expiredRate = totals.messages_sent > 0 ? (totals.expired_messages / totals.messages_sent) * 100 : 0;
        const workflowStartRate = totals.messages_sent > 0 ? (totals.workflow_runs / totals.messages_sent) * 100 : 0;
        const sentShare = totals.messages_total > 0 ? Math.min(1, totals.messages_sent / totals.messages_total) : 0;
        const inboundShare = Math.max(0, 1 - sentShare);

        return {
            totals,
            inboundCount,
            activeDays,
            averagePerActiveDay,
            peakDay,
            dailyMax,
            responseRate,
            expiredRate,
            workflowStartRate,
            sentShare,
            inboundShare
        };
    }, [analyticsData, analyticsRows]);

    const normalizeQuickReplyShortcut = useCallback((value: string) => {
        if (!value) return '';
        const trimmed = value.trim();
        if (!trimmed) return '';
        const withoutSlash = trimmed.replace(/^\/+/, '');
        const token = withoutSlash.split(/\s+/)[0];
        return token.toLowerCase();
    }, []);

    const normalizeQuickReplyMessageType = useCallback((value: unknown): 'text' | 'image' | 'video' | 'document' => {
        const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
        if (normalized === 'image' || normalized === 'video' || normalized === 'document') return normalized;
        return 'text';
    }, []);

    const normalizeQuickReplyMediaUrl = useCallback((value: unknown) => {
        return typeof value === 'string' ? value.trim() : '';
    }, []);

    const normalizeQuickReplyMediaStorage = useCallback((value: unknown): 'external' | 'r2' => {
        const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
        if (normalized === 'r2') return 'r2';
        return 'external';
    }, []);

    const normalizeQuickReplyMediaAssetKey = useCallback((value: unknown) => {
        return typeof value === 'string' ? value.trim() : '';
    }, []);

    const normalizeQuickReplyMediaMimeType = useCallback((value: unknown) => {
        return typeof value === 'string' ? value.trim().toLowerCase() : '';
    }, []);

    const normalizeQuickReplyMediaSizeBytes = useCallback((value: unknown): number | null => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return null;
        return Math.max(0, Math.floor(parsed)) || null;
    }, []);

    const normalizeQuickReplyMediaFilename = useCallback((value: unknown) => {
        return typeof value === 'string' ? value.trim() : '';
    }, []);

    const normalizeQuickReplyRecord = useCallback((item: any): QuickReply => {
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
            media_filename: message_type === 'document' ? normalizeQuickReplyMediaFilename(item?.media_filename) : ''
        };
    }, [
        normalizeQuickReplyMediaAssetKey,
        normalizeQuickReplyMediaFilename,
        normalizeQuickReplyMediaMimeType,
        normalizeQuickReplyMediaSizeBytes,
        normalizeQuickReplyMediaStorage,
        normalizeQuickReplyMediaUrl,
        normalizeQuickReplyMessageType
    ]);

    const fetchQuickReplies = useCallback(() => {
        if (!activeProfileId || !session?.access_token) {
            setQuickReplies([]);
            return;
        }
        setQuickRepliesLoading(true);
        setQuickRepliesError(null);
        fetch(`${SOCKET_URL}/api/company/quick-replies?profileId=${encodeURIComponent(activeProfileId)}`, {
            headers: {
                Authorization: `Bearer ${session.access_token}`
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
                    setQuickReplies(Array.isArray(data.data) ? data.data.map((item: any) => normalizeQuickReplyRecord(item)) : []);
                } else if (data?.error) {
                    setQuickRepliesError(data.error);
                }
            })
            .catch((err) => {
                setQuickRepliesError(err?.message || 'Failed to load quick replies');
            })
            .finally(() => setQuickRepliesLoading(false));
    }, [activeProfileId, normalizeQuickReplyRecord, session?.access_token]);

    const saveQuickReplies = useCallback(async (items: QuickReply[]) => {
        if (!activeProfileId || !session?.access_token) return;
        setQuickRepliesSaving(true);
        setQuickRepliesError(null);

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

        for (const item of items) {
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
            const res = await fetch(`${SOCKET_URL}/api/company/quick-replies?profileId=${encodeURIComponent(activeProfileId)}`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${session.access_token}`,
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
            setQuickReplies(Array.isArray(data.data) ? data.data.map((item: any) => normalizeQuickReplyRecord(item)) : []);
        } catch (err: any) {
            setQuickRepliesError(err?.message || 'Failed to save quick replies');
        } finally {
            setQuickRepliesSaving(false);
        }
    }, [
        activeProfileId,
        normalizeQuickReplyMediaFilename,
        normalizeQuickReplyMediaAssetKey,
        normalizeQuickReplyMediaMimeType,
        normalizeQuickReplyMediaSizeBytes,
        normalizeQuickReplyMediaStorage,
        normalizeQuickReplyMediaUrl,
        normalizeQuickReplyMessageType,
        normalizeQuickReplyRecord,
        normalizeQuickReplyShortcut,
        session?.access_token
    ]);

    const normalizeHiddenFeatureList = useCallback((value: unknown): string[] => {
        const allowed = new Set([
            'team-inbox',
            'automations',
            'broadcast',
            'chatbots',
            'contacts',
            'calls',
            'analytics',
            'settings'
        ]);
        const unique = new Set<string>();
        const push = (entry: unknown) => {
            if (typeof entry !== 'string') return;
            const normalized = entry.trim().toLowerCase();
            if (!normalized || !allowed.has(normalized)) return;
            unique.add(normalized);
        };
        if (Array.isArray(value)) {
            value.forEach((entry) => push(entry));
            return Array.from(unique);
        }
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) return [];
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) {
                    parsed.forEach((entry) => push(entry));
                    return Array.from(unique);
                }
            } catch {
                // fall through to CSV parsing
            }
            trimmed
                .split(/[,\n;]/g)
                .map((entry) => entry.trim())
                .filter(Boolean)
                .forEach((entry) => push(entry));
            return Array.from(unique);
        }
        return [];
    }, []);

    const fetchUiControls = useCallback(async () => {
        if (!session?.access_token) {
            setHiddenUiFeatures([]);
            setAppLogoUrl('');
            setUiControlsLoading(false);
            return;
        }
        setUiControlsLoading(true);
        try {
            const res = await fetch(`${SOCKET_URL}/api/company/ui-controls`, {
                headers: {
                    Authorization: `Bearer ${session.access_token}`
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
                if (data?.code === 'UI_CONTROLS_MISSING') {
                    setHiddenUiFeatures([]);
                    setAppLogoUrl('');
                    return;
                }
                throw new Error(data?.error || 'Failed to load UI controls');
            }

            setHiddenUiFeatures(normalizeHiddenFeatureList(data?.data?.hidden_features));
            setAppLogoUrl(typeof data?.data?.app_logo_url === 'string' ? data.data.app_logo_url.trim() : '');
        } catch (error: any) {
            console.warn('Failed to load company UI controls:', error?.message || error);
            setHiddenUiFeatures([]);
            setAppLogoUrl('');
        } finally {
            setUiControlsLoading(false);
        }
    }, [normalizeHiddenFeatureList, session?.access_token]);

    useEffect(() => {
        activeProfileIdRef.current = activeProfileId;
    }, [activeProfileId]);

    useEffect(() => {
        selectedChatIdRef.current = selectedChatId;
    }, [selectedChatId]);

    useEffect(() => {
        try {
            if (activeProfileId) {
                window.localStorage.setItem('lastActiveProfileId', activeProfileId);
            } else {
                window.localStorage.removeItem('lastActiveProfileId');
            }
        } catch {
            // ignore storage errors
        }
    }, [activeProfileId]);

    useEffect(() => {
        if (!activeProfileId) {
            setQuickReplies([]);
            return;
        }
        fetchQuickReplies();
    }, [activeProfileId, fetchQuickReplies]);

    useEffect(() => {
        if (!session?.access_token) {
            setHiddenUiFeatures([]);
            setAppLogoUrl('');
            setUiControlsLoading(false);
            return;
        }
        fetchUiControls();
    }, [fetchUiControls, session?.access_token]);

    useEffect(() => {
        if (!session?.access_token) return;
        const refreshTimer = window.setInterval(() => {
            fetchUiControls();
        }, 4 * 60 * 1000);
        return () => window.clearInterval(refreshTimer);
    }, [fetchUiControls, session?.access_token]);


    useEffect(() => {
        if (!activeProfileId) return;
        try {
            const stored = window.localStorage.getItem(`lastChatId:${activeProfileId}`);
            if (stored && !selectedChatId) {
                setSelectedChatId(stored);
            }
        } catch {
            // ignore storage errors
        }
    }, [activeProfileId, selectedChatId]);

    useEffect(() => {
        if (!activeProfileId || !selectedChatId) {
            setMessageText('');
            setComposerMediaType('none');
            setComposerMediaUrl((prev) => {
                if (prev.startsWith('blob:')) URL.revokeObjectURL(prev);
                return '';
            });
            setComposerMediaId('');
            setComposerMediaAssetKey('');
            setComposerMediaMimeType('');
            setComposerMediaSizeBytes(null);
            setComposerMediaFilename('');
            setComposerMediaError(null);
            setComposerMediaUploading(false);
            setComposerDragActive(false);
            setShowMediaComposer(false);
            return;
        }
        try {
            const key = getDraftStorageKey(activeProfileId, selectedChatId);
            if (!key) {
                setMessageText('');
                setComposerMediaType('none');
                setComposerMediaUrl((prev) => {
                    if (prev.startsWith('blob:')) URL.revokeObjectURL(prev);
                    return '';
                });
                setComposerMediaId('');
                setComposerMediaAssetKey('');
                setComposerMediaMimeType('');
                setComposerMediaSizeBytes(null);
                setComposerMediaFilename('');
                setComposerMediaError(null);
                setComposerMediaUploading(false);
                setComposerDragActive(false);
                setShowMediaComposer(false);
                return;
            }
            const storedDraft = window.localStorage.getItem(key);
            setMessageText(storedDraft || '');
        } catch {
            setMessageText('');
        }
    }, [activeProfileId, selectedChatId, getDraftStorageKey]);

    useEffect(() => {
        if (!activeProfileId || !selectedChatId) return;
        try {
            window.localStorage.setItem(`lastChatId:${activeProfileId}`, selectedChatId);
            window.localStorage.setItem('lastChatId', selectedChatId);
        } catch {
            // ignore storage errors
        }
    }, [activeProfileId, selectedChatId]);

    useEffect(() => {
        if (!selectedChatId) return;
        const canonical = canonicalContactJid(selectedChatId);
        if (canonical && canonical !== selectedChatId) {
            setSelectedChatId(canonical);
        }
    }, [selectedChatId]);

    useEffect(() => {
        const chatKey = canonicalContactJid(selectedChatId || '');
        if (!chatKey) return;
        setUnreadMessagesByChat((prev) => {
            if (!(chatKey in prev)) return prev;
            const next = { ...prev };
            delete next[chatKey];
            return next;
        });
    }, [selectedChatId]);

    useEffect(() => {
        setShowWorkflowStarter(false);
    }, [selectedChatId, activeProfileId]);

    useEffect(() => {
        if (!selectedChatId) return;
        const contact = pickContactMetaByJid(contacts, selectedChatId);
        setContactDraftName(contact?.name || getCleanId(selectedChatId));
        setContactTagsDraft(splitContactTags(contact?.tags).labelTags);
        setContactTagInput('');
        setContactDirty(false);
    }, [selectedChatId]);

    useEffect(() => {
        if (!selectedChatId || contactDirty) return;
        const contact = pickContactMetaByJid(contacts, selectedChatId);
        if (!contact) return;
        setContactDraftName(contact.name || getCleanId(selectedChatId));
        setContactTagsDraft(splitContactTags(contact.tags).labelTags);
    }, [contacts, selectedChatId, contactDirty]);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setShowMenu(false);
            }
            if (profileMenuRef.current && !profileMenuRef.current.contains(event.target as Node)) {
                setShowProfileMenu(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    useEffect(() => {
        const interval = setInterval(() => setNow(Date.now()), 60_000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const syncOnlineState = () => setIsOffline(!window.navigator.onLine);
        syncOnlineState();
        window.addEventListener('online', syncOnlineState);
        window.addEventListener('offline', syncOnlineState);
        return () => {
            window.removeEventListener('online', syncOnlineState);
            window.removeEventListener('offline', syncOnlineState);
        };
    }, []);

    useEffect(() => {
        if (!showAnalytics) return;
        fetchAnalytics();
    }, [showAnalytics, fetchAnalytics]);

    useEffect(() => {
        if (workspaceSection !== 'contacts') return;
        fetchTeamUsers();
    }, [workspaceSection, fetchTeamUsers]);

    useEffect(() => {
        if (activeView !== 'chatflow') return;
        if (!teamUsers.length && !teamUsersLoading) {
            fetchTeamUsers();
        }
        fetchWorkflowTemplateOptions();
    }, [activeView, teamUsers.length, teamUsersLoading, fetchTeamUsers, fetchWorkflowTemplateOptions]);

    useEffect(() => {
        if (!showTemplateComposer) return;
        fetchTemplateComposerOptions();
    }, [showTemplateComposer, fetchTemplateComposerOptions]);

    useEffect(() => {
        setAssignMenuContactId(null);
    }, [activeProfileId, workspaceSection]);

    useEffect(() => {
        if (uiControlsLoading) return;
        const activeFeature = UI_FEATURE_KEY_BY_WORKSPACE_SECTION[workspaceSection];
        if (!activeFeature || !isUiFeatureHidden(activeFeature)) return;

        const candidateSections: Array<'team-inbox' | 'automations' | 'broadcast' | 'chatbots' | 'contacts' | 'more'> = [
            'team-inbox',
            'automations',
            'broadcast',
            'chatbots',
            'contacts',
            'more'
        ];
        const firstVisible = candidateSections.find((section) => !isUiFeatureHidden(UI_FEATURE_KEY_BY_WORKSPACE_SECTION[section]));
        setWorkspaceSection(firstVisible || 'ads');
    }, [isUiFeatureHidden, workspaceSection, uiControlsLoading]);

    useEffect(() => {
        if (uiControlsLoading) return;
        if (activeView !== 'settings') return;
        if (!isUiFeatureHidden(SETTINGS_UI_FEATURE_KEY)) return;
        setActiveView('dashboard');
    }, [activeView, isUiFeatureHidden, uiControlsLoading]);

    useEffect(() => {
        if (uiControlsLoading) return;
        if (!showAnalytics) return;
        if (!isUiFeatureHidden('analytics')) return;
        setShowAnalytics(false);
    }, [isUiFeatureHidden, showAnalytics, uiControlsLoading]);


    const handleSignOut = async () => {
        clearAllDrafts();
        setMessageText('');
        setUnreadMessagesByChat({});
        seenIncomingMessageKeysRef.current.clear();
        setHostAuthError(null);
        setShowOnboardingTutorial(false);
        resetOnboardingWizard();
        try {
            window.localStorage.removeItem(OAUTH_PENDING_COMPANY_KEY);
        } catch {
            // ignore
        }
        await supabase.auth.signOut();
        setSession(null);
    };

    // Check Auth
    useEffect(() => {
        supabase.auth.getSession().then(({ data: { session } }) => {
            setSession(session);
            setAuthChecking(false);
        });

        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session);
            setAuthChecking(false);
        });

        return () => subscription.unsubscribe();
    }, []);

    useEffect(() => {
        if (!session) {
            return;
        }

        let pendingCompanyId = '';
        try {
            pendingCompanyId = window.localStorage.getItem(OAUTH_PENDING_COMPANY_KEY) || '';
        } catch {
            pendingCompanyId = '';
        }

        const hostCompanyId = resolveCompanyIdFromLocation();
        const requiredCompanyId = String(hostCompanyId || pendingCompanyId || '').trim().toLowerCase();
        if (!requiredCompanyId) {
            setHostAuthError(null);
            return;
        }

        const userCompanyRaw =
            (session.user.user_metadata as any)?.company_id ||
            (session.user.app_metadata as any)?.company_id ||
            '';
        const userCompany = String(userCompanyRaw || '').trim().toLowerCase();
        if (userCompany === requiredCompanyId) {
            try {
                window.localStorage.removeItem(OAUTH_PENDING_COMPANY_KEY);
            } catch {
                // ignore
            }
            setHostAuthError(null);
            return;
        }

        const message = userCompany
            ? `This account belongs to "${userCompany}". Please use ${userCompany}.2fast.xyz.`
            : 'This account is not assigned to any company. Ask your admin to set up your account first.';

        setHostAuthError(message);
        try {
            window.localStorage.removeItem(OAUTH_PENDING_COMPANY_KEY);
        } catch {
            // ignore
        }
        supabase.auth.signOut().finally(() => {
            setSession(null);
        });
    }, [session]);

    useEffect(() => {
        if (!ENABLE_FIRST_TIME_SETUP) {
            setShowOnboardingTutorial(false);
            resetOnboardingWizard();
            return;
        }
        if (authChecking || hostAuthError) return;
        if (!session?.user?.id || !onboardingStorageKey || !isAdmin || isWabaProviderAdmin) {
            setShowOnboardingTutorial(false);
            resetOnboardingWizard();
            return;
        }

        let hasSeen = false;
        try {
            hasSeen = window.localStorage.getItem(onboardingStorageKey) === '1';
        } catch {
            hasSeen = false;
        }

        if (hasSeen) {
            setShowOnboardingTutorial(false);
            return;
        }

        resetOnboardingWizard();
        setShowOnboardingTutorial(true);
    }, [authChecking, hostAuthError, isAdmin, isWabaProviderAdmin, onboardingStorageKey, resetOnboardingWizard, session?.user?.id]);

    useEffect(() => {
        if (!session) {
            setIsAdmin(false);
            return;
        }

        supabase
            .from('user_roles')
            .select('role')
            .eq('user_id', session.user.id)
            .maybeSingle()
            .then(({ data, error }) => {
                if (error) {
                    console.warn('user_roles lookup failed', error);
                    setIsAdmin(false);
                    return;
                }
                const role = typeof data?.role === 'string' ? data.role.toLowerCase() : '';
                setIsAdmin(role === 'admin' || role === 'owner');
            });
    }, [session]);

    useEffect(() => {
        const statusEmoji = connectionStatus === 'open' ? '🟢' : connectionStatus === 'connecting' ? '🟡' : '🔴';
        document.title = `${statusEmoji} WhatsApp Business API`;
    }, [connectionStatus]);

    useEffect(() => {
        if (!session) {
            setSocket(null);
            setProfiles([]);
            setProfilesLoaded(false);
            setActiveProfileId(null);
            setAllMessages([]);
            setContacts({});
            return;
        }

        console.log('Connecting socket with token', session.access_token.substring(0, 10));
        setProfilesLoaded(false);
        const newSocket = io(SOCKET_URL, {
            auth: { token: session.access_token },
            transports: ['websocket', 'polling'],
            autoConnect: false
        });
        setSocket(newSocket);
        const connectTimer = window.setTimeout(() => {
            if (!newSocket.connected) {
                newSocket.connect();
            }
        }, 0);

        newSocket.on('connect', () => {
            if (activeProfileIdRef.current) {
                newSocket.emit('switchProfile', activeProfileIdRef.current);
            }
        });

        newSocket.on('profiles.update', (data) => {
            const list = Array.isArray(data) ? data : [];
            setProfiles(list);
            setProfilesLoaded(true);
            if (list.length === 0) {
                setActiveProfileId(null);
                setLoadingChats(false);
                return;
            }

            // Prefer configured/open profiles whenever available.
            const current = activeProfileIdRef.current;
            const openProfiles = list.filter((p: any) => p?.status === 'open');
            const hasOpenProfiles = openProfiles.length > 0;
            if (current) {
                const currentProfile = list.find((p: any) => p.id === current);
                if (currentProfile && (!hasOpenProfiles || currentProfile?.status === 'open')) return;
            }

            let persisted: string | null = null;
            try {
                persisted = window.localStorage.getItem('lastActiveProfileId');
            } catch {
                persisted = null;
            }
            const persistedProfile =
                persisted
                    ? list.find((p: any) => p.id === persisted && (!hasOpenProfiles || p?.status === 'open'))
                    : null;
            const next = persistedProfile || (hasOpenProfiles ? openProfiles[0] : list[0]);
            if (next?.id) setActiveProfileId(next.id);
        });

        newSocket.on('connection.update', (update) => {
            if (update.profileId === activeProfileIdRef.current) setConnectionStatus(update.connection);
            if (update.connection === 'close') {
                pushLog('WABA connection closed.', 'info');
            }
        });

        newSocket.on('messages.upsert', (data) => {
            if (data.profileId === activeProfileIdRef.current) {
                const incomingMessages = Array.isArray(data?.messages) ? data.messages : [];
                setAllMessages((prev) => [...incomingMessages, ...prev]);
                setLoadingChats(false);
                if (incomingMessages.length === 0) return;
                const activeChatKey = canonicalContactJid(selectedChatIdRef.current || '');
                setUnreadMessagesByChat((prev) => {
                    let next = prev;
                    let changed = false;
                    incomingMessages.forEach((msg: any, index: number) => {
                        if (msg?.key?.fromMe) return;
                        const jid = canonicalContactJid(msg?.key?.remoteJid || '');
                        if (!jid) return;
                        const rawId = typeof msg?.key?.id === 'string' ? msg.key.id.trim() : '';
                        const ts = Number(msg?.messageTimestamp || 0);
                        const dedupeKey = `${jid}:${rawId || `ts-${ts}-idx-${index}`}`;
                        if (seenIncomingMessageKeysRef.current.has(dedupeKey)) return;
                        seenIncomingMessageKeysRef.current.add(dedupeKey);
                        if (activeChatKey && jid === activeChatKey) return;
                        if (!changed) {
                            next = { ...prev };
                            changed = true;
                        }
                        next[jid] = (next[jid] || 0) + 1;
                    });
                    return changed ? next : prev;
                });
            }
        });

        newSocket.on('messages.history', (data) => {
            if (data.profileId === activeProfileIdRef.current) {
                const historyMessages = Array.isArray(data?.messages) ? data.messages : [];
                setAllMessages(historyMessages);
                setLoadingChats(false);
                const nextSeen = new Set<string>();
                historyMessages.forEach((msg: any, index: number) => {
                    if (msg?.key?.fromMe) return;
                    const jid = canonicalContactJid(msg?.key?.remoteJid || '');
                    if (!jid) return;
                    const rawId = typeof msg?.key?.id === 'string' ? msg.key.id.trim() : '';
                    const ts = Number(msg?.messageTimestamp || 0);
                    nextSeen.add(`${jid}:${rawId || `ts-${ts}-idx-${index}`}`);
                });
                seenIncomingMessageKeysRef.current = nextSeen;
                setUnreadMessagesByChat({});
            }
        });

        newSocket.on('server.stats', (stats) => {
            setServerStats(stats);
        });

        newSocket.on('message.status', (data) => {
            if (data.profileId !== activeProfileIdRef.current) return;
            const { messageId, status } = data || {};
            if (!messageId || !status) return;
            setAllMessages(prev =>
                prev.map(msg =>
                    msg.key?.id === messageId
                        ? { ...msg, status }
                        : msg
                )
            );
        });

        newSocket.on('calls.update', (data) => {
            if (data?.profileId !== activeProfileIdRef.current) return;
            const eventName = typeof data?.event === 'string' ? data.event.trim().toLowerCase() : '';
            const callId = typeof data?.callId === 'string' ? data.callId.trim() : '';
            const from = typeof data?.from === 'string' ? data.from.trim() : '';
            const to = typeof data?.to === 'string' ? data.to.trim() : '';

            if (eventName === 'connect') {
                pushLog(`[Calls] Incoming call ${callId || '-'} from ${from || 'unknown'} to ${to || '-'}.`, 'info');
                showToast('Incoming WhatsApp call received.', 'success');
                return;
            }

            if (eventName === 'terminate') {
                pushLog(`[Calls] Call ${callId || '-'} ended.`, 'info');
                return;
            }

            if (eventName) {
                pushLog(`[Calls] ${eventName.toUpperCase()} ${callId || '-'}.`, 'info');
            }
        });

        newSocket.on('messages.cleared', (data) => {
            if (data.profileId !== activeProfileIdRef.current) return;
            const targetKey = canonicalContactJid(data.jid);
            setAllMessages(prev => prev.filter(msg => canonicalContactJid(msg.key.remoteJid) !== targetKey));
            if (!targetKey) return;
            setUnreadMessagesByChat((prev) => {
                if (!(targetKey in prev)) return prev;
                const next = { ...prev };
                delete next[targetKey];
                return next;
            });
        });

        newSocket.on('messaging-history.set', (history) => {
            setAllMessages(prev => [...history.messages, ...prev]);
            const list = Array.isArray(history?.messages) ? history.messages : [];
            list.forEach((msg: any, index: number) => {
                if (msg?.key?.fromMe) return;
                const jid = canonicalContactJid(msg?.key?.remoteJid || '');
                if (!jid) return;
                const rawId = typeof msg?.key?.id === 'string' ? msg.key.id.trim() : '';
                const ts = Number(msg?.messageTimestamp || 0);
                seenIncomingMessageKeysRef.current.add(`${jid}:${rawId || `ts-${ts}-idx-${index}`}`);
            });
        });

        newSocket.on('contacts.update', (data) => {
            if (data.profileId === activeProfileIdRef.current) {
                setContacts(prev => {
                    const next = { ...prev };
                    data.contacts.forEach((c: any) => {
                        if (!c.id) return;
                        const aliasKeys = buildContactJidVariants(c.id);
                        const canonicalKey = canonicalContactJid(c.id) || c.id;
                        const prevMeta = pickContactMetaByJid(next, canonicalKey) || {};
                        const incomingName = typeof c.name === 'string' ? c.name : (typeof c.notify === 'string' ? c.notify : '');
                        const resolvedName = pickContactName(incomingName, (prevMeta as any).name, c.id);
                        const nextLastInboundAt = c.lastInboundAt === undefined ? (prevMeta as any).lastInboundAt || null : c.lastInboundAt;
                        const nextAssigneeUserId = c.assigneeUserId === undefined ? (prevMeta as any).assigneeUserId || null : c.assigneeUserId;
                        const nextAssigneeName = c.assigneeName === undefined ? (prevMeta as any).assigneeName || null : c.assigneeName;
                        const nextAssigneeColor = c.assigneeColor === undefined ? (prevMeta as any).assigneeColor || null : c.assigneeColor;
                        const nextCtaReferralAt = c.ctaReferralAt === undefined ? (prevMeta as any).ctaReferralAt || null : c.ctaReferralAt;
                        const nextCtaFreeWindowStartedAt = c.ctaFreeWindowStartedAt === undefined ? (prevMeta as any).ctaFreeWindowStartedAt || null : c.ctaFreeWindowStartedAt;
                        const nextCtaFreeWindowExpiresAt = c.ctaFreeWindowExpiresAt === undefined ? (prevMeta as any).ctaFreeWindowExpiresAt || null : c.ctaFreeWindowExpiresAt;
                        const incomingTemplateAttributes = c.templateAttributes === undefined ? c.template_attributes : c.templateAttributes;
                        const nextTemplateAttributes = incomingTemplateAttributes === undefined
                            ? normalizeContactTemplateAttributes((prevMeta as any).templateAttributes)
                            : normalizeContactTemplateAttributes(incomingTemplateAttributes);
                        aliasKeys.forEach((key) => {
                            if (key !== canonicalKey) delete next[key];
                        });
                        next[canonicalKey] = {
                            name: resolvedName || (prevMeta as any).name,
                            lastInboundAt: nextLastInboundAt,
                            tags: Array.isArray(c.tags) ? c.tags : (prevMeta as any).tags || [],
                            assigneeUserId: nextAssigneeUserId,
                            assigneeName: nextAssigneeName,
                            assigneeColor: nextAssigneeColor,
                            ctaReferralAt: nextCtaReferralAt,
                            ctaFreeWindowStartedAt: nextCtaFreeWindowStartedAt,
                            ctaFreeWindowExpiresAt: nextCtaFreeWindowExpiresAt,
                            templateAttributes: nextTemplateAttributes
                        };
                    });
                    return next;
                });
            }
        });

        newSocket.on('mediaDownloaded', ({ messageId, mediaId, data, mimetype }) => {
            setMediaCache(prev => ({
                ...prev,
                ...(messageId ? { [messageId]: { data, mimetype } } : {}),
                ...(mediaId ? { [mediaId]: { data, mimetype } } : {})
            }));
            const completionKeys = Array.from(
                new Set(
                    [messageId, mediaId].filter((value): value is string => (
                        typeof value === 'string' && value.trim().length > 0
                    ))
                )
            );
            if (completionKeys.length === 0) return;

            completionKeys.forEach((key) => {
                requestedMediaRef.current.delete(key);
                const progressTimer = mediaProgressTimerRef.current[key];
                if (typeof progressTimer === 'number') {
                    window.clearInterval(progressTimer);
                    delete mediaProgressTimerRef.current[key];
                }
                const timeoutTimer = mediaProgressTimeoutRef.current[key];
                if (typeof timeoutTimer === 'number') {
                    window.clearTimeout(timeoutTimer);
                    delete mediaProgressTimeoutRef.current[key];
                }
            });

            setMediaDownloadProgress((prev) => {
                const next = { ...prev };
                let changed = false;
                completionKeys.forEach((key) => {
                    const current = next[key];
                    if (!current || current.percent !== 100 || current.status !== 'processing') {
                        next[key] = {
                            percent: 100,
                            status: 'processing'
                        };
                        changed = true;
                    }
                });
                return changed ? next : prev;
            });

            completionKeys.forEach((key) => {
                mediaProgressTimeoutRef.current[key] = window.setTimeout(() => {
                    removeMediaProgress(key);
                }, 450);
            });
        });

        newSocket.on('profile.added', (id) => {
            handleSwitchProfile(id);
            setShowAddProfileModal(false);
            setNewProfileName('');
            setIsCreatingProfile(false);
        });

        newSocket.on('profile.error', (data) => {
            setStartingWorkflow(false);
            if (typeof data?.message === 'string') {
                setLastProfileError(data.message);
                pushLog(data.message, 'error');
            }
            if (typeof data?.message === 'string' && data.message.includes('Outside 24h window')) {
                setForceTemplateMode(true);
                return;
            }
            alert(data.message);
            setIsCreatingProfile(false);
            setLoadingChats(false);
        });

        newSocket.on('workflow.started', (data) => {
            setStartingWorkflow(false);
            const profileId = activeProfileIdRef.current;
            if (profileId) {
                newSocket.emit('refreshMessages', profileId);
            }
            if (data?.workflowId) {
                pushLog(`Workflow started: ${data.workflowId}`, 'info');
            }
        });

        newSocket.on('connect_error', (err: any) => {
            setProfilesLoaded(true);
            pushLog(`Socket connect error: ${err?.message || err}`, 'error');
        });

        newSocket.on('disconnect', (reason: any) => {
            pushLog(`Socket disconnected: ${reason}`, 'info');
        });

        const refreshInterval = setInterval(() => {
            if (newSocket.connected && activeProfileIdRef.current) {
                newSocket.emit('refreshMessages', activeProfileIdRef.current);
            }
        }, 10000);

        return () => {
            clearInterval(refreshInterval);
            window.clearTimeout(connectTimer);
            newSocket.removeAllListeners();
            if (newSocket.connected || newSocket.active) {
                newSocket.disconnect();
            }
        };
    }, [session]); // ONLY reconnect if session changes

    // Handle switching profile separately
    useEffect(() => {
        if (socket && activeProfileId) {
            console.log('Switching to profile:', activeProfileId);
            setLoadingChats(true);
            socket.emit('switchProfile', activeProfileId);
        }
    }, [socket, activeProfileId]);

    useEffect(() => {
        if (!session || profilesLoaded) return;
        const timer = window.setTimeout(() => {
            recoverSocketConnection('Profiles load timed out. Restarting socket connection...');
        }, 15_000);
        return () => window.clearTimeout(timer);
    }, [session, profilesLoaded, recoverSocketConnection]);

    useEffect(() => {
        if (!session || !activeProfileId || !loadingChats) return;
        const timer = window.setTimeout(() => {
            recoverSocketConnection('Chat sync timed out. Restarting socket connection...');
        }, 15_000);
        return () => window.clearTimeout(timer);
    }, [session, activeProfileId, loadingChats, recoverSocketConnection]);

    const applyWorkflowsFromServer = (list: any[]) => {
        const normalized = (Array.isArray(list) ? list : []).map((wf: any, idx: number) => {
            const rawId = typeof wf?.id === 'string' ? wf.id.trim() : String(wf?.id ?? '').trim();
            const normalizedId = rawId || `wf-${Date.now()}-${idx}`;
            const normalizedName = typeof wf?.name === 'string' ? wf.name.trim() : '';
            const builderName =
                typeof wf?.builder?.meta?.name === 'string'
                    ? wf.builder.meta.name.trim()
                    : '';
            const builderEnabled =
                typeof wf?.builder?.meta?.enabled === 'boolean'
                    ? wf.builder.meta.enabled
                    : undefined;
            const withEnabled = {
                ...wf,
                id: normalizedId,
                name: normalizedName || builderName,
                enabled: wf?.enabled === false ? false : builderEnabled === false ? false : true
            };
            if (withEnabled?.builder && Array.isArray(withEnabled.builder.nodes)) return withEnabled;
            return {
                ...withEnabled,
                builder: buildBuilderFromActions(Array.isArray(wf?.actions) ? wf.actions : [], normalizedId)
            };
        });

        setWorkflows(normalized);
        const nextSelected = normalized[0]?.id || null;
        if (!selectedWorkflowId || !normalized.find((f: any) => f.id === selectedWorkflowId)) {
            setSelectedWorkflowId(nextSelected);
        }
        const drafts: Record<string, string> = {};
        normalized.forEach((wf: any) => {
            drafts[wf.id] = JSON.stringify(wf.actions || [], null, 2);
        });
        setWorkflowDrafts(drafts);
    };

    useEffect(() => {
        if (activeView !== 'chatflow' || !activeProfileId) return;
        setWorkflowsLoading(true);
        fetch(`${SOCKET_URL}/api/flows?profileId=${activeProfileId}`)
            .then(res => res.json())
            .then(data => {
                const list = Array.isArray(data?.workflows) ? data.workflows : [];
                applyWorkflowsFromServer(list);
            })
            .catch(err => console.error('Failed to fetch workflows:', err))
            .finally(() => setWorkflowsLoading(false));
    }, [activeView, activeProfileId]);

    useEffect(() => {
        if (activeView !== 'dashboard' || !activeProfileId) return;
        setWorkflowsLoading(true);
        fetch(`${SOCKET_URL}/api/flows?profileId=${activeProfileId}`)
            .then(res => res.json())
            .then(data => {
                const list = Array.isArray(data?.workflows) ? data.workflows : [];
                applyWorkflowsFromServer(list);
            })
            .catch(err => console.error('Failed to fetch workflows:', err))
            .finally(() => setWorkflowsLoading(false));
    }, [activeView, activeProfileId]);

    useEffect(() => {
        if (activeView !== 'chatflow' || workflowEditorMode !== 'visual' || !selectedWorkflowId) return;
        const wf = workflows.find(item => item.id === selectedWorkflowId);
        if (!wf) return;
        if (wf.builder && Array.isArray(wf.builder.nodes)) return;
        const builder = buildBuilderFromActions(wf.actions || [], wf.id);
        setWorkflows(prev => prev.map(item => item.id === wf.id ? { ...item, builder } : item));
    }, [activeView, workflowEditorMode, selectedWorkflowId, workflows]);

    const handleSaveWorkflows = async (updatedWorkflows: any[], draftOverrides?: Record<string, string>) => {
        try {
            if (!activeProfileId) {
                alert('No active profile selected.');
                return false;
            }
            // Validate JSON drafts before saving
            const drafts = draftOverrides || workflowDrafts;
            const normalized = updatedWorkflows.map(wf => {
                const workflowName = typeof wf?.name === 'string' ? wf.name.trim() : '';
                const builderMeta =
                    wf?.builder && typeof wf.builder === 'object' && !Array.isArray(wf.builder)
                        ? (wf.builder as any)
                        : null;
                const builderWithName = builderMeta
                    ? {
                        ...builderMeta,
                        meta: {
                            ...(builderMeta.meta && typeof builderMeta.meta === 'object' ? builderMeta.meta : {}),
                            name: workflowName,
                            enabled: wf?.enabled !== false
                        }
                    }
                    : wf?.builder || null;
                const draft = drafts[wf.id];
                if (typeof draft === 'string') {
                    try {
                        return { ...wf, name: workflowName, builder: builderWithName, actions: JSON.parse(draft) };
                    } catch {
                        throw new Error(`Invalid JSON in actions for workflow: ${wf.id}`);
                    }
                }
                return { ...wf, name: workflowName, builder: builderWithName };
            });

            const res = await fetch(`${SOCKET_URL}/api/flows?profileId=${activeProfileId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workflows: normalized })
            });

            const payload = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(payload?.error || `Failed to save workflows (${res.status})`);
            }

            const refreshed = await fetch(`${SOCKET_URL}/api/flows?profileId=${activeProfileId}`);
            const refreshedPayload = await refreshed.json().catch(() => ({}));
            const list = Array.isArray(refreshedPayload?.workflows) ? refreshedPayload.workflows : [];
            applyWorkflowsFromServer(list);

            showToast('Workflows saved', 'success');
            return true;
        } catch (err: any) {
            showToast(err?.message || 'Failed to save workflows', 'error');
            return false;
        }
    };

    const { chatsMap, chatList, latestChatId } = useMemo(() => {
        const nextMap = new Map<string, Chat>();
        allMessages.forEach(msg => {
            const rawJid = msg.key.remoteJid;
            if (!rawJid) return;
            const jid = canonicalContactJid(rawJid);
            if (!jid) return;

            const existing = nextMap.get(jid);
            const content =
                msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.buttonsMessage?.contentText ||
                msg.message?.listMessage?.description ||
                (msg.message?.buttonsMessage ? 'Buttons' : msg.message?.listMessage ? 'List' : 'Media message');

            if (!existing || (msg.messageTimestamp && msg.messageTimestamp > (existing.timestamp || 0))) {
                const cleanId = getCleanId(jid);
                let rawName = pickContactMetaByJid(contacts, rawJid)?.name || msg.pushName || cleanId;
                if (rawName.includes('@')) {
                    rawName = getCleanId(rawName);
                }

                nextMap.set(jid, {
                    id: jid,
                    name: rawName,
                    lastMessage: content,
                    timestamp: msg.messageTimestamp,
                    unreadCount: 0,
                });
            }
        });

        // Ensure contacts with no messages still appear in chat list.
        Object.entries(contacts).forEach(([rawJid, contact]) => {
            const jid = canonicalContactJid(rawJid);
            if (!jid || nextMap.has(jid)) return;
            const mergedContact = pickContactMetaByJid(contacts, jid) || contact;
            const cleanId = getCleanId(jid);
            let rawName = mergedContact?.name || cleanId;
            if (rawName.includes('@')) rawName = getCleanId(rawName);
            const lastInboundMs = mergedContact?.lastInboundAt ? new Date(mergedContact.lastInboundAt).getTime() : 0;
            const timestamp = Number.isFinite(lastInboundMs) && lastInboundMs > 0
                ? Math.floor(lastInboundMs / 1000)
                : 0;
            nextMap.set(jid, {
                id: jid,
                name: rawName,
                lastMessage: '',
                timestamp,
                unreadCount: 0
            });
        });

        const query = searchQuery.trim().toLowerCase();
        const dedupedList = Array.from(nextMap.values())
            .filter((chat) => {
                const meta: ContactMeta = pickContactMetaByJid(contacts, chat.id) || {};
                const tags = splitContactTags(meta.tags).labelTags;
                const hasTags = tags.length > 0;
                const hasAssignee = Boolean((meta.assigneeUserId || '').trim() || (meta.assigneeName || '').trim());
                const cleanId = getCleanId(chat.id).toLowerCase();
                const matchesQuery =
                    !query
                    || chat.name.toLowerCase().includes(query)
                    || cleanId.includes(query)
                    || tags.some((tag) => tag.toLowerCase().includes(query));
                if (!matchesQuery) return false;
                if (chatListFilter === 'tagged') return hasTags;
                if (chatListFilter === 'untagged') return !hasTags;
                if (chatListFilter === 'assigned') return hasAssignee;
                if (chatListFilter === 'unassigned') return !hasAssignee;
                return true;
            })
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        const seenCustomers = new Set<string>();
        const nextList = dedupedList.filter((chat) => {
            const key = canonicalContactJid(chat.id) || chat.id;
            if (seenCustomers.has(key)) return false;
            seenCustomers.add(key);
            return true;
        });

        return {
            chatsMap: nextMap,
            chatList: nextList,
            latestChatId: nextList[0]?.id || null
        };
    }, [allMessages, contacts, searchQuery, chatListFilter]);

    const totalUnreadMessages = useMemo(
        () => Object.values(unreadMessagesByChat).reduce((sum, count) => sum + Math.max(0, Number(count) || 0), 0),
        [unreadMessagesByChat]
    );
    const totalUnreadBadgeCount = Math.max(0, Math.min(999, totalUnreadMessages));

    const contactsList = useMemo(() => {
        type ContactRow = {
            id: string;
            name: string;
            phone: string;
            tags: string[];
            assigneeUserId: string | null;
            assigneeName: string | null;
            assigneeColor: string | null;
            lastInboundAt: string | null;
            lastActivityTs: number;
            totalMessages: number;
        };

        const rows = new Map<string, ContactRow>();
        const ensure = (jid: string): ContactRow | null => {
            const key = canonicalContactJid(jid);
            if (!key || key.endsWith('@g.us')) return null;
            const existing = rows.get(key);
            if (existing) return existing;
            const meta = pickContactMetaByJid(contacts, key) || {};
            const fallbackName = formatPhoneNumber(getCleanId(key));
            const row: ContactRow = {
                id: key,
                name: meta.name || fallbackName,
                phone: formatPhoneNumber(getCleanId(key)),
                tags: splitContactTags(meta.tags).labelTags,
                assigneeUserId: meta.assigneeUserId || null,
                assigneeName: meta.assigneeName || null,
                assigneeColor: meta.assigneeColor || null,
                lastInboundAt: meta.lastInboundAt || null,
                lastActivityTs: meta.lastInboundAt ? new Date(meta.lastInboundAt).getTime() || 0 : 0,
                totalMessages: 0
            };
            rows.set(key, row);
            return row;
        };

        Object.keys(contacts).forEach((jid) => {
            ensure(jid);
        });

        allMessages.forEach((msg) => {
            const jid = msg.key?.remoteJid || '';
            const row = ensure(jid);
            if (!row) return;
            row.totalMessages += 1;
            const ts = (msg.messageTimestamp || 0) * 1000;
            if (ts > row.lastActivityTs) row.lastActivityTs = ts;
            if (!msg.key.fromMe && ts > 0) {
                const inboundIso = new Date(ts).toISOString();
                if (!row.lastInboundAt || ts > new Date(row.lastInboundAt).getTime()) {
                    row.lastInboundAt = inboundIso;
                }
            }
            if (!row.name) {
                row.name = msg.pushName || row.phone;
            }
        });

        const query = contactsSearchQuery.trim().toLowerCase();
        const filtered = Array.from(rows.values()).filter((row) => {
            if (!query) return true;
            if (row.name.toLowerCase().includes(query)) return true;
            if (row.phone.toLowerCase().includes(query)) return true;
            if (row.tags.some((tag) => tag.toLowerCase().includes(query))) return true;
            return false;
        });

        filtered.sort((a, b) => {
            const aTs = a.lastActivityTs || (a.lastInboundAt ? new Date(a.lastInboundAt).getTime() : 0);
            const bTs = b.lastActivityTs || (b.lastInboundAt ? new Date(b.lastInboundAt).getTime() : 0);
            return bTs - aTs;
        });

        return filtered;
    }, [contacts, allMessages, contactsSearchQuery]);

    useEffect(() => {
        if (activeView !== 'dashboard') return;
        if (!selectedChatId && latestChatId) {
            setSelectedChatId(latestChatId);
        }
    }, [activeView, selectedChatId, latestChatId]);

    const tagAnalytics = useMemo(() => {
        const tagCounts = new Map<string, number>();
        const tagMessageCounts = new Map<string, number>();
        const tagsByChat = new Map<string, string[]>();
        const seenContacts = new Set<string>();

        Object.entries(contacts).forEach(([rawJid]) => {
            const jid = canonicalContactJid(rawJid);
            if (!jid || seenContacts.has(jid)) return;
            seenContacts.add(jid);
            const tags = splitContactTags((pickContactMetaByJid(contacts, jid) || {}).tags).labelTags;
            if (tags.length === 0) return;
            tagsByChat.set(jid, tags);
            tags.forEach(tag => {
                tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
            });
        });

        allMessages.forEach(msg => {
            const tags = tagsByChat.get(canonicalContactJid(msg.key?.remoteJid || ''));
            if (!tags || tags.length === 0) return;
            tags.forEach(tag => {
                tagMessageCounts.set(tag, (tagMessageCounts.get(tag) || 0) + 1);
            });
        });

        const rows = Array.from(tagCounts.entries()).map(([tag, count]) => ({
            tag,
            contacts: count,
            messages: tagMessageCounts.get(tag) || 0
        }));
        rows.sort((a, b) => b.contacts - a.contacts);
        return rows;
    }, [contacts, allMessages]);

    const automationWorkflows = useMemo(() => {
        const list = Array.isArray(workflows) ? [...workflows] : [];
        list.sort((a, b) => {
            const aKey = (a?.name || a?.trigger_keyword || a?.id || '').toString();
            const bKey = (b?.name || b?.trigger_keyword || b?.id || '').toString();
            return aKey.localeCompare(bKey);
        });
        return list;
    }, [workflows]);

    const startableWorkflows = useMemo(
        () => automationWorkflows.filter((wf: any) => wf?.enabled !== false),
        [automationWorkflows]
    );

    const workflowTagOptions = useMemo(() => {
        const seen = new Set<string>();
        Object.values(contacts).forEach((contact) => {
            const tags = splitContactTags(contact?.tags).labelTags;
            tags.forEach((tag) => {
                const value = typeof tag === 'string' ? tag.trim() : '';
                if (value) seen.add(value);
            });
        });
        contactTagsDraft.forEach((tag) => {
            const value = typeof tag === 'string' ? tag.trim() : '';
            if (value) seen.add(value);
        });
        return Array.from(seen).sort((a, b) => a.localeCompare(b));
    }, [contacts, contactTagsDraft]);

    const workflowTriggerOptions = useMemo(() => {
        return workflows
            .map((wf: any) => {
                const id = typeof wf?.id === 'string' ? wf.id : '';
                if (!id) return null;
                const name = typeof wf?.name === 'string' ? wf.name.trim() : '';
                const keyword = typeof wf?.trigger_keyword === 'string' ? wf.trigger_keyword.trim() : '';
                const baseLabel = name || id;
                return {
                    id,
                    name: keyword ? `${baseLabel} (${keyword})` : baseLabel
                };
            })
            .filter(Boolean) as Array<{ id: string; name?: string }>;
    }, [workflows]);

    const workflowVariableOptions = useMemo(() => {
        const seen = new Set<string>();

        workflows.forEach((wf: any) => {
            const actions = Array.isArray(wf?.actions) ? wf.actions : [];
            actions.forEach((action: any) => {
                if (action?.type !== 'ask_question') return;
                const key = typeof action?.save_as === 'string'
                    ? action.save_as.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
                    : '';
                if (key) seen.add(key);
            });
        });

        allMessages.forEach((msg) => {
            const vars = msg?.workflowState?.vars;
            if (!vars || typeof vars !== 'object') return;
            Object.keys(vars).forEach((rawKey) => {
                const key = typeof rawKey === 'string'
                    ? rawKey.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
                    : '';
                if (key) seen.add(key);
            });
        });

        return Array.from(seen).sort((a, b) => a.localeCompare(b));
    }, [workflows, allMessages]);

    useEffect(() => {
        if (startWorkflowId && !startableWorkflows.find(wf => wf.id === startWorkflowId)) {
            setStartWorkflowId('');
        }
    }, [startWorkflowId, startableWorkflows]);

    const currentChatMessages = useMemo(() => {
        const selectedKey = canonicalContactJid(selectedChatId);
        if (!selectedKey) return [];
        return allMessages
            .filter(msg => canonicalContactJid(msg.key.remoteJid) === selectedKey)
            .sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));
    }, [allMessages, selectedChatId]);

    const activeProfileStatus = useMemo<'open' | 'close' | 'unknown'>(() => {
        if (!activeProfileId) return 'close';
        const profile = profiles.find((item: any) => item?.id === activeProfileId);
        const status = typeof profile?.status === 'string' ? profile.status.toLowerCase() : '';
        if (!status) return 'unknown';
        return status === 'open' ? 'open' : 'close';
    }, [profiles, activeProfileId]);

    const selectedWorkflowMemory = useMemo(() => {
        let vars: Record<string, string> = {};
        let qaHistory: Array<{ key: string; question: string; answer: string; at: string }> = [];

        for (let idx = currentChatMessages.length - 1; idx >= 0; idx -= 1) {
            const state = currentChatMessages[idx]?.workflowState;
            if (!state || typeof state !== 'object') continue;

            if (Object.keys(vars).length === 0 && state.vars && typeof state.vars === 'object') {
                const nextVars: Record<string, string> = {};
                Object.entries(state.vars as Record<string, unknown>).forEach(([key, value]) => {
                    if (typeof key !== 'string') return;
                    const normalized = key.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
                    if (!normalized) return;
                    if (value === null || value === undefined) return;
                    nextVars[normalized] = String(value);
                });
                if (Object.keys(nextVars).length > 0) vars = nextVars;
            }

            if (qaHistory.length === 0 && Array.isArray(state.qa_history)) {
                const nextQa = state.qa_history
                    .map((entry: any) => ({
                        key: typeof entry?.key === 'string' ? entry.key : '',
                        question: typeof entry?.question === 'string' ? entry.question : '',
                        answer: typeof entry?.answer === 'string' ? entry.answer : '',
                        at: typeof entry?.at === 'string' ? entry.at : ''
                    }))
                    .filter((entry: any) => entry.key && entry.answer);
                if (nextQa.length > 0) qaHistory = nextQa;
            }

            if (Object.keys(vars).length > 0 && qaHistory.length > 0) break;
        }

        return {
            vars,
            qaHistory: qaHistory.slice(-20).reverse()
        };
    }, [currentChatMessages]);

    const messageRows = useMemo<MessageVirtualRow[]>(() => {
        const rows: MessageVirtualRow[] = [];
        let lastDateKey = '';
        currentChatMessages.forEach((msg, idx) => {
            const msgMs = (msg.messageTimestamp || 0) * 1000;
            const dateKey = msgMs ? new Date(msgMs).toDateString() : '';
            const showDate = Boolean(dateKey && dateKey !== lastDateKey);
            if (showDate) {
                lastDateKey = dateKey;
                rows.push({
                    kind: 'date',
                    id: `date-${dateKey}-${idx}`,
                    label: formatDateLabel(msgMs)
                });
            }
            rows.push({
                kind: 'message',
                id: msg.key.id || `${msg.key.remoteJid || 'msg'}-${idx}`,
                msg
            });
        });
        return rows;
    }, [currentChatMessages]);

    const messageContentHeight = useMemo(() => {
        if (messageRows.length === 0) return 0;
        let total = 0;
        for (let index = 0; index < messageRows.length; index += 1) {
            const size = messageRowHeight.getRowHeight(index);
            if (typeof size === 'number' && Number.isFinite(size) && size > 0) {
                total += size;
            } else {
                total += 120;
            }
        }
        return total;
    }, [messageRows, messageRowHeight]);

    const messageTopPadding = useMemo(() => {
        const viewportHeight = messageViewport.height || 0;
        if (!viewportHeight) return 0;
        return Math.max(0, viewportHeight - messageContentHeight);
    }, [messageViewport.height, messageContentHeight]);

    const getMessageMediaId = useCallback((message: Message): string | null => {
        if (!message?.message) return null;
        const imageMediaId = message.message.imageMessage?.mediaId;
        const documentMediaId = message.message.documentMessage?.mediaId;
        const audioMediaId = message.message.audioMessage?.mediaId;
        const videoMediaId = message.message.videoMessage?.mediaId;
        return imageMediaId || documentMediaId || audioMediaId || videoMediaId || null;
    }, []);

    const clearMediaDownloadTimers = useCallback((key: string | null | undefined) => {
        if (!key) return;
        const progressTimer = mediaProgressTimerRef.current[key];
        if (typeof progressTimer === 'number') {
            window.clearInterval(progressTimer);
            delete mediaProgressTimerRef.current[key];
        }
        const timeoutTimer = mediaProgressTimeoutRef.current[key];
        if (typeof timeoutTimer === 'number') {
            window.clearTimeout(timeoutTimer);
            delete mediaProgressTimeoutRef.current[key];
        }
    }, []);

    const removeMediaProgress = useCallback((key: string | null | undefined) => {
        if (!key) return;
        clearMediaDownloadTimers(key);
        setMediaDownloadProgress((prev) => {
            if (!(key in prev)) return prev;
            const next = { ...prev };
            delete next[key];
            return next;
        });
    }, [clearMediaDownloadTimers]);

    const beginMediaDownload = useCallback((message: Message, options?: { force?: boolean }) => {
        if (!socket || !activeProfileId) return;
        const mediaId = getMessageMediaId(message);
        if (!mediaId) return;
        const messageId = message.key?.id;
        if (messageId && mediaCache[messageId]) return;
        if (mediaCache[mediaId]) return;
        const requestKey = messageId || mediaId;
        if (!requestKey) return;
        if (requestedMediaRef.current.has(requestKey)) return;

        const existingProgress = mediaDownloadProgressRef.current[requestKey];
        if (!options?.force && existingProgress?.status === 'error') return;

        clearMediaDownloadTimers(requestKey);
        requestedMediaRef.current.add(requestKey);
        setMediaDownloadProgress((prev) => ({
            ...prev,
            [requestKey]: {
                percent: 8,
                status: 'requesting'
            }
        }));

        const progressTimer = window.setInterval(() => {
            setMediaDownloadProgress((prev) => {
                const current = prev[requestKey];
                if (!current || current.status === 'error') return prev;
                const increment = current.status === 'requesting' ? 16 : current.percent < 62 ? 9 : 4;
                const nextPercent = Math.min(92, current.percent + increment);
                const nextStatus: MediaDownloadStatus = nextPercent >= 72 ? 'processing' : 'downloading';
                if (nextPercent === current.percent && nextStatus === current.status) return prev;
                return {
                    ...prev,
                    [requestKey]: {
                        percent: nextPercent,
                        status: nextStatus
                    }
                };
            });
        }, 550);
        mediaProgressTimerRef.current[requestKey] = progressTimer;

        const timeoutTimer = window.setTimeout(() => {
            clearMediaDownloadTimers(requestKey);
            requestedMediaRef.current.delete(requestKey);
            setMediaDownloadProgress((prev) => {
                const current = prev[requestKey];
                if (!current) return prev;
                return {
                    ...prev,
                    [requestKey]: {
                        percent: Math.max(current.percent, 12),
                        status: 'error'
                    }
                };
            });
        }, 30000);
        mediaProgressTimeoutRef.current[requestKey] = timeoutTimer;

        socket.emit('downloadMedia', { profileId: activeProfileId, message });
    }, [activeProfileId, clearMediaDownloadTimers, getMessageMediaId, mediaCache, socket]);

    const getMediaDownloadProgress = useCallback((message: Message): MediaDownloadProgressState | null => {
        const requestKey = message.key?.id || getMessageMediaId(message);
        if (!requestKey) return null;
        return mediaDownloadProgress[requestKey] || null;
    }, [getMessageMediaId, mediaDownloadProgress]);

    const renderMediaLoadingPlaceholder = useCallback((message: Message, compact = false) => {
        const progress = getMediaDownloadProgress(message);
        if (!progress) {
            return (
                <div className={`animate-pulse space-y-2 ${compact ? 'w-32' : 'w-28'}`}>
                    <div className="h-3 rounded bg-[#e8edf1]" />
                    <div className="h-3 rounded bg-[#eef2f5]" />
                </div>
            );
        }

        const isError = progress.status === 'error';
        const percent = Math.max(1, Math.min(100, Math.round(progress.percent)));
        const statusLabel =
            progress.status === 'requesting'
                ? 'Requesting file...'
                : progress.status === 'downloading'
                    ? 'Downloading file...'
                    : progress.status === 'processing'
                        ? 'Preparing preview...'
                        : 'Download failed';

        return (
            <div className={`space-y-2 ${compact ? 'w-44' : 'w-52'}`}>
                <div className="h-2 rounded-full bg-[#e8edf1] overflow-hidden">
                    <div
                        className={`h-full transition-all duration-300 ${isError ? 'bg-rose-400' : 'bg-[#00a884]'}`}
                        style={{ width: `${isError ? Math.max(percent, 12) : percent}%` }}
                    />
                </div>
                <div className="flex items-center justify-between gap-2">
                    <span className={`text-[10px] font-semibold ${isError ? 'text-rose-600' : 'text-[#54656f]'}`}>
                        {statusLabel}
                    </span>
                    {isError ? (
                        <button
                            type="button"
                            onClick={(event) => {
                                event.stopPropagation();
                                beginMediaDownload(message, { force: true });
                            }}
                            className="text-[10px] font-bold text-rose-600 hover:text-rose-700 hover:underline"
                        >
                            Retry
                        </button>
                    ) : (
                        <span className="text-[10px] font-semibold text-[#54656f]">{percent}%</span>
                    )}
                </div>
            </div>
        );
    }, [beginMediaDownload, getMediaDownloadProgress]);

    useEffect(() => {
        if (!selectedChatId) return;
        if (messageRows.length === 0) return;
        let cancelled = false;
        const timers: number[] = [];
        const scrollToLatest = () => {
            if (cancelled) return;
            messageListRef.current?.scrollToRow({
                index: messageRows.length - 1,
                align: 'end'
            });
        };
        const run = () => requestAnimationFrame(scrollToLatest);
        run();
        timers.push(window.setTimeout(run, 60));
        timers.push(window.setTimeout(run, 180));
        return () => {
            cancelled = true;
            timers.forEach((timerId) => window.clearTimeout(timerId));
        };
    }, [selectedChatId, chatOpenNonce, messageRows.length, messageViewport.height]);

    useEffect(() => {
        return () => {
            Object.keys(mediaProgressTimerRef.current).forEach((key) => {
                window.clearInterval(mediaProgressTimerRef.current[key]);
            });
            Object.keys(mediaProgressTimeoutRef.current).forEach((key) => {
                window.clearTimeout(mediaProgressTimeoutRef.current[key]);
            });
            mediaProgressTimerRef.current = {};
            mediaProgressTimeoutRef.current = {};
            requestedMediaRef.current.clear();
        };
    }, []);

    useEffect(() => {
        if (!selectedChatId) return;
        currentChatMessages.forEach((msg) => {
            const hasDirectMediaUrl = Boolean(
                msg.message?.imageMessage?.url ||
                msg.message?.documentMessage?.url ||
                msg.message?.videoMessage?.url
            );
            if (hasDirectMediaUrl) return;
            const imageMediaId = msg.message?.imageMessage?.mediaId;
            const docMediaId = msg.message?.documentMessage?.mediaId;
            const docName = msg.message?.documentMessage?.fileName || '';
            const docMime = msg.message?.documentMessage?.mimetype || '';
            const docIsImage = Boolean(
                docMime.startsWith('image/') ||
                /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(docName)
            );
            const audioMediaId = msg.message?.audioMessage?.mediaId;
            const videoMediaId = msg.message?.videoMessage?.mediaId;
            const mediaId = imageMediaId || (docIsImage ? docMediaId : undefined) || audioMediaId || videoMediaId;
            if (!mediaId) return;
            beginMediaDownload(msg);
        });
    }, [beginMediaDownload, selectedChatId, currentChatMessages]);

    const currentAgentName =
        (session?.user?.user_metadata as any)?.full_name ||
        (session?.user?.user_metadata as any)?.name ||
        (session?.user?.email ? String(session.user.email).split('@')[0] : 'You');

    const selectedChat = selectedChatId
        ? (chatsMap.get(selectedChatId) || {
            id: selectedChatId,
            name: pickContactMetaByJid(contacts, selectedChatId)?.name || getCleanId(selectedChatId),
            lastMessage: '',
            timestamp: 0,
            unreadCount: 0
        })
        : null;
    const selectedContact = selectedChatId ? pickContactMetaByJid(contacts, selectedChatId) : null;
    const selectedContactTemplateAttributes = useMemo(() => {
        const list = Array.isArray(selectedContact?.templateAttributes)
            ? [...selectedContact.templateAttributes]
            : [];
        return list
            .sort((a, b) => {
                const aMs = new Date(a.savedAt || '').getTime();
                const bMs = new Date(b.savedAt || '').getTime();
                if (Number.isNaN(aMs) && Number.isNaN(bMs)) return 0;
                if (Number.isNaN(aMs)) return 1;
                if (Number.isNaN(bMs)) return -1;
                return bMs - aMs;
            })
            .slice(0, 20);
    }, [selectedContact?.templateAttributes]);
    const selectedHumanTakeover = Boolean(selectedContact?.humanTakeover);
    const selectedAssigneeName = selectedContact?.assigneeName || null;
    const selectedAssigneeColor = selectedContact?.assigneeColor || '#6b7280';
    const selectedAssigneeInitials = getInitials(selectedAssigneeName || 'Unassigned');
    const assignTargetContact = assignMenuContactId ? pickContactMetaByJid(contacts, assignMenuContactId) : null;
    const assignTargetName = assignMenuContactId
        ? (assignTargetContact?.name || chatsMap.get(assignMenuContactId)?.name || formatPhoneNumber(getCleanId(assignMenuContactId)))
        : '';
    const assignTargetPhone = assignMenuContactId ? formatPhoneNumber(getCleanId(assignMenuContactId)) : '';
    const assignTargetAssigneeUserId = assignTargetContact?.assigneeUserId || null;
    const lastInboundMs = getLastInboundTs(allMessages, selectedChatId, contacts);
    const windowExpiresMs = lastInboundMs ? lastInboundMs + 24 * 60 * 60 * 1000 : null;
    const windowRemainingMs = windowExpiresMs ? windowExpiresMs - now : null;
    const windowOpen = windowRemainingMs !== null && windowRemainingMs > 0;
    const ctaFreeWindowExpiresMs = selectedContact?.ctaFreeWindowExpiresAt
        ? new Date(selectedContact.ctaFreeWindowExpiresAt || '').getTime()
        : null;
    const ctaFreeWindowRemainingMs =
        ctaFreeWindowExpiresMs && !Number.isNaN(ctaFreeWindowExpiresMs)
            ? ctaFreeWindowExpiresMs - now
            : null;
    const ctaFreeWindowOpen = ctaFreeWindowRemainingMs !== null && ctaFreeWindowRemainingMs > 0;
    const canSendText = windowOpen && !forceTemplateMode;
    const hasComposerMedia = composerMediaType !== 'none'
        && (
            composerMediaId.trim().length > 0
            || composerMediaAssetKey.trim().length > 0
            || composerMediaUrl.trim().length > 0
        );
    const quickReplyQuery = useMemo(() => {
        const trimmed = messageText.trim();
        if (!trimmed.startsWith('/')) return null;
        const token = trimmed.slice(1).split(/\s+/)[0];
        return token.toLowerCase();
    }, [messageText]);

    const quickReplySuggestions = useMemo(() => {
        if (quickReplyQuery === null) return [];
        const query = quickReplyQuery;
        return quickReplies
            .filter(item => {
                const shortcut = normalizeQuickReplyShortcut(item.shortcut);
                if (!shortcut) return false;
                return query === '' || shortcut.startsWith(query);
            })
            .slice(0, 8);
    }, [quickReplies, quickReplyQuery, normalizeQuickReplyShortcut]);

    const selectedTemplateOption = useMemo(() => {
        if (!selectedTemplateOptionId) return null;
        return templateComposerOptions.find((option) => option.id === selectedTemplateOptionId) || null;
    }, [selectedTemplateOptionId, templateComposerOptions]);

    const selectedTemplateHeader = useMemo(
        () => findTemplateComponent(selectedTemplateOption?.components, 'HEADER'),
        [selectedTemplateOption]
    );
    const selectedTemplateBody = useMemo(
        () => findTemplateComponent(selectedTemplateOption?.components, 'BODY'),
        [selectedTemplateOption]
    );
    const selectedTemplateHeaderFormat = useMemo(
        () => normalizeTemplateComponentType(selectedTemplateHeader?.format || selectedTemplateHeader?.type),
        [selectedTemplateHeader]
    );
    const requiredTemplateBodyAttributeCount = useMemo(
        () => extractTemplateVariableCount(selectedTemplateBody?.text),
        [selectedTemplateBody]
    );
    const requiredTemplateHeaderAttributeCount = useMemo(
        () => selectedTemplateHeaderFormat === 'TEXT' ? extractTemplateVariableCount(selectedTemplateHeader?.text) : 0,
        [selectedTemplateHeader, selectedTemplateHeaderFormat]
    );
    const savedTemplateBodyAttributesByIndex = useMemo(() => {
        const map = new Map<number, ContactTemplateAttribute>();
        const templateName = selectedTemplateOption?.name?.trim().toLowerCase();
        if (!templateName || !Array.isArray(selectedContact?.templateAttributes)) return map;
        selectedContact.templateAttributes.forEach((entry) => {
            if (!entry || entry.scope !== 'body') return;
            if (entry.templateName.trim().toLowerCase() !== templateName) return;
            if (!map.has(entry.index)) {
                map.set(entry.index, entry);
            }
        });
        return map;
    }, [selectedContact?.templateAttributes, selectedTemplateOption?.name]);

    useEffect(() => {
        setTemplateBodyAttributes((prev) =>
            Array.from({ length: requiredTemplateBodyAttributeCount }, (_, index) => prev[index] || '')
        );
    }, [requiredTemplateBodyAttributeCount]);

    useEffect(() => {
        setTemplateBodyAttributeNames((prev) =>
            Array.from(
                { length: requiredTemplateBodyAttributeCount },
                (_, index) => prev[index] || inferTemplateVariableLabel(selectedTemplateBody?.text, index + 1, 'body')
            )
        );
    }, [requiredTemplateBodyAttributeCount, selectedTemplateBody]);

    useEffect(() => {
        setTemplateHeaderAttributes((prev) =>
            Array.from({ length: requiredTemplateHeaderAttributeCount }, (_, index) => prev[index] || '')
        );
    }, [requiredTemplateHeaderAttributeCount]);

    useEffect(() => {
        if (!selectedTemplateOption) return;
        setTemplateName(selectedTemplateOption.name);
        setTemplateLanguage(selectedTemplateOption.language || 'en_US');
        setTemplateComponents('');
        setTemplateHeaderMediaUrl('');
        setTemplateHeaderDocumentFilename((prev) => {
            if (prev.trim()) return prev;
            return `${selectedTemplateOption.name}.pdf`;
        });
        setTemplateBodyAttributes(
            Array.from(
                { length: requiredTemplateBodyAttributeCount },
                (_, index) => savedTemplateBodyAttributesByIndex.get(index + 1)?.value || ''
            )
        );
        setTemplateBodyAttributeNames(
            Array.from(
                { length: requiredTemplateBodyAttributeCount },
                (_, index) =>
                    savedTemplateBodyAttributesByIndex.get(index + 1)?.key
                    || inferTemplateVariableLabel(selectedTemplateBody?.text, index + 1, 'body')
            )
        );
    }, [
        selectedTemplateOption,
        requiredTemplateBodyAttributeCount,
        savedTemplateBodyAttributesByIndex,
        selectedTemplateBody
    ]);

    const inferComposerMediaType = useCallback((file: File): 'image' | 'video' | 'document' => {
        const mimeType = (file.type || '').toLowerCase();
        if (mimeType.startsWith('image/')) return 'image';
        if (mimeType.startsWith('video/')) return 'video';
        return 'document';
    }, []);

    const resetComposerMedia = useCallback((nextType: 'none' | 'image' | 'video' | 'document' = 'none') => {
        setComposerMediaUrl((prev) => {
            if (typeof prev === 'string' && prev.startsWith('blob:')) {
                URL.revokeObjectURL(prev);
            }
            return '';
        });
        setComposerMediaId('');
        setComposerMediaAssetKey('');
        setComposerMediaMimeType('');
        setComposerMediaSizeBytes(null);
        setComposerMediaFilename('');
        setComposerMediaError(null);
        setComposerMediaUploading(false);
        setComposerDragActive(false);
        setComposerMediaType(nextType);
        if (nextType === 'none') {
            setShowMediaComposer(false);
        }
    }, []);

    useEffect(() => {
        return () => {
            if (composerMediaUrl.startsWith('blob:')) {
                URL.revokeObjectURL(composerMediaUrl);
            }
        };
    }, [composerMediaUrl]);

    const uploadComposerMediaFile = useCallback(async (file: File, requestedType: 'image' | 'video' | 'document') => {
        if (!activeProfileId || !session?.access_token) {
            setComposerMediaError('Select a profile and login before uploading media.');
            return;
        }
        setShowMediaComposer(true);
        setComposerMediaType(requestedType);
        setComposerMediaUploading(true);
        setComposerMediaError(null);
        try {
            const uploaded = await uploadFileToWabaMedia({
                apiBaseUrl: SOCKET_URL,
                profileId: activeProfileId,
                sessionToken: session.access_token,
                file
            });
            const previewUrl = URL.createObjectURL(file);
            setComposerMediaUrl((prev) => {
                if (prev.startsWith('blob:')) {
                    URL.revokeObjectURL(prev);
                }
                return previewUrl;
            });
            setComposerMediaId(uploaded.mediaId);
            setComposerMediaAssetKey('');
            setComposerMediaMimeType(uploaded.mimeType);
            setComposerMediaSizeBytes(uploaded.sizeBytes);
            setComposerMediaFilename(requestedType === 'document' ? (uploaded.fileName || 'document') : '');
        } catch (error: any) {
            setComposerMediaError(error?.message || 'Upload failed.');
            setComposerMediaId('');
            setComposerMediaAssetKey('');
            setComposerMediaMimeType('');
            setComposerMediaSizeBytes(null);
        } finally {
            setComposerMediaUploading(false);
        }
    }, [activeProfileId, session?.access_token]);

    const handleComposerMediaInputChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0] || null;
        event.target.value = '';
        if (!file) return;
        const messageType =
            composerMediaType === 'image' || composerMediaType === 'video' || composerMediaType === 'document'
                ? composerMediaType
                : inferComposerMediaType(file);
        void uploadComposerMediaFile(file, messageType);
    }, [composerMediaType, inferComposerMediaType, uploadComposerMediaFile]);

    const handleComposerDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
        if (!canSendText) return;
        const hasFiles = Array.from(event.dataTransfer?.types || []).includes('Files');
        if (!hasFiles) return;
        event.preventDefault();
        event.stopPropagation();
        if (!composerDragActive) {
            setComposerDragActive(true);
        }
    }, [canSendText, composerDragActive]);

    const handleComposerDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setComposerDragActive(false);
    }, []);

    const handleComposerDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
        if (!canSendText) return;
        event.preventDefault();
        event.stopPropagation();
        setComposerDragActive(false);
        const file = event.dataTransfer?.files?.[0] || null;
        if (!file) return;
        const messageType = inferComposerMediaType(file);
        void uploadComposerMediaFile(file, messageType);
    }, [canSendText, inferComposerMediaType, uploadComposerMediaFile]);

    const openComposerMediaPicker = useCallback((messageType: 'image' | 'video' | 'document') => {
        setShowMediaComposer(true);
        if (composerMediaType !== messageType) {
            resetComposerMedia(messageType);
        } else {
            setComposerMediaError(null);
            setComposerMediaType(messageType);
        }
        requestAnimationFrame(() => {
            composerFileInputRef.current?.click();
        });
    }, [composerMediaType, resetComposerMedia]);

    const handleQuickReplyPick = (item: QuickReply) => {
        const text = typeof item.text === 'string' ? item.text.trim() : '';
        const quickReplyType = normalizeQuickReplyMessageType(item.message_type);
        const mediaUrl = normalizeQuickReplyMediaUrl(item.media_url);
        const mediaStorage = normalizeQuickReplyMediaStorage(item.media_storage);
        const mediaAssetKey = normalizeQuickReplyMediaAssetKey(item.media_asset_key);
        const mediaMimeType = normalizeQuickReplyMediaMimeType(item.media_mime_type);
        const mediaSizeBytes = normalizeQuickReplyMediaSizeBytes(item.media_size_bytes);
        const mediaFilename = normalizeQuickReplyMediaFilename(item.media_filename);
        if (!text && quickReplyType === 'text') return;

        if (quickReplyType === 'text' || (!mediaUrl && !mediaAssetKey)) {
            resetComposerMedia('none');
        } else {
            setComposerMediaType(quickReplyType);
            setComposerMediaUrl(mediaUrl);
            setComposerMediaId('');
            setComposerMediaAssetKey(mediaStorage === 'r2' ? mediaAssetKey : '');
            setComposerMediaMimeType(mediaMimeType);
            setComposerMediaSizeBytes(mediaSizeBytes);
            setComposerMediaFilename(quickReplyType === 'document' ? (mediaFilename || 'document') : '');
            setComposerMediaError(null);
            setShowMediaComposer(true);
        }

        setMessageTextWithDraft(text);
        requestAnimationFrame(() => {
            if (!messageInputRef.current) return;
            messageInputRef.current.focus();
            messageInputRef.current.setSelectionRange(text.length, text.length);
        });
    };

    useEffect(() => {
        if (!lastInboundMs) return;
        if (lastInboundRef.current === null || lastInboundMs > lastInboundRef.current) {
            lastInboundRef.current = lastInboundMs;
            setForceTemplateMode(false);
        }
    }, [lastInboundMs]);

    const buildOutgoingPayloadFromMessage = useCallback((msg: Message): {
        text: string;
        media?: { type: 'image' | 'video' | 'document'; id?: string; url?: string; assetKey?: string; filename?: string };
    } | null => {
        if (!msg?.key?.fromMe) return null;
        const text =
            typeof msg?.message?.conversation === 'string'
                ? msg.message.conversation.trim()
                : typeof msg?.message?.extendedTextMessage?.text === 'string'
                    ? msg.message.extendedTextMessage.text.trim()
                    : '';
        const imageMediaId =
            typeof msg?.message?.imageMessage?.mediaId === 'string'
                ? msg.message.imageMessage.mediaId.trim()
                : '';
        const imageUrl = typeof msg?.message?.imageMessage?.url === 'string' ? msg.message.imageMessage.url.trim() : '';
        const imageAssetKey = typeof msg?.message?.imageMessage?.assetKey === 'string' ? msg.message.imageMessage.assetKey.trim() : '';
        if (imageMediaId || imageUrl || imageAssetKey) {
            return {
                text,
                media: {
                    type: 'image',
                    ...(imageMediaId ? { id: imageMediaId } : {}),
                    ...(imageUrl ? { url: imageUrl } : {}),
                    ...(imageAssetKey ? { assetKey: imageAssetKey } : {})
                }
            };
        }
        const videoMediaId =
            typeof msg?.message?.videoMessage?.mediaId === 'string'
                ? msg.message.videoMessage.mediaId.trim()
                : '';
        const videoUrl = typeof msg?.message?.videoMessage?.url === 'string' ? msg.message.videoMessage.url.trim() : '';
        const videoAssetKey = typeof msg?.message?.videoMessage?.assetKey === 'string' ? msg.message.videoMessage.assetKey.trim() : '';
        if (videoMediaId || videoUrl || videoAssetKey) {
            return {
                text,
                media: {
                    type: 'video',
                    ...(videoMediaId ? { id: videoMediaId } : {}),
                    ...(videoUrl ? { url: videoUrl } : {}),
                    ...(videoAssetKey ? { assetKey: videoAssetKey } : {})
                }
            };
        }
        const documentMediaId =
            typeof msg?.message?.documentMessage?.mediaId === 'string'
                ? msg.message.documentMessage.mediaId.trim()
                : '';
        const documentUrl = typeof msg?.message?.documentMessage?.url === 'string' ? msg.message.documentMessage.url.trim() : '';
        const documentAssetKey =
            typeof msg?.message?.documentMessage?.assetKey === 'string'
                ? msg.message.documentMessage.assetKey.trim()
                : '';
        if (documentMediaId || documentUrl || documentAssetKey) {
            const filename =
                typeof msg?.message?.documentMessage?.fileName === 'string'
                    ? msg.message.documentMessage.fileName.trim()
                    : '';
            return {
                text,
                media: {
                    type: 'document',
                    ...(documentMediaId ? { id: documentMediaId } : {}),
                    ...(documentUrl ? { url: documentUrl } : {}),
                    ...(documentAssetKey ? { assetKey: documentAssetKey } : {}),
                    ...(filename ? { filename } : {})
                }
            };
        }
        if (!text) return null;
        return { text };
    }, []);

    const handleResendMessage = useCallback((messageId: string) => {
        if (!socket || !activeProfileId) return;
        const failedMessage = allMessages.find((msg) => msg.key?.id === messageId);
        if (!failedMessage || !failedMessage.key?.fromMe) return;
        const payload = buildOutgoingPayloadFromMessage(failedMessage);
        if (!payload) return;
        const jid = typeof failedMessage.key?.remoteJid === 'string'
            ? failedMessage.key.remoteJid
            : (selectedChatId || '');
        if (!jid) return;

        const resendTempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        setAllMessages((prev) =>
            prev.map((msg) =>
                msg.key?.id === messageId
                    ? {
                        ...msg,
                        key: { ...msg.key, id: resendTempId, remoteJid: jid },
                        messageTimestamp: Math.floor(Date.now() / 1000),
                        status: 'pending'
                    }
                    : msg
            )
        );

        socket.emit(
            'sendMessage',
            {
                profileId: activeProfileId,
                jid,
                text: payload.text,
                ...(payload.media ? { media: payload.media } : {}),
                clientTempId: resendTempId
            },
            (ack: any) => {
                if (!ack?.success) {
                    setAllMessages((prev) =>
                        prev.map((msg) =>
                            msg.key?.id === resendTempId
                                ? { ...msg, status: 'failed' }
                                : msg
                        )
                    );
                    return;
                }
                const realMessageId = typeof ack?.data?.messageId === 'string' ? ack.data.messageId : '';
                if (!realMessageId) return;
                setAllMessages((prev) =>
                    prev.map((msg) =>
                        msg.key?.id === resendTempId
                            ? { ...msg, key: { ...msg.key, id: realMessageId }, status: 'sent' }
                            : msg
                    )
                );
            }
        );
    }, [activeProfileId, allMessages, buildOutgoingPayloadFromMessage, selectedChatId, socket]);

    const handleSendMessage = () => {
        if (!socket || !activeProfileId || !selectedChatId) return;
        if (composerMediaUploading) return;
        const outgoingText = messageText.trim();
        const mediaId = composerMediaId.trim();
        const mediaUrl = composerMediaUrl.trim();
        const mediaAssetKey = composerMediaAssetKey.trim();
        const mediaType = composerMediaType;
        const mediaFilename = composerMediaFilename.trim();
        const tempMessageId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const sendMedia =
            (mediaType === 'image' || mediaType === 'video' || mediaType === 'document') && (mediaId || mediaUrl || mediaAssetKey)
                ? {
                    type: mediaType,
                    ...(mediaId ? { id: mediaId } : {}),
                    ...(mediaUrl ? { url: mediaUrl } : {}),
                    ...(mediaAssetKey ? { assetKey: mediaAssetKey } : {}),
                    ...(mediaType === 'document' && mediaFilename ? { filename: mediaFilename } : {})
                }
                : null;

        if (!outgoingText && !sendMedia) return;

        socket.emit(
            'sendMessage',
            {
                profileId: activeProfileId,
                jid: selectedChatId,
                text: outgoingText,
                ...(sendMedia ? { media: sendMedia } : {}),
                clientTempId: tempMessageId
            },
            (ack: any) => {
                if (!ack?.success) {
                    setAllMessages((prev) =>
                        prev.map((msg) =>
                            msg.key?.id === tempMessageId
                                ? { ...msg, status: 'failed' }
                                : msg
                        )
                    );
                    return;
                }
                const realMessageId = typeof ack?.data?.messageId === 'string' ? ack.data.messageId : '';
                if (!realMessageId) return;
                setAllMessages((prev) =>
                    prev.map((msg) =>
                        msg.key?.id === tempMessageId
                            ? { ...msg, key: { ...msg.key, id: realMessageId }, status: 'sent' }
                            : msg
                    )
                );
            }
        );
        const tempMsg: Message = {
            key: { id: tempMessageId, remoteJid: selectedChatId, fromMe: true },
            message: (() => {
                if (!sendMedia) return { conversation: outgoingText };
                if (sendMedia.type === 'image') {
                    return {
                        ...(outgoingText ? { conversation: outgoingText } : {}),
                        imageMessage: {
                            mediaId: sendMedia.id,
                            caption: outgoingText,
                            assetKey: sendMedia.assetKey,
                            url: sendMedia.url
                        }
                    };
                }
                if (sendMedia.type === 'video') {
                    return {
                        ...(outgoingText ? { conversation: outgoingText } : {}),
                        videoMessage: {
                            mediaId: sendMedia.id,
                            caption: outgoingText,
                            assetKey: sendMedia.assetKey,
                            url: sendMedia.url
                        }
                    };
                }
                return {
                    ...(outgoingText ? { conversation: outgoingText } : {}),
                    documentMessage: {
                        mediaId: sendMedia.id,
                        caption: outgoingText,
                        assetKey: sendMedia.assetKey,
                        fileName: sendMedia.filename || 'document',
                        url: sendMedia.url
                    }
                };
            })(),
            messageTimestamp: Math.floor(Date.now() / 1000),
            status: 'pending',
            agent: {
                user_id: session?.user?.id,
                name: currentAgentName,
                color: '#6b7280'
            }
        };
        setAllMessages(prev => [tempMsg, ...prev]);
        persistDraft('', activeProfileId, selectedChatId);
        setMessageText('');
        resetComposerMedia('none');
    };

    const openSettingsFromMore = useCallback(() => {
        if (isUiFeatureHidden(SETTINGS_UI_FEATURE_KEY)) return;
        setWorkspaceSection('team-inbox');
        requestAnimationFrame(() => {
            setActiveView('settings');
        });
    }, [isUiFeatureHidden]);

    const openAnalyticsFromMore = useCallback(() => {
        if (isUiFeatureHidden('analytics')) return;
        setWorkspaceSection('team-inbox');
        requestAnimationFrame(() => {
            setShowAnalytics(true);
        });
    }, [isUiFeatureHidden]);

    const handleToggleHumanTakeover = useCallback(async () => {
        if (!socket || !activeProfileId || !selectedChatId) return;
        if (selectedChatId.endsWith('@g.us')) return;

        const nextEnabled = !selectedHumanTakeover;
        setHumanTakeoverSaving(true);
        try {
            const response: any = await new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    resolve({ success: false, error: 'Request timed out. Please try again.' });
                }, 8000);
                socket.emit(
                    'contact.human_takeover',
                    { profileId: activeProfileId, jid: selectedChatId, enabled: nextEnabled },
                    (ack: any) => {
                        clearTimeout(timeout);
                        resolve(ack);
                    }
                );
            });
            if (!response?.success) {
                throw new Error(response?.error || 'Failed to update human takeover');
            }
        } catch (err: any) {
            alert(err?.message || 'Failed to update human takeover');
        } finally {
            setHumanTakeoverSaving(false);
        }
    }, [activeProfileId, selectedChatId, selectedHumanTakeover, socket]);

    const handleCallAction = useCallback(async (kind: 'voice' | 'video') => {
        if (!session?.access_token) {
            showToast('Please login again before checking call permission.', 'error');
            return;
        }
        if (!activeProfileId) {
            showToast('No active profile selected.', 'error');
            return;
        }
        if (!selectedChatId) return;
        if (selectedChatId.endsWith('@g.us')) {
            showToast('Calls are not supported for groups yet.', 'error');
            return;
        }

        const userWaId = getCleanId(selectedChatId).replace(/\D/g, '');
        if (!userWaId) {
            showToast('This contact has no valid WhatsApp ID for calling.', 'error');
            return;
        }

        setCallActionLoading(kind);
        try {
            const params = new URLSearchParams({
                profileId: activeProfileId,
                user_wa_id: userWaId
            });
            const response = await fetch(`${SOCKET_URL}/api/waba/call-permissions?${params.toString()}`, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${session.access_token}`
                }
            });
            const payload = await response.json().catch(() => null);
            if (!response.ok || payload?.success === false) {
                throw new Error(payload?.error || `Failed with status ${response.status}`);
            }

            const permissionStatus = String(payload?.data?.permission?.status || '').toLowerCase();
            const actions = Array.isArray(payload?.data?.actions) ? payload.data.actions : [];
            const startAction = actions.find((entry: any) => String(entry?.action_name || '').toLowerCase() === 'start_call');
            const canStartCall = startAction?.can_perform_action === true;
            const callTypeLabel = kind === 'video' ? 'Video call' : 'Voice call';

            if (permissionStatus === 'granted' && canStartCall) {
                showToast(`${callTypeLabel} is permitted. Dialer UI not enabled yet.`, 'success');
                pushLog(`[Calls] ${callTypeLabel} permitted for ${userWaId}.`, 'info');
            } else if (permissionStatus === 'pending') {
                showToast('Call permission is pending approval from this user.', 'error');
            } else if (permissionStatus === 'denied') {
                showToast('Call permission was denied by this user.', 'error');
            } else if (permissionStatus === 'expired') {
                showToast('Call permission has expired. Request permission again.', 'error');
            } else {
                showToast('Call permission is not available for this contact.', 'error');
            }
        } catch (error: any) {
            const rawMessage = String(error?.message || '').toLowerCase();
            if (rawMessage.includes('calling api not enabled') || rawMessage.includes('code=138000')) {
                showToast('Meta Calling API is not enabled for this phone number yet. Enable WhatsApp Cloud Calling for this number first.', 'error');
            } else {
                showToast(error?.message || 'Failed to check call permission.', 'error');
            }
        } finally {
            setCallActionLoading(null);
        }
    }, [activeProfileId, selectedChatId, session?.access_token, showToast, pushLog]);

    const handleStartWorkflow = () => {
        if (!socket || !selectedChatId || !activeProfileId || !startWorkflowId) return;
        if (selectedChatId.endsWith('@g.us')) {
            alert('Workflows are not supported for groups.');
            return;
        }
        setStartingWorkflow(true);
        socket.emit('startWorkflow', { profileId: activeProfileId, jid: selectedChatId, workflowId: startWorkflowId });
        pushLog(`Starting workflow ${startWorkflowId}`, 'info');
        setShowWorkflowStarter(false);
    };

    const handleCreateAutomation = useCallback(() => {
        const id = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const actions = [{ type: 'send_text', text: 'Hello! How can we help you?' }];
        const newWorkflow = {
            id,
            name: '',
            trigger_keyword: '',
            run_on_new_chat: false,
            actions,
            enabled: false,
            builder: buildBuilderFromActions(actions, id)
        };
        const nextWorkflows = [...automationWorkflows, newWorkflow];
        const nextDrafts = {
            ...workflowDrafts,
            [id]: JSON.stringify(actions, null, 2)
        };

        setWorkflows(nextWorkflows);
        setWorkflowDrafts(nextDrafts);
        setSelectedWorkflowId(id);
        setWorkspaceSection('team-inbox');
        setActiveView('chatflow');
        void handleSaveWorkflows(nextWorkflows, nextDrafts);
        showToast('New automation created. Tick it on when ready.', 'success');
    }, [
        automationWorkflows,
        buildBuilderFromActions,
        handleSaveWorkflows,
        showToast,
        workflowDrafts
    ]);

    const openAutomationBuilder = useCallback((workflowId: string | null) => {
        const requestedId = typeof workflowId === 'string' ? workflowId.trim() : '';
        const preferredSelectedId = typeof selectedWorkflowId === 'string' ? selectedWorkflowId.trim() : '';
        const fallbackWorkflow = automationWorkflows.find((workflow: any) => {
            const id = workflow?.id;
            if (typeof id === 'string') return id.trim().length > 0;
            if (typeof id === 'number') return Number.isFinite(id);
            return false;
        });

        const preferredId = requestedId || preferredSelectedId;
        const targetWorkflow =
            (preferredId
                ? automationWorkflows.find((workflow: any) => String(workflow?.id ?? '').trim() === preferredId)
                : null)
            || fallbackWorkflow;

        if (!targetWorkflow) {
            handleCreateAutomation();
            return;
        }

        const targetName = typeof targetWorkflow?.name === 'string' ? targetWorkflow.name.trim() : '';
        showToast(`Opening workflow ${targetName || String(targetWorkflow.id)}...`, 'success');
        setSelectedWorkflowId(String(targetWorkflow.id));
        setWorkflowEditorMode('visual');
        setWorkspaceSection('team-inbox');
        setActiveView('chatflow');
    }, [automationWorkflows, handleCreateAutomation, selectedWorkflowId, showToast]);

    const handleSaveWorkflowTrigger = useCallback(async (workflowId: string, triggerKeyword: string, runOnNewChat: boolean) => {
        const normalizedId = workflowId.trim();
        if (!normalizedId) {
            throw new Error('Workflow is required.');
        }
        const target = automationWorkflows.find((workflow: any) => String(workflow?.id ?? '').trim() === normalizedId);
        if (!target) {
            throw new Error('Workflow not found.');
        }

        const normalizedTrigger = triggerKeyword.trim();
        const nextWorkflows = automationWorkflows.map((workflow: any) =>
            String(workflow?.id ?? '').trim() === normalizedId
                ? { ...workflow, trigger_keyword: normalizedTrigger, run_on_new_chat: runOnNewChat }
                : runOnNewChat
                    ? { ...workflow, run_on_new_chat: false }
                : workflow
        );
        const nextDrafts = { ...workflowDrafts };
        nextWorkflows.forEach((workflow: any) => {
            if (typeof nextDrafts[workflow.id] === 'string') return;
            nextDrafts[workflow.id] = JSON.stringify(Array.isArray(workflow.actions) ? workflow.actions : [], null, 2);
        });

        setWorkflows(nextWorkflows);
        setWorkflowDrafts(nextDrafts);
        const saved = await handleSaveWorkflows(nextWorkflows, nextDrafts);
        if (!saved) {
            throw new Error('Failed to save trigger.');
        }
    }, [automationWorkflows, handleSaveWorkflows, workflowDrafts]);

    const handleToggleAutomationEnabled = useCallback((workflowId: string, nextEnabled: boolean) => {
        const targetWorkflow = automationWorkflows.find((workflow: any) => workflow.id === workflowId);
        const workflowLabel = typeof targetWorkflow?.name === 'string' && targetWorkflow.name.trim()
            ? targetWorkflow.name.trim()
            : workflowId;
        const nextWorkflows = automationWorkflows.map((workflow: any) =>
            workflow.id === workflowId
                ? { ...workflow, enabled: nextEnabled }
                : workflow
        );
        const nextDrafts = { ...workflowDrafts };
        nextWorkflows.forEach((workflow: any) => {
            if (typeof nextDrafts[workflow.id] === 'string') return;
            nextDrafts[workflow.id] = JSON.stringify(Array.isArray(workflow.actions) ? workflow.actions : [], null, 2);
        });

        setWorkflows(nextWorkflows);
        setWorkflowDrafts(nextDrafts);
        if (!nextEnabled && startWorkflowId === workflowId) {
            setStartWorkflowId('');
        }
        void handleSaveWorkflows(nextWorkflows, nextDrafts);
        showToast(nextEnabled ? `Automation ${workflowLabel} is on.` : `Automation ${workflowLabel} is off.`, 'success');
    }, [
        automationWorkflows,
        handleSaveWorkflows,
        showToast,
        startWorkflowId,
        workflowDrafts
    ]);

    const handleCopyAutomation = useCallback((workflowId: string) => {
        const sourceId = workflowId.trim();
        const sourceWorkflow = automationWorkflows.find(
            (workflow: any) => String(workflow?.id ?? '').trim() === sourceId
        );
        if (!sourceWorkflow) {
            showToast('Workflow not found to copy.', 'error');
            return;
        }

        const existingIds = new Set(
            automationWorkflows.map((workflow: any) => String(workflow?.id ?? '').trim()).filter(Boolean)
        );
        let copiedId = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        while (existingIds.has(copiedId)) {
            copiedId = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        }

        const existingNames = new Set(
            automationWorkflows
                .map((workflow: any) => (typeof workflow?.name === 'string' ? workflow.name.trim() : ''))
                .filter(Boolean)
                .map((name: string) => name.toLowerCase())
        );
        const sourceName = typeof sourceWorkflow?.name === 'string' ? sourceWorkflow.name.trim() : '';
        let copiedName = sourceName ? `${sourceName}-copy` : 'workflow-copy';
        let copyNameIndex = 2;
        while (existingNames.has(copiedName.toLowerCase())) {
            copiedName = sourceName ? `${sourceName}-copy-${copyNameIndex}` : `workflow-copy-${copyNameIndex}`;
            copyNameIndex += 1;
        }

        const sourceActions = Array.isArray(sourceWorkflow.actions) ? sourceWorkflow.actions : [];
        const copiedActions = JSON.parse(JSON.stringify(sourceActions));
        const copiedBuilder = sourceWorkflow?.builder && Array.isArray(sourceWorkflow.builder.nodes)
            ? JSON.parse(JSON.stringify(sourceWorkflow.builder))
            : buildBuilderFromActions(copiedActions, copiedId);
        if (copiedBuilder && typeof copiedBuilder === 'object') {
            copiedBuilder.id = copiedId;
        }

        const sourceTrigger = typeof sourceWorkflow?.trigger_keyword === 'string'
            ? sourceWorkflow.trigger_keyword.trim()
            : '';

        const copiedWorkflow = {
            ...sourceWorkflow,
            id: copiedId,
            name: copiedName,
            trigger_keyword: sourceTrigger,
            run_on_new_chat: false,
            enabled: false,
            actions: copiedActions,
            builder: copiedBuilder
        };

        const nextWorkflows = [...automationWorkflows, copiedWorkflow];
        const nextDrafts = {
            ...workflowDrafts,
            [copiedId]: JSON.stringify(copiedActions, null, 2)
        };

        setWorkflows(nextWorkflows);
        setWorkflowDrafts(nextDrafts);
        setSelectedWorkflowId(copiedId);
        void handleSaveWorkflows(nextWorkflows, nextDrafts);
        showToast(`Automation copied as ${copiedName}`, 'success');
    }, [
        automationWorkflows,
        buildBuilderFromActions,
        handleSaveWorkflows,
        showToast,
        workflowDrafts
    ]);

    const handleClearChat = () => {
        if (!socket || !selectedChatId || !activeProfileId) return;
        if (selectedChatId.endsWith('@g.us')) {
            alert('Clear chat is not supported for groups.');
            return;
        }
        const ok = confirm('Clear this chat history? This cannot be undone.');
        if (!ok) return;
        socket.emit('clearChat', { profileId: activeProfileId, jid: selectedChatId });
    };

    const handleSaveContact = () => {
        if (!socket || !selectedChatId || !activeProfileId) return;
        if (selectedChatId.endsWith('@g.us')) return;
        const existingContact = pickContactMetaByJid(contacts, selectedChatId);
        const { systemTags } = splitContactTags(existingContact?.tags);
        const nextLabelTags = splitContactTags(contactTagsDraft).labelTags;
        const mergedTags = [...systemTags, ...nextLabelTags];
        const aliasKeys = buildContactJidVariants(selectedChatId);
        const canonicalKey = canonicalContactJid(selectedChatId) || selectedChatId;

        // Optimistic local update so labels appear immediately before socket round-trip.
        setContacts((prev) => {
            const next = { ...prev };
            const prevMeta = pickContactMetaByJid(next, canonicalKey) || existingContact || {};
            aliasKeys.forEach((key) => {
                if (key !== canonicalKey) delete next[key];
            });
            next[canonicalKey] = {
                ...prevMeta,
                name: contactDraftName.trim() || prevMeta.name || getCleanId(canonicalKey),
                tags: mergedTags
            };
            return next;
        });

        socket.emit('contact.update', {
            profileId: activeProfileId,
            jid: selectedChatId,
            name: contactDraftName.trim(),
            tags: mergedTags
        });
        setContactDirty(false);
        pushLog('Contact saved.', 'info');
    };

    const handleAddTag = () => {
        const next = contactTagInput.trim();
        if (!next) return;
        if (SYSTEM_CONTACT_TAGS.has(normalizeTagKey(next))) {
            setContactTagInput('');
            alert('This label is reserved by the system. Please use another label name.');
            return;
        }
        if (contactTagsDraft.includes(next)) {
            setContactTagInput('');
            return;
        }
        setContactTagsDraft(prev => [...prev, next]);
        setContactTagInput('');
        setContactDirty(true);
    };

    const handleRemoveTag = (tag: string) => {
        setContactTagsDraft(prev => prev.filter(t => t !== tag));
        setContactDirty(true);
    };

    const handleDownloadMedia = (message: Message) => {
        beginMediaDownload(message, { force: true });
    };

    const handleSendTemplate = () => {
        if (!socket || !selectedChatId || !activeProfileId) return;
        if (!templateName.trim()) {
            alert('Template name is required.');
            return;
        }

        let components: any[] | undefined;
        let namedBodyAttributes: Array<{ scope: 'body'; index: number; key: string; value: string }> = [];
        if (templateComponents.trim()) {
            try {
                const parsed = JSON.parse(templateComponents);
                if (!Array.isArray(parsed)) {
                    alert('Template components must be a JSON array.');
                    return;
                }
                components = parsed;
            } catch {
                alert('Invalid JSON in template components.');
                return;
            }
        } else if (selectedTemplateOption) {
            const built: any[] = [];
            const headerType = selectedTemplateHeaderFormat;
            const mediaLink = templateHeaderMediaUrl.trim();
            if (requiredTemplateHeaderAttributeCount > 0) {
                const missingHeaderParamIndex = templateHeaderAttributes.findIndex((value) => !value.trim());
                if (missingHeaderParamIndex >= 0) {
                    alert(`Header attribute {{${missingHeaderParamIndex + 1}}} is required.`);
                    return;
                }
                built.push({
                    type: 'header',
                    parameters: templateHeaderAttributes.map((value) => ({
                        type: 'text',
                        text: value.trim()
                    }))
                });
            } else if (headerType === 'IMAGE' || headerType === 'VIDEO' || headerType === 'DOCUMENT') {
                if (!mediaLink) {
                    alert(`Template header requires ${headerType.toLowerCase()} link.`);
                    return;
                }
                if (headerType === 'DOCUMENT') {
                    built.push({
                        type: 'header',
                        parameters: [
                            {
                                type: 'document',
                                document: {
                                    link: mediaLink,
                                    ...(templateHeaderDocumentFilename.trim()
                                        ? { filename: templateHeaderDocumentFilename.trim() }
                                        : {})
                                }
                            }
                        ]
                    });
                } else if (headerType === 'IMAGE') {
                    built.push({
                        type: 'header',
                        parameters: [{ type: 'image', image: { link: mediaLink } }]
                    });
                } else if (headerType === 'VIDEO') {
                    built.push({
                        type: 'header',
                        parameters: [{ type: 'video', video: { link: mediaLink } }]
                    });
                }
            }

            if (requiredTemplateBodyAttributeCount > 0) {
                const missingBodyParamIndex = templateBodyAttributes.findIndex((value) => !value.trim());
                if (missingBodyParamIndex >= 0) {
                    alert(`Body attribute {{${missingBodyParamIndex + 1}}} is required.`);
                    return;
                }
                const missingBodyAttributeNameIndex = templateBodyAttributeNames.findIndex((value) => !value.trim());
                if (missingBodyAttributeNameIndex >= 0) {
                    alert(`Body attribute label for {{${missingBodyAttributeNameIndex + 1}}} is required.`);
                    return;
                }
                built.push({
                    type: 'body',
                    parameters: templateBodyAttributes.map((value) => ({
                        type: 'text',
                        text: value.trim()
                    }))
                });
                namedBodyAttributes = templateBodyAttributes.map((value, index) => ({
                    scope: 'body' as const,
                    index: index + 1,
                    key: (templateBodyAttributeNames[index] || inferTemplateVariableLabel(selectedTemplateBody?.text, index + 1, 'body')).trim(),
                    value: value.trim()
                }));
            }
            components = built.length > 0 ? built : undefined;
        }

        socket.emit('sendTemplate', {
            profileId: activeProfileId,
            jid: selectedChatId,
            name: templateName.trim(),
            language: templateLanguage.trim() || 'en_US',
            components,
            bodyAttributes: namedBodyAttributes
        });
        setShowTemplateComposer(false);
    };

    const handleSwitchProfile = (id: string) => {
        setActiveProfileId(id);
        setAllMessages([]);
        setContacts({});
        setSelectedChatId(null);
        setUnreadMessagesByChat({});
        seenIncomingMessageKeysRef.current.clear();
        setShowTemplateComposer(false);
        setConnectionStatus('connecting'); // Anticipate status update
        setLoadingChats(true);
        socket?.emit('switchProfile', id);
        setShowProfileMenu(false);
    };

    const handleAddProfile = () => {
        setShowAddProfileModal(true);
    };

    const submitAddProfile = () => {
        if (newProfileName.trim() && !isCreatingProfile) {
            setIsCreatingProfile(true);
            console.log('Submitting new profile:', newProfileName.trim());
            socket?.emit('addProfile', newProfileName.trim());
        }
    };

    const handleUpdateProfileName = (profileId: string, currentName: string) => {
        setEditingProfileId(profileId);
        setEditingProfileName(currentName);
        setShowEditProfileModal(true);
    };

    const submitUpdateProfileName = () => {
        if (editingProfileName.trim() && editingProfileName !== profiles.find(p => p.id === editingProfileId)?.name) {
            socket?.emit('updateProfileName', { profileId: editingProfileId, name: editingProfileName.trim() });
            setShowEditProfileModal(false);
        }
    };

    const handleDeleteProfile = (profileId: string, name: string) => {
        socket?.emit('deleteProfile', profileId);
        if (activeProfileId === profileId) {
            // If we deleted the active profile, switch to default or first available
            const next = profiles.find(p => p.id !== profileId);
            if (next) {
                handleSwitchProfile(next.id);
            } else {
                handleSwitchProfile('default');
            }
        }
    };

    const handleOpenChat = useCallback((chatId: string) => {
        setSelectedChatId(chatId);
        const chatKey = canonicalContactJid(chatId);
        if (chatKey) {
            setUnreadMessagesByChat((prev) => {
                if (!(chatKey in prev)) return prev;
                const next = { ...prev };
                delete next[chatKey];
                return next;
            });
        }
        setChatOpenNonce((prev) => prev + 1);
    }, []);

    const handleNewChat = () => {
        if (!newPhoneNumber.trim()) return;
        let cleanNumber = newPhoneNumber.replace(/\D/g, '');
        if (!cleanNumber.includes('@')) {
            cleanNumber = `${cleanNumber}@s.whatsapp.net`;
        }
        handleOpenChat(cleanNumber);
        setShowNewChatModal(false);
        setNewPhoneNumber('');
    };

    const canStartWorkflow = Boolean(startWorkflowId) && !startingWorkflow && !selectedChatId?.endsWith('@g.us');
    const workflowStarter = (
        <div className="relative">
            <button
                onClick={() => setShowWorkflowStarter(prev => !prev)}
                className="p-1.5 hover:bg-white rounded-lg transition-all text-[#54656f]"
                title="Start workflow"
            >
                <Bot className="w-5 h-5" />
            </button>
            {showWorkflowStarter && (
                <div className="absolute bottom-full mb-2 left-0 bg-white border border-[#eceff1] rounded-2xl shadow-[0_10px_30px_rgba(0,0,0,0.12)] p-3 z-20">
                    <div className="flex items-center gap-2">
                        <select
                            value={startWorkflowId}
                            onChange={(e) => setStartWorkflowId(e.target.value)}
                            disabled={startableWorkflows.length === 0}
                            className="bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-[12px] font-bold text-[#111b21] focus:outline-none focus:ring-1 focus:ring-[#00a884]/20 disabled:opacity-60 w-[170px]"
                        >
                            <option value="">
                                {startableWorkflows.length === 0 ? 'No workflows' : 'Choose workflow'}
                            </option>
                            {startableWorkflows.map((wf: any) => (
                                <option key={wf.id} value={wf.id}>
                                    {wf.name || wf.trigger_keyword || wf.id}
                                </option>
                            ))}
                        </select>
                        <button
                            onClick={handleStartWorkflow}
                            disabled={!canStartWorkflow}
                            className="px-3 py-2 rounded-xl bg-[#111b21] text-white text-[11px] font-bold uppercase tracking-widest flex items-center gap-2 hover:bg-[#202c33] transition-all disabled:opacity-50"
                        >
                            <Play className="w-4 h-4" />
                            {startingWorkflow ? 'Starting' : 'Start'}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );

    if (authChecking) {
        return (
            <div className="h-screen bg-[#f8f9fa] text-[#111b21] p-6 md:p-10">
                <div className="animate-pulse max-w-5xl mx-auto space-y-6">
                    <div className="h-10 w-64 rounded-xl bg-[#e8edf1]" />
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="h-28 rounded-2xl bg-white border border-[#eceff1]" />
                        <div className="h-28 rounded-2xl bg-white border border-[#eceff1]" />
                        <div className="h-28 rounded-2xl bg-white border border-[#eceff1]" />
                    </div>
                    <div className="h-[380px] rounded-3xl bg-white border border-[#eceff1]" />
                </div>
            </div>
        );
    }

    if (!session) {
        return (
            <Login
                forcedMessage={hostAuthError}
                onLogin={(nextSession) => {
                    setHostAuthError(null);
                    setSession(nextSession);
                    setAuthChecking(false);
                }}
            />
        )
    }

    const baseWorkspaceTabs: Array<{
        id: 'team-inbox' | 'broadcast' | 'chatbots' | 'contacts' | 'ads' | 'automations' | 'more';
        label: string;
        icon: React.ComponentType<{ className?: string }>;
        beta?: boolean;
    }> = [
            { id: 'team-inbox', label: 'Team Inbox', icon: MessageSquare },
            { id: 'automations', label: 'Automation', icon: Workflow },
            { id: 'broadcast', label: 'Broadcast', icon: Send },
            { id: 'chatbots', label: 'Chatbot', icon: Bot },
            { id: 'contacts', label: 'Contacts', icon: Users },
            { id: 'more', label: 'Analytic', icon: BarChart3 }
        ];

    const showUiControlsSkeleton = Boolean(session?.access_token) && uiControlsLoading;
    const workspaceTabs = showUiControlsSkeleton
        ? []
        : baseWorkspaceTabs.filter((tab) => !isUiFeatureHidden(UI_FEATURE_KEY_BY_WORKSPACE_SECTION[tab.id]));

    const activeWorkspaceLabel = workspaceTabs.find(tab => tab.id === workspaceSection)?.label || 'Workspace';
    const defaultWorkspaceSection = workspaceTabs[0]?.id || 'team-inbox';
    const broadcastNav: Array<{ id: 'template-library' | 'my-templates' | 'broadcast-history' | 'scheduled-broadcasts'; label: string }> = [
        { id: 'template-library', label: 'Create Template' },
        { id: 'my-templates', label: 'My Templates' },
        { id: 'broadcast-history', label: 'Broadcast History' },
        { id: 'scheduled-broadcasts', label: 'Scheduled Broadcasts' }
    ];

    return (
        <>
            {isOffline && (
                <>
                    <div className="fixed top-0 inset-x-0 z-[260] bg-[#111b21] text-white border-b border-[#2f3b42]">
                        <div className="h-11 px-4 flex items-center justify-center gap-2 text-[12px] font-bold tracking-wide">
                            <span className="px-2 py-0.5 rounded-full bg-rose-500/90 text-[10px] uppercase">Offline</span>
                            <span>No internet connection. Reconnecting…</span>
                        </div>
                    </div>
                    <div className="fixed left-1/2 -translate-x-1/2 bottom-5 z-[260] pointer-events-none">
                        <div className="offline-dino-card">
                            <div className="offline-dino-stage">
                                <div className="offline-dino-runner" role="img" aria-label="Running dinosaur">🦖</div>
                                <div className="offline-dino-ground" />
                            </div>
                            <div className="offline-dino-label">
                                Waiting for internet
                                <span className="offline-dino-dots" aria-hidden="true">
                                    <span>.</span>
                                    <span>.</span>
                                    <span>.</span>
                                </span>
                            </div>
                        </div>
                    </div>
                </>
            )}
            <header className="fixed top-0 inset-x-0 z-[120] h-[72px] bg-white border-b border-[#eceff1]">
                <div className="h-full px-5 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-5 min-w-0 flex-1">
                        <div className="flex items-center gap-2 shrink-0">
                            <div className="h-8 min-w-[96px] max-w-[170px] px-3 rounded-lg border border-[#eceff1] bg-[#f8f9fa] flex items-center justify-center overflow-hidden">
                                <img
                                    src={appLogoUrl || qmessageLogo}
                                    alt="QMessage logo"
                                    className="h-6 w-auto max-w-[150px] object-contain"
                                    loading="lazy"
                                />
                            </div>
                        </div>
                        <div className="hidden xl:block w-px h-8 bg-[#eceff1]" />
                        <nav className="flex items-center gap-1 overflow-x-auto whitespace-nowrap custom-scrollbar">
                            {showUiControlsSkeleton ? (
                                <div className="animate-pulse flex items-center gap-2">
                                    <div className="h-9 w-28 rounded-xl bg-[#eef2f5]" />
                                    <div className="h-9 w-24 rounded-xl bg-[#eef2f5]" />
                                    <div className="h-9 w-24 rounded-xl bg-[#eef2f5]" />
                                    <div className="h-9 w-24 rounded-xl bg-[#eef2f5]" />
                                </div>
                            ) : workspaceTabs.map((tab) => {
                                const Icon = tab.icon;
                                const active = tab.id === 'more' ? showAnalytics : workspaceSection === tab.id;
                                return (
                                    <button
                                        key={tab.id}
                                        onClick={() => {
                                            if (tab.id === 'more') {
                                                openAnalyticsFromMore();
                                                return;
                                            }
                                            setWorkspaceSection(tab.id);
                                        }}
                                        className={`px-3 py-2 rounded-xl text-[16px] font-bold transition-all flex items-center gap-2 ${active ? 'text-[#00a884] bg-[#00a884]/10' : 'text-[#4a4a4a] hover:bg-[#f0f2f5]'}`}
                                    >
                                        <Icon className="w-4 h-4" />
                                        <span>{tab.label}</span>
                                        {tab.beta && (
                                            <span className="px-2 py-0.5 rounded-full bg-[#dcfce7] text-[#15803d] text-[10px] font-black uppercase tracking-wider">
                                                Beta
                                            </span>
                                        )}
                                    </button>
                                );
                            })}
                        </nav>
                    </div>
                    <div className="flex items-center gap-2">
                        {showUiControlsSkeleton ? (
                            <>
                                <div className="w-10 h-10 rounded-full bg-[#eef2f5] animate-pulse" />
                                <div className="hidden md:block w-10 h-10 rounded-full bg-[#eef2f5] animate-pulse" />
                            </>
                        ) : (
                            <>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setActiveView('dashboard');
                                        setShowAnalytics(false);
                                        setWorkspaceSection('team-inbox');
                                    }}
                                    className="relative w-10 h-10 rounded-full bg-[#f3f4f6] text-[#00a884] flex items-center justify-center hover:bg-[#e8f5f1] transition-all"
                                    title="Unread messages"
                                >
                                    <MessageSquare className="w-5 h-5" />
                                    {totalUnreadBadgeCount > 0 && (
                                        <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-[#ef4444] text-white text-[9px] font-black leading-4 text-center border border-white">
                                            {totalUnreadBadgeCount}
                                        </span>
                                    )}
                                </button>
                                {!isUiFeatureHidden(SETTINGS_UI_FEATURE_KEY) && (
                                    <button
                                        onClick={openSettingsFromMore}
                                        className="hidden md:flex w-10 h-10 rounded-full bg-[#f3f4f6] text-[#6b7280] items-center justify-center"
                                    >
                                        <User className="w-5 h-5" />
                                    </button>
                                )}
                            </>
                        )}
                    </div>
                </div>
            </header>

            {workspaceSection === 'team-inbox' ? (
                <div className="flex h-screen pt-[72px] bg-[#f8f9fa] overflow-hidden text-[#111b21] font-sans">
            <div className="w-[400px] border-r border-[#eceff1] flex flex-col bg-white">
                <div className="px-3 py-2 border-b border-[#f0f2f5]">
                    <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1.5">
                            <button
                                type="button"
                                onClick={() => setShowNewChatModal(true)}
                                className="w-8 h-8 rounded-lg bg-[#00a884]/12 border border-[#00a884]/25 text-[#00a884] flex items-center justify-center hover:bg-[#00a884]/18 transition-all"
                                title="Start new chat"
                            >
                                <MessageSquare className="w-4 h-4" />
                            </button>
                            <button
                                type="button"
                                onClick={() => setShowNewChatModal(true)}
                                className="w-8 h-8 rounded-lg bg-[#2563eb]/12 border border-[#2563eb]/25 text-[#2563eb] flex items-center justify-center hover:bg-[#2563eb]/18 transition-all"
                                title="Start new chat"
                            >
                                <MessageSquare className="w-4 h-4" />
                            </button>
                            <button
                                type="button"
                                onClick={() => setShowNewChatModal(true)}
                                className="w-8 h-8 rounded-lg bg-[#ec4899]/12 border border-[#ec4899]/25 text-[#ec4899] flex items-center justify-center hover:bg-[#ec4899]/18 transition-all"
                                title="Start new chat"
                            >
                                <MessageSquare className="w-4 h-4" />
                            </button>
                        </div>
                        <div className="flex-1 bg-[#f0f2f5] rounded-xl flex items-center px-4 py-2 focus-within:bg-white focus-within:ring-1 focus-within:ring-[#00a884]/20 transition-all">
                            <Search className="w-4 h-4 text-[#54656f] mr-4" />
                            <input
                                type="text"
                                placeholder="Search or start new chat"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="bg-transparent border-none text-[15px] w-full focus:outline-none placeholder:text-[#54656f]"
                            />
                        </div>
                        <div className="w-[132px] bg-[#f0f2f5] rounded-xl flex items-center px-2.5 py-2 border border-transparent focus-within:border-[#00a884]/30 transition-all">
                            <Filter className="w-3.5 h-3.5 text-[#54656f] mr-2" />
                            <select
                                value={chatListFilter}
                                onChange={(e) => setChatListFilter(e.target.value as typeof chatListFilter)}
                                className="bg-transparent text-[11px] font-bold text-[#334155] w-full focus:outline-none"
                            >
                                <option value="all">All</option>
                                <option value="tagged">Tagged</option>
                                <option value="untagged">Untagged</option>
                                <option value="assigned">Assigned</option>
                                <option value="unassigned">Unassigned</option>
                            </select>
                        </div>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto custom-scrollbar">
                    {!activeProfileId ? (
                        <div className="p-4 flex flex-col items-center justify-center h-full text-center bg-white">
                            {profilesLoaded ? (
                                <>
                                    <User className="w-12 h-12 text-[#54656f] mb-4 opacity-10" />
                                    <p className="text-[#111b21] font-bold mb-2">No Profile active</p>
                                    <p className="text-sm text-[#8696a0] mb-6">
                                        {SINGLE_PROFILE_MODE
                                            ? 'Default WABA profile will appear here once created.'
                                            : 'Create or select a profile to start'}
                                    </p>
                                    {!SINGLE_PROFILE_MODE && (
                                        <button
                                            onClick={() => setShowAddProfileModal(true)}
                                            className="bg-[#00a884] text-black px-6 py-2 rounded-lg font-bold hover:bg-[#008f6f] transition-all"
                                        >
                                            Create First Profile
                                        </button>
                                    )}
                                </>
                            ) : (
                                <div className="w-full max-w-[240px] animate-pulse space-y-2">
                                    <div className="h-4 rounded bg-[#e8edf1]" />
                                    <div className="h-3 rounded bg-[#eef2f5] w-4/5 mx-auto" />
                                    <div className="h-3 rounded bg-[#eef2f5] w-3/5 mx-auto" />
                                </div>
                            )}
                        </div>
                    ) : activeProfileStatus === 'close' ? (
                        <div className="p-6 flex flex-col items-center justify-center h-full text-center">
                            <div className="bg-white p-6 rounded-2xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)] max-w-md">
                                <ShieldCheck className="w-10 h-10 text-[#00a884] mx-auto mb-4" />
                                <p className="text-[#111b21] font-bold mb-2">WABA not configured for this profile</p>
                                <p className="text-sm text-[#54656f] leading-relaxed">
                                    Add your Meta Cloud API credentials in Supabase `waba_configs` and enable the config.
                                    Once saved, refresh the page and the profile will show as connected.
                                </p>
                            </div>
                        </div>
                    ) : connectionStatus !== 'open' ? (
                        <div className="p-6 flex flex-col items-center justify-center h-full text-center">
                            <div className="bg-white p-6 rounded-2xl border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)] max-w-md">
                                <CircleDashed className="w-10 h-10 text-[#00a884] mx-auto mb-4 animate-spin" />
                                <p className="text-[#111b21] font-bold mb-2">Connecting to WABA...</p>
                                <p className="text-sm text-[#54656f] leading-relaxed">
                                    Waiting for live connection. If this takes more than a few seconds, refresh the page.
                                </p>
                            </div>
                        </div>
                    ) : (
                        <div className="h-full overflow-hidden" ref={chatListViewportRef}>
                            {loadingChats ? (
                                <div className="h-full p-3 animate-pulse space-y-3">
                                    {Array.from({ length: 8 }).map((_, idx) => (
                                        <div key={`chat-skeleton-${idx}`} className="flex items-center gap-3 px-2 py-2 rounded-xl border border-[#eef2f5] bg-white">
                                            <div className="h-10 w-10 rounded-full bg-[#e8edf1]" />
                                            <div className="flex-1 space-y-2">
                                                <div className="h-3 w-1/3 rounded bg-[#e8edf1]" />
                                                <div className="h-2.5 w-2/3 rounded bg-[#eef2f5]" />
                                            </div>
                                            <div className="h-2.5 w-10 rounded bg-[#eef2f5]" />
                                        </div>
                                    ))}
                                </div>
                            ) : chatList.length === 0 ? (
                                <div className="h-full flex items-center justify-center text-sm text-[#8696a0]">
                                    No chats found.
                                </div>
                            ) : chatListViewport.height > 0 ? (
                                <List
                                    style={{
                                        height: chatListViewport.height,
                                        width: chatListViewport.width || '100%'
                                    }}
                                    rowCount={chatList.length}
                                    rowHeight={CHAT_ROW_HEIGHT}
                                    rowProps={{}}
                                    overscanCount={8}
                                    rowComponent={(props: any) => {
                                        const { index, style } = props as { index: number; style: React.CSSProperties };
                                        const chat = chatList[index];
                                        const contactMeta = pickContactMetaByJid(contacts, chat.id) || {};
                                        const assigneeName = contactMeta.assigneeName || null;
                                        const assigneeColor = contactMeta.assigneeColor || '#6b7280';
                                        const contactTags = splitContactTags(contactMeta.tags).labelTags;
                                        const primaryTag = contactTags[0] || null;
                                        const extraTagCount = Math.max(0, contactTags.length - (primaryTag ? 1 : 0));
                                        return (
                                            <div style={style}>
                                                <div
                                                    onClick={() => handleOpenChat(chat.id)}
                                                    className={`flex items-center px-3 py-2 cursor-pointer hover:bg-[#f5f6f6] transition-colors border-b border-[#fcfdfd] ${selectedChatId === chat.id ? 'bg-[#f0f2f5]' : ''}`}
                                                >
                                                    <div className="w-12 h-12 rounded-full bg-[#f0f2f5] mr-3 flex-shrink-0 flex items-center justify-center border border-[#eceff1]">
                                                        {chat.id.endsWith('@g.us') ? (
                                                            <Users className="text-[#54656f] w-5 h-5" />
                                                        ) : (
                                                            <User className="text-[#54656f] w-5 h-5" />
                                                        )}
                                                    </div>
                                                    <div className="flex-1 min-w-0 border-b border-[#f5f6f6] pb-3 pt-1">
                                                        <div className="flex justify-between items-baseline mb-0.5">
                                                            <h3 className="font-bold text-[16px] truncate pr-2 text-[#111b21]">
                                                                {chat.name}
                                                            </h3>
                                                            <span className="text-[11px] font-medium text-[#54656f]">
                                                                {chat.timestamp ? new Date(chat.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                                                            </span>
                                                        </div>
                                                        {(chat.id.endsWith('@s.whatsapp.net') || chat.id.endsWith('@lid')) &&
                                                            getCleanId(chat.name) !== getCleanId(chat.id) && (
                                                                <div className="text-[11px] text-[#00a884] font-bold leading-none mb-1">
                                                                    {formatPhoneNumber(getCleanId(chat.id))}
                                                                </div>
                                                            )}
                                                        <div className="flex items-center justify-between mt-0.5 gap-2">
                                                            <div className="flex-1 min-w-0 flex items-center gap-1.5">
                                                                <p className="truncate text-[13px] text-[#54656f] font-medium leading-tight flex-1 min-w-0">
                                                                    {chat.lastMessage}
                                                                </p>
                                                                {primaryTag && (
                                                                    <span
                                                                        className="max-w-[84px] truncate px-1.5 py-0.5 rounded-full bg-[#e8f5f1] border border-[#d1eee6] text-[9px] font-bold text-[#0f766e] uppercase tracking-wide"
                                                                        title={primaryTag}
                                                                    >
                                                                        {primaryTag}
                                                                    </span>
                                                                )}
                                                                {extraTagCount > 0 && (
                                                                    <span className="text-[9px] font-bold text-[#6b7280]">+{extraTagCount}</span>
                                                                )}
                                                            </div>
                                                            <div className="ml-2 flex items-center gap-1.5 shrink-0">
                                                                {assigneeName ? (
                                                                    <button
                                                                        type="button"
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            if (!teamUsers.length && !teamUsersLoading) fetchTeamUsers();
                                                                            setAssignMenuContactId(prev => (prev === chat.id ? null : chat.id));
                                                                        }}
                                                                        className="px-1.5 py-0.5 text-[9px] rounded uppercase font-bold border tracking-tight hover:opacity-85 transition-all"
                                                                        style={{
                                                                            backgroundColor: withHexAlpha(assigneeColor, '20', '#f3f4f6'),
                                                                            borderColor: withHexAlpha(assigneeColor, '66', '#d1d5db'),
                                                                            color: textColor(assigneeColor, '#374151')
                                                                        }}
                                                                    >
                                                                        {assigneeName}
                                                                    </button>
                                                                ) : chat.id.endsWith('@g.us') ? (
                                                                    <span className="px-1.5 py-0.5 bg-[#f0f2f5] text-[#54656f] text-[9px] rounded uppercase font-bold border border-[#eceff1] tracking-tight">Group</span>
                                                                ) : (
                                                                    <button
                                                                        type="button"
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            if (!teamUsers.length && !teamUsersLoading) fetchTeamUsers();
                                                                            setAssignMenuContactId(prev => (prev === chat.id ? null : chat.id));
                                                                        }}
                                                                        className="px-1.5 py-0.5 bg-[#f8f9fa] text-[#9ca3af] text-[9px] rounded uppercase font-bold border border-[#eceff1] tracking-tight hover:bg-[#f0f2f5] transition-all"
                                                                    >
                                                                        Unassigned
                                                                    </button>
                                                                )}
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    }}
                                />
                            ) : null}
                        </div>
                    )}
                </div>
            </div>

            {selectedChatId ? (
                <div className="flex-1 min-w-0 flex bg-[#f0f2f5] relative overflow-hidden">
                    <div className="flex-1 min-w-0 flex flex-col min-h-0 relative overflow-hidden">
                    <div className="absolute inset-0 opacity-[0.06] pointer-events-none bg-[url('https://web.whatsapp.com/img/bg-chat-tile-light_6860a4760a595861d83d.png')] bg-repeat" />

                    <header className="h-[60px] shrink-0 bg-[#f0f2f5] px-3 flex items-center justify-between z-10 border-l border-[#eceff1]">
                        <div className="flex items-center gap-3 cursor-pointer" onClick={() => setShowContactInfo(true)}>
                            <div className="w-10 h-10 rounded-full bg-white flex items-center justify-center overflow-hidden border border-[#eceff1] shadow-sm">
                                {selectedChat?.id.endsWith('@g.us') ? (
                                    <Users className="text-[#54656f] w-5 h-5" />
                                ) : (
                                    <User className="text-[#54656f] w-5 h-5" />
                                )}
                            </div>
                            <div>
                                <h2 className="font-bold text-[16px] leading-tight text-[#111b21]">
                                    {selectedChat?.name}
                                </h2>
                                <p className="text-[12px] text-[#54656f]">
                                    {selectedChat?.id.endsWith('@g.us') ? (
                                        <span className="text-[#54656f] font-medium tracking-tight uppercase text-[10px]">Group Statistics</span>
                                    ) : (
                                        <>
                                            <span className="text-[#00a884] font-bold">{formatPhoneNumber(getCleanId(selectedChat?.id))}</span>
                                            <span className="ml-2 text-[#06d755] font-bold">• active</span>
                                            {lastInboundMs ? (
                                                <span className={`ml-2 text-[11px] font-bold ${windowOpen ? 'text-[#00a884]' : 'text-rose-600'}`}>
                                                    {windowOpen ? `${formatRemaining(windowRemainingMs || 0)} left` : '24h closed'}
                                                </span>
                                            ) : (
                                                <span className="ml-2 text-[11px] font-medium text-[#8a9aa1]">24h: no inbound</span>
                                            )}
                                            {ctaFreeWindowOpen && (
                                                <span className="ml-2 text-[11px] font-bold text-[#2563eb]">
                                                    CTA free template: {formatRemaining(ctaFreeWindowRemainingMs || 0)}
                                                </span>
                                            )}
                                            <span className="ml-2 inline-block">
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        if (!selectedChatId) return;
                                                        if (!teamUsers.length && !teamUsersLoading) fetchTeamUsers();
                                                        setAssignMenuContactId(prev => (prev === selectedChatId ? null : selectedChatId));
                                                    }}
                                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border hover:opacity-85 transition-all"
                                                    style={{
                                                        backgroundColor: selectedAssigneeName
                                                            ? withHexAlpha(selectedAssigneeColor, '20', '#f3f4f6')
                                                            : '#f8f9fa',
                                                        borderColor: selectedAssigneeName
                                                            ? withHexAlpha(selectedAssigneeColor, '66', '#d1d5db')
                                                            : '#eceff1',
                                                        color: selectedAssigneeName
                                                            ? textColor(selectedAssigneeColor, '#374151')
                                                            : '#9ca3af'
                                                    }}
                                                >
                                                    {selectedAssigneeInitials}
                                                    <span>{selectedAssigneeName || 'Unassigned'}</span>
                                                </button>
                                            </span>
                                            <span className="ml-2 inline-block">
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleToggleHumanTakeover();
                                                    }}
                                                    disabled={humanTakeoverSaving}
                                                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border transition-all disabled:opacity-60 ${selectedHumanTakeover
                                                            ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                                                            : 'bg-amber-50 border-amber-300 text-amber-700 hover:bg-amber-100'
                                                        }`}
                                                >
                                                    <Shield className="w-3 h-3" />
                                                    <span>{selectedHumanTakeover ? 'Human' : 'Bot'}</span>
                                                </button>
                                            </span>
                                        </>
                                    )}
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center gap-6 text-[#54656f]">
                            {!isUiFeatureHidden('calls') && (
                                <>
                                    <button
                                        type="button"
                                        onClick={() => void handleCallAction('video')}
                                        disabled={callActionLoading !== null}
                                        title="Check video call permission"
                                        className="text-[#54656f] hover:text-[#111b21] transition-colors disabled:opacity-50"
                                    >
                                        <Video className="w-5 h-5" />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => void handleCallAction('voice')}
                                        disabled={callActionLoading !== null}
                                        title="Check voice call permission"
                                        className="text-[#54656f] hover:text-[#111b21] transition-colors disabled:opacity-50"
                                    >
                                        <Phone className="w-5 h-5" />
                                    </button>
                                </>
                            )}
                            <div className="w-px h-6 bg-[#eceff1] mx-1" />
                            <Search className="w-5 h-5 cursor-pointer hover:text-[#111b21]" />
                            <User className="w-5 h-5 cursor-pointer hover:text-[#111b21]" onClick={() => setShowContactInfo(true)} />
                            <Trash2 className="w-5 h-5 cursor-pointer hover:text-rose-600" onClick={handleClearChat} />
                            <MoreVertical className="w-5 h-5 cursor-pointer hover:text-[#111b21]" />
                        </div>
                    </header>

                    <div className="flex-1 min-h-0 px-16 py-6 z-10 flex flex-col">
                        {lastProfileError && (
                            <div className="self-center sticky top-2 z-20 mb-2 flex items-center gap-3 bg-[#fff4e5] border border-[#ffd9b3] text-[#7a4b00] px-3 py-2 rounded-xl text-[11px] font-bold shadow-sm">
                                <span className="flex-1">{lastProfileError}</span>
                                <button
                                    onClick={() => setLastProfileError(null)}
                                    className="text-[#7a4b00] hover:bg-[#ffe7cc] p-1 rounded-md transition-all"
                                >
                                    <X className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        )}
                        <div className="flex-1 min-h-0 overflow-hidden custom-scrollbar" ref={messageViewportRef}>
                            {messageRows.length === 0 ? (
                                <div className="h-full flex items-center justify-center text-sm text-[#8696a0]">
                                    No messages yet.
                                </div>
                            ) : messageViewport.height > 0 ? (
                                <List
                                    listRef={messageListRef}
                                    style={{
                                        height: messageViewport.height,
                                        width: messageViewport.width || '100%',
                                        paddingTop: messageTopPadding
                                    }}
                                    rowCount={messageRows.length}
                                    rowHeight={messageRowHeight}
                                    rowProps={{}}
                                    overscanCount={8}
                                    className="custom-scrollbar"
                                    rowComponent={(props: any) => {
                                        const { index, style } = props as { index: number; style: React.CSSProperties };
                                        const row = messageRows[index];
                                        if (!row) return null;
                                        if (row.kind === 'date') {
                                            return (
                                                <div style={style} className="flex items-center justify-center">
                                                    <div className="px-3 py-1 rounded-full bg-[#e9edef] text-[11px] font-bold text-[#54656f] shadow-sm border border-[#d7dfe5]">
                                                        {row.label}
                                                    </div>
                                                </div>
                                            );
                                        }

                                        const msg = row.msg;
                                        const key = row.id;
                                        const buttonsMessage = msg.message?.buttonsMessage;
                                        const listMessage = msg.message?.listMessage;
                                        const messageText = getMessagePreviewText(msg);
                                        const messageSenderName = msg.key.fromMe
                                            ? (msg.workflowState ? 'Automation' : (msg.agent?.name || currentAgentName || 'You'))
                                            : null;
                                        const messageSenderColor = msg.workflowState ? '#2563eb' : (msg.agent?.color || '#6b7280');
                                        const buttons = Array.isArray(buttonsMessage?.buttons) ? buttonsMessage?.buttons : [];
                                        const listSections = Array.isArray(listMessage?.sections) ? listMessage?.sections : [];
                                        const isFailedOutgoing = msg.key.fromMe && msg.status === 'failed';

                                        return (
                                            <div style={style} className="w-full px-1">
                                                <div className={`w-full flex ${msg.key.fromMe ? 'justify-end' : 'justify-start'}`}>
                                                    <div className="max-w-[85%] flex flex-col">
                                                        <div className={`
                                                            px-3 py-1.5 rounded-xl text-[14px] shadow-[0_1px_0.5px_rgba(0,0,0,0.1)] relative mb-1 tracking-tight
                                                            ${msg.key.fromMe
                                                            ? (isFailedOutgoing
                                                                ? 'bg-[#fee2e2] border border-[#fecaca] text-[#7f1d1d] rounded-tr-none'
                                                                : 'bg-[#d9fdd3] text-[#111b21] rounded-tr-none')
                                                            : 'bg-white text-[#111b21] rounded-tl-none'}
                                                        `}>
                                                            {messageText && (
                                                                <p className={`leading-relaxed whitespace-pre-wrap break-words ${isFailedOutgoing ? 'pr-28' : 'pr-14'}`}>
                                                                    {messageText}
                                                                </p>
                                                            )}

                                                            {buttons.length > 0 && (
                                                                <div className="mt-2 space-y-1">
                                                                    {buttons.map((button: any, btnIdx: number) => (
                                                                        <div
                                                                            key={`${key}-btn-${btnIdx}`}
                                                                            className="px-3 py-2 rounded-lg border border-[#e2e8f0] bg-white/70 text-[13px] font-semibold text-[#111b21]"
                                                                        >
                                                                            {button?.buttonText?.displayText || button?.buttonId || `Button ${btnIdx + 1}`}
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            )}
                                                            {buttonsMessage?.footerText && (
                                                                <div className="mt-1 text-[11px] text-[#54656f] font-medium">
                                                                    {buttonsMessage.footerText}
                                                                </div>
                                                            )}

                                                            {listMessage && (
                                                                <div className="mt-2 space-y-2">
                                                                    {listMessage.title && (
                                                                        <div className="text-[12px] font-bold text-[#111b21]">
                                                                            {listMessage.title}
                                                                        </div>
                                                                    )}
                                                                    {listMessage.buttonText && (
                                                                        <div className="px-3 py-2 rounded-lg bg-[#f0f2f5] text-[12px] font-bold text-[#111b21] border border-[#eceff1]">
                                                                            {listMessage.buttonText}
                                                                        </div>
                                                                    )}
                                                                    {listSections.map((section: any, sectionIdx: number) => {
                                                                        const rows = Array.isArray(section?.rows) ? section.rows : [];
                                                                        return (
                                                                            <div key={`${key}-section-${sectionIdx}`} className="space-y-1">
                                                                                {section?.title && (
                                                                                    <div className="text-[11px] font-bold uppercase tracking-tight text-[#54656f]">
                                                                                        {section.title}
                                                                                    </div>
                                                                                )}
                                                                                {rows.map((row: any, rowIdx: number) => (
                                                                                    <div key={`${key}-row-${sectionIdx}-${rowIdx}`} className="px-3 py-2 rounded-lg bg-white/70 border border-[#eceff1]">
                                                                                        <div className="text-[13px] font-semibold text-[#111b21]">
                                                                                            {row?.title || row?.rowId || `Option ${rowIdx + 1}`}
                                                                                        </div>
                                                                                        {row?.description && (
                                                                                            <div className="text-[11px] text-[#54656f] mt-0.5">
                                                                                                {row.description}
                                                                                            </div>
                                                                                        )}
                                                                                    </div>
                                                                                ))}
                                                                            </div>
                                                                        );
                                                                    })}
                                                                    {listMessage.footerText && (
                                                                        <div className="text-[11px] text-[#54656f]">
                                                                            {listMessage.footerText}
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            )}

                                                            {msg.message?.imageMessage && (
                                                                <div className="mt-1 mb-1 max-w-sm rounded-lg overflow-hidden cursor-pointer bg-[#fcfdfd] min-h-[100px] flex items-center justify-center relative border border-[#eceff1]">
                                                                    {(() => {
                                                                        const mediaId = msg.message?.imageMessage?.mediaId;
                                                                        const directUrl = msg.message?.imageMessage?.url;
                                                                        const cacheEntry = mediaCache[msg.key.id!] || (mediaId ? mediaCache[mediaId] : undefined);
                                                                        return cacheEntry ? (
                                                                            <img
                                                                                src={`data:${cacheEntry.mimetype};base64,${cacheEntry.data}`}
                                                                                alt="WhatsApp Attachment"
                                                                                className="max-w-full h-auto block"
                                                                            />
                                                                        ) : directUrl ? (
                                                                            <img
                                                                                src={directUrl}
                                                                                alt="WhatsApp Attachment"
                                                                                className="max-w-full h-auto block"
                                                                            />
                                                                        ) : (
                                                                            <div className="p-4 text-center" onClick={() => handleDownloadMedia(msg)}>
                                                                                {renderMediaLoadingPlaceholder(msg)}
                                                                            </div>
                                                                        );
                                                                    })()}
                                                                </div>
                                                            )}

                                                            {msg.message?.documentMessage && (() => {
                                                                const doc = msg.message.documentMessage;
                                                                const mediaId = doc.mediaId;
                                                                const cacheEntry = mediaCache[msg.key.id!] || (mediaId ? mediaCache[mediaId] : undefined);
                                                                const docName = doc.fileName || '';
                                                                const docMime = doc.mimetype || '';
                                                                const docUrl = doc.url || '';
                                                                const isImageDoc = Boolean(
                                                                    docMime.startsWith('image/') ||
                                                                    /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(docName)
                                                                );

                                                                if (isImageDoc) {
                                                                    return (
                                                                        <div
                                                                            className="mt-1 mb-1 max-w-sm rounded-lg overflow-hidden cursor-pointer bg-[#fcfdfd] min-h-[100px] flex items-center justify-center relative border border-[#eceff1]"
                                                                            onClick={() => {
                                                                                if (!cacheEntry) {
                                                                                    handleDownloadMedia(msg);
                                                                                }
                                                                            }}
                                                                        >
                                                                            {cacheEntry ? (
                                                                                <img
                                                                                    src={`data:${cacheEntry.mimetype};base64,${cacheEntry.data}`}
                                                                                    alt={docName || 'Image'}
                                                                                    className="max-w-full h-auto block"
                                                                                />
                                                                            ) : docUrl ? (
                                                                                <img
                                                                                    src={docUrl}
                                                                                    alt={docName || 'Image'}
                                                                                    className="max-w-full h-auto block"
                                                                                />
                                                                            ) : (
                                                                                <div className="p-4 text-center">
                                                                                    {renderMediaLoadingPlaceholder(msg)}
                                                                                </div>
                                                                            )}
                                                                        </div>
                                                                    );
                                                                }

                                                                return (
                                                                    <div
                                                                        className="mt-1 mb-1 p-3 bg-[#f8f9fa] rounded-xl flex items-center gap-3 cursor-pointer hover:bg-white transition-all border border-[#eceff1]"
                                                                        onClick={() => {
                                                                            if (cacheEntry) {
                                                                                const link = document.createElement('a');
                                                                                link.href = `data:${cacheEntry.mimetype};base64,${cacheEntry.data}`;
                                                                                link.download = doc.fileName || 'document';
                                                                                link.click();
                                                                            } else if (docUrl) {
                                                                                window.open(docUrl, '_blank');
                                                                            } else {
                                                                                handleDownloadMedia(msg);
                                                                            }
                                                                        }}
                                                                    >
                                                                        <div className="p-2 bg-[#00a884]/10 rounded-lg text-[#00a884]">
                                                                            <Paperclip className="w-5 h-5" />
                                                                        </div>
                                                                        <div className="flex-1 min-w-0">
                                                                            <p className="text-sm font-bold truncate text-[#111b21]">{doc.fileName || 'Document'}</p>
                                                                            <p className="text-[10px] text-[#54656f] font-bold uppercase tracking-tight">
                                                                                {Math.round((Number(doc.fileLength) || 0) / 1024)} KB • {doc.mimetype?.split('/')[1]?.toUpperCase() || 'FILE'}
                                                                            </p>
                                                                            {!cacheEntry && !docUrl && (
                                                                                <div className="mt-2">
                                                                                    {renderMediaLoadingPlaceholder(msg, true)}
                                                                                </div>
                                                                            )}
                                                                        </div>
                                                                    </div>
                                                                );
                                                            })()}

                                                            {msg.message?.videoMessage && (() => {
                                                                const mediaId = msg.message?.videoMessage?.mediaId;
                                                                const directUrl = msg.message?.videoMessage?.url;
                                                                const cacheEntry = mediaCache[msg.key.id!] || (mediaId ? mediaCache[mediaId] : undefined);
                                                                return (
                                                                    <div className="mt-1 mb-1 max-w-sm rounded-lg overflow-hidden bg-[#fcfdfd] min-h-[100px] flex items-center justify-center relative border border-[#eceff1]">
                                                                        {cacheEntry ? (
                                                                            <video
                                                                                controls
                                                                                className="max-w-full h-auto block"
                                                                                src={`data:${cacheEntry.mimetype};base64,${cacheEntry.data}`}
                                                                            />
                                                                        ) : directUrl ? (
                                                                            <video
                                                                                controls
                                                                                className="max-w-full h-auto block"
                                                                                src={directUrl}
                                                                            />
                                                                        ) : (
                                                                            <div className="p-4 text-center" onClick={() => handleDownloadMedia(msg)}>
                                                                                {renderMediaLoadingPlaceholder(msg)}
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                );
                                                            })()}

                                                            {msg.message?.audioMessage && (() => {
                                                                const mediaId = msg.message?.audioMessage?.mediaId;
                                                                const cacheEntry = mediaCache[msg.key.id!] || (mediaId ? mediaCache[mediaId] : undefined);
                                                                return (
                                                                    <div className="mt-1 mb-1 p-3 bg-[#f8f9fa] rounded-xl border border-[#eceff1] w-[260px]">
                                                                        {cacheEntry ? (
                                                                            <audio
                                                                                controls
                                                                                className="w-full"
                                                                                src={`data:${cacheEntry.mimetype};base64,${cacheEntry.data}`}
                                                                            />
                                                                        ) : (
                                                                            <div className="cursor-pointer" onClick={() => handleDownloadMedia(msg)}>
                                                                                {renderMediaLoadingPlaceholder(msg, true)}
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                );
                                                            })()}

                                                            <div className="absolute bottom-1 right-2 flex items-center gap-1">
                                                                <span className="text-[10px] text-[#54656f]/70 font-bold">
                                                                    {msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : ''}
                                                                </span>
                                                                {renderMessageStatus(msg)}
                                                                {isFailedOutgoing && (
                                                                    <button
                                                                        type="button"
                                                                        onClick={(event) => {
                                                                            event.stopPropagation();
                                                                            if (!msg.key?.id) return;
                                                                            handleResendMessage(msg.key.id);
                                                                        }}
                                                                        className="text-[10px] font-bold text-[#d93025] hover:underline"
                                                                    >
                                                                        Resend
                                                                    </button>
                                                                )}
                                                            </div>
                                                        </div>
                                                        {messageSenderName && (
                                                            <div
                                                                className="mt-0.5 px-1 text-[10px] font-medium text-right"
                                                                style={{ color: textColor(messageSenderColor, '#6b7280') }}
                                                            >
                                                                {messageSenderName}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    }}
                                />
                            ) : null}
                        </div>
                    </div>

                    <footer className="shrink-0 bg-[#f0f2f5] px-3 py-2 flex items-center gap-1.5 z-10 min-h-[54px]">
                        <div className="flex items-center text-[#54656f]">
                            <button type="button" className="p-1.5 hover:bg-white rounded-lg transition-all cursor-pointer">
                                <Smile className="w-6 h-6" />
                            </button>
                            <button
                                type="button"
                                onClick={() => openComposerMediaPicker('image')}
                                className={`p-1.5 rounded-lg transition-all cursor-pointer ${composerMediaType === 'image' && showMediaComposer ? 'bg-[#00a884]/10 text-[#00a884]' : 'hover:bg-white'}`}
                                title="Attach image"
                            >
                                <ImageIcon className="w-5 h-5" />
                            </button>
                            <button
                                type="button"
                                onClick={() => openComposerMediaPicker('document')}
                                className={`p-1.5 rounded-lg transition-all cursor-pointer ${composerMediaType === 'document' && showMediaComposer ? 'bg-[#00a884]/10 text-[#00a884]' : 'hover:bg-white'}`}
                                title="Attach document"
                            >
                                <FileIcon className="w-5 h-5" />
                            </button>
                            <button
                                type="button"
                                onClick={() => openComposerMediaPicker('video')}
                                className={`p-1.5 rounded-lg transition-all cursor-pointer ${composerMediaType === 'video' && showMediaComposer ? 'bg-[#00a884]/10 text-[#00a884]' : 'hover:bg-white'}`}
                                title="Attach video"
                            >
                                <Paperclip className="w-6 h-6 -rotate-45" />
                            </button>
                        </div>
                        {workflowStarter}
                        <div
                            className="flex-1 mx-1 relative"
                            onDragOver={handleComposerDragOver}
                            onDragLeave={handleComposerDragLeave}
                            onDrop={handleComposerDrop}
                        >
                            {canSendText && composerDragActive && (
                                <div className="absolute inset-0 z-40 rounded-xl border-2 border-dashed border-[#00a884] bg-[#00a884]/10 backdrop-blur-[1px] pointer-events-none flex items-center justify-center">
                                    <span className="px-3 py-1 rounded-full bg-white/90 text-[#006f57] text-xs font-bold uppercase tracking-wide">
                                        Drop file to attach
                                    </span>
                                </div>
                            )}
                            {!canSendText && (
                                <div className="absolute -top-8 left-0 px-3 py-1.5 rounded-lg bg-[#fff3e0] text-[#a16207] text-[11px] font-bold border border-[#fde68a]">
                                    24h window closed for free text. Template message can still be sent anytime.
                                </div>
                            )}
                            {canSendText && quickReplyQuery !== null && (
                                <div className="absolute bottom-[58px] left-0 right-0 bg-white border border-[#eceff1] rounded-2xl shadow-xl z-20 max-h-56 overflow-y-auto">
                                    {quickRepliesLoading ? (
                                        <div className="px-3 py-3 animate-pulse space-y-2">
                                            <div className="h-9 rounded-xl bg-[#eef2f5]" />
                                            <div className="h-9 rounded-xl bg-[#eef2f5]" />
                                            <div className="h-9 rounded-xl bg-[#eef2f5]" />
                                        </div>
                                    ) : quickReplySuggestions.length === 0 ? (
                                        <div className="px-4 py-3 text-sm text-[#54656f]">No quick replies found.</div>
                                    ) : (
                                        quickReplySuggestions.map((item, idx) => (
                                            <button
                                                type="button"
                                                key={`${item.id || 'quick'}-${idx}`}
                                                onClick={() => handleQuickReplyPick(item)}
                                                className="w-full text-left px-4 py-3 hover:bg-[#f6f8f9] transition-all border-b border-[#f1f3f4] last:border-b-0"
                                            >
                                                <div className="flex items-center justify-between gap-2">
                                                    <div className="text-xs font-bold uppercase tracking-widest text-[#00a884]">/{normalizeQuickReplyShortcut(item.shortcut)}</div>
                                                    {normalizeQuickReplyMessageType(item.message_type) !== 'text' && (
                                                        <span className="text-[10px] font-semibold uppercase tracking-wide text-[#4b5c68] bg-[#eef2f5] px-2 py-0.5 rounded-full">
                                                            {normalizeQuickReplyMessageType(item.message_type)}
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="text-sm text-[#111b21] mt-1 max-h-10 overflow-hidden">
                                                    {(() => {
                                                        const type = normalizeQuickReplyMessageType(item.message_type);
                                                        const text = typeof item.text === 'string' ? item.text.trim() : '';
                                                        if (text) return text;
                                                        if (type === 'text') return '';
                                                        return `Media quick reply (${type})`;
                                                    })()}
                                                </div>
                                            </button>
                                        ))
                                    )}
                                </div>
                            )}
                            {canSendText && showMediaComposer && (
                                <div className="absolute bottom-[58px] left-0 right-0 bg-white border border-[#eceff1] rounded-2xl shadow-xl z-20 p-3 space-y-2">
                                    <div className="flex items-center justify-between">
                                        <div className="text-[11px] font-bold uppercase tracking-widest text-[#54656f]">Attach Media</div>
                                        <button
                                            type="button"
                                            onClick={() => resetComposerMedia('none')}
                                            className="text-[#8696a0] hover:text-rose-500"
                                        >
                                            <X className="w-4 h-4" />
                                        </button>
                                    </div>
                                    <input
                                        ref={composerFileInputRef}
                                        type="file"
                                        accept={composerMediaType === 'image' ? 'image/*' : composerMediaType === 'video' ? 'video/*' : '*/*'}
                                        className="hidden"
                                        onChange={handleComposerMediaInputChange}
                                    />
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                        <select
                                            value={composerMediaType}
                                            onChange={(e) => resetComposerMedia(e.target.value as 'image' | 'video' | 'document')}
                                            className="bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-xs font-bold text-[#111b21] focus:outline-none focus:ring-1 focus:ring-[#00a884]/20"
                                        >
                                            <option value="image">Image</option>
                                            <option value="video">Video</option>
                                            <option value="document">Document</option>
                                        </select>
                                        <button
                                            type="button"
                                            onClick={() => composerFileInputRef.current?.click()}
                                            disabled={composerMediaUploading}
                                            className="h-9 rounded-xl bg-[#00a884] text-white text-xs font-bold hover:bg-[#008f6f] transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                                        >
                                            {composerMediaUploading ? 'Uploading…' : 'Upload File'}
                                        </button>
                                    </div>
                                    {composerMediaType === 'document' && (
                                        <input
                                            type="text"
                                            placeholder="Document filename (optional)"
                                            value={composerMediaFilename}
                                            onChange={(e) => setComposerMediaFilename(e.target.value)}
                                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-xs font-medium text-[#111b21] focus:outline-none focus:ring-1 focus:ring-[#00a884]/20"
                                        />
                                    )}
                                    {composerMediaError && (
                                        <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700">
                                            {composerMediaError}
                                        </div>
                                    )}
                                    {!composerMediaError && hasComposerMedia && (
                                        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-700">
                                            Media ready to send.
                                            {composerMediaSizeBytes ? ` (${Math.ceil(composerMediaSizeBytes / 1024)} KB)` : ''}
                                        </div>
                                    )}
                                    <p className="text-[11px] text-[#6b7280]">
                                        Text + media will be sent in one message.
                                    </p>
                                </div>
                            )}
                                <textarea
                                    ref={messageInputRef}
                                    placeholder={canSendText ? 'Type a message (Enter = newline, Ctrl/Cmd+Enter = send)' : 'Type a message (24h closed - use template)'}
                                    value={messageText}
                                    disabled={!canSendText}
                                    onChange={(e) => setMessageTextWithDraft(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                                            e.preventDefault();
                                            if (!canSendText) {
                                                setShowTemplateComposer(true);
                                                return;
                                            }
                                            if (quickReplyQuery !== null && quickReplySuggestions.length > 0) {
                                                handleQuickReplyPick(quickReplySuggestions[0]);
                                                return;
                                            }
                                            handleSendMessage();
                                        }
                                        if (canSendText && e.key === 'Tab' && quickReplyQuery !== null && quickReplySuggestions.length > 0) {
                                            e.preventDefault();
                                            handleQuickReplyPick(quickReplySuggestions[0]);
                                        }
                                    }}
                                    rows={1}
                                    className={`w-full border border-[#eceff1] rounded-lg px-3 py-2.5 text-[14px] leading-5 resize-y min-h-[44px] max-h-[132px] focus:outline-none focus:ring-1 focus:ring-[#00a884]/20 placeholder:text-[#54656f]/50 ${canSendText ? 'bg-white text-[#111b21]' : 'bg-[#f8f9fa] text-[#9ca3af] cursor-not-allowed'}`}
                                />
                            {composerMediaUploading ? (
                                <div className="mt-1 text-[11px] font-bold text-[#54656f]">
                                    Uploading attachment…
                                </div>
                            ) : hasComposerMedia && (
                                <div className="mt-1 text-[11px] font-bold text-[#00a884]">
                                    Attachment ready: {composerMediaType}
                                </div>
                            )}
                        </div>
                        <div className="text-[#54656f] flex items-center gap-1.5">
                            <div className="relative">
                                <button
                                    type="button"
                                    onClick={() => setShowTemplateComposer(prev => !prev)}
                                    className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition-all ${showTemplateComposer ? 'bg-[#00a884]/10 text-[#00a884]' : 'bg-white border border-[#eceff1] text-[#334155] hover:bg-[#f8fafc]'}`}
                                    title="Send template message"
                                >
                                    <FileText className="w-4 h-4" />
                                    <span>Template</span>
                                </button>
                                {showTemplateComposer && (
                                    <div className="absolute bottom-[52px] right-0 w-[460px] max-w-[90vw] bg-white border border-[#eceff1] rounded-2xl shadow-xl z-30 p-3 space-y-2">
                                        <div className="text-[11px] font-bold uppercase tracking-widest text-[#54656f]">Send Template Message</div>
                                        <div className="text-[11px] text-[#64748b]">
                                            Approved template messages are available even when the 24h window is open.
                                        </div>
                                        {templateComposerError && (
                                            <div className="px-2 py-1.5 rounded-lg bg-rose-50 border border-rose-200 text-[11px] text-rose-700 font-semibold">
                                                {templateComposerError}
                                            </div>
                                        )}
                                        <div className="flex items-center gap-2">
                                            <select
                                                value={selectedTemplateOptionId}
                                                onChange={(e) => setSelectedTemplateOptionId(e.target.value)}
                                                className="flex-1 bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-xs font-bold focus:outline-none focus:ring-1 focus:ring-[#00a884]/20 text-[#111b21]"
                                            >
                                                <option value="">Pick approved template</option>
                                                {templateComposerOptions.map((option) => (
                                                    <option key={option.id} value={option.id}>
                                                        {option.name} ({option.language})
                                                    </option>
                                                ))}
                                            </select>
                                            <button
                                                type="button"
                                                onClick={() => fetchTemplateComposerOptions()}
                                                disabled={templateComposerLoading}
                                                className="px-3 py-2 rounded-xl border border-[#e5e7eb] text-[11px] font-bold text-[#334155] hover:bg-[#f8fafc] disabled:opacity-50"
                                            >
                                                {templateComposerLoading ? '...' : 'Reload'}
                                            </button>
                                        </div>
                                        <input
                                            type="text"
                                            placeholder="Template name"
                                            value={templateName}
                                            onChange={(e) => setTemplateName(e.target.value)}
                                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-xs font-bold focus:outline-none focus:ring-1 focus:ring-[#00a884]/20 text-[#111b21]"
                                        />
                                        <input
                                            type="text"
                                            placeholder="Language (e.g. en_US)"
                                            value={templateLanguage}
                                            onChange={(e) => setTemplateLanguage(e.target.value)}
                                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-[#00a884]/20 text-[#111b21]"
                                        />
                                        {selectedTemplateOption && (
                                            <div className="rounded-xl border border-[#eceff1] bg-[#f8fafc] p-2 space-y-2">
                                                <div className="text-[10px] font-black uppercase tracking-widest text-[#64748b]">
                                                    Attributes from approved template
                                                </div>
                                                {requiredTemplateHeaderAttributeCount > 0 && (
                                                    <div className="space-y-1">
                                                        <div className="text-[10px] font-bold text-[#0f172a]">
                                                            Header text attributes ({requiredTemplateHeaderAttributeCount})
                                                        </div>
                                                        {Array.from({ length: requiredTemplateHeaderAttributeCount }).map((_, index) => (
                                                            <input
                                                                key={`header-attr-${index}`}
                                                                type="text"
                                                                value={templateHeaderAttributes[index] || ''}
                                                                onChange={(e) => setTemplateHeaderAttributes((prev) => {
                                                                    const next = Array.from(
                                                                        { length: requiredTemplateHeaderAttributeCount },
                                                                        (_, idx) => prev[idx] || ''
                                                                    );
                                                                    next[index] = e.target.value;
                                                                    return next;
                                                                })}
                                                                placeholder={`Header {{${index + 1}}}`}
                                                                className="w-full bg-white border border-[#e2e8f0] rounded-lg px-2.5 py-1.5 text-[11px] text-[#111b21] focus:outline-none focus:ring-1 focus:ring-[#00a884]/20"
                                                            />
                                                        ))}
                                                    </div>
                                                )}
                                                {(selectedTemplateHeaderFormat === 'IMAGE' || selectedTemplateHeaderFormat === 'VIDEO' || selectedTemplateHeaderFormat === 'DOCUMENT') && (
                                                    <div className="space-y-1">
                                                        <div className="text-[10px] font-bold text-[#0f172a]">
                                                            Header {selectedTemplateHeaderFormat.toLowerCase()} link
                                                        </div>
                                                        <input
                                                            type="text"
                                                            value={templateHeaderMediaUrl}
                                                            onChange={(e) => setTemplateHeaderMediaUrl(e.target.value)}
                                                            placeholder={`https://.../${selectedTemplateHeaderFormat.toLowerCase()}`}
                                                            className="w-full bg-white border border-[#e2e8f0] rounded-lg px-2.5 py-1.5 text-[11px] text-[#111b21] focus:outline-none focus:ring-1 focus:ring-[#00a884]/20"
                                                        />
                                                        {selectedTemplateHeaderFormat === 'DOCUMENT' && (
                                                            <input
                                                                type="text"
                                                                value={templateHeaderDocumentFilename}
                                                                onChange={(e) => setTemplateHeaderDocumentFilename(e.target.value)}
                                                                placeholder="Filename (e.g. document.pdf)"
                                                                className="w-full bg-white border border-[#e2e8f0] rounded-lg px-2.5 py-1.5 text-[11px] text-[#111b21] focus:outline-none focus:ring-1 focus:ring-[#00a884]/20"
                                                            />
                                                        )}
                                                    </div>
                                                )}
                                                {requiredTemplateBodyAttributeCount > 0 && (
                                                    <div className="space-y-1">
                                                        <div className="text-[10px] font-bold text-[#0f172a]">
                                                            Body attributes ({requiredTemplateBodyAttributeCount})
                                                        </div>
                                                        <div className="text-[10px] text-[#64748b]">
                                                            Name each attribute so it is saved on the customer profile.
                                                        </div>
                                                        {Array.from({ length: requiredTemplateBodyAttributeCount }).map((_, index) => (
                                                            <div key={`body-attr-${index}`} className="grid grid-cols-2 gap-1.5">
                                                                <input
                                                                    type="text"
                                                                    value={templateBodyAttributeNames[index] || ''}
                                                                    onChange={(e) => setTemplateBodyAttributeNames((prev) => {
                                                                        const next = Array.from(
                                                                            { length: requiredTemplateBodyAttributeCount },
                                                                            (_, idx) => prev[idx] || inferTemplateVariableLabel(selectedTemplateBody?.text, idx + 1, 'body')
                                                                        );
                                                                        next[index] = e.target.value;
                                                                        return next;
                                                                    })}
                                                                    placeholder={`Name for {{${index + 1}}}`}
                                                                    className="w-full bg-white border border-[#e2e8f0] rounded-lg px-2.5 py-1.5 text-[11px] text-[#111b21] focus:outline-none focus:ring-1 focus:ring-[#00a884]/20"
                                                                />
                                                                <input
                                                                    type="text"
                                                                    value={templateBodyAttributes[index] || ''}
                                                                    onChange={(e) => setTemplateBodyAttributes((prev) => {
                                                                        const next = Array.from(
                                                                            { length: requiredTemplateBodyAttributeCount },
                                                                            (_, idx) => prev[idx] || ''
                                                                        );
                                                                        next[index] = e.target.value;
                                                                        return next;
                                                                    })}
                                                                    placeholder={`Value for {{${index + 1}}}`}
                                                                    className="w-full bg-white border border-[#e2e8f0] rounded-lg px-2.5 py-1.5 text-[11px] text-[#111b21] focus:outline-none focus:ring-1 focus:ring-[#00a884]/20"
                                                                />
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                                {requiredTemplateBodyAttributeCount === 0
                                                    && requiredTemplateHeaderAttributeCount === 0
                                                    && selectedTemplateHeaderFormat !== 'IMAGE'
                                                    && selectedTemplateHeaderFormat !== 'VIDEO'
                                                    && selectedTemplateHeaderFormat !== 'DOCUMENT' && (
                                                        <div className="text-[11px] text-[#64748b]">
                                                            No attributes required for this template.
                                                        </div>
                                                    )}
                                            </div>
                                        )}
                                        <input
                                            type="text"
                                            placeholder='Advanced override: components JSON (optional)'
                                            value={templateComponents}
                                            onChange={(e) => setTemplateComponents(e.target.value)}
                                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-3 py-2 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-[#00a884]/20 text-[#111b21]"
                                        />
                                        <div className="flex justify-end gap-2">
                                            <button
                                                type="button"
                                                onClick={() => setShowTemplateComposer(false)}
                                                className="px-3 py-2 rounded-xl text-xs font-bold text-[#54656f] hover:bg-[#f0f2f5]"
                                            >
                                                Close
                                            </button>
                                            <button
                                                type="button"
                                                onClick={handleSendTemplate}
                                                className="px-3 py-2 rounded-xl bg-[#00a884] text-white text-xs font-bold hover:bg-[#008f6f]"
                                            >
                                                Send Template
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                            {canSendText ? (
                                (messageText.trim() || hasComposerMedia) ? (
                                    <div onClick={handleSendMessage} className="p-2.5 bg-[#00a884] shadow-sm rounded-lg cursor-pointer text-white transition-transform active:scale-95"><Send className="w-5 h-5" /></div>
                                ) : (
                                    <div className="p-1.5 hover:bg-white rounded-lg transition-all cursor-pointer"><Mic className="w-6 h-6" /></div>
                                )
                            ) : null}
                        </div>
                    </footer>

                    </div>

                    {/* Contact Info Sidebar */}
                    {showContactInfo && (
                        <aside className="w-[360px] max-w-[42vw] min-w-[320px] h-full bg-white border-l border-[#eceff1] shadow-[-12px_0_28px_rgba(0,0,0,0.08)] flex flex-col overflow-hidden z-20">
                                <header className="h-[54px] bg-[#f0f2f5] px-4 flex items-center gap-4 text-[#111b21] border-b border-[#eceff1]">
                                    <X className="w-5 h-5 cursor-pointer hover:text-[#54656f]" onClick={() => setShowContactInfo(false)} />
                                    <h2 className="text-[14px] font-bold">Contact Info</h2>
                                </header>

                                <div className="flex-1 overflow-y-auto custom-scrollbar flex flex-col items-center py-6 px-5 space-y-6">
                                    <div className="w-32 h-32 rounded-full bg-[#f0f2f5] flex items-center justify-center border border-[#eceff1] flex-shrink-0 shadow-sm">
                                        {selectedChat?.id.endsWith('@g.us') ? (
                                            <Users className="text-[#aebac1] w-16 h-16" />
                                        ) : (
                                            <User className="text-[#aebac1] w-16 h-16" />
                                        )}
                                    </div>

                                <div className="w-full text-center space-y-2">
                                    <div className="flex flex-col items-center gap-2">
                                        <input
                                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-4 py-2.5 text-[14px] font-bold text-center focus:outline-none focus:border-[#00a884]"
                                            value={contactDraftName}
                                            onChange={(e) => {
                                                setContactDraftName(e.target.value);
                                                setContactDirty(true);
                                            }}
                                            placeholder="Contact name"
                                            disabled={selectedChat?.id.endsWith('@g.us')}
                                        />
                                        <button
                                            onClick={handleSaveContact}
                                            disabled={selectedChat?.id.endsWith('@g.us')}
                                            className={`px-3 py-1.5 rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all ${contactDirty ? 'bg-[#00a884] text-white' : 'bg-[#f0f2f5] text-[#8696a0]'} `}
                                        >
                                            Save Contact
                                        </button>
                                    </div>
                                    <p className="text-[#54656f] text-[13px] mt-1 font-medium">
                                        {selectedChat?.id.endsWith('@g.us') ? 'Shared Group' : formatPhoneNumber(getCleanId(selectedChat?.id))}
                                    </p>
                                </div>

                                <div className="w-full space-y-3 bg-[#f8f9fa] p-4 rounded-2xl border border-[#eceff1]">
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[10px] text-[#00a884] font-bold uppercase tracking-wider">Phone number</span>
                                        <span className="text-[14px] font-bold text-[#111b21]">
                                            {selectedChat?.id.endsWith('@g.us') ? 'Enterprise Group' : formatPhoneNumber(getCleanId(selectedChat?.id))}
                                        </span>
                                    </div>
                                    <div className="flex flex-col gap-1 pt-3 border-t border-[#eceff1]">
                                        <span className="text-[10px] text-[#00a884] font-bold uppercase tracking-wider">Assignee</span>
                                        {selectedChat?.id.endsWith('@g.us') ? (
                                            <span className="text-[13px] text-[#54656f] font-medium leading-relaxed">Group chat</span>
                                        ) : (
                                            <div className="w-fit">
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        if (!selectedChatId) return;
                                                        if (!teamUsers.length && !teamUsersLoading) fetchTeamUsers();
                                                        setAssignMenuContactId(prev => (prev === selectedChatId ? null : selectedChatId));
                                                    }}
                                                    className="inline-flex w-fit items-center gap-1 px-2 py-1 rounded-full border text-[12px] font-bold hover:opacity-85 transition-all"
                                                    style={{
                                                        backgroundColor: selectedAssigneeName
                                                            ? withHexAlpha(selectedAssigneeColor, '20', '#f3f4f6')
                                                            : '#f8f9fa',
                                                        borderColor: selectedAssigneeName
                                                            ? withHexAlpha(selectedAssigneeColor, '66', '#d1d5db')
                                                            : '#eceff1',
                                                        color: selectedAssigneeName
                                                            ? textColor(selectedAssigneeColor, '#374151')
                                                            : '#9ca3af'
                                                    }}
                                                >
                                                    {selectedAssigneeInitials}
                                                    <span>{selectedAssigneeName || 'Unassigned'}</span>
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                    <div className="flex flex-col gap-1 pt-3 border-t border-[#eceff1]">
                                        <span className="text-[10px] text-[#00a884] font-bold uppercase tracking-wider">24h Window</span>
                                        {lastInboundMs ? (
                                            <span className="text-[13px] text-[#54656f] font-medium leading-relaxed">
                                                {windowOpen ? `Open (${formatRemaining(windowRemainingMs || 0)} left)` : 'Closed (template required)'}
                                            </span>
                                        ) : (
                                            <span className="text-[13px] text-[#54656f] font-medium leading-relaxed">No inbound message yet</span>
                                        )}
                                    </div>
                                    <div className="flex flex-col gap-1 pt-3 border-t border-[#eceff1]">
                                        <span className="text-[10px] text-[#2563eb] font-bold uppercase tracking-wider">CTA Free Entry</span>
                                        {ctaFreeWindowOpen ? (
                                            <span className="text-[13px] text-[#54656f] font-medium leading-relaxed">
                                                Active ({formatRemaining(ctaFreeWindowRemainingMs || 0)} left for free template sends)
                                            </span>
                                        ) : (
                                            <span className="text-[13px] text-[#54656f] font-medium leading-relaxed">Not active</span>
                                        )}
                                    </div>
                                    <div className="flex flex-col gap-1 pt-3 border-t border-[#eceff1]">
                                        <span className="text-[10px] text-[#00a884] font-bold uppercase tracking-wider">WABA Info</span>
                                        <span className="text-[13px] text-[#54656f] font-medium leading-relaxed">This conversation is handled through Meta's WhatsApp Business Cloud API.</span>
                                    </div>
                                    <div className="flex flex-col gap-2.5 pt-3 border-t border-[#eceff1]">
                                        <span className="text-[10px] text-[#2563eb] font-bold uppercase tracking-wider">Saved Answers</span>
                                        {Object.keys(selectedWorkflowMemory.vars).length === 0 ? (
                                            <span className="text-[11px] text-[#8696a0]">No saved workflow variables yet</span>
                                        ) : (
                                            <div className="flex flex-col gap-1.5">
                                                {Object.entries(selectedWorkflowMemory.vars).map(([key, value]) => (
                                                    <div key={`var-${key}`} className="bg-white border border-[#eceff1] rounded-xl px-3 py-2">
                                                        <div className="text-[10px] font-black uppercase tracking-wider text-[#2563eb]">{key}</div>
                                                        <div className="text-[12px] font-semibold text-[#111b21] break-words">{value}</div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                        {selectedWorkflowMemory.qaHistory.length > 0 && (
                                            <div className="flex flex-col gap-1.5">
                                                {selectedWorkflowMemory.qaHistory.map((entry, idx) => (
                                                    <div key={`qa-${entry.key}-${idx}`} className="bg-white border border-[#eceff1] rounded-xl px-3 py-2">
                                                        <div className="text-[10px] font-black uppercase tracking-wider text-[#54656f]">{entry.key}</div>
                                                        {entry.question ? (
                                                            <div className="text-[10px] text-[#64748b] mt-1 break-words">Q: {entry.question}</div>
                                                        ) : null}
                                                        <div className="text-[11px] font-semibold text-[#111b21] break-words mt-1">A: {entry.answer}</div>
                                                        {entry.at ? (
                                                            <div className="text-[10px] text-[#94a3b8] mt-1">{new Date(entry.at).toLocaleString()}</div>
                                                        ) : null}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                    <div className="flex flex-col gap-2.5 pt-3 border-t border-[#eceff1]">
                                        <span className="text-[10px] text-[#7c3aed] font-bold uppercase tracking-wider">Saved Template Attributes</span>
                                        {selectedContactTemplateAttributes.length === 0 ? (
                                            <span className="text-[11px] text-[#8696a0]">No template attributes saved yet</span>
                                        ) : (
                                            <div className="flex flex-col gap-1.5">
                                                {selectedContactTemplateAttributes.map((entry, idx) => (
                                                    <div key={`template-attr-${entry.templateName}-${entry.scope}-${entry.index}-${idx}`} className="bg-white border border-[#eceff1] rounded-xl px-3 py-2">
                                                        <div className="text-[10px] font-black uppercase tracking-wider text-[#7c3aed]">
                                                            {entry.key}
                                                        </div>
                                                        <div className="text-[12px] font-semibold text-[#111b21] break-words">{entry.value}</div>
                                                        <div className="text-[10px] text-[#64748b] mt-1">
                                                            {entry.templateName} • {entry.scope} {`{{${entry.index}}}`} • {entry.language}
                                                        </div>
                                                        {entry.savedAt ? (
                                                            <div className="text-[10px] text-[#94a3b8] mt-1">{new Date(entry.savedAt).toLocaleString()}</div>
                                                        ) : null}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                    <div className="flex flex-col gap-2.5 pt-3 border-t border-[#eceff1]">
                                        <span className="text-[10px] text-[#00a884] font-bold uppercase tracking-wider">Tags</span>
                                        <div className="flex flex-wrap gap-2">
                                            {contactTagsDraft.length === 0 && (
                                                <span className="text-[11px] text-[#8696a0]">No tags yet</span>
                                            )}
                                            {contactTagsDraft.map(tag => (
                                                <span key={tag} className="flex items-center gap-1 px-2 py-1 rounded-full bg-white border border-[#eceff1] text-[10px] font-bold text-[#111b21]">
                                                    {tag}
                                                    <button
                                                        onClick={() => handleRemoveTag(tag)}
                                                        className="text-[#a0a8af] hover:text-rose-500"
                                                    >
                                                        <X className="w-3 h-3" />
                                                    </button>
                                                </span>
                                            ))}
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <input
                                                className="flex-1 bg-white border border-[#eceff1] rounded-xl px-3 py-2 text-[11px] font-bold focus:outline-none focus:border-[#00a884]"
                                                value={contactTagInput}
                                                onChange={(e) => setContactTagInput(e.target.value)}
                                                placeholder="Add tag"
                                                onKeyDown={(e) => e.key === 'Enter' && handleAddTag()}
                                            />
                                            <button
                                                onClick={handleAddTag}
                                                className="px-3 py-2 rounded-xl bg-[#00a884] text-white text-[10px] font-bold uppercase tracking-widest"
                                            >
                                                Add
                                            </button>
                                            <button
                                                onClick={handleSaveContact}
                                                className="px-3 py-2 rounded-xl bg-[#111b21] text-white text-[10px] font-bold uppercase tracking-widest"
                                            >
                                                Save
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                <div className="w-full pt-2">
                                    <button
                                        onClick={() => {
                                            handleClearChat();
                                            setShowContactInfo(false);
                                        }}
                                        className="w-full py-3 bg-white hover:bg-rose-50 text-rose-500 font-bold rounded-2xl transition-all border border-rose-100 flex items-center justify-center gap-2 text-[12px]"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                        Clear History
                                    </button>
                                </div>
                            </div>
                        </aside>
                    )}
                </div>
            ) : (
                <div className="flex-1 flex flex-col items-center justify-center bg-[#fcfdfd] relative">
                    <div className="absolute inset-x-0 bottom-0 h-1.5 bg-[#00a884] z-20" />
                    <div className="text-center relative z-10 px-6">
                        {loadingChats && (
                            <div className="w-[280px] mx-auto mb-10 animate-pulse space-y-3">
                                <div className="h-3 rounded bg-[#e8edf1]" />
                                <div className="h-3 rounded bg-[#eef2f5] w-5/6 mx-auto" />
                                <div className="h-3 rounded bg-[#eef2f5] w-3/4 mx-auto" />
                            </div>
                        )}
                        <div className="mb-12 flex justify-center scale-110">
                            <img src={qmessageLogo} alt="QMessage logo" className="w-[230px] opacity-90 rounded-3xl" />
                        </div>
                        <h1 className="text-[32px] font-bold text-[#111b21] mb-2 tracking-tight">QMessage Console</h1>
                        <p className="text-[#54656f] text-[15px] leading-relaxed mb-12 max-w-sm mx-auto font-medium">
                            Manage WhatsApp Business API conversations in one clean dashboard.
                        </p>
                        <div className="flex items-center justify-center gap-2 text-[#54656f] text-[12px] font-bold uppercase tracking-widest bg-[#f0f2f5] py-2 px-6 rounded-full w-fit mx-auto shadow-sm">
                            <ShieldCheck className="w-4 h-4 text-[#00a884]" />
                            Enterprise Grade Security
                        </div>
                    </div>

                </div>
            )}



            {/* Add Profile Modal */}
            <AddProfileModal
                open={!SINGLE_PROFILE_MODE && showAddProfileModal}
                profileName={newProfileName}
                isCreatingProfile={isCreatingProfile}
                onProfileNameChange={setNewProfileName}
                onClose={() => setShowAddProfileModal(false)}
                onSubmit={submitAddProfile}
            />

            {/* Edit Profile Modal */}
            <EditProfileModal
                open={!SINGLE_PROFILE_MODE && showEditProfileModal}
                profileName={editingProfileName}
                onProfileNameChange={setEditingProfileName}
                onClose={() => setShowEditProfileModal(false)}
                onSubmit={submitUpdateProfileName}
            />

            {/* New Chat Modal */}
            <NewChatModal
                open={showNewChatModal}
                phoneNumber={newPhoneNumber}
                onPhoneNumberChange={setNewPhoneNumber}
                onClose={() => setShowNewChatModal(false)}
                onSubmit={handleNewChat}
            />

            {/* First Login Onboarding */}
            <OnboardingTutorialModal
                open={ENABLE_FIRST_TIME_SETUP && showOnboardingTutorial}
                currentStep={currentOnboardingStep}
                steps={onboardingSteps}
                stepIndex={onboardingStep}
                onboardingSetup={onboardingSetup}
                isCurrentStepValid={isCurrentOnboardingStepValid}
                isFinalStep={isFinalOnboardingStep}
                onboardingConnectLoading={onboardingConnectLoading}
                activeProfileId={activeProfileId}
                onboardingConnectError={onboardingConnectError}
                onboardingConnectSuccess={onboardingConnectSuccess}
                onboardingValidationError={onboardingValidationError}
                onUpdateField={(field, value) => updateOnboardingField(field as OnboardingFieldKey, value)}
                onConnect={handleOnboardingConnect}
                onBack={handleOnboardingBack}
                onNext={handleOnboardingNext}
            />

            {/* Chat Flow Setup View */}
            {
                activeView === 'chatflow' && (
                    <ChatflowView
                        open={activeView === 'chatflow'}
                        selectedWorkflowId={selectedWorkflowId}
                        workflows={workflows}
                        workflowDrafts={workflowDrafts}
                        workflowEditorMode={workflowEditorMode}
                        setWorkflowEditorMode={setWorkflowEditorMode}
                        setWorkflows={setWorkflows}
                        setWorkflowDrafts={setWorkflowDrafts}
                        setSelectedWorkflowId={setSelectedWorkflowId}
                        onSaveWorkflows={handleSaveWorkflows}
                        onBackToAutomations={() => {
                            setActiveView('dashboard');
                            setWorkspaceSection('automations');
                        }}
                        buildBuilderFromActions={buildBuilderFromActions}
                        buildActionsFromBuilder={buildActionsFromBuilder}
                        FlowCanvasComponent={LazyFlowCanvas}
                        workflowTagOptions={workflowTagOptions}
                        workflowVariableOptions={workflowVariableOptions}
                        teamUsers={teamUsers}
                        workflowTriggerOptions={workflowTriggerOptions}
                        workflowTemplateOptions={workflowTemplateOptions}
                    />
                )
            }

            {/* Settings View */}
            {
                activeView === 'settings' && (
                    <SettingsView
                        settingsNav={settingsNav}
                        onScrollToSettingsSection={scrollToSettingsSection}
                        onSignOut={handleSignOut}
                        onClose={() => setActiveView('dashboard')}
                        profileId={activeProfileId || ''}
                        sessionToken={session?.access_token || null}
                        isAdmin={isAdmin}
                        quickReplies={quickReplies}
                        quickRepliesLoading={quickRepliesLoading}
                        quickRepliesSaving={quickRepliesSaving}
                        quickRepliesError={quickRepliesError}
                        onRefreshQuickReplies={fetchQuickReplies}
                        onSaveQuickReplies={saveQuickReplies}
                        onRefreshUiControls={fetchUiControls}
                        showCallSettings={!isUiFeatureHidden('calls')}
                        WebhookViewComponent={LazyWebhookView}
                    />
                )
            }

            {showAnalytics && (
                <div className="fixed inset-0 bg-[#f8f9fa] z-[160] flex flex-col">
                    <header className="h-[70px] bg-[#f0f2f5] px-6 flex items-center justify-between border-b border-[#eceff1]">
                        <div className="flex items-center gap-4">
                            <CircleDashed className="text-[#00a884] w-7 h-7" />
                            <h1 className="text-xl font-bold text-[#111b21]">Analytics</h1>
                        </div>
                        <button onClick={() => setShowAnalytics(false)} className="p-2 hover:bg-white rounded-xl transition-all">
                            <X className="w-6 h-6 text-[#54656f]" />
                        </button>
                    </header>
                    <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">
                        <div className="bg-white p-6 rounded-[24px] border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)] mb-8">
                            <div className="flex flex-col lg:flex-row lg:items-end gap-4">
                                <div>
                                    <label className="text-[10px] font-black uppercase tracking-widest text-[#54656f]">Start Date</label>
                                    <input
                                        type="date"
                                        value={analyticsStart}
                                        onChange={(e) => setAnalyticsStart(e.target.value)}
                                        className="mt-2 w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-4 py-2 text-sm font-bold text-[#111b21]"
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] font-black uppercase tracking-widest text-[#54656f]">End Date</label>
                                    <input
                                        type="date"
                                        value={analyticsEnd}
                                        onChange={(e) => setAnalyticsEnd(e.target.value)}
                                        className="mt-2 w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-4 py-2 text-sm font-bold text-[#111b21]"
                                    />
                                </div>
                                <div className="flex-1">
                                    <label className="text-[10px] font-black uppercase tracking-widest text-[#54656f]">Tag</label>
                                    <select
                                        value={analyticsTag}
                                        onChange={(e) => setAnalyticsTag(e.target.value)}
                                        className="mt-2 w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-4 py-2 text-sm font-bold text-[#111b21]"
                                    >
                                        <option value="">All tags</option>
                                        {(analyticsData?.tags || []).map((tag: string) => (
                                            <option key={tag} value={tag}>{tag}</option>
                                        ))}
                                    </select>
                                </div>
                                <button
                                    onClick={fetchAnalytics}
                                    disabled={analyticsLoading}
                                    className="h-[42px] px-5 rounded-xl bg-[#111b21] text-white text-xs font-bold uppercase tracking-widest hover:bg-[#202c33] transition-all disabled:opacity-50"
                                >
                                    {analyticsLoading ? 'Loading…' : 'Apply'}
                                </button>
                            </div>
                            {analyticsError && (
                                <div className="mt-4 text-sm text-rose-600 font-medium">{analyticsError}</div>
                            )}
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-6 mb-8">
                            <div className="bg-white p-6 rounded-[24px] border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
                                <div className="text-[#54656f] text-[10px] uppercase font-black tracking-widest mb-2">Total Messages</div>
                                <div className="text-3xl font-black text-[#111b21]">{analyticsInsights.totals.messages_total}</div>
                            </div>
                            <div className="bg-white p-6 rounded-[24px] border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
                                <div className="text-[#54656f] text-[10px] uppercase font-black tracking-widest mb-2">Inbound Messages</div>
                                <div className="text-3xl font-black text-[#4f9cf9]">{analyticsInsights.inboundCount}</div>
                            </div>
                            <div className="bg-white p-6 rounded-[24px] border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
                                <div className="text-[#54656f] text-[10px] uppercase font-black tracking-widest mb-2">Messages Sent</div>
                                <div className="text-3xl font-black text-[#00a884]">{analyticsInsights.totals.messages_sent}</div>
                            </div>
                            <div className="bg-white p-6 rounded-[24px] border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
                                <div className="text-[#54656f] text-[10px] uppercase font-black tracking-widest mb-2">Workflow Runs</div>
                                <div className="text-3xl font-black text-[#111b21]">{analyticsInsights.totals.workflow_runs}</div>
                            </div>
                            <div className="bg-white p-6 rounded-[24px] border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
                                <div className="text-[#54656f] text-[10px] uppercase font-black tracking-widest mb-2">Response Rate</div>
                                <div className="text-3xl font-black text-[#111b21]">{analyticsInsights.responseRate.toFixed(1)}%</div>
                                <div className="text-[11px] text-[#8696a0] mt-1">Sent vs inbound</div>
                            </div>
                            <div className="bg-white p-6 rounded-[24px] border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
                                <div className="text-[#54656f] text-[10px] uppercase font-black tracking-widest mb-2">Expired Rate</div>
                                <div className="text-3xl font-black text-rose-600">{analyticsInsights.expiredRate.toFixed(1)}%</div>
                                <div className="text-[11px] text-[#8696a0] mt-1">Expired over sent</div>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 mb-8">
                            <div className="xl:col-span-2 bg-white p-6 rounded-[24px] border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
                                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
                                    <div>
                                        <div className="text-[#54656f] text-[10px] uppercase font-black tracking-widest">Chart</div>
                                        <h3 className="text-lg font-bold text-[#111b21] mt-1">Daily Message Volume</h3>
                                    </div>
                                    <div className="flex items-center gap-4 text-[11px] text-[#54656f] font-bold">
                                        <span className="flex items-center gap-2">
                                            <span className="w-2.5 h-2.5 rounded-full bg-[#4f9cf9]" />
                                            Inbound
                                        </span>
                                        <span className="flex items-center gap-2">
                                            <span className="w-2.5 h-2.5 rounded-full bg-[#00a884]" />
                                            Sent
                                        </span>
                                    </div>
                                </div>

                                {analyticsRows.length === 0 ? (
                                    <div className="h-64 rounded-2xl border border-dashed border-[#d4dbe0] flex items-center justify-center text-sm text-[#8696a0]">
                                        No analytics data for this range.
                                    </div>
                                ) : (
                                    <>
                                        <div className="h-64 rounded-2xl border border-[#edf1f4] bg-[#fcfdfd] p-4 overflow-x-auto">
                                            <div className="min-w-[720px] h-full flex items-end gap-2">
                                                {analyticsRows.map((row: AnalyticsPerDayRow) => {
                                                    const total = Math.max(0, row.total);
                                                    const inbound = Math.min(total, Math.max(0, row.inbound));
                                                    const sent = Math.min(total, Math.max(0, row.sent));
                                                    const barHeight = Math.max(8, Math.round((total / analyticsInsights.dailyMax) * 100));
                                                    const inboundHeight = total > 0 ? (inbound / total) * 100 : 0;
                                                    const sentHeight = total > 0 ? (sent / total) * 100 : 0;
                                                    return (
                                                        <div
                                                            key={row.date}
                                                            className="w-[24px] sm:w-[28px] shrink-0 h-full flex flex-col justify-end items-center gap-2"
                                                            title={`${row.date}: total ${total}, inbound ${inbound}, sent ${sent}`}
                                                        >
                                                            <div
                                                                className="relative w-full rounded-t-[10px] bg-[#e9eef1] overflow-hidden transition-all hover:scale-[1.03]"
                                                                style={{ height: `${barHeight}%` }}
                                                            >
                                                                {inbound > 0 && (
                                                                    <span
                                                                        className="absolute bottom-0 left-0 right-0 bg-[#4f9cf9]"
                                                                        style={{ height: `${inboundHeight}%` }}
                                                                    />
                                                                )}
                                                                {sent > 0 && (
                                                                    <span
                                                                        className="absolute top-0 left-0 right-0 bg-[#00a884]"
                                                                        style={{ height: `${sentHeight}%` }}
                                                                    />
                                                                )}
                                                            </div>
                                                            <span className="text-[10px] font-bold text-[#6a7b87]">{formatAnalyticsDateShort(row.date)}</span>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                        <div className="mt-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs text-[#6a7b87] font-medium">
                                            <span>
                                                Peak day: {analyticsInsights.peakDay ? `${analyticsInsights.peakDay.date} (${analyticsInsights.peakDay.total})` : 'n/a'}
                                            </span>
                                            <span>Average per active day: {analyticsInsights.averagePerActiveDay.toFixed(1)}</span>
                                        </div>
                                    </>
                                )}
                            </div>

                            <div className="bg-white p-6 rounded-[24px] border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
                                <div className="text-[#54656f] text-[10px] uppercase font-black tracking-widest">Chart</div>
                                <h3 className="text-lg font-bold text-[#111b21] mt-1">Inbound vs Sent Share</h3>
                                <div className="mt-5 flex items-center justify-center">
                                    <div
                                        className="w-40 h-40 rounded-full flex items-center justify-center"
                                        style={{
                                            background: `conic-gradient(#00a884 0 ${Math.round(analyticsInsights.sentShare * 100)}%, #4f9cf9 ${Math.round(analyticsInsights.sentShare * 100)}% 100%)`
                                        }}
                                    >
                                        <div className="w-[102px] h-[102px] rounded-full bg-white border border-[#edf1f4] flex flex-col items-center justify-center">
                                            <span className="text-[10px] uppercase tracking-widest text-[#6a7b87] font-black">Sent</span>
                                            <span className="text-2xl font-black text-[#111b21]">{Math.round(analyticsInsights.sentShare * 100)}%</span>
                                        </div>
                                    </div>
                                </div>
                                <div className="mt-6 space-y-3">
                                    <div className="flex items-center justify-between text-sm">
                                        <span className="text-[#54656f] font-medium">Inbound</span>
                                        <span className="font-bold text-[#4f9cf9]">
                                            {analyticsInsights.inboundCount} ({Math.round(analyticsInsights.inboundShare * 100)}%)
                                        </span>
                                    </div>
                                    <div className="flex items-center justify-between text-sm">
                                        <span className="text-[#54656f] font-medium">Sent</span>
                                        <span className="font-bold text-[#00a884]">
                                            {analyticsInsights.totals.messages_sent} ({Math.round(analyticsInsights.sentShare * 100)}%)
                                        </span>
                                    </div>
                                </div>
                                <div className="mt-6 p-4 rounded-2xl border border-[#edf1f4] bg-[#f8fafb]">
                                    <div className="text-[10px] uppercase tracking-widest font-black text-[#6a7b87]">Insight</div>
                                    <p className="text-sm text-[#42535f] mt-2 leading-relaxed">
                                        Workflow starts are {analyticsInsights.workflowStartRate.toFixed(1)}% of outbound traffic in this range.
                                    </p>
                                </div>
                            </div>
                        </div>

                        <div className="bg-white rounded-[24px] border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)] overflow-hidden mb-8">
                            <div className="px-6 py-4 border-b border-[#eceff1] bg-[#fcfdfd] flex items-center justify-between">
                                <h3 className="text-sm font-bold text-[#111b21]">Staff Reply Performance</h3>
                                <span className="text-[11px] font-bold uppercase tracking-widest text-[#6a7b87]">{analyticsStaffRows.length} staff</span>
                            </div>
                            <div className="overflow-x-auto">
                                <table className="w-full text-left">
                                    <thead className="bg-[#fcfdfd] text-[#54656f] text-[10px] uppercase font-black tracking-widest border-b border-[#eceff1]">
                                        <tr>
                                            <th className="px-6 py-4">Staff</th>
                                            <th className="px-6 py-4">Sent</th>
                                            <th className="px-6 py-4">Reply Rate</th>
                                            <th className="px-6 py-4">Replied / Inbound</th>
                                            <th className="px-6 py-4">Contacts</th>
                                            <th className="px-6 py-4">Workflow Runs</th>
                                            <th className="px-6 py-4">Expired</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-[#f0f2f5]">
                                        {analyticsStaffRows.length === 0 ? (
                                            <tr>
                                                <td className="px-6 py-6 text-sm text-[#8696a0]" colSpan={7}>
                                                    No staff analytics for this range yet.
                                                </td>
                                            </tr>
                                        ) : (
                                            analyticsStaffRows.map((row: AnalyticsStaffRow) => (
                                                <tr key={row.user_id} className="hover:bg-[#f8f9fa] transition-all">
                                                    <td className="px-6 py-4 text-sm font-bold text-[#111b21]">
                                                        <span className="inline-flex items-center gap-2">
                                                            <span
                                                                className="w-2.5 h-2.5 rounded-full border border-white shadow-[0_0_0_1px_rgba(17,27,33,0.08)]"
                                                                style={{ backgroundColor: row.color || '#6b7280' }}
                                                            />
                                                            {row.name || row.user_id}
                                                        </span>
                                                    </td>
                                                    <td className="px-6 py-4 text-sm text-[#54656f] font-medium">{row.sent}</td>
                                                    <td className="px-6 py-4 text-sm font-bold text-[#111b21]">{row.reply_rate.toFixed(1)}%</td>
                                                    <td className="px-6 py-4 text-sm text-[#54656f] font-medium">
                                                        {row.replied_contacts} / {row.inbound_contacts}
                                                    </td>
                                                    <td className="px-6 py-4 text-sm text-[#54656f] font-medium">{row.contacts_messaged}</td>
                                                    <td className="px-6 py-4 text-sm text-[#54656f] font-medium">{row.workflow_runs}</td>
                                                    <td className="px-6 py-4 text-sm font-medium text-rose-700">{row.expired_messages}</td>
                                                </tr>
                                            ))
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </div>

                        <div className="bg-white rounded-[24px] border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)] overflow-hidden">
                            <div className="px-6 py-4 border-b border-[#eceff1] bg-[#fcfdfd] flex items-center justify-between">
                                <h3 className="text-sm font-bold text-[#111b21]">Daily Breakdown</h3>
                                <span className="text-[11px] font-bold uppercase tracking-widest text-[#6a7b87]">{analyticsRows.length} days</span>
                            </div>
                            <div className="overflow-x-auto">
                                <table className="w-full text-left">
                                    <thead className="bg-[#fcfdfd] text-[#54656f] text-[10px] uppercase font-black tracking-widest border-b border-[#eceff1]">
                                        <tr>
                                            <th className="px-6 py-4">Date</th>
                                            <th className="px-6 py-4">Total Messages</th>
                                            <th className="px-6 py-4">Inbound</th>
                                            <th className="px-6 py-4">Sent</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-[#f0f2f5]">
                                        {analyticsRows.length === 0 ? (
                                            <tr>
                                                <td className="px-6 py-6 text-sm text-[#8696a0]" colSpan={4}>
                                                    No analytics data for this range.
                                                </td>
                                            </tr>
                                        ) : (
                                            analyticsRows.map((row: AnalyticsPerDayRow) => (
                                                <tr key={row.date} className="hover:bg-[#f8f9fa] transition-all">
                                                    <td className="px-6 py-4 text-sm font-bold text-[#111b21]">{row.date}</td>
                                                    <td className="px-6 py-4 text-sm text-[#54656f] font-medium">{row.total}</td>
                                                    <td className="px-6 py-4 text-sm text-[#54656f] font-medium">{row.inbound}</td>
                                                    <td className="px-6 py-4 text-sm text-[#54656f] font-medium">{row.sent}</td>
                                                </tr>
                                            ))
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Admin View is handled above - deleting redundant block if any */}

            <div className="fixed bottom-6 right-6 z-[200] flex flex-col items-end gap-3">
                {import.meta.env.DEV && (
                    <DebugButton
                        payload={{
                            ts: new Date().toISOString(),
                            env: {
                                mode: import.meta.env.MODE,
                                socketUrl: SOCKET_URL
                            },
                            session: {
                                userId: session.user.id,
                                email: session.user.email || null,
                                companyId:
                                    (session.user.user_metadata as any)?.company_id ||
                                    (session.user.app_metadata as any)?.company_id ||
                                    null,
                                expiresAt: session.expires_at || null,
                                accessToken: redactSecret(session.access_token)
                            },
                            socket: {
                                connected: Boolean(socket?.connected),
                                id: socket?.id || null
                            },
                            state: {
                                isAdmin,
                                activeView,
                                activeProfileId: activeProfileId || null,
                                connectionStatus,
                                selectedChatId: selectedChatId || null,
                                windowOpen,
                                forceTemplateMode,
                                lastProfileError
                            },
                            counts: {
                                profiles: profiles.length,
                                chats: chatList.length,
                                messages: allMessages.length,
                                logs: logEntries.length
                            },
                            serverStats
                        }}
                    />
                )}
                {logOpen && (
                    <div className="w-[360px] max-h-[60vh] bg-white border border-[#eceff1] rounded-2xl shadow-[0_12px_40px_rgba(0,0,0,0.12)] overflow-hidden">
                        <div className="px-4 py-3 border-b border-[#eceff1] flex items-center gap-2">
                            <Bug className="w-4 h-4 text-[#00a884]" />
                            <span className="text-sm font-bold text-[#111b21]">Flow Logs</span>
                            <button
                                onClick={() => setLogEntries([])}
                                className="ml-auto text-[11px] font-bold text-[#00a884] hover:text-[#008f6f]"
                            >
                                Clear
                            </button>
                            <button
                                onClick={() => setLogOpen(false)}
                                className="text-[#54656f] hover:text-[#111b21] p-1 rounded-md"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>
                        <div className="px-4 py-3 border-b border-[#eceff1] bg-[#fcfdfd]">
                            <div className="grid grid-cols-3 gap-2">
                                <div className="rounded-xl border border-[#eceff1] bg-white px-3 py-2">
                                    <div className="text-[10px] font-bold uppercase tracking-widest text-[#54656f]">CPU</div>
                                    <div className="text-[12px] font-black text-[#111b21]">
                                        {serverStats?.cpu !== undefined ? `${serverStats.cpu}%` : '--'}
                                    </div>
                                </div>
                                <div className="rounded-xl border border-[#eceff1] bg-white px-3 py-2">
                                    <div className="text-[10px] font-bold uppercase tracking-widest text-[#54656f]">RAM</div>
                                    <div className="text-[12px] font-black text-[#111b21]">
                                        {serverStats?.memUsed !== undefined && serverStats?.memTotal !== undefined
                                            ? `${formatBytes(serverStats.memUsed)} / ${formatBytes(serverStats.memTotal)}`
                                            : '--'}
                                    </div>
                                    <div className="text-[10px] font-medium text-[#54656f]">
                                        {serverStats?.memPct !== undefined ? `${serverStats.memPct}% used` : ''}
                                    </div>
                                </div>
                                <div className="rounded-xl border border-[#eceff1] bg-white px-3 py-2">
                                    <div className="text-[10px] font-bold uppercase tracking-widest text-[#54656f]">Bandwidth</div>
                                    <div className="text-[11px] font-black text-[#111b21]">
                                        ↑ {formatBps(serverStats?.bandwidth?.outBps)}
                                    </div>
                                    <div className="text-[11px] font-black text-[#111b21]">
                                        ↓ {formatBps(serverStats?.bandwidth?.inBps)}
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div className="max-h-[50vh] overflow-y-auto custom-scrollbar">
                            {logEntries.length === 0 ? (
                                <div className="px-4 py-6 text-xs text-[#8696a0] text-center">
                                    No logs yet.
                                </div>
                            ) : (
                                <div className="flex flex-col gap-2 px-4 py-3">
                                    {logEntries.slice().reverse().map(entry => (
                                        <div key={entry.id} className="border border-[#f0f2f5] rounded-xl px-3 py-2 bg-[#f8f9fa]">
                                            <div className="flex items-center gap-2 text-[10px] font-bold text-[#54656f]">
                                                <span>{formatLogTime(entry.ts)}</span>
                                                <span className={`px-2 py-0.5 rounded-full ${entry.level === 'error' ? 'bg-rose-100 text-rose-600' : 'bg-emerald-100 text-emerald-600'}`}>
                                                    {entry.level.toUpperCase()}
                                                </span>
                                            </div>
                                            <div className="text-[12px] text-[#111b21] mt-1 break-words">
                                                {entry.message}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                )}
                <button
                    onClick={() => setLogOpen(prev => !prev)}
                    className="flex items-center gap-2 bg-[#111b21] text-white px-4 py-2 rounded-full shadow-lg hover:bg-[#202c33] transition-all"
                >
                    <Bug className="w-4 h-4" />
                    <span className="text-xs font-bold uppercase tracking-widest">Logs</span>
                    {logEntries.length > 0 && (
                        <span className="ml-1 bg-[#00a884] text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
                            {logEntries.length}
                        </span>
                    )}
                </button>
            </div>

            <style dangerouslySetInnerHTML={{
                __html: `
                .custom-scrollbar::-webkit-scrollbar {
                  width: 6px !important;
                }
                .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
                .custom-scrollbar::-webkit-scrollbar-thumb { background: #ced0d6; border-radius: 10px; }
                .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #aebac1; }
                
                input::placeholder { color: #54656f; opacity: 0.5; }
                textarea::placeholder { color: #54656f; opacity: 0.5; }
                
                * { font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important; }
            ` }} />
                </div>
            ) : workspaceSection === 'broadcast' ? (
                <BroadcastView
                    broadcastNav={broadcastNav}
                    broadcastSection={broadcastSection}
                    setBroadcastSection={setBroadcastSection}
                    activeProfileId={activeProfileId}
                    sessionToken={session?.access_token || null}
                    BroadcastTemplateBuilder={LazyBroadcastTemplateBuilder}
                    BroadcastTemplatesList={LazyBroadcastTemplatesList}
                />
            ) : workspaceSection === 'automations' ? (
                <AutomationsView
                    workflows={automationWorkflows}
                    workflowsLoading={workflowsLoading}
                    profileId={activeProfileId}
                    sessionToken={session?.access_token || null}
                    apiBaseUrl={SOCKET_URL}
                    onOpenBuilder={openAutomationBuilder}
                    onCreateWorkflow={handleCreateAutomation}
                    onToggleWorkflowEnabled={handleToggleAutomationEnabled}
                    onCopyWorkflow={handleCopyAutomation}
                    onQuickRepliesUpdated={fetchQuickReplies}
                    onSaveWorkflowTrigger={handleSaveWorkflowTrigger}
                />
            ) : workspaceSection === 'chatbots' ? (
                <ChatbotsView
                    profileId={activeProfileId}
                    sessionToken={session?.access_token || null}
                    apiBaseUrl={SOCKET_URL}
                />
            ) : workspaceSection === 'more' ? (
                <div className="h-screen pt-[72px] bg-[#f8f9fa] text-[#111b21] font-sans">
                    <div className="h-full p-6 overflow-y-auto custom-scrollbar">
                        <div className="max-w-3xl mx-auto space-y-4">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {!isUiFeatureHidden(SETTINGS_UI_FEATURE_KEY) && (
                                    <button
                                        type="button"
                                        onClick={openSettingsFromMore}
                                        className="text-left bg-white border border-[#eceff1] rounded-2xl p-5 hover:bg-[#f8f9fa] transition-all cursor-pointer pointer-events-auto"
                                    >
                                        <div className="flex items-center gap-3 mb-2">
                                            <div className="w-9 h-9 rounded-xl bg-[#00a884]/10 border border-[#00a884]/20 text-[#00a884] flex items-center justify-center">
                                                <Settings className="w-5 h-5" />
                                            </div>
                                            <div className="text-lg font-black text-[#111b21]">Settings</div>
                                        </div>
                                        <p className="text-sm text-[#54656f]">
                                            Webhooks, onboarding, team users, and workspace configuration.
                                        </p>
                                    </button>
                                )}

                                {!isUiFeatureHidden('analytics') && (
                                    <button
                                        type="button"
                                        onClick={openAnalyticsFromMore}
                                        className="text-left bg-white border border-[#eceff1] rounded-2xl p-5 hover:bg-[#f8f9fa] transition-all cursor-pointer pointer-events-auto"
                                    >
                                        <div className="flex items-center gap-3 mb-2">
                                            <div className="w-9 h-9 rounded-xl bg-[#111b21]/5 border border-[#111b21]/10 text-[#111b21] flex items-center justify-center">
                                                <CircleDashed className="w-5 h-5" />
                                            </div>
                                            <div className="text-lg font-black text-[#111b21]">Analytics</div>
                                        </div>
                                        <p className="text-sm text-[#54656f]">
                                            View message totals, workflow metrics, and date-based performance.
                                        </p>
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            ) : workspaceSection === 'contacts' ? (
                <ContactsView
                    contactsList={contactsList}
                    teamUsersLoading={teamUsersLoading}
                    teamUsers={teamUsers}
                    contactsSearchQuery={contactsSearchQuery}
                    onContactsSearchChange={setContactsSearchQuery}
                    assigningContactId={assigningContactId}
                    onToggleAssignMenu={(contactId) => {
                        if (!teamUsers.length && !teamUsersLoading) fetchTeamUsers();
                        setAssignMenuContactId(prev => (prev === contactId ? null : contactId));
                    }}
                    onOpenChat={(contactId) => {
                        handleOpenChat(contactId);
                        setWorkspaceSection(defaultWorkspaceSection);
                    }}
                />
            ) : (
                <div className="h-screen pt-[72px] bg-[#f8f9fa] text-[#111b21] font-sans">
                    <div className="h-full flex items-center justify-center p-6">
                        <div className="w-full max-w-xl bg-white border border-[#eceff1] rounded-3xl p-8 shadow-[0_12px_40px_rgba(0,0,0,0.06)]">
                            <h2 className="text-2xl font-black text-[#111b21] mb-3">{activeWorkspaceLabel}</h2>
                            <p className="text-sm text-[#54656f] leading-relaxed mb-6">
                                This section is not enabled yet. Open an available workspace section to continue.
                            </p>
                            <button
                                onClick={() => setWorkspaceSection(defaultWorkspaceSection)}
                                className="px-5 py-3 rounded-xl bg-[#00a884] text-white text-sm font-bold hover:bg-[#008f6f] transition-all"
                            >
                                Open Workspace
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {assignMenuContactId && !assignMenuContactId.endsWith('@g.us') && (
                <div
                    className="fixed inset-0 z-[260] bg-black/30 backdrop-blur-[1px] flex items-center justify-center p-4"
                    onClick={() => setAssignMenuContactId(null)}
                >
                    <div
                        className="w-full max-w-md bg-white border border-[#eceff1] rounded-2xl shadow-[0_18px_60px_rgba(0,0,0,0.2)] overflow-hidden"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="px-4 py-3 border-b border-[#eceff1] flex items-center gap-3">
                            <div className="w-9 h-9 rounded-full bg-[#f0f2f5] border border-[#eceff1] flex items-center justify-center">
                                <User className="w-4 h-4 text-[#54656f]" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="text-sm font-bold text-[#111b21] truncate">{assignTargetName || 'Contact'}</div>
                                <div className="text-[11px] text-[#00a884] font-bold">{assignTargetPhone || '-'}</div>
                            </div>
                            <button
                                type="button"
                                onClick={() => setAssignMenuContactId(null)}
                                className="p-1.5 rounded-lg text-[#8696a0] hover:bg-[#f0f2f5] hover:text-[#111b21]"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="px-4 py-3 border-b border-[#eceff1] text-[12px] text-[#54656f]">
                            Current assignee:{' '}
                            <span className="font-bold text-[#111b21]">
                                {assignTargetContact?.assigneeName || 'Unassigned'}
                            </span>
                        </div>

                        <div className="max-h-[52vh] overflow-y-auto custom-scrollbar p-2">
                            <button
                                type="button"
                                onClick={() => handleAssignContact(assignMenuContactId, null)}
                                disabled={assigningContactId === assignMenuContactId}
                                className={`w-full text-left px-3 py-2 rounded-xl text-[12px] font-bold transition-all ${!assignTargetAssigneeUserId ? 'bg-[#f8f9fa] text-[#111b21]' : 'hover:bg-[#f8f9fa] text-[#6b7280]'} disabled:opacity-60`}
                            >
                                Unassign
                            </button>
                            <div className="h-px bg-[#f0f2f5] my-2" />
                            {teamUsersLoading && teamUsers.length === 0 ? (
                                <div className="px-3 py-3 animate-pulse space-y-2">
                                    <div className="h-8 rounded-xl bg-[#eef2f5]" />
                                    <div className="h-8 rounded-xl bg-[#eef2f5]" />
                                    <div className="h-8 rounded-xl bg-[#eef2f5]" />
                                </div>
                            ) : teamUsers.length === 0 ? (
                                <div className="px-3 py-3 text-[12px] text-[#9ca3af]">No staff found</div>
                            ) : (
                                teamUsers.map((member) => {
                                    const active = assignTargetAssigneeUserId === member.id;
                                    return (
                                        <button
                                            key={`assign-modal-${assignMenuContactId}-${member.id}`}
                                            type="button"
                                            onClick={() => handleAssignContact(assignMenuContactId, member.id)}
                                            disabled={assigningContactId === assignMenuContactId}
                                            className={`w-full text-left px-3 py-2 rounded-xl text-[12px] font-semibold hover:bg-[#f8f9fa] transition-all disabled:opacity-60 ${active ? 'bg-[#f0f7ff]' : ''}`}
                                        >
                                            <span
                                                className="inline-block w-2 h-2 rounded-full mr-2 align-middle"
                                                style={{ backgroundColor: member.color || '#6b7280' }}
                                            />
                                            <span className="align-middle">{member.name}</span>
                                            <span className="ml-2 text-[10px] uppercase tracking-wide text-[#9ca3af]">{member.role}</span>
                                        </button>
                                    );
                                })
                            )}
                        </div>
                    </div>
                </div>
            )}
            {appToast && (
                <div className="fixed top-4 right-4 z-[280] max-w-[360px]">
                    <div
                        className={`rounded-xl border px-4 py-2.5 text-sm font-semibold shadow-lg ${appToast.tone === 'success'
                                ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                                : 'bg-rose-50 border-rose-200 text-rose-700'
                            }`}
                    >
                        {appToast.message}
                    </div>
                </div>
            )}
        </>
    );
}
