
import React, { Suspense, lazy, useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { List, useDynamicRowHeight, useListRef } from 'react-window';
import { io, Socket } from 'socket.io-client';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import {
    Search,
    MoreVertical,
    Menu,
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
    Bot,
    Bell,
    LifeBuoy
} from 'lucide-react';
import Login from './Login';
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
import BottomNavBar from './features/mobile/BottomNavBar';
import ChatHeader from './features/mobile/ChatHeader';
import ContactListItem from './features/mobile/ContactListItem';
import ChatBubble from './features/mobile/ChatBubble';
import MessageInputBar from './features/mobile/MessageInputBar';
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
import {
    getNotificationPermissionState,
} from './features/pwa/installUtils';
import {
    NATIVE_PUSH_CHANNEL_ID,
    NATIVE_PUSH_ACTION_EVENT,
    NATIVE_PUSH_CHANNEL_STATUS_EVENT,
    NATIVE_PUSH_RECEIVED_EVENT,
    NATIVE_PUSH_TOKEN_EVENT,
    initializeNativePushBridge,
    refreshNativePushChannelStatus,
    type NativePushActionEventDetail,
    type NativePushChannelStatusEventDetail,
    type NativePushReceivedEventDetail,
    type NativePushTokenEventDetail
} from './features/native/nativePushBridge';
import {
    openAndroidAppNotificationSettings,
    openAndroidChannelNotificationSettings
} from './features/native/nativeNotificationSettingsBridge';


const SOCKET_URL = getSocketUrl();
const SINGLE_PROFILE_MODE = false;
const OAUTH_PENDING_COMPANY_KEY = 'pendingOAuthCompanyId';
const MOBILE_LAYOUT_BREAKPOINT = 1024;
const MOBILE_BOTTOM_TAB_SECTIONS = ['team-inbox', 'automations', 'contacts', 'more'] as const;
const PWA_UPDATE_AVAILABLE_EVENT = 'qmessage:pwa-update-available';
const API_REQUEST_TIMEOUT_MS = 18_000;
const AUTH_CHECK_TIMEOUT_MS = 4_000;
const PROFILE_SYNC_TIMEOUT_MS = 20_000;
const CHAT_SYNC_TIMEOUT_MS = 24_000;
const SOCKET_STALE_REFRESH_INTERVAL_MS = 90_000;
const BROWSER_VOICE_CALL_DISCONNECT_GRACE_MS = 8_000;
const DEFAULT_WEBRTC_ICE_SERVERS: RTCIceServer[] = [
    {
        urls: [
            'stun:stun.l.google.com:19302',
            'stun:stun1.l.google.com:19302'
        ]
    }
];

const parseWebrtcIceServers = (): RTCIceServer[] => {
    const raw = typeof import.meta.env.VITE_WEBRTC_ICE_SERVERS === 'string'
        ? import.meta.env.VITE_WEBRTC_ICE_SERVERS.trim()
        : '';
    if (!raw) {
        return DEFAULT_WEBRTC_ICE_SERVERS;
    }

    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length === 0) {
            return DEFAULT_WEBRTC_ICE_SERVERS;
        }
        return parsed.filter((entry) => entry && typeof entry === 'object' && entry.urls) as RTCIceServer[];
    } catch {
        return DEFAULT_WEBRTC_ICE_SERVERS;
    }
};
const QUICK_REPLIES_PREFETCH_DELAY_MS = 220;
const NOTIFICATION_SOUND_PREF_KEY = 'qmessage.notification.sound.enabled.v1';
const ANDROID_HEADS_UP_PROMPT_KEY = 'qmessage.native.android.headsup.prompted.v1';

const readNotificationSoundPreference = (): boolean => {
    if (typeof window === 'undefined') return true;
    try {
        const raw = window.localStorage.getItem(NOTIFICATION_SOUND_PREF_KEY);
        if (!raw) return true;
        const normalized = raw.trim().toLowerCase();
        return !(normalized === '0' || normalized === 'false' || normalized === 'off');
    } catch {
        return true;
    }
};

const shouldPromptAndroidHeadsUpEnable = (): boolean => {
    if (typeof window === 'undefined') return false;
    try {
        const raw = window.sessionStorage.getItem(ANDROID_HEADS_UP_PROMPT_KEY);
        return raw !== '1';
    } catch {
        return true;
    }
};

const markAndroidHeadsUpPrompted = () => {
    if (typeof window === 'undefined') return;
    try {
        window.sessionStorage.setItem(ANDROID_HEADS_UP_PROMPT_KEY, '1');
    } catch {
        // ignore persistence failures
    }
};

const shouldShowDebugOverlay = (): boolean => {
    if (import.meta.env.DEV) return true;
    if (Capacitor.isNativePlatform()) return true;
    if (typeof window === 'undefined') return false;
    const protocol = (window.location.protocol || '').toLowerCase();
    if (protocol === 'capacitor:' || protocol === 'ionic:') return true;
    try {
        return new URLSearchParams(window.location.search).get('debug') === '1';
    } catch {
        return false;
    }
};

const urlBase64ToUint8Array = (value: string): ArrayBuffer => {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
    const base64 = normalized + padding;
    const raw = window.atob(base64);
    const output = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) {
        output[index] = raw.charCodeAt(index);
    }
    return output.buffer;
};


const LazyWebhookView = lazy(() => import('./WebhookView'));
const LazyBroadcastTemplateBuilder = lazy(() => import('./BroadcastTemplateBuilder'));
const LazyBroadcastTemplatesList = lazy(() => import('./BroadcastTemplatesList'));
const LazyFlowCanvas = lazy(() => import('./FlowCanvas'));

const isSameSessionIdentity = (left: Session | null, right: Session | null): boolean => {
    if (!left && !right) return true;
    if (!left || !right) return false;
    return (
        left.access_token === right.access_token
        && left.refresh_token === right.refresh_token
        && left.expires_at === right.expires_at
        && left.user?.id === right.user?.id
    );
};

interface Message {
    profileId?: string | null;
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

type ChatListFilterOption = 'all' | 'tagged' | 'untagged' | 'assigned' | 'unassigned';

type ChatListComputationResult = {
    chatsMap: Map<string, Chat>;
    chatList: Chat[];
    latestChatId: string | null;
};

type ContactListRow = {
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

type UnreadDeltaByChat = Record<string, number>;

type UnreadCandidate = {
    jid: string;
    dedupeKey: string;
};

type DebugSocketEventRecord = {
    name: string;
    at: number;
    detail?: string;
};

type ChatListFlickerStats = {
    changes: number;
    rapidChanges: number;
    lastSignature: string;
    lastChangedAt: number;
};

type SendMediaKind = 'image' | 'video' | 'document';

type SendMediaPayload = {
    type: SendMediaKind;
    id?: string;
    url?: string;
    assetKey?: string;
    filename?: string;
};

type OutgoingMessagePayload = {
    text: string;
    media?: SendMediaPayload;
};

type CallPermissionUiState = {
    permissionStatus: string;
    canStartCall: boolean;
    canRequestPermission: boolean;
    expirationTime: string | null;
    storedPermissionStatus: string | null;
    storedUpdatedAt: string | null;
};

type CallSessionPayload = {
    sdp_type: 'offer' | 'answer';
    sdp: string;
};

type IncomingCallState = {
    callId: string;
    profileId: string;
    phoneNumberId: string;
    from: string | null;
    to: string | null;
    direction: string | null;
    contactName: string | null;
    normalizedStatus: string;
    timestamp: number;
    event: string;
    session: CallSessionPayload | null;
    bizOpaqueCallbackData: string | null;
    acceptedByUserId: string | null;
    acceptedByName: string | null;
    acceptedAt: string | null;
    claimExpiresAt: string | null;
    loadingAction: 'accept' | 'reject' | 'terminate' | null;
};

type ActiveVoiceCallState = {
    callId: string | null;
    customerWaId: string | null;
    remoteLabel: string;
    direction: 'inbound' | 'outbound';
    status: 'preparing' | 'connecting' | 'connected' | 'ending' | 'failed';
    muted: boolean;
    startedAt: number;
    profileId: string;
    lastError: string | null;
};

type BrowserVoiceCallSession = {
    peerConnection: RTCPeerConnection;
    localStream: MediaStream;
    remoteStream: MediaStream;
    callId: string | null;
    customerWaId: string | null;
    direction: 'inbound' | 'outbound';
    profileId: string;
    remoteLabel: string;
    remoteDescriptionApplied: boolean;
    preAcceptSent: boolean;
    acceptSent: boolean;
    acceptLockToken: string | null;
    disconnectTimeoutId: number | null;
};

type TemplateBodyAttributePayload = {
    scope: 'body';
    index: number;
    key: string;
    value: string;
};

type TemplateBuildResult = {
    components?: any[];
    bodyAttributes: TemplateBodyAttributePayload[];
    error: string | null;
};

interface MediaData {
    data: string;
    mimetype: string;
}

type MediaDownloadStatus = 'requesting' | 'downloading' | 'processing' | 'error';

interface MediaDownloadProgressState {
    percent: number;
    status: MediaDownloadStatus;
}

type QuickReplyMediaItem = {
    type?: 'image' | 'video' | 'document';
    media_storage?: 'external' | 'r2';
    media_asset_key?: string;
    media_mime_type?: string;
    media_size_bytes?: number | null;
    media_url?: string;
    media_filename?: string;
};

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
    media_items?: QuickReplyMediaItem[];
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
    variant?: 'default' | 'chat';
    title?: string;
    avatarLabel?: string;
};

type WabaConnectedConfettiPiece = {
    id: number;
    left: number;
    hue: number;
    delay: number;
    duration: number;
    size: number;
    opacity: number;
};

type WabaConnectedSummary = {
    phoneNumberId: string;
    displayPhoneNumber: string;
    verifiedName: string;
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
    profileId?: string | null;
    name?: string;
    alias?: string | null;
    whatsappName?: string | null;
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
    total_messages: number;
    workflow_runs: number;
    expired_messages: number;
    contacts_messaged: number;
    inbound_contacts: number;
    replied_contacts: number;
    reply_rate: number;
    avg_response_seconds: number;
    is_online: boolean;
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
const CHAT_READ_CURSOR_STORAGE_PREFIX = 'chatReadCursor:';
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

const normalizeChatReadCursorMap = (value: unknown): Record<string, number> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const next: Record<string, number> = {};
    Object.entries(value as Record<string, unknown>).forEach(([jid, ts]) => {
        const canonical = canonicalContactJid(jid);
        const numericTs = Number(ts);
        if (!canonical || !Number.isFinite(numericTs) || numericTs <= 0) return;
        next[canonical] = Math.floor(numericTs);
    });
    return next;
};

const readChatReadCursorFromStorage = (profileId: string | null | undefined): Record<string, number> => {
    if (typeof window === 'undefined' || !profileId) return {};
    try {
        const raw = window.localStorage.getItem(`${CHAT_READ_CURSOR_STORAGE_PREFIX}${profileId}`);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return normalizeChatReadCursorMap(parsed);
    } catch {
        return {};
    }
};

const resolveRealtimeReadCursor = (
    profileId: string | null | undefined,
    inMemoryCursor: Record<string, number>
): Record<string, number> => {
    if (Object.keys(inMemoryCursor).length > 0) return inMemoryCursor;
    return readChatReadCursorFromStorage(profileId);
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

type DesktopChatListRowProps = {
    chats: Chat[];
    contacts: Record<string, ContactMeta>;
    selectedChatId: string | null;
    onOpenChat: (chatId: string) => void;
    onToggleAssigneeMenu: (chatId: string) => void;
};

const DesktopChatListRow = ({
    ariaAttributes,
    index,
    style,
    chats,
    contacts,
    selectedChatId,
    onOpenChat,
    onToggleAssigneeMenu
}: {
    ariaAttributes: {
        'aria-posinset': number;
        'aria-setsize': number;
        role: 'listitem';
    };
    index: number;
    style: React.CSSProperties;
} & DesktopChatListRowProps) => {
    const chat = chats[index];
    if (!chat) return null;
    const contactMeta = pickContactMetaByJid(contacts, chat.id) || {};
    const assigneeName = contactMeta.assigneeName || null;
    const assigneeColor = contactMeta.assigneeColor || '#6b7280';
    const contactTags = splitContactTags(contactMeta.tags).labelTags;
    const primaryTag = contactTags[0] || null;
    const extraTagCount = Math.max(0, contactTags.length - (primaryTag ? 1 : 0));
    const assigneeNode = assigneeName ? (
        <button
            type="button"
            onClick={(event) => {
                event.stopPropagation();
                onToggleAssigneeMenu(chat.id);
            }}
            className="px-1.5 py-0.5 text-[9px] rounded uppercase font-bold border tracking-tight hover:opacity-85 transition-all"
            style={{
                backgroundColor: withHexAlpha(assigneeColor, '20', '#f3f4f6'),
                borderColor: withHexAlpha(assigneeColor, '66', '#d1d5db'),
                color: textColor(assigneeColor, '#374151')
            }}
            title={`Staff ${assigneeName}`}
        >
            <span className="inline-flex max-w-[110px] items-center truncate">Staff {assigneeName}</span>
        </button>
    ) : chat.id.endsWith('@g.us') ? (
        <span className="px-1.5 py-0.5 bg-[#f0f2f5] text-[#54656f] text-[9px] rounded uppercase font-bold border border-[#eceff1] tracking-tight">Staff Group</span>
    ) : (
        <button
            type="button"
            onClick={(event) => {
                event.stopPropagation();
                onToggleAssigneeMenu(chat.id);
            }}
            className="px-1.5 py-0.5 bg-[#f8f9fa] text-[#9ca3af] text-[9px] rounded uppercase font-bold border border-[#eceff1] tracking-tight hover:bg-[#f0f2f5] transition-all"
        >
            <span className="inline-flex max-w-[110px] items-center truncate">Staff Unassigned</span>
        </button>
    );

    return (
        <div style={style} {...ariaAttributes}>
            <ContactListItem
                id={chat.id}
                name={chat.name}
                preview={chat.lastMessage || ''}
                timestampLabel={chat.timestamp ? new Date(chat.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                isSelected={selectedChatId === chat.id}
                isGroup={chat.id.endsWith('@g.us')}
                phoneLabel={
                    (chat.id.endsWith('@s.whatsapp.net') || chat.id.endsWith('@lid'))
                        && getCleanId(chat.name) !== getCleanId(chat.id)
                        ? formatPhoneNumber(getCleanId(chat.id))
                        : undefined
                }
                badgeCount={chat.unreadCount}
                primaryTag={primaryTag}
                extraTagCount={extraTagCount}
                assignee={assigneeNode}
                onClick={() => onOpenChat(chat.id)}
            />
        </div>
    );
};

const normalizeContactNameValue = (value: unknown): string => (
    typeof value === 'string' ? value.trim() : ''
);

const resolveContactDisplayName = (
    aliasValue: unknown,
    whatsappNameValue: unknown,
    fallbackNameValue: unknown,
    jid: string | null | undefined
): string => {
    const alias = normalizeContactNameValue(aliasValue);
    if (alias) return alias;
    const whatsappName = normalizeContactNameValue(whatsappNameValue);
    if (whatsappName) return whatsappName;
    const fallback = normalizeContactNameValue(fallbackNameValue);
    if (fallback) return fallback;
    return getCleanId(jid || '');
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
                total_messages: toSafeAnalyticsCount(row?.total_messages ?? row?.sent),
                workflow_runs: toSafeAnalyticsCount(row?.workflow_runs),
                expired_messages: toSafeAnalyticsCount(row?.expired_messages),
                contacts_messaged: toSafeAnalyticsCount(row?.contacts_messaged),
                inbound_contacts: toSafeAnalyticsCount(row?.inbound_contacts),
                replied_contacts: toSafeAnalyticsCount(row?.replied_contacts),
                reply_rate: toSafeAnalyticsRate(row?.reply_rate),
                avg_response_seconds: toSafeAnalyticsCount(row?.avg_response_seconds),
                is_online: Boolean(row?.is_online)
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

const formatAnalyticsDuration = (seconds: number): string => {
    const safeSeconds = Math.max(0, Math.floor(seconds));
    if (safeSeconds < 60) return `${safeSeconds}s`;
    const minutes = Math.floor(safeSeconds / 60);
    const remainder = safeSeconds % 60;
    if (minutes < 60) return `${minutes}m ${remainder}s`;
    const hours = Math.floor(minutes / 60);
    const remMinutes = minutes % 60;
    return `${hours}h ${remMinutes}m`;
};

const getUnreadCountForChat = (unreadMessagesByChat: Record<string, number>, jidValue: string): number => {
    const key = canonicalContactJid(jidValue) || jidValue;
    return Math.max(0, Number(unreadMessagesByChat[key] || 0));
};

const getChatListPreviewText = (msg: Message): string => (
    msg.message?.conversation
    || msg.message?.extendedTextMessage?.text
    || msg.message?.buttonsMessage?.contentText
    || msg.message?.listMessage?.description
    || (msg.message?.buttonsMessage ? 'Buttons' : msg.message?.listMessage ? 'List' : 'Media message')
);

const getIncomingNotificationPreview = (msg: Message): string => {
    const preview = getMessagePreviewText(msg).trim();
    if (preview) return preview;
    if (msg.message?.imageMessage) return 'Photo';
    if (msg.message?.videoMessage) return 'Video';
    if (msg.message?.documentMessage) return 'Document';
    if (msg.message?.audioMessage) return 'Voice message';
    return 'New message';
};

const MAX_NOTIFICATION_BODY_LENGTH = 120;

const truncateNotificationBody = (value: string, maxLength = MAX_NOTIFICATION_BODY_LENGTH): string => {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized) return 'New message';
    if (maxLength <= 3) return normalized.slice(0, Math.max(0, maxLength));
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength - 3)}...`;
};

const normalizeChatDisplayName = (rawName: string, jid: string): string => {
    const cleanId = getCleanId(jid);
    const normalized = rawName.trim() || cleanId;
    if (normalized.includes('@')) return getCleanId(normalized);
    return normalized;
};

const doesChatMatchQueryAndFilter = (
    chat: Chat,
    contacts: Record<string, ContactMeta>,
    query: string,
    filter: ChatListFilterOption
): boolean => {
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
    if (filter === 'tagged') return hasTags;
    if (filter === 'untagged') return !hasTags;
    if (filter === 'assigned') return hasAssignee;
    if (filter === 'unassigned') return !hasAssignee;
    return true;
};

const dedupeChatsByCanonicalJid = (list: Chat[]): Chat[] => {
    const seenCustomers = new Set<string>();
    return list.filter((chat) => {
        const key = canonicalContactJid(chat.id) || chat.id;
        if (seenCustomers.has(key)) return false;
        seenCustomers.add(key);
        return true;
    });
};

const applyUnreadCountsToChats = (
    list: Chat[],
    unreadMessagesByChat: Record<string, number>
): Chat[] => list.map((chat) => ({
    ...chat,
    unreadCount: getUnreadCountForChat(unreadMessagesByChat, chat.id)
}));

const buildChatListComputation = (
    allMessages: Message[],
    contacts: Record<string, ContactMeta>,
    searchQuery: string,
    chatListFilter: ChatListFilterOption,
    unreadMessagesByChat: Record<string, number>
): ChatListComputationResult => {
    const nextMap = new Map<string, Chat>();

    allMessages.forEach((msg) => {
        const rawJid = msg.key.remoteJid;
        if (!rawJid) return;
        const jid = canonicalContactJid(rawJid);
        if (!jid) return;

        const existing = nextMap.get(jid);
        if (!existing || (msg.messageTimestamp && msg.messageTimestamp > (existing.timestamp || 0))) {
            const cleanId = getCleanId(jid);
            const rawName = pickContactMetaByJid(contacts, rawJid)?.name || msg.pushName || cleanId;
            nextMap.set(jid, {
                id: jid,
                name: normalizeChatDisplayName(rawName, jid),
                lastMessage: getChatListPreviewText(msg),
                timestamp: msg.messageTimestamp,
                unreadCount: getUnreadCountForChat(unreadMessagesByChat, jid)
            });
        }
    });

    Object.entries(contacts).forEach(([rawJid, contact]) => {
        const jid = canonicalContactJid(rawJid);
        if (!jid || nextMap.has(jid)) return;
        const mergedContact = pickContactMetaByJid(contacts, jid) || contact;
        const cleanId = getCleanId(jid);
        const lastInboundMs = mergedContact?.lastInboundAt ? new Date(mergedContact.lastInboundAt).getTime() : 0;
        const timestamp = Number.isFinite(lastInboundMs) && lastInboundMs > 0
            ? Math.floor(lastInboundMs / 1000)
            : 0;
        nextMap.set(jid, {
            id: jid,
            name: normalizeChatDisplayName(mergedContact?.name || cleanId, jid),
            lastMessage: '',
            timestamp,
            unreadCount: getUnreadCountForChat(unreadMessagesByChat, jid)
        });
    });

    const query = searchQuery.trim().toLowerCase();
    const filteredAndSorted = Array.from(nextMap.values())
        .filter((chat) => doesChatMatchQueryAndFilter(chat, contacts, query, chatListFilter))
        .sort((a, b) => {
            const tsDiff = (b.timestamp || 0) - (a.timestamp || 0);
            if (tsDiff !== 0) return tsDiff;
            return a.id.localeCompare(b.id);
        });
    const dedupedList = dedupeChatsByCanonicalJid(filteredAndSorted);
    const nextListWithUnread = applyUnreadCountsToChats(dedupedList, unreadMessagesByChat);

    return {
        chatsMap: nextMap,
        chatList: nextListWithUnread,
        latestChatId: nextListWithUnread[0]?.id || null
    };
};

const ensureContactRow = (
    rows: Map<string, ContactListRow>,
    contacts: Record<string, ContactMeta>,
    jid: string
): ContactListRow | null => {
    const key = canonicalContactJid(jid);
    if (!key || key.endsWith('@g.us')) return null;
    const existing = rows.get(key);
    if (existing) return existing;

    const meta = pickContactMetaByJid(contacts, key) || {};
    const phone = formatPhoneNumber(getCleanId(key));
    const fallbackName = phone;
    const row: ContactListRow = {
        id: key,
        name: meta.name || fallbackName,
        phone,
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

const applyMessageToContactRow = (row: ContactListRow, msg: Message): void => {
    row.totalMessages += 1;
    const timestampMs = (msg.messageTimestamp || 0) * 1000;
    if (timestampMs > row.lastActivityTs) row.lastActivityTs = timestampMs;
    if (!msg.key.fromMe && timestampMs > 0) {
        const inboundIso = new Date(timestampMs).toISOString();
        if (!row.lastInboundAt || timestampMs > new Date(row.lastInboundAt).getTime()) {
            row.lastInboundAt = inboundIso;
        }
    }
    if (!row.name) {
        row.name = msg.pushName || row.phone;
    }
};

const doesContactMatchQuery = (row: ContactListRow, query: string): boolean => {
    if (!query) return true;
    if (row.name.toLowerCase().includes(query)) return true;
    if (row.phone.toLowerCase().includes(query)) return true;
    if (row.tags.some((tag) => tag.toLowerCase().includes(query))) return true;
    return false;
};

const getContactSortTimestamp = (row: ContactListRow): number => (
    row.lastActivityTs || (row.lastInboundAt ? new Date(row.lastInboundAt).getTime() : 0)
);

const buildContactsListComputation = (
    contacts: Record<string, ContactMeta>,
    allMessages: Message[],
    contactsSearchQuery: string
): ContactListRow[] => {
    const rows = new Map<string, ContactListRow>();
    Object.keys(contacts).forEach((jid) => {
        ensureContactRow(rows, contacts, jid);
    });

    allMessages.forEach((msg) => {
        const row = ensureContactRow(rows, contacts, msg.key?.remoteJid || '');
        if (!row) return;
        applyMessageToContactRow(row, msg);
    });

    const query = contactsSearchQuery.trim().toLowerCase();
    const filtered = Array.from(rows.values()).filter((row) => doesContactMatchQuery(row, query));
    filtered.sort((a, b) => getContactSortTimestamp(b) - getContactSortTimestamp(a));
    return filtered;
};

const buildUnreadDedupeKey = (
    jid: string,
    rawMessageId: string,
    timestamp: number,
    index: number
): string => `${jid}:${rawMessageId || `ts-${timestamp}-idx-${index}`}`;

const toUnreadCandidate = (
    message: any,
    index: number,
    chatReadCursorByChat: Record<string, number>
): UnreadCandidate | null => {
    if (message?.key?.fromMe) return null;
    const jid = canonicalContactJid(message?.key?.remoteJid || '');
    if (!jid) return null;
    const rawMessageId = typeof message?.key?.id === 'string' ? message.key.id.trim() : '';
    const timestamp = Number(message?.messageTimestamp || 0);
    const readCursor = Number(chatReadCursorByChat[jid] || 0);
    if (readCursor > 0 && (!timestamp || timestamp <= readCursor)) return null;
    return {
        jid,
        dedupeKey: buildUnreadDedupeKey(jid, rawMessageId, timestamp, index)
    };
};

const incrementUnreadDelta = (target: UnreadDeltaByChat, jid: string): void => {
    target[jid] = (target[jid] || 0) + 1;
};

const mergeUnreadDelta = (
    currentUnreadByChat: Record<string, number>,
    unreadDeltaByChat: UnreadDeltaByChat
): Record<string, number> => {
    if (Object.keys(unreadDeltaByChat).length === 0) return currentUnreadByChat;
    const next = { ...currentUnreadByChat };
    Object.entries(unreadDeltaByChat).forEach(([jid, count]) => {
        next[jid] = (next[jid] || 0) + count;
    });
    return next;
};

const collectUnreadDeltaFromIncomingUpsert = (
    incomingMessages: any[],
    activeChatKey: string,
    seenIncomingMessageKeys: Set<string>,
    chatReadCursorByChat: Record<string, number>
): UnreadDeltaByChat => {
    const unreadDeltaByChat: UnreadDeltaByChat = {};
    incomingMessages.forEach((msg, index) => {
        const candidate = toUnreadCandidate(msg, index, chatReadCursorByChat);
        if (!candidate) return;
        if (seenIncomingMessageKeys.has(candidate.dedupeKey)) return;
        seenIncomingMessageKeys.add(candidate.dedupeKey);
        if (activeChatKey && candidate.jid === activeChatKey) return;
        incrementUnreadDelta(unreadDeltaByChat, candidate.jid);
    });
    return unreadDeltaByChat;
};

const collectUnreadDeltaFromHistory = (
    historyMessages: any[],
    activeChatKey: string,
    previousSeen: Set<string>,
    chatReadCursorByChat: Record<string, number>
): { nextSeen: Set<string>; unreadDeltaByChat: UnreadDeltaByChat } => {
    const nextSeen = new Set<string>();
    const unreadDeltaByChat: UnreadDeltaByChat = {};
    historyMessages.forEach((msg, index) => {
        const candidate = toUnreadCandidate(msg, index, chatReadCursorByChat);
        if (!candidate) return;
        nextSeen.add(candidate.dedupeKey);
        if (previousSeen.has(candidate.dedupeKey)) return;
        if (activeChatKey && candidate.jid === activeChatKey) return;
        incrementUnreadDelta(unreadDeltaByChat, candidate.jid);
    });
    return { nextSeen, unreadDeltaByChat };
};

const buildMessageIdentityKey = (msg: Message, index = 0): string => {
    const jid = canonicalContactJid(msg?.key?.remoteJid || '') || msg?.key?.remoteJid || '';
    const id = typeof msg?.key?.id === 'string' ? msg.key.id.trim() : '';
    const ts = Number(msg?.messageTimestamp || 0);
    return `${jid}:${id || `ts-${ts}-i-${index}`}`;
};

const mergeMessagesByIdentity = (current: Message[], incoming: Message[]): Message[] => {
    if (!Array.isArray(incoming) || incoming.length === 0) return current;
    const seen = new Set<string>();
    const merged: Message[] = [];

    incoming.forEach((msg, index) => {
        const key = buildMessageIdentityKey(msg, index);
        if (seen.has(key)) return;
        seen.add(key);
        merged.push(msg);
    });

    current.forEach((msg, index) => {
        const key = buildMessageIdentityKey(msg, index + incoming.length);
        if (seen.has(key)) return;
        seen.add(key);
        merged.push(msg);
    });

    return merged;
};

const getLatestTimestampFromMessages = (messages: Message[]): number => {
    let latest = 0;
    messages.forEach((msg) => {
        const ts = Number(msg?.messageTimestamp || 0);
        if (Number.isFinite(ts) && ts > latest) latest = ts;
    });
    return latest;
};

const trimString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const sanitizeHeaderValue = (value: unknown): string => {
    const raw = typeof value === 'string' ? value : String(value ?? '');
    return raw
        .replace(/[^\x09\x20-\x7E\x80-\xFF]/g, '')
        .replace(/[\r\n]+/g, ' ')
        .trim();
};

const sanitizeBearerToken = (value: unknown): string => (
    trimString(value).replace(/[^\x21-\x7E]/g, '')
);

const createSafeHeaders = (value: HeadersInit | undefined): Headers => {
    const headers = new Headers();
    const setHeader = (key: unknown, headerValue: unknown) => {
        const name = trimString(key);
        const safeValue = sanitizeHeaderValue(headerValue);
        if (name && safeValue) {
            headers.set(name, safeValue);
        }
    };

    if (!value) return headers;

    try {
        new Headers(value).forEach((headerValue, key) => setHeader(key, headerValue));
        return headers;
    } catch {
        if (Array.isArray(value)) {
            value.forEach(([key, headerValue]) => setHeader(key, headerValue));
            return headers;
        }
        if (typeof Headers !== 'undefined' && value instanceof Headers) {
            value.forEach((headerValue, key) => setHeader(key, headerValue));
            return headers;
        }
        Object.entries(value as Record<string, unknown>).forEach(([key, headerValue]) => setHeader(key, headerValue));
        return headers;
    }
};

const createAuthHeaders = (token: unknown, value?: HeadersInit): Headers => {
    const headers = createSafeHeaders(value);
    const safeToken = sanitizeBearerToken(token);
    if (safeToken) {
        headers.set('Authorization', `Bearer ${safeToken}`);
    }
    return headers;
};

const normalizeWebRtcSdp = (value: unknown): string => {
    if (typeof value !== 'string') return '';
    const normalized = value
        .replace(/^\uFEFF/, '')
        .replace(/\u0000/g, '')
        .replace(/\r\n|\r|\n/g, '\r\n')
        .replace(/^(?:\r\n)+/, '')
        .replace(/(?:\r\n)+$/, '');
    return normalized ? `${normalized}\r\n` : '';
};

const normalizeCallSessionPayload = (value: unknown): CallSessionPayload | null => {
    if (!value || typeof value !== 'object') return null;
    const raw = value as { sdp_type?: unknown; sdpType?: unknown; sdp?: unknown };
    const sdpType = trimString(raw.sdp_type || raw.sdpType).toLowerCase();
    if (sdpType !== 'offer' && sdpType !== 'answer') return null;
    const sdp = normalizeWebRtcSdp(raw.sdp);
    if (!sdp) return null;
    return {
        sdp_type: sdpType,
        sdp
    };
};

const createClientTempMessageId = (): string => `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const createSendMediaPayload = (
    type: SendMediaKind,
    mediaId: string,
    mediaUrl: string,
    mediaAssetKey: string,
    mediaFilename = ''
): SendMediaPayload | null => {
    if (!mediaId && !mediaUrl && !mediaAssetKey) return null;
    return {
        type,
        ...(mediaId ? { id: mediaId } : {}),
        ...(mediaUrl ? { url: mediaUrl } : {}),
        ...(mediaAssetKey ? { assetKey: mediaAssetKey } : {}),
        ...(type === 'document' && mediaFilename ? { filename: mediaFilename } : {})
    };
};

const buildSendMediaFromComposerState = (
    mediaType: 'none' | 'image' | 'video' | 'document',
    mediaId: string,
    mediaUrl: string,
    mediaAssetKey: string,
    mediaFilename: string
): SendMediaPayload | null => {
    if (mediaType !== 'image' && mediaType !== 'video' && mediaType !== 'document') return null;
    return createSendMediaPayload(mediaType, mediaId, mediaUrl, mediaAssetKey, mediaFilename);
};

const normalizeQuickReplyMediaItemType = (
    value: unknown,
    fallback: 'image' | 'video' | 'document'
): 'image' | 'video' | 'document' => {
    const normalized = trimString(value).toLowerCase();
    if (normalized === 'image' || normalized === 'video' || normalized === 'document') return normalized;
    return fallback;
};

const buildSendMediaPayloadFromQuickReplyMediaItem = (
    mediaItem: QuickReplyMediaItem,
    fallbackType: 'image' | 'video' | 'document'
): SendMediaPayload | null => {
    const mediaType = normalizeQuickReplyMediaItemType(mediaItem?.type, fallbackType);
    const mediaUrl = trimString(mediaItem?.media_url);
    const mediaAssetKey = trimString(mediaItem?.media_asset_key);
    const mediaFilename = trimString(mediaItem?.media_filename);
    return createSendMediaPayload(mediaType, '', mediaUrl, mediaAssetKey, mediaFilename);
};

const extractMessageMediaFields = (mediaMessage: any): { mediaId: string; mediaUrl: string; mediaAssetKey: string } => ({
    mediaId: trimString(mediaMessage?.mediaId),
    mediaUrl: trimString(mediaMessage?.url),
    mediaAssetKey: trimString(mediaMessage?.assetKey)
});

const buildOutgoingMediaFromMessage = (msg: Message): SendMediaPayload | null => {
    const imageFields = extractMessageMediaFields(msg?.message?.imageMessage);
    const imagePayload = createSendMediaPayload('image', imageFields.mediaId, imageFields.mediaUrl, imageFields.mediaAssetKey);
    if (imagePayload) return imagePayload;

    const videoFields = extractMessageMediaFields(msg?.message?.videoMessage);
    const videoPayload = createSendMediaPayload('video', videoFields.mediaId, videoFields.mediaUrl, videoFields.mediaAssetKey);
    if (videoPayload) return videoPayload;

    const documentFields = extractMessageMediaFields(msg?.message?.documentMessage);
    const documentPayload = createSendMediaPayload(
        'document',
        documentFields.mediaId,
        documentFields.mediaUrl,
        documentFields.mediaAssetKey,
        trimString(msg?.message?.documentMessage?.fileName)
    );
    if (documentPayload) return documentPayload;

    return null;
};

const buildOptimisticMessageContent = (
    outgoingText: string,
    sendMedia: SendMediaPayload | null
): NonNullable<Message['message']> => {
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
};

const buildOptimisticPendingMessage = (args: {
    tempMessageId: string;
    remoteJid: string;
    outgoingText: string;
    sendMedia: SendMediaPayload | null;
    agentUserId?: string;
    agentName: string;
}): Message => ({
    key: { id: args.tempMessageId, remoteJid: args.remoteJid, fromMe: true },
    message: buildOptimisticMessageContent(args.outgoingText, args.sendMedia),
    messageTimestamp: Math.floor(Date.now() / 1000),
    status: 'pending',
    agent: {
        user_id: args.agentUserId,
        name: args.agentName,
        color: '#6b7280'
    }
});

const markMessageStatusById = (
    messages: Message[],
    messageId: string,
    status: NonNullable<Message['status']>
): Message[] => messages.map((msg) => (
    msg.key?.id === messageId
        ? { ...msg, status }
        : msg
));

const replaceTempMessageIdAndStatus = (
    messages: Message[],
    tempMessageId: string,
    realMessageId: string,
    status: NonNullable<Message['status']>
): Message[] => messages.map((msg) => (
    msg.key?.id === tempMessageId
        ? { ...msg, key: { ...msg.key, id: realMessageId }, status }
        : msg
));

const buildWorkflowBuilderWithNameMeta = (workflow: any, workflowName: string): any => {
    const builderMeta =
        workflow?.builder && typeof workflow.builder === 'object' && !Array.isArray(workflow.builder)
            ? (workflow.builder as any)
            : null;
    if (!builderMeta) return workflow?.builder || null;
    return {
        ...builderMeta,
        meta: {
            ...(builderMeta.meta && typeof builderMeta.meta === 'object' ? builderMeta.meta : {}),
            name: workflowName,
            enabled: workflow?.enabled !== false
        }
    };
};

const normalizeWorkflowForSave = (workflow: any, drafts: Record<string, string>): any => {
    const workflowName = trimString(workflow?.name);
    const builder = buildWorkflowBuilderWithNameMeta(workflow, workflowName);
    const draft = drafts[workflow.id];
    if (typeof draft !== 'string') {
        return { ...workflow, name: workflowName, builder };
    }
    try {
        return { ...workflow, name: workflowName, builder, actions: JSON.parse(draft) };
    } catch {
        throw new Error(`Invalid JSON in actions for workflow: ${workflow.id}`);
    }
};

const normalizeWorkflowsForSave = (workflows: any[], drafts: Record<string, string>): any[] => (
    workflows.map((workflow) => normalizeWorkflowForSave(workflow, drafts))
);

const ensureWorkflowDraftEntries = (
    workflows: any[],
    existingDrafts: Record<string, string>
): Record<string, string> => {
    const nextDrafts = { ...existingDrafts };
    workflows.forEach((workflow) => {
        if (typeof nextDrafts[workflow.id] === 'string') return;
        nextDrafts[workflow.id] = JSON.stringify(Array.isArray(workflow.actions) ? workflow.actions : [], null, 2);
    });
    return nextDrafts;
};

const createUniqueWorkflowId = (existingIds: Set<string>): string => {
    let nextId = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    while (existingIds.has(nextId)) {
        nextId = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    }
    return nextId;
};

const createCopiedWorkflowName = (existingNames: Set<string>, sourceName: string): string => {
    let copiedName = sourceName ? `${sourceName}-copy` : 'workflow-copy';
    let copyNameIndex = 2;
    while (existingNames.has(copiedName.toLowerCase())) {
        copiedName = sourceName ? `${sourceName}-copy-${copyNameIndex}` : `workflow-copy-${copyNameIndex}`;
        copyNameIndex += 1;
    }
    return copiedName;
};

const deepCloneJsonValue = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

const buildCopiedWorkflowRecord = (
    sourceWorkflow: any,
    copiedId: string,
    copiedName: string,
    buildBuilderFromActionsFn: typeof buildBuilderFromActions
): { copiedWorkflow: any; copiedActions: any[] } => {
    const sourceActions = Array.isArray(sourceWorkflow.actions) ? sourceWorkflow.actions : [];
    const copiedActions = deepCloneJsonValue(sourceActions);
    const copiedBuilder = sourceWorkflow?.builder && Array.isArray(sourceWorkflow.builder.nodes)
        ? deepCloneJsonValue(sourceWorkflow.builder)
        : buildBuilderFromActionsFn(copiedActions, copiedId);
    if (copiedBuilder && typeof copiedBuilder === 'object') {
        copiedBuilder.id = copiedId;
    }
    const sourceTrigger = trimString(sourceWorkflow?.trigger_keyword);
    return {
        copiedWorkflow: {
            ...sourceWorkflow,
            id: copiedId,
            name: copiedName,
            trigger_keyword: sourceTrigger,
            run_on_new_chat: false,
            enabled: false,
            actions: copiedActions,
            builder: copiedBuilder
        },
        copiedActions
    };
};

const extractCallPermissionSummary = (payload: any): CallPermissionUiState => {
    const permissionStatus = String(payload?.data?.permission?.status || '').toLowerCase();
    const expirationTime = typeof payload?.data?.permission?.expiration_time === 'string'
        ? payload.data.permission.expiration_time
        : null;
    const actions = Array.isArray(payload?.data?.actions) ? payload.data.actions : [];
    const startAction = actions.find((entry: any) => String(entry?.action_name || '').toLowerCase() === 'start_call');
    const requestAction = actions.find((entry: any) => String(entry?.action_name || '').toLowerCase() === 'send_call_permission_request');
    return {
        permissionStatus,
        canStartCall: startAction?.can_perform_action === true,
        canRequestPermission: requestAction?.can_perform_action === true,
        expirationTime,
        storedPermissionStatus: typeof payload?.stored_permission?.permission_status === 'string'
            ? payload.stored_permission.permission_status.toLowerCase()
            : null,
        storedUpdatedAt: typeof payload?.stored_permission?.updated_at === 'string'
            ? payload.stored_permission.updated_at
            : null
    };
};

const getCallPermissionFeedback = (
    kind: 'voice' | 'video',
    permissionStatus: string,
    canStartCall: boolean,
    canRequestPermission: boolean,
    userWaId: string
): { message: string; tone: 'success' | 'error'; logMessage?: string } => {
    const callTypeLabel = kind === 'video' ? 'Video call' : 'Voice call';
    if ((permissionStatus === 'granted' || permissionStatus === 'temporary' || permissionStatus === 'permanent') && canStartCall) {
        return {
            message: `${callTypeLabel} is permitted. Live call pickup is not configured yet.`,
            tone: 'success',
            logMessage: `[Calls] ${callTypeLabel} permitted for ${userWaId}.`
        };
    }
    if (permissionStatus === 'pending') {
        return { message: 'Call permission is pending approval from this user.', tone: 'error' };
    }
    if (permissionStatus === 'denied' || permissionStatus === 'rejected') {
        return { message: 'Call permission was denied by this user.', tone: 'error' };
    }
    if (permissionStatus === 'expired') {
        return { message: 'Call permission has expired. Request permission again.', tone: 'error' };
    }
    if (canRequestPermission) {
        return { message: 'This contact can be sent a call permission request from the chat header.', tone: 'error' };
    }
    return { message: 'Call permission is not available for this contact.', tone: 'error' };
};

const getCallPermissionBadgeLabel = (state: CallPermissionUiState | null): string => {
    if (!state) return 'Call: unavailable';
    if ((state.permissionStatus === 'temporary' || state.permissionStatus === 'permanent' || state.permissionStatus === 'granted') && state.canStartCall) {
        return state.permissionStatus === 'permanent' ? 'Call: permanent' : 'Call: approved';
    }
    if (state.permissionStatus === 'pending') return 'Call: pending';
    if (state.permissionStatus === 'expired') return 'Call: expired';
    if (state.permissionStatus === 'rejected' || state.permissionStatus === 'denied') return 'Call: rejected';
    if (state.canRequestPermission) return 'Call: request needed';
    return 'Call: unavailable';
};

const getVoiceCallStatusLabel = (status: ActiveVoiceCallState['status']): string => {
    switch (status) {
        case 'preparing':
            return 'Preparing audio';
        case 'connecting':
            return 'Connecting';
        case 'connected':
            return 'Live';
        case 'ending':
            return 'Ending';
        case 'failed':
            return 'Failed';
        default:
            return status;
    }
};

type CallApiErrorResult = {
    code: string | null;
    message: string;
    details: any;
};

const getIncomingCallStatusLabel = (status: string): string => {
    switch (status.trim().toLowerCase()) {
        case 'ringing':
            return 'Ringing';
        case 'accepting':
            return 'Answering';
        case 'accepted':
            return 'Accepted';
        case 'answered':
            return 'Answered';
        case 'rejected':
            return 'Rejected';
        case 'terminated':
            return 'Ended';
        case 'missed':
            return 'Missed';
        case 'failed':
            return 'Failed';
        default:
            return status || 'Unknown';
    }
};

const parseCallApiError = (payload: any, responseStatus: number, fallbackMessage: string): CallApiErrorResult => {
    const nestedError = payload?.error && typeof payload.error === 'object' ? payload.error : null;
    const code = typeof nestedError?.code === 'string'
        ? nestedError.code.trim()
        : (typeof payload?.code === 'string' ? payload.code.trim() : '');
    const message =
        (typeof nestedError?.message === 'string' ? nestedError.message.trim() : '')
        || (typeof payload?.error === 'string' ? payload.error.trim() : '')
        || (typeof payload?.message === 'string' ? payload.message.trim() : '')
        || fallbackMessage
        || `Failed with status ${responseStatus}`;
    const details = nestedError?.details ?? payload?.details ?? null;
    return {
        code: code || null,
        message,
        details
    };
};

const formatCallApiErrorMessage = (error: CallApiErrorResult): string => {
    if (error.code === 'CALL_ALREADY_ANSWERED') {
        const answeredBy = typeof error.details?.answered_by === 'string' ? error.details.answered_by.trim() : '';
        return answeredBy
            ? `Someone already answered this call. ${answeredBy} is handling it.`
            : 'Someone already answered this call.';
    }
    if (error.code === 'CALL_MEDIA_BACKEND_NOT_CONFIGURED') {
        return 'Call media backend is not configured yet. Check the WebRTC calling setup before answering.';
    }
    if (error.code === 'CALL_ACCEPT_LOCK_REQUIRED') {
        return 'This call answer session expired. Please try answering again.';
    }
    return error.message;
};

const formatMicrophoneCallErrorMessage = (error: any): string | null => {
    const errorName = typeof error?.name === 'string' ? error.name.trim() : '';
    if (errorName === 'NotAllowedError' || errorName === 'SecurityError') {
        return 'Microphone access is blocked. Allow mic permission for this site, then try again.';
    }
    if (errorName === 'NotFoundError') {
        return 'No microphone was found for this browser. Connect a mic and try again.';
    }
    if (errorName === 'NotReadableError' || errorName === 'AbortError') {
        return 'The microphone is busy or unavailable. Close other apps using the mic and try again.';
    }
    return null;
};

const isIncomingCallClaimed = (call: IncomingCallState): boolean => (
    ['accepting', 'accepted', 'answered'].includes(call.normalizedStatus.trim().toLowerCase())
);

const isCallingApiNotEnabledError = (errorMessage: string): boolean => (
    errorMessage.includes('calling api not enabled') || errorMessage.includes('code=138000')
);

const emitSocketWithTimeout = async (
    socket: Socket,
    eventName: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
    timeoutError: string
): Promise<any> => new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
        resolve({ success: false, error: timeoutError });
    }, timeoutMs);
    socket.emit(eventName, payload, (ack: any) => {
        window.clearTimeout(timeout);
        resolve(ack);
    });
});

const applyAssignedContactUpdate = (
    previousContacts: Record<string, ContactMeta>,
    targetJid: string,
    contact: any
): Record<string, ContactMeta> => {
    const next = { ...previousContacts };
    const aliasKeys = Array.from(new Set([
        ...buildContactJidVariants(targetJid),
        ...buildContactJidVariants(contact?.id)
    ]));
    const canonicalKey = canonicalContactJid(contact?.id || targetJid) || contact?.id || targetJid;
    const prevMeta = pickContactMetaByJid(next, canonicalKey) || {};
    const incomingAlias = normalizeContactNameValue(contact?.alias);
    const nextAlias = contact?.alias === undefined
        ? ((prevMeta as any).alias ?? null)
        : (incomingAlias || null);
    const incomingWhatsappName = normalizeContactNameValue(contact?.whatsappName);
    const nextWhatsappName = contact?.whatsappName === undefined
        ? ((prevMeta as any).whatsappName ?? null)
        : (incomingWhatsappName || null);
    const legacyIncomingName = normalizeContactNameValue(contact?.name);
    const nextDisplayName = resolveContactDisplayName(
        nextAlias,
        nextWhatsappName,
        legacyIncomingName || (prevMeta as any).name,
        canonicalKey
    );
    aliasKeys.forEach((key) => {
        if (key !== canonicalKey) delete next[key];
    });
    next[canonicalKey] = {
        ...prevMeta,
        name: nextDisplayName,
        alias: nextAlias,
        whatsappName: nextWhatsappName,
        lastInboundAt: contact?.lastInboundAt ?? prevMeta.lastInboundAt ?? null,
        tags: Array.isArray(contact?.tags) ? contact.tags : (prevMeta.tags || []),
        assigneeUserId: contact?.assigneeUserId ?? null,
        assigneeName: contact?.assigneeName ?? null,
        assigneeColor: contact?.assigneeColor ?? null,
        ctaReferralAt: contact?.ctaReferralAt ?? prevMeta.ctaReferralAt ?? null,
        ctaFreeWindowStartedAt: contact?.ctaFreeWindowStartedAt ?? prevMeta.ctaFreeWindowStartedAt ?? null,
        ctaFreeWindowExpiresAt: contact?.ctaFreeWindowExpiresAt ?? prevMeta.ctaFreeWindowExpiresAt ?? null
    };
    return next;
};

const parseTemplateComponentsInput = (templateComponents: string): { components?: any[]; error: string | null } => {
    const raw = templateComponents.trim();
    if (!raw) return { components: undefined, error: null };
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return { components: undefined, error: 'Template components must be a JSON array.' };
        }
        return { components: parsed, error: null };
    } catch {
        return { components: undefined, error: 'Invalid JSON in template components.' };
    }
};

const extractTemplateBodyParameterValues = (components: any[] | undefined): string[] => {
    if (!Array.isArray(components)) return [];
    const bodyComponent = components.find((component: any) => {
        const type = typeof component?.type === 'string' ? component.type.trim().toLowerCase() : '';
        return type === 'body';
    });
    const parameters = Array.isArray(bodyComponent?.parameters) ? bodyComponent.parameters : [];
    return parameters
        .map((param: any) => {
            if (typeof param?.text === 'string') return param.text.trim();
            return '';
        })
        .filter(Boolean);
};

const renderTemplatePreviewText = (templateText: unknown, bodyValues: string[]): string => {
    const baseText = typeof templateText === 'string' ? templateText.trim() : '';
    const normalizedValues = bodyValues
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean);

    if (baseText) {
        let rendered = baseText;
        normalizedValues.forEach((value, index) => {
            const placeholderPattern = new RegExp(`{{\\s*${index + 1}\\s*}}`, 'g');
            rendered = rendered.replace(placeholderPattern, value);
        });
        return rendered.trim();
    }

    return normalizedValues.join(' ').trim();
};

const buildTemplateHeaderComponent = (args: {
    selectedTemplateHeaderFormat: string;
    requiredTemplateHeaderAttributeCount: number;
    templateHeaderAttributes: string[];
    templateHeaderMediaUrl: string;
    templateHeaderDocumentFilename: string;
}): { component?: any; error: string | null } => {
    const {
        selectedTemplateHeaderFormat,
        requiredTemplateHeaderAttributeCount,
        templateHeaderAttributes,
        templateHeaderMediaUrl,
        templateHeaderDocumentFilename
    } = args;
    const headerType = selectedTemplateHeaderFormat;
    const mediaLink = templateHeaderMediaUrl.trim();
    if (requiredTemplateHeaderAttributeCount > 0) {
        const missingHeaderParamIndex = templateHeaderAttributes.findIndex((value) => !value.trim());
        if (missingHeaderParamIndex >= 0) {
            return { error: `Header attribute {{${missingHeaderParamIndex + 1}}} is required.` };
        }
        return {
            component: {
                type: 'header',
                parameters: templateHeaderAttributes.map((value) => ({
                    type: 'text',
                    text: value.trim()
                }))
            },
            error: null
        };
    }
    if (headerType !== 'IMAGE' && headerType !== 'VIDEO' && headerType !== 'DOCUMENT') {
        return { component: undefined, error: null };
    }
    if (!mediaLink) {
        return { error: `Template header requires ${headerType.toLowerCase()} link.` };
    }
    if (headerType === 'DOCUMENT') {
        return {
            component: {
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
            },
            error: null
        };
    }
    if (headerType === 'IMAGE') {
        return {
            component: {
                type: 'header',
                parameters: [{ type: 'image', image: { link: mediaLink } }]
            },
            error: null
        };
    }
    return {
        component: {
            type: 'header',
            parameters: [{ type: 'video', video: { link: mediaLink } }]
        },
        error: null
    };
};

const buildTemplateBodyComponent = (args: {
    requiredTemplateBodyAttributeCount: number;
    templateBodyAttributes: string[];
    templateBodyAttributeNames: string[];
    selectedTemplateBodyText: unknown;
}): { component?: any; bodyAttributes: TemplateBodyAttributePayload[]; error: string | null } => {
    const {
        requiredTemplateBodyAttributeCount,
        templateBodyAttributes,
        templateBodyAttributeNames,
        selectedTemplateBodyText
    } = args;
    if (requiredTemplateBodyAttributeCount <= 0) {
        return { component: undefined, bodyAttributes: [], error: null };
    }
    const missingBodyParamIndex = templateBodyAttributes.findIndex((value) => !value.trim());
    if (missingBodyParamIndex >= 0) {
        return { component: undefined, bodyAttributes: [], error: `Body attribute {{${missingBodyParamIndex + 1}}} is required.` };
    }
    const missingBodyAttributeNameIndex = templateBodyAttributeNames.findIndex((value) => !value.trim());
    if (missingBodyAttributeNameIndex >= 0) {
        return {
            component: undefined,
            bodyAttributes: [],
            error: `Body attribute label for {{${missingBodyAttributeNameIndex + 1}}} is required.`
        };
    }
    return {
        component: {
            type: 'body',
            parameters: templateBodyAttributes.map((value) => ({
                type: 'text',
                text: value.trim()
            }))
        },
        bodyAttributes: templateBodyAttributes.map((value, index) => ({
            scope: 'body' as const,
            index: index + 1,
            key: (
                templateBodyAttributeNames[index]
                || inferTemplateVariableLabel(selectedTemplateBodyText, index + 1, 'body')
            ).trim(),
            value: value.trim()
        })),
        error: null
    };
};

const buildTemplateFromSelection = (args: {
    selectedTemplateHeaderFormat: string;
    requiredTemplateHeaderAttributeCount: number;
    templateHeaderAttributes: string[];
    templateHeaderMediaUrl: string;
    templateHeaderDocumentFilename: string;
    requiredTemplateBodyAttributeCount: number;
    templateBodyAttributes: string[];
    templateBodyAttributeNames: string[];
    selectedTemplateBodyText: unknown;
}): TemplateBuildResult => {
    const built: any[] = [];
    const headerResult = buildTemplateHeaderComponent({
        selectedTemplateHeaderFormat: args.selectedTemplateHeaderFormat,
        requiredTemplateHeaderAttributeCount: args.requiredTemplateHeaderAttributeCount,
        templateHeaderAttributes: args.templateHeaderAttributes,
        templateHeaderMediaUrl: args.templateHeaderMediaUrl,
        templateHeaderDocumentFilename: args.templateHeaderDocumentFilename
    });
    if (headerResult.error) {
        return { components: undefined, bodyAttributes: [], error: headerResult.error };
    }
    if (headerResult.component) {
        built.push(headerResult.component);
    }

    const bodyResult = buildTemplateBodyComponent({
        requiredTemplateBodyAttributeCount: args.requiredTemplateBodyAttributeCount,
        templateBodyAttributes: args.templateBodyAttributes,
        templateBodyAttributeNames: args.templateBodyAttributeNames,
        selectedTemplateBodyText: args.selectedTemplateBodyText
    });
    if (bodyResult.error) {
        return { components: undefined, bodyAttributes: [], error: bodyResult.error };
    }
    if (bodyResult.component) {
        built.push(bodyResult.component);
    }
    return {
        components: built.length > 0 ? built : undefined,
        bodyAttributes: bodyResult.bodyAttributes,
        error: null
    };
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
    const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
    const [chatOpenNonce, setChatOpenNonce] = useState(0);
    const [messageText, setMessageText] = useState('');
    const [composerMediaType, setComposerMediaType] = useState<'none' | 'image' | 'video' | 'document'>('none');
    const [composerMediaUrl, setComposerMediaUrl] = useState('');
    const [composerMediaId, setComposerMediaId] = useState('');
    const [composerMediaAssetKey, setComposerMediaAssetKey] = useState('');
    const [composerMediaMimeType, setComposerMediaMimeType] = useState('');
    const [composerMediaSizeBytes, setComposerMediaSizeBytes] = useState<number | null>(null);
    const [composerMediaFilename, setComposerMediaFilename] = useState('');
    const [composerQueuedMedia, setComposerQueuedMedia] = useState<SendMediaPayload[]>([]);
    const [composerMediaUploading, setComposerMediaUploading] = useState(false);
    const [composerDragActive, setComposerDragActive] = useState(false);
    const [composerMediaError, setComposerMediaError] = useState<string | null>(null);
    const [showMediaComposer, setShowMediaComposer] = useState(false);
    const [showMobileComposerMenu, setShowMobileComposerMenu] = useState(false);
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
    const [mobileChatQuickFilter, setMobileChatQuickFilter] = useState<'all' | 'unread'>('all');
    const [mobileTagFilter, setMobileTagFilter] = useState('');
    const [contactsSearchQuery, setContactsSearchQuery] = useState('');
    const [teamUsers, setTeamUsers] = useState<TeamUserLite[]>([]);
    const [teamUsersLoading, setTeamUsersLoading] = useState(false);
    const [workflowTemplateOptions, setWorkflowTemplateOptions] = useState<WorkflowTemplateOption[]>([]);
    const [assignMenuContactId, setAssignMenuContactId] = useState<string | null>(null);
    const [assigningContactId, setAssigningContactId] = useState<string | null>(null);
    const [humanTakeoverSaving, setHumanTakeoverSaving] = useState(false);
    const [callActionLoading, setCallActionLoading] = useState<'voice' | 'video' | null>(null);
    const [selectedCallPermission, setSelectedCallPermission] = useState<CallPermissionUiState | null>(null);
    const [callPermissionLoading, setCallPermissionLoading] = useState(false);
    const [callPermissionRequestLoading, setCallPermissionRequestLoading] = useState(false);
    const [incomingCalls, setIncomingCalls] = useState<IncomingCallState[]>([]);
    const [activeVoiceCall, setActiveVoiceCall] = useState<ActiveVoiceCallState | null>(null);
    const [mediaCache, setMediaCache] = useState<Record<string, MediaData>>({});
    const [mediaDownloadProgress, setMediaDownloadProgress] = useState<Record<string, MediaDownloadProgressState>>({});
    const [unreadMessagesByChat, setUnreadMessagesByChat] = useState<Record<string, number>>({});
    const [chatReadCursorByChat, setChatReadCursorByChat] = useState<Record<string, number>>({});
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
    const [isMobile, setIsMobile] = useState(() => {
        if (typeof window === 'undefined') return false;
        return window.innerWidth < MOBILE_LAYOUT_BREAKPOINT;
    });
    const [debugPanelOpen, setDebugPanelOpen] = useState(false);
    const [debugPanelVersion, setDebugPanelVersion] = useState(0);
    const [notificationPermissionState, setNotificationPermissionState] = useState<NotificationPermission | 'unsupported'>(
        () => getNotificationPermissionState()
    );
    const [notificationSoundEnabled, setNotificationSoundEnabled] = useState<boolean>(
        () => readNotificationSoundPreference()
    );
    const [sendingTestNotification, setSendingTestNotification] = useState(false);
    const [pwaUpdateRegistration, setPwaUpdateRegistration] = useState<ServiceWorkerRegistration | null>(null);
    const [showPwaUpdateBanner, setShowPwaUpdateBanner] = useState(false);
    const [nativePushTokenState, setNativePushTokenState] = useState<{
        token: string;
        platform: 'android' | 'ios' | '';
    }>({
        token: '',
        platform: ''
    });
    const [showWabaConnectedSuccess, setShowWabaConnectedSuccess] = useState(false);
    const [wabaConnectedSummary, setWabaConnectedSummary] = useState<WabaConnectedSummary | null>(null);

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
            const stored = window.localStorage.getItem('lastActiveProfileId');
            const normalized = trimString(stored);
            if (!normalized) return null;
            if (normalized === 'null' || normalized === 'undefined') return null;
            return normalized;
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
    const activeVoiceCallRef = useRef<ActiveVoiceCallState | null>(null);
    const browserVoiceCallSessionRef = useRef<BrowserVoiceCallSession | null>(null);
    const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
    const profilesRef = useRef<any[]>([]);
    const selectedChatIdRef = useRef<string | null>(null);
    const chatReadCursorByChatRef = useRef<Record<string, number>>({});
    const mobileSwipeStartRef = useRef<{ x: number; y: number; at: number } | null>(null);
    const contactsRef = useRef<Record<string, ContactMeta>>({});
    const lastRecoverAtRef = useRef(0);
    const lastInboundRef = useRef<number | null>(null);
    const lastRealtimeEventAtRef = useRef(Date.now());
    const lastRefreshRequestEmitAtRef = useRef(0);
    const latestMessageTimestampRef = useRef(0);
    const requestedMediaRef = useRef<Set<string>>(new Set());
    const seenIncomingMessageKeysRef = useRef<Set<string>>(new Set());
    const notifiedIncomingMessageKeysRef = useRef<Set<string>>(new Set());
    const mediaDownloadProgressRef = useRef<Record<string, MediaDownloadProgressState>>({});
    const mediaProgressTimerRef = useRef<Record<string, number>>({});
    const mediaProgressTimeoutRef = useRef<Record<string, number>>({});
    const socketInstanceRef = useRef<Socket | null>(null);
    const socketAccessTokenRef = useRef('');
    const refreshSessionPromiseRef = useRef<Promise<string | null> | null>(null);
    const refreshAccessTokenRef = useRef<(() => Promise<string | null>) | null>(null);
    const authRecoveryInFlightRef = useRef(false);
    const lastTestNotificationTriggerAtRef = useRef(0);
    const notificationAudioContextRef = useRef<AudioContext | null>(null);
    const notificationSoundEnabledRef = useRef(notificationSoundEnabled);
    const pushSubscriptionEndpointRef = useRef('');
    const pushSubscriptionUserIdRef = useRef<string | null>(null);
    const pushSubscriptionSyncingRef = useRef(false);
    const nativePushSyncedTokenRef = useRef('');
    const nativePushSyncedPlatformRef = useRef<'android' | 'ios' | ''>('');
    const nativePushSyncedUserIdRef = useRef<string | null>(null);
    const nativePushTokenSyncingRef = useRef(false);
    const hiddenSocketDisconnectTimerRef = useRef<number | null>(null);
    const pwaUpdateReloadTimerRef = useRef<number | null>(null);
    const pwaUpdateReloadingRef = useRef(false);
    const lastUiControlsRefreshAtRef = useRef(0);
    const debugSocketEventCountersRef = useRef<Record<string, number>>({});
    const debugLastSocketEventRef = useRef<DebugSocketEventRecord | null>(null);
    const lastSwitchProfileEmitRef = useRef<{ socket: Socket | null; profileId: string | null }>({
        socket: null,
        profileId: null
    });
    const chatListFlickerStatsRef = useRef<ChatListFlickerStats>({
        changes: 0,
        rapidChanges: 0,
        lastSignature: '',
        lastChangedAt: 0
    });
    const { ref: chatListViewportRef, size: chatListViewport } = useElementSize<HTMLDivElement>();
    const { ref: messageViewportRef, size: messageViewport } = useElementSize<HTMLDivElement>();
    const messageListRef = useListRef(null);
    const messageRowHeight = useDynamicRowHeight({
        defaultRowHeight: 120,
        key: selectedChatId || 'all'
    });
    const debugOverlayEnabled = useMemo(() => shouldShowDebugOverlay(), []);
    const webrtcIceServers = useMemo(() => parseWebrtcIceServers(), []);
    const wabaConnectedConfettiPieces = useMemo<WabaConnectedConfettiPiece[]>(
        () => Array.from({ length: 42 }, (_unused, index) => {
            const seed = index + 1;
            const left = ((seed * 17.7) % 100);
            const hue = Math.round((seed * 52.3) % 360);
            const delay = Number(((seed % 8) * 0.16).toFixed(2));
            const duration = Number((3.6 + ((seed * 7) % 9) * 0.38).toFixed(2));
            const size = 7 + (seed % 6) * 2;
            const opacity = Number((0.48 + (seed % 5) * 0.09).toFixed(2));
            return { id: seed, left, hue, delay, duration, size, opacity };
        }),
        []
    );

    const attachRemoteAudioStream = useCallback((stream: MediaStream | null) => {
        const element = remoteAudioRef.current;
        if (!element) return;
        const nextStream = stream || null;
        if ((element.srcObject || null) !== nextStream) {
            element.srcObject = nextStream;
        }
        if (nextStream) {
            void element.play().catch(() => undefined);
        }
    }, []);

    const destroyBrowserVoiceCallSession = useCallback((options?: {
        preserveUiState?: boolean;
        nextUiState?: Partial<ActiveVoiceCallState> | null;
    }) => {
        const session = browserVoiceCallSessionRef.current;
        browserVoiceCallSessionRef.current = null;

        if (session) {
            if (session.disconnectTimeoutId !== null) {
                window.clearTimeout(session.disconnectTimeoutId);
                session.disconnectTimeoutId = null;
            }
            try {
                session.peerConnection.ontrack = null;
                session.peerConnection.onconnectionstatechange = null;
                session.peerConnection.oniceconnectionstatechange = null;
                session.peerConnection.onicegatheringstatechange = null;
                session.peerConnection.close();
            } catch {
                // ignore peer connection cleanup failures
            }
            session.localStream.getTracks().forEach((track) => {
                try {
                    track.stop();
                } catch {
                    // ignore track cleanup failures
                }
            });
            session.remoteStream.getTracks().forEach((track) => {
                try {
                    track.stop();
                } catch {
                    // ignore track cleanup failures
                }
            });
        }

        attachRemoteAudioStream(null);
        if (!options?.preserveUiState) {
            setActiveVoiceCall(options?.nextUiState ? ((current) => current ? { ...current, ...options.nextUiState } : null) : null);
        }
    }, [attachRemoteAudioStream]);

    const waitForIceGatheringComplete = useCallback(async (peerConnection: RTCPeerConnection, timeoutMs = 4_000) => {
        if (peerConnection.iceGatheringState === 'complete') return;
        await new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                peerConnection.removeEventListener('icegatheringstatechange', onStateChange);
                window.clearTimeout(timeoutId);
                resolve();
            };
            const onStateChange = () => {
                if (peerConnection.iceGatheringState === 'complete') {
                    finish();
                }
            };
            const timeoutId = window.setTimeout(finish, timeoutMs);
            peerConnection.addEventListener('icegatheringstatechange', onStateChange);
        });
    }, []);

    const createBrowserVoiceCallSession = useCallback(async (params: {
        direction: 'inbound' | 'outbound';
        profileId: string;
        customerWaId: string | null;
        remoteLabel: string;
        callId?: string | null;
    }) => {
        if (!window.RTCPeerConnection) {
            throw new Error('WebRTC is not supported in this browser.')
        }
        if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error('Microphone access is not available in this browser.')
        }
        if (browserVoiceCallSessionRef.current) {
            throw new Error('Finish the current call before starting a new one.')
        }

        const localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true
            },
            video: false
        });
        const remoteStream = new MediaStream();
        const peerConnection = new RTCPeerConnection({ iceServers: webrtcIceServers });
        const session: BrowserVoiceCallSession = {
            peerConnection,
            localStream,
            remoteStream,
            callId: params.callId || null,
            customerWaId: params.customerWaId,
            direction: params.direction,
            profileId: params.profileId,
            remoteLabel: params.remoteLabel,
            remoteDescriptionApplied: false,
            preAcceptSent: false,
            acceptSent: false,
            acceptLockToken: null,
            disconnectTimeoutId: null
        };
        localStream.getTracks().forEach((track) => {
            peerConnection.addTrack(track, localStream);
        });
        peerConnection.ontrack = (event) => {
            event.streams.forEach((stream) => {
                stream.getTracks().forEach((track) => {
                    if (!remoteStream.getTracks().some((existing) => existing.id === track.id)) {
                        remoteStream.addTrack(track);
                    }
                });
            });
            attachRemoteAudioStream(remoteStream);
            setActiveVoiceCall((current) => current ? { ...current, status: 'connected' } : current);
        };
        peerConnection.onconnectionstatechange = () => {
            const state = peerConnection.connectionState;
            if (state === 'connected') {
                if (session.disconnectTimeoutId !== null) {
                    window.clearTimeout(session.disconnectTimeoutId);
                    session.disconnectTimeoutId = null;
                }
                setActiveVoiceCall((current) => current ? { ...current, status: 'connected' } : current);
                return;
            }
            if (state === 'connecting' || state === 'new') {
                if (session.disconnectTimeoutId !== null) {
                    window.clearTimeout(session.disconnectTimeoutId);
                    session.disconnectTimeoutId = null;
                }
                return;
            }
            if (state === 'disconnected') {
                if (session.disconnectTimeoutId !== null) {
                    return;
                }
                session.disconnectTimeoutId = window.setTimeout(() => {
                    session.disconnectTimeoutId = null;
                    if (browserVoiceCallSessionRef.current !== session) {
                        return;
                    }
                    if (session.peerConnection.connectionState === 'connected' || session.peerConnection.connectionState === 'connecting') {
                        return;
                    }
                    destroyBrowserVoiceCallSession();
                }, BROWSER_VOICE_CALL_DISCONNECT_GRACE_MS);
                return;
            }
            if (state === 'failed' || state === 'closed') {
                destroyBrowserVoiceCallSession();
            }
        };
        browserVoiceCallSessionRef.current = session;
        setActiveVoiceCall({
            callId: session.callId,
            customerWaId: session.customerWaId,
            remoteLabel: params.remoteLabel,
            direction: params.direction,
            status: 'preparing',
            muted: false,
            startedAt: Date.now(),
            profileId: params.profileId,
            lastError: null
        });
        return session;
    }, [attachRemoteAudioStream, destroyBrowserVoiceCallSession, webrtcIceServers]);

    const bumpDebugSocketEvent = useCallback((name: string, detail = '') => {
        if (!debugOverlayEnabled) return;
        const nextCount = (debugSocketEventCountersRef.current[name] || 0) + 1;
        debugSocketEventCountersRef.current[name] = nextCount;
        debugLastSocketEventRef.current = {
            name,
            at: Date.now(),
            detail: detail ? detail.slice(0, 180) : ''
        };
        if (debugPanelOpen) {
            setDebugPanelVersion((prev) => prev + 1);
        }
    }, [debugOverlayEnabled, debugPanelOpen]);

    useEffect(() => {
        mediaDownloadProgressRef.current = mediaDownloadProgress;
    }, [mediaDownloadProgress]);

    const isSuperAdmin = useMemo(() => {
        const userMeta: any = (session?.user?.user_metadata as any) || {};
        const appMeta: any = (session?.user?.app_metadata as any) || {};
        const roleCandidates = [
            userMeta.role,
            appMeta.role
        ];
        const flagCandidates = [
            userMeta.super_admin,
            userMeta.is_super_admin,
            appMeta.super_admin,
            appMeta.is_super_admin
        ];
        const hasSuperRole = roleCandidates.some((value) => {
            if (typeof value === 'string') {
                const normalized = value.trim().toLowerCase();
                return normalized === 'super_admin' || normalized === 'superadmin' || normalized === 'super-admin';
            }
            return false;
        });
        if (hasSuperRole) return true;
        return flagCandidates.some((value) => {
            if (value === true) return true;
            if (typeof value === 'string') {
                const normalized = value.trim().toLowerCase();
                return normalized === 'true' || normalized === '1' || normalized === 'yes';
            }
            return false;
        });
    }, [session?.user?.app_metadata, session?.user?.user_metadata]);

    const settingsNav = [
        {
            group: 'Onboarding',
            items: [
                { id: 'settings-connect', label: 'Connect WhatsApp' }
            ]
        },
        {
            group: 'Preferences',
            items: [
                { id: 'settings-notifications', label: 'Notifications' },
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
                { id: 'settings-promo-push', label: 'Promo Push' },
                ...(isSuperAdmin ? [
                    { id: 'settings-system-runtime', label: 'System Runtime' },
                    { id: 'settings-connected-clients', label: 'Connected Clients' },
                    { id: 'settings-connected-businesses', label: 'Connected Businesses' }
                ] : [])
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

    const handleContinueAfterWabaConnected = useCallback(() => {
        setShowWabaConnectedSuccess(false);
        setWabaConnectedSummary(null);
    }, []);

    const handleOpenWabaConnectedSettings = useCallback(() => {
        setShowWabaConnectedSuccess(false);
        setWabaConnectedSummary(null);
        openSettingsSection('settings-connect');
    }, [openSettingsSection]);

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
                headers: createAuthHeaders(session.access_token, {
                    'Content-Type': 'application/json'
                }),
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
            tone,
            variant: 'default'
        });
    }, []);

    const showChatToast = useCallback((title: string, message: string) => {
        const safeTitle = title.trim() || 'New message';
        const safeMessage = message.trim() || 'New message';
        setAppToast({
            id: Date.now(),
            title: safeTitle,
            message: safeMessage,
            tone: 'success',
            variant: 'chat',
            avatarLabel: getInitials(safeTitle)
        });
    }, []);

    const playNotificationGlassSound = useCallback(async (force = false): Promise<boolean> => {
        if (!force && !notificationSoundEnabledRef.current) return false;
        if (typeof window === 'undefined') return false;

        const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
        if (!AudioContextCtor) return false;

        const ctx: AudioContext = notificationAudioContextRef.current || new AudioContextCtor();
        notificationAudioContextRef.current = ctx;

        if (ctx.state === 'suspended') {
            try {
                await ctx.resume();
            } catch {
                return false;
            }
        }

        if (ctx.state !== 'running') return false;

        const startAt = ctx.currentTime + 0.01;
        const master = ctx.createGain();
        master.gain.setValueAtTime(0.0001, startAt);
        master.connect(ctx.destination);

        const tones = [
            { frequency: 1318.51, at: 0.0, gain: 0.18, decay: 0.28 },
            { frequency: 1760.0, at: 0.045, gain: 0.14, decay: 0.26 },
            { frequency: 2349.32, at: 0.09, gain: 0.11, decay: 0.22 }
        ];

        tones.forEach((tone) => {
            const baseOsc = ctx.createOscillator();
            baseOsc.type = 'triangle';
            baseOsc.frequency.setValueAtTime(tone.frequency, startAt + tone.at);

            const sparkleOsc = ctx.createOscillator();
            sparkleOsc.type = 'sine';
            sparkleOsc.frequency.setValueAtTime(tone.frequency * 2, startAt + tone.at);

            const highpass = ctx.createBiquadFilter();
            highpass.type = 'highpass';
            highpass.frequency.setValueAtTime(780, startAt);

            const baseGain = ctx.createGain();
            baseGain.gain.setValueAtTime(0.0001, startAt + tone.at);
            baseGain.gain.exponentialRampToValueAtTime(tone.gain, startAt + tone.at + 0.016);
            baseGain.gain.exponentialRampToValueAtTime(0.0001, startAt + tone.at + tone.decay);

            const sparkleGain = ctx.createGain();
            sparkleGain.gain.setValueAtTime(0.0001, startAt + tone.at);
            sparkleGain.gain.exponentialRampToValueAtTime(tone.gain * 0.35, startAt + tone.at + 0.012);
            sparkleGain.gain.exponentialRampToValueAtTime(0.0001, startAt + tone.at + tone.decay);

            baseOsc.connect(baseGain);
            sparkleOsc.connect(sparkleGain);
            baseGain.connect(highpass);
            sparkleGain.connect(highpass);
            highpass.connect(master);

            baseOsc.start(startAt + tone.at);
            sparkleOsc.start(startAt + tone.at);
            baseOsc.stop(startAt + tone.at + tone.decay + 0.05);
            sparkleOsc.stop(startAt + tone.at + tone.decay + 0.05);
        });

        master.gain.exponentialRampToValueAtTime(0.65, startAt + 0.03);
        master.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.72);

        return true;
    }, []);

    useEffect(() => {
        if (!session?.access_token) return;
        void initializeNativePushBridge();
    }, [session?.access_token]);

    useEffect(() => {
        const handleNativePushToken = (event: Event) => {
            const detail = (event as CustomEvent<NativePushTokenEventDetail>).detail;
            const token = typeof detail?.value === 'string' ? detail.value.trim() : '';
            const platform = detail?.platform === 'android' || detail?.platform === 'ios'
                ? detail.platform
                : '';
            if (!token) return;
            setNativePushTokenState((prev) => (
                prev.token === token && prev.platform === platform
                    ? prev
                    : { token, platform }
            ));
            pushLog(
                `[Native Push] Device token ready (${token.slice(0, 10)}...)${platform ? ` [${platform}]` : ''}.`,
                'info'
            );
        };

        window.addEventListener(NATIVE_PUSH_TOKEN_EVENT, handleNativePushToken as EventListener);
        return () => {
            window.removeEventListener(NATIVE_PUSH_TOKEN_EVENT, handleNativePushToken as EventListener);
        };
    }, [pushLog]);
    useEffect(() => {
        const handleNativePushChannelStatus = (event: Event) => {
            if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return;

            const detail = (event as CustomEvent<NativePushChannelStatusEventDetail>).detail;
            pushLog(
                `[Native Push] Channel ${detail?.id || 'unknown'} status: headsUp=${detail?.headsUpEnabled ? 'on' : 'off'} importance=${typeof detail?.importance === 'number' ? detail.importance : 'n/a'}.`,
                detail?.headsUpEnabled ? 'info' : 'error'
            );
            if (detail?.headsUpEnabled) return;
            if (!shouldPromptAndroidHeadsUpEnable()) return;

            markAndroidHeadsUpPrompted();
            showToast('Heads-up notifications are OFF. Enable Pop on screen for Chat Messages.', 'error');

            const importanceLabel = typeof detail?.importance === 'number'
                ? ' (importance ' + String(detail.importance) + ')'
                : '';

            window.setTimeout(() => {
                const wantsHelp = window.confirm(
                    'Heads-up alerts are disabled' + importanceLabel + '. Open notification settings and enable Pop on screen for Chat Messages?'
                );
                if (!wantsHelp) return;

                void (async () => {
                    const targetChannelId = (detail?.id || NATIVE_PUSH_CHANNEL_ID || '').trim();
                    const openedChannelSettings = targetChannelId
                        ? await openAndroidChannelNotificationSettings(targetChannelId)
                        : false;
                    if (openedChannelSettings) return;

                    const openedAppSettings = await openAndroidAppNotificationSettings();
                    if (openedAppSettings) return;

                    window.alert(
                        'Android steps:\\n1) Long-press QMessage app icon\\n2) App info\\n3) Notifications\\n4) Chat Messages\\n5) Enable Pop on screen, sound, and vibration'
                    );
                })();
            }, 420);
        };

        window.addEventListener(NATIVE_PUSH_CHANNEL_STATUS_EVENT, handleNativePushChannelStatus as EventListener);
        void refreshNativePushChannelStatus();
        return () => {
            window.removeEventListener(NATIVE_PUSH_CHANNEL_STATUS_EVENT, handleNativePushChannelStatus as EventListener);
        };
    }, [pushLog, showToast]);

    useEffect(() => {
        const handleNativePushForeground = (event: Event) => {
            if (socketInstanceRef.current?.connected) return;
            const detail = (event as CustomEvent<NativePushReceivedEventDetail>).detail;
            pushLog(
                `[Native Push] Received app=${detail?.appVisibility || 'unknown'} payload=${detail?.payloadKind || 'unknown'} channel=${NATIVE_PUSH_CHANNEL_ID}.`,
                'info'
            );
            if (document.visibilityState !== 'visible') return;
            const title = typeof detail?.title === 'string' ? detail.title.trim() : '';
            const body = typeof detail?.body === 'string' ? detail.body.trim() : '';
            showChatToast(
                title || 'QMessage',
                truncateNotificationBody(body || 'New message')
            );
            void playNotificationGlassSound();
        };

        window.addEventListener(NATIVE_PUSH_RECEIVED_EVENT, handleNativePushForeground as EventListener);
        return () => {
            window.removeEventListener(NATIVE_PUSH_RECEIVED_EVENT, handleNativePushForeground as EventListener);
        };
    }, [playNotificationGlassSound, pushLog, showChatToast]);

    const handleToggleNotificationSound = useCallback((enabled: boolean) => {
        setNotificationSoundEnabled(enabled);
        if (enabled) {
            void playNotificationGlassSound(true);
        }
    }, [playNotificationGlassSound]);

    const handleTestNotificationSound = useCallback(async () => {
        const played = await playNotificationGlassSound(true);
        if (played) {
            showToast('Playing iPhone Glass notification sound.', 'success');
            return;
        }
        showToast('Unable to play notification sound on this device right now.', 'error');
    }, [playNotificationGlassSound, showToast]);

    useEffect(() => {
        notificationSoundEnabledRef.current = notificationSoundEnabled;
        try {
            window.localStorage.setItem(NOTIFICATION_SOUND_PREF_KEY, notificationSoundEnabled ? '1' : '0');
        } catch {
            // ignore persistence failures
        }
    }, [notificationSoundEnabled]);

    useEffect(() => {
        return () => {
            const ctx = notificationAudioContextRef.current;
            notificationAudioContextRef.current = null;
            if (ctx) {
                void ctx.close().catch(() => undefined);
            }
        };
    }, []);

    const clearPwaUpdateReloadTimer = useCallback(() => {
        if (pwaUpdateReloadTimerRef.current !== null) {
            window.clearTimeout(pwaUpdateReloadTimerRef.current);
            pwaUpdateReloadTimerRef.current = null;
        }
    }, []);

    const handleApplyPwaUpdate = useCallback(() => {
        const waitingWorker = pwaUpdateRegistration?.waiting;
        if (!waitingWorker) {
            setShowPwaUpdateBanner(false);
            return;
        }
        pwaUpdateReloadingRef.current = true;
        setShowPwaUpdateBanner(false);
        waitingWorker.postMessage({ type: 'SKIP_WAITING' });
        clearPwaUpdateReloadTimer();
        pwaUpdateReloadTimerRef.current = window.setTimeout(() => {
            window.location.reload();
        }, 3200);
    }, [clearPwaUpdateReloadTimer, pwaUpdateRegistration]);

    useEffect(() => {
        if (!appToast) return;
        const dismissAfterMs = appToast.variant === 'chat' ? 3200 : 2400;
        const timer = window.setTimeout(() => {
            setAppToast((current) => (current?.id === appToast.id ? null : current));
        }, dismissAfterMs);
        return () => window.clearTimeout(timer);
    }, [appToast]);

    useEffect(() => {
        return () => {
            clearPwaUpdateReloadTimer();
        };
    }, [clearPwaUpdateReloadTimer]);

    const handleRequestNotificationPermission = useCallback(async () => {
        if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
            try {
                const current = await PushNotifications.checkPermissions();
                let receiveStatus = current.receive;
                pushLog(`[Native Push] POST_NOTIFICATIONS(check)=${receiveStatus}.`, 'info');

                if (receiveStatus !== 'granted') {
                    const requested = await PushNotifications.requestPermissions();
                    receiveStatus = requested.receive;
                    pushLog(`[Native Push] POST_NOTIFICATIONS(request)=${receiveStatus}.`, requested.receive === 'granted' ? 'info' : 'error');
                }

                if (receiveStatus === 'granted') {
                    setNotificationPermissionState('granted');
                    showToast('Notifications enabled for incoming chat alerts.', 'success');
                    return;
                }

                setNotificationPermissionState('denied');
                showToast('Android notifications are blocked. Open settings to enable them.', 'error');
                const wantsSettings = window.confirm(
                    'Android notification permission is blocked. Open app notification settings now?'
                );
                if (wantsSettings) {
                    const opened = await openAndroidAppNotificationSettings();
                    if (!opened) {
                        window.alert(
                            'Android steps:\\n1) Long-press QMessage app icon\\n2) App info\\n3) Notifications\\n4) Enable notifications for this app'
                        );
                    }
                }
                return;
            } catch (error: any) {
                showToast(error?.message || 'Failed to request Android notification permission.', 'error');
                return;
            }
        }

        if (!('Notification' in window)) {
            setNotificationPermissionState('unsupported');
            showToast('This device does not support browser notifications.', 'error');
            return;
        }
        try {
            const permission = await Notification.requestPermission();
            setNotificationPermissionState(permission);
            if (permission === 'granted') {
                showToast('Notifications enabled for incoming chat alerts.', 'success');
                window.setTimeout(() => {
                    void syncWebPushSubscription(true);
                }, 0);
                return;
            }
            if (permission === 'denied') {
                showToast('Notifications blocked. You can enable them in browser settings.', 'error');
            }
        } catch (error: any) {
            showToast(error?.message || 'Failed to request notification permission.', 'error');
        }
    }, [pushLog, showToast]);

    const handleSendTestNotification = useCallback(async () => {
        if (!socket) {
            showToast('Realtime connection is not ready yet. Please try again.', 'error');
            return;
        }

        const nowMs = Date.now();
        if (nowMs - lastTestNotificationTriggerAtRef.current < 1500) {
            return;
        }
        lastTestNotificationTriggerAtRef.current = nowMs;

        if (notificationPermissionState === 'default') {
            await handleRequestNotificationPermission();
        }

        setSendingTestNotification(true);
        try {
            const deviceLabel = (() => {
                const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
                if (/iphone/i.test(ua)) return 'iPhone';
                if (/ipad/i.test(ua)) return 'iPad';
                if (/android/i.test(ua)) return 'Android';
                return 'Device';
            })();

            const ack = await emitSocketWithTimeout(
                socket,
                'notification.test',
                {
                    profileId: activeProfileIdRef.current || activeProfileId || '',
                    title: 'QMessage Test Notification',
                    body: `Test sent from ${deviceLabel}.`,
                    source: 'mobile-fab'
                },
                5000,
                'Notification test timed out.'
            );

            if (!ack?.success) {
                throw new Error(ack?.error || 'Failed to send test notification.');
            }

            showToast('Test sent. Check your other logged-in devices.', 'success');
        } catch (error: any) {
            showToast(error?.message || 'Failed to send test notification.', 'error');
        } finally {
            setSendingTestNotification(false);
        }
    }, [activeProfileId, handleRequestNotificationPermission, notificationPermissionState, showToast, socket]);

    useEffect(() => {
        if (!('serviceWorker' in navigator)) return;

        const onPwaUpdateAvailable = (event: Event) => {
            const customEvent = event as CustomEvent<ServiceWorkerRegistration>;
            const registration = customEvent.detail;
            if (!registration?.waiting) return;
            setPwaUpdateRegistration(registration);
            setShowPwaUpdateBanner(true);
        };

        const onControllerChange = () => {
            if (!pwaUpdateReloadingRef.current) return;
            pwaUpdateReloadingRef.current = false;
            clearPwaUpdateReloadTimer();
            window.location.reload();
        };

        window.addEventListener(PWA_UPDATE_AVAILABLE_EVENT, onPwaUpdateAvailable as EventListener);
        navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

        return () => {
            window.removeEventListener(PWA_UPDATE_AVAILABLE_EVENT, onPwaUpdateAvailable as EventListener);
            navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
        };
    }, [clearPwaUpdateReloadTimer]);

    useEffect(() => {
        const syncPermission = () => setNotificationPermissionState(getNotificationPermissionState());
        syncPermission();
        document.addEventListener('visibilitychange', syncPermission);
        return () => {
            document.removeEventListener('visibilitychange', syncPermission);
        };
    }, []);

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

    const updateSessionState = useCallback((nextSession: Session | null) => {
        setSession((previousSession) => {
            if (isSameSessionIdentity(previousSession, nextSession)) {
                return previousSession;
            }
            return nextSession;
        });
    }, []);

    const refreshAccessToken = useCallback(async (): Promise<string | null> => {
        if (refreshSessionPromiseRef.current) {
            return refreshSessionPromiseRef.current;
        }

        const pendingRefresh = supabase.auth
            .refreshSession()
            .then(({ data, error }) => {
                const refreshedToken = data?.session?.access_token?.trim() || '';
                if (error || !refreshedToken) return null;
                updateSessionState(data.session);
                return refreshedToken;
            })
            .catch(() => null)
            .finally(() => {
                refreshSessionPromiseRef.current = null;
            });

        refreshSessionPromiseRef.current = pendingRefresh;
        return pendingRefresh;
    }, [updateSessionState]);

    const forceSessionReauth = useCallback((message: string) => {
        if (authRecoveryInFlightRef.current) return;
        authRecoveryInFlightRef.current = true;
        setHostAuthError(message);
        refreshSessionPromiseRef.current = null;
        void supabase.auth.signOut()
            .catch(() => undefined)
            .finally(() => {
                updateSessionState(null);
                authRecoveryInFlightRef.current = false;
            });
    }, [updateSessionState]);


    useEffect(() => {
        refreshAccessTokenRef.current = refreshAccessToken;
    }, [refreshAccessToken]);
    const fetchWithSessionAuth = useCallback(
        async (
            input: RequestInfo | URL,
            init: RequestInit = {},
            retryOnUnauthorized = true,
            requestTimeoutMs = API_REQUEST_TIMEOUT_MS
        ) => {
            const method = typeof init.method === 'string' ? init.method.trim().toUpperCase() : 'GET';
            const isRetryableTimeoutMethod = method === 'GET' || method === 'HEAD';
            const buildHeaders = (token: string) => {
                return createAuthHeaders(token, init.headers || undefined);
            };

            const runWithToken = async (token: string) => {
                const timeoutController = new AbortController();
                const externalSignal = init.signal;
                const onExternalAbort = () => timeoutController.abort();
                if (externalSignal) {
                    if (externalSignal.aborted) {
                        timeoutController.abort();
                    } else {
                        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
                    }
                }

                const shouldTimeout = Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0;
                const timeoutId = shouldTimeout
                    ? window.setTimeout(() => {
                        timeoutController.abort();
                    }, requestTimeoutMs)
                    : null;

                try {
                    return await fetch(input, {
                        ...init,
                        headers: buildHeaders(token),
                        signal: timeoutController.signal
                    });
                } catch (error: any) {
                    if (timeoutController.signal.aborted && !externalSignal?.aborted) {
                        throw new Error('Request timed out. Please retry.');
                    }
                    throw error;
                } finally {
                    if (typeof timeoutId === 'number') {
                        window.clearTimeout(timeoutId);
                    }
                    if (externalSignal) {
                        externalSignal.removeEventListener('abort', onExternalAbort);
                    }
                }
            };

            const runWithTimeoutRetry = async (token: string) => {
                try {
                    return await runWithToken(token);
                } catch (error: any) {
                    const message = typeof error?.message === 'string' ? error.message : '';
                    if (!isRetryableTimeoutMethod || !message.includes('Request timed out')) {
                        throw error;
                    }
                    await new Promise<void>((resolve) => {
                        window.setTimeout(() => resolve(), 350);
                    });
                    return runWithToken(token);
                }
            };

            const currentToken = session?.access_token?.trim();
            if (!currentToken) {
                forceSessionReauth('Invalid or expired session. Please sign in again.');
                throw new Error('Invalid or expired session');
            }

            let response = await runWithTimeoutRetry(currentToken);
            if (response.status !== 401 || !retryOnUnauthorized) {
                return response;
            }

            const refreshedToken = await refreshAccessToken();
            if (!refreshedToken) {
                forceSessionReauth('Invalid or expired session. Please sign in again.');
                return response;
            }
            response = await runWithTimeoutRetry(refreshedToken);
            if (response.status === 401) {
                forceSessionReauth('Invalid or expired session. Please sign in again.');
            }
            return response;
        },
        [forceSessionReauth, refreshAccessToken, session?.access_token]
    );

    const syncWebPushSubscription = useCallback(async (force = false): Promise<boolean> => {
        const currentUserId = typeof session?.user?.id === 'string' ? session.user.id.trim() : '';
        if (!currentUserId || !session?.access_token) return false;
        if (typeof window === 'undefined') return false;
        if (!window.isSecureContext) return false;
        if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return false;
        if (Notification.permission !== 'granted') return false;

        if (pushSubscriptionUserIdRef.current !== currentUserId) {
            pushSubscriptionUserIdRef.current = currentUserId;
            pushSubscriptionEndpointRef.current = '';
        }

        if (pushSubscriptionSyncingRef.current) return false;
        pushSubscriptionSyncingRef.current = true;

        try {
            let registration: ServiceWorkerRegistration | null = null;
            try {
                registration = (await navigator.serviceWorker.getRegistration()) || null;
            } catch {
                registration = null;
            }

            if (!registration) {
                try {
                    registration = await navigator.serviceWorker.register('/sw.js');
                } catch {
                    registration = null;
                }
            }

            if (!registration) {
                const readyRegistration = await Promise.race<ServiceWorkerRegistration | null>([
                    navigator.serviceWorker.ready,
                    new Promise<null>((resolve) => {
                        window.setTimeout(() => resolve(null), 2400);
                    })
                ]);
                registration = readyRegistration;
            }

            if (!registration?.pushManager) return false;

            const keyRes = await fetchWithSessionAuth(SOCKET_URL + '/api/push/public-key');
            const keyData = await keyRes.json().catch(() => null);
            const publicKey = typeof keyData?.publicKey === 'string' ? keyData.publicKey.trim() : '';
            if (!keyRes.ok || !keyData?.success || !keyData?.enabled || !publicKey) {
                return false;
            }

            let subscription = await registration.pushManager.getSubscription();
            if (!subscription) {
                subscription = await registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(publicKey)
                });
            }
            if (!subscription) return false;

            const payload = subscription.toJSON();
            const endpoint = typeof payload?.endpoint === 'string' ? payload.endpoint.trim() : '';
            if (!endpoint) return false;

            if (!force && endpoint === pushSubscriptionEndpointRef.current) {
                return true;
            }

            const subscribeRes = await fetchWithSessionAuth(SOCKET_URL + '/api/push/subscribe', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ subscription: payload })
            });
            const subscribeData = await subscribeRes.json().catch(() => null);
            if (!subscribeRes.ok || !subscribeData?.success) {
                throw new Error(subscribeData?.error || 'Failed to register push subscription.');
            }

            pushSubscriptionEndpointRef.current = endpoint;
            pushSubscriptionUserIdRef.current = currentUserId;
            return true;
        } catch (error) {
            console.warn('[push] Failed to sync browser push subscription:', error);
            return false;
        } finally {
            pushSubscriptionSyncingRef.current = false;
        }
    }, [fetchWithSessionAuth, session?.access_token, session?.user?.id]);

    useEffect(() => {
        if (!session?.access_token || !session?.user?.id) {
            pushSubscriptionEndpointRef.current = '';
            pushSubscriptionUserIdRef.current = null;
            return;
        }
        if (notificationPermissionState !== 'granted') return;
        if (typeof window === 'undefined') return;
        if (!window.isSecureContext) return;
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

        let cancelled = false;
        let retryTimer: number | null = null;
        let attempts = 0;
        const maxAttempts = 8;

        const attemptSync = async (force = false) => {
            attempts += 1;
            const synced = await syncWebPushSubscription(force);
            if (cancelled || synced || attempts >= maxAttempts) return;
            retryTimer = window.setTimeout(() => {
                void attemptSync();
            }, 1200);
        };

        void attemptSync();

        return () => {
            cancelled = true;
            if (retryTimer !== null) {
                window.clearTimeout(retryTimer);
            }
        };
    }, [notificationPermissionState, session?.access_token, session?.user?.id, syncWebPushSubscription]);

    const syncNativePushToken = useCallback(async (force = false): Promise<boolean> => {
        const currentUserId = typeof session?.user?.id === 'string' ? session.user.id.trim() : '';
        const accessToken = typeof session?.access_token === 'string' ? session.access_token.trim() : '';
        if (!currentUserId || !accessToken) return false;
        if (!Capacitor.isNativePlatform()) return false;

        const token = typeof nativePushTokenState.token === 'string' ? nativePushTokenState.token.trim() : '';
        const platformFromState = nativePushTokenState.platform;
        const platformRaw = platformFromState || Capacitor.getPlatform();
        const platform = platformRaw === 'android' || platformRaw === 'ios' ? platformRaw : '';

        if (!token || !platform) return false;

        if (nativePushSyncedUserIdRef.current !== currentUserId) {
            nativePushSyncedTokenRef.current = '';
            nativePushSyncedPlatformRef.current = '';
            nativePushSyncedUserIdRef.current = currentUserId;
        }

        if (
            !force
            && nativePushSyncedTokenRef.current === token
            && nativePushSyncedPlatformRef.current === platform
            && nativePushSyncedUserIdRef.current === currentUserId
        ) {
            return true;
        }

        if (nativePushTokenSyncingRef.current) return false;
        nativePushTokenSyncingRef.current = true;

        try {
            const registerRes = await fetchWithSessionAuth(`${SOCKET_URL}/api/push/native/register`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    token,
                    platform,
                    appId: 'com.qmessage.app'
                })
            });
            const registerData = await registerRes.json().catch(() => null);
            if (!registerRes.ok || !registerData?.success) {
                throw new Error(registerData?.error || 'Failed to register native push token.');
            }

            nativePushSyncedTokenRef.current = token;
            nativePushSyncedPlatformRef.current = platform;
            nativePushSyncedUserIdRef.current = currentUserId;
            return true;
        } catch (error) {
            console.warn('[native-push] Failed to sync native push token:', error);
            return false;
        } finally {
            nativePushTokenSyncingRef.current = false;
        }
    }, [fetchWithSessionAuth, nativePushTokenState.platform, nativePushTokenState.token, session?.access_token, session?.user?.id]);

    useEffect(() => {
        if (!session?.access_token || !session?.user?.id) {
            nativePushSyncedTokenRef.current = '';
            nativePushSyncedPlatformRef.current = '';
            nativePushSyncedUserIdRef.current = null;
            return;
        }
        if (!Capacitor.isNativePlatform()) return;

        let cancelled = false;
        let retryTimer: number | null = null;
        let attempts = 0;
        const maxAttempts = 5;

        const attemptSync = async (force = false) => {
            attempts += 1;
            const synced = await syncNativePushToken(force);
            if (cancelled || synced || attempts >= maxAttempts) return;
            retryTimer = window.setTimeout(() => {
                void attemptSync();
            }, 1400);
        };

        void attemptSync();

        return () => {
            cancelled = true;
            if (retryTimer !== null) {
                window.clearTimeout(retryTimer);
            }
        };
    }, [session?.access_token, session?.user?.id, syncNativePushToken]);

    const fetchTeamUsers = useCallback(async () => {
        if (!session?.access_token) return;
        setTeamUsersLoading(true);
        try {
            const res = await fetchWithSessionAuth(`${SOCKET_URL}/api/company/team-users`);
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
    }, [fetchWithSessionAuth, session?.access_token]);

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
                headers: createAuthHeaders(session.access_token)
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
                headers: createAuthHeaders(session.access_token)
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
                const response: any = await emitSocketWithTimeout(
                    socket,
                    'contact.assign',
                    {
                        profileId: activeProfileId,
                        jid,
                        assigneeUserId
                    },
                    8000,
                    'Assignment timed out. Please try again.'
                );

                if (!response?.success) {
                    throw new Error(response?.error || 'Failed to assign contact');
                }

                const contact = response?.data?.contact;
                if (contact?.id) {
                    setContacts((prev) => applyAssignedContactUpdate(prev, jid, contact));
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
            if (document.visibilityState !== 'visible') return;
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
        if (!activeProfileId || !session?.access_token) return;
        setAnalyticsLoading(true);
        setAnalyticsError(null);
        const params = new URLSearchParams({
            profileId: activeProfileId,
            start: analyticsStart,
            end: analyticsEnd
        });
        if (analyticsTag.trim()) params.set('tag', analyticsTag.trim());
        fetch(`${SOCKET_URL}/api/analytics?${params.toString()}`, {
            headers: createAuthHeaders(session.access_token)
        })
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
    }, [activeProfileId, analyticsStart, analyticsEnd, analyticsTag, session?.access_token]);

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

    const analyticsStaffInsights = useMemo(() => {
        const onlineCount = analyticsStaffRows.filter((row) => row.is_online).length;
        const totalMessages = analyticsStaffRows.reduce((sum, row) => sum + toSafeAnalyticsCount(row.total_messages), 0);
        const responseRows = analyticsStaffRows.filter((row) => row.avg_response_seconds > 0);
        const weighted = responseRows.reduce(
            (acc, row) => {
                const weight = Math.max(1, toSafeAnalyticsCount(row.replied_contacts));
                return {
                    total: acc.total + (row.avg_response_seconds * weight),
                    weight: acc.weight + weight
                };
            },
            { total: 0, weight: 0 }
        );
        const averageResponseSeconds = weighted.weight > 0
            ? Math.round(weighted.total / weighted.weight)
            : 0;

        return {
            onlineCount,
            totalMessages,
            averageResponseSeconds
        };
    }, [analyticsStaffRows]);

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

    const normalizeQuickReplyMediaItems = useCallback((
        value: unknown,
        fallbackType: 'image' | 'video' | 'document'
    ): QuickReplyMediaItem[] => {
        if (!Array.isArray(value)) return [];
        const normalized: QuickReplyMediaItem[] = [];
        value.forEach((entry: any) => {
            const mediaType = normalizeQuickReplyMediaItemType(entry?.type, fallbackType);
            const mediaAssetKey = normalizeQuickReplyMediaAssetKey(entry?.media_asset_key);
            const mediaStorage: 'external' | 'r2' = mediaAssetKey ? 'r2' : normalizeQuickReplyMediaStorage(entry?.media_storage);
            const mediaUrl = normalizeQuickReplyMediaUrl(entry?.media_url);
            if (mediaStorage === 'r2') {
                if (!mediaAssetKey) return;
            } else if (!mediaUrl) {
                return;
            }
            const mediaFilename = mediaType === 'document'
                ? normalizeQuickReplyMediaFilename(entry?.media_filename)
                : '';
            normalized.push({
                type: mediaType,
                media_storage: mediaStorage,
                media_asset_key: mediaAssetKey,
                media_mime_type: normalizeQuickReplyMediaMimeType(entry?.media_mime_type),
                media_size_bytes: normalizeQuickReplyMediaSizeBytes(entry?.media_size_bytes),
                media_url: mediaStorage === 'r2' ? '' : mediaUrl,
                media_filename: mediaFilename
            });
        });
        return normalized;
    }, [
        normalizeQuickReplyMediaAssetKey,
        normalizeQuickReplyMediaFilename,
        normalizeQuickReplyMediaMimeType,
        normalizeQuickReplyMediaSizeBytes,
        normalizeQuickReplyMediaStorage,
        normalizeQuickReplyMediaUrl
    ]);

    const buildLegacyQuickReplyMediaItems = useCallback((
        item: any,
        messageType: 'image' | 'video' | 'document'
    ): QuickReplyMediaItem[] => {
        const mediaAssetKey = normalizeQuickReplyMediaAssetKey(item?.media_asset_key);
        const mediaStorage: 'external' | 'r2' = mediaAssetKey ? 'r2' : normalizeQuickReplyMediaStorage(item?.media_storage);
        const mediaUrl = normalizeQuickReplyMediaUrl(item?.media_url);
        if (mediaStorage === 'r2') {
            if (!mediaAssetKey) return [];
        } else if (!mediaUrl) {
            return [];
        }
        return [{
            type: messageType,
            media_storage: mediaStorage,
            media_asset_key: mediaAssetKey,
            media_mime_type: normalizeQuickReplyMediaMimeType(item?.media_mime_type),
            media_size_bytes: normalizeQuickReplyMediaSizeBytes(item?.media_size_bytes),
            media_url: mediaStorage === 'r2' ? '' : mediaUrl,
            media_filename: messageType === 'document' ? normalizeQuickReplyMediaFilename(item?.media_filename) : ''
        }];
    }, [
        normalizeQuickReplyMediaAssetKey,
        normalizeQuickReplyMediaFilename,
        normalizeQuickReplyMediaMimeType,
        normalizeQuickReplyMediaSizeBytes,
        normalizeQuickReplyMediaStorage,
        normalizeQuickReplyMediaUrl
    ]);

    const normalizeQuickReplyRecord = useCallback((item: any): QuickReply => {
        const message_type = normalizeQuickReplyMessageType(item?.message_type);
        let media_items = message_type === 'text'
            ? []
            : normalizeQuickReplyMediaItems(item?.media_items, message_type);
        if (message_type !== 'text' && media_items.length === 0) {
            media_items = buildLegacyQuickReplyMediaItems(item, message_type);
        }
        const primaryMedia = media_items[0] || null;
        const media_asset_key = primaryMedia
            ? normalizeQuickReplyMediaAssetKey(primaryMedia.media_asset_key)
            : normalizeQuickReplyMediaAssetKey(item?.media_asset_key);
        const media_storage = primaryMedia
            ? (media_asset_key ? 'r2' : normalizeQuickReplyMediaStorage(primaryMedia.media_storage))
            : (media_asset_key ? 'r2' : normalizeQuickReplyMediaStorage(item?.media_storage));
        const media_mime_type = primaryMedia
            ? normalizeQuickReplyMediaMimeType(primaryMedia.media_mime_type)
            : normalizeQuickReplyMediaMimeType(item?.media_mime_type);
        const media_size_bytes = primaryMedia
            ? normalizeQuickReplyMediaSizeBytes(primaryMedia.media_size_bytes)
            : normalizeQuickReplyMediaSizeBytes(item?.media_size_bytes);
        const media_url = primaryMedia
            ? normalizeQuickReplyMediaUrl(primaryMedia.media_url)
            : normalizeQuickReplyMediaUrl(item?.media_url);
        const media_filename = primaryMedia
            ? normalizeQuickReplyMediaFilename(primaryMedia.media_filename)
            : normalizeQuickReplyMediaFilename(item?.media_filename);
        return {
            id: typeof item?.id === 'string' ? item.id : undefined,
            shortcut: typeof item?.shortcut === 'string' ? item.shortcut : '',
            text: typeof item?.text === 'string' ? item.text : '',
            message_type,
            media_storage,
            media_asset_key,
            media_mime_type,
            media_size_bytes,
            media_url,
            media_filename: message_type === 'document' ? media_filename : '',
            media_items
        };
    }, [
        buildLegacyQuickReplyMediaItems,
        normalizeQuickReplyMediaAssetKey,
        normalizeQuickReplyMediaFilename,
        normalizeQuickReplyMediaItems,
        normalizeQuickReplyMediaMimeType,
        normalizeQuickReplyMediaSizeBytes,
        normalizeQuickReplyMediaStorage,
        normalizeQuickReplyMediaUrl,
        normalizeQuickReplyMessageType
    ]);

    const fetchQuickReplies = useCallback(() => {
        if (!profilesLoaded) {
            return;
        }
        const profileExists = profiles.some((profile: any) => profile?.id === activeProfileId);
        if (!activeProfileId || !session?.access_token || !profileExists) {
            setQuickReplies([]);
            return;
        }
        setQuickRepliesLoading(true);
        setQuickRepliesError(null);
        fetchWithSessionAuth(`${SOCKET_URL}/api/company/quick-replies?profileId=${encodeURIComponent(activeProfileId)}`)
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
    }, [activeProfileId, fetchWithSessionAuth, normalizeQuickReplyRecord, profiles, profilesLoaded, session?.access_token]);

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
            media_items: QuickReplyMediaItem[];
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
            let mediaItems = messageType === 'text'
                ? []
                : normalizeQuickReplyMediaItems(item.media_items, messageType);
            if (messageType !== 'text' && mediaItems.length === 0) {
                mediaItems = buildLegacyQuickReplyMediaItems(item, messageType);
            }
            const primaryMedia = mediaItems[0] || null;
            const primaryMediaStorage = primaryMedia
                ? (normalizeQuickReplyMediaAssetKey(primaryMedia.media_asset_key) ? 'r2' : normalizeQuickReplyMediaStorage(primaryMedia.media_storage))
                : resolvedMediaStorage;
            const primaryMediaAssetKey = primaryMedia
                ? normalizeQuickReplyMediaAssetKey(primaryMedia.media_asset_key)
                : mediaAssetKey;
            const primaryMediaMimeType = primaryMedia
                ? normalizeQuickReplyMediaMimeType(primaryMedia.media_mime_type)
                : mediaMimeType;
            const primaryMediaSizeBytes = primaryMedia
                ? normalizeQuickReplyMediaSizeBytes(primaryMedia.media_size_bytes)
                : mediaSizeBytes;
            const primaryMediaUrl = primaryMedia
                ? normalizeQuickReplyMediaUrl(primaryMedia.media_url)
                : mediaUrl;
            const primaryMediaFilename = primaryMedia
                ? normalizeQuickReplyMediaFilename(primaryMedia.media_filename)
                : mediaFilename;
            if (!shortcut) continue;
            if (seen.has(shortcut)) {
                setQuickRepliesError(`Duplicate shortcut: /${shortcut}`);
                setQuickRepliesSaving(false);
                return;
            }
            if (messageType === 'text') {
                if (!text) continue;
            } else if (mediaItems.length === 0) {
                continue;
            }
            seen.add(shortcut);
            cleaned.push({
                shortcut,
                text,
                message_type: messageType,
                media_storage: messageType === 'text' ? 'external' : primaryMediaStorage,
                media_asset_key: messageType === 'text' || primaryMediaStorage !== 'r2' ? null : primaryMediaAssetKey,
                media_mime_type: messageType === 'text' || primaryMediaStorage !== 'r2' ? null : (primaryMediaMimeType || null),
                media_size_bytes: messageType === 'text' || primaryMediaStorage !== 'r2' ? null : primaryMediaSizeBytes,
                media_url: messageType === 'text' || primaryMediaStorage === 'r2' ? null : primaryMediaUrl,
                media_filename: messageType === 'document' && primaryMediaFilename ? primaryMediaFilename : null,
                media_items: messageType === 'text'
                    ? []
                    : mediaItems.map((entry) => {
                        const entryAssetKey = normalizeQuickReplyMediaAssetKey(entry.media_asset_key);
                        const entryStorage: 'external' | 'r2' = entryAssetKey ? 'r2' : normalizeQuickReplyMediaStorage(entry.media_storage);
                        return {
                            type: normalizeQuickReplyMediaItemType(entry.type, messageType),
                            media_storage: entryStorage,
                            media_asset_key: entryStorage === 'r2' ? entryAssetKey : '',
                            media_mime_type: entryStorage === 'r2' ? normalizeQuickReplyMediaMimeType(entry.media_mime_type) : '',
                            media_size_bytes: entryStorage === 'r2' ? normalizeQuickReplyMediaSizeBytes(entry.media_size_bytes) : null,
                            media_url: entryStorage === 'r2' ? '' : normalizeQuickReplyMediaUrl(entry.media_url),
                            media_filename: normalizeQuickReplyMediaItemType(entry.type, messageType) === 'document'
                                ? normalizeQuickReplyMediaFilename(entry.media_filename)
                                : ''
                        };
                    })
            });
        }

        try {
            const res = await fetch(`${SOCKET_URL}/api/company/quick-replies?profileId=${encodeURIComponent(activeProfileId)}`, {
                method: 'POST',
                headers: createAuthHeaders(session.access_token, {
                    'Content-Type': 'application/json'
                }),
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
        buildLegacyQuickReplyMediaItems,
        normalizeQuickReplyMediaItems,
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
            'settings',
            'settings-review',
            'settings-manual',
            'settings-register',
            'settings-webhooks',
            'settings-ads-shoot',
            'settings-promo-push'
        ]);
        const aliases: Record<string, string> = {
            'team_inbox': 'team-inbox',
            'teaminbox': 'team-inbox',
            'inbox': 'team-inbox',
            'automation': 'automations',
            'broadcasts': 'broadcast',
            'chatbot': 'chatbots',
            'contact': 'contacts',
            'call': 'calls',
            'analytic': 'analytics',
            'setting': 'settings',
            'more': 'analytics',
            'other': 'analytics',
            'settingsreview': 'settings-review',
            'review': 'settings-review',
            'permission-verification-console': 'settings-review',
            'settingsmanual': 'settings-manual',
            'manual-waba-setup': 'settings-manual',
            'settingsregister': 'settings-register',
            'register-whatsapp-number': 'settings-register',
            'settingswebhooks': 'settings-webhooks',
            'outgoing-webhooks': 'settings-webhooks',
            'settingsadsshoot': 'settings-ads-shoot',
            'ads-shoot-mode': 'settings-ads-shoot',
            'settingspromopush': 'settings-promo-push',
            'promo-push': 'settings-promo-push'
        };
        const unique = new Set<string>();
        const push = (entry: unknown) => {
            if (typeof entry !== 'string') return;
            const raw = entry.trim().toLowerCase();
            const normalizedBase = raw.replace(/\s+/g, '-');
            const normalized = aliases[normalizedBase] || aliases[normalizedBase.replace(/-/g, '')] || normalizedBase;
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
            const res = await fetchWithSessionAuth(`${SOCKET_URL}/api/company/ui-controls`, {}, true, 18_000);
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
            // Preserve previously loaded UI controls on transient/network failures
            // so hidden features do not suddenly reappear.
        } finally {
            setUiControlsLoading(false);
        }
    }, [fetchWithSessionAuth, normalizeHiddenFeatureList, session?.access_token]);

    const markChatAsRead = useCallback((chatId: string | null | undefined) => {
        const chatKey = canonicalContactJid(chatId || '');
        if (!chatKey) return;
        setUnreadMessagesByChat((prev) => {
            if (!(chatKey in prev)) return prev;
            const next = { ...prev };
            delete next[chatKey];
            return next;
        });
        const latestTs = allMessages.reduce((maxTs, msg) => {
            const jid = canonicalContactJid(msg.key?.remoteJid || '');
            if (jid !== chatKey) return maxTs;
            return Math.max(maxTs, Number(msg?.messageTimestamp || 0));
        }, 0);
        const readUntilTs = Math.max(latestTs, Math.floor(Date.now() / 1000));
        setChatReadCursorByChat((prev) => {
            if ((prev[chatKey] || 0) >= readUntilTs) return prev;
            return {
                ...prev,
                [chatKey]: readUntilTs
            };
        });
    }, [allMessages]);

    useEffect(() => {
        activeProfileIdRef.current = activeProfileId;
        bumpDebugSocketEvent('state.activeProfileId', trimString(activeProfileId) || '(none)');
    }, [activeProfileId, bumpDebugSocketEvent]);

    useEffect(() => {
        activeVoiceCallRef.current = activeVoiceCall;
    }, [activeVoiceCall]);

    useEffect(() => {
        profilesRef.current = Array.isArray(profiles) ? profiles : [];
        if (!debugOverlayEnabled) return;
        const summary = profilesRef.current
            .slice(0, 6)
            .map((profile: any) => `${trimString(profile?.id)}:${trimString(profile?.status) || '-'}`)
            .join(',');
        bumpDebugSocketEvent('state.profiles', `count=${profilesRef.current.length} ${summary}`);
    }, [profiles, debugOverlayEnabled, bumpDebugSocketEvent]);

    useEffect(() => {
        selectedChatIdRef.current = selectedChatId;
    }, [selectedChatId]);

    useEffect(() => () => {
        destroyBrowserVoiceCallSession();
    }, [destroyBrowserVoiceCallSession]);

    useEffect(() => {
        chatReadCursorByChatRef.current = chatReadCursorByChat;
    }, [chatReadCursorByChat]);

    useEffect(() => {
        if (Object.keys(chatReadCursorByChat).length === 0) return;
        if (Object.keys(unreadMessagesByChat).length === 0) return;

        const latestInboundByChat: Record<string, number> = {};
        allMessages.forEach((msg) => {
            if (msg?.key?.fromMe) return;
            const jid = canonicalContactJid(msg?.key?.remoteJid || '');
            if (!jid) return;
            const ts = Number(msg?.messageTimestamp || 0);
            if (!Number.isFinite(ts) || ts <= 0) return;
            latestInboundByChat[jid] = Math.max(latestInboundByChat[jid] || 0, ts);
        });

        setUnreadMessagesByChat((prev) => {
            let changed = false;
            const next: Record<string, number> = {};
            Object.entries(prev).forEach(([jid, count]) => {
                const normalizedCount = Math.max(0, Number(count) || 0);
                if (normalizedCount <= 0) {
                    changed = true;
                    return;
                }
                const readCursor = Number(chatReadCursorByChat[jid] || 0);
                const latestInboundTs = Number(latestInboundByChat[jid] || 0);
                if (readCursor > 0 && latestInboundTs > 0 && latestInboundTs <= readCursor) {
                    changed = true;
                    return;
                }
                next[jid] = normalizedCount;
            });
            return changed ? next : prev;
        });
    }, [allMessages, chatReadCursorByChat, unreadMessagesByChat]);

    useEffect(() => {
        contactsRef.current = contacts;
    }, [contacts]);

    useEffect(() => {
        if (!activeProfileId) {
            setChatReadCursorByChat({});
            chatReadCursorByChatRef.current = {};
            return;
        }
        const next = readChatReadCursorFromStorage(activeProfileId);
        chatReadCursorByChatRef.current = next;
        setChatReadCursorByChat(next);
    }, [activeProfileId]);

    useEffect(() => {
        if (!activeProfileId) return;
        try {
            const storageKey = `${CHAT_READ_CURSOR_STORAGE_PREFIX}${activeProfileId}`;
            if (Object.keys(chatReadCursorByChat).length === 0) {
                window.localStorage.removeItem(storageKey);
                return;
            }
            window.localStorage.setItem(storageKey, JSON.stringify(chatReadCursorByChat));
        } catch {
            // ignore storage errors
        }
    }, [activeProfileId, chatReadCursorByChat]);

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
        if (workspaceSection !== 'team-inbox' || !selectedChatId) {
            return;
        }
        const timer = window.setTimeout(() => {
            fetchQuickReplies();
        }, QUICK_REPLIES_PREFETCH_DELAY_MS);
        return () => {
            window.clearTimeout(timer);
        };
    }, [activeProfileId, fetchQuickReplies, selectedChatId, workspaceSection]);

    useEffect(() => {
        if (!session?.access_token) {
            setHiddenUiFeatures([]);
            setAppLogoUrl('');
            setUiControlsLoading(false);
            return;
        }
        const timer = window.setTimeout(() => {
            fetchUiControls();
        }, 180);
        return () => {
            window.clearTimeout(timer);
        };
    }, [fetchUiControls, session?.access_token]);

    useEffect(() => {
        if (!session?.access_token) return;
        const refreshUiControlsIfNeeded = (force = false) => {
            const nowMs = Date.now();
            if (!force && nowMs - lastUiControlsRefreshAtRef.current < 5 * 60 * 1000) {
                return;
            }
            lastUiControlsRefreshAtRef.current = nowMs;
            fetchUiControls();
        };

        const onVisibilityChange = () => {
            if (document.visibilityState !== 'visible') return;
            refreshUiControlsIfNeeded();
        };
        const onOnline = () => refreshUiControlsIfNeeded(true);

        document.addEventListener('visibilitychange', onVisibilityChange);
        window.addEventListener('online', onOnline);
        return () => {
            document.removeEventListener('visibilitychange', onVisibilityChange);
            window.removeEventListener('online', onOnline);
        };
    }, [fetchUiControls, session?.access_token]);


    useEffect(() => {
        if (!isMobile) return;
        if (!selectedChatId) return;
        setSelectedChatId(null);
    }, [isMobile]);

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
        markChatAsRead(chatKey);
    }, [selectedChatId, markChatAsRead]);

    useEffect(() => {
        setIncomingCalls([]);
    }, [activeProfileId]);

    useEffect(() => {
        if (!selectedChatId) return;
        markChatAsRead(selectedChatId);
    }, [selectedChatId, allMessages.length, markChatAsRead]);

    useEffect(() => {
        setShowWorkflowStarter(false);
    }, [selectedChatId, activeProfileId]);

    useEffect(() => {
        setShowMobileComposerMenu(false);
    }, [selectedChatId, workspaceSection, isMobile, showMediaComposer, showTemplateComposer]);

    useEffect(() => {
        if (!selectedChatId) return;
        const contact = pickContactMetaByJid(contacts, selectedChatId);
        setContactDraftName(contact?.alias || '');
        setContactTagsDraft(splitContactTags(contact?.tags).labelTags);
        setContactTagInput('');
        setContactDirty(false);
    }, [selectedChatId]);

    useEffect(() => {
        if (!selectedChatId || contactDirty) return;
        const contact = pickContactMetaByJid(contacts, selectedChatId);
        if (!contact) return;
        setContactDraftName(contact.alias || '');
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
        if (typeof window === 'undefined') return;
        const syncMobileLayout = () => setIsMobile(window.innerWidth < MOBILE_LAYOUT_BREAKPOINT);
        syncMobileLayout();
        window.addEventListener('resize', syncMobileLayout);
        return () => window.removeEventListener('resize', syncMobileLayout);
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

    useEffect(() => {
        if (!isMobile) return;
        if ((MOBILE_BOTTOM_TAB_SECTIONS as readonly string[]).includes(workspaceSection)) return;
        setWorkspaceSection('team-inbox');
        setSelectedChatId(null);
    }, [isMobile, workspaceSection]);

    useEffect(() => {
        if (!isMobile) return;
        if (chatListFilter === 'all') return;
        setChatListFilter('all');
    }, [isMobile, chatListFilter]);

    const mobileSwipeSectionOrder = useMemo<Array<'team-inbox' | 'automations' | 'contacts' | 'more'>>(() => {
        if (uiControlsLoading) return ['team-inbox', 'automations', 'contacts', 'more'];
        const ordered: Array<'team-inbox' | 'automations' | 'contacts' | 'more'> = ['team-inbox', 'automations', 'contacts', 'more'];
        return ordered.filter((section) => !isUiFeatureHidden(UI_FEATURE_KEY_BY_WORKSPACE_SECTION[section]));
    }, [isUiFeatureHidden, uiControlsLoading]);

    const switchMobileWorkspaceBySwipe = useCallback((nextSection: 'team-inbox' | 'automations' | 'contacts' | 'more') => {
        setShowContactInfo(false);
        if (nextSection === 'more') {
            setShowAnalytics(true);
            return;
        }
        setShowAnalytics(false);
        if (nextSection === 'team-inbox') {
            setSelectedChatId(null);
        }
        setWorkspaceSection(nextSection);
    }, []);

    const handleMobileWorkspaceTouchStart = useCallback((event: React.TouchEvent) => {
        if (!isMobile || activeView !== 'dashboard') return;
        if (event.touches.length !== 1) return;
        if (workspaceSection === 'team-inbox' && Boolean(selectedChatId)) return;
        const target = event.target as HTMLElement | null;
        if (target?.closest('input, textarea, select, button, [contenteditable=\"true\"]')) return;
        if (target?.closest('.mobile-horizontal-scroll')) return;
        const touch = event.touches[0];
        mobileSwipeStartRef.current = {
            x: touch.clientX,
            y: touch.clientY,
            at: Date.now()
        };
    }, [activeView, isMobile, selectedChatId, workspaceSection]);

    const handleMobileWorkspaceTouchEnd = useCallback((event: React.TouchEvent) => {
        if (!isMobile || activeView !== 'dashboard') return;
        if (workspaceSection === 'team-inbox' && Boolean(selectedChatId)) return;
        const start = mobileSwipeStartRef.current;
        mobileSwipeStartRef.current = null;
        if (!start || event.changedTouches.length === 0) return;

        const touch = event.changedTouches[0];
        const deltaX = touch.clientX - start.x;
        const deltaY = touch.clientY - start.y;
        const elapsedMs = Date.now() - start.at;
        const absX = Math.abs(deltaX);
        const absY = Math.abs(deltaY);

        if (elapsedMs > 700) return;
        if (absX < 72) return;
        if (absY > 64) return;
        if (absX <= absY) return;

        const activeSection = showAnalytics ? 'more' : workspaceSection;
        const currentIndex = mobileSwipeSectionOrder.findIndex((section) => section === activeSection);
        if (currentIndex < 0) return;

        const step = deltaX < 0 ? 1 : -1;
        const nextIndex = currentIndex + step;
        if (nextIndex < 0 || nextIndex >= mobileSwipeSectionOrder.length) return;

        switchMobileWorkspaceBySwipe(mobileSwipeSectionOrder[nextIndex]);
    }, [activeView, isMobile, mobileSwipeSectionOrder, selectedChatId, showAnalytics, switchMobileWorkspaceBySwipe, workspaceSection]);


    const handleSignOut = async () => {
        clearAllDrafts();
        setMessageText('');
        setUnreadMessagesByChat({});
        setChatReadCursorByChat({});
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
        updateSessionState(null);
    };

    useEffect(() => {
        if (typeof window === 'undefined') return;
        let params: URLSearchParams;
        try {
            params = new URLSearchParams(window.location.search);
        } catch {
            return;
        }
        if (params.get('waba') !== 'connected') return;
        const phoneNumberId = params.get('waba_phone_number_id') || '';
        const displayPhoneNumber = params.get('waba_display_phone_number') || '';
        const verifiedName = params.get('waba_verified_name') || '';
        if (phoneNumberId || displayPhoneNumber || verifiedName) {
            setWabaConnectedSummary({
                phoneNumberId: phoneNumberId.trim(),
                displayPhoneNumber: displayPhoneNumber.trim(),
                verifiedName: verifiedName.trim()
            });
        } else {
            setWabaConnectedSummary(null);
        }
        setShowWabaConnectedSuccess(true);
        params.delete('waba');
        params.delete('waba_phone_number_id');
        params.delete('waba_display_phone_number');
        params.delete('waba_verified_name');
        const nextQuery = params.toString();
        const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}${window.location.hash}`;
        window.history.replaceState({}, '', nextUrl);
    }, []);

    // Check Auth
    useEffect(() => {
        let cancelled = false;
        const authTimeout = window.setTimeout(() => {
            if (cancelled) return;
            setAuthChecking(false);
        }, AUTH_CHECK_TIMEOUT_MS);

        supabase.auth.getSession()
            .then(({ data: { session } }) => {
                if (cancelled) return;
                updateSessionState(session);
                setAuthChecking(false);
            })
            .catch(() => {
                if (cancelled) return;
                setAuthChecking(false);
            });

        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            if (cancelled) return;
            updateSessionState(session);
            setAuthChecking(false);
        });

        return () => {
            cancelled = true;
            window.clearTimeout(authTimeout);
            subscription.unsubscribe();
        };
    }, [updateSessionState]);

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
            updateSessionState(null);
        });
    }, [session, updateSessionState]);

    useEffect(() => {
        if (!ENABLE_FIRST_TIME_SETUP) {
            setShowOnboardingTutorial(false);
            resetOnboardingWizard();
            return;
        }
        if (authChecking || hostAuthError) return;
        if (!session?.user?.id || !onboardingStorageKey || !isAdmin || isSuperAdmin) {
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
    }, [authChecking, hostAuthError, isAdmin, isSuperAdmin, onboardingStorageKey, resetOnboardingWizard, session?.user?.id]);

    useEffect(() => {
        if (!session?.access_token) {
            setIsAdmin(false);
            return;
        }

        const metadataRoleCandidates = [
            (session.user.user_metadata as any)?.role,
            (session.user.app_metadata as any)?.role
        ]
            .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
            .filter(Boolean);
        const metadataRole = metadataRoleCandidates[0] || '';
        if (metadataRole === 'admin' || metadataRole === 'owner') {
            setIsAdmin(true);
            return;
        }
        if (metadataRole === 'agent') {
            setIsAdmin(false);
            return;
        }

        let cancelled = false;
        const resolveRole = async () => {
            try {
                const res = await fetchWithSessionAuth(`${SOCKET_URL}/api/company/me`);
                const data = await res.json().catch(() => null);
                if (!res.ok || !data?.success) {
                    throw new Error(data?.error || 'Failed to resolve current user role');
                }
                const role = typeof data?.data?.role === 'string'
                    ? data.data.role.toLowerCase()
                    : '';
                if (!cancelled) {
                    setIsAdmin(role === 'admin' || role === 'owner');
                }
            } catch (error) {
                console.warn('company role lookup failed', error);
                if (!cancelled) {
                    setIsAdmin(false);
                }
            }
        };

        void resolveRole();
        return () => {
            cancelled = true;
        };
    }, [fetchWithSessionAuth, session?.access_token]);

    useEffect(() => {
        const statusEmoji = connectionStatus === 'open' ? '🟢' : connectionStatus === 'connecting' ? '🟡' : '🔴';
        document.title = `${statusEmoji} WhatsApp Business API`;
    }, [connectionStatus]);

    const socketAccessToken = session?.access_token || '';

    useEffect(() => {
        if (!socketAccessToken) {
            refreshSessionPromiseRef.current = null;
            const existingSocket = socketInstanceRef.current;
            if (existingSocket) {
                existingSocket.removeAllListeners();
                if (existingSocket.connected) {
                    existingSocket.disconnect();
                }
            }
            socketInstanceRef.current = null;
            socketAccessTokenRef.current = '';
            setSocket(null);
            setProfiles([]);
            setProfilesLoaded(false);
            setActiveProfileId(null);
            setAllMessages([]);
            latestMessageTimestampRef.current = 0;
            setContacts({});
            setSelectedChatId(null);
            return;
        }

        if (
            socketInstanceRef.current
            && socketAccessTokenRef.current === socketAccessToken
        ) {
            setSocket(socketInstanceRef.current);
            return;
        }

        const previousSocket = socketInstanceRef.current;
        if (previousSocket) {
            previousSocket.removeAllListeners();
            if (previousSocket.connected) {
                previousSocket.disconnect();
            }
        }

        setProfilesLoaded(false);
        const isNativeSocketClient = Capacitor.isNativePlatform();
        const newSocket = io(SOCKET_URL, {
            auth: { token: socketAccessToken },
            transports: isNativeSocketClient ? ['websocket'] : ['websocket', 'polling'],
            rememberUpgrade: true,
            autoConnect: false,
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 750,
            reconnectionDelayMax: 4000,
            timeout: 12000
        });
        socketInstanceRef.current = newSocket;
        socketAccessTokenRef.current = socketAccessToken;
        setSocket(newSocket);
        let disposed = false;
        const connectTimer = window.setTimeout(() => {
            if (!disposed && !newSocket.connected) {
                newSocket.connect();
            }
        }, 50);

        const emitRefreshMessages = (options: { forceFullHistory?: boolean; includeContacts?: boolean } = {}) => {
            const profileId = activeProfileIdRef.current;
            if (!profileId || !newSocket.connected) return;

            const nowMs = Date.now();
            const latestTs = Math.max(0, Math.floor(latestMessageTimestampRef.current || 0));
            const forceFullHistory = options.forceFullHistory === true || latestTs <= 0;
            const minGapMs = forceFullHistory ? 0 : 1200;
            if (nowMs - lastRefreshRequestEmitAtRef.current < minGapMs) return;

            const sinceTimestamp = forceFullHistory ? 0 : Math.max(0, latestTs - 2);
            newSocket.emit('refreshMessages', {
                profileId,
                sinceTimestamp,
                includeContacts: options.includeContacts === true,
                forceFullHistory
            });
            lastRefreshRequestEmitAtRef.current = nowMs;
            lastRealtimeEventAtRef.current = nowMs;
        };

        const emitPresenceVisibility = () => {
            if (!newSocket.connected) return;
            const visibility = document.visibilityState === 'visible' ? 'visible' : 'hidden';
            newSocket.emit('presence.visibility', { visibility });
        };

        newSocket.on('connect', () => {
            bumpDebugSocketEvent('socket.connect', `id=${newSocket.id || '-'}`);
            const profileId = activeProfileIdRef.current;
            if (profileId) {
                const shouldRequestContacts = latestMessageTimestampRef.current <= 0;
                emitRefreshMessages({
                    forceFullHistory: shouldRequestContacts,
                    includeContacts: shouldRequestContacts
                });
            }
            lastRealtimeEventAtRef.current = Date.now();
            emitPresenceVisibility();
        });

        newSocket.on('profiles.update', (data) => {
            const list = (Array.isArray(data) ? data : [])
                .map((profile: any) => {
                    const normalizedId = trimString(profile?.id) || trimString(profile?.profileId);
                    if (!normalizedId) return null;
                    return {
                        ...profile,
                        id: normalizedId
                    };
                })
                .filter(Boolean) as any[];
            bumpDebugSocketEvent('profiles.update', `count=${list.length}`);
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

        newSocket.on('profile.unread', (data) => {
            const profileId = typeof data?.profileId === 'string' ? data.profileId : '';
            const unreadCount = Math.max(0, Number(data?.unreadCount || 0));
            if (!profileId) return;
            setProfiles((prev) => prev.map((item: any) => {
                if (item?.id !== profileId) return item;
                return {
                    ...item,
                    unreadCount
                };
            }));
        });

        newSocket.on('connection.update', (update) => {
            bumpDebugSocketEvent(
                'connection.update',
                `profile=${trimString(update?.profileId) || '-'} status=${trimString(update?.connection) || '-'}`
            );
            if (update.profileId === activeProfileIdRef.current) setConnectionStatus(update.connection);
            if (update.connection === 'close') {
                pushLog('WABA connection closed.', 'info');
            }
        });

        const notifyIncomingMessages = async (incomingMessages: Message[]) => {
            if (!Array.isArray(incomingMessages) || incomingMessages.length === 0) return;
            const canShowSystemNotification = 'Notification' in window && Notification.permission === 'granted';

            const visibleChatKey = canonicalContactJid(selectedChatIdRef.current || '');
            const notificationCandidates: Message[] = [];

            incomingMessages.forEach((msg, index) => {
                if (msg?.key?.fromMe) return;
                const jid = canonicalContactJid(msg?.key?.remoteJid || '');
                if (!jid) return;
                if (document.visibilityState === 'visible' && jid === visibleChatKey) return;

                const rawId = typeof msg?.key?.id === 'string' ? msg.key.id.trim() : '';
                const ts = Number(msg?.messageTimestamp || 0);
                const dedupeKey = `${jid}:${rawId || `ts-${ts}-idx-${index}`}`;
                if (notifiedIncomingMessageKeysRef.current.has(dedupeKey)) return;
                notifiedIncomingMessageKeysRef.current.add(dedupeKey);
                notificationCandidates.push(msg);
            });

            if (notificationCandidates.length === 0) return;

            if (notifiedIncomingMessageKeysRef.current.size > 5000) {
                const recentKeys = Array.from(notifiedIncomingMessageKeysRef.current).slice(-2500);
                notifiedIncomingMessageKeysRef.current = new Set(recentKeys);
            }

            const latest = notificationCandidates[notificationCandidates.length - 1];
            const jid = canonicalContactJid(latest?.key?.remoteJid || '');
            if (!jid) return;

            const contactMeta = pickContactMetaByJid(contactsRef.current, jid) || {};
            const fallbackName = formatPhoneNumber(getCleanId(jid));
            const senderName =
                (typeof contactMeta.name === 'string' && contactMeta.name.trim())
                || (typeof latest?.pushName === 'string' && latest.pushName.trim())
                || fallbackName
                || 'New message';
            const notificationSuffix = notificationCandidates.length > 1
                ? ` (+${notificationCandidates.length - 1} more)`
                : '';
            const body = `${truncateNotificationBody(
                getIncomingNotificationPreview(latest),
                Math.max(24, MAX_NOTIFICATION_BODY_LENGTH - notificationSuffix.length)
            )}${notificationSuffix}`;

            void playNotificationGlassSound();


            if (document.visibilityState === 'visible') {
                showChatToast(senderName, body);
            }

            if (!canShowSystemNotification) return;

            const options: NotificationOptions = {
                body,
                icon: '/icons/icon-192.png',
                badge: '/icons/icon-192.png',
                tag: `chat:${jid}`,
                data: {
                    url: `/?chat=${encodeURIComponent(jid)}`
                }
            };

            try {
                const registration = await navigator.serviceWorker?.getRegistration?.();
                if (registration) {
                    await registration.showNotification(senderName, options);
                    return;
                }
            } catch {
                // fallback to Notification constructor below
            }

            try {
                const notification = new Notification(senderName, options);
                notification.onclick = () => {
                    window.focus();
                };
            } catch {
                // ignore unsupported Notification constructor environments
            }
        };

        newSocket.on('messages.upsert', (data) => {
            if (data.profileId === activeProfileIdRef.current) {
                lastRealtimeEventAtRef.current = Date.now();
                const incomingMessages = Array.isArray(data?.messages) ? data.messages : [];
                bumpDebugSocketEvent('messages.upsert', `count=${incomingMessages.length}`);
                const latestIncomingTs = getLatestTimestampFromMessages(incomingMessages);
                if (latestIncomingTs > latestMessageTimestampRef.current) {
                    latestMessageTimestampRef.current = latestIncomingTs;
                }
                setAllMessages((prev) => mergeMessagesByIdentity(prev, incomingMessages));
                setLoadingChats(false);
                if (incomingMessages.length === 0) return;
                void notifyIncomingMessages(incomingMessages);
                const activeChatKey = canonicalContactJid(selectedChatIdRef.current || '');
                const effectiveReadCursor = resolveRealtimeReadCursor(
                    activeProfileIdRef.current,
                    chatReadCursorByChatRef.current
                );
                if (
                    Object.keys(chatReadCursorByChatRef.current).length === 0
                    && Object.keys(effectiveReadCursor).length > 0
                ) {
                    chatReadCursorByChatRef.current = effectiveReadCursor;
                    setChatReadCursorByChat((prev) => (
                        Object.keys(prev).length === 0 ? effectiveReadCursor : prev
                    ));
                }
                setUnreadMessagesByChat((prev) => {
                    const unreadDeltaByChat = collectUnreadDeltaFromIncomingUpsert(
                        incomingMessages,
                        activeChatKey,
                        seenIncomingMessageKeysRef.current,
                        effectiveReadCursor
                    );
                    return mergeUnreadDelta(prev, unreadDeltaByChat);
                });
            }
        });

        newSocket.on('messages.history', (data) => {
            if (data.profileId === activeProfileIdRef.current) {
                lastRealtimeEventAtRef.current = Date.now();
                const historyMessages = Array.isArray(data?.messages) ? data.messages : [];
                bumpDebugSocketEvent('messages.history', `count=${historyMessages.length}`);
                setAllMessages(historyMessages);
                const latestHistoryTs = Number(data?.latestTimestamp || 0) || getLatestTimestampFromMessages(historyMessages);
                latestMessageTimestampRef.current = Math.max(latestMessageTimestampRef.current, latestHistoryTs);
                setLoadingChats(false);
                const previousSeen = seenIncomingMessageKeysRef.current;
                const activeChatKey = canonicalContactJid(selectedChatIdRef.current || '');
                const effectiveReadCursor = resolveRealtimeReadCursor(
                    activeProfileIdRef.current,
                    chatReadCursorByChatRef.current
                );
                if (
                    Object.keys(chatReadCursorByChatRef.current).length === 0
                    && Object.keys(effectiveReadCursor).length > 0
                ) {
                    chatReadCursorByChatRef.current = effectiveReadCursor;
                    setChatReadCursorByChat((prev) => (
                        Object.keys(prev).length === 0 ? effectiveReadCursor : prev
                    ));
                }
                const { nextSeen, unreadDeltaByChat } = collectUnreadDeltaFromHistory(
                    historyMessages,
                    activeChatKey,
                    previousSeen,
                    effectiveReadCursor
                );
                seenIncomingMessageKeysRef.current = nextSeen;
                if (Object.keys(unreadDeltaByChat).length > 0) {
                    setUnreadMessagesByChat((prev) => mergeUnreadDelta(prev, unreadDeltaByChat));
                }
            }
        });

        newSocket.on('messages.delta', (data) => {
            if (data.profileId !== activeProfileIdRef.current) return;
            lastRealtimeEventAtRef.current = Date.now();
            const deltaMessages = Array.isArray(data?.messages) ? data.messages : [];
            bumpDebugSocketEvent('messages.delta', `count=${deltaMessages.length}`);
            const latestDeltaTs = Number(data?.latestTimestamp || 0) || getLatestTimestampFromMessages(deltaMessages);
            if (latestDeltaTs > latestMessageTimestampRef.current) {
                latestMessageTimestampRef.current = latestDeltaTs;
            }
            if (deltaMessages.length === 0) return;

            setAllMessages((prev) => mergeMessagesByIdentity(prev, deltaMessages));
            void notifyIncomingMessages(deltaMessages);
            const activeChatKey = canonicalContactJid(selectedChatIdRef.current || '');
            const effectiveReadCursor = resolveRealtimeReadCursor(
                activeProfileIdRef.current,
                chatReadCursorByChatRef.current
            );
            setUnreadMessagesByChat((prev) => {
                const unreadDeltaByChat = collectUnreadDeltaFromIncomingUpsert(
                    deltaMessages,
                    activeChatKey,
                    seenIncomingMessageKeysRef.current,
                    effectiveReadCursor
                );
                return mergeUnreadDelta(prev, unreadDeltaByChat);
            });
        });

        newSocket.on('notification.test', (payload) => {
            const title = typeof payload?.title === 'string' && payload.title.trim()
                ? payload.title.trim()
                : 'QMessage Test Notification';
            const body = typeof payload?.body === 'string' && payload.body.trim()
                ? payload.body.trim()
                : 'Cross-device notification test';

            showChatToast(title, body);
            void playNotificationGlassSound();

            const canShowSystemNotification = 'Notification' in window && Notification.permission === 'granted';
            if (!canShowSystemNotification) return;

            const options: NotificationOptions = {
                body,
                icon: '/icons/icon-192.png',
                badge: '/icons/icon-192.png',
                tag: `test-notification:${payload?.id || Date.now()}`,
                data: {
                    url: '/'
                }
            };

            void (async () => {
                try {
                    const registration = await navigator.serviceWorker?.getRegistration?.();
                    if (registration) {
                        await registration.showNotification(title, options);
                        return;
                    }
                } catch {
                    // fallback below
                }

                try {
                    const notification = new Notification(title, options);
                    notification.onclick = () => {
                        window.focus();
                    };
                } catch {
                    // ignore unsupported Notification constructor environments
                }
            })();
        });
        newSocket.on('server.stats', (stats) => {
            lastRealtimeEventAtRef.current = Date.now();
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
            const currentUserId = typeof session?.user?.id === 'string' ? session.user.id.trim() : '';
            const eventName = typeof data?.event === 'string' ? data.event.trim().toLowerCase() : '';
            const callId = typeof data?.callId === 'string' ? data.callId.trim() : '';
            const from = typeof data?.from === 'string' ? data.from.trim() : '';
            const to = typeof data?.to === 'string' ? data.to.trim() : '';
            const normalizedStatus = typeof data?.normalizedStatus === 'string' ? data.normalizedStatus.trim().toLowerCase() : '';
            const acceptedByUserId = typeof data?.acceptedByUserId === 'string' ? data.acceptedByUserId.trim() : '';
            const acceptedByName = typeof data?.acceptedByName === 'string' ? data.acceptedByName.trim() : '';
            const acceptedAt = typeof data?.acceptedAt === 'string' ? data.acceptedAt.trim() : '';
            const claimExpiresAt = typeof data?.claimExpiresAt === 'string' ? data.claimExpiresAt.trim() : '';
            const sessionPayload = normalizeCallSessionPayload(data?.session);
            const isRinging = normalizedStatus === 'ringing';
            const normalizedPartyId = getCleanId(from || to).replace(/\D/g, '');
            const browserSession = browserVoiceCallSessionRef.current;
            const claimedByAnotherUser =
                Boolean(acceptedByUserId)
                && acceptedByUserId !== currentUserId
                && ['accepting', 'accepted', 'answered'].includes(normalizedStatus);
            let suppressIncomingCardForActiveSession = false;

            if (browserSession) {
                const sameCallId = Boolean(callId && browserSession.callId && browserSession.callId === callId);
                const sameCustomer = Boolean(normalizedPartyId && browserSession.customerWaId && browserSession.customerWaId === normalizedPartyId);
                const isMatchingBrowserSession = sameCallId || (!browserSession.callId && sameCustomer);

                if (isMatchingBrowserSession) {
                    if (claimedByAnotherUser) {
                        showToast(
                            acceptedByName
                                ? `Someone already answered this call. ${acceptedByName} is handling it.`
                                : 'Someone already answered this call.',
                            'error'
                        );
                        destroyBrowserVoiceCallSession();
                        return;
                    }

                    if (callId && browserSession.callId !== callId) {
                        browserSession.callId = callId;
                        setActiveVoiceCall((current) => current ? { ...current, callId } : current);
                    }

                    suppressIncomingCardForActiveSession =
                        Boolean(callId)
                        && ['accepting', 'accepted', 'answered'].includes(normalizedStatus)
                        && (!acceptedByUserId || acceptedByUserId === currentUserId);

                    if (
                        browserSession.direction === 'outbound'
                        && sessionPayload?.sdp_type === 'answer'
                        && sessionPayload.sdp
                        && !browserSession.remoteDescriptionApplied
                    ) {
                        browserSession.remoteDescriptionApplied = true;
                        const remoteAnswerSdp = normalizeWebRtcSdp(sessionPayload.sdp);
                        void browserSession.peerConnection
                            .setRemoteDescription({ type: 'answer', sdp: remoteAnswerSdp })
                            .then(() => {
                                setActiveVoiceCall((current) => current ? { ...current, status: 'connecting' } : current);
                            })
                            .catch((error: any) => {
                                browserSession.remoteDescriptionApplied = false;
                                pushLog(`[Calls] Failed to apply outbound answer SDP: ${error?.message || 'unknown error'}`, 'error');
                                showToast(error?.message || 'Failed to connect call audio.', 'error');
                                destroyBrowserVoiceCallSession();
                            });
                    }

                    if (normalizedStatus === 'terminated' || normalizedStatus === 'rejected' || normalizedStatus === 'missed' || normalizedStatus === 'failed' || eventName === 'terminate' || eventName === 'reject') {
                        destroyBrowserVoiceCallSession();
                    } else if (eventName === 'accept' || normalizedStatus === 'answered') {
                        setActiveVoiceCall((current) => current ? { ...current, status: 'connected' } : current);
                    } else {
                        setActiveVoiceCall((current) => current ? { ...current, status: current.status === 'connected' ? current.status : 'connecting' } : current);
                    }
                }
            }

            if (callId) {
                setIncomingCalls((prev) => {
                    if (suppressIncomingCardForActiveSession) {
                        return prev.filter((entry) => entry.callId !== callId);
                    }

                    const existing = prev.find((entry) => entry.callId === callId);
                    const nextEntry: IncomingCallState = {
                        callId,
                        profileId: typeof data?.profileId === 'string' ? data.profileId : activeProfileIdRef.current || '',
                        phoneNumberId: typeof data?.phoneNumberId === 'string' ? data.phoneNumberId : '',
                        from: from || null,
                        to: to || null,
                        direction: typeof data?.direction === 'string' ? data.direction : null,
                        contactName: typeof data?.contactName === 'string' ? data.contactName : null,
                        normalizedStatus: normalizedStatus || 'unknown',
                        timestamp: Number(data?.timestamp || Date.now() / 1000),
                        event: eventName || 'unknown',
                        session: sessionPayload,
                        bizOpaqueCallbackData: typeof data?.bizOpaqueCallbackData === 'string' ? data.bizOpaqueCallbackData : null,
                        acceptedByUserId: acceptedByUserId || null,
                        acceptedByName: acceptedByName || null,
                        acceptedAt: acceptedAt || null,
                        claimExpiresAt: claimExpiresAt || null,
                        loadingAction: existing?.loadingAction || null
                    };

                    if (isRinging || isIncomingCallClaimed(nextEntry)) {
                        if (existing) {
                            return prev.map((entry) => entry.callId === callId ? nextEntry : entry);
                        }
                        return [nextEntry, ...prev].slice(0, 5);
                    }

                    if (normalizedStatus === 'terminated' || normalizedStatus === 'rejected' || normalizedStatus === 'missed' || normalizedStatus === 'failed' || eventName === 'terminate' || eventName === 'reject') {
                        return prev.filter((entry) => entry.callId !== callId);
                    }

                    return existing
                        ? prev.map((entry) => entry.callId === callId ? nextEntry : entry)
                        : prev;
                });
            }

            if (isRinging) {
                pushLog(`[Calls] Incoming call ${callId || '-'} from ${from || 'unknown'} to ${to || '-'}.`, 'info');
                showToast('Incoming WhatsApp call received.', 'success');
                return;
            }

            if (normalizedStatus === 'terminated' || eventName === 'terminate') {
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
                lastRealtimeEventAtRef.current = Date.now();
                const contactCount = Array.isArray(data?.contacts) ? data.contacts.length : 0;
                bumpDebugSocketEvent('contacts.update', `count=${contactCount}`);
                setContacts(prev => {
                    const next = { ...prev };
                    data.contacts.forEach((c: any) => {
                        if (!c.id) return;
                        const aliasKeys = buildContactJidVariants(c.id);
                        const canonicalKey = canonicalContactJid(c.id) || c.id;
                        if (c.deleted === true) {
                            aliasKeys.forEach((key) => {
                                if (key in next) delete next[key];
                            });
                            if (canonicalKey in next) delete next[canonicalKey];
                            return;
                        }
                        const prevMeta = pickContactMetaByJid(next, canonicalKey) || {};
                        const incomingName = normalizeContactNameValue(
                            typeof c.name === 'string' ? c.name : (typeof c.notify === 'string' ? c.notify : '')
                        );
                        const nextAlias = c.alias === undefined
                            ? ((prevMeta as any).alias ?? null)
                            : (normalizeContactNameValue(c.alias) || null);
                        const nextWhatsappName = c.whatsappName === undefined
                            ? ((prevMeta as any).whatsappName ?? null)
                            : (normalizeContactNameValue(c.whatsappName) || null);
                        const resolvedName = resolveContactDisplayName(
                            nextAlias,
                            nextWhatsappName,
                            pickContactName(incomingName, (prevMeta as any).name, c.id),
                            canonicalKey
                        );
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
                            alias: nextAlias,
                            whatsappName: nextWhatsappName,
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
            setIsCreatingProfile(false);

            const profileErrorMessage = typeof data?.message === 'string' ? data.message : '';
            bumpDebugSocketEvent('profile.error', profileErrorMessage || '(empty)');
            if (profileErrorMessage) {
                setLastProfileError(profileErrorMessage);
                pushLog(profileErrorMessage, 'error');
            }

            if (profileErrorMessage.includes('Outside 24h window')) {
                setForceTemplateMode(true);
                return;
            }

            if (profileErrorMessage.includes('Profile not found for this company')) {
                const list = Array.isArray(profilesRef.current) ? profilesRef.current : [];
                const openProfiles = list.filter((profile: any) => profile?.status === 'open');
                const fallbackProfile = openProfiles[0] || list[0];
                if (fallbackProfile?.id && fallbackProfile.id !== activeProfileIdRef.current) {
                    setLastProfileError(null);
                    setActiveProfileId(fallbackProfile.id);
                    setConnectionStatus('connecting');
                    setLoadingChats(true);
                    return;
                }
                setConnectionStatus('close');
            }

            alert(profileErrorMessage || 'Profile operation failed.');
            setLoadingChats(false);
        });

        newSocket.on('workflow.started', (data) => {
            setStartingWorkflow(false);
            emitRefreshMessages();
            if (data?.workflowId) {
                pushLog(`Workflow started: ${data.workflowId}`, 'info');
            }
        });

        let socketAuthRetryInFlight = false;

        newSocket.on('connect_error', async (err: any) => {
            setProfilesLoaded(true);
            setLoadingChats(false);

            const errorMessage = typeof err?.message === 'string' ? err.message : String(err || '');
            bumpDebugSocketEvent('socket.connect_error', errorMessage || '(empty)');
            const normalizedErrorMessage = errorMessage.toLowerCase();
            const shouldTryTokenRefresh =
                normalizedErrorMessage.includes('invalid session')
                || normalizedErrorMessage.includes('authentication error')
                || normalizedErrorMessage.includes('jwt')
                || normalizedErrorMessage.includes('token');

            if (shouldTryTokenRefresh && !socketAuthRetryInFlight) {
                socketAuthRetryInFlight = true;
                try {
                    const refreshedToken = await refreshAccessTokenRef.current?.();
                    if (refreshedToken) {
                        socketAccessTokenRef.current = refreshedToken;
                        newSocket.auth = { token: refreshedToken };
                        if (!newSocket.connected) {
                            newSocket.connect();
                        }
                        pushLog('Socket session refreshed. Reconnecting...', 'info');
                        return;
                    }
                } finally {
                    socketAuthRetryInFlight = false;
                }
            }

            pushLog(`Socket connect error: ${errorMessage || err}`, 'error');
        });

        newSocket.on('disconnect', (reason: any) => {
            bumpDebugSocketEvent('socket.disconnect', trimString(reason) || String(reason || '-'));
            pushLog(`Socket disconnected: ${reason}`, 'info');
            if (document.visibilityState !== 'visible') return;
            window.setTimeout(() => {
                if (!newSocket.connected) {
                    newSocket.connect();
                }
            }, 350);
        });

        const requestActiveProfileRefresh = () => {
            if (document.visibilityState !== 'visible') return;
            if (!newSocket.connected || !activeProfileIdRef.current) return;
            emitRefreshMessages();
        };
        let refreshDebounceTimer: number | null = null;

        const scheduleActiveProfileRefresh = (delayMs = 300) => {
            if (typeof refreshDebounceTimer === 'number') {
                window.clearTimeout(refreshDebounceTimer);
            }
            refreshDebounceTimer = window.setTimeout(() => {
                refreshDebounceTimer = null;
                requestActiveProfileRefresh();
            }, delayMs);
        };

        const clearHiddenDisconnectTimer = () => {
            if (typeof hiddenSocketDisconnectTimerRef.current !== 'number') return;
            window.clearTimeout(hiddenSocketDisconnectTimerRef.current);
            hiddenSocketDisconnectTimerRef.current = null;
        };

        const handleVisibilityChange = () => {
            emitPresenceVisibility();
            if (document.visibilityState === 'visible') {
                clearHiddenDisconnectTimer();
                if (!newSocket.connected) newSocket.connect();
                scheduleActiveProfileRefresh(80);
                return;
            }
            clearHiddenDisconnectTimer();
        };

        const handleWindowFocus = () => requestActiveProfileRefresh();
        const handleWindowBlur = () => emitPresenceVisibility();
        const handlePageHide = () => emitPresenceVisibility();
        const handleOnline = () => {
            if (!newSocket.connected) newSocket.connect();
            scheduleActiveProfileRefresh(120);
        };

        const staleRefreshTimer = window.setInterval(() => {
            if (document.visibilityState !== 'visible') return;
            const profileId = activeProfileIdRef.current;
            if (!profileId) return;
            if (!newSocket.connected) {
                newSocket.connect();
                return;
            }
            const staleForMs = Date.now() - lastRealtimeEventAtRef.current;
            if (staleForMs < SOCKET_STALE_REFRESH_INTERVAL_MS) return;
            emitRefreshMessages();
        }, SOCKET_STALE_REFRESH_INTERVAL_MS);
        const visibilityHeartbeatTimer = window.setInterval(() => {
            emitPresenceVisibility();
        }, 30_000);

        document.addEventListener('visibilitychange', handleVisibilityChange);
        window.addEventListener('focus', handleWindowFocus);
        window.addEventListener('blur', handleWindowBlur);
        window.addEventListener('pagehide', handlePageHide);
        window.addEventListener('online', handleOnline);

        return () => {
            disposed = true;
            window.clearInterval(staleRefreshTimer);
            window.clearInterval(visibilityHeartbeatTimer);
            if (typeof refreshDebounceTimer === 'number') {
                window.clearTimeout(refreshDebounceTimer);
            }
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            window.removeEventListener('focus', handleWindowFocus);
            window.removeEventListener('blur', handleWindowBlur);
            window.removeEventListener('pagehide', handlePageHide);
            window.removeEventListener('online', handleOnline);
            clearHiddenDisconnectTimer();
            window.clearTimeout(connectTimer);
            newSocket.removeAllListeners();
            if (newSocket.connected) {
                newSocket.disconnect();
            }
            if (socketInstanceRef.current === newSocket) {
                socketInstanceRef.current = null;
                socketAccessTokenRef.current = '';
            }
        };
    }, [socketAccessToken]);

    // Keep active profile valid as soon as profile list is available.
    useEffect(() => {
        if (!profilesLoaded) return;
        const openProfiles = profiles.filter((profile: any) => profile?.status === 'open');
        const hasOpenProfiles = openProfiles.length > 0;
        const profileExists = activeProfileId
            ? profiles.some((profile: any) => profile?.id === activeProfileId)
            : false;

        if (!activeProfileId || !profileExists) {
            const fallbackProfile = hasOpenProfiles ? openProfiles[0] : profiles[0];
            if (fallbackProfile?.id && fallbackProfile.id !== activeProfileId) {
                setConnectionStatus('connecting');
                setLoadingChats(true);
                setActiveProfileId(fallbackProfile.id);
                return;
            }

            setLoadingChats(false);
            if (profiles.length === 0) {
                setConnectionStatus('close');
            }
            return;
        }
    }, [activeProfileId, profiles, profilesLoaded]);

    // Handle switching profile separately
    useEffect(() => {
        if (!socket || !profilesLoaded || !activeProfileId) return;
        const profileExists = profilesRef.current.some((profile: any) => profile?.id === activeProfileId);
        if (!profileExists) return;
        const lastEmit = lastSwitchProfileEmitRef.current;
        if (lastEmit.socket === socket && lastEmit.profileId === activeProfileId) return;
        lastSwitchProfileEmitRef.current = { socket, profileId: activeProfileId };

        setLoadingChats(true);
        latestMessageTimestampRef.current = 0;
        bumpDebugSocketEvent('switchProfile.emit', activeProfileId);
        socket.emit('switchProfile', activeProfileId);
    }, [socket, activeProfileId, profilesLoaded, bumpDebugSocketEvent]);

    useEffect(() => {
        if (!session || profilesLoaded) return;
        const timer = window.setTimeout(() => {
            recoverSocketConnection('Profiles load timed out. Restarting socket connection...');
            setProfilesLoaded(true);
        }, PROFILE_SYNC_TIMEOUT_MS);
        return () => window.clearTimeout(timer);
    }, [session, profilesLoaded, recoverSocketConnection]);

    useEffect(() => {
        if (!session || !activeProfileId || !loadingChats) return;
        const timer = window.setTimeout(() => {
            recoverSocketConnection('Chat sync timed out. Restarting socket connection...');
            setLoadingChats(false);
        }, CHAT_SYNC_TIMEOUT_MS);
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
        const shouldLoadWorkflows = activeView === 'chatflow'
            || (activeView === 'dashboard' && workspaceSection === 'automations');
        if (!shouldLoadWorkflows || !activeProfileId || !session?.access_token) return;

        setWorkflowsLoading(true);
        fetch(`${SOCKET_URL}/api/flows?profileId=${activeProfileId}`, {
            headers: createAuthHeaders(session.access_token)
        })
            .then(res => res.json())
            .then(data => {
                const list = Array.isArray(data?.workflows) ? data.workflows : [];
                applyWorkflowsFromServer(list);
            })
            .catch(err => console.error('Failed to fetch workflows:', err))
            .finally(() => setWorkflowsLoading(false));
    }, [activeView, activeProfileId, session?.access_token, workspaceSection]);

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
            if (!activeProfileId || !session?.access_token) {
                alert('Please sign in and select an active profile.');
                return false;
            }
            const drafts = draftOverrides || workflowDrafts;
            const normalized = normalizeWorkflowsForSave(updatedWorkflows, drafts);

            const res = await fetch(`${SOCKET_URL}/api/flows?profileId=${activeProfileId}`, {
                method: 'POST',
                headers: createAuthHeaders(session.access_token, {
                    'Content-Type': 'application/json'
                }),
                body: JSON.stringify({ workflows: normalized })
            });

            const payload = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(payload?.error || `Failed to save workflows (${res.status})`);
            }

            const refreshed = await fetch(`${SOCKET_URL}/api/flows?profileId=${activeProfileId}`, {
                headers: createAuthHeaders(session.access_token)
            });
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

    const { chatsMap, chatList } = useMemo(
        () => buildChatListComputation(allMessages, contacts, searchQuery, chatListFilter, unreadMessagesByChat),
        [allMessages, contacts, searchQuery, chatListFilter, unreadMessagesByChat]
    );

    const totalUnreadMessages = useMemo(
        () => chatList.reduce((sum, chat) => sum + Math.max(0, Number(chat.unreadCount) || 0), 0),
        [chatList]
    );
    const totalUnreadBadgeCount = Math.max(0, Math.min(999, totalUnreadMessages));
    const mobileUnreadChatCount = useMemo(
        () => chatList.reduce((sum, chat) => sum + (chat.unreadCount > 0 ? 1 : 0), 0),
        [chatList]
    );
    const mobileChatFilterTags = useMemo(() => {
        const next = new Set<string>();
        Object.values(contacts).forEach((meta) => {
            splitContactTags(meta?.tags).labelTags.forEach((tag) => {
                const normalized = tag.trim();
                if (normalized) next.add(normalized);
            });
        });
        return Array.from(next).sort((a, b) => a.localeCompare(b));
    }, [contacts]);
    const mobileTagFilterKey = mobileTagFilter.trim().toLowerCase();
    const chatListForView = useMemo(() => {
        if (!isMobile) return chatList;
        let next = chatList;
        if (mobileChatQuickFilter === 'unread') {
            next = next.filter((chat) => chat.unreadCount > 0);
        }
        if (mobileTagFilterKey) {
            next = next.filter((chat) => {
                const meta: ContactMeta = pickContactMetaByJid(contacts, chat.id) || {};
                return splitContactTags(meta.tags).labelTags.some(
                    (tag) => tag.trim().toLowerCase() === mobileTagFilterKey
                );
            });
        }
        return next;
    }, [chatList, contacts, isMobile, mobileChatQuickFilter, mobileTagFilterKey]);

    useEffect(() => {
        if (!debugOverlayEnabled) return;
        const nowMs = Date.now();
        const nextSignature = chatListForView.map((chat) => `${chat.id}:${chat.timestamp || 0}:${chat.unreadCount}`).join('|');
        const stats = chatListFlickerStatsRef.current;
        if (stats.lastSignature && stats.lastSignature !== nextSignature) {
            stats.changes += 1;
            if (nowMs - stats.lastChangedAt < 1200) {
                stats.rapidChanges += 1;
            }
            stats.lastChangedAt = nowMs;
        }
        if (!stats.lastChangedAt) {
            stats.lastChangedAt = nowMs;
        }
        stats.lastSignature = nextSignature;
    }, [chatListForView, debugOverlayEnabled]);

    const contactsList = useMemo(
        () => buildContactsListComputation(contacts, allMessages, contactsSearchQuery),
        [contacts, allMessages, contactsSearchQuery]
    );

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
    const isMobileChatOpen = isMobile && Boolean(selectedChatId);
    const selectedContact = selectedChatId ? pickContactMetaByJid(contacts, selectedChatId) : null;
    const selectedContactAlias = normalizeContactNameValue(selectedContact?.alias);
    const selectedContactWhatsappName = normalizeContactNameValue(selectedContact?.whatsappName)
        || (
            !selectedContactAlias
                ? normalizeContactNameValue(selectedContact?.name)
                : ''
        )
        || formatPhoneNumber(getCleanId(selectedChat?.id));
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
    const showMobileWindowClosedBanner = Boolean(
        isMobile
        && selectedChatId
        && selectedChat
        && !selectedChat.id.endsWith('@g.us')
        && lastInboundMs
        && !windowOpen
    );
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
    const composerQueuedMediaCount = composerQueuedMedia.length;
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
        setComposerQueuedMedia([]);
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

    const uploadComposerMediaFiles = useCallback(async (
        files: File[],
        forcedType?: 'image' | 'video' | 'document'
    ) => {
        const fileQueue = Array.isArray(files) ? files.filter(Boolean) : [];
        if (fileQueue.length === 0) return;
        if (!activeProfileId || !session?.access_token) {
            setComposerMediaError('Select a profile and login before uploading media.');
            return;
        }
        const queue = forcedType === 'video' ? fileQueue.slice(0, 1) : fileQueue;
        const initialType = forcedType || inferComposerMediaType(queue[0]);
        const uploadedPayloads: SendMediaPayload[] = [];
        let uploadFailedCount = 0;
        let firstUploadError = '';

        setShowMediaComposer(true);
        setComposerMediaType(initialType);
        setComposerQueuedMedia([]);
        setComposerMediaUploading(true);
        setComposerMediaError(null);

        try {
            for (const file of queue) {
                const mediaType = forcedType || inferComposerMediaType(file);
                try {
                    const uploaded = await uploadFileToWabaMedia({
                        apiBaseUrl: SOCKET_URL,
                        profileId: activeProfileId,
                        sessionToken: session.access_token,
                        file
                    });
                    const sendPayload = createSendMediaPayload(
                        mediaType,
                        uploaded.mediaId,
                        '',
                        '',
                        mediaType === 'document' ? (uploaded.fileName || 'document') : ''
                    );
                    if (!sendPayload) continue;
                    if (uploadedPayloads.length === 0) {
                        const previewUrl = URL.createObjectURL(file);
                        setComposerMediaUrl((prev) => {
                            if (prev.startsWith('blob:')) {
                                URL.revokeObjectURL(prev);
                            }
                            return previewUrl;
                        });
                        setComposerMediaType(mediaType);
                        setComposerMediaId(uploaded.mediaId);
                        setComposerMediaAssetKey('');
                        setComposerMediaMimeType(uploaded.mimeType);
                        setComposerMediaSizeBytes(uploaded.sizeBytes);
                        setComposerMediaFilename(mediaType === 'document' ? (uploaded.fileName || 'document') : '');
                    }
                    uploadedPayloads.push(sendPayload);
                } catch (error: any) {
                    uploadFailedCount += 1;
                    if (!firstUploadError) firstUploadError = error?.message || 'Upload failed.';
                }
            }

            if (uploadedPayloads.length === 0) {
                setComposerMediaError(firstUploadError || 'Upload failed.');
                setComposerMediaId('');
                setComposerMediaAssetKey('');
                setComposerMediaMimeType('');
                setComposerMediaSizeBytes(null);
                return;
            }

            setComposerQueuedMedia(uploadedPayloads.slice(1));
            if (uploadFailedCount > 0) {
                setComposerMediaError(`${uploadFailedCount} file${uploadFailedCount > 1 ? 's' : ''} failed to upload.`);
            } else {
                setComposerMediaError(null);
            }
        } finally {
            setComposerMediaUploading(false);
        }
    }, [activeProfileId, inferComposerMediaType, session?.access_token]);

    const handleComposerMediaInputChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files || []);
        event.target.value = '';
        if (files.length === 0) return;
        const messageType =
            composerMediaType === 'image' || composerMediaType === 'video' || composerMediaType === 'document'
                ? composerMediaType
                : undefined;
        void uploadComposerMediaFiles(files, messageType);
    }, [composerMediaType, uploadComposerMediaFiles]);

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
        const files = Array.from(event.dataTransfer?.files || []);
        if (files.length === 0) return;
        void uploadComposerMediaFiles(files);
    }, [canSendText, uploadComposerMediaFiles]);

    const openComposerMediaPicker = useCallback((messageType: 'image' | 'video' | 'document') => {
        setShowMediaComposer(true);
        if (composerMediaType !== messageType) {
            resetComposerMedia(messageType);
        } else {
            setComposerQueuedMedia([]);
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
        const mediaFallbackType: 'image' | 'video' | 'document' = quickReplyType === 'text' ? 'image' : quickReplyType;
        let normalizedMediaItems = quickReplyType === 'text'
            ? []
            : normalizeQuickReplyMediaItems(item.media_items, mediaFallbackType);
        if (quickReplyType !== 'text' && normalizedMediaItems.length === 0) {
            normalizedMediaItems = buildLegacyQuickReplyMediaItems(item, mediaFallbackType);
        }
        const sendMediaList = normalizedMediaItems
            .map((mediaItem) => buildSendMediaPayloadFromQuickReplyMediaItem(mediaItem, mediaFallbackType))
            .filter((payload): payload is SendMediaPayload => Boolean(payload));
        const firstMediaPayload = sendMediaList[0] || null;
        const firstMediaMeta = normalizedMediaItems[0] || null;
        if (!text && quickReplyType === 'text') return;

        if (quickReplyType === 'text' || !firstMediaPayload) {
            resetComposerMedia('none');
            setComposerQueuedMedia([]);
        } else {
            setComposerMediaType(firstMediaPayload.type);
            setComposerMediaUrl(firstMediaPayload.url || '');
            setComposerMediaId(firstMediaPayload.id || '');
            setComposerMediaAssetKey(firstMediaPayload.assetKey || '');
            setComposerMediaMimeType(
                firstMediaMeta
                    ? normalizeQuickReplyMediaMimeType(firstMediaMeta.media_mime_type)
                    : ''
            );
            setComposerMediaSizeBytes(
                firstMediaMeta
                    ? normalizeQuickReplyMediaSizeBytes(firstMediaMeta.media_size_bytes)
                    : null
            );
            setComposerMediaFilename(
                firstMediaPayload.type === 'document'
                    ? (firstMediaPayload.filename || normalizeQuickReplyMediaFilename(firstMediaMeta?.media_filename) || 'document')
                    : ''
            );
            setComposerQueuedMedia(sendMediaList.slice(1));
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

    const buildOutgoingPayloadFromMessage = useCallback((msg: Message): OutgoingMessagePayload | null => {
        if (!msg?.key?.fromMe) return null;
        const text = trimString(msg?.message?.conversation) || trimString(msg?.message?.extendedTextMessage?.text);
        const media = buildOutgoingMediaFromMessage(msg);
        if (media) return { text, media };
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

        const resendTempId = createClientTempMessageId();
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
                    setAllMessages((prev) => markMessageStatusById(prev, resendTempId, 'failed'));
                    return;
                }
                const realMessageId = trimString(ack?.data?.messageId);
                if (!realMessageId) return;
                setAllMessages((prev) => replaceTempMessageIdAndStatus(prev, resendTempId, realMessageId, 'sent'));
            }
        );
    }, [activeProfileId, allMessages, buildOutgoingPayloadFromMessage, selectedChatId, socket]);

    const handleSendMessage = () => {
        if (!socket || !activeProfileId || !selectedChatId) return;
        if (composerMediaUploading) return;
        const outgoingText = messageText.trim();
        const primaryMedia = buildSendMediaFromComposerState(
            composerMediaType,
            composerMediaId.trim(),
            composerMediaUrl.trim(),
            composerMediaAssetKey.trim(),
            composerMediaFilename.trim()
        );
        const queuedMedia = composerQueuedMedia.filter((entry) => (
            Boolean(entry?.id || entry?.url || entry?.assetKey)
        ));
        const mediaBatch = primaryMedia ? [primaryMedia, ...queuedMedia] : queuedMedia;

        if (!outgoingText && mediaBatch.length === 0) return;

        const pendingMessages: Message[] = [];
        const emitSend = (text: string, media: SendMediaPayload | null) => {
            const tempMessageId = createClientTempMessageId();
            socket.emit(
                'sendMessage',
                {
                    profileId: activeProfileId,
                    jid: selectedChatId,
                    text,
                    ...(media ? { media } : {}),
                    clientTempId: tempMessageId
                },
                (ack: any) => {
                    if (!ack?.success) {
                        setAllMessages((prev) => markMessageStatusById(prev, tempMessageId, 'failed'));
                        return;
                    }
                    const realMessageId = trimString(ack?.data?.messageId);
                    if (!realMessageId) return;
                    setAllMessages((prev) => replaceTempMessageIdAndStatus(prev, tempMessageId, realMessageId, 'sent'));
                }
            );
            pendingMessages.push(buildOptimisticPendingMessage({
                tempMessageId,
                remoteJid: selectedChatId,
                outgoingText: text,
                sendMedia: media,
                agentUserId: session?.user?.id,
                agentName: currentAgentName
            }));
        };

        if (mediaBatch.length === 0) {
            emitSend(outgoingText, null);
        } else {
            mediaBatch.forEach((media, index) => {
                emitSend(index === 0 ? outgoingText : '', media);
            });
        }

        if (pendingMessages.length > 0) {
            setAllMessages((prev) => [...pendingMessages.reverse(), ...prev]);
        }
        persistDraft('', activeProfileId, selectedChatId);
        setMessageText('');
        resetComposerMedia('none');
    };

    const openSettingsFromMore = useCallback(() => {
        if (isUiFeatureHidden(SETTINGS_UI_FEATURE_KEY)) return;
        setShowAnalytics(false);
        setShowContactInfo(false);
        setWorkspaceSection('team-inbox');
        if (isMobile) {
            setSelectedChatId(null);
        }
        requestAnimationFrame(() => {
            setActiveView('settings');
        });
    }, [isMobile, isUiFeatureHidden]);

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

    const fetchSelectedCallPermission = useCallback(async (options?: { silent?: boolean }): Promise<CallPermissionUiState | null> => {
        if (!session?.access_token) {
            if (!options?.silent) showToast('Please login again before checking call permission.', 'error');
            return null;
        }
        if (!activeProfileId) {
            if (!options?.silent) showToast('No active profile selected.', 'error');
            return null;
        }
        if (!selectedChatId) return null;
        if (selectedChatId.endsWith('@g.us')) {
            setSelectedCallPermission(null);
            if (!options?.silent) showToast('Calls are not supported for groups yet.', 'error');
            return null;
        }

        const userWaId = getCleanId(selectedChatId).replace(/\D/g, '');
        if (!userWaId) {
            if (!options?.silent) showToast('This contact has no valid WhatsApp ID for calling.', 'error');
            return null;
        }

        if (!options?.silent) {
            setCallPermissionLoading(true);
        }
        try {
            const params = new URLSearchParams({
                profileId: activeProfileId,
                user_wa_id: userWaId
            });
            const response = await fetch(`${SOCKET_URL}/api/waba/call-permissions?${params.toString()}`, {
                method: 'GET',
                headers: createAuthHeaders(session.access_token)
            });
            const payload = await response.json().catch(() => null);
            if (!response.ok || payload?.success === false) {
                throw new Error(payload?.error || `Failed with status ${response.status}`);
            }

            const summary = extractCallPermissionSummary(payload);
            setSelectedCallPermission(summary);
            return summary;
        } catch (error: any) {
            if (!options?.silent) {
                const rawMessage = String(error?.message || '').toLowerCase();
                if (isCallingApiNotEnabledError(rawMessage)) {
                    showToast('Meta Calling API is not enabled for this phone number yet. Enable WhatsApp Cloud Calling for this number first.', 'error');
                } else {
                    showToast(error?.message || 'Failed to check call permission.', 'error');
                }
            }
            return null;
        } finally {
            if (!options?.silent) {
                setCallPermissionLoading(false);
            }
        }
    }, [activeProfileId, selectedChatId, session?.access_token, showToast]);

    const handleRequestCallPermission = useCallback(async () => {
        if (!session?.access_token) {
            showToast('Please login again before requesting call permission.', 'error');
            return;
        }
        if (!activeProfileId || !selectedChatId) return;
        if (selectedChatId.endsWith('@g.us')) {
            showToast('Calls are not supported for groups yet.', 'error');
            return;
        }

        const userWaId = getCleanId(selectedChatId).replace(/\D/g, '');
        if (!userWaId) {
            showToast('This contact has no valid WhatsApp ID for calling.', 'error');
            return;
        }

        setCallPermissionRequestLoading(true);
        try {
            const response = await fetch(`${SOCKET_URL}/api/whatsapp/calling/request-permission`, {
                method: 'POST',
                headers: createAuthHeaders(session.access_token, {
                    'Content-Type': 'application/json'
                }),
                body: JSON.stringify({
                    profileId: activeProfileId,
                    user_wa_id: userWaId,
                    body_text: `We would like to call you to help support your request.`
                })
            });
            const payload = await response.json().catch(() => null);
            if (!response.ok || payload?.success === false) {
                throw new Error(payload?.error || `Failed with status ${response.status}`);
            }

            showToast('Call permission request sent.', 'success');
            pushLog(`[Calls] Permission request sent to ${userWaId}.`, 'info');
            setSelectedCallPermission((current) => current ? { ...current, canRequestPermission: false, permissionStatus: current.permissionStatus || 'pending' } : {
                permissionStatus: 'pending',
                canStartCall: false,
                canRequestPermission: false,
                expirationTime: null,
                storedPermissionStatus: null,
                storedUpdatedAt: null
            });
            void fetchSelectedCallPermission({ silent: true });
        } catch (error: any) {
            showToast(error?.message || 'Failed to send call permission request.', 'error');
        } finally {
            setCallPermissionRequestLoading(false);
        }
    }, [activeProfileId, selectedChatId, session?.access_token, showToast, pushLog, fetchSelectedCallPermission]);

    const fetchStoredCallDetails = useCallback(async (callId: string) => {
        if (!activeProfileId) return null;
        const params = new URLSearchParams({
            profileId: activeProfileId
        });
        const response = await fetchWithSessionAuth(
            `${SOCKET_URL}/api/whatsapp/calls/${encodeURIComponent(callId)}?${params.toString()}`,
            { method: 'GET' }
        );
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.success === false) {
            const apiError = parseCallApiError(payload, response.status, `Failed with status ${response.status}`);
            const error: any = new Error(formatCallApiErrorMessage(apiError));
            error.callApiError = apiError;
            throw error;
        }
        return payload?.data?.call || null;
    }, [activeProfileId, fetchWithSessionAuth]);

    const handleAcceptIncomingCall = useCallback(async (callId: string) => {
        if (!session?.access_token) {
            showToast('Please login again before accepting calls.', 'error');
            return;
        }
        if (!activeProfileId) {
            showToast('No active profile selected.', 'error');
            return;
        }
        if (browserVoiceCallSessionRef.current || activeVoiceCallRef.current) {
            showToast('Finish the current call before answering another one.', 'error');
            return;
        }

        const currentUserId = trimString(session?.user?.id);
        const existingCall = incomingCalls.find((entry) => entry.callId === callId) || null;
        const fallbackCall = existingCall || {
            callId,
            profileId: activeProfileId,
            phoneNumberId: '',
            from: null,
            to: null,
            direction: 'inbound',
            contactName: null,
            normalizedStatus: 'ringing',
            timestamp: Math.floor(Date.now() / 1000),
            event: 'connect',
            session: null,
            bizOpaqueCallbackData: null,
            acceptedByUserId: null,
            acceptedByName: null,
            acceptedAt: null,
            claimExpiresAt: null,
            loadingAction: null
        };

        setIncomingCalls((prev) => prev.map((entry) => entry.callId === callId ? { ...entry, loadingAction: 'accept' } : entry));

        try {
            let sessionPayload = normalizeCallSessionPayload(fallbackCall.session);
            let phoneNumberId = fallbackCall.phoneNumberId;
            let fromWaId = fallbackCall.from;
            let remoteLabel = fallbackCall.contactName || formatPhoneNumber(fallbackCall.from || '') || fallbackCall.from || 'Unknown caller';
            const storedCall = await fetchStoredCallDetails(callId);
            const storedStatus = trimString(storedCall?.status).toLowerCase();
            const storedAcceptedByUserId = trimString(storedCall?.accepted_by_user_id);
            const storedAcceptedByName = trimString(storedCall?.accepted_by_name);
            const storedAcceptedAt = trimString(storedCall?.accepted_at);
            const storedClaimExpiresAt = trimString(storedCall?.claim_expires_at);

            if (storedCall) {
                const storedSessionPayload = normalizeCallSessionPayload(storedCall?.session);
                if (storedSessionPayload?.sdp_type === 'offer') {
                    sessionPayload = storedSessionPayload;
                }
                phoneNumberId = trimString(storedCall.phone_number_id) || phoneNumberId;
                fromWaId = trimString(storedCall.customer_id) || fromWaId;
                remoteLabel = trimString(storedCall.customer_name) || remoteLabel;

                setIncomingCalls((prev) => prev.map((entry) => entry.callId === callId ? {
                    ...entry,
                    phoneNumberId: trimString(storedCall.phone_number_id) || entry.phoneNumberId,
                    from: trimString(storedCall.customer_id) || entry.from,
                    contactName: trimString(storedCall.customer_name) || entry.contactName,
                    normalizedStatus: storedStatus || entry.normalizedStatus,
                    session: storedSessionPayload?.sdp_type === 'offer'
                        ? storedSessionPayload
                        : entry.session,
                    acceptedByUserId: storedAcceptedByUserId || null,
                    acceptedByName: storedAcceptedByName || null,
                    acceptedAt: storedAcceptedAt || null,
                    claimExpiresAt: storedClaimExpiresAt || null,
                    loadingAction: 'accept'
                } : entry));
            }

            if (['accepting', 'accepted', 'answered'].includes(storedStatus)) {
                if (storedAcceptedByUserId && storedAcceptedByUserId !== currentUserId) {
                    const answeredMessage = storedAcceptedByName
                        ? `Someone already answered this call. ${storedAcceptedByName} is handling it.`
                        : 'Someone already answered this call.';
                    showToast(answeredMessage, 'error');
                    setIncomingCalls((prev) => prev.map((entry) => entry.callId === callId ? {
                        ...entry,
                        normalizedStatus: storedStatus,
                        acceptedByUserId: storedAcceptedByUserId || entry.acceptedByUserId,
                        acceptedByName: storedAcceptedByName || entry.acceptedByName,
                        acceptedAt: storedAcceptedAt || entry.acceptedAt,
                        claimExpiresAt: storedClaimExpiresAt || entry.claimExpiresAt,
                        loadingAction: null
                    } : entry));
                    return;
                }
                showToast('You already answered this call in another window.', 'error');
                setIncomingCalls((prev) => prev.map((entry) => entry.callId === callId ? {
                    ...entry,
                    normalizedStatus: storedStatus,
                    acceptedByUserId: storedAcceptedByUserId || currentUserId || entry.acceptedByUserId,
                    acceptedByName: storedAcceptedByName || entry.acceptedByName,
                    acceptedAt: storedAcceptedAt || entry.acceptedAt,
                    claimExpiresAt: storedClaimExpiresAt || entry.claimExpiresAt,
                    loadingAction: null
                } : entry));
                return;
            }

            if (['rejected', 'terminated', 'missed', 'failed'].includes(storedStatus)) {
                showToast(`This call is no longer available (${getIncomingCallStatusLabel(storedStatus)}).`, 'error');
                setIncomingCalls((prev) => prev.filter((entry) => entry.callId !== callId));
                return;
            }

            if (!sessionPayload?.sdp || sessionPayload.sdp_type !== 'offer') {
                throw new Error('This call does not have a valid SDP offer yet. Wait a moment and try again.');
            }

            const customerWaId = getCleanId(fromWaId || '').replace(/\D/g, '') || null;
            const browserSession = await createBrowserVoiceCallSession({
                direction: 'inbound',
                profileId: activeProfileId,
                customerWaId,
                remoteLabel,
                callId
            });

            const remoteOfferSdp = normalizeWebRtcSdp(sessionPayload.sdp);
            await browserSession.peerConnection.setRemoteDescription({
                type: 'offer',
                sdp: remoteOfferSdp
            });
            browserSession.remoteDescriptionApplied = true;

            const answer = await browserSession.peerConnection.createAnswer();
            await browserSession.peerConnection.setLocalDescription(answer);
            await waitForIceGatheringComplete(browserSession.peerConnection);

            const finalSdp = normalizeWebRtcSdp(browserSession.peerConnection.localDescription?.sdp);
            if (!finalSdp) {
                throw new Error('Failed to generate a local audio answer.');
            }

            const requestBody = JSON.stringify({
                profileId: activeProfileId,
                phoneNumberId: phoneNumberId || undefined,
                session: {
                    sdp_type: 'answer',
                    sdp: finalSdp
                }
            });

            const preAcceptResponse = await fetchWithSessionAuth(`${SOCKET_URL}/api/whatsapp/calls/${encodeURIComponent(callId)}/pre-accept`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: requestBody
            });
            const preAcceptPayload = await preAcceptResponse.json().catch(() => null);
            if (!preAcceptResponse.ok || preAcceptPayload?.success === false) {
                const apiError = parseCallApiError(preAcceptPayload, preAcceptResponse.status, `Failed with status ${preAcceptResponse.status}`);
                const error: any = new Error(formatCallApiErrorMessage(apiError));
                error.callApiError = apiError;
                throw error;
            }
            browserSession.preAcceptSent = true;
            browserSession.acceptLockToken = trimString(preAcceptPayload?.data?.accept_lock_token || preAcceptPayload?.data?.acceptLockToken);
            if (!browserSession.acceptLockToken) {
                throw new Error('Call accept lock was not returned by the server.');
            }

            const acceptResponse = await fetchWithSessionAuth(`${SOCKET_URL}/api/whatsapp/calls/${encodeURIComponent(callId)}/accept`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    profileId: activeProfileId,
                    phoneNumberId: phoneNumberId || undefined,
                    session: {
                        sdp_type: 'answer',
                        sdp: finalSdp
                    },
                    acceptLockToken: browserSession.acceptLockToken
                })
            });
            const acceptPayload = await acceptResponse.json().catch(() => null);
            if (!acceptResponse.ok || acceptPayload?.success === false) {
                const apiError = parseCallApiError(acceptPayload, acceptResponse.status, `Failed with status ${acceptResponse.status}`);
                const error: any = new Error(formatCallApiErrorMessage(apiError));
                error.callApiError = apiError;
                throw error;
            }
            browserSession.acceptSent = true;

            setActiveVoiceCall((current) => current ? {
                ...current,
                callId,
                status: 'connecting',
                lastError: null
            } : current);
            setIncomingCalls((prev) => prev.filter((entry) => entry.callId !== callId));
            pushLog(`[Calls] Accepting call ${callId}.`, 'info');
            showToast('Call accepted. Audio is connecting.', 'success');
        } catch (error: any) {
            destroyBrowserVoiceCallSession();
            const micMessage = formatMicrophoneCallErrorMessage(error);
            const apiError = error?.callApiError || null;
            const finalMessage = micMessage || (apiError ? formatCallApiErrorMessage(apiError) : (error?.message || 'Failed to accept incoming call.'));
            showToast(finalMessage, 'error');
            pushLog(`[Calls] Accept failed for ${callId}: ${finalMessage}`, 'error');
            setIncomingCalls((prev) => prev.map((entry) => entry.callId === callId ? { ...entry, loadingAction: null } : entry));
        }
    }, [
        activeProfileId,
        createBrowserVoiceCallSession,
        destroyBrowserVoiceCallSession,
        fetchStoredCallDetails,
        fetchWithSessionAuth,
        incomingCalls,
        pushLog,
        session?.access_token,
        showToast,
        waitForIceGatheringComplete
    ]);

    const handleIncomingCallAction = useCallback(async (callId: string, action: 'accept' | 'reject' | 'terminate') => {
        if (action === 'accept') {
            await handleAcceptIncomingCall(callId);
            return;
        }
        if (!session?.access_token) {
            showToast('Please login again before managing calls.', 'error');
            return;
        }
        if (!activeProfileId) {
            showToast('No active profile selected.', 'error');
            return;
        }

        setIncomingCalls((prev) => prev.map((entry) => entry.callId === callId ? { ...entry, loadingAction: action } : entry));
        try {
            const response = await fetchWithSessionAuth(`${SOCKET_URL}/api/whatsapp/calls/${encodeURIComponent(callId)}/${action}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    profileId: activeProfileId
                })
            });
            const payload = await response.json().catch(() => null);
            if (!response.ok || payload?.success === false) {
                const apiError = parseCallApiError(payload, response.status, `Failed with status ${response.status}`);
                const error: any = new Error(formatCallApiErrorMessage(apiError));
                error.callApiError = apiError;
                throw error;
            }

            showToast(action === 'reject' ? 'Incoming call rejected.' : 'Call terminated.', 'success');
            setIncomingCalls((prev) => prev.filter((entry) => entry.callId !== callId));
        } catch (error: any) {
            const apiError = error?.callApiError || null;
            const finalMessage = apiError ? formatCallApiErrorMessage(apiError) : (error?.message || `Failed to ${action} call.`);
            showToast(finalMessage, 'error');
            setIncomingCalls((prev) => prev.map((entry) => entry.callId === callId ? { ...entry, loadingAction: null } : entry));
        }
    }, [activeProfileId, fetchWithSessionAuth, handleAcceptIncomingCall, session?.access_token, showToast]);

    const startOutboundVoiceCall = useCallback(async (userWaId: string, remoteLabel: string) => {
        if (!session?.access_token) {
            showToast('Please login again before starting a call.', 'error');
            return;
        }
        if (!activeProfileId) {
            showToast('No active profile selected.', 'error');
            return;
        }
        if (browserVoiceCallSessionRef.current || activeVoiceCallRef.current) {
            showToast('Finish the current call before starting another one.', 'error');
            return;
        }

        try {
            const browserSession = await createBrowserVoiceCallSession({
                direction: 'outbound',
                profileId: activeProfileId,
                customerWaId: userWaId,
                remoteLabel
            });

            const offer = await browserSession.peerConnection.createOffer({
                offerToReceiveAudio: true
            });
            await browserSession.peerConnection.setLocalDescription(offer);
            await waitForIceGatheringComplete(browserSession.peerConnection);

            const finalSdp = normalizeWebRtcSdp(browserSession.peerConnection.localDescription?.sdp);
            if (!finalSdp) {
                throw new Error('Failed to generate a local call offer.');
            }

            const response = await fetchWithSessionAuth(`${SOCKET_URL}/api/whatsapp/calls/connect`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    profileId: activeProfileId,
                    customer_id: userWaId,
                    session: {
                        sdp_type: 'offer',
                        sdp: finalSdp
                    }
                })
            });
            const payload = await response.json().catch(() => null);
            if (!response.ok || payload?.success === false) {
                throw new Error(payload?.error || `Failed with status ${response.status}`);
            }

            const storedCall = payload?.data?.stored_call || null;
            const callId = trimString(
                payload?.data?.call_id
                || storedCall?.call_id
                || payload?.data?.response?.call_id
                || payload?.data?.response?.id
            ) || null;

            browserSession.callId = callId;
            setActiveVoiceCall((current) => current ? {
                ...current,
                callId,
                status: 'connecting',
                lastError: null
            } : current);
            pushLog(`[Calls] Outbound voice call started for ${userWaId}.`, 'info');
            showToast('Voice call started. Waiting for answer.', 'success');
        } catch (error: any) {
            destroyBrowserVoiceCallSession();
            showToast(error?.message || 'Failed to start voice call.', 'error');
            pushLog(`[Calls] Failed to start outbound voice call: ${error?.message || 'unknown error'}`, 'error');
        }
    }, [
        activeProfileId,
        createBrowserVoiceCallSession,
        destroyBrowserVoiceCallSession,
        fetchWithSessionAuth,
        pushLog,
        session?.access_token,
        showToast,
        waitForIceGatheringComplete
    ]);

    const toggleActiveVoiceCallMute = useCallback(() => {
        const browserSession = browserVoiceCallSessionRef.current;
        const callState = activeVoiceCallRef.current;
        if (!browserSession || !callState) return;
        const nextMuted = !callState.muted;
        browserSession.localStream.getAudioTracks().forEach((track) => {
            track.enabled = !nextMuted;
        });
        setActiveVoiceCall((current) => current ? { ...current, muted: nextMuted } : current);
    }, []);

    const handleEndActiveVoiceCall = useCallback(async () => {
        const currentCall = activeVoiceCallRef.current;
        if (!currentCall) return;

        setActiveVoiceCall((existing) => existing ? { ...existing, status: 'ending' } : existing);
        try {
            if (currentCall.callId && session?.access_token && activeProfileId) {
                const response = await fetchWithSessionAuth(`${SOCKET_URL}/api/whatsapp/calls/${encodeURIComponent(currentCall.callId)}/terminate`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        profileId: activeProfileId
                    })
                });
                const payload = await response.json().catch(() => null);
                if (!response.ok || payload?.success === false) {
                    throw new Error(payload?.error || `Failed with status ${response.status}`);
                }
            }
        } catch (error: any) {
            showToast(error?.message || 'Failed to terminate the active call cleanly.', 'error');
        } finally {
            destroyBrowserVoiceCallSession();
        }
    }, [activeProfileId, destroyBrowserVoiceCallSession, fetchWithSessionAuth, session?.access_token, showToast]);

    const handleCallAction = useCallback(async (kind: 'voice' | 'video') => {
        const userWaId = selectedChatId ? getCleanId(selectedChatId).replace(/\D/g, '') : '';
        setCallActionLoading(kind);
        try {
            const summary = await fetchSelectedCallPermission();
            if (!summary) return;
            if (kind === 'video') {
                showToast('Video calling is not implemented yet. Use voice call for live pickup.', 'error');
                return;
            }

            if ((summary.permissionStatus === 'granted' || summary.permissionStatus === 'temporary' || summary.permissionStatus === 'permanent') && summary.canStartCall) {
                const remoteLabel =
                    pickContactMetaByJid(contacts, selectedChatId || '')?.name
                    || formatPhoneNumber(userWaId)
                    || userWaId;
                await startOutboundVoiceCall(userWaId, remoteLabel);
                return;
            }

            const feedback = getCallPermissionFeedback(kind, summary.permissionStatus, summary.canStartCall, summary.canRequestPermission, userWaId);
            showToast(feedback.message, feedback.tone);
            if (feedback.logMessage) {
                pushLog(feedback.logMessage, 'info');
            }
        } finally {
            setCallActionLoading(null);
        }
    }, [contacts, fetchSelectedCallPermission, pushLog, selectedChatId, showToast, startOutboundVoiceCall]);

    useEffect(() => {
        if (!activeProfileId || !selectedChatId || selectedChatId.endsWith('@g.us')) {
            setSelectedCallPermission(null);
            return;
        }
        void fetchSelectedCallPermission({ silent: true });
    }, [activeProfileId, selectedChatId, fetchSelectedCallPermission]);

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
        const nextDrafts = ensureWorkflowDraftEntries(nextWorkflows, workflowDrafts);

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
        const nextDrafts = ensureWorkflowDraftEntries(nextWorkflows, workflowDrafts);

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
        const copiedId = createUniqueWorkflowId(existingIds);

        const existingNames = new Set(
            automationWorkflows
                .map((workflow: any) => (typeof workflow?.name === 'string' ? workflow.name.trim() : ''))
                .filter(Boolean)
                .map((name: string) => name.toLowerCase())
        );
        const sourceName = trimString(sourceWorkflow?.name);
        const copiedName = createCopiedWorkflowName(existingNames, sourceName);
        const { copiedWorkflow, copiedActions } = buildCopiedWorkflowRecord(
            sourceWorkflow,
            copiedId,
            copiedName,
            buildBuilderFromActions
        );

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
        const nextAlias = contactDraftName.trim();

        // Optimistic local update so labels appear immediately before socket round-trip.
        setContacts((prev) => {
            const next = { ...prev };
            const prevMeta = pickContactMetaByJid(next, canonicalKey) || existingContact || {};
            const currentWhatsappName = normalizeContactNameValue((prevMeta as any).whatsappName);
            aliasKeys.forEach((key) => {
                if (key !== canonicalKey) delete next[key];
            });
            next[canonicalKey] = {
                ...prevMeta,
                name: resolveContactDisplayName(
                    nextAlias,
                    currentWhatsappName,
                    (prevMeta as any).name,
                    canonicalKey
                ),
                alias: nextAlias || null,
                whatsappName: currentWhatsappName || null,
                tags: mergedTags
            };
            return next;
        });

        socket.emit('contact.update', {
            profileId: activeProfileId,
            jid: selectedChatId,
            alias: nextAlias,
            tags: mergedTags
        });
        setContactDirty(false);
        pushLog('Alias saved.', 'info');
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
        let namedBodyAttributes: TemplateBodyAttributePayload[] = [];
        let templatePreviewText = '';
        const parsedTemplateInput = parseTemplateComponentsInput(templateComponents);
        if (parsedTemplateInput.error) {
            alert(parsedTemplateInput.error);
            return;
        }
        if (parsedTemplateInput.components) {
            components = parsedTemplateInput.components;
            const previewBodyValues = extractTemplateBodyParameterValues(components);
            templatePreviewText = renderTemplatePreviewText(selectedTemplateBody?.text, previewBodyValues);
        } else if (selectedTemplateOption) {
            const templateBuildResult = buildTemplateFromSelection({
                selectedTemplateHeaderFormat,
                requiredTemplateHeaderAttributeCount,
                templateHeaderAttributes,
                templateHeaderMediaUrl,
                templateHeaderDocumentFilename,
                requiredTemplateBodyAttributeCount,
                templateBodyAttributes,
                templateBodyAttributeNames,
                selectedTemplateBodyText: selectedTemplateBody?.text
            });
            if (templateBuildResult.error) {
                alert(templateBuildResult.error);
                return;
            }
            components = templateBuildResult.components;
            namedBodyAttributes = templateBuildResult.bodyAttributes;
            templatePreviewText = renderTemplatePreviewText(
                selectedTemplateBody?.text,
                templateBuildResult.bodyAttributes.map((entry) => entry.value)
            );
        }

        socket.emit('sendTemplate', {
            profileId: activeProfileId,
            jid: selectedChatId,
            name: templateName.trim(),
            language: templateLanguage.trim() || 'en_US',
            components,
            bodyAttributes: namedBodyAttributes,
            previewText: templatePreviewText
        });
        setShowTemplateComposer(false);
    };

    const handleSwitchProfile = (id: string) => {
        setActiveProfileId(id);
        setAllMessages([]);
        setContacts({});
        setSelectedChatId(null);
        setUnreadMessagesByChat({});
        setChatReadCursorByChat({});
        seenIncomingMessageKeysRef.current.clear();
        setShowTemplateComposer(false);
        setConnectionStatus('connecting'); // Anticipate status update
        setLoadingChats(true);
        lastSwitchProfileEmitRef.current = { socket: null, profileId: null };
        setShowProfileMenu(false);
    };

    const handleAddProfile = () => {
        setShowAddProfileModal(true);
    };

    const submitAddProfile = () => {
        if (newProfileName.trim() && !isCreatingProfile) {
            setIsCreatingProfile(true);
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

    const handleDeleteProfile = (profileId: string, _name: string) => {
        socket?.emit('deleteProfile', profileId);
        if (activeProfileId === profileId) {
            const remainingProfiles = profiles.filter((p) => p.id !== profileId);
            const openProfiles = remainingProfiles.filter((p: any) => p?.status === 'open');
            const next = openProfiles[0] || remainingProfiles[0];
            if (next) {
                handleSwitchProfile(next.id);
            } else {
                setActiveProfileId(null);
                setAllMessages([]);
                setContacts({});
                setSelectedChatId(null);
                setUnreadMessagesByChat({});
                setChatReadCursorByChat({});
                setLoadingChats(false);
                setConnectionStatus('close');
            }
        }
    };

    const handleOpenChat = useCallback((chatId: string) => {
        setSelectedChatId(chatId);
        markChatAsRead(chatId);
        setChatOpenNonce((prev) => prev + 1);
    }, [markChatAsRead]);

    useEffect(() => {
        const consumeNotificationChatParam = (rawUrl: string | null | undefined) => {
            if (!rawUrl) return;
            let nextChatId = '';
            try {
                const parsed = new URL(rawUrl, window.location.origin);
                nextChatId = parsed.searchParams.get('chat') || '';
                if (!nextChatId) return;
                parsed.searchParams.delete('chat');
                window.history.replaceState({}, '', parsed.pathname + parsed.search + parsed.hash);
            } catch {
                return;
            }

            setShowAnalytics(false);
            setWorkspaceSection('team-inbox');
            handleOpenChat(nextChatId);
        };

        consumeNotificationChatParam(window.location.href);

        const handleNativePushAction = (event: Event) => {
            const detail = (event as CustomEvent<NativePushActionEventDetail>).detail;
            pushLog(
                `[Native Push] Action=${detail?.actionId || 'tap'} app=${detail?.appVisibility || 'unknown'} channel=${NATIVE_PUSH_CHANNEL_ID}.`,
                'info'
            );
            const payloadData = detail?.payload?.notification?.data as Record<string, unknown> | undefined;
            const urlFromData = typeof payloadData?.url === 'string' ? payloadData.url : '';
            const chatFromData = typeof payloadData?.chat === 'string' ? payloadData.chat : '';

            if (urlFromData) {
                consumeNotificationChatParam(urlFromData);
                return;
            }
            if (chatFromData) {
                consumeNotificationChatParam(`/?chat=${encodeURIComponent(chatFromData)}`);
            }
        };

        window.addEventListener(NATIVE_PUSH_ACTION_EVENT, handleNativePushAction as EventListener);

        const handleServiceWorkerMessage = (event: MessageEvent<any>) => {
            if (event?.data?.type !== 'notification-click') return;
            consumeNotificationChatParam(event.data?.url);
        };

        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);
        }

        return () => {
            window.removeEventListener(NATIVE_PUSH_ACTION_EVENT, handleNativePushAction as EventListener);
            if ('serviceWorker' in navigator) {
                navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage);
            }
        };
    }, [handleOpenChat, pushLog]);

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
                    updateSessionState(nextSession);
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
            { id: 'more', label: 'Analytics', icon: BarChart3 }
        ];

    const showUiControlsSkeleton = Boolean(session?.access_token) && uiControlsLoading;
    const workspaceTabs = showUiControlsSkeleton
        ? []
        : baseWorkspaceTabs.filter((tab) => !isUiFeatureHidden(UI_FEATURE_KEY_BY_WORKSPACE_SECTION[tab.id]));

    const activeWorkspaceLabel = workspaceTabs.find(tab => tab.id === workspaceSection)?.label || 'Workspace';
    const defaultWorkspaceSection = workspaceTabs[0]?.id || 'team-inbox';
    const hideGlobalHeaderOnMobileInbox = isMobile
        && activeView === 'dashboard'
        && workspaceSection === 'team-inbox'
        && !showAnalytics;
    const shouldShowMobileBottomNav = isMobile
        && activeView === 'dashboard'
        && (showAnalytics || !(workspaceSection === 'team-inbox' && Boolean(selectedChatId)))
        && !showContactInfo;
    const mobileWorkspaceTabs = workspaceTabs.filter((tab) =>
        (MOBILE_BOTTOM_TAB_SECTIONS as readonly string[]).includes(tab.id)
    );
    const broadcastNav: Array<{ id: 'template-library' | 'my-templates' | 'broadcast-history' | 'scheduled-broadcasts'; label: string }> = [
        { id: 'template-library', label: 'Create Template' },
        { id: 'my-templates', label: 'My Templates' },
        { id: 'broadcast-history', label: 'Broadcast History' },
        { id: 'scheduled-broadcasts', label: 'Scheduled Broadcasts' }
    ];
    const mobileSafeInsetsStyle: React.CSSProperties | undefined = isMobile
        ? {
            paddingLeft: 'max(env(safe-area-inset-left), 0px)',
            paddingRight: 'max(env(safe-area-inset-right), 0px)'
        }
        : undefined;
    const mobileHeaderOffsetStyle: React.CSSProperties | undefined = isMobile
        ? {
            paddingLeft: 'max(env(safe-area-inset-left), 0px)',
            paddingRight: 'max(env(safe-area-inset-right), 0px)',
            paddingTop: 'calc(64px + env(safe-area-inset-top))'
        }
        : undefined;
    const mobileBottomNavPaddingStyle: React.CSSProperties | undefined = isMobile && shouldShowMobileBottomNav
        ? {
            paddingBottom: 'calc(76px + env(safe-area-inset-bottom))'
        }
        : undefined;
    const mobileBottomNavContentPaddingStyle: React.CSSProperties | undefined = isMobile && shouldShowMobileBottomNav
        ? {
            paddingBottom: 'calc(92px + env(safe-area-inset-bottom))'
        }
        : undefined;
    const handleToggleChatAssigneeMenu = (chatId: string) => {
        if (!teamUsers.length && !teamUsersLoading) fetchTeamUsers();
        setAssignMenuContactId((prev) => (prev === chatId ? null : chatId));
    };
    const webChatListRowProps: DesktopChatListRowProps = {
        chats: chatListForView,
        contacts,
        selectedChatId,
        onOpenChat: handleOpenChat,
        onToggleAssigneeMenu: handleToggleChatAssigneeMenu
    };
    const renderChatListItem = (chat: Chat, style?: React.CSSProperties) => {
        const contactMeta = pickContactMetaByJid(contacts, chat.id) || {};
        const assigneeName = contactMeta.assigneeName || null;
        const assigneeColor = contactMeta.assigneeColor || '#6b7280';
        const contactTags = splitContactTags(contactMeta.tags).labelTags;
        const primaryTag = contactTags[0] || null;
        const extraTagCount = Math.max(0, contactTags.length - (primaryTag ? 1 : 0));
        const assigneeNode = assigneeName ? (
            <button
                type="button"
                onClick={(e) => {
                    e.stopPropagation();
                    handleToggleChatAssigneeMenu(chat.id);
                }}
                className="px-1.5 py-0.5 text-[9px] rounded uppercase font-bold border tracking-tight hover:opacity-85 transition-all"
                style={{
                    backgroundColor: withHexAlpha(assigneeColor, '20', '#f3f4f6'),
                    borderColor: withHexAlpha(assigneeColor, '66', '#d1d5db'),
                    color: textColor(assigneeColor, '#374151')
                }}
                title={`Staff ${assigneeName}`}
            >
                <span className="inline-flex max-w-[110px] items-center truncate">Staff {assigneeName}</span>
            </button>
        ) : chat.id.endsWith('@g.us') ? (
            <span className="px-1.5 py-0.5 bg-[#f0f2f5] text-[#54656f] text-[9px] rounded uppercase font-bold border border-[#eceff1] tracking-tight">Staff Group</span>
        ) : (
            <button
                type="button"
                onClick={(e) => {
                    e.stopPropagation();
                    handleToggleChatAssigneeMenu(chat.id);
                }}
                className="px-1.5 py-0.5 bg-[#f8f9fa] text-[#9ca3af] text-[9px] rounded uppercase font-bold border border-[#eceff1] tracking-tight hover:bg-[#f0f2f5] transition-all"
            >
                <span className="inline-flex max-w-[110px] items-center truncate">Staff Unassigned</span>
            </button>
        );
        return (
            <div key={`chat-row-${chat.id}`} style={style}>
                <ContactListItem
                    id={chat.id}
                    name={chat.name}
                    preview={chat.lastMessage || ''}
                    timestampLabel={chat.timestamp ? new Date(chat.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                    isSelected={selectedChatId === chat.id}
                    isGroup={chat.id.endsWith('@g.us')}
                    phoneLabel={
                        (chat.id.endsWith('@s.whatsapp.net') || chat.id.endsWith('@lid'))
                            && getCleanId(chat.name) !== getCleanId(chat.id)
                            ? formatPhoneNumber(getCleanId(chat.id))
                            : undefined
                    }
                    badgeCount={chat.unreadCount}
                    primaryTag={primaryTag}
                    extraTagCount={extraTagCount}
                    assignee={assigneeNode}
                    onClick={() => handleOpenChat(chat.id)}
                />
            </div>
        );
    };

    const activeProfileExists = Boolean(
        activeProfileId
        && profiles.some((profile: any) => trimString(profile?.id) === activeProfileId)
    );
    const debugProfileSummary = profiles
        .slice(0, 8)
        .map((profile: any) => ({
            id: trimString(profile?.id),
            status: trimString(profile?.status) || 'unknown',
            companyId: trimString(profile?.company_id),
            name: trimString(profile?.name)
        }));
    const debugSnapshot = {
        ts: new Date().toISOString(),
        env: {
            mode: import.meta.env.MODE,
            socketUrl: SOCKET_URL,
            native: Capacitor.isNativePlatform()
        },
        session: {
            userId: session?.user?.id || null,
            email: session?.user?.email || null,
            companyId: resolveCompanyIdFromLocation() || trimString((session?.user?.user_metadata as any)?.company_id) || trimString((session?.user?.app_metadata as any)?.company_id) || null,
            expiresAt: session?.expires_at || null,
            accessToken: session?.access_token ? `len ${session.access_token.length}` : null
        },
        socket: {
            connected: Boolean(socket?.connected),
            id: socket?.id || null,
            transport: socket?.io?.engine?.transport?.name || null
        },
        state: {
            isAdmin,
            activeView,
            workspaceSection,
            activeProfileId,
            activeProfileStatus,
            activeProfileExists,
            profilesLoaded,
            connectionStatus,
            selectedChatId,
            windowOpen,
            forceTemplateMode,
            lastProfileError
        },
        counts: {
            profiles: profiles.length,
            chats: chatList.length,
            chatsView: chatListForView.length,
            messages: allMessages.length,
            logs: logEntries.length
        },
        diagnostics: {
            panelVersion: debugPanelVersion,
            chatListTop: chatListForView.slice(0, 8).map((chat) => chat.id),
            listChanges: chatListFlickerStatsRef.current.changes,
            rapidListChanges: chatListFlickerStatsRef.current.rapidChanges,
            lastSocketEvent: debugLastSocketEventRef.current,
            eventCounters: debugSocketEventCountersRef.current
        },
        profiles: debugProfileSummary,
        serverStats: serverStats
            ? {
                cpu: serverStats.cpu,
                memPct: serverStats.memPct,
                inBps: serverStats?.bandwidth?.inBps || 0,
                outBps: serverStats?.bandwidth?.outBps || 0,
                timestamp: serverStats.timestamp
            }
            : null
    };
    const debugSnapshotText = JSON.stringify(debugSnapshot, null, 2);

    const handleCopyMobileDebugSnapshot = async () => {
        if (!debugSnapshotText) return;

        try {
            if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(debugSnapshotText);
                showToast('Mobile debug copied.', 'success');
                return;
            }
        } catch {
            // fallback below
        }

        try {
            if (typeof document === 'undefined') throw new Error('Clipboard unavailable');
            const textArea = document.createElement('textarea');
            textArea.value = debugSnapshotText;
            textArea.setAttribute('readonly', 'readonly');
            textArea.style.position = 'fixed';
            textArea.style.top = '-1000px';
            textArea.style.opacity = '0';
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            const copied = document.execCommand('copy');
            document.body.removeChild(textArea);
            if (!copied) {
                throw new Error('Copy command failed');
            }
            showToast('Mobile debug copied.', 'success');
        } catch {
            showToast('Unable to copy debug. Please long-press and copy manually.', 'error');
        }
    };

    const visibleIncomingCalls = incomingCalls.filter((call) => {
        if (!activeVoiceCall?.callId || call.callId !== activeVoiceCall.callId) return true;
        return !isIncomingCallClaimed(call);
    });

    return (
        <>
            {isOffline && (
                <>
                    <div
                        className="fixed top-0 inset-x-0 z-[260] bg-[#111b21] text-white border-b border-[#2f3b42]"
                        style={{
                            paddingTop: 'max(env(safe-area-inset-top), 0px)',
                            paddingLeft: 'max(env(safe-area-inset-left), 0px)',
                            paddingRight: 'max(env(safe-area-inset-right), 0px)'
                        }}
                    >
                        <div className="h-11 px-4 flex items-center justify-center gap-2 text-[12px] font-bold tracking-wide">
                            <span className="px-2 py-0.5 rounded-full bg-rose-500/90 text-[10px] uppercase">Offline</span>
                            <span>No internet connection. Reconnecting...</span>
                        </div>
                    </div>
                    {!isMobile && (
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
                    )}
                </>
            )}
            {showWabaConnectedSuccess && (
                <div className="fixed inset-0 z-[360] qm-waba-success-shell overflow-y-auto">
                    <div className="qm-waba-success-confetti-layer" aria-hidden="true">
                        {wabaConnectedConfettiPieces.map((piece) => (
                            <span
                                key={`waba-confetti-${piece.id}`}
                                className="qm-waba-confetti-piece"
                                style={{
                                    left: `${piece.left}%`,
                                    width: `${piece.size}px`,
                                    height: `${Math.max(6, Math.round(piece.size * 0.58))}px`,
                                    backgroundColor: `hsl(${piece.hue} 92% 58%)`,
                                    animationDelay: `${piece.delay}s`,
                                    animationDuration: `${piece.duration}s`,
                                    opacity: piece.opacity
                                }}
                            />
                        ))}
                    </div>
                    <div className="min-h-full px-4 py-7 md:px-8 md:py-12 flex items-start justify-center">
                        <div className="qm-waba-success-card w-full max-w-xl relative">
                            <div className="w-16 h-16 rounded-2xl mx-auto bg-[#dff7ee] border border-[#bfe9da] text-[#0f805f] flex items-center justify-center shadow-[0_14px_28px_rgba(15,128,95,0.2)]">
                                <CheckCheck className="w-9 h-9" />
                            </div>
                            <div className="mt-5 text-center space-y-3">
                                <p className="text-[11px] font-black tracking-[0.14em] uppercase text-[#0f805f]">Connected</p>
                                <h2 className="text-2xl md:text-[2rem] leading-tight font-black text-[#12253a]">
                                    WhatsApp Business is connected successfully
                                </h2>
                                <p className="text-sm md:text-[15px] text-[#586b82] leading-relaxed">
                                    Embedded Signup completed and your WABA connection is active.
                                    You can continue to the inbox now or review connection settings.
                                </p>
                                {wabaConnectedSummary && (
                                    <div className="mx-auto mt-2 max-w-[460px] rounded-2xl border border-[#dbe8f6] bg-[#f8fbff] px-4 py-3 text-left">
                                        <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[#64748b]">Selected WhatsApp Number</p>
                                        <p className="mt-1 text-[15px] font-extrabold text-[#12253a]">
                                            {wabaConnectedSummary.displayPhoneNumber || wabaConnectedSummary.phoneNumberId || '-'}
                                        </p>
                                        {(wabaConnectedSummary.verifiedName || wabaConnectedSummary.phoneNumberId) && (
                                            <p className="mt-1 text-[11px] text-[#586b82]">
                                                {wabaConnectedSummary.verifiedName ? `Verified name: ${wabaConnectedSummary.verifiedName}` : ''}
                                                {wabaConnectedSummary.verifiedName && wabaConnectedSummary.phoneNumberId ? ' · ' : ''}
                                                {wabaConnectedSummary.phoneNumberId ? `Phone Number ID: ${wabaConnectedSummary.phoneNumberId}` : ''}
                                            </p>
                                        )}
                                    </div>
                                )}
                            </div>
                            <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <button
                                    type="button"
                                    onClick={handleOpenWabaConnectedSettings}
                                    className="qm-btn qm-btn-primary w-full"
                                >
                                    Open Settings
                                </button>
                                <button
                                    type="button"
                                    onClick={handleContinueAfterWabaConnected}
                                    className="qm-btn qm-btn-secondary w-full"
                                >
                                    Continue to Inbox
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
            {!hideGlobalHeaderOnMobileInbox && (
            <header
                className="fixed top-0 inset-x-0 z-[120] h-[64px] lg:h-[72px] bg-white/92 backdrop-blur-md border-b border-[var(--qm-border)]"
                style={isMobile ? {
                    minHeight: 'calc(64px + env(safe-area-inset-top))',
                    paddingTop: 'max(env(safe-area-inset-top), 0px)',
                    paddingLeft: 'max(env(safe-area-inset-left), 0px)',
                    paddingRight: 'max(env(safe-area-inset-right), 0px)'
                } : undefined}
            >
                <div className="h-full px-3 sm:px-4 lg:px-5 flex items-center justify-between gap-3 lg:gap-4">
                    <div className="flex items-center gap-5 min-w-0 flex-1">
                        <div className="flex items-center gap-2 shrink-0">
                            <img
                                src={appLogoUrl || qmessageLogo}
                                alt="QMessage logo"
                                className="h-8 w-auto max-w-[170px] object-contain"
                                loading="lazy"
                            />
                        </div>
                        <div className="hidden xl:block w-px h-8 bg-[#eceff1]" />
                        <div className="lg:hidden min-w-0">
                            <div className="text-[14px] font-bold text-[#111b21] truncate">{activeWorkspaceLabel}</div>
                        </div>
                        <nav className="hidden lg:flex items-center gap-1 overflow-x-auto whitespace-nowrap custom-scrollbar">
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
                                            setShowAnalytics(false);
                                            setWorkspaceSection(tab.id);
                                        }}
                                    className={`px-3 py-2 rounded-xl text-[16px] font-bold transition-all flex items-center gap-2 ${active ? 'text-[#00a884] bg-[#e8f8f2] border border-[#c7efdf]' : 'text-[#4a4a4a] hover:bg-[#f4f8ff]'}`}
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
                                        if (isMobile) setSelectedChatId(null);
                                    }}
                                    className="relative w-10 h-10 rounded-full bg-[#edf4fb] text-[#00a884] border border-[var(--qm-border)] flex items-center justify-center hover:bg-[#e8f5f1] transition-all"
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
                                        className="hidden sm:flex w-10 h-10 rounded-full bg-[#edf4fb] border border-[var(--qm-border)] text-[#6b7280] items-center justify-center"
                                        title="Open settings"
                                        aria-label="Open settings"
                                    >
                                        <MoreVertical className="w-5 h-5" />
                                    </button>
                                )}
                            </>
                        )}
                    </div>
                </div>
            </header>
            )}

            {workspaceSection === 'team-inbox' ? (
                <div
                    className={`qm-app-gradient flex ${isMobile ? 'h-[100dvh]' : 'h-screen'} ${hideGlobalHeaderOnMobileInbox ? 'pt-0' : 'pt-[64px] lg:pt-[72px]'} overflow-hidden text-[#111b21] font-sans`}
                    style={{
                        ...(hideGlobalHeaderOnMobileInbox ? mobileSafeInsetsStyle : mobileHeaderOffsetStyle),
                        ...(mobileBottomNavPaddingStyle || {})
                    }}
                    onTouchStart={handleMobileWorkspaceTouchStart}
                    onTouchEnd={handleMobileWorkspaceTouchEnd}
                >
            <div className={`${isMobileChatOpen ? 'hidden' : 'flex'} w-full lg:w-[400px] border-r border-[var(--qm-border)] flex-col bg-white/95`}>
                <div className={`px-3 py-2 border-b border-[var(--qm-border)] ${hideGlobalHeaderOnMobileInbox ? 'pt-[max(env(safe-area-inset-top),0.35rem)]' : ''}`}>
                    <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1.5">
                            {isMobile ? (
                                <img
                                    src={appLogoUrl || qmessageLogo}
                                    alt="QMessage logo"
                                    className="w-9 h-9 rounded-lg object-cover"
                                />
                            ) : (
                                <>
                                    <button
                                        type="button"
                                        onClick={() => setShowNewChatModal(true)}
                                        className="w-8 h-8 rounded-lg bg-[#00a884]/12 border border-[#00a884]/25 text-[#00a884] flex items-center justify-center hover:bg-[#00a884]/18 transition-all"
                                        title="Start new chat"
                                    >
                                        <Plus className="w-4 h-4" />
                                    </button>
                                    {!SINGLE_PROFILE_MODE && (
                                        <button
                                            type="button"
                                            onClick={handleAddProfile}
                                            className="w-8 h-8 rounded-lg bg-[#f4f8ff] border border-[var(--qm-border)] text-[#54656f] flex items-center justify-center hover:bg-white hover:border-[#cdd8e0] transition-all"
                                            title="Add profile"
                                        >
                                            <Users className="w-4 h-4" />
                                        </button>
                                    )}
                                </>
                            )}
                        </div>
                        <div className="flex-1 bg-[#f4f8ff] border border-transparent rounded-xl flex items-center px-4 py-2 focus-within:bg-white focus-within:border-[var(--qm-border)] focus-within:ring-1 focus-within:ring-[#00a884]/20 transition-all">
                            <Search className="w-4 h-4 text-[#54656f] mr-4" />
                            <input
                                type="text"
                                placeholder="Search or start new chat"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="bg-transparent border-none text-[15px] w-full focus:outline-none placeholder:text-[#54656f]"
                            />
                        </div>
                        {isMobile && !isUiFeatureHidden(SETTINGS_UI_FEATURE_KEY) && (
                            <button
                                type="button"
                                onClick={openSettingsFromMore}
                                className="w-10 h-10 rounded-xl bg-[#f4f8ff] border border-[var(--qm-border)] text-[#54656f] flex items-center justify-center hover:bg-white hover:border-[#cdd8e0] transition-all"
                                title="Open settings"
                                aria-label="Open settings"
                            >
                                <MoreVertical className="w-4 h-4" />
                            </button>
                        )}
                        {!isMobile && (
                            <div className="flex w-[108px] sm:w-[132px] bg-[#f4f8ff] rounded-xl items-center px-2.5 py-2 border border-transparent focus-within:border-[#00a884]/30 transition-all">
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
                        )}
                    </div>
                    {isMobile && (
                        <div className="mobile-horizontal-scroll mt-2 flex items-center gap-2 pr-1">
                            <button
                                type="button"
                                onClick={() => setMobileChatQuickFilter('all')}
                                className={`snap-start h-8 px-3 rounded-full text-[11px] font-bold border whitespace-nowrap transition-all ${mobileChatQuickFilter === 'all'
                                        ? 'bg-[#e9f7f4] border-[#b9eadd] text-[#008f6f]'
                                        : 'bg-[#f7f9fa] border-[#e2e8ee] text-[#54656f]'
                                    }`}
                            >
                                All
                            </button>
                            <button
                                type="button"
                                onClick={() => setMobileChatQuickFilter('unread')}
                                className={`snap-start h-8 px-3 rounded-full text-[11px] font-bold border whitespace-nowrap transition-all ${mobileChatQuickFilter === 'unread'
                                        ? 'bg-[#e9f7f4] border-[#b9eadd] text-[#008f6f]'
                                        : 'bg-[#f7f9fa] border-[#e2e8ee] text-[#54656f]'
                                    }`}
                            >
                                Unread {mobileUnreadChatCount > 0 ? `(${mobileUnreadChatCount})` : ''}
                            </button>
                            <div className={`snap-start h-8 rounded-full border whitespace-nowrap transition-all flex items-center gap-1.5 pl-2 pr-2 ${mobileTagFilter ? 'bg-[#ecfdf3] border-[#bbf7d0] text-[#166534]' : 'bg-[#f7f9fa] border-[#e2e8ee] text-[#54656f]'}`}>
                                <Plus className="w-3.5 h-3.5 shrink-0" />
                                <select
                                    value={mobileTagFilter}
                                    onChange={(e) => setMobileTagFilter(e.target.value)}
                                    className="bg-transparent text-[11px] font-bold focus:outline-none pr-1"
                                >
                                    <option value="">+ Tag</option>
                                    {mobileChatFilterTags.map((tag) => (
                                        <option key={`mobile-filter-tag-${tag}`} value={tag}>
                                            {tag}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </div>
                    )}
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
                                    Set up your Meta Cloud API in Settings.
                                    Once configured, refresh the page and the profile will show as connected.
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
                            ) : chatListForView.length === 0 ? (
                                <div className="h-full flex items-center justify-center text-sm text-[#8696a0]">
                                    No chats found.
                                </div>
                            ) : isMobile ? (
                                <div className="h-full overflow-y-auto custom-scrollbar">
                                    {chatListForView.map((chat) => renderChatListItem(chat))}
                                </div>
                            ) : chatListViewport.height > 0 ? (
                                <List
                                    style={{
                                        height: chatListViewport.height,
                                        width: chatListViewport.width || '100%'
                                    }}
                                    rowCount={chatListForView.length}
                                    rowHeight={CHAT_ROW_HEIGHT}
                                    rowProps={webChatListRowProps}
                                    overscanCount={8}
                                    rowComponent={DesktopChatListRow}
                                />
                            ) : null}
                        </div>
                    )}
                </div>
            </div>

            {selectedChatId ? (
                <div
                    className="flex-1 min-w-0 flex bg-[#f3f8ff] relative overflow-hidden"
                    onDragOver={handleComposerDragOver}
                    onDragLeave={handleComposerDragLeave}
                    onDrop={handleComposerDrop}
                >
                    {canSendText && composerDragActive && (
                        <div className="absolute inset-0 z-30 pointer-events-none bg-[#00a884]/6 backdrop-blur-[1px]">
                            <div className="absolute inset-x-0 top-0 h-[3px] bg-[#00a884]" />
                            <div className="h-full w-full flex items-center justify-center">
                                <div className="rounded-2xl border-2 border-dashed border-[#00a884]/50 bg-white/90 px-5 py-3 shadow-[0_10px_28px_rgba(0,0,0,0.12)]">
                                    <p className="text-xs font-extrabold uppercase tracking-[0.14em] text-[#007f62]">
                                        Drop image, video, or file to attach
                                    </p>
                                </div>
                            </div>
                        </div>
                    )}
                    <div className="flex-1 min-w-0 flex flex-col min-h-0 relative overflow-hidden">
                    <div className="absolute inset-0 opacity-[0.06] pointer-events-none bg-[url('https://web.whatsapp.com/img/bg-chat-tile-light_6860a4760a595861d83d.png')] bg-repeat" />

                    {isMobile ? (
                        <ChatHeader
                            title={selectedChat?.name || 'Chat'}
                            subtitle={selectedChat?.id.endsWith('@g.us')
                                ? 'Group chat'
                                : (
                                    <>
                                        <span className="text-[#00a884] font-bold">{formatPhoneNumber(getCleanId(selectedChat?.id))}</span>
                                        {lastInboundMs ? (
                                            windowOpen ? (
                                                <span className="ml-1.5 font-semibold text-[#00a884]">
                                                    {`${formatRemaining(windowRemainingMs || 0)} left`}
                                                </span>
                                            ) : null
                                        ) : (
                                            <span className="ml-1.5 text-[#8a9aa1]">24h: no inbound</span>
                                        )}
                                    </>
                                )}
                            isGroup={selectedChat?.id.endsWith('@g.us')}
                            showBack
                            onBack={() => {
                                setSelectedChatId(null);
                                setShowContactInfo(false);
                            }}
                            onOpenInfo={() => setShowContactInfo(true)}
                            rightSlot={(
                                <button
                                    type="button"
                                    onClick={handleClearChat}
                                    className="p-2 rounded-lg hover:bg-white/90 text-[#54656f] hover:text-rose-600 transition-all"
                                    title="Clear chat"
                                >
                                    <Trash2 className="w-4 h-4" />
                                </button>
                            )}
                        />
                    ) : (
                    <header className="h-[60px] shrink-0 bg-[#f4f8ff] px-3 flex items-center justify-between z-10 border-l border-[var(--qm-border)]">
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
                                            <span className="ml-2 inline-flex items-center rounded-full border border-[#d8e6df] bg-white px-2 py-0.5 text-[10px] font-bold text-[#46625b]">
                                                {callPermissionLoading ? 'Call: loading' : getCallPermissionBadgeLabel(selectedCallPermission)}
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
                                        onClick={() => void handleRequestCallPermission()}
                                        disabled={!isAdmin || callPermissionRequestLoading || !selectedChatId || selectedChatId.endsWith('@g.us')}
                                        title="Request call permission"
                                        className="text-[#54656f] hover:text-[#111b21] transition-colors disabled:opacity-50"
                                    >
                                        <Bell className="w-5 h-5" />
                                    </button>
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
                    )}

                    <div className={`flex-1 min-h-0 z-10 flex flex-col ${isMobile ? 'px-2 py-3' : 'px-16 py-6'}`}>
                        {showMobileWindowClosedBanner && (
                            <div className="mb-2 self-center px-3 py-1.5 rounded-full bg-[#fff3e0]/95 text-[#a16207] text-[11px] font-bold border border-[#fde68a] shadow-[0_8px_24px_rgba(0,0,0,0.12)] backdrop-blur-[2px] text-center">
                                24h window closed. Use template message to reply.
                            </div>
                        )}
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
                                        const messageTimestampLabel = msg.messageTimestamp
                                            ? new Date(msg.messageTimestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
                                            : '';

                                        return (
                                            <div style={style} className="w-full px-1">
                                                <ChatBubble
                                                    fromMe={Boolean(msg.key.fromMe)}
                                                    failed={isFailedOutgoing}
                                                    senderName={messageSenderName}
                                                    senderColor={textColor(messageSenderColor, '#6b7280')}
                                                    timestampLabel={messageTimestampLabel}
                                                    statusIcon={renderMessageStatus(msg)}
                                                    footerSlot={isFailedOutgoing ? (
                                                        <div className="mt-1 text-right">
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
                                                        </div>
                                                    ) : undefined}
                                                >
                                                            {messageText && (
                                                                <p className="leading-relaxed whitespace-pre-wrap break-words">
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
                                                                const videoSrc = cacheEntry
                                                                    ? `data:${cacheEntry.mimetype};base64,${cacheEntry.data}`
                                                                    : (directUrl || '');
                                                                return (
                                                                    <div className="mt-1 mb-1 w-[280px] max-w-[78vw] rounded-xl overflow-hidden bg-[#0b141a] border border-[#eceff1]">
                                                                        {videoSrc ? (
                                                                            <div className="w-full aspect-[16/10] bg-black">
                                                                                <video
                                                                                    controls
                                                                                    preload="metadata"
                                                                                    playsInline
                                                                                    className="w-full h-full object-cover block"
                                                                                    src={videoSrc}
                                                                                />
                                                                            </div>
                                                                        ) : (
                                                                            <button
                                                                                type="button"
                                                                                onClick={() => handleDownloadMedia(msg)}
                                                                                className="w-full aspect-[16/10] bg-[#f8f9fa] text-[#54656f] flex flex-col items-center justify-center gap-2 px-3"
                                                                            >
                                                                                <Video className="w-6 h-6 text-[#00a884]" />
                                                                                <span className="text-[11px] font-bold uppercase tracking-widest text-[#54656f]">Video Preview</span>
                                                                                {renderMediaLoadingPlaceholder(msg, true)}
                                                                            </button>
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

                                                </ChatBubble>
                                            </div>
                                        );
                                    }}
                                />
                            ) : null}
                        </div>
                    </div>

                    <MessageInputBar>
                        <div className="flex items-center gap-1.5 z-10 min-h-[54px]">
                        <div className="relative flex items-center text-[#54656f]">
                            {isMobile && (
                                <button
                                    type="button"
                                    onClick={() => setShowMobileComposerMenu((prev) => !prev)}
                                    className={`p-1.5 rounded-lg transition-all cursor-pointer ${showMobileComposerMenu ? 'bg-[#00a884]/10 text-[#00a884]' : 'hover:bg-white'}`}
                                    title="More actions"
                                >
                                    <Menu className="w-5 h-5" />
                                </button>
                            )}
                            <button type="button" className="p-1.5 hover:bg-white rounded-lg transition-all cursor-pointer">
                                <Smile className="w-6 h-6" />
                            </button>
                            {!isMobile && (
                                <>
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
                                </>
                            )}
                        </div>
                        {!isMobile && workflowStarter}
                        <div
                            className="flex-1 mx-1 relative"
                            onDragOver={handleComposerDragOver}
                            onDragLeave={handleComposerDragLeave}
                            onDrop={handleComposerDrop}
                        >
                            {!canSendText && !isMobile && (
                                <div className="absolute -top-8 left-0 px-3 py-1.5 rounded-lg text-[11px] bg-[#fff3e0] text-[#a16207] font-bold border border-[#fde68a]">
                                    24h window closed. Use template message to reply.
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
                                                {(() => {
                                                    const itemQuickReplyType = normalizeQuickReplyMessageType(item.message_type);
                                                    const mediaItems = itemQuickReplyType === 'text'
                                                        ? []
                                                        : normalizeQuickReplyMediaItems(item.media_items, itemQuickReplyType);
                                                    const mediaCount = mediaItems.length > 0
                                                        ? mediaItems.length
                                                        : (
                                                            itemQuickReplyType === 'text'
                                                                ? 0
                                                                : (normalizeQuickReplyMediaUrl(item.media_url) || normalizeQuickReplyMediaAssetKey(item.media_asset_key))
                                                                    ? 1
                                                                    : 0
                                                        );
                                                    const mediaBadge = mediaCount > 1
                                                        ? `${itemQuickReplyType} x${mediaCount}`
                                                        : itemQuickReplyType;
                                                    return (
                                                        <>
                                                <div className="flex items-center justify-between gap-2">
                                                    <div className="text-xs font-bold uppercase tracking-widest text-[#00a884]">/{normalizeQuickReplyShortcut(item.shortcut)}</div>
                                                    {itemQuickReplyType !== 'text' && (
                                                        <span className="text-[10px] font-semibold uppercase tracking-wide text-[#4b5c68] bg-[#eef2f5] px-2 py-0.5 rounded-full">
                                                            {mediaBadge}
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="text-sm text-[#111b21] mt-1 max-h-10 overflow-hidden">
                                                    {(() => {
                                                        const text = typeof item.text === 'string' ? item.text.trim() : '';
                                                        if (text) return text;
                                                        if (itemQuickReplyType === 'text') return '';
                                                        if (mediaCount > 1) return `Media quick reply (${mediaCount} files)`;
                                                        return `Media quick reply (${itemQuickReplyType})`;
                                                    })()}
                                                </div>
                                                        </>
                                                    );
                                                })()}
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
                                        multiple={composerMediaType !== 'video'}
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
                                        {composerQueuedMediaCount > 0
                                            ? `Text + first media will be sent first, then ${composerQueuedMediaCount} more attachment${composerQueuedMediaCount > 1 ? 's' : ''}.`
                                            : 'Text + media will be sent in one message.'}
                                    </p>
                                </div>
                            )}
                                {isMobile && !canSendText ? (
                                    <button
                                        type="button"
                                        onClick={() => setShowTemplateComposer(true)}
                                        className="w-full border border-[#f7dca2] bg-[#fff8e7] text-[#9a6700] rounded-xl px-3 py-2.5 text-[13px] font-bold text-left hover:bg-[#fff3d6] transition-all"
                                    >
                                        Tap here to send a template message
                                    </button>
                                ) : (
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
                                )}
                            {composerMediaUploading ? (
                                <div className="mt-1 text-[11px] font-bold text-[#54656f]">
                                    Uploading attachment…
                                </div>
                            ) : hasComposerMedia && (
                                <div className="mt-1 text-[11px] font-bold text-[#00a884]">
                                    Attachment ready: {composerMediaType}
                                    {composerQueuedMediaCount > 0 ? ` (+${composerQueuedMediaCount} more)` : ''}. Add text or tap send.
                                </div>
                            )}
                        </div>
                        <div className="text-[#54656f] flex items-center gap-1.5">
                            <div className="relative">
                                {!isMobile && (
                                    <button
                                        type="button"
                                        onClick={() => setShowTemplateComposer(prev => !prev)}
                                        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition-all ${showTemplateComposer ? 'bg-[#00a884]/10 text-[#00a884]' : 'bg-white border border-[#eceff1] text-[#334155] hover:bg-[#f8fafc]'}`}
                                        title="Send template message"
                                    >
                                        <FileText className="w-4 h-4" />
                                        <span>Template</span>
                                    </button>
                                )}
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
                            {canSendText && (messageText.trim() || hasComposerMedia) ? (
                                <button
                                    type="button"
                                    onClick={handleSendMessage}
                                    className="w-11 h-11 rounded-full bg-[#00a884] shadow-sm cursor-pointer text-white transition-all hover:bg-[#008f6f] active:scale-95 flex items-center justify-center"
                                    title="Send message"
                                >
                                    <Send className="w-5 h-5" />
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (!canSendText) {
                                            setShowTemplateComposer(true);
                                            return;
                                        }
                                        // Voice recording trigger placeholder (matches existing behavior).
                                    }}
                                    className={`w-11 h-11 rounded-full transition-all cursor-pointer flex items-center justify-center ${canSendText ? 'bg-[#00a884] text-white hover:bg-[#008f6f]' : 'bg-[#e6ebef] text-[#7d8b95]'}`}
                                    title={canSendText ? 'Voice record' : 'Voice message unavailable, use template'}
                                >
                                    <Mic className="w-5 h-5" />
                                </button>
                            )}
                        </div>
                        {isMobile && (
                            <>
                                <div
                                    className={`fixed inset-0 z-[205] bg-[#111b21]/45 backdrop-blur-[1px] transition-opacity duration-300 ${showMobileComposerMenu ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
                                    onClick={() => setShowMobileComposerMenu(false)}
                                />
                                <div
                                    className={`fixed inset-0 z-[210] flex items-end transition-opacity duration-200 ${showMobileComposerMenu ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
                                    style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 0.5rem)' }}
                                >
                                    <div className={`mx-2 rounded-t-[28px] rounded-b-2xl border border-[#eceff1] bg-white shadow-[0_-16px_40px_rgba(0,0,0,0.22)] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${showMobileComposerMenu ? 'translate-y-0' : 'translate-y-full'}`}>
                                        <div className="pt-2 pb-1.5 flex justify-center">
                                            <div className="h-1.5 w-12 rounded-full bg-[#d2dbe1]" />
                                        </div>
                                        <div className="px-4 pb-2 text-[11px] font-bold uppercase tracking-widest text-[#667781]">
                                            Attach
                                        </div>
                                        <div className="px-3 pb-3 grid grid-cols-2 gap-2">
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setShowMobileComposerMenu(false);
                                                    openComposerMediaPicker('image');
                                                }}
                                                className="h-[52px] rounded-2xl border border-[#e7edf2] bg-[#f8fafb] text-[12px] font-semibold text-[#334155] hover:bg-[#eef4f6] flex items-center justify-center gap-2"
                                            >
                                                <ImageIcon className="w-4 h-4 text-[#54656f]" />
                                                Image
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setShowMobileComposerMenu(false);
                                                    openComposerMediaPicker('document');
                                                }}
                                                className="h-[52px] rounded-2xl border border-[#e7edf2] bg-[#f8fafb] text-[12px] font-semibold text-[#334155] hover:bg-[#eef4f6] flex items-center justify-center gap-2"
                                            >
                                                <FileIcon className="w-4 h-4 text-[#54656f]" />
                                                Document
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setShowMobileComposerMenu(false);
                                                    openComposerMediaPicker('video');
                                                }}
                                                className="h-[52px] rounded-2xl border border-[#e7edf2] bg-[#f8fafb] text-[12px] font-semibold text-[#334155] hover:bg-[#eef4f6] flex items-center justify-center gap-2"
                                            >
                                                <Paperclip className="w-4 h-4 -rotate-45 text-[#54656f]" />
                                                Video
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setShowMobileComposerMenu(false);
                                                    setShowTemplateComposer(true);
                                                }}
                                                className="h-[52px] rounded-2xl border border-[#e7edf2] bg-[#f8fafb] text-[12px] font-semibold text-[#334155] hover:bg-[#eef4f6] flex items-center justify-center gap-2"
                                            >
                                                <FileText className="w-4 h-4 text-[#54656f]" />
                                                Template
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </>
                        )}
                        </div>
                    </MessageInputBar>

                    </div>

                    {/* Contact Info Sidebar */}
                    {showContactInfo && (
                        <aside className={isMobile
                            ? "fixed inset-0 z-[220] bg-white flex flex-col overflow-hidden"
                            : "w-[360px] max-w-[42vw] min-w-[320px] h-full bg-white border-l border-[#eceff1] shadow-[-12px_0_28px_rgba(0,0,0,0.08)] flex flex-col overflow-hidden z-20"}
                        >
                                <header className="h-[54px] bg-[#f0f2f5] px-3 sm:px-4 flex items-center gap-4 text-[#111b21] border-b border-[#eceff1]">
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
                                        <span className="text-[10px] font-bold uppercase tracking-widest text-[#54656f]">
                                            Alias
                                        </span>
                                        <input
                                            className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-4 py-2.5 text-[14px] font-bold text-center focus:outline-none focus:border-[#00a884]"
                                            value={contactDraftName}
                                            onChange={(e) => {
                                                setContactDraftName(e.target.value);
                                                setContactDirty(true);
                                            }}
                                            placeholder="Set alias (optional)"
                                            disabled={selectedChat?.id.endsWith('@g.us')}
                                        />
                                        <button
                                            onClick={handleSaveContact}
                                            disabled={selectedChat?.id.endsWith('@g.us')}
                                            className={`px-3 py-1.5 rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all ${contactDirty ? 'bg-[#00a884] text-white' : 'bg-[#f0f2f5] text-[#8696a0]'} `}
                                        >
                                            Save Alias
                                        </button>
                                    </div>
                                    <p className="text-[#54656f] text-[13px] mt-1 font-medium">
                                        {selectedChat?.id.endsWith('@g.us') ? 'Shared Group' : formatPhoneNumber(getCleanId(selectedChat?.id))}
                                    </p>
                                </div>

                                <div className="w-full space-y-3 bg-[#f8f9fa] p-4 rounded-2xl border border-[#eceff1]">
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[10px] text-[#00a884] font-bold uppercase tracking-wider">WhatsApp name</span>
                                        <span className="text-[14px] font-bold text-[#111b21]">
                                            {selectedChat?.id.endsWith('@g.us') ? 'Enterprise Group' : selectedContactWhatsappName}
                                        </span>
                                    </div>
                                    <div className="flex flex-col gap-1 pt-3 border-t border-[#eceff1]">
                                        <span className="text-[10px] text-[#00a884] font-bold uppercase tracking-wider">Alias</span>
                                        <span className="text-[14px] font-bold text-[#111b21]">
                                            {selectedChat?.id.endsWith('@g.us') ? '--' : (selectedContactAlias || '--')}
                                        </span>
                                    </div>
                                    <div className="flex flex-col gap-1 pt-3 border-t border-[#eceff1]">
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
            ) : isMobile ? null : (
                <div className="qm-app-gradient flex-1 px-4 py-6 sm:px-6 lg:px-10">
                    <div className="mx-auto flex h-full max-w-4xl flex-col justify-center">
                        <div className="qm-shell p-6 sm:p-8 lg:p-10">
                            {loadingChats && (
                                <div className="mb-6 space-y-3">
                                    <div className="qm-loading-block h-3.5 w-48 rounded-full" />
                                    <div className="qm-loading-block h-3.5 w-80 rounded-full" />
                                </div>
                            )}
                            <div className="flex flex-col gap-6 lg:flex-row lg:items-center">
                                <div className="flex-1">
                                    <p className="qm-eyebrow">Workspace Overview</p>
                                    <h1 className="mt-2 text-3xl font-black tracking-tight text-[var(--qm-text)] lg:text-4xl">
                                        Welcome to your QMessage command center
                                    </h1>
                                    <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[var(--qm-text-muted)]">
                                        Open a chat to start handling conversations, launch automation setup, or review delivery insights across your WABA operations.
                                    </p>
                                    <div className="mt-5 flex flex-wrap gap-2">
                                        <button
                                            type="button"
                                            onClick={() => setShowNewChatModal(true)}
                                            className="qm-btn qm-btn-primary h-10 px-4"
                                        >
                                            <Plus className="h-4 w-4" />
                                            New Chat
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setWorkspaceSection('automations')}
                                            className="qm-btn qm-btn-secondary h-10 px-4"
                                        >
                                            <Workflow className="h-4 w-4" />
                                            Open Automations
                                        </button>
                                    </div>
                                </div>

                                <div className="w-full max-w-[320px] shrink-0 space-y-2">
                                    <div className="qm-kpi">
                                        <div className="qm-kpi-label">Coverage</div>
                                        <div className="qm-kpi-value">Inbox + Automation</div>
                                    </div>
                                    <div className="qm-kpi">
                                        <div className="qm-kpi-label">Security</div>
                                        <div className="qm-kpi-value flex items-center gap-2">
                                            <ShieldCheck className="h-4 w-4 text-[var(--qm-brand)]" />
                                            Company-isolated
                                        </div>
                                    </div>
                                    <div className="qm-kpi">
                                        <div className="qm-kpi-label">Operational Flow</div>
                                        <div className="qm-kpi-value">Capture → Route → Respond</div>
                                    </div>
                                </div>
                            </div>
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
                        isSuperAdmin={isSuperAdmin}
                        quickReplies={quickReplies}
                        quickRepliesLoading={quickRepliesLoading}
                        quickRepliesSaving={quickRepliesSaving}
                        quickRepliesError={quickRepliesError}
                        onRefreshQuickReplies={fetchQuickReplies}
                        onSaveQuickReplies={saveQuickReplies}
                        onRefreshUiControls={fetchUiControls}
                        showCallSettings={!isUiFeatureHidden('calls')}
                        showPermissionVerificationConsole={!isUiFeatureHidden('settings-review')}
                        showManualWabaSetup={!isUiFeatureHidden('settings-manual')}
                        showRegisterWhatsAppNumber={!isUiFeatureHidden('settings-register')}
                        showOutgoingWebhooks={!isUiFeatureHidden('settings-webhooks')}
                        showAdsShootMode={!isUiFeatureHidden('settings-ads-shoot')}
                        notificationPermission={notificationPermissionState}
                        notificationSoundEnabled={notificationSoundEnabled}
                        onToggleNotificationSound={handleToggleNotificationSound}
                        onRequestNotifications={() => {
                            void handleRequestNotificationPermission();
                        }}
                        onTestNotificationSound={() => {
                            void handleTestNotificationSound();
                        }}
                        WebhookViewComponent={LazyWebhookView}
                        isMobileView={isMobile}
                    />
                )
            }

            {showAnalytics && (
                <div
                    className="fixed inset-0 z-[110] bg-[#f8f9fa] text-[#111b21] font-sans pt-[64px] lg:pt-[72px]"
                    style={{
                        ...(mobileHeaderOffsetStyle || {}),
                        ...(mobileBottomNavPaddingStyle || {})
                    }}
                    onTouchStart={handleMobileWorkspaceTouchStart}
                    onTouchEnd={handleMobileWorkspaceTouchEnd}
                >
                    <div
                        className={`h-full overflow-y-auto custom-scrollbar ${isMobile ? 'p-4' : 'p-6'}`}
                        style={mobileBottomNavContentPaddingStyle}
                    >
                        <div className="mx-auto w-full max-w-[1280px] space-y-6">
                        <div className={`${isMobile ? 'px-1 py-1' : 'bg-white border border-[#e6ebef] rounded-2xl p-4 md:p-5'}`}>
                            <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
                                <div>
                                    <h2 className="text-lg md:text-xl font-semibold text-[#111b21] tracking-tight">Analytics</h2>
                                    <p className="text-[11px] text-[#54656f] mt-1">
                                        Message volume, response rates, and team performance.
                                    </p>
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[160px_160px_minmax(180px,1fr)_auto] gap-2">
                                    <div>
                                        <label className="text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97]">Start Date</label>
                                        <input
                                            type="date"
                                            value={analyticsStart}
                                            onChange={(e) => setAnalyticsStart(e.target.value)}
                                            className="mt-1.5 w-full bg-[#f8f9fa] border border-[#dfe6eb] rounded-xl px-3 py-2 text-sm font-semibold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97]">End Date</label>
                                        <input
                                            type="date"
                                            value={analyticsEnd}
                                            onChange={(e) => setAnalyticsEnd(e.target.value)}
                                            className="mt-1.5 w-full bg-[#f8f9fa] border border-[#dfe6eb] rounded-xl px-3 py-2 text-sm font-semibold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-[10px] font-semibold uppercase tracking-wide text-[#7a8b97]">Tag</label>
                                        <select
                                            value={analyticsTag}
                                            onChange={(e) => setAnalyticsTag(e.target.value)}
                                            className="mt-1.5 w-full bg-[#f8f9fa] border border-[#dfe6eb] rounded-xl px-3 py-2 text-sm font-semibold text-[#111b21] focus:outline-none focus:border-[#00a884]"
                                        >
                                            <option value="">All tags</option>
                                            {(analyticsData?.tags || []).map((tag: string) => (
                                                <option key={tag} value={tag}>{tag}</option>
                                            ))}
                                        </select>
                                    </div>
                                    <div className="sm:col-span-2 lg:col-span-1 flex items-end">
                                        <button
                                            onClick={fetchAnalytics}
                                            disabled={analyticsLoading}
                                            className="h-10 px-4 rounded-lg bg-[#00a884] text-white text-[11px] font-semibold uppercase tracking-wide hover:bg-[#008f6f] transition-all disabled:opacity-60"
                                        >
                                            {analyticsLoading ? 'Loading...' : 'Apply'}
                                        </button>
                                    </div>
                                </div>
                            </div>
                            {analyticsError && (
                                <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700">
                                    {analyticsError}
                                </div>
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

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                            <div className="bg-white p-6 rounded-[24px] border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
                                <div className="text-[#54656f] text-[10px] uppercase font-black tracking-widest mb-2">Staff Online</div>
                                <div className="text-3xl font-black text-[#00a884]">{analyticsStaffInsights.onlineCount}</div>
                                <div className="text-[11px] text-[#8696a0] mt-1">Active in last 10 minutes</div>
                            </div>
                            <div className="bg-white p-6 rounded-[24px] border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
                                <div className="text-[#54656f] text-[10px] uppercase font-black tracking-widest mb-2">Staff Response Time</div>
                                <div className="text-3xl font-black text-[#111b21]">
                                    {analyticsStaffInsights.averageResponseSeconds > 0
                                        ? formatAnalyticsDuration(analyticsStaffInsights.averageResponseSeconds)
                                        : '--'}
                                </div>
                                <div className="text-[11px] text-[#8696a0] mt-1">Weighted average reply time</div>
                            </div>
                            <div className="bg-white p-6 rounded-[24px] border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
                                <div className="text-[#54656f] text-[10px] uppercase font-black tracking-widest mb-2">Staff Total Message</div>
                                <div className="text-3xl font-black text-[#111b21]">{analyticsStaffInsights.totalMessages}</div>
                                <div className="text-[11px] text-[#8696a0] mt-1">Outbound messages by staff</div>
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
                                            <th className="px-6 py-4">Online</th>
                                            <th className="px-6 py-4">Response Time</th>
                                            <th className="px-6 py-4">Total Messages</th>
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
                                                <td className="px-6 py-6 text-sm text-[#8696a0]" colSpan={10}>
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
                                                    <td className="px-6 py-4 text-sm font-medium">
                                                        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ${row.is_online
                                                            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                                            : 'border-slate-200 bg-slate-50 text-slate-600'
                                                            }`}>
                                                            <span className={`h-1.5 w-1.5 rounded-full ${row.is_online ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                                                            {row.is_online ? 'Online' : 'Offline'}
                                                        </span>
                                                    </td>
                                                    <td className="px-6 py-4 text-sm text-[#54656f] font-medium">
                                                        {row.avg_response_seconds > 0 ? formatAnalyticsDuration(row.avg_response_seconds) : '--'}
                                                    </td>
                                                    <td className="px-6 py-4 text-sm text-[#54656f] font-medium">{row.total_messages}</td>
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
                </div>
            )}

            {/* Admin View is handled above - deleting redundant block if any */}

            {!isMobile && (
            <div className="fixed bottom-6 right-6 z-[200] flex flex-col items-end gap-3">
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
            </div>
            )}

                </div>
            ) : workspaceSection === 'broadcast' ? (
                <div onTouchStart={handleMobileWorkspaceTouchStart} onTouchEnd={handleMobileWorkspaceTouchEnd}>
                    <BroadcastView
                        broadcastNav={broadcastNav}
                        broadcastSection={broadcastSection}
                        setBroadcastSection={setBroadcastSection}
                        activeProfileId={activeProfileId}
                        sessionToken={session?.access_token || null}
                        BroadcastTemplateBuilder={LazyBroadcastTemplateBuilder}
                        BroadcastTemplatesList={LazyBroadcastTemplatesList}
                        onToast={showToast}
                    />
                </div>
            ) : workspaceSection === 'automations' ? (
                <div onTouchStart={handleMobileWorkspaceTouchStart} onTouchEnd={handleMobileWorkspaceTouchEnd}>
                    <AutomationsView
                        workflows={automationWorkflows}
                        workflowsLoading={workflowsLoading}
                        isMobileView={isMobile}
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
                </div>
            ) : workspaceSection === 'chatbots' ? (
                <div onTouchStart={handleMobileWorkspaceTouchStart} onTouchEnd={handleMobileWorkspaceTouchEnd}>
                    <ChatbotsView
                        profileId={activeProfileId}
                        sessionToken={session?.access_token || null}
                        apiBaseUrl={SOCKET_URL}
                    />
                </div>
            ) : workspaceSection === 'more' ? (
                <div
                    className={`${isMobile ? 'h-[100dvh]' : 'h-screen'} qm-workspace-page qm-app-gradient text-[var(--qm-text)] font-sans`}
                    style={{
                        ...(mobileHeaderOffsetStyle || {}),
                        ...(mobileBottomNavPaddingStyle || {})
                    }}
                    onTouchStart={handleMobileWorkspaceTouchStart}
                    onTouchEnd={handleMobileWorkspaceTouchEnd}
                >
                    <div className="h-full qm-workspace-body overflow-y-auto custom-scrollbar">
                        <div className="max-w-3xl mx-auto space-y-4">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {!isUiFeatureHidden(SETTINGS_UI_FEATURE_KEY) && (
                                    <button
                                        type="button"
                                        onClick={openSettingsFromMore}
                                        className="text-left qm-card p-5 hover:bg-[#f8fbff] transition-all cursor-pointer pointer-events-auto"
                                    >
                                        <div className="flex items-center gap-3 mb-2">
                                            <div className="w-9 h-9 rounded-xl bg-[var(--qm-brand-soft)] border border-[var(--qm-border)] text-[var(--qm-brand)] flex items-center justify-center">
                                                <Settings className="w-5 h-5" />
                                            </div>
                                            <div className="text-lg font-black text-[var(--qm-text)]">Settings</div>
                                        </div>
                                        <p className="text-sm text-[var(--qm-text-muted)]">
                                            Webhooks, team users, credentials, and workspace configuration.
                                        </p>
                                    </button>
                                )}

                                {!isUiFeatureHidden('analytics') && (
                                    <button
                                        type="button"
                                        onClick={openAnalyticsFromMore}
                                        className="text-left qm-card p-5 hover:bg-[#f8fbff] transition-all cursor-pointer pointer-events-auto"
                                    >
                                        <div className="flex items-center gap-3 mb-2">
                                            <div className="w-9 h-9 rounded-xl bg-[#edf4ff] border border-[var(--qm-border)] text-[var(--qm-accent)] flex items-center justify-center">
                                                <BarChart3 className="w-5 h-5" />
                                            </div>
                                            <div className="text-lg font-black text-[var(--qm-text)]">Analytics</div>
                                        </div>
                                        <p className="text-sm text-[var(--qm-text-muted)]">
                                            View message totals, workflow metrics, and date-based performance.
                                        </p>
                                    </button>
                                )}

                                <a
                                    href="mailto:hello@2fast.xyz"
                                    className="text-left qm-card p-5 hover:bg-[#f8fbff] transition-all cursor-pointer pointer-events-auto"
                                >
                                    <div className="flex items-center gap-3 mb-2">
                                        <div className="w-9 h-9 rounded-xl bg-[#eef6ff] border border-[var(--qm-border)] text-[var(--qm-accent)] flex items-center justify-center">
                                            <LifeBuoy className="w-5 h-5" />
                                        </div>
                                        <div className="text-lg font-black text-[var(--qm-text)]">Support</div>
                                    </div>
                                    <p className="text-sm text-[var(--qm-text-muted)]">
                                        Need help with WABA setup, delivery issues, or account operations? Contact support directly.
                                    </p>
                                </a>
                            </div>
                        </div>
                    </div>
                </div>
            ) : workspaceSection === 'contacts' ? (
                <div onTouchStart={handleMobileWorkspaceTouchStart} onTouchEnd={handleMobileWorkspaceTouchEnd}>
                    <ContactsView
                        contactsList={contactsList}
                        isMobileView={isMobile}
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
                </div>
            ) : (
                <div
                    className={`${isMobile ? 'h-[100dvh]' : 'h-screen'} pt-[64px] lg:pt-[72px] bg-[#f8f9fa] text-[#111b21] font-sans`}
                    style={{
                        ...(mobileHeaderOffsetStyle || {}),
                        ...(mobileBottomNavPaddingStyle || {})
                    }}
                    onTouchStart={handleMobileWorkspaceTouchStart}
                    onTouchEnd={handleMobileWorkspaceTouchEnd}
                >
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

            {shouldShowMobileBottomNav && mobileWorkspaceTabs.length > 0 && (
                <BottomNavBar
                    items={mobileWorkspaceTabs.map((tab) => ({
                        id: tab.id,
                        label: tab.label,
                        icon: tab.icon,
                        badgeCount: tab.id === 'team-inbox' ? totalUnreadBadgeCount : undefined
                    }))}
                    activeId={showAnalytics ? 'more' : workspaceSection}
                    onSelect={(id) => {
                        if (id === 'more') {
                            openAnalyticsFromMore();
                            return;
                        }
                        setShowAnalytics(false);
                        setShowContactInfo(false);
                        if (id === 'team-inbox') {
                            setSelectedChatId(null);
                        }
                        setWorkspaceSection(id as typeof workspaceSection);
                    }}
                />
            )}

            {showPwaUpdateBanner && (
                <div className="fixed left-0 right-0 top-0 z-[320] pointer-events-none px-3 pt-[calc(env(safe-area-inset-top,0px)+12px)]">
                    <div className="mx-auto max-w-md pointer-events-auto rounded-2xl border border-white/15 bg-[#111b21] px-4 py-3 text-white shadow-[0_12px_34px_rgba(0,0,0,0.34)]">
                        <div className="text-[13px] font-bold">New update available</div>
                        <div className="mt-1 text-[11px] text-white/80">
                            A newer version is ready. Update now for the latest fixes.
                        </div>
                        <div className="mt-3 flex items-center justify-end gap-2">
                            <button
                                type="button"
                                onClick={() => setShowPwaUpdateBanner(false)}
                                className="px-3 py-1.5 rounded-lg border border-white/20 text-[11px] font-semibold text-white/85 hover:bg-white/10 transition-all"
                            >
                                Later
                            </button>
                            <button
                                type="button"
                                onClick={handleApplyPwaUpdate}
                                className="px-3 py-1.5 rounded-lg bg-[#00a884] text-[11px] font-semibold text-white hover:bg-[#008f72] transition-all"
                            >
                                Update now
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
            {visibleIncomingCalls.length > 0 && (
                <div
                    className="fixed top-4 left-4 z-[275] flex max-w-[420px] flex-col gap-3"
                    style={{
                        top: 'max(calc(env(safe-area-inset-top) + 0.5rem), 1rem)',
                        left: 'max(calc(env(safe-area-inset-left) + 0.5rem), 1rem)',
                        right: isMobile ? 'max(calc(env(safe-area-inset-right) + 0.5rem), 0.75rem)' : undefined
                    }}
                >
                    {visibleIncomingCalls.map((call) => {
                        const currentUserId = trimString(session?.user?.id);
                        const normalizedStatus = trimString(call.normalizedStatus).toLowerCase() || 'ringing';
                        const isClaimed = isIncomingCallClaimed(call);
                        const claimedByAnotherUser = isClaimed && !!call.acceptedByUserId && call.acceptedByUserId !== currentUserId;
                        const claimedByCurrentUserElsewhere = isClaimed && !!call.acceptedByUserId && call.acceptedByUserId === currentUserId;
                        const isTerminal = ['rejected', 'terminated', 'missed', 'failed'].includes(normalizedStatus);
                        const hasBusyCallSession = Boolean(activeVoiceCall || browserVoiceCallSessionRef.current);
                        const canAccept =
                            call.loadingAction === null
                            && normalizedStatus === 'ringing'
                            && !isClaimed
                            && !hasBusyCallSession;
                        const canReject =
                            call.loadingAction === null
                            && !isTerminal
                            && (!claimedByAnotherUser || isAdmin);
                        const canTerminate =
                            call.loadingAction === null
                            && !isTerminal
                            && (call.acceptedByUserId
                                ? call.acceptedByUserId === currentUserId || isAdmin
                                : isAdmin);
                        let statusMessage = '';
                        if (claimedByAnotherUser) {
                            statusMessage = call.acceptedByName
                                ? `Someone already answered this call. ${call.acceptedByName} is handling it.`
                                : 'Someone already answered this call.';
                        } else if (claimedByCurrentUserElsewhere) {
                            statusMessage = 'You already answered this call in another window.';
                        } else if (normalizedStatus === 'accepting' && call.acceptedByName) {
                            statusMessage = `${call.acceptedByName} is answering this call.`;
                        } else if (normalizedStatus === 'accepted' && call.acceptedByName) {
                            statusMessage = `${call.acceptedByName} accepted this call.`;
                        } else if (normalizedStatus === 'answered' && call.acceptedByName) {
                            statusMessage = `${call.acceptedByName} is on this call.`;
                        }

                        return (
                            <div
                                key={call.callId}
                                className="rounded-2xl border border-[#cde7dd] bg-white/98 px-4 py-3 shadow-[0_14px_34px_rgba(0,0,0,0.16)] backdrop-blur-sm"
                            >
                                <div className="flex items-start gap-3">
                                    <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[#dcfce7] text-[#047857]">
                                        <Phone className="h-5 w-5" />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2">
                                            <p className="truncate text-[13px] font-bold text-[#111b21]">
                                                {call.contactName || formatPhoneNumber(call.from || '') || call.from || 'Unknown caller'}
                                            </p>
                                            <span className="rounded-full bg-[#ecfdf5] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#047857]">
                                                {getIncomingCallStatusLabel(normalizedStatus)}
                                            </span>
                                        </div>
                                        <p className="mt-0.5 text-[12px] text-[#54656f]">
                                            {call.from || 'Unknown'} {call.to ? `to ${call.to}` : ''}
                                        </p>
                                        <p className="mt-0.5 text-[11px] font-medium text-[#7a8b97]">
                                            {new Date((call.timestamp || Date.now() / 1000) * 1000).toLocaleTimeString()}
                                        </p>
                                        {statusMessage && (
                                            <p className={`mt-2 text-[11px] font-semibold ${claimedByAnotherUser ? 'text-rose-700' : 'text-[#54656f]'}`}>
                                                {statusMessage}
                                            </p>
                                        )}
                                        <div className="mt-3 flex items-center gap-2">
                                            <button
                                                type="button"
                                                onClick={() => void handleIncomingCallAction(call.callId, 'accept')}
                                                disabled={!canAccept}
                                                className="rounded-xl border border-[#b7e4cf] bg-[#ecfdf5] px-3 py-1.5 text-[12px] font-bold text-[#047857] transition-all hover:bg-[#dcfce7] disabled:opacity-60"
                                            >
                                                {call.loadingAction === 'accept' ? 'Accepting...' : 'Accept'}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => void handleIncomingCallAction(call.callId, 'reject')}
                                                disabled={!canReject}
                                                className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-1.5 text-[12px] font-bold text-rose-700 transition-all hover:bg-rose-100 disabled:opacity-60"
                                            >
                                                {call.loadingAction === 'reject' ? 'Rejecting...' : 'Reject'}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => void handleIncomingCallAction(call.callId, 'terminate')}
                                                disabled={!canTerminate}
                                                className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-[12px] font-bold text-slate-700 transition-all hover:bg-slate-100 disabled:opacity-60"
                                            >
                                                {call.loadingAction === 'terminate' ? 'Ending...' : 'Terminate'}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
            {activeVoiceCall && (
                <div
                    className="fixed bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] left-4 right-4 z-[278] sm:left-auto sm:right-4 sm:max-w-[420px]"
                >
                    <div className="rounded-3xl border border-[#d7e9df] bg-white/98 px-4 py-4 shadow-[0_18px_42px_rgba(0,0,0,0.2)] backdrop-blur-sm">
                        <div className="flex items-start gap-3">
                            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#dcfce7] text-[#047857]">
                                <Phone className="h-5 w-5" />
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <p className="truncate text-[14px] font-bold text-[#111b21]">
                                        {activeVoiceCall.remoteLabel || formatPhoneNumber(activeVoiceCall.customerWaId || '') || activeVoiceCall.customerWaId || 'WhatsApp call'}
                                    </p>
                                    <span className="rounded-full bg-[#ecfdf5] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#047857]">
                                        {getVoiceCallStatusLabel(activeVoiceCall.status)}
                                    </span>
                                </div>
                                <p className="mt-0.5 text-[12px] text-[#54656f]">
                                    {activeVoiceCall.direction === 'inbound' ? 'Incoming voice call' : 'Outgoing voice call'}
                                    {activeVoiceCall.customerWaId ? ` • ${formatPhoneNumber(activeVoiceCall.customerWaId) || activeVoiceCall.customerWaId}` : ''}
                                </p>
                                <p className="mt-0.5 text-[11px] font-medium text-[#7a8b97]">
                                    Started {new Date(activeVoiceCall.startedAt).toLocaleTimeString()}
                                    {activeVoiceCall.muted ? ' • Mic muted' : ' • Mic live'}
                                </p>
                                {activeVoiceCall.lastError && (
                                    <p className="mt-1 text-[11px] font-medium text-rose-600">
                                        {activeVoiceCall.lastError}
                                    </p>
                                )}
                                <div className="mt-3 flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={toggleActiveVoiceCallMute}
                                        disabled={activeVoiceCall.status === 'ending'}
                                        className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-[12px] font-bold text-slate-700 transition-all hover:bg-slate-100 disabled:opacity-60"
                                    >
                                        <Mic className="h-3.5 w-3.5" />
                                        {activeVoiceCall.muted ? 'Unmute' : 'Mute'}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => void handleEndActiveVoiceCall()}
                                        disabled={activeVoiceCall.status === 'ending'}
                                        className="inline-flex items-center gap-1.5 rounded-xl border border-rose-200 bg-rose-50 px-3 py-1.5 text-[12px] font-bold text-rose-700 transition-all hover:bg-rose-100 disabled:opacity-60"
                                    >
                                        <X className="h-3.5 w-3.5" />
                                        {activeVoiceCall.status === 'ending' ? 'Ending...' : 'Hang up'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
            {appToast && (
                <div
                    className="fixed top-4 right-4 z-[280] max-w-[360px]"
                    style={{
                        top: 'max(calc(env(safe-area-inset-top) + 0.5rem), 1rem)',
                        right: 'max(calc(env(safe-area-inset-right) + 0.5rem), 1rem)',
                        left: isMobile ? 'max(env(safe-area-inset-left), 0.75rem)' : undefined
                    }}
                >
                    {appToast.variant === 'chat' ? (
                        <div className="rounded-2xl border border-[#d8e1e6] bg-white px-3.5 py-3 shadow-[0_12px_30px_rgba(0,0,0,0.18)]">
                            <div className="flex items-start gap-3">
                                <div className="w-10 h-10 rounded-full bg-[#dcf8c6] border border-[#b9e3ad] text-[#128c7e] text-xs font-black flex items-center justify-center shrink-0">
                                    {appToast.avatarLabel || getInitials(appToast.title || 'M')}
                                </div>
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                        <p className="text-[13px] font-bold text-[#111b21] truncate">
                                            {appToast.title || 'New message'}
                                        </p>
                                        <span className="text-[10px] font-bold text-[#00a884] uppercase tracking-wide">Now</span>
                                    </div>
                                    <p className="mt-0.5 text-[12px] leading-5 text-[#54656f] break-words">
                                        {appToast.message}
                                    </p>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div
                            className={`rounded-xl border px-4 py-2.5 text-sm font-semibold shadow-lg ${appToast.tone === 'success'
                                    ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                                    : 'bg-rose-50 border-rose-200 text-rose-700'
                                }`}
                        >
                            {appToast.message}
                        </div>
                    )}
                </div>
            )}
            <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
            {debugOverlayEnabled && isMobile && (
                <div
                    className="fixed z-[285] left-2 right-2"
                    style={{
                        bottom: 'calc(env(safe-area-inset-bottom) + 4.75rem)'
                    }}
                >
                    <div className="rounded-xl border border-[#d7dee4] bg-white/95 shadow-[0_10px_30px_rgba(0,0,0,0.18)] backdrop-blur-sm overflow-hidden">
                        <button
                            type="button"
                            onClick={() => setDebugPanelOpen((prev) => !prev)}
                            className="w-full px-3 py-2 flex items-center justify-between text-[11px] font-extrabold uppercase tracking-[0.12em] text-[#334155] bg-[#f8fbff] border-b border-[#e4ebf1]"
                        >
                            <span>Mobile Debug</span>
                            <span>{debugPanelOpen ? 'Hide' : 'Show'}</span>
                        </button>
                        {debugPanelOpen && (
                            <div className="max-h-[42vh] overflow-y-auto custom-scrollbar px-3 py-2">
                                <div className="pb-2 flex items-center justify-end">
                                    <button
                                        type="button"
                                        onClick={handleCopyMobileDebugSnapshot}
                                        className="h-7 px-2.5 rounded-md border border-[#d1dbe5] bg-white text-[10px] font-extrabold uppercase tracking-[0.08em] text-[#334155] hover:bg-[#f8fbff] transition-colors"
                                    >
                                        Copy
                                    </button>
                                </div>
                                <pre className="text-[11px] leading-5 text-[#1f2937] whitespace-pre-wrap break-all">{debugSnapshotText}</pre>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </>
    );
}







