import express, { type Express } from 'express'
import {
    claimWhatsappCallAcceptLock,
    getRecentWhatsappRawWebhookEvents,
    getStoredWhatsappCall,
    getStoredWhatsappCallPermission,
    insertWhatsappCallPermissionRequest,
    isStoredCallPermissionCurrentlyApproved,
    upsertWhatsappCall,
    type MetaWebhookEventType
} from '../../src/services/meta-whatsapp-store'
import { getApiBasePath, isOfficialMetaOnlyMode } from '../../src/config/runtime-policy'

const COMMAND_MAX_COUNT = 30
const COMMAND_NAME_MAX_LENGTH = 32
const COMMAND_DESCRIPTION_MAX_LENGTH = 256
const COMMAND_NAME_REGEX = /^[a-z0-9_-]+$/
const EMOJI_REGEX = /\p{Extended_Pictographic}/u
const SCHEDULED_BROADCAST_MAX_RECIPIENTS = 500
const SCHEDULED_BROADCAST_TICK_MS = 30_000
const CALL_ACCEPT_LOCK_TTL_MS = 45_000
const CALL_OWNER_STATUSES = new Set(['accepting', 'accepted', 'answered'])
const CALL_TERMINAL_STATUSES = new Set(['rejected', 'terminated', 'missed', 'failed'])
const SUPPORTED_DATA_LOCALIZATION_REGIONS = new Set([
    'AU',
    'ID',
    'IN',
    'JP',
    'SG',
    'KR',
    'DE',
    'CH',
    'GB',
    'BR',
    'BH',
    'ZA',
    'AE',
    'CA'
])

type ConversationalCommand = {
    command_name: string
    command_description: string
}

function trimText(value: any): string {
    return typeof value === 'string' ? value.trim() : ''
}

function sanitizeCommandName(value: any): string {
    return trimText(value).replace(/^\/+/, '').toLowerCase()
}

function sanitizeConversationalCommands(rawCommands: any): ConversationalCommand[] {
    if (!Array.isArray(rawCommands)) return []

    const cleaned: ConversationalCommand[] = []
    const seen = new Set<string>()

    for (let index = 0; index < rawCommands.length; index += 1) {
        const item = rawCommands[index] || {}
        const commandName = sanitizeCommandName(item.command_name)
        const commandDescription = trimText(item.command_description)
        const label = `commands[${index}]`

        if (!commandName && !commandDescription) continue
        if (!commandName || !commandDescription) {
            throw new Error(`${label} requires both command_name and command_description`)
        }
        if (commandName.length > COMMAND_NAME_MAX_LENGTH) {
            throw new Error(`${label}.command_name must be at most ${COMMAND_NAME_MAX_LENGTH} characters`)
        }
        if (commandDescription.length > COMMAND_DESCRIPTION_MAX_LENGTH) {
            throw new Error(`${label}.command_description must be at most ${COMMAND_DESCRIPTION_MAX_LENGTH} characters`)
        }
        if (!COMMAND_NAME_REGEX.test(commandName)) {
            throw new Error(`${label}.command_name supports lowercase letters, numbers, underscore, and hyphen only`)
        }
        if (EMOJI_REGEX.test(commandName) || EMOJI_REGEX.test(commandDescription)) {
            throw new Error(`${label} does not support emoji`)
        }
        if (seen.has(commandName)) {
            throw new Error(`Duplicate command_name "${commandName}" is not allowed`)
        }

        seen.add(commandName)
        cleaned.push({
            command_name: commandName,
            command_description: commandDescription
        })
    }

    if (cleaned.length > COMMAND_MAX_COUNT) {
        throw new Error(`commands supports up to ${COMMAND_MAX_COUNT} items`)
    }

    return cleaned
}

function sanitizeConversationalPrompts(rawPrompts: any): string[] {
    if (!Array.isArray(rawPrompts)) return []
    return rawPrompts
        .map((value) => trimText(value))
        .filter(Boolean)
}

function toHttpErrorPayload(error: any, fallback = 'Unexpected error'): {
    status: number
    payload: { success: false; error: string; details?: string[] }
} {
    const statusFromObject = Number(error?.status)
    let status = Number.isFinite(statusFromObject) ? statusFromObject : 500
    const message = trimText(error?.message) || fallback

    if (!Number.isFinite(statusFromObject)) {
        const match = /^WABA API error\s+(\d+):\s*/i.exec(message)
        if (match?.[1]) {
            const parsed = Number.parseInt(match[1], 10)
            if (Number.isFinite(parsed)) status = parsed
        }
    }

    if (!Number.isFinite(status) || status < 400 || status > 599) status = 500

    const graphMessage = trimText(error?.response?.error?.message)
    const graphType = trimText(error?.response?.error?.type)
    const graphCode = error?.response?.error?.code
    const graphSubcode = error?.response?.error?.error_subcode

    const details: string[] = []
    if (graphMessage && graphMessage !== message) details.push(graphMessage)
    if (graphType) details.push(`type=${graphType}`)
    if (graphCode !== undefined && graphCode !== null && String(graphCode).trim()) details.push(`code=${graphCode}`)
    if (graphSubcode !== undefined && graphSubcode !== null && String(graphSubcode).trim()) details.push(`subcode=${graphSubcode}`)
    const appUserAdvice = buildMetaAppUserTokenAdvice(message || graphMessage)
    if (appUserAdvice) details.push(appUserAdvice)

    return {
        status,
        payload: {
            success: false,
            error: message,
            ...(details.length > 0 ? { details } : {})
        }
    }
}

const SUPER_ADMIN_ROLE_VALUES = new Set(['super_admin', 'superadmin', 'super-admin'])

function isSuperAdminUser(user: any): boolean {
    const userMeta = user?.user_metadata || {}
    const appMeta = user?.app_metadata || {}
    const roleCandidates = [
        userMeta.role,
        appMeta.role
    ]
    const flagCandidates = [
        userMeta.super_admin,
        userMeta.is_super_admin,
        appMeta.super_admin,
        appMeta.is_super_admin
    ]

    const hasRole = roleCandidates.some((value) => {
        if (typeof value !== 'string') return false
        return SUPER_ADMIN_ROLE_VALUES.has(value.trim().toLowerCase())
    })
    if (hasRole) return true

    return flagCandidates.some((value) => {
        if (value === true) return true
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase()
            return normalized === 'true' || normalized === '1' || normalized === 'yes'
        }
        return false
    })
}

function serializeSystemRuntimeStatus(value: any) {
    const maintenance = value?.maintenance && typeof value.maintenance === 'object'
        ? value.maintenance
        : {}
    const downtimeLog = Array.isArray(value?.downtimeLog) ? value.downtimeLog : []
    return {
        online: value?.online === true,
        started_at: trimText(value?.startedAt),
        current_time: trimText(value?.currentTime),
        uptime_ms: Number.isFinite(Number(value?.uptimeMs)) ? Math.max(0, Math.floor(Number(value.uptimeMs))) : 0,
        heartbeat_at: trimText(value?.heartbeatAt) || null,
        maintenance: {
            enabled: maintenance?.enabled === true,
            message: trimText(maintenance?.message),
            updated_at: trimText(maintenance?.updatedAt) || null,
            updated_by: trimText(maintenance?.updatedBy) || null
        },
        last_offline_at: trimText(value?.lastOfflineAt) || null,
        last_offline_ended_at: trimText(value?.lastOfflineEndedAt) || null,
        last_offline_duration_ms: Number.isFinite(Number(value?.lastOfflineDurationMs))
            ? Math.max(0, Math.floor(Number(value.lastOfflineDurationMs)))
            : null,
        downtime_log: downtimeLog.map((entry: any) => ({
            id: trimText(entry?.id),
            offline_from: trimText(entry?.offlineFrom),
            offline_until: trimText(entry?.offlineUntil),
            duration_ms: Number.isFinite(Number(entry?.durationMs)) ? Math.max(0, Math.floor(Number(entry.durationMs))) : 0,
            reason: trimText(entry?.reason)
        }))
    }
}

function toTemplateText(value: any): string {
    if (value === null || value === undefined) return ''
    return String(value)
}

function parsePreverifiedIdsInput(value: any): string[] {
    const out = new Set<string>()

    const push = (entry: any) => {
        const text = typeof entry === 'string' ? entry.trim() : ''
        if (!text) return
        out.add(text)
    }

    if (Array.isArray(value)) {
        value.forEach((entry) => push(entry))
    } else if (typeof value === 'string') {
        const trimmed = value.trim()
        if (!trimmed) return []
        try {
            const parsed = JSON.parse(trimmed)
            if (Array.isArray(parsed)) {
                parsed.forEach((entry) => push(entry))
            } else {
                trimmed.split(',').forEach((entry) => push(entry))
            }
        } catch {
            trimmed.split(',').forEach((entry) => push(entry))
        }
    }

    return Array.from(out)
}

type EmbeddedSignupFeatureType = 'whatsapp_business_app_onboarding'

function parseEmbeddedSignupFeatureType(value: any): EmbeddedSignupFeatureType | null {
    const raw = trimText(value).toLowerCase()
    if (!raw) return null
    if (raw === 'whatsapp_business_app_onboarding') return 'whatsapp_business_app_onboarding'
    if (raw === 'business_app_onboarding') return 'whatsapp_business_app_onboarding'
    if (raw === 'coexistence') return 'whatsapp_business_app_onboarding'
    return null
}

function parseEmbeddedSignupSessionInfoVersion(value: any): string | null {
    const raw = trimText(value)
    if (!raw) return null
    if (!/^\d+$/.test(raw)) return null
    return raw
}

function isTruthyFlag(value: any): boolean {
    if (value === true) return true
    const raw = trimText(value).toLowerCase()
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

function buildEmbeddedSignupExtras(params: {
    preverifiedIds: string[]
    featureType?: EmbeddedSignupFeatureType | null
    sessionInfoVersion?: string | null
}): Record<string, any> | undefined {
    const hasPreverified = Array.isArray(params.preverifiedIds) && params.preverifiedIds.length > 0
    const featureType = params.featureType || null
    const sessionInfoVersion = params.sessionInfoVersion || null
    if (!hasPreverified && !featureType && !sessionInfoVersion) {
        return undefined
    }

    const setup: Record<string, any> = {}
    if (hasPreverified) {
        setup.preVerifiedPhone = {
            ids: params.preverifiedIds
        }
    }

    const extras: Record<string, any> = {
        feature: 'whatsapp_embedded_signup',
        version: 2,
        setup
    }

    if (featureType) {
        extras.featureType = featureType
    }
    if (sessionInfoVersion) {
        extras.sessionInfoVersion = sessionInfoVersion
    }

    return extras
}

function parseScheduledRecipientsInput(value: any): string[] {
    const deduped = new Set<string>()

    const push = (entry: any) => {
        const text = typeof entry === 'string' ? entry.trim() : ''
        if (!text) return
        deduped.add(text)
    }

    if (Array.isArray(value)) {
        value.forEach((entry) => push(entry))
    } else if (typeof value === 'string') {
        const trimmed = value.trim()
        if (!trimmed) return []
        trimmed
            .split(/[\n,;]+/)
            .map((item) => item.trim())
            .filter(Boolean)
            .forEach((item) => push(item))
    }

    return Array.from(deduped)
}

function parseTokenScopes(value: any): string[] {
    if (Array.isArray(value)) {
        return Array.from(
            new Set(
                value
                    .map((entry) => trimText(entry))
                    .filter(Boolean)
            )
        )
    }

    const raw = trimText(value)
    if (!raw) return []

    try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
            return Array.from(
                new Set(
                    parsed
                        .map((entry) => trimText(entry))
                        .filter(Boolean)
                )
            )
        }
    } catch {
        // fall through to comma-separated parsing
    }

    return Array.from(
        new Set(
            raw
                .split(/[,\s]+/)
                .map((entry) => trimText(entry))
                .filter(Boolean)
        )
    )
}

function parseDataLocalizationRegion(value: any): string | null {
    const raw = trimText(value).toUpperCase()
    if (!raw) return null
    if (!SUPPORTED_DATA_LOCALIZATION_REGIONS.has(raw)) return null
    return raw
}

type ReviewDeliveryStage = 'accepted' | 'sent' | 'delivered' | 'read' | 'failed'
type MetaPhoneNumberRemovalMode = 'deregister' | 'graph-delete' | 'legacy-delete'

function normalizeReviewDeliveryStage(value: any): ReviewDeliveryStage {
    const raw = trimText(value).toLowerCase()
    if (raw === 'sent') return 'sent'
    if (raw === 'delivered') return 'delivered'
    if (raw === 'read') return 'read'
    if (raw === 'failed') return 'failed'
    return 'accepted'
}

function normalizeGraphApiVersion(value: any, fallback = 'v19.0'): string {
    const raw = trimText(value) || fallback
    const normalized = raw.startsWith('v') ? raw : `v${raw}`
    if (!/^v\d+(\.\d+)?$/i.test(normalized)) {
        throw new Error('apiVersion must look like v19.0')
    }
    return normalized
}

function normalizeMetaNumericId(value: any, label: string): string {
    const raw = trimText(value)
    if (!raw) {
        throw new Error(`${label} is required`)
    }
    if (!/^\d+$/.test(raw)) {
        throw new Error(`${label} must contain digits only`)
    }
    return raw
}

function normalizeMetaPhoneRemovalMode(value: any): MetaPhoneNumberRemovalMode {
    const raw = trimText(value).toLowerCase()
    if (raw === 'graph-delete' || raw === 'legacy-delete') return raw
    return 'deregister'
}

async function requestMetaPhoneNumberRemoval(params: {
    mode: MetaPhoneNumberRemovalMode
    apiVersion: string
    accessToken: string
    wabaId?: string
    phoneNumberId: string
}) {
    const phoneNumberId = normalizeMetaNumericId(params.phoneNumberId, 'phoneNumberId')
    let method = 'POST'
    let path = `${phoneNumberId}/deregister`

    if (params.mode === 'graph-delete' || params.mode === 'legacy-delete') {
        method = 'DELETE'
        const wabaId = normalizeMetaNumericId(params.wabaId, 'wabaId')
        path = params.mode === 'legacy-delete'
            ? `whatsapp_business_accounts/${wabaId}/phone_numbers/${phoneNumberId}`
            : `${wabaId}/phone_numbers/${phoneNumberId}`
    }

    const url = `https://graph.facebook.com/${params.apiVersion}/${path}`
    const response = await fetch(url, {
        method,
        headers: {
            Authorization: `Bearer ${params.accessToken}`
        }
    })
    const text = await response.text()
    let data: any = null
    try {
        data = text ? JSON.parse(text) : null
    } catch {
        data = text || null
    }

    if (!response.ok || data?.error) {
        const message = trimText(data?.error?.message) || response.statusText || 'Meta API request failed'
        const error: any = new Error(`Meta API error ${response.status}: ${message}`)
        error.status = response.status
        error.response = data
        throw error
    }

    return {
        method,
        path: `/${params.apiVersion}/${path}`,
        data
    }
}

function buildMetaAppUserTokenAdvice(message: string): string | null {
    const match = /Cannot call API for app\s+(\d+)\s+on behalf of user\s+(\d+)/i.exec(message || '')
    if (!match) return null
    return `Meta rejected the Facebook user token for app ${match[1]} and user ${match[2]}. Put the Meta app in Live mode or add that Facebook user as an app Admin/Developer/Tester while testing. For production WABA operations, use a business integration or system user token with WhatsApp permissions and full access to the WABA/phone number.`
}

function formatMetaOperationError(error: any, fallback: string): string {
    const normalized = toHttpErrorPayload(error, fallback)
    const details = normalized.payload.details || []
    return details.length > 0
        ? `${normalized.payload.error} (${details.join('; ')})`
        : normalized.payload.error
}

function toMetaTimestampIso(value: any): string | null {
    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric <= 0) return null
    const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1000
    const date = new Date(milliseconds)
    if (Number.isNaN(date.getTime())) return null
    return date.toISOString()
}

function buildReviewDeliveryTimeline(stage: ReviewDeliveryStage) {
    const reachedSent = stage === 'sent' || stage === 'delivered' || stage === 'read' || stage === 'failed'
    const reachedDelivered = stage === 'delivered' || stage === 'read'
    return {
        accepted: true,
        sent: reachedSent,
        delivered: reachedDelivered,
        read: stage === 'read',
        failed: stage === 'failed'
    }
}

function isMissingWabaConfigsUpdatedAtError(error: any): boolean {
    const code = typeof error?.code === 'string' ? error.code : ''
    const message = String(error?.message || '').toLowerCase()
    if (code !== '42703') return false
    return message.includes('waba_configs.updated_at') || message.includes('updated_at')
}

function isMissingWhatsappConnectionsTableError(error: any): boolean {
    const code = typeof error?.code === 'string' ? error.code : ''
    const message = String(error?.message || '').toLowerCase()
    if (code !== '42P01') return false
    return message.includes('whatsapp_connections')
}

function formatScheduledBroadcastError(value: any): string {
    if (!value) return 'Unknown error'
    if (typeof value === 'string') return value
    if (typeof value?.message === 'string' && value.message.trim()) return value.message.trim()
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

function resolveMetaAppIdFromEnv(): string {
    return trimText(process.env.META_APP_ID || process.env.WABA_APP_ID || process.env.APP_ID)
}

function resolveMetaAppSecretFromEnv(): string {
    return trimText(process.env.META_APP_SECRET || process.env.WABA_APP_SECRET || process.env.APP_SECRET)
}

function resolveMetaVerifyTokenFromEnv(): string {
    return trimText(process.env.META_WEBHOOK_VERIFY_TOKEN || process.env.WABA_VERIFY_TOKEN || process.env.VERIFY_TOKEN)
}

function resolveMetaGraphVersionFromEnv(fallback = 'v25.0'): string {
    return normalizeGraphApiVersion(process.env.META_GRAPH_VERSION || process.env.WABA_API_VERSION || fallback, fallback)
}

function resolveMetaEmbeddedSignupV4ConfigIdFromEnv(): string {
    return trimText(
        process.env.META_WA_EMBEDDED_SIGNUP_V4_CONFIGURATION_ID
        || process.env.WABA_EMBEDDED_SIGNUP_V4_CONFIGURATION_ID
        || process.env.WABA_EMBEDDED_SIGNUP_CONFIG_ID
    )
}

function resolveMetaCoexistenceConfigIdFromEnv(): string {
    return trimText(
        process.env.META_WA_COEXISTENCE_CONFIGURATION_ID
        || process.env.WABA_COEXISTENCE_CONFIGURATION_ID
        || process.env.META_WA_EXISTING_APP_CONFIGURATION_ID
        || process.env.WABA_EXISTING_APP_CONFIGURATION_ID
    )
}

function resolveMetaExistingAppConfigIdFromEnv(): string {
    return resolveMetaCoexistenceConfigIdFromEnv()
}

function buildMetaGraphUrl(path: string, apiVersion: string, params?: Record<string, string>) {
    const cleanPath = path.startsWith('/') ? path.slice(1) : path
    const url = new URL(`https://graph.facebook.com/${apiVersion}/${cleanPath}`)
    if (params) {
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
        })
    }
    return url.toString()
}

async function requestMetaGraph(path: string, options: {
    accessToken?: string
    apiVersion?: string
    method?: string
    params?: Record<string, string>
    body?: any
} = {}) {
    const apiVersion = options.apiVersion || resolveMetaGraphVersionFromEnv()
    const url = path.startsWith('http')
        ? path
        : buildMetaGraphUrl(path, apiVersion, options.params)

    const headers: Record<string, string> = {}
    if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`
    let body: string | undefined

    if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json'
        body = JSON.stringify(options.body)
    }

    const response = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body
    })

    const text = await response.text()
    let data: any = null
    try {
        data = text ? JSON.parse(text) : null
    } catch {
        data = text || null
    }

    if (!response.ok || data?.error) {
        const message = trimText(data?.error?.message) || response.statusText || 'Meta Graph API request failed'
        const error: any = new Error(`Meta Graph API error ${response.status}: ${message}`)
        error.status = response.status
        error.response = data
        throw error
    }

    return data
}

function isMetaAlreadyRegisteredError(error: any): boolean {
    const message = trimText(error?.response?.error?.message || error?.message).toLowerCase()
    return (
        message.includes('already registered')
        || message.includes('already connected')
        || message.includes('is already active')
    )
}

function isMetaAlreadySubscribedError(error: any): boolean {
    const message = trimText(error?.response?.error?.message || error?.message).toLowerCase()
    return message.includes('already subscribed') || message.includes('subscribed')
}

function isMetaPinRequiredError(error: any): boolean {
    const message = trimText(error?.response?.error?.message || error?.message).toLowerCase()
    return message.includes('pin') && (message.includes('required') || message.includes('missing'))
}

function normalizeConnectionDisplayName(phoneDetails: any): string | null {
    return trimText(phoneDetails?.display_name || phoneDetails?.name || phoneDetails?.verified_name) || null
}

function sanitizeOnboardingResponse(value: any): any {
    if (!value || typeof value !== 'object') return value ?? null
    const clone = JSON.parse(JSON.stringify(value))
    if (clone && typeof clone === 'object') {
        delete clone.access_token
        delete clone.token
        delete clone.system_user_token
        delete clone.business_integration_system_user_token
    }
    return clone
}

function deriveOnboardingTypeFromFlow(flowType: string): 'normal' | 'coexistence' {
    const normalized = trimText(flowType).toLowerCase()
    if (
        normalized === 'whatsapp_business_app_onboarding' ||
        normalized === 'business_app_onboarding' ||
        normalized === 'coexistence' ||
        normalized === 'existing_business_app'
    ) {
        return 'coexistence'
    }
    return 'normal'
}

function extractCallPermissionSummary(payload: any): {
    permissionStatus: string
    canStartCall: boolean
    canRequestPermission: boolean
    expirationTime: string | null
} {
    const permissionStatus = trimText(payload?.permission?.status || payload?.data?.permission?.status).toLowerCase()
    const expirationTime =
        trimText(payload?.permission?.expiration_time || payload?.data?.permission?.expiration_time) || null
    const actions = Array.isArray(payload?.actions)
        ? payload.actions
        : Array.isArray(payload?.data?.actions)
            ? payload.data.actions
            : []
    const canStartCall = actions.some((entry: any) => (
        trimText(entry?.action_name).toLowerCase() === 'start_call' && entry?.can_perform_action === true
    ))
    const canRequestPermission = actions.some((entry: any) => (
        trimText(entry?.action_name).toLowerCase() === 'send_call_permission_request' && entry?.can_perform_action === true
    ))

    return {
        permissionStatus,
        canStartCall,
        canRequestPermission,
        expirationTime
    }
}

function mapRecentWebhookTypeFilter(value: any): MetaWebhookEventType | null {
    const raw = trimText(value).toLowerCase()
    if (!raw) return null
    if (raw === 'history' || raw === 'coexistence') return 'coexistence_history'
    if (raw === 'call') return 'call'
    if (raw === 'permission_reply' || raw === 'call_permission_reply') return 'call_permission_reply'
    if (raw === 'message') return 'message'
    if (raw === 'status') return 'status'
    if (raw === 'unknown') return 'unknown'
    return null
}

export function registerWabaRoutes(app: Express, ctx: any) {
    const {
        assertProfileCompany,
        buildEmbeddedSignupUrl,
        buildTemplateSendComponents,
        createSystemUserToken,
        createTemplateMediaHeaderHandle,
        decryptToken,
        encryptToken,
        exchangeCodeForToken,
        exchangeForLongLivedToken,
        fetchBusinessIntegrationSystemUserToken,
        fetchBusinesses,
        fetchClientBusinessId,
        fetchClientWabaAccounts,
        fetchOwnedWabaAccounts,
        fetchPhoneNumbers,
        findConflictingActivePhoneNumberConfig,
        findOrCreateUser,
        getCompanyRoom,
        getCompanyIdForProfile,
        getMessagesForUsers,
        getMessagesForUsersSince,
        getSupabaseUserFromRequest,
        getTokenEncryptionKey,
        getUserCompanyId,
        getUsersForCompany,
        hashOAuthState,
        insertMessage,
        isAdminUser,
        normalizePhoneNumber,
        parseAuthenticationCode,
        parseAuthenticationPreviewOptions,
        parseMarketingSendOptions,
        randomBytes,
        readTrimmed,
        resolveOauthMode,
        resolveOauthRedirectUri,
        resolveOauthReturnUrl,
        resolveProfileAccess,
        sendWhatsAppMessage,
        setUserTemplateAttributes,
        io,
        subscribeWabaApp,
        supabase,
        systemRuntimeStatus,
        unsubscribeWabaApp,
        validateAuthenticationTemplateInput,
        validateAuthenticationUpsertInput,
        validateMarketingTemplateInput,
        validateTemplateSendComponents,
        validateUtilityTemplateInput,
        wabaRegistry,
        WABA_OAUTH_SCOPES
    } = ctx

    const shapeWhatsAppConnectionRow = (row: any) => ({
        id: trimText(row?.id) || null,
        company_id: trimText(row?.company_id) || null,
        profile_id: trimText(row?.profile_id) || null,
        user_id: trimText(row?.user_id) || null,
        waba_id: trimText(row?.waba_id) || null,
        phone_number_id: trimText(row?.phone_number_id) || null,
        business_id: trimText(row?.business_id) || null,
        phone_number: trimText(row?.phone_number) || null,
        display_name: trimText(row?.display_name) || null,
        verified_name: trimText(row?.verified_name) || null,
        account_review_status: trimText(row?.account_review_status) || null,
        business_verification_status: trimText(row?.business_verification_status) || null,
        quality_rating: trimText(row?.quality_rating) || null,
        platform_type: trimText(row?.platform_type) || null,
        is_on_biz_app: row?.is_on_biz_app === true ? true : row?.is_on_biz_app === false ? false : null,
        status: trimText(row?.status) || null,
        flow_type: trimText(row?.flow_type) || null,
        coexistence_enabled: row?.coexistence_enabled === true,
        onboarding_type: trimText(row?.onboarding_type) || null,
        coexistence_status: trimText(row?.coexistence_status) || null,
        sync_status: trimText(row?.sync_status) || null,
        contacts_sync_request_id: trimText(row?.contacts_sync_request_id) || null,
        history_sync_request_id: trimText(row?.history_sync_request_id) || null,
        sync_started_at: trimText(row?.sync_started_at) || null,
        history_sync_progress: Number.isFinite(Number(row?.history_sync_progress))
            ? Math.max(0, Math.min(100, Math.floor(Number(row.history_sync_progress))))
            : null,
        history_sync_requested: row?.history_sync_requested === true,
        history_sync_available: row?.history_sync_available === true,
        messaging_paused: row?.messaging_paused === true,
        disconnection_reason: trimText(row?.disconnection_reason) || null,
        disconnection_initiated_by: trimText(row?.disconnection_initiated_by) || null,
        last_account_update_event: trimText(row?.last_account_update_event) || null,
        last_webhook_at: trimText(row?.last_webhook_at) || null,
        token_expires_at: trimText(row?.token_expires_at) || null,
        last_synced_at: trimText(row?.last_synced_at) || null,
        created_at: trimText(row?.created_at) || null,
        updated_at: trimText(row?.updated_at) || null
    })

    const exchangeEmbeddedSignupCodeForToken = async (params: {
        code: string
        appId: string
        appSecret: string
        apiVersion: string
        req?: any
    }) => {
        const baseUrl = buildMetaGraphUrl('oauth/access_token', params.apiVersion, {
            client_id: params.appId,
            client_secret: params.appSecret,
            code: params.code
        })

        try {
            return await requestMetaGraph(baseUrl, { method: 'GET' })
        } catch (error) {
            if (!params.req) throw error
            const redirectUri = resolveOauthRedirectUri(params.req)
            return exchangeCodeForToken({
                appId: params.appId,
                appSecret: params.appSecret,
                redirectUri,
                code: params.code,
                apiVersion: params.apiVersion
            })
        }
    }

    const fetchWabaAndPhoneDetails = async (params: {
        accessToken: string
        apiVersion: string
        wabaId: string
        phoneNumberId: string
    }) => {
        const [wabaDetails, phoneDetails] = await Promise.all([
            requestMetaGraph(params.wabaId, {
                accessToken: params.accessToken,
                apiVersion: params.apiVersion,
                params: {
                    fields: 'id,name,currency,timezone_id,account_review_status,business_verification_status,message_template_namespace'
                }
            }),
            requestMetaGraph(params.phoneNumberId, {
                accessToken: params.accessToken,
                apiVersion: params.apiVersion,
                params: {
                    fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,status,name,is_on_biz_app'
                }
            })
        ])

        return { wabaDetails, phoneDetails }
    }

    const fetchWabaPhoneNumbers = async (params: {
        accessToken: string
        apiVersion: string
        wabaId: string
    }) => {
        const response = await requestMetaGraph(`${params.wabaId}/phone_numbers`, {
            accessToken: params.accessToken,
            apiVersion: params.apiVersion,
            params: {
                fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,status,name,is_on_biz_app'
            }
        })

        return Array.isArray(response?.data) ? response.data : []
    }

    const startCoexistenceSync = async (params: {
        connectionId: string
        accessToken: string
        apiVersion: string
        phoneNumberId: string
    }) => {
        const { data: existingRow, error: existingError } = await supabase
            .from('whatsapp_connections')
            .select('contacts_sync_request_id, history_sync_request_id, sync_status')
            .eq('id', params.connectionId)
            .maybeSingle()

        if (existingError && !isMissingWhatsappConnectionsTableError(existingError)) {
            throw new Error(existingError.message)
        }

        const nowIso = new Date().toISOString()
        let contactsSyncRequestId = trimText(existingRow?.contacts_sync_request_id) || null
        let historySyncRequestId = trimText(existingRow?.history_sync_request_id) || null
        let syncStatus = trimText(existingRow?.sync_status) || 'pending'

        if (!contactsSyncRequestId) {
            const contactsResponse = await requestMetaGraph(`${params.phoneNumberId}/smb_app_data`, {
                accessToken: params.accessToken,
                apiVersion: params.apiVersion,
                method: 'POST',
                body: {
                    messaging_product: 'whatsapp',
                    sync_type: 'smb_app_state_sync'
                }
            })
            contactsSyncRequestId = trimText(
                contactsResponse?.request_id
                || contactsResponse?.id
                || contactsResponse?.data?.request_id
            ) || null
        }

        if (!historySyncRequestId) {
            const historyResponse = await requestMetaGraph(`${params.phoneNumberId}/smb_app_data`, {
                accessToken: params.accessToken,
                apiVersion: params.apiVersion,
                method: 'POST',
                body: {
                    messaging_product: 'whatsapp',
                    sync_type: 'history'
                }
            })
            historySyncRequestId = trimText(
                historyResponse?.request_id
                || historyResponse?.id
                || historyResponse?.data?.request_id
            ) || null
        }

        if (contactsSyncRequestId || historySyncRequestId) {
            syncStatus = 'in_progress'
        }

        const { error: updateError } = await supabase
            .from('whatsapp_connections')
            .update({
                contacts_sync_request_id: contactsSyncRequestId,
                history_sync_request_id: historySyncRequestId,
                history_sync_requested: Boolean(historySyncRequestId),
                history_sync_available: Boolean(historySyncRequestId),
                sync_started_at: nowIso,
                sync_status: syncStatus,
                updated_at: nowIso
            })
            .eq('id', params.connectionId)

        if (updateError && !isMissingWhatsappConnectionsTableError(updateError)) {
            throw new Error(updateError.message)
        }

        return {
            contactsSyncRequestId,
            historySyncRequestId,
            syncStartedAt: nowIso,
            syncStatus
        }
    }

    const completeCoexistenceOnboarding = async (params: {
        req: any
        companyId: string
        profileId: string
        userId: string
        code: string
        wabaId: string
        phoneNumberId?: string | null
        businessId?: string | null
    }) => {
        const appId = resolveMetaAppIdFromEnv()
        const appSecret = resolveMetaAppSecretFromEnv()
        const verifyToken = resolveMetaVerifyTokenFromEnv()
        const apiVersion = resolveMetaGraphVersionFromEnv('v24.0')
        if (!appId || !appSecret) {
            const error: any = new Error('Missing META_APP_ID or META_APP_SECRET')
            error.status = 500
            throw error
        }
        if (!verifyToken) {
            const error: any = new Error('Missing META_WEBHOOK_VERIFY_TOKEN or WABA_VERIFY_TOKEN')
            error.status = 500
            throw error
        }
        if (!getTokenEncryptionKey()) {
            const error: any = new Error('Missing WABA_TOKEN_ENCRYPTION_KEY or ENCRYPTION_KEY')
            error.status = 500
            throw error
        }

        const tokenData = await exchangeEmbeddedSignupCodeForToken({
            code: params.code,
            appId,
            appSecret,
            apiVersion,
            req: params.req
        })

        const accessToken = trimText(tokenData?.access_token)
        const accessTokenType = trimText(tokenData?.token_type) || null
        const expiresIn = Number(tokenData?.expires_in)
        const accessTokenExpiresAt = Number.isFinite(expiresIn) && expiresIn > 0
            ? new Date(Date.now() + expiresIn * 1000).toISOString()
            : null

        if (!accessToken) {
            const error: any = new Error('Token exchange failed: no access token returned by Meta')
            error.status = 502
            throw error
        }

        const wabaDetails = await requestMetaGraph(params.wabaId, {
            accessToken,
            apiVersion,
            params: {
                fields: 'id,name,currency,timezone_id,account_review_status,business_verification_status,message_template_namespace'
            }
        })

        let phoneNumberId = trimText(params.phoneNumberId) || null
        let phoneDetails: any = null
        let availablePhoneNumbers: any[] = []

        if (phoneNumberId) {
            phoneDetails = await requestMetaGraph(phoneNumberId, {
                accessToken,
                apiVersion,
                params: {
                    fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,status,name,is_on_biz_app'
                }
            })
        } else {
            availablePhoneNumbers = await fetchWabaPhoneNumbers({
                accessToken,
                apiVersion,
                wabaId: params.wabaId
            })

            if (!availablePhoneNumbers.length) {
                const error: any = new Error('Meta did not return any phone numbers for this WABA')
                error.status = 409
                throw error
            }

            if (availablePhoneNumbers.length > 1) {
                return {
                    success: false,
                    requiresSelection: true,
                    flowType: 'coexistence',
                    wabaId: params.wabaId,
                    businessId: params.businessId || null,
                    phoneNumbers: availablePhoneNumbers.map((entry: any) => ({
                        id: trimText(entry?.id) || null,
                        phone_number: trimText(entry?.display_phone_number) || null,
                        verified_name: trimText(entry?.verified_name) || null,
                        status: trimText(entry?.status) || null,
                        platform_type: trimText(entry?.platform_type) || null,
                        is_on_biz_app: entry?.is_on_biz_app === true
                    }))
                }
            }

            phoneDetails = availablePhoneNumbers[0]
            phoneNumberId = trimText(phoneDetails?.id) || null
        }

        if (!phoneNumberId) {
            const error: any = new Error('Meta did not return a phone_number_id for this coexistence onboarding flow')
            error.status = 409
            throw error
        }

        const isOnBizApp = phoneDetails?.is_on_biz_app === true
        const platformType = trimText(phoneDetails?.platform_type).toUpperCase()
        const coexistenceEnabled = isOnBizApp && platformType === 'CLOUD_API'
        const coexistenceStatus = coexistenceEnabled ? 'connected' : 'pending'

        const { connectionRow } = await syncWhatsAppConnection({
            profileId: params.profileId,
            companyId: params.companyId,
            userId: params.userId,
            appId,
            appSecret,
            verifyToken,
            apiVersion,
            accessToken,
            accessTokenType,
            accessTokenExpiresAt,
            businessId: params.businessId || null,
            wabaId: params.wabaId,
            phoneNumberId,
            flowType: 'coexistence',
            skipPhoneRegistration: true,
            onboardingType: 'coexistence',
            coexistenceEnabled,
            coexistenceStatus,
            isOnBizApp,
            syncStatus: 'pending',
            historySyncRequested: false,
            historySyncAvailable: false,
            messagingPaused: false,
            phoneDetails,
            wabaDetails,
            status: coexistenceEnabled ? (trimText(phoneDetails?.status) || 'CONNECTED') : 'PENDING',
            rawOnboardingResponse: {
                flow_type: 'coexistence',
                business_id: params.businessId || null,
                waba_id: params.wabaId,
                phone_number_id: phoneNumberId,
                token_type: accessTokenType,
                token_expires_at: accessTokenExpiresAt,
                is_on_biz_app: isOnBizApp,
                platform_type: trimText(phoneDetails?.platform_type) || null
            }
        })

        const connectionId = trimText(connectionRow?.id)
        let syncResult: {
            contactsSyncRequestId: string | null
            historySyncRequestId: string | null
            syncStartedAt: string
            syncStatus: string
        } | null = null

        if (connectionId) {
            syncResult = await startCoexistenceSync({
                connectionId,
                accessToken,
                apiVersion,
                phoneNumberId
            })
        }

        const refreshedConnection = connectionId
            ? await supabase
                .from('whatsapp_connections')
                .select('*')
                .eq('id', connectionId)
                .maybeSingle()
            : { data: connectionRow, error: null }

        if (refreshedConnection.error && !isMissingWhatsappConnectionsTableError(refreshedConnection.error)) {
            throw new Error(refreshedConnection.error.message)
        }

        return {
            success: true,
            flowType: 'coexistence',
            connection: shapeWhatsAppConnectionRow(refreshedConnection.data || connectionRow),
            sync: syncResult
        }
    }

    const persistRuntimeWabaConfig = async (params: {
        profileId: string
        companyId: string
        appId: string
        appSecret: string
        verifyToken: string
        apiVersion: string
        accessToken: string
        accessTokenType?: string | null
        accessTokenExpiresAt?: string | null
        businessId?: string | null
        clientBusinessId?: string | null
        wabaId: string
        phoneNumberId: string
        flowType: string
    }) => {
        const nowIso = new Date().toISOString()
        const payload: any = {
            profile_id: params.profileId,
            company_id: params.companyId,
            app_id: params.appId || null,
            phone_number_id: params.phoneNumberId,
            business_id: params.businessId || null,
            client_business_id: params.clientBusinessId || null,
            waba_id: params.wabaId,
            business_account_id: params.wabaId,
            access_token: encryptToken(params.accessToken),
            access_token_type: params.accessTokenType || null,
            access_token_expires_at: params.accessTokenExpiresAt || null,
            token_scopes: Array.isArray(WABA_OAUTH_SCOPES) ? WABA_OAUTH_SCOPES : null,
            token_source: params.flowType || 'embedded_signup_v4',
            system_user_token: null,
            system_user_token_expires_at: null,
            token_last_refreshed_at: nowIso,
            verify_token: params.verifyToken,
            app_secret: params.appSecret || null,
            api_version: params.apiVersion,
            enabled: true,
            connected_at: nowIso
        }

        const { error } = await supabase
            .from('waba_configs')
            .upsert(payload, { onConflict: 'profile_id' })

        if (error) {
            throw new Error(error.message)
        }
    }

    const persistWhatsAppConnection = async (params: {
        companyId: string
        profileId: string
        userId: string
        wabaId: string
        phoneNumberId: string
        businessId?: string | null
        accessToken: string
        tokenExpiresAt?: string | null
        flowType: string
        phoneDetails?: any
        wabaDetails?: any
        status?: string | null
        onboardingType?: 'normal' | 'coexistence'
        coexistenceStatus?: string | null
        historySyncRequested?: boolean
        historySyncAvailable?: boolean
        coexistenceEnabled?: boolean
        isOnBizApp?: boolean | null
        syncStatus?: string | null
        contactsSyncRequestId?: string | null
        historySyncRequestId?: string | null
        syncStartedAt?: string | null
        historySyncProgress?: number | null
        messagingPaused?: boolean
        disconnectionReason?: string | null
        disconnectionInitiatedBy?: string | null
        lastAccountUpdateEvent?: string | null
        rawOnboardingResponse?: any
    }) => {
        const nowIso = new Date().toISOString()
        const { data: existingRow, error: existingError } = await supabase
            .from('whatsapp_connections')
            .select('*')
            .eq('company_id', params.companyId)
            .eq('waba_id', params.wabaId)
            .eq('phone_number_id', params.phoneNumberId)
            .maybeSingle()

        if (existingError && !isMissingWhatsappConnectionsTableError(existingError)) {
            throw new Error(existingError.message)
        }

        const payload = {
            company_id: params.companyId,
            profile_id: params.profileId,
            user_id: params.userId,
            waba_id: params.wabaId,
            phone_number_id: params.phoneNumberId,
            business_id: params.businessId || trimText(params.wabaDetails?.business_id) || null,
            phone_number: trimText(params.phoneDetails?.display_phone_number) || null,
            display_name: normalizeConnectionDisplayName(params.phoneDetails),
            verified_name: trimText(params.phoneDetails?.verified_name) || null,
            access_token_encrypted: encryptToken(params.accessToken),
            token_expires_at: params.tokenExpiresAt || null,
            account_review_status: trimText(params.wabaDetails?.account_review_status) || null,
            business_verification_status: trimText(params.wabaDetails?.business_verification_status) || null,
            quality_rating: trimText(params.phoneDetails?.quality_rating) || null,
            platform_type: trimText(params.phoneDetails?.platform_type) || null,
            is_on_biz_app: typeof params.isOnBizApp === 'boolean'
                ? params.isOnBizApp
                : (params.phoneDetails?.is_on_biz_app === true ? true : params.phoneDetails?.is_on_biz_app === false ? false : existingRow?.is_on_biz_app ?? null),
            status: trimText(params.status || params.phoneDetails?.status) || null,
            flow_type: params.flowType || 'embedded_signup_v4',
            coexistence_enabled: typeof params.coexistenceEnabled === 'boolean'
                ? params.coexistenceEnabled
                : existingRow?.coexistence_enabled === true,
            onboarding_type: params.onboardingType || trimText(existingRow?.onboarding_type) || deriveOnboardingTypeFromFlow(params.flowType),
            coexistence_status: trimText(params.coexistenceStatus) || trimText(existingRow?.coexistence_status) || null,
            sync_status: trimText(params.syncStatus) || trimText(existingRow?.sync_status) || null,
            contacts_sync_request_id: trimText(params.contactsSyncRequestId) || trimText(existingRow?.contacts_sync_request_id) || null,
            history_sync_request_id: trimText(params.historySyncRequestId) || trimText(existingRow?.history_sync_request_id) || null,
            sync_started_at: trimText(params.syncStartedAt) || trimText(existingRow?.sync_started_at) || null,
            history_sync_progress: Number.isFinite(Number(params.historySyncProgress))
                ? Math.max(0, Math.min(100, Math.floor(Number(params.historySyncProgress))))
                : (Number.isFinite(Number(existingRow?.history_sync_progress))
                    ? Math.max(0, Math.min(100, Math.floor(Number(existingRow.history_sync_progress))))
                    : null),
            history_sync_requested: typeof params.historySyncRequested === 'boolean'
                ? params.historySyncRequested
                : existingRow?.history_sync_requested === true,
            history_sync_available: typeof params.historySyncAvailable === 'boolean'
                ? params.historySyncAvailable
                : existingRow?.history_sync_available === true,
            messaging_paused: typeof params.messagingPaused === 'boolean'
                ? params.messagingPaused
                : existingRow?.messaging_paused === true,
            disconnection_reason: trimText(params.disconnectionReason) || trimText(existingRow?.disconnection_reason) || null,
            disconnection_initiated_by: trimText(params.disconnectionInitiatedBy) || trimText(existingRow?.disconnection_initiated_by) || null,
            last_account_update_event: trimText(params.lastAccountUpdateEvent) || trimText(existingRow?.last_account_update_event) || null,
            raw_onboarding_response_json: params.rawOnboardingResponse !== undefined
                ? sanitizeOnboardingResponse(params.rawOnboardingResponse)
                : (existingRow?.raw_onboarding_response_json ?? undefined),
            last_synced_at: nowIso,
            updated_at: nowIso
        }

        const { data, error } = await supabase
            .from('whatsapp_connections')
            .upsert(payload, {
                onConflict: 'company_id,waba_id,phone_number_id'
            })
            .select('*')
            .maybeSingle()

        if (error) {
            if (isMissingWhatsappConnectionsTableError(error)) {
                return payload as any
            }
            throw new Error(error.message)
        }

        return data
    }

    const getCompanyWhatsappConnections = async (companyId: string, profileId?: string) => {
        let query = supabase
            .from('whatsapp_connections')
            .select('*')
            .eq('company_id', companyId)
            .order('updated_at', { ascending: false })

        if (profileId) {
            query = query.eq('profile_id', profileId)
        }

        const { data, error } = await query
        if (error) {
            if (isMissingWhatsappConnectionsTableError(error)) return []
            throw new Error(error.message)
        }
        return Array.isArray(data) ? data : []
    }

    const requireAdminAccess = async (access: any, res: any) => {
        const admin = await isAdminUser(access.user.id, access.companyId || undefined)
        if (!admin) {
            res.status(403).json({ success: false, error: 'Admin access required' })
            return false
        }
        return true
    }

    const isVersionedApiRequest = (req: any) => trimText(req?.versionedApiAlias).toLowerCase() === 'v1'

    const setDeprecatedRouteHeaders = (res: any, preferredPath: string) => {
        if (!preferredPath) return
        res.setHeader('X-Deprecated-Route', 'true')
        res.setHeader('X-Preferred-Route', preferredPath)
    }

    const buildVersionedApiSuccess = (req: any, data: any, meta?: any) => ({
        success: true,
        data,
        error: null,
        request_id: req?.requestId || null,
        ...(meta && typeof meta === 'object' ? { meta } : {})
    })

    const buildVersionedApiError = (
        req: any,
        code: string,
        message: string,
        details?: any
    ) => ({
        success: false,
        data: null,
        error: {
            code,
            message,
            ...(details !== undefined && details !== null
                ? (
                    (Array.isArray(details) && details.length === 0)
                        ? {}
                        : { details }
                )
                : {})
        },
        request_id: req?.requestId || null
    })

    const normalizeVersionedApiErrorCode = (value: any, fallback: string) => {
        const text = trimText(value)
        if (text && /^[A-Z0-9_]+$/.test(text)) return text
        return fallback
    }

    const sendVersionedApiError = (
        req: any,
        res: any,
        error: any,
        fallbackMessage: string,
        fallbackCode: string
    ) => {
        if (error?.versionedError && typeof error.versionedError === 'object') {
            const status = Number.isFinite(Number(error?.status)) ? Number(error.status) : 500
            return res
                .status(status)
                .json(buildVersionedApiError(
                    req,
                    normalizeVersionedApiErrorCode(error.versionedError.code, fallbackCode),
                    trimText(error.versionedError.message) || fallbackMessage,
                    error.versionedError.details
                ))
        }

        if (error?.payload && typeof error.payload === 'object') {
            const status = Number.isFinite(Number(error?.status)) ? Number(error.status) : 500
            const details = Array.isArray(error.payload.details)
                ? error.payload.details.map((entry: any) => trimText(entry)).filter(Boolean)
                : []
            const code = normalizeVersionedApiErrorCode(error.payload.error, fallbackCode)
            const message =
                trimText(error?.message)
                || trimText(error.payload.message)
                || (code !== trimText(error.payload.error) ? trimText(error.payload.error) : '')
                || details[0]
                || fallbackMessage

            return res
                .status(status)
                .json(buildVersionedApiError(req, code, message, details))
        }

        const normalized = toHttpErrorPayload(error, fallbackMessage)
        const details = Array.isArray(normalized.payload.details)
            ? normalized.payload.details.map((entry: any) => trimText(entry)).filter(Boolean)
            : []

        return res
            .status(normalized.status)
            .json(buildVersionedApiError(
                req,
                fallbackCode,
                trimText(normalized.payload.error) || fallbackMessage,
                details
            ))
    }

    const shapeVersionedWhatsappConnection = (row: any) => {
        const shaped = shapeWhatsAppConnectionRow(row)
        return {
            connection_id: shaped.id,
            company_id: shaped.company_id,
            profile_id: shaped.profile_id,
            provider: 'meta_whatsapp_cloud_api',
            business_account_id: shaped.waba_id,
            phone_number_id: shaped.phone_number_id,
            display_phone_number: shaped.phone_number,
            display_name: shaped.display_name,
            verified_name: shaped.verified_name,
            status: shaped.status,
            platform_type: shaped.platform_type,
            quality_rating: shaped.quality_rating,
            account_review_status: shaped.account_review_status,
            business_verification_status: shaped.business_verification_status,
            flow_type: shaped.flow_type,
            coexistence_enabled: shaped.coexistence_enabled,
            onboarding_type: shaped.onboarding_type,
            coexistence_status: shaped.coexistence_status,
            is_on_biz_app: shaped.is_on_biz_app,
            sync_status: shaped.sync_status,
            contacts_sync_request_id: shaped.contacts_sync_request_id,
            history_sync_request_id: shaped.history_sync_request_id,
            sync_started_at: shaped.sync_started_at,
            history_sync_progress: shaped.history_sync_progress,
            history_sync_requested: shaped.history_sync_requested,
            history_sync_available: shaped.history_sync_available,
            messaging_paused: shaped.messaging_paused,
            disconnection_reason: shaped.disconnection_reason,
            disconnection_initiated_by: shaped.disconnection_initiated_by,
            last_account_update_event: shaped.last_account_update_event,
            token_expires_at: shaped.token_expires_at,
            last_webhook_at: shaped.last_webhook_at,
            last_synced_at: shaped.last_synced_at,
            created_at: shaped.created_at,
            updated_at: shaped.updated_at,
            provider_ids: {
                business_id: shaped.business_id,
                waba_id: shaped.waba_id,
                phone_number_id: shaped.phone_number_id
            }
        }
    }

    const resolveCompanyWhatsappAccess = async (req: any, res: any, location: 'query' | 'body' = 'query') => {
        const user = await getSupabaseUserFromRequest(req, res)
        if (!user) return null

        const userCompanyId = getUserCompanyId(user)
        if (!userCompanyId) {
            res.status(400).json({ success: false, error: 'Company ID missing in user metadata' })
            return null
        }

        const source = location === 'body' ? req.body : req.query
        const requestedCompanyId = trimText(source?.company_id || source?.companyId) || userCompanyId
        const profileId = trimText(source?.profile_id || source?.profileId) || null

        if (requestedCompanyId !== userCompanyId && !isSuperAdminUser(user)) {
            res.status(403).json({ success: false, error: 'company_id does not belong to your account' })
            return null
        }

        if (profileId) {
            const ownsProfile = await assertProfileCompany(profileId, requestedCompanyId)
            if (!ownsProfile) {
                res.status(403).json({ success: false, error: 'Profile does not belong to the requested company' })
                return null
            }
        }

        return {
            user,
            companyId: requestedCompanyId,
            profileId
        }
    }

    const refreshWhatsappConnectionsForCompany = async (params: {
        companyId: string
        profileId?: string | null
        userId: string
    }) => {
        const rows = await getCompanyWhatsappConnections(params.companyId, params.profileId || undefined)
        const refreshed: any[] = []
        const failures: Array<{ phone_number_id: string | null; error: string }> = []

        for (const row of rows) {
            const accessTokenEncrypted = trimText(row?.access_token_encrypted)
            if (!accessTokenEncrypted) {
                failures.push({
                    phone_number_id: trimText(row?.phone_number_id) || null,
                    error: 'Missing encrypted access token'
                })
                continue
            }

            try {
                const accessToken = decryptToken(accessTokenEncrypted)
                const { data: configRow } = await supabase
                    .from('waba_configs')
                    .select('api_version')
                    .eq('profile_id', trimText(row?.profile_id))
                    .maybeSingle()

                const apiVersion = trimText(configRow?.api_version) || resolveMetaGraphVersionFromEnv('v24.0')
                const { wabaDetails, phoneDetails } = await fetchWabaAndPhoneDetails({
                    accessToken,
                    apiVersion,
                    wabaId: trimText(row?.waba_id),
                    phoneNumberId: trimText(row?.phone_number_id)
                })

                const updated = await persistWhatsAppConnection({
                    companyId: trimText(row?.company_id),
                    profileId: trimText(row?.profile_id),
                    userId: trimText(row?.user_id) || params.userId,
                    wabaId: trimText(row?.waba_id),
                    phoneNumberId: trimText(row?.phone_number_id),
                    businessId: trimText(row?.business_id) || null,
                    accessToken,
                    tokenExpiresAt: trimText(row?.token_expires_at) || null,
                    flowType: trimText(row?.flow_type) || 'refresh_status',
                    phoneDetails,
                    wabaDetails,
                    status: trimText(phoneDetails?.status) || trimText(row?.status) || 'CONNECTED'
                })
                refreshed.push(updated)
            } catch (error: any) {
                failures.push({
                    phone_number_id: trimText(row?.phone_number_id) || null,
                    error: error?.message || 'Failed to refresh connection'
                })
            }
        }

        return { refreshed, failures }
    }

    const disconnectWhatsappConnection = async (params: {
        companyId: string
        profileId: string
        revoke: boolean
    }) => {
        const { data: config, error: fetchError } = await supabase
            .from('waba_configs')
            .select('profile_id, company_id, app_id, phone_number_id, business_id, waba_id, business_account_id, access_token, system_user_token, api_version')
            .eq('profile_id', params.profileId)
            .maybeSingle()

        if (fetchError || !config) {
            const error: any = new Error(fetchError?.message || 'WABA config not found')
            error.status = 404
            throw error
        }

        const wabaId = trimText(config.waba_id || config.business_account_id)
        let unsubscribed = false
        let unsubscribeError: string | null = null

        if (params.revoke && wabaId) {
            try {
                const token = decryptToken(config.system_user_token || config.access_token)
                await unsubscribeWabaApp(wabaId, token, config.api_version || resolveMetaGraphVersionFromEnv('v24.0'))
                unsubscribed = true
            } catch (error: any) {
                unsubscribeError = error?.message || 'Failed to unsubscribe app'
            }
        }

        const nowIso = new Date().toISOString()
        const { error: configUpdateError } = await supabase
            .from('waba_configs')
            .update({ enabled: false })
            .eq('profile_id', params.profileId)

        if (configUpdateError) {
            const error: any = new Error(configUpdateError.message)
            error.status = 500
            throw error
        }

        const { error: connectionUpdateError } = await supabase
            .from('whatsapp_connections')
            .update({
                status: 'DISCONNECTED',
                last_synced_at: nowIso,
                updated_at: nowIso
            })
            .eq('company_id', params.companyId)
            .eq('profile_id', params.profileId)

        if (connectionUpdateError && !isMissingWhatsappConnectionsTableError(connectionUpdateError)) {
            const error: any = new Error(connectionUpdateError.message)
            error.status = 500
            throw error
        }

        await wabaRegistry.refresh(true)

        return {
            disabled: true,
            unsubscribed,
            unsubscribe_error: unsubscribeError
        }
    }

    const buildOnboardingStatusData = async (access: any) => {
        const connections = await getCompanyWhatsappConnections(access.companyId)
        const appId = resolveMetaAppIdFromEnv()
        const appSecret = resolveMetaAppSecretFromEnv()
        const verifyToken = resolveMetaVerifyTokenFromEnv()
        const embeddedConfigId = resolveMetaEmbeddedSignupV4ConfigIdFromEnv()
        const tokenEncryptionReady = Boolean(getTokenEncryptionKey())
        const permissionsReady =
            Array.isArray(WABA_OAUTH_SCOPES)
            && WABA_OAUTH_SCOPES.includes('whatsapp_business_management')
            && WABA_OAUTH_SCOPES.includes('whatsapp_business_messaging')
            && WABA_OAUTH_SCOPES.includes('business_management')

        const issues: string[] = []
        if (!appId) issues.push('META_APP_ID is missing.')
        if (!appSecret) issues.push('META_APP_SECRET is missing.')
        if (!verifyToken) issues.push('META_WEBHOOK_VERIFY_TOKEN is missing.')
        if (!embeddedConfigId) issues.push('META_WA_EMBEDDED_SIGNUP_V4_CONFIGURATION_ID is missing.')
        if (!tokenEncryptionReady) issues.push('ENCRYPTION_KEY is missing.')

        return {
            company_id: access.companyId,
            provider: 'meta_whatsapp_cloud_api',
            tech_provider_ready: Boolean(appId && appSecret && verifyToken && tokenEncryptionReady),
            embedded_signup_config_found: Boolean(embeddedConfigId),
            permissions_ready: permissionsReady,
            webhook_configured: Boolean(verifyToken),
            customers_connected: connections.length,
            calling_media_ready: true,
            issues
        }
    }

    const buildCoexistenceStartData = async (access: any, req: any) => {
        const appId = resolveMetaAppIdFromEnv()
        const appSecret = resolveMetaAppSecretFromEnv()
        const verifyToken = resolveMetaVerifyTokenFromEnv()
        if (!appId || !appSecret || !verifyToken) {
            const error: any = new Error('Missing META_APP_ID/META_APP_SECRET/META_WEBHOOK_VERIFY_TOKEN or WABA equivalents')
            error.status = 500
            throw error
        }

        const configId = resolveMetaCoexistenceConfigIdFromEnv()
        if (!configId) {
            const error: any = new Error('Missing META_WA_COEXISTENCE_CONFIGURATION_ID or META_WA_EXISTING_APP_CONFIGURATION_ID')
            error.status = 500
            throw error
        }

        const requestedBusinessId = readTrimmed(req.body?.businessId || req.body?.business_id || req.query?.businessId || req.query?.business_id) || null
        const requestedWabaId = readTrimmed(req.body?.wabaId || req.body?.waba_id || req.query?.wabaId || req.query?.waba_id) || null
        const requestedPhoneNumberId = readTrimmed(req.body?.phoneNumberId || req.body?.phone_number_id || req.query?.phoneNumberId || req.query?.phone_number_id) || null
        const redirectUri = resolveOauthRedirectUri(req)
        const apiVersion = resolveMetaGraphVersionFromEnv('v25.0')
        const state = randomBytes(16).toString('hex')
        const stateHash = hashOAuthState(state)
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
        const redirectUrl = sanitizeReturnUrl(req.body?.returnUrl || req.body?.return_url || req.query?.returnUrl || req.query?.return_url) || resolveOauthReturnUrl(req)

        const { error } = await supabase
            .from('waba_oauth_states')
            .insert({
                state_hash: stateHash,
                profile_id: access.profileId,
                company_id: access.companyId,
                user_id: access.user.id,
                requested_business_id: requestedBusinessId,
                requested_waba_id: requestedWabaId,
                requested_phone_number_id: requestedPhoneNumberId,
                redirect_url: redirectUrl,
                expires_at: expiresAt
            })

        if (error) {
            const nextError: any = new Error(error.message)
            nextError.status = 500
            throw nextError
        }

        const url = buildEmbeddedSignupUrl({
            appId,
            redirectUri,
            state,
            scopes: WABA_OAUTH_SCOPES,
            apiVersion,
            configId,
            includeScopes: resolveOauthMode(configId) === 'user',
            extras: {
                featureType: 'whatsapp_business_app_onboarding',
                sessionInfoVersion: '3'
            }
        })

        return {
            provider: 'meta_embedded_signup',
            onboarding_type: 'coexistence',
            start_url: url,
            configuration_id: configId,
            feature_type: 'whatsapp_business_app_onboarding',
            session_info_version: '3'
        }
    }

    const buildVersionedActorFromUser = (user: any) => {
        const displayName =
            trimText(user?.user_metadata?.name)
            || trimText(user?.user_metadata?.full_name)
            || trimText(user?.email)
            || trimText(user?.id)
            || 'Team Member'

        return {
            user_id: trimText(user?.id) || 'team-member',
            name: displayName,
            color: '#2563eb'
        }
    }

    const normalizeCallStatusLabel = (value: any) => trimText(value).toLowerCase()

    const buildCallOwnershipDetails = (row: any) => ({
        answered_by: trimText(row?.accepted_by_name) || trimText(row?.accepted_by_user_id) || 'Another team member',
        status: normalizeCallStatusLabel(row?.status) || 'accepted'
    })

    const createVersionedCallError = (
        code: string,
        message: string,
        status: number,
        details?: any
    ) => {
        const error: any = new Error(message)
        error.status = status
        error.versionedError = {
            code,
            message,
            details
        }
        return error
    }

    const createCallAlreadyAnsweredError = (row: any) => createVersionedCallError(
        'CALL_ALREADY_ANSWERED',
        'Someone already answered this call.',
        409,
        buildCallOwnershipDetails(row)
    )

    const createCallStateConflictError = (row: any) => createVersionedCallError(
        'CALL_NOT_RINGING',
        `This call is already ${normalizeCallStatusLabel(row?.status) || 'unavailable'}.`,
        409,
        {
            status: normalizeCallStatusLabel(row?.status) || 'unknown'
        }
    )

    const createCallOwnershipForbiddenError = (message: string, row: any) => createVersionedCallError(
        'CALL_CLAIMED_BY_ANOTHER_USER',
        message,
        409,
        buildCallOwnershipDetails(row)
    )

    const createCallLockRequiredError = () => createVersionedCallError(
        'CALL_ACCEPT_LOCK_REQUIRED',
        'This call must be pre-accepted before it can be accepted.',
        409
    )

    const createCallNotFoundError = () => createVersionedCallError(
        'WHATSAPP_CALL_NOT_FOUND',
        'Call not found for this profile.',
        404
    )

    const buildRealtimeCallPayloadFromStoredCall = (params: {
        access: any
        row: any
        event: string
        normalizedStatus?: string | null
    }) => {
        const row = params.row || {}
        const lastEventAt = trimText(row?.last_event_at)
        const parsedLastEventMs = lastEventAt ? new Date(lastEventAt).getTime() : Number.NaN
        const timestamp = Number.isFinite(parsedLastEventMs)
            ? Math.max(0, Math.floor(parsedLastEventMs / 1000))
            : Math.floor(Date.now() / 1000)
        return {
            profileId: params.access.profileId,
            callId: trimText(row?.call_id) || '',
            event: trimText(params.event) || trimText(row?.event) || 'unknown',
            normalizedStatus: normalizeCallStatusLabel(params.normalizedStatus || row?.status) || 'unknown',
            phoneNumberId: trimText(row?.phone_number_id) || '',
            from: trimText(row?.customer_wa_id) || null,
            to: trimText(row?.business_wa_id) || null,
            direction: trimText(row?.direction) || null,
            timestamp,
            status: [],
            startTime: trimText(row?.start_time) ? Math.floor(new Date(row.start_time).getTime() / 1000) : null,
            endTime: trimText(row?.end_time) ? Math.floor(new Date(row.end_time).getTime() / 1000) : null,
            duration: Number.isFinite(Number(row?.duration_seconds)) ? Number(row.duration_seconds) : null,
            deeplinkPayload: trimText(row?.deeplink_payload) || null,
            ctaPayload: trimText(row?.cta_payload) || null,
            bizOpaqueCallbackData: trimText(row?.biz_opaque_callback_data) || null,
            session: row?.session_sdp_type && row?.session_sdp
                ? {
                    sdp_type: row.session_sdp_type,
                    sdp: row.session_sdp
                }
                : null,
            contactName: trimText(row?.customer_name) || null,
            errors: Array.isArray(row?.meta_error) ? row.meta_error : [],
            acceptedByUserId: trimText(row?.accepted_by_user_id) || null,
            acceptedByName: trimText(row?.accepted_by_name) || null,
            acceptedAt: trimText(row?.accepted_at) || null,
            claimExpiresAt: trimText(row?.claim_expires_at) || null,
            persistedCall: shapeVersionedWhatsappCall(row)
        }
    }

    const broadcastStoredCallRealtimeUpdate = (params: {
        access: any
        row: any
        event: string
        normalizedStatus?: string | null
    }) => {
        if (!io || typeof getCompanyRoom !== 'function' || !params.row) return
        const companyId = trimText(params.access?.companyId)
        if (!companyId) return
        io.to(getCompanyRoom(companyId)).emit('calls.update', buildRealtimeCallPayloadFromStoredCall(params))
    }

    const buildVersionedConversationJid = (phoneNumber: string) => {
        const normalized = normalizePhoneNumber(phoneNumber)
        if (!normalized) return ''
        return `${normalized}@s.whatsapp.net`
    }

    const buildVersionedConversationName = (user: any) => {
        return (
            trimText(user?.alias)
            || trimText(user?.name)
            || normalizePhoneNumber(user?.phone_number)
            || trimText(user?.phone_number)
            || 'Unknown contact'
        )
    }

    const extractVersionedMessageType = (record: any) => {
        const content = record?.content || {}
        return trimText(content.type || content.payload?.type) || 'text'
    }

    const extractVersionedMessageText = (record: any) => {
        const content = record?.content || {}
        const payload = content.payload || {}
        return (
            trimText(content.text)
            || trimText(payload.text)
            || trimText(content.caption)
            || trimText(payload.caption)
            || trimText(payload.body)
            || trimText(payload.template?.name)
            || ''
        )
    }

    const shapeVersionedWhatsappMessage = (record: any, user?: any) => {
        const content = record?.content || {}
        const payload = content.payload || {}
        const type = extractVersionedMessageType(record)
        const text = extractVersionedMessageText(record)
        const phoneNumber = normalizePhoneNumber(user?.phone_number || content.to || '')

        return {
            id: trimText(content.message_id) || trimText(record?.id) || null,
            record_id: trimText(record?.id) || null,
            conversation_id: trimText(record?.user_id) || null,
            profile_id: trimText(record?.profile_id) || null,
            direction: trimText(record?.direction) || null,
            type,
            status: trimText(content.status) || null,
            text: text || null,
            to: trimText(content.to) || phoneNumber || null,
            contact_phone_number: phoneNumber || null,
            media: {
                type: type === 'image' || type === 'video' || type === 'audio' || type === 'document' ? type : null,
                media_id: trimText(content.media_id) || null,
                asset_key: trimText(content.media_asset_key) || null,
                url:
                    trimText(content.image_url)
                    || trimText(content.video_url)
                    || trimText(content.document_url)
                    || trimText(payload?.media?.link)
                    || null,
                filename: trimText(content.filename) || trimText(payload?.media?.filename) || null,
                mimetype: trimText(content.mimetype) || trimText(payload?.mimetype) || null
            },
            agent: content.agent || payload.agent || null,
            workflow_state: record?.workflow_state || null,
            created_at: trimText(record?.created_at) || null
        }
    }

    const loadConversationRecord = async (companyId: string, profileId: string, conversationId: string) => {
        const { data, error } = await supabase
            .from('users')
            .select('*')
            .eq('company_id', companyId)
            .eq('profile_id', profileId)
            .eq('id', conversationId)
            .maybeSingle()

        if (error) {
            throw new Error(error.message)
        }

        return data || null
    }

    const loadLatestMessagesForConversationUsers = async (userIds: string[]) => {
        const out = new Map<string, any>()
        if (!Array.isArray(userIds) || userIds.length === 0) return out

        const sampleLimit = Math.max(50, Math.min(2000, userIds.length * 20))
        const recentMessages = await getMessagesForUsers(userIds, sampleLimit)
        for (const record of recentMessages) {
            const userId = trimText(record?.user_id)
            if (!userId || out.has(userId)) continue
            out.set(userId, record)
        }
        return out
    }

    const shapeVersionedConversation = (user: any, latestMessage?: any | null) => {
        const phoneNumber = normalizePhoneNumber(user?.phone_number)
        const latest = latestMessage ? shapeVersionedWhatsappMessage(latestMessage, user) : null
        return {
            id: trimText(user?.id) || null,
            profile_id: trimText(user?.profile_id) || null,
            company_id: trimText(user?.company_id) || null,
            jid: buildVersionedConversationJid(phoneNumber),
            phone_number: phoneNumber || null,
            display_name: buildVersionedConversationName(user),
            alias: trimText(user?.alias) || null,
            whatsapp_name: trimText(user?.name) || null,
            tags: Array.isArray(user?.tags) ? user.tags : [],
            assignee: {
                user_id: trimText(user?.assigned_to_user_id) || null,
                name: trimText(user?.assigned_to_name) || null,
                color: trimText(user?.assigned_to_color) || null,
                assigned_at: trimText(user?.assigned_at) || null
            },
            human_takeover: Array.isArray(user?.tags) ? user.tags.includes('human_takeover') : false,
            last_inbound_at: trimText(user?.last_inbound_at) || null,
            last_window_reminder_at: trimText(user?.last_window_reminder_at) || null,
            latest_message: latest
        }
    }

    const syncWhatsAppConnection = async (params: {
        profileId: string
        companyId: string
        userId: string
        appId: string
        appSecret: string
        verifyToken: string
        apiVersion: string
        accessToken: string
        accessTokenType?: string | null
        accessTokenExpiresAt?: string | null
        businessId?: string | null
        clientBusinessId?: string | null
        wabaId: string
        phoneNumberId: string
        flowType: string
        pin?: string | null
        skipPhoneRegistration?: boolean
        onboardingType?: 'normal' | 'coexistence'
        coexistenceStatus?: string | null
        historySyncRequested?: boolean
        historySyncAvailable?: boolean
        rawOnboardingResponse?: any
    }) => {
        const phoneConfigConflict = await findConflictingActivePhoneNumberConfig(params.phoneNumberId, params.profileId)
        if (phoneConfigConflict) {
            const conflictProfileId = trimText(phoneConfigConflict.profileId || phoneConfigConflict.profile_id)
            const error: any = new Error(`phoneNumberId "${params.phoneNumberId}" is already connected to profile "${conflictProfileId}". Disconnect it first.`)
            error.status = 409
            throw error
        }

        if (!params.skipPhoneRegistration) {
            try {
                const payload: Record<string, any> = {
                    messaging_product: 'whatsapp'
                }
                const pin = trimText(params.pin)
                if (pin) payload.pin = pin
                await requestMetaGraph(`${params.phoneNumberId}/register`, {
                    accessToken: params.accessToken,
                    apiVersion: params.apiVersion,
                    method: 'POST',
                    body: payload
                })
            } catch (error: any) {
                if (!trimText(params.pin) && isMetaPinRequiredError(error)) {
                    error.status = 409
                    error.needsPin = true
                    error.message = 'Meta requires a 6-digit phone registration PIN for this number. Enter the PIN and try again.'
                    throw error
                }
                if (!isMetaAlreadyRegisteredError(error)) {
                    throw error
                }
            }
        }

        try {
            await subscribeWabaApp(params.wabaId, params.accessToken, params.apiVersion)
        } catch (error: any) {
            if (!isMetaAlreadySubscribedError(error)) {
                throw error
            }
        }

        const { wabaDetails, phoneDetails } = await fetchWabaAndPhoneDetails({
            accessToken: params.accessToken,
            apiVersion: params.apiVersion,
            wabaId: params.wabaId,
            phoneNumberId: params.phoneNumberId
        })

        await persistRuntimeWabaConfig({
            profileId: params.profileId,
            companyId: params.companyId,
            appId: params.appId,
            appSecret: params.appSecret,
            verifyToken: params.verifyToken,
            apiVersion: params.apiVersion,
            accessToken: params.accessToken,
            accessTokenType: params.accessTokenType,
            accessTokenExpiresAt: params.accessTokenExpiresAt,
            businessId: params.businessId,
            clientBusinessId: params.clientBusinessId,
            wabaId: params.wabaId,
            phoneNumberId: params.phoneNumberId,
            flowType: params.flowType
        })

        const connectionRow = await persistWhatsAppConnection({
            companyId: params.companyId,
            profileId: params.profileId,
            userId: params.userId,
            wabaId: params.wabaId,
            phoneNumberId: params.phoneNumberId,
            businessId: params.businessId,
            accessToken: params.accessToken,
            tokenExpiresAt: params.accessTokenExpiresAt,
            flowType: params.flowType,
            phoneDetails,
            wabaDetails,
            status: trimText(phoneDetails?.status) || 'CONNECTED',
            onboardingType: params.onboardingType,
            coexistenceStatus: params.coexistenceStatus,
            historySyncRequested: params.historySyncRequested,
            historySyncAvailable: params.historySyncAvailable,
            rawOnboardingResponse: params.rawOnboardingResponse
        })

        await wabaRegistry.refresh(true)

        return {
            connectionRow,
            wabaDetails,
            phoneDetails
        }
    }

app.get('/api/waba/conversational-automation', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return
        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const response = await client.getConversationalAutomation()
        res.json({ success: true, data: response })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/waba/conversational-automation', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return
        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        let commands: ConversationalCommand[] = []
        let prompts: string[] = []
        try {
            commands = sanitizeConversationalCommands(req.body?.commands)
            prompts = sanitizeConversationalPrompts(req.body?.prompts)
        } catch (validationError: any) {
            return res.status(400).json({ success: false, error: validationError?.message || 'Invalid conversational components payload' })
        }

        const enableWelcomeRaw = req.body?.enable_welcome_message
        const enable_welcome_message = enableWelcomeRaw === undefined ? undefined : Boolean(enableWelcomeRaw)
        const response = await client.setConversationalAutomation({
            enable_welcome_message,
            commands,
            prompts
        })

        res.json({ success: true, data: response })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

// Configure window reminder settings (24h window warning)
app.get('/api/waba/window-reminder', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const { data, error } = await supabase
            .from('waba_configs')
            .select('window_reminder_enabled, window_reminder_minutes, window_reminder_text')
            .eq('profile_id', access.profileId)
            .maybeSingle()

        if (error) {
            return res.status(500).json({ success: false, error: error.message })
        }

        res.json({
            success: true,
            data: data || {
                window_reminder_enabled: false,
                window_reminder_minutes: null,
                window_reminder_text: null
            }
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/waba/window-reminder', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const { data: existing, error: fetchError } = await supabase
            .from('waba_configs')
            .select('profile_id')
            .eq('profile_id', access.profileId)
            .maybeSingle()

        if (fetchError) {
            return res.status(500).json({ success: false, error: fetchError.message })
        }

        if (!existing) {
            return res.status(404).json({ success: false, error: 'WABA config not found for this profile.' })
        }

        const enabled = Boolean(req.body?.enabled)
        const minutesRaw = req.body?.minutes
        const minutesNumber = Number(minutesRaw)
        const minutes = Number.isFinite(minutesNumber) && minutesNumber > 0 ? Math.round(minutesNumber) : null
        const text = typeof req.body?.text === 'string' ? req.body.text.trim() : null

        const updatePayload = {
            window_reminder_enabled: enabled,
            window_reminder_minutes: minutes,
            window_reminder_text: text || null
        }

        const { error } = await supabase
            .from('waba_configs')
            .update(updatePayload)
            .eq('profile_id', access.profileId)

        if (error) {
            return res.status(500).json({ success: false, error: error.message })
        }

        await wabaRegistry.refresh(true)

        res.json({ success: true, data: updatePayload })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

// ============================================
// WABA EMBEDDED SIGNUP (OAUTH)
// ============================================
app.get('/api/waba/embedded-signup/url', async (req: any, res: any) => {
    try {
        setDeprecatedRouteHeaders(res, '/api/v1/whatsapp/connect/start')
        const user = await getSupabaseUserFromRequest(req, res)
        if (!user) return

        const profileId = typeof req.query?.profileId === 'string' ? req.query.profileId : undefined
        if (!profileId) {
            return res.status(400).json({ success: false, error: 'profileId is required' })
        }

        const companyId = getUserCompanyId(user)
        if (!companyId) {
            return res.status(400).json({ success: false, error: 'Company ID missing in user metadata' })
        }

        const ownsProfile = await assertProfileCompany(profileId, companyId)
        if (!ownsProfile) {
            return res.status(403).json({ success: false, error: 'Profile does not belong to your company' })
        }

        const appId = resolveMetaAppIdFromEnv()
        const appSecret = resolveMetaAppSecretFromEnv()
        const verifyToken = resolveMetaVerifyTokenFromEnv()
        if (!appId || !appSecret || !verifyToken) {
            return res.status(500).json({ success: false, error: 'Missing META_APP_ID/META_APP_SECRET/META_WEBHOOK_VERIFY_TOKEN or WABA equivalents' })
        }

        if (!getTokenEncryptionKey()) {
            return res.status(500).json({ success: false, error: 'Missing WABA_TOKEN_ENCRYPTION_KEY' })
        }

        const requestedBusinessId = typeof req.query?.businessId === 'string' ? req.query.businessId : null
        const requestedWabaId = typeof req.query?.wabaId === 'string' ? req.query.wabaId : null
        const requestedPhoneNumberId = typeof req.query?.phoneNumberId === 'string' ? req.query.phoneNumberId : null
        const preverifiedIdsFromQuery =
            req.query?.preVerifiedIds ||
            req.query?.preverifiedIds ||
            req.query?.preVerifiedPhoneIds ||
            null
        const preverifiedIdsFromEnv =
            process.env.WABA_EMBEDDED_SIGNUP_PREVERIFIED_IDS ||
            process.env.WABA_PREVERIFIED_PHONE_IDS ||
            ''
        const preverifiedIds = [
            ...parsePreverifiedIdsInput(preverifiedIdsFromEnv),
            ...parsePreverifiedIdsInput(preverifiedIdsFromQuery)
        ]
        const uniquePreverifiedIds = Array.from(new Set(preverifiedIds))
        const queryFeatureType = parseEmbeddedSignupFeatureType(
            req.query?.featureType ||
            req.query?.signupFeatureType ||
            req.query?.embeddedSignupFeatureType ||
            null
        )
        const envFeatureType = parseEmbeddedSignupFeatureType(process.env.WABA_EMBEDDED_SIGNUP_FEATURE_TYPE || '')
        const featureType = queryFeatureType ||
            (isTruthyFlag(req.query?.coexistence) ? 'whatsapp_business_app_onboarding' : null) ||
            envFeatureType
        const querySessionInfoVersion = parseEmbeddedSignupSessionInfoVersion(req.query?.sessionInfoVersion)
        const envSessionInfoVersion = parseEmbeddedSignupSessionInfoVersion(process.env.WABA_EMBEDDED_SIGNUP_SESSION_INFO_VERSION || '')
        const sessionInfoVersion = querySessionInfoVersion ||
            (featureType === 'whatsapp_business_app_onboarding' ? '3' : null) ||
            envSessionInfoVersion
        const embeddedSignupExtras = buildEmbeddedSignupExtras({
            preverifiedIds: uniquePreverifiedIds,
            featureType,
            sessionInfoVersion
        })

        const redirectUri = resolveOauthRedirectUri(req)
        const apiVersion = resolveMetaGraphVersionFromEnv('v25.0')
        const defaultConfigId = resolveMetaEmbeddedSignupV4ConfigIdFromEnv()
        const coexistenceConfigId = resolveMetaCoexistenceConfigIdFromEnv()
        const configId = featureType === 'whatsapp_business_app_onboarding'
            ? coexistenceConfigId
            : defaultConfigId
        if (featureType === 'whatsapp_business_app_onboarding' && !configId) {
            return res.status(500).json({
                success: false,
                error: 'Missing META_WA_COEXISTENCE_CONFIGURATION_ID or META_WA_EXISTING_APP_CONFIGURATION_ID'
            })
        }
        const oauthMode = resolveOauthMode(configId)
        const includeScopes = oauthMode === 'user'

        const state = randomBytes(16).toString('hex')
        const stateHash = hashOAuthState(state)
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

        const requestedReturnUrl = sanitizeReturnUrl(req.query?.returnUrl)
        const redirectUrl = requestedReturnUrl || resolveOauthReturnUrl(req)

        const { error } = await supabase
            .from('waba_oauth_states')
            .insert({
                state_hash: stateHash,
                profile_id: profileId,
                company_id: companyId,
                user_id: user.id,
                requested_business_id: requestedBusinessId,
                requested_waba_id: requestedWabaId,
                requested_phone_number_id: requestedPhoneNumberId,
                redirect_url: redirectUrl,
                expires_at: expiresAt
            })

        if (error) {
            return res.status(500).json({ success: false, error: error.message })
        }

        const url = buildEmbeddedSignupUrl({
            appId,
            redirectUri,
            state,
            scopes: WABA_OAUTH_SCOPES,
            apiVersion,
            configId: configId || undefined,
            includeScopes,
            extras: embeddedSignupExtras
        })

        res.json({ success: true, url })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/whatsapp/embedded-signup/v4/complete', async (req: any, res: any) => {
    try {
        setDeprecatedRouteHeaders(res, '/api/v1/whatsapp/connect/complete')
        const user = await getSupabaseUserFromRequest(req, res)
        if (!user) return

        const requestedCompanyId = trimText(req.body?.company_id || req.body?.companyId)
        const profileId = trimText(req.body?.profile_id || req.body?.profileId)
        const code = trimText(req.body?.code)
        const wabaId = trimText(req.body?.waba_id || req.body?.wabaId)
        const phoneNumberId = trimText(req.body?.phone_number_id || req.body?.phoneNumberId)
        const businessId = trimText(req.body?.business_id || req.body?.businessId) || null
        const flowType = trimText(req.body?.flow_type || req.body?.flowType) || 'new_phone_onboarding'
        const pin = trimText(req.body?.pin)

        if (!requestedCompanyId) {
            return res.status(400).json({ success: false, error: 'company_id is required' })
        }
        if (!profileId) {
            return res.status(400).json({ success: false, error: 'profile_id is required' })
        }
        if (!code || !wabaId || !phoneNumberId) {
            return res.status(400).json({ success: false, error: 'code, waba_id, and phone_number_id are required' })
        }
        if (pin && !/^\d{6}$/.test(pin)) {
            return res.status(400).json({ success: false, error: 'pin must be 6 digits' })
        }

        const companyId = getUserCompanyId(user)
        if (!companyId) {
            return res.status(400).json({ success: false, error: 'Company ID missing in user metadata' })
        }
        if (requestedCompanyId !== companyId && !isSuperAdminUser(user)) {
            return res.status(403).json({ success: false, error: 'company_id does not belong to your account' })
        }

        const ownsProfile = await assertProfileCompany(profileId, requestedCompanyId)
        if (!ownsProfile) {
            return res.status(403).json({ success: false, error: 'Profile does not belong to the requested company' })
        }

        const appId = resolveMetaAppIdFromEnv()
        const appSecret = resolveMetaAppSecretFromEnv()
        const verifyToken = resolveMetaVerifyTokenFromEnv()
        const apiVersion = resolveMetaGraphVersionFromEnv('v24.0')
        if (!appId || !appSecret) {
            return res.status(500).json({ success: false, error: 'Missing META_APP_ID or META_APP_SECRET' })
        }
        if (!verifyToken) {
            return res.status(500).json({ success: false, error: 'Missing META_WEBHOOK_VERIFY_TOKEN or WABA_VERIFY_TOKEN' })
        }
        if (!getTokenEncryptionKey()) {
            return res.status(500).json({ success: false, error: 'Missing WABA_TOKEN_ENCRYPTION_KEY or ENCRYPTION_KEY' })
        }

        const tokenData = await exchangeEmbeddedSignupCodeForToken({
            code,
            appId,
            appSecret,
            apiVersion,
            req
        })

        const accessToken = trimText(tokenData?.access_token)
        const accessTokenType = trimText(tokenData?.token_type) || null
        const expiresIn = Number(tokenData?.expires_in)
        const accessTokenExpiresAt = Number.isFinite(expiresIn) && expiresIn > 0
            ? new Date(Date.now() + expiresIn * 1000).toISOString()
            : null

        if (!accessToken) {
            return res.status(502).json({ success: false, error: 'Token exchange failed: no access token returned by Meta' })
        }

        try {
            const onboardingType = deriveOnboardingTypeFromFlow(flowType)
            const { connectionRow, phoneDetails } = await syncWhatsAppConnection({
                profileId,
                companyId: requestedCompanyId,
                userId: user.id,
                appId,
                appSecret,
                verifyToken,
                apiVersion,
                accessToken,
                accessTokenType,
                accessTokenExpiresAt,
                businessId,
                wabaId,
                phoneNumberId,
                flowType,
                skipPhoneRegistration: onboardingType === 'coexistence',
                pin: pin || null,
                onboardingType,
                coexistenceEnabled: onboardingType === 'coexistence',
                coexistenceStatus: onboardingType === 'coexistence' ? 'connected' : null,
                historySyncRequested: onboardingType === 'coexistence' ? false : undefined,
                historySyncAvailable: onboardingType === 'coexistence' ? false : undefined,
                rawOnboardingResponse: {
                    flow_type: flowType,
                    business_id: businessId,
                    waba_id: wabaId,
                    phone_number_id: phoneNumberId,
                    token_type: accessTokenType,
                    token_expires_at: accessTokenExpiresAt
                }
            })

            return res.json({
                success: true,
                connection: {
                    id: trimText(connectionRow?.id) || null,
                    waba_id: trimText(connectionRow?.waba_id) || wabaId,
                    phone_number_id: trimText(connectionRow?.phone_number_id) || phoneNumberId,
                    phone_number: trimText(connectionRow?.phone_number || phoneDetails?.display_phone_number) || null,
                    display_name: trimText(connectionRow?.display_name || phoneDetails?.name || phoneDetails?.display_name) || null,
                    verified_name: trimText(connectionRow?.verified_name || phoneDetails?.verified_name) || null,
                    status: trimText(connectionRow?.status || phoneDetails?.status) || 'CONNECTED'
                }
            })
        } catch (error: any) {
            if (error?.needsPin) {
                return res.status(409).json({
                    success: false,
                    error: error.message,
                    needs_pin: true
                })
            }
            const normalized = toHttpErrorPayload(error, 'Failed to complete Embedded Signup v4 onboarding')
            return res.status(normalized.status).json(normalized.payload)
        }
    } catch (error: any) {
        const normalized = toHttpErrorPayload(error, 'Failed to complete Embedded Signup v4 onboarding')
        res.status(normalized.status).json(normalized.payload)
    }
})

app.get('/api/whatsapp/status', async (req: any, res: any) => {
    try {
        if (!isVersionedApiRequest(req)) {
            setDeprecatedRouteHeaders(res, '/api/v1/whatsapp/connections')
        }
        const user = await getSupabaseUserFromRequest(req, res)
        if (!user) return

        const userCompanyId = getUserCompanyId(user)
        if (!userCompanyId) {
            return res.status(400).json({ success: false, error: 'Company ID missing in user metadata' })
        }

        const requestedCompanyId = trimText(req.query?.company_id || req.query?.companyId) || userCompanyId
        const profileId = trimText(req.query?.profile_id || req.query?.profileId)
        if (requestedCompanyId !== userCompanyId && !isSuperAdminUser(user)) {
            return res.status(403).json({ success: false, error: 'company_id does not belong to your account' })
        }
        if (profileId) {
            const ownsProfile = await assertProfileCompany(profileId, requestedCompanyId)
            if (!ownsProfile) {
                return res.status(403).json({ success: false, error: 'Profile does not belong to the requested company' })
            }
        }

        const rows = await getCompanyWhatsappConnections(requestedCompanyId, profileId || undefined)
        const activeConnection = profileId
            ? rows.find((row: any) => trimText(row?.profile_id) === profileId) || null
            : (rows[0] || null)

        res.json({
            success: true,
            company_id: requestedCompanyId,
            profile_id: profileId || null,
            status: activeConnection ? (trimText(activeConnection?.status) || 'CONNECTED') : 'NOT_CONNECTED',
            connected: Boolean(activeConnection),
            connection: activeConnection ? shapeWhatsAppConnectionRow(activeConnection) : null,
            connections: rows.map((row: any) => shapeWhatsAppConnectionRow(row))
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error?.message || 'Failed to load WhatsApp status' })
    }
})

app.get('/api/whatsapp/phone-numbers', async (req: any, res: any) => {
    try {
        setDeprecatedRouteHeaders(res, '/api/v1/whatsapp/connections')
        const user = await getSupabaseUserFromRequest(req, res)
        if (!user) return

        const userCompanyId = getUserCompanyId(user)
        if (!userCompanyId) {
            return res.status(400).json({ success: false, error: 'Company ID missing in user metadata' })
        }

        const requestedCompanyId = trimText(req.query?.company_id || req.query?.companyId) || userCompanyId
        if (requestedCompanyId !== userCompanyId && !isSuperAdminUser(user)) {
            return res.status(403).json({ success: false, error: 'company_id does not belong to your account' })
        }

        const rows = await getCompanyWhatsappConnections(requestedCompanyId)
        res.json({
            success: true,
            company_id: requestedCompanyId,
            phone_numbers: rows.map((row: any) => shapeWhatsAppConnectionRow(row))
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error?.message || 'Failed to load WhatsApp phone numbers' })
    }
})

app.post('/api/whatsapp/refresh-status', async (req: any, res: any) => {
    try {
        setDeprecatedRouteHeaders(res, '/api/v1/whatsapp/connections/refresh')
        const user = await getSupabaseUserFromRequest(req, res)
        if (!user) return

        const userCompanyId = getUserCompanyId(user)
        if (!userCompanyId) {
            return res.status(400).json({ success: false, error: 'Company ID missing in user metadata' })
        }

        const requestedCompanyId = trimText(req.body?.company_id || req.body?.companyId) || userCompanyId
        const profileId = trimText(req.body?.profile_id || req.body?.profileId)
        if (requestedCompanyId !== userCompanyId && !isSuperAdminUser(user)) {
            return res.status(403).json({ success: false, error: 'company_id does not belong to your account' })
        }
        if (profileId) {
            const ownsProfile = await assertProfileCompany(profileId, requestedCompanyId)
            if (!ownsProfile) {
                return res.status(403).json({ success: false, error: 'Profile does not belong to the requested company' })
            }
        }

        const rows = await getCompanyWhatsappConnections(requestedCompanyId, profileId || undefined)
        const refreshed: any[] = []
        const failures: Array<{ phone_number_id: string | null; error: string }> = []

        for (const row of rows) {
            const accessTokenEncrypted = trimText(row?.access_token_encrypted)
            if (!accessTokenEncrypted) {
                failures.push({
                    phone_number_id: trimText(row?.phone_number_id) || null,
                    error: 'Missing encrypted access token'
                })
                continue
            }

            try {
                const accessToken = decryptToken(accessTokenEncrypted)
                const { data: configRow } = await supabase
                    .from('waba_configs')
                    .select('api_version')
                    .eq('profile_id', trimText(row?.profile_id))
                    .maybeSingle()

                const apiVersion = trimText(configRow?.api_version) || resolveMetaGraphVersionFromEnv('v24.0')
                const { wabaDetails, phoneDetails } = await fetchWabaAndPhoneDetails({
                    accessToken,
                    apiVersion,
                    wabaId: trimText(row?.waba_id),
                    phoneNumberId: trimText(row?.phone_number_id)
                })

                const updated = await persistWhatsAppConnection({
                    companyId: trimText(row?.company_id),
                    profileId: trimText(row?.profile_id),
                    userId: trimText(row?.user_id) || user.id,
                    wabaId: trimText(row?.waba_id),
                    phoneNumberId: trimText(row?.phone_number_id),
                    businessId: trimText(row?.business_id) || null,
                    accessToken,
                    tokenExpiresAt: trimText(row?.token_expires_at) || null,
                    flowType: trimText(row?.flow_type) || 'refresh_status',
                    phoneDetails,
                    wabaDetails,
                    status: trimText(phoneDetails?.status) || trimText(row?.status) || 'CONNECTED'
                })
                refreshed.push(shapeWhatsAppConnectionRow(updated))
            } catch (error: any) {
                failures.push({
                    phone_number_id: trimText(row?.phone_number_id) || null,
                    error: error?.message || 'Failed to refresh connection'
                })
            }
        }

        res.json({
            success: failures.length === 0,
            company_id: requestedCompanyId,
            profile_id: profileId || null,
            connections: refreshed,
            failures
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error?.message || 'Failed to refresh WhatsApp status' })
    }
})

app.post('/api/whatsapp/disconnect', async (req: any, res: any) => {
    try {
        setDeprecatedRouteHeaders(res, '/api/v1/whatsapp/connections/disconnect')
        const user = await getSupabaseUserFromRequest(req, res)
        if (!user) return

        const companyId = getUserCompanyId(user)
        if (!companyId) {
            return res.status(400).json({ success: false, error: 'Company ID missing in user metadata' })
        }

        const admin = await isAdminUser(user.id, companyId || undefined)
        if (!admin) {
            return res.status(403).json({ success: false, error: 'Admin access required' })
        }

        const requestedCompanyId = trimText(req.body?.company_id || req.body?.companyId) || companyId
        const profileId = trimText(req.body?.profile_id || req.body?.profileId)
        const revoke = req.body?.revoke === true

        if (requestedCompanyId !== companyId && !isSuperAdminUser(user)) {
            return res.status(403).json({ success: false, error: 'company_id does not belong to your account' })
        }
        if (!profileId) {
            return res.status(400).json({ success: false, error: 'profile_id is required' })
        }

        const ownsProfile = await assertProfileCompany(profileId, requestedCompanyId)
        if (!ownsProfile) {
            return res.status(403).json({ success: false, error: 'Profile does not belong to the requested company' })
        }

        const { data: config, error: fetchError } = await supabase
            .from('waba_configs')
            .select('profile_id, company_id, app_id, phone_number_id, business_id, waba_id, business_account_id, access_token, system_user_token, api_version')
            .eq('profile_id', profileId)
            .maybeSingle()

        if (fetchError || !config) {
            return res.status(404).json({ success: false, error: fetchError?.message || 'WABA config not found' })
        }

        const wabaId = trimText(config.waba_id || config.business_account_id)
        let unsubscribed = false
        let unsubscribeError: string | null = null

        if (revoke && wabaId) {
            try {
                const token = decryptToken(config.system_user_token || config.access_token)
                await unsubscribeWabaApp(wabaId, token, config.api_version || resolveMetaGraphVersionFromEnv('v24.0'))
                unsubscribed = true
            } catch (error: any) {
                unsubscribeError = error?.message || 'Failed to unsubscribe app'
            }
        }

        const nowIso = new Date().toISOString()
        const { error: configUpdateError } = await supabase
            .from('waba_configs')
            .update({ enabled: false })
            .eq('profile_id', profileId)

        if (configUpdateError) {
            return res.status(500).json({ success: false, error: configUpdateError.message })
        }

        const { error: connectionUpdateError } = await supabase
            .from('whatsapp_connections')
            .update({
                status: 'DISCONNECTED',
                last_synced_at: nowIso,
                updated_at: nowIso
            })
            .eq('company_id', requestedCompanyId)
            .eq('profile_id', profileId)

        if (connectionUpdateError && !isMissingWhatsappConnectionsTableError(connectionUpdateError)) {
            return res.status(500).json({ success: false, error: connectionUpdateError.message })
        }

        await wabaRegistry.refresh(true)

        if (unsubscribeError) {
            return res.json({ success: false, error: unsubscribeError, disabled: true, unsubscribed })
        }

        return res.json({ success: true, disabled: true, unsubscribed })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error?.message || 'Failed to disconnect WhatsApp' })
    }
})

// Manual WABA setup (admin-only fallback before Embedded Signup permissions)
app.post('/api/waba/manual-config', async (req: any, res: any) => {
    try {
        const user = await getSupabaseUserFromRequest(req, res)
        if (!user) return

        const companyId = getUserCompanyId(user)
        if (!companyId) {
            return res.status(400).json({ success: false, error: 'Company ID missing in user metadata' })
        }

        const profileId = typeof req.body?.profileId === 'string' ? req.body.profileId.trim() : ''
        if (!profileId) {
            return res.status(400).json({ success: false, error: 'profileId is required' })
        }

        const ownsProfile = await assertProfileCompany(profileId, companyId)
        if (!ownsProfile) {
            return res.status(403).json({ success: false, error: 'Profile does not belong to your company' })
        }

        const wabaId = typeof req.body?.wabaId === 'string' ? req.body.wabaId.trim() : ''
        const phoneNumberId = typeof req.body?.phoneNumberId === 'string' ? req.body.phoneNumberId.trim() : ''
        const accessToken = typeof req.body?.accessToken === 'string' ? req.body.accessToken.trim() : ''
        const businessId = typeof req.body?.businessId === 'string' ? req.body.businessId.trim() : null
        const verifyToken = (typeof req.body?.verifyToken === 'string' ? req.body.verifyToken.trim() : '') || resolveMetaVerifyTokenFromEnv()
        const appId = (typeof req.body?.appId === 'string' ? req.body.appId.trim() : '') || resolveMetaAppIdFromEnv()
        const appSecret = (typeof req.body?.appSecret === 'string' ? req.body.appSecret.trim() : '') || resolveMetaAppSecretFromEnv()
        const apiVersion = (typeof req.body?.apiVersion === 'string' ? req.body.apiVersion.trim() : '') || resolveMetaGraphVersionFromEnv('v24.0')

        if (!wabaId || !phoneNumberId || !accessToken) {
            return res.status(400).json({ success: false, error: 'wabaId, phoneNumberId, and accessToken are required' })
        }

        const phoneConfigConflict = await findConflictingActivePhoneNumberConfig(phoneNumberId, profileId)
        if (phoneConfigConflict) {
            return res.status(409).json({
                success: false,
                error: `phoneNumberId "${phoneNumberId}" is already connected to profile "${phoneConfigConflict.profileId}". Disconnect it first.`
            })
        }

        if (!verifyToken) {
            return res.status(400).json({ success: false, error: 'verifyToken is required (or set META_WEBHOOK_VERIFY_TOKEN / WABA_VERIFY_TOKEN)' })
        }

        if (!getTokenEncryptionKey()) {
            return res.status(500).json({ success: false, error: 'Missing WABA_TOKEN_ENCRYPTION_KEY or ENCRYPTION_KEY' })
        }

        const nowIso = new Date().toISOString()
        const payload: any = {
            profile_id: profileId,
            company_id: companyId,
            app_id: appId || null,
            phone_number_id: phoneNumberId,
            business_id: businessId || null,
            waba_id: wabaId,
            business_account_id: wabaId,
            access_token: encryptToken(accessToken),
            access_token_type: null,
            access_token_expires_at: null,
            token_scopes: null,
            token_source: 'system_user',
            system_user_token: null,
            system_user_token_expires_at: null,
            token_last_refreshed_at: nowIso,
            verify_token: verifyToken,
            app_secret: appSecret || null,
            api_version: apiVersion,
            enabled: true,
            connected_at: nowIso
        }

        const { error: upsertError } = await supabase
            .from('waba_configs')
            .upsert(payload, { onConflict: 'profile_id' })

        if (upsertError) {
            return res.status(500).json({ success: false, error: upsertError.message })
        }

        let subscribeError: string | null = null
        try {
            await subscribeWabaApp(wabaId, accessToken, apiVersion)
        } catch (err: any) {
            subscribeError = formatMetaOperationError(err, 'Failed to subscribe webhook')
        }

        try {
            const details = await fetchWabaAndPhoneDetails({
                accessToken,
                apiVersion,
                wabaId,
                phoneNumberId
            })
            await persistWhatsAppConnection({
                companyId,
                profileId,
                userId: user.id,
                wabaId,
                phoneNumberId,
                businessId,
                accessToken,
                tokenExpiresAt: null,
                flowType: 'manual_config',
                phoneDetails: details.phoneDetails,
                wabaDetails: details.wabaDetails,
                status: subscribeError ? 'PENDING' : (trimText(details.phoneDetails?.status) || 'CONNECTED')
            })
        } catch (err: any) {
            await persistWhatsAppConnection({
                companyId,
                profileId,
                userId: user.id,
                wabaId,
                phoneNumberId,
                businessId,
                accessToken,
                tokenExpiresAt: null,
                flowType: 'manual_config',
                status: subscribeError ? 'PENDING' : 'CONNECTED'
            })
        }

        await wabaRegistry.refresh(true)

        res.json({
            success: true,
            subscribed: !subscribeError,
            subscribeError
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

function escapeHtml(value: any): string {
    const text = value === null || value === undefined ? '' : String(value)
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

function sanitizeReturnUrl(value: any): string | null {
    const raw = typeof value === 'string' ? value.trim() : ''
    if (!raw) return null
    try {
        const parsed = new URL(raw)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
        return parsed.toString()
    } catch {
        return null
    }
}

function renderOauthShell(payload: {
    title: string
    subtitle: string
    tone?: 'info' | 'success' | 'error'
    contentHtml: string
    returnUrl?: string
}) {
    const tone = payload.tone || 'info'
    const toneBadgeClass = tone === 'success'
        ? 'background:#e8f9f2;color:#0f805f;border-color:#bae7d3;'
        : tone === 'error'
            ? 'background:#fff1f3;color:#be2f42;border-color:#f4cad1;'
            : 'background:#eef5ff;color:#1f5fb8;border-color:#d3e2fb;'
    const safeTitle = escapeHtml(payload.title)
    const safeSubtitle = escapeHtml(payload.subtitle)
    const safeReturnUrl = sanitizeReturnUrl(payload.returnUrl)
    const returnLink = safeReturnUrl
        ? `<a href="${escapeHtml(safeReturnUrl)}" style="display:inline-flex;align-items:center;justify-content:center;padding:11px 16px;border-radius:12px;background:#111b21;color:#fff;text-decoration:none;font-size:13px;font-weight:700;">Return to dashboard</a>`
        : ''

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${safeTitle}</title>
</head>
<body style="margin:0;font-family:Manrope,Segoe UI,Arial,sans-serif;background:radial-gradient(circle at 14% 10%,rgba(14,164,122,.14),transparent 34%),radial-gradient(circle at 86% 0,rgba(42,110,244,.14),transparent 30%),#f6f8fb;color:#12253a;">
  <main style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:26px 14px;">
    <section style="width:min(100%,620px);border:1px solid #d7e4f4;border-radius:26px;background:linear-gradient(180deg,#fff 0%,#f8fcff 100%);box-shadow:0 22px 58px rgba(17,35,60,.16);padding:22px 20px;">
      <div style="display:inline-flex;border:1px solid #dbe8f8;border-radius:999px;padding:5px 10px;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;${toneBadgeClass}">${escapeHtml(tone)}</div>
      <h1 style="margin:14px 0 0;font-size:28px;line-height:1.18;letter-spacing:-.02em;">${safeTitle}</h1>
      <p style="margin:10px 0 0;color:#586b82;font-size:14px;line-height:1.6;">${safeSubtitle}</p>
      <div style="margin-top:18px;">${payload.contentHtml}</div>
      ${returnLink ? `<div style="margin-top:20px;">${returnLink}</div>` : ''}
    </section>
  </main>
</body>
</html>`
}

function renderOauthHtml(title: string, message: string, returnUrl?: string) {
    const normalizedTitle = typeof title === 'string' ? title.trim() : ''
    const normalizedMessage = typeof message === 'string' ? message.trim() : ''
    const tone: 'info' | 'success' | 'error' =
        /^connected$/i.test(normalizedTitle)
            ? 'success'
            : /(failed|error|invalid|expired|no |missing|conflict|already)/i.test(`${normalizedTitle} ${normalizedMessage}`)
                ? 'error'
                : 'info'
    return renderOauthShell({
        title: normalizedTitle || 'WABA OAuth Status',
        subtitle: normalizedMessage || 'Completed.',
        tone,
        contentHtml: '',
        returnUrl
    })
}

function renderBusinessChoiceHtml(payload: {
    businesses: Array<{ id: string; name?: string }>
    state: string
    returnUrl?: string
}) {
    const rows = payload.businesses.map((business) => {
        const businessName = typeof business?.name === 'string' && business.name.trim() ? business.name.trim() : 'Business'
        const businessId = typeof business?.id === 'string' ? business.id.trim() : ''
        const href = `/auth/waba/callback?state=${encodeURIComponent(payload.state)}&business_id=${encodeURIComponent(businessId)}`
        return `<li style="list-style:none;">
            <a href="${escapeHtml(href)}" style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;border-radius:14px;border:1px solid #d9e5f3;background:#fff;color:#12253a;text-decoration:none;font-weight:700;">
              <span style="display:block;min-width:0;">
                <span style="display:block;font-size:14px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(businessName)}</span>
                <span style="display:block;margin-top:4px;font-size:11px;color:#6a7e95;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">${escapeHtml(businessId)}</span>
              </span>
              <span style="display:inline-flex;align-items:center;justify-content:center;padding:7px 10px;border-radius:10px;background:#111b21;color:#fff;font-size:11px;white-space:nowrap;">Select</span>
            </a>
          </li>`
    }).join('')

    return renderOauthShell({
        title: 'Select Business',
        subtitle: 'Choose which Meta Business should be connected for this WABA profile.',
        tone: 'info',
        contentHtml: `<ul style="margin:0;padding:0;display:grid;gap:10px;">${rows}</ul>`,
        returnUrl: payload.returnUrl
    })
}

function renderPhoneNumberChoiceHtml(payload: {
    phoneNumbers: Array<{
        id: string
        display_phone_number?: string
        verified_name?: string
        conflict_profile_id?: string | null
    }>
    state: string
    businessId: string
    wabaId: string
    returnUrl?: string
    subtitle?: string
    alertMessage?: string
}) {
    const rows = payload.phoneNumbers
        .map((phone) => {
            const phoneId = typeof phone?.id === 'string' ? phone.id.trim() : ''
            if (!phoneId) return ''

            const displayPhone = typeof phone?.display_phone_number === 'string' && phone.display_phone_number.trim()
                ? phone.display_phone_number.trim()
                : 'No display number'
            const verifiedName = typeof phone?.verified_name === 'string' && phone.verified_name.trim()
                ? phone.verified_name.trim()
                : null
            const conflictProfileId = typeof phone?.conflict_profile_id === 'string' && phone.conflict_profile_id.trim()
                ? phone.conflict_profile_id.trim()
                : null
            const verifiedLine = verifiedName
                ? `Verified name: ${escapeHtml(verifiedName)}`
                : 'Verified name not available'
            const href = `/auth/waba/callback?state=${encodeURIComponent(payload.state)}&business_id=${encodeURIComponent(payload.businessId)}&waba_id=${encodeURIComponent(payload.wabaId)}&phone_number_id=${encodeURIComponent(phoneId)}`

            if (conflictProfileId) {
                return `<li style="list-style:none;">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:12px 14px;border-radius:14px;border:1px solid #f1c7ce;background:#fff6f7;">
              <span style="display:block;min-width:0;">
                <span style="display:block;font-size:14px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(displayPhone)}</span>
                <span style="display:block;margin-top:4px;font-size:11px;color:#6a7e95;">${verifiedLine}</span>
                <span style="display:block;margin-top:4px;font-size:11px;color:#6a7e95;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">${escapeHtml(phoneId)}</span>
              </span>
              <span style="display:inline-flex;align-items:center;justify-content:center;padding:7px 10px;border-radius:10px;background:#f8d6dc;color:#8b1f2f;font-size:11px;white-space:nowrap;">Unavailable</span>
            </div>
            <p style="margin:6px 4px 0;font-size:12px;color:#8b1f2f;">Connected to profile ${escapeHtml(conflictProfileId)}. Disconnect it first.</p>
          </li>`
            }

            return `<li style="list-style:none;">
            <a href="${escapeHtml(href)}" style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;border-radius:14px;border:1px solid #d9e5f3;background:#fff;color:#12253a;text-decoration:none;font-weight:700;">
              <span style="display:block;min-width:0;">
                <span style="display:block;font-size:14px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(displayPhone)}</span>
                <span style="display:block;margin-top:4px;font-size:11px;color:#6a7e95;">${verifiedLine}</span>
                <span style="display:block;margin-top:4px;font-size:11px;color:#6a7e95;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">${escapeHtml(phoneId)}</span>
              </span>
              <span style="display:inline-flex;align-items:center;justify-content:center;padding:7px 10px;border-radius:10px;background:#111b21;color:#fff;font-size:11px;white-space:nowrap;">Select</span>
            </a>
          </li>`
        })
        .filter(Boolean)
        .join('')

    const alertHtml = payload.alertMessage
        ? `<div style="margin:0 0 12px;padding:11px 12px;border:1px solid #f4cad1;background:#fff3f5;color:#8b1f2f;border-radius:12px;font-size:12px;line-height:1.5;">${escapeHtml(payload.alertMessage)}</div>`
        : ''
    const listHtml = rows || `<li style="list-style:none;padding:12px 14px;border-radius:14px;border:1px solid #d9e5f3;background:#fff;font-size:13px;color:#5b6f86;">No phone numbers available.</li>`

    return renderOauthShell({
        title: 'Select Phone Number',
        subtitle: payload.subtitle || 'Choose which WhatsApp phone number should be connected for this profile.',
        tone: 'info',
        contentHtml: `${alertHtml}<ul style="margin:0;padding:0;display:grid;gap:10px;">${listHtml}</ul>`,
        returnUrl: payload.returnUrl
    })
}

app.get('/auth/waba/callback', async (req: any, res: any) => {
    try {
        const errorParam = typeof req.query?.error === 'string' ? req.query.error : null
        const errorDescription = typeof req.query?.error_description === 'string' ? req.query.error_description : null
        if (errorParam) {
            return res.status(400).send(renderOauthHtml('Connection failed', errorDescription || errorParam, resolveOauthReturnUrl(req)))
        }

        const code = typeof req.query?.code === 'string' ? req.query.code : null
        const state = typeof req.query?.state === 'string' ? req.query.state : null
        const selectedBusinessId = typeof req.query?.business_id === 'string'
            ? req.query.business_id
            : typeof req.query?.businessId === 'string'
                ? req.query.businessId
                : null
        const selectedWabaId = typeof req.query?.waba_id === 'string'
            ? req.query.waba_id
            : typeof req.query?.wabaId === 'string'
                ? req.query.wabaId
                : null
        const selectedPhoneNumberId = typeof req.query?.phone_number_id === 'string'
            ? req.query.phone_number_id
            : typeof req.query?.phoneNumberId === 'string'
                ? req.query.phoneNumberId
                : null
        if (!state) {
            return res.status(400).send(renderOauthHtml('Invalid callback', 'Missing state.', resolveOauthReturnUrl(req)))
        }

        const stateHash = hashOAuthState(state)
        const { data: stateRow, error: stateError } = await supabase
            .from('waba_oauth_states')
            .select('*')
            .eq('state_hash', stateHash)
            .maybeSingle()

        if (stateError || !stateRow) {
            return res.status(400).send(renderOauthHtml('Invalid state', 'OAuth state not found or expired.', resolveOauthReturnUrl(req)))
        }

        if (stateRow.used_at) {
            const usedAtIso = (() => {
                try {
                    return new Date(stateRow.used_at).toISOString()
                } catch {
                    return String(stateRow.used_at || '')
                }
            })()
            return res.status(400).send(renderOauthHtml(
                'State already used',
                `This OAuth link was already used at ${usedAtIso}. Start "Connect WhatsApp Business" again to generate a fresh link.`,
                stateRow.redirect_url || resolveOauthReturnUrl(req)
            ))
        }

        if (stateRow.expires_at && new Date(stateRow.expires_at).getTime() < Date.now()) {
            const expiresAtIso = (() => {
                try {
                    return new Date(stateRow.expires_at).toISOString()
                } catch {
                    return String(stateRow.expires_at || '')
                }
            })()
            return res.status(400).send(renderOauthHtml(
                'State expired',
                `This OAuth link expired at ${expiresAtIso}. Start "Connect WhatsApp Business" again. Each link is valid for 10 minutes.`,
                stateRow.redirect_url || resolveOauthReturnUrl(req)
            ))
        }

        const appId = process.env.WABA_APP_ID || process.env.APP_ID
        const appSecret = process.env.WABA_APP_SECRET || process.env.APP_SECRET
        const verifyToken = process.env.WABA_VERIFY_TOKEN || process.env.VERIFY_TOKEN
        if (!appId || !appSecret || !verifyToken) {
            return res.status(500).send(renderOauthHtml('Server misconfigured', 'Missing WABA_APP_ID, WABA_APP_SECRET, or WABA_VERIFY_TOKEN.'))
        }

        if (!getTokenEncryptionKey()) {
            return res.status(500).send(renderOauthHtml('Server misconfigured', 'Missing WABA_TOKEN_ENCRYPTION_KEY.'))
        }

        const apiVersion = process.env.WABA_API_VERSION || 'v19.0'
        const configId = process.env.WABA_EMBEDDED_SIGNUP_CONFIG_ID
        const oauthMode = resolveOauthMode(configId)
        const useBusinessIntegration = oauthMode === 'business_integration'
        const redirectUri = resolveOauthRedirectUri(req)

        let accessToken: string | null = null
        let tokenType: string | undefined = undefined
        let expiresIn: number | undefined = undefined

        if (code) {
            const tokenData = await exchangeCodeForToken({
                appId,
                appSecret,
                redirectUri,
                code,
                apiVersion
            })
            accessToken = tokenData.access_token
            tokenType = tokenData.token_type
            expiresIn = tokenData.expires_in
        } else if (stateRow.access_token) {
            try {
                accessToken = decryptToken(stateRow.access_token)
                tokenType = stateRow.access_token_type || undefined
                if (stateRow.access_token_expires_at) {
                    const expiresAtMs = new Date(stateRow.access_token_expires_at).getTime()
                    if (!Number.isNaN(expiresAtMs)) {
                        expiresIn = Math.max(0, Math.round((expiresAtMs - Date.now()) / 1000))
                    }
                }
            } catch (err: any) {
                return res.status(400).send(renderOauthHtml('Session expired', 'Please restart the signup flow.'))
            }
        } else {
            return res.status(400).send(renderOauthHtml('Invalid callback', 'Missing code for token exchange. Please restart the signup flow.'))
        }

        if (!accessToken) {
            return res.status(400).send(renderOauthHtml('Invalid callback', 'Missing access token. Please restart the signup flow.'))
        }
        let clientBusinessId: string | null = null
        let businessIntegrationToken: string | null = null
        let businessIntegrationExpiresAt: string | null = null

        if (useBusinessIntegration) {
            try {
                const me = await fetchClientBusinessId(accessToken, apiVersion)
                clientBusinessId = me.client_business_id || null
            } catch (err: any) {
                console.warn('[WABA] Failed to fetch client_business_id:', err?.message || err)
            }

            if (clientBusinessId) {
                try {
                    const existingToken = await fetchBusinessIntegrationSystemUserToken({
                        clientBusinessId,
                        accessToken,
                        appSecret,
                        apiVersion,
                        fetchOnly: true
                    })
                    if (existingToken?.access_token) {
                        businessIntegrationToken = existingToken.access_token
                        if (existingToken.expires_in) {
                            businessIntegrationExpiresAt = new Date(Date.now() + Number(existingToken.expires_in) * 1000).toISOString()
                        }
                    } else {
                        const createdToken = await fetchBusinessIntegrationSystemUserToken({
                            clientBusinessId,
                            accessToken,
                            appSecret,
                            apiVersion
                        })
                        if (createdToken?.access_token) {
                            businessIntegrationToken = createdToken.access_token
                            if (createdToken.expires_in) {
                                businessIntegrationExpiresAt = new Date(Date.now() + Number(createdToken.expires_in) * 1000).toISOString()
                            }
                        }
                    }
                } catch (err: any) {
                    console.warn('[WABA] Failed to fetch business integration token:', err?.message || err)
                }
            }
        } else {
            try {
                const longLived = await exchangeForLongLivedToken({
                    appId,
                    appSecret,
                    shortLivedToken: accessToken,
                    apiVersion
                })
                if (longLived?.access_token) {
                    accessToken = longLived.access_token
                    tokenType = longLived.token_type || tokenType
                    expiresIn = longLived.expires_in || expiresIn
                }
            } catch (err: any) {
                console.warn('[WABA] Long-lived token exchange failed:', err?.message || err)
            }
        }

        const graphToken = businessIntegrationToken || accessToken
        const returnUrl = stateRow.redirect_url || resolveOauthReturnUrl(req)
        const persistOauthSessionState = async () => {
            const accessTokenExpiresAt = expiresIn
                ? new Date(Date.now() + Number(expiresIn) * 1000).toISOString()
                : null
            const { error: persistError } = await supabase
                .from('waba_oauth_states')
                .update({
                    access_token: encryptToken(accessToken),
                    access_token_type: tokenType || null,
                    access_token_expires_at: accessTokenExpiresAt,
                    client_business_id: clientBusinessId
                })
                .eq('id', stateRow.id)
            return persistError || null
        }

        let wabaId = selectedWabaId || (stateRow.requested_waba_id as string | null)
        let businessId = selectedBusinessId || (stateRow.requested_business_id as string | null)
        let preferredWabaIds = new Set<string>()
        let preferredBusinessIds = new Set<string>()

        if (!businessId) {
            if (useBusinessIntegration && clientBusinessId) {
                businessId = clientBusinessId
            } else {
                const businesses = await fetchBusinesses(accessToken, apiVersion)
                if (!businesses.length) {
                    return res.status(400).send(renderOauthHtml('No businesses found', 'This account has no Meta businesses available.'))
                }

                if (businesses.length > 1 && !selectedBusinessId) {
                    const persistError = await persistOauthSessionState()
                    if (persistError) {
                        return res.status(500).send(renderOauthHtml('Storage failed', persistError.message, returnUrl))
                    }
                    return res.status(200).send(renderBusinessChoiceHtml({
                        businesses,
                        state,
                        returnUrl
                    }))
                }

                try {
                    const { data: existingConfigs } = await supabase
                        .from('waba_configs')
                        .select('business_id, waba_id')
                        .eq('company_id', stateRow.company_id)

                    ;(existingConfigs || []).forEach((row: any) => {
                        if (row.business_id) preferredBusinessIds.add(String(row.business_id))
                        if (row.waba_id) preferredWabaIds.add(String(row.waba_id))
                    })
                } catch (err: any) {
                    console.warn('[WABA] Failed to load existing configs for auto selection:', err?.message || err)
                }

                const preferredBusiness = businesses.find((b) => preferredBusinessIds.has(b.id))
                if (preferredBusiness) {
                    businessId = preferredBusiness.id
                } else if (businesses.length === 1) {
                    businessId = businesses[0].id
                } else {
                    businessId = businesses[0].id
                }
            }
        }

        if (!businessId) {
            return res.status(400).send(renderOauthHtml('No businesses found', 'Could not determine which Meta Business to connect.', returnUrl))
        }

        if (!wabaId) {
            const owned = await fetchOwnedWabaAccounts(businessId, graphToken, apiVersion)
            const candidates = owned.length ? owned : await fetchClientWabaAccounts(businessId, graphToken, apiVersion)
            if (!candidates.length) {
                return res.status(400).send(renderOauthHtml('No WABA found', 'No WhatsApp Business Accounts found for this business.'))
            }
            if (candidates.length > 1) {
                const preferred = candidates.find((c) => preferredWabaIds.has(c.id))
                wabaId = preferred ? preferred.id : candidates[0].id
            } else {
                wabaId = candidates[0].id
            }
        }

        if (!wabaId) {
            return res.status(400).send(renderOauthHtml('No WABA found', 'Could not determine which WABA to connect.', returnUrl))
        }

        const stateProfileId = typeof stateRow.profile_id === 'string' ? stateRow.profile_id.trim() : ''
        if (!stateProfileId) {
            return res.status(400).send(renderOauthHtml('Invalid callback', 'Profile information is missing in OAuth state.'))
        }

        let phoneNumberId = selectedPhoneNumberId || (stateRow.requested_phone_number_id as string | null)
        let selectedPhoneDisplayNumber: string | null = null
        let selectedPhoneVerifiedName: string | null = null
        let availablePhoneNumbers: Array<{ id: string; display_phone_number?: string; verified_name?: string }> = await fetchPhoneNumbers(wabaId, graphToken, apiVersion)
        if (!availablePhoneNumbers.length) {
            return res.status(400).send(renderOauthHtml('No phone numbers found', 'No phone numbers were found for this WABA.'))
        }

        availablePhoneNumbers = availablePhoneNumbers
            .map((entry) => {
                const id = typeof entry?.id === 'string' ? entry.id.trim() : ''
                if (!id) return null
                return { ...entry, id }
            })
            .filter((entry): entry is { id: string; display_phone_number?: string; verified_name?: string } => Boolean(entry))

        if (!availablePhoneNumbers.length) {
            return res.status(400).send(renderOauthHtml('No phone numbers found', 'No valid phone number IDs were returned for this WABA.'))
        }

        const phoneNumbersById = new Map(availablePhoneNumbers.map((entry) => [entry.id, entry]))
        let phoneConflictsById: Map<string, string | null> | null = null
        const loadPhoneConflicts = async () => {
            if (phoneConflictsById) return phoneConflictsById

            const nextMap = new Map<string, string | null>()
            for (const candidate of availablePhoneNumbers) {
                const conflict = await findConflictingActivePhoneNumberConfig(candidate.id, stateProfileId)
                if (!conflict) continue
                const conflictingProfileId = typeof conflict?.profileId === 'string'
                    ? conflict.profileId.trim()
                    : typeof conflict?.profile_id === 'string'
                        ? conflict.profile_id.trim()
                        : ''
                nextMap.set(candidate.id, conflictingProfileId || null)
            }

            phoneConflictsById = nextMap
            return nextMap
        }
        const buildPhoneChoices = async () => {
            const conflicts = await loadPhoneConflicts()
            return availablePhoneNumbers.map((entry) => ({
                id: entry.id,
                display_phone_number: entry.display_phone_number,
                verified_name: entry.verified_name,
                conflict_profile_id: conflicts.get(entry.id) || null
            }))
        }

        if (!phoneNumberId && availablePhoneNumbers.length > 1) {
            const persistError = await persistOauthSessionState()
            if (persistError) {
                return res.status(500).send(renderOauthHtml('Storage failed', persistError.message, returnUrl))
            }
            return res.status(200).send(renderPhoneNumberChoiceHtml({
                phoneNumbers: await buildPhoneChoices(),
                state,
                businessId,
                wabaId,
                returnUrl
            }))
        }

        if (!phoneNumberId) {
            phoneNumberId = availablePhoneNumbers[0].id
        }

        if (!phoneNumbersById.has(phoneNumberId)) {
            const persistError = await persistOauthSessionState()
            if (persistError) {
                return res.status(500).send(renderOauthHtml('Storage failed', persistError.message, returnUrl))
            }
            return res.status(400).send(renderPhoneNumberChoiceHtml({
                phoneNumbers: await buildPhoneChoices(),
                state,
                businessId,
                wabaId,
                returnUrl,
                alertMessage: `phoneNumberId "${phoneNumberId}" is not available in this WABA. Select a different number.`
            }))
        }

        const selectedPhone = phoneNumbersById.get(phoneNumberId)
        if (selectedPhone) {
            selectedPhoneDisplayNumber = typeof selectedPhone.display_phone_number === 'string'
                ? selectedPhone.display_phone_number.trim() || null
                : null
            selectedPhoneVerifiedName = typeof selectedPhone.verified_name === 'string'
                ? selectedPhone.verified_name.trim() || null
                : null
        }

        const phoneConflicts = await loadPhoneConflicts()
        const phoneConflictProfileId = phoneConflicts.get(phoneNumberId) || null
        if (phoneConflictProfileId !== null) {
            if (availablePhoneNumbers.length > 1) {
                const persistError = await persistOauthSessionState()
                if (persistError) {
                    return res.status(500).send(renderOauthHtml('Storage failed', persistError.message, returnUrl))
                }
                return res.status(409).send(renderPhoneNumberChoiceHtml({
                    phoneNumbers: await buildPhoneChoices(),
                    state,
                    businessId,
                    wabaId,
                    returnUrl,
                    alertMessage: `phoneNumberId "${phoneNumberId}" is already connected to another profile. Disconnect it first or select a different number.`
                }))
            }

            return res.status(409).send(renderOauthHtml(
                'Phone number already connected',
                `phoneNumberId "${phoneNumberId}" is already connected to another profile. Disconnect it first.`,
                returnUrl
            ))
        }

        try {
            await subscribeWabaApp(wabaId, graphToken, apiVersion)
        } catch (err: any) {
            return res.status(500).send(renderOauthHtml('Subscription failed', formatMetaOperationError(err, 'Failed to subscribe app.')))
        }

        let systemUserToken: string | null = null
        let systemUserTokenExpiresAt: string | null = null
        const systemUserId = process.env.WABA_SYSTEM_USER_ID
        if (systemUserId && !useBusinessIntegration) {
            try {
                const systemTokenResponse = await createSystemUserToken({
                    systemUserId,
                    accessToken,
                    scopes: WABA_OAUTH_SCOPES,
                    apiVersion
                }) as any
                if (systemTokenResponse?.access_token) {
                    systemUserToken = systemTokenResponse.access_token
                    if (systemTokenResponse.expires_in) {
                        systemUserTokenExpiresAt = new Date(Date.now() + Number(systemTokenResponse.expires_in) * 1000).toISOString()
                    }
                }
            } catch (err: any) {
                console.warn('[WABA] System user token exchange failed:', err?.message || err)
            }
        }

        const nowIso = new Date().toISOString()
        const baseTokenExpiresAt = expiresIn ? new Date(Date.now() + Number(expiresIn) * 1000).toISOString() : null
        const accessTokenExpiresAt = useBusinessIntegration
            ? (businessIntegrationToken ? businessIntegrationExpiresAt : baseTokenExpiresAt)
            : baseTokenExpiresAt

        const payload: any = {
            profile_id: stateProfileId,
            company_id: stateRow.company_id,
            app_id: appId,
            phone_number_id: phoneNumberId,
            business_id: businessId,
            client_business_id: clientBusinessId,
            waba_id: wabaId,
            business_account_id: wabaId,
            access_token: encryptToken(graphToken),
            access_token_type: tokenType || null,
            access_token_expires_at: accessTokenExpiresAt,
            token_scopes: useBusinessIntegration ? null : WABA_OAUTH_SCOPES,
            token_source: useBusinessIntegration ? 'business_integration' : (systemUserToken ? 'system_user' : 'user'),
            system_user_token: systemUserToken ? encryptToken(systemUserToken) : null,
            system_user_token_expires_at: systemUserTokenExpiresAt,
            token_last_refreshed_at: nowIso,
            verify_token: verifyToken,
            app_secret: appSecret,
            api_version: apiVersion,
            enabled: true,
            connected_at: nowIso
        }

        const { error: upsertError } = await supabase
            .from('waba_configs')
            .upsert(payload, { onConflict: 'profile_id' })

        if (upsertError) {
            return res.status(500).send(renderOauthHtml('Storage failed', upsertError.message))
        }

        try {
            const details = await fetchWabaAndPhoneDetails({
                accessToken: graphToken,
                apiVersion,
                wabaId,
                phoneNumberId
            })
            await persistWhatsAppConnection({
                companyId: trimText(stateRow.company_id),
                profileId: stateProfileId,
                userId: trimText(stateRow.user_id) || stateRow.user_id,
                wabaId,
                phoneNumberId,
                businessId,
                accessToken: graphToken,
                tokenExpiresAt: accessTokenExpiresAt,
                flowType: useBusinessIntegration ? 'business_integration' : (systemUserToken ? 'system_user' : 'legacy_embedded_signup'),
                phoneDetails: details.phoneDetails,
                wabaDetails: details.wabaDetails,
                status: trimText(details.phoneDetails?.status) || 'CONNECTED'
            })
        } catch (err: any) {
            await persistWhatsAppConnection({
                companyId: trimText(stateRow.company_id),
                profileId: stateProfileId,
                userId: trimText(stateRow.user_id) || stateRow.user_id,
                wabaId,
                phoneNumberId,
                businessId,
                accessToken: graphToken,
                tokenExpiresAt: accessTokenExpiresAt,
                flowType: useBusinessIntegration ? 'business_integration' : (systemUserToken ? 'system_user' : 'legacy_embedded_signup'),
                phoneDetails: {
                    display_phone_number: selectedPhoneDisplayNumber,
                    verified_name: selectedPhoneVerifiedName,
                    status: 'CONNECTED'
                },
                status: 'CONNECTED'
            })
        }

        await supabase
            .from('waba_oauth_states')
            .update({
                used_at: new Date().toISOString(),
                requested_business_id: businessId,
                requested_waba_id: wabaId,
                requested_phone_number_id: phoneNumberId
            })
            .eq('id', stateRow.id)

        await wabaRegistry.refresh(true)

        if (returnUrl) {
            const redirect = new URL(returnUrl)
            redirect.searchParams.set('waba', 'connected')
            if (phoneNumberId) {
                redirect.searchParams.set('waba_phone_number_id', String(phoneNumberId))
            }
            if (selectedPhoneDisplayNumber) {
                redirect.searchParams.set('waba_display_phone_number', selectedPhoneDisplayNumber)
            }
            if (selectedPhoneVerifiedName) {
                redirect.searchParams.set('waba_verified_name', selectedPhoneVerifiedName)
            }
            return res.redirect(302, redirect.toString())
        }

        return res.send(renderOauthHtml('Connected', 'WhatsApp Business account connected successfully.'))
    } catch (error: any) {
        res.status(500).send(renderOauthHtml('Unexpected error', error.message || 'Unexpected error'))
    }
})

// ============================================
// WABA PRE-VERIFIED NUMBERS
// ============================================
app.get('/api/waba/preverified-numbers', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const config = await wabaRegistry.getConfigByProfile(access.profileId)
        const businessPortfolioId = typeof req.query?.businessPortfolioId === 'string'
            ? req.query.businessPortfolioId.trim()
            : (config?.businessId || config?.clientBusinessId || '').trim()
        const status = typeof req.query?.codeVerificationStatus === 'string'
            ? req.query.codeVerificationStatus.trim().toUpperCase()
            : undefined

        if (!businessPortfolioId) {
            return res.status(400).json({ success: false, error: 'businessPortfolioId is required' })
        }

        const data = await client.getPreverifiedNumbers(
            businessPortfolioId,
            status ? { codeVerificationStatus: status } : undefined
        )
        res.json({ success: true, data })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/waba/preverified-numbers/add', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const config = await wabaRegistry.getConfigByProfile(access.profileId)
        const businessPortfolioId = typeof req.body?.businessPortfolioId === 'string'
            ? req.body.businessPortfolioId.trim()
            : (config?.businessId || config?.clientBusinessId || '').trim()
        const phoneNumber = typeof req.body?.phoneNumber === 'string' ? req.body.phoneNumber.trim() : ''

        if (!businessPortfolioId || !phoneNumber) {
            return res.status(400).json({ success: false, error: 'businessPortfolioId and phoneNumber are required' })
        }

        const data = await client.addPreverifiedPhoneNumber(businessPortfolioId, phoneNumber)
        res.json({ success: true, data })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/waba/preverified-numbers/request-code', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const preverifiedPhoneNumberId = typeof req.body?.preverifiedPhoneNumberId === 'string'
            ? req.body.preverifiedPhoneNumberId.trim()
            : ''
        const codeMethodRaw = typeof req.body?.codeMethod === 'string' ? req.body.codeMethod.trim().toUpperCase() : ''
        const codeMethod = codeMethodRaw === 'VOICE' ? 'VOICE' : 'SMS'
        const language = typeof req.body?.language === 'string' ? req.body.language.trim() : 'en_US'

        if (!preverifiedPhoneNumberId) {
            return res.status(400).json({ success: false, error: 'preverifiedPhoneNumberId is required' })
        }

        const data = await client.requestPreverifiedNumberCode(preverifiedPhoneNumberId, codeMethod, language || 'en_US')
        res.json({ success: true, data })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/waba/preverified-numbers/verify-code', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const preverifiedPhoneNumberId = typeof req.body?.preverifiedPhoneNumberId === 'string'
            ? req.body.preverifiedPhoneNumberId.trim()
            : ''
        const code = typeof req.body?.code === 'string' ? req.body.code.trim() : ''

        if (!preverifiedPhoneNumberId || !code) {
            return res.status(400).json({ success: false, error: 'preverifiedPhoneNumberId and code are required' })
        }

        const data = await client.verifyPreverifiedNumberCode(preverifiedPhoneNumberId, code)
        res.json({ success: true, data })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/waba/preverified-numbers/share', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const businessId = typeof req.body?.businessId === 'string' ? req.body.businessId.trim() : ''
        const partnerBusinessId = typeof req.body?.partnerBusinessId === 'string' ? req.body.partnerBusinessId.trim() : ''
        const preverifiedId = typeof req.body?.preverifiedId === 'string' ? req.body.preverifiedId.trim() : ''

        if (!businessId || !partnerBusinessId || !preverifiedId) {
            return res.status(400).json({ success: false, error: 'businessId, partnerBusinessId, and preverifiedId are required' })
        }

        const data = await client.sharePreverifiedNumber(businessId, partnerBusinessId, preverifiedId)
        res.json({ success: true, data })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.delete('/api/waba/preverified-numbers/share', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const businessId = typeof req.body?.businessId === 'string' ? req.body.businessId.trim() : ''
        const partnerBusinessId = typeof req.body?.partnerBusinessId === 'string' ? req.body.partnerBusinessId.trim() : ''
        const preverifiedId = typeof req.body?.preverifiedId === 'string' ? req.body.preverifiedId.trim() : ''

        if (!businessId || !partnerBusinessId || !preverifiedId) {
            return res.status(400).json({ success: false, error: 'businessId, partnerBusinessId, and preverifiedId are required' })
        }

        const data = await client.unsharePreverifiedNumber(businessId, partnerBusinessId, preverifiedId)
        res.json({ success: true, data })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

// ============================================
// WABA NUMBER REGISTRATION (REQUEST/VERIFY/REGISTER)
// ============================================
app.get('/api/waba/registration/config', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const config = await wabaRegistry.getConfigByProfile(access.profileId)
        const { data: configRow, error: configRowError } = await supabase
            .from('waba_configs')
            .select('company_id, business_id, client_business_id, waba_id, business_account_id, phone_number_id, token_source, access_token_expires_at, api_version, enabled')
            .eq('profile_id', access.profileId)
            .maybeSingle()
        const { data: connectionRow, error: connectionRowError } = await supabase
            .from('whatsapp_connections')
            .select('*')
            .eq('company_id', access.companyId)
            .eq('profile_id', access.profileId)
            .order('updated_at', { ascending: false })
            .limit(1)
            .maybeSingle()

        if (configRowError) {
            return res.status(500).json({ success: false, error: configRowError.message })
        }
        if (connectionRowError && !isMissingWhatsappConnectionsTableError(connectionRowError)) {
            return res.status(500).json({ success: false, error: connectionRowError.message })
        }

        const connectedCompanyId = trimText(configRow?.company_id || config?.companyId)
        const connectedWabaId = trimText(config?.wabaId || config?.businessAccountId || configRow?.waba_id || configRow?.business_account_id)
        const connectedBusinessId = trimText(config?.businessId || configRow?.business_id)
        const connectedClientBusinessId = trimText(config?.clientBusinessId || configRow?.client_business_id)
        const connectedPhoneNumberId = trimText(config?.phoneNumberId || configRow?.phone_number_id)
        const connectedTokenSource = trimText(config?.tokenSource || configRow?.token_source)
        const connectedAccessTokenExpiresAt = trimText(config?.accessTokenExpiresAt || configRow?.access_token_expires_at)
        const connectedApiVersion = trimText(config?.apiVersion || configRow?.api_version)

        res.json({
            success: true,
            data: {
                profileId: access.profileId,
                companyId: access.companyId,
                metaAppId: resolveMetaAppIdFromEnv() || null,
                metaGraphVersion: resolveMetaGraphVersionFromEnv('v24.0'),
                embeddedSignupV4ConfigId: resolveMetaEmbeddedSignupV4ConfigIdFromEnv() || null,
                coexistenceConfigId: resolveMetaCoexistenceConfigIdFromEnv() || null,
                existingAppConfigId: resolveMetaExistingAppConfigIdFromEnv() || null,
                officialMetaOnly: isOfficialMetaOnlyMode(),
                apiBasePath: getApiBasePath(),
                connectedCompanyId: connectedCompanyId || null,
                connectedCompanyMismatch: Boolean(connectedCompanyId && connectedCompanyId !== access.companyId),
                businessId: connectedBusinessId || null,
                clientBusinessId: connectedClientBusinessId || null,
                wabaId: connectedWabaId || null,
                phoneNumberId: connectedPhoneNumberId || null,
                phoneNumber: trimText(connectionRow?.phone_number) || null,
                displayName: trimText(connectionRow?.display_name) || null,
                verifiedName: trimText(connectionRow?.verified_name) || null,
                platformType: trimText(connectionRow?.platform_type) || null,
                isOnBizApp: connectionRow?.is_on_biz_app === true ? true : connectionRow?.is_on_biz_app === false ? false : null,
                status: trimText(connectionRow?.status) || null,
                coexistenceEnabled: connectionRow?.coexistence_enabled === true,
                syncStatus: trimText(connectionRow?.sync_status) || null,
                contactsSyncRequestId: trimText(connectionRow?.contacts_sync_request_id) || null,
                historySyncRequestId: trimText(connectionRow?.history_sync_request_id) || null,
                syncStartedAt: trimText(connectionRow?.sync_started_at) || null,
                historySyncProgress: Number.isFinite(Number(connectionRow?.history_sync_progress))
                    ? Math.max(0, Math.min(100, Math.floor(Number(connectionRow.history_sync_progress))))
                    : null,
                messagingPaused: connectionRow?.messaging_paused === true,
                disconnectionReason: trimText(connectionRow?.disconnection_reason) || null,
                disconnectionInitiatedBy: trimText(connectionRow?.disconnection_initiated_by) || null,
                lastAccountUpdateEvent: trimText(connectionRow?.last_account_update_event) || null,
                qualityRating: trimText(connectionRow?.quality_rating) || null,
                tokenSource: connectedTokenSource || null,
                accessTokenExpiresAt: connectedAccessTokenExpiresAt || null,
                apiVersion: connectedApiVersion || null,
                enabled: configRow?.enabled === true
            }
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/waba/registration/company-id', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const companyId = trimText(req.body?.companyId)
        if (!companyId) {
            return res.status(400).json({ success: false, error: 'companyId is required' })
        }

        const isSuperAdmin = isSuperAdminUser(access.user)
        if (!isSuperAdmin && companyId !== access.companyId) {
            return res.status(403).json({
                success: false,
                error: `Company ID must match your account company "${access.companyId}".`
            })
        }

        const { data: existingConfig, error: existingConfigError } = await supabase
            .from('waba_configs')
            .select('profile_id')
            .eq('profile_id', access.profileId)
            .maybeSingle()

        if (existingConfigError) {
            return res.status(500).json({ success: false, error: existingConfigError.message })
        }
        if (!existingConfig?.profile_id) {
            return res.status(404).json({ success: false, error: 'WABA config not found for this profile.' })
        }

        const { error: updateError } = await supabase
            .from('waba_configs')
            .update({ company_id: companyId })
            .eq('profile_id', access.profileId)

        if (updateError) {
            return res.status(500).json({ success: false, error: updateError.message })
        }

        await wabaRegistry.refresh(true)

        return res.json({
            success: true,
            data: {
                profileId: access.profileId,
                companyId
            }
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.get('/api/waba/review/readiness', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const runtimeConfig = await wabaRegistry.getConfigByProfile(access.profileId)
        let { data: configRow, error: configError } = await supabase
            .from('waba_configs')
            .select('enabled, phone_number_id, business_id, client_business_id, waba_id, business_account_id, token_source, access_token_expires_at, token_scopes, connected_at, updated_at')
            .eq('profile_id', access.profileId)
            .maybeSingle()

        if (configError && isMissingWabaConfigsUpdatedAtError(configError)) {
            const fallback = await supabase
                .from('waba_configs')
                .select('enabled, phone_number_id, business_id, client_business_id, waba_id, business_account_id, token_source, access_token_expires_at, token_scopes, connected_at')
                .eq('profile_id', access.profileId)
                .maybeSingle()
            configRow = fallback.data as any
            configError = fallback.error as any
        }

        if (configError) {
            return res.status(500).json({ success: false, error: configError.message })
        }

        const oauthMode = resolveOauthMode(process.env.WABA_EMBEDDED_SIGNUP_CONFIG_ID || '')
        const oauthRedirectUri = resolveOauthRedirectUri(req)
        const oauthReturnUrl = resolveOauthReturnUrl(req)
        const appId = readTrimmed(process.env.WABA_APP_ID || process.env.APP_ID)
        const appSecret = readTrimmed(process.env.WABA_APP_SECRET || process.env.APP_SECRET)
        const verifyToken = readTrimmed(process.env.WABA_VERIFY_TOKEN || process.env.VERIFY_TOKEN)
        const encryptionKeyReady = Boolean(getTokenEncryptionKey())
        const tokenScopes = parseTokenScopes(configRow?.token_scopes)
        const profileWabaId = readTrimmed(runtimeConfig?.wabaId || runtimeConfig?.businessAccountId || configRow?.waba_id || configRow?.business_account_id)
        const profileBusinessId = readTrimmed(runtimeConfig?.businessId || configRow?.business_id)
        const profileClientBusinessId = readTrimmed(runtimeConfig?.clientBusinessId || configRow?.client_business_id)
        const profilePhoneNumberId = readTrimmed(runtimeConfig?.phoneNumberId || configRow?.phone_number_id)
        const tokenSource = readTrimmed(runtimeConfig?.tokenSource || configRow?.token_source)
        const accessTokenExpiresAt = readTrimmed(runtimeConfig?.accessTokenExpiresAt || configRow?.access_token_expires_at)
        const connectedAt = trimText(configRow?.connected_at)
        const updatedAt = trimText(configRow?.updated_at)
        const hasDbConfig = Boolean(configRow)
        const enabled = configRow?.enabled === true

        const prerequisites = [
            {
                key: 'app_id',
                label: 'WABA_APP_ID',
                ok: Boolean(appId),
                detail: appId ? 'Configured' : 'Missing'
            },
            {
                key: 'app_secret',
                label: 'WABA_APP_SECRET',
                ok: Boolean(appSecret),
                detail: appSecret ? 'Configured' : 'Missing'
            },
            {
                key: 'verify_token',
                label: 'WABA_VERIFY_TOKEN',
                ok: Boolean(verifyToken),
                detail: verifyToken ? 'Configured' : 'Missing'
            },
            {
                key: 'token_encryption',
                label: 'WABA_TOKEN_ENCRYPTION_KEY',
                ok: encryptionKeyReady,
                detail: encryptionKeyReady ? 'Configured' : 'Missing'
            },
            {
                key: 'oauth_redirect_uri',
                label: 'OAuth Redirect URI',
                ok: /^https:\/\//i.test(oauthRedirectUri),
                detail: oauthRedirectUri
            },
            {
                key: 'oauth_return_url',
                label: 'OAuth Return URL',
                ok: /^https:\/\//i.test(oauthReturnUrl),
                detail: oauthReturnUrl
            }
        ]

        res.json({
            success: true,
            data: {
                profileId: access.profileId,
                companyId: access.companyId,
                oauth: {
                    mode: oauthMode,
                    configId: readTrimmed(process.env.WABA_EMBEDDED_SIGNUP_CONFIG_ID || '') || null,
                    redirectUri: oauthRedirectUri,
                    returnUrl: oauthReturnUrl
                },
                prerequisites,
                connection: {
                    connected: Boolean(runtimeConfig) && (!hasDbConfig || enabled),
                    runtimeConfigLoaded: Boolean(runtimeConfig),
                    enabled,
                    phoneNumberId: profilePhoneNumberId || null,
                    wabaId: profileWabaId || null,
                    businessId: profileBusinessId || null,
                    clientBusinessId: profileClientBusinessId || null,
                    tokenSource: tokenSource || null,
                    accessTokenExpiresAt: accessTokenExpiresAt || null,
                    tokenScopes,
                    connectedAt: connectedAt || null,
                    updatedAt: updatedAt || null
                }
            }
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error?.message || 'Failed to load review readiness' })
    }
})

app.get('/api/waba/review/businesses', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const config = await wabaRegistry.getConfigByProfile(access.profileId)
        if (!config) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const businesses = await fetchBusinesses(config.accessToken, config.apiVersion)
        res.json({
            success: true,
            data: {
                count: businesses.length,
                items: businesses.slice(0, 50)
            }
        })
    } catch (error: any) {
        const normalized = toHttpErrorPayload(error, 'Failed to fetch businesses for this token')
        res.status(normalized.status).json(normalized.payload)
    }
})

app.post('/api/waba/review/send-test-message', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const rawRecipient = readTrimmed(req.body?.to || req.body?.recipient || req.body?.recipientPhone || req.body?.recipient_phone)
        const normalizedRecipient = normalizePhoneNumber(rawRecipient)
        if (!normalizedRecipient) {
            return res.status(400).json({ success: false, error: 'Recipient phone number is required' })
        }

        const text = readTrimmed(req.body?.text || req.body?.message || req.body?.body) || 'Meta App Review test message from QMessage.'
        if (text.length > 1024) {
            return res.status(400).json({ success: false, error: 'Test message must be 1024 characters or less' })
        }

        const sentAtIso = new Date().toISOString()
        let result: any = null
        let messageId = ''
        let tracked = false
        let trackingNote = 'Message accepted by Graph API. Delivery webhook status is not tracked for this send.'

        const resolvedCompanyId =
            readTrimmed(access.companyId)
            || readTrimmed(await getCompanyIdForProfile(access.profileId))

        if (resolvedCompanyId) {
            const user = await findOrCreateUser(resolvedCompanyId, normalizedRecipient, access.profileId)
            if (user?.id) {
                const sent = await sendWhatsAppMessage({
                    client,
                    userId: user.id,
                    profileId: access.profileId,
                    to: normalizedRecipient,
                    type: 'text',
                    content: { text }
                })
                result = sent?.response || null
                messageId = readTrimmed(sent?.messageId || sent?.response?.messages?.[0]?.id)
                if (messageId) {
                    tracked = true
                    trackingNote = 'Message accepted by Graph API. Delivery/read progression is tracked via webhook status events.'
                }
            }
        }

        if (!messageId) {
            result = await client.sendText(normalizedRecipient, text)
            messageId = readTrimmed(result?.messages?.[0]?.id || result?.message_id)
        }

        res.json({
            success: true,
            data: {
                to: normalizedRecipient,
                text,
                messageId: messageId || null,
                sentAt: sentAtIso,
                tracked,
                delivery: {
                    status: 'accepted',
                    timeline: buildReviewDeliveryTimeline('accepted'),
                    note: trackingNote
                },
                response: result
            }
        })
    } catch (error: any) {
        const normalized = toHttpErrorPayload(error, 'Failed to send review test message')
        res.status(normalized.status).json(normalized.payload)
    }
})

app.get('/api/waba/review/message-status', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const messageId = readTrimmed(req.query?.messageId || req.query?.message_id)
        if (!messageId) {
            return res.status(400).json({ success: false, error: 'messageId is required' })
        }

        const { data: messageRow, error: messageError } = await supabase
            .from('messages')
            .select('id, user_id, created_at, content')
            .eq('content->>message_id', messageId)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()

        if (messageError) {
            return res.status(500).json({ success: false, error: messageError.message })
        }

        if (!messageRow) {
            return res.json({
                success: true,
                data: {
                    messageId,
                    tracked: false,
                    status: 'accepted',
                    timeline: buildReviewDeliveryTimeline('accepted'),
                    checkedAt: new Date().toISOString(),
                    sentAt: null,
                    lastEventAt: null,
                    recipient: null,
                    note: 'Message is accepted by Graph API, but no stored delivery status event is available yet.'
                }
            })
        }

        const resolvedCompanyId =
            readTrimmed(access.companyId)
            || readTrimmed(await getCompanyIdForProfile(access.profileId))

        let userRow: any = null
        if (messageRow.user_id) {
            const { data: fetchedUser, error: userError } = await supabase
                .from('users')
                .select('id, company_id, phone_number')
                .eq('id', messageRow.user_id)
                .maybeSingle()

            if (userError) {
                return res.status(500).json({ success: false, error: userError.message })
            }
            userRow = fetchedUser || null
        }

        if (
            resolvedCompanyId
            && userRow?.company_id
            && readTrimmed(userRow.company_id) !== resolvedCompanyId
        ) {
            return res.status(404).json({ success: false, error: 'Message not found for this company' })
        }

        const content = messageRow?.content && typeof messageRow.content === 'object' ? messageRow.content : {}
        const lastStatusEvent =
            content?.last_status_event && typeof content.last_status_event === 'object'
                ? content.last_status_event
                : null
        const stage = normalizeReviewDeliveryStage(lastStatusEvent?.status || content?.status)
        const recipientParticipantId = readTrimmed(
            lastStatusEvent?.recipient_participant_id
            || lastStatusEvent?.participant_recipient_id
        )

        res.json({
            success: true,
            data: {
                messageId,
                tracked: true,
                status: stage,
                timeline: buildReviewDeliveryTimeline(stage),
                checkedAt: new Date().toISOString(),
                sentAt: readTrimmed(content?.sent_at || messageRow?.created_at) || null,
                lastEventAt: toMetaTimestampIso(lastStatusEvent?.timestamp),
                recipient: readTrimmed(
                    lastStatusEvent?.recipient_id
                    || content?.to
                    || userRow?.phone_number
                ) || null,
                lastStatusEvent: lastStatusEvent
                    ? {
                        status: readTrimmed(lastStatusEvent?.status) || null,
                        timestamp: Number.isFinite(Number(lastStatusEvent?.timestamp)) ? Number(lastStatusEvent.timestamp) : null,
                        timestampIso: toMetaTimestampIso(lastStatusEvent?.timestamp),
                        recipientId: readTrimmed(lastStatusEvent?.recipient_id) || null,
                        recipientType: readTrimmed(lastStatusEvent?.recipient_type) || null,
                        recipientParticipantId: recipientParticipantId || null
                    }
                    : null
            }
        })
    } catch (error: any) {
        const normalized = toHttpErrorPayload(error, 'Failed to load review message status')
        res.status(normalized.status).json(normalized.payload)
    }
})

app.get('/api/waba/registration/phone-numbers', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const wabaId = typeof req.query?.wabaId === 'string' ? req.query.wabaId : undefined
        const data = await client.getPhoneNumbers(wabaId)
        res.json({ success: true, data })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/waba/registration/request-code', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const phoneNumberId = typeof req.body?.phoneNumberId === 'string' ? req.body.phoneNumberId : ''
        const rawMethod = typeof req.body?.codeMethod === 'string' ? req.body.codeMethod : ''
        const codeMethod = rawMethod.toUpperCase()
        const rawLanguage = trimText(req.body?.language ?? req.body?.locale).replace('-', '_')
        let language = rawLanguage || 'en_US'
        if (/^[a-z]{2}$/i.test(language)) {
            language = `en_${language.toUpperCase()}`
        }

        if (!phoneNumberId) {
            return res.status(400).json({ success: false, error: 'phoneNumberId is required' })
        }
        if (codeMethod !== 'SMS' && codeMethod !== 'VOICE') {
            return res.status(400).json({ success: false, error: 'codeMethod must be SMS or VOICE' })
        }
        if (!/^[a-z]{2}_[A-Z]{2}$/.test(language)) {
            return res.status(400).json({
                success: false,
                error: 'language must be in format ll_CC (for example, en_US)'
            })
        }

        const data = await client.requestVerificationCode(phoneNumberId, codeMethod as 'SMS' | 'VOICE', language)
        res.json({ success: true, data })
    } catch (error: any) {
        const normalized = toHttpErrorPayload(error, 'Failed to request verification code')
        res.status(normalized.status).json(normalized.payload)
    }
})

app.post('/api/waba/registration/verify-code', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const phoneNumberId = typeof req.body?.phoneNumberId === 'string' ? req.body.phoneNumberId : ''
        const code = typeof req.body?.code === 'string' ? req.body.code.trim() : ''

        if (!phoneNumberId || !code) {
            return res.status(400).json({ success: false, error: 'phoneNumberId and code are required' })
        }

        const data = await client.verifyPhoneNumberCode(phoneNumberId, code)
        res.json({ success: true, data })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/waba/registration/register', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const phoneNumberId = typeof req.body?.phoneNumberId === 'string' ? req.body.phoneNumberId : ''
        const pin = typeof req.body?.pin === 'string' ? req.body.pin.trim() : ''
        const dataLocalizationRegion = parseDataLocalizationRegion(
            req.body?.dataLocalizationRegion ?? req.body?.data_localization_region
        )
        const rawDataLocalizationRegion = trimText(
            req.body?.dataLocalizationRegion ?? req.body?.data_localization_region
        ).toUpperCase()

        if (!phoneNumberId || !pin) {
            return res.status(400).json({ success: false, error: 'phoneNumberId and pin are required' })
        }
        if (!/^\d{6}$/.test(pin)) {
            return res.status(400).json({ success: false, error: 'pin must be 6 digits' })
        }
        if (rawDataLocalizationRegion && !dataLocalizationRegion) {
            return res.status(400).json({
                success: false,
                error: 'dataLocalizationRegion must be one of: AU, ID, IN, JP, SG, KR, DE, CH, GB, BR, BH, ZA, AE, CA'
            })
        }

        const data = await client.registerPhoneNumber(phoneNumberId, pin, {
            ...(dataLocalizationRegion ? { dataLocalizationRegion } : {})
        })
        res.json({ success: true, data })
    } catch (error: any) {
        const normalized = toHttpErrorPayload(error, 'Failed to register phone number')
        res.status(normalized.status).json(normalized.payload)
    }
})

app.post('/api/waba/registration/deregister', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const phoneNumberId = typeof req.body?.phoneNumberId === 'string' ? req.body.phoneNumberId.trim() : ''
        if (!phoneNumberId) {
            return res.status(400).json({ success: false, error: 'phoneNumberId is required' })
        }

        const data = await client.deregisterPhoneNumber(phoneNumberId)
        res.json({ success: true, data })
    } catch (error: any) {
        const normalized = toHttpErrorPayload(error, 'Failed to deregister phone number')
        res.status(normalized.status).json(normalized.payload)
    }
})

app.post('/api/waba/registration/remove-phone-number', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const admin = await isAdminUser(access.user.id, access.companyId)
        if (!admin) {
            return res.status(403).json({ success: false, error: 'Admin access required' })
        }

        const mode = normalizeMetaPhoneRemovalMode(req.body?.mode)
        const suppliedPhoneNumberId = trimText(req.body?.phoneNumberId || req.body?.phone_number_id)
        const suppliedWabaId = trimText(req.body?.wabaId || req.body?.waba_id)
        const suppliedToken = trimText(req.body?.accessToken || req.body?.access_token)
        const suppliedApiVersion = trimText(req.body?.apiVersion || req.body?.api_version)
        const shouldDisableLocal = req.body?.disableLocal !== false

        const config = await wabaRegistry.getConfigByProfile(access.profileId)
        const phoneNumberId = suppliedPhoneNumberId || trimText(config?.phoneNumberId)
        const wabaId = suppliedWabaId || trimText(config?.wabaId || config?.businessAccountId)
        const accessToken = suppliedToken || trimText(config?.accessToken)
        const apiVersion = normalizeGraphApiVersion(
            suppliedApiVersion || config?.apiVersion,
            process.env.WABA_API_VERSION || 'v19.0'
        )

        if (!phoneNumberId) {
            return res.status(400).json({ success: false, error: 'phoneNumberId is required' })
        }
        if ((mode === 'graph-delete' || mode === 'legacy-delete') && !wabaId) {
            return res.status(400).json({ success: false, error: 'wabaId is required for DELETE removal modes' })
        }
        if (!accessToken) {
            return res.status(400).json({ success: false, error: 'A saved WABA token or accessToken override is required' })
        }

        const result = await requestMetaPhoneNumberRemoval({
            mode,
            apiVersion,
            accessToken,
            wabaId,
            phoneNumberId
        })

        let localDisabled = false
        if (shouldDisableLocal && config?.phoneNumberId === phoneNumberId) {
            const { error: updateError } = await supabase
                .from('waba_configs')
                .update({ enabled: false })
                .eq('profile_id', access.profileId)

            if (updateError) {
                return res.status(500).json({
                    success: false,
                    error: updateError.message,
                    meta: {
                        mode,
                        method: result.method,
                        path: result.path,
                        data: result.data
                    }
                })
            }

            localDisabled = true
            await wabaRegistry.refresh(true)
        }

        res.json({
            success: true,
            data: {
                mode,
                method: result.method,
                path: result.path,
                localDisabled,
                response: result.data
            }
        })
    } catch (error: any) {
        const normalized = toHttpErrorPayload(error, 'Failed to remove phone number from Meta')
        res.status(normalized.status).json(normalized.payload)
    }
})

app.post('/api/waba/registration/profile', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const phoneNumberId = typeof req.body?.phoneNumberId === 'string' ? req.body.phoneNumberId : ''
        const profile = req.body?.profile

        if (!phoneNumberId || !profile || typeof profile !== 'object') {
            return res.status(400).json({ success: false, error: 'phoneNumberId and profile object are required' })
        }

        const data = await client.updateBusinessProfile(phoneNumberId, profile)
        res.json({ success: true, data })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.get('/api/waba/business-profile', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const config = await wabaRegistry.getConfigByProfile(access.profileId)
        const queryPhoneNumberId = readTrimmed(req.query?.phoneNumberId || req.query?.phone_number_id)
        const phoneNumberId = queryPhoneNumberId || readTrimmed(config?.phoneNumberId)
        if (!phoneNumberId) {
            return res.status(400).json({ success: false, error: 'phoneNumberId is required (or must exist in profile config)' })
        }

        const rawFields = readTrimmed(req.query?.fields)
        const fields = rawFields
            ? rawFields.split(',').map((entry) => readTrimmed(entry)).filter(Boolean)
            : ['about', 'address', 'description', 'email', 'profile_picture_url', 'websites', 'vertical']

        const data = await client.getBusinessProfile(phoneNumberId, fields)
        res.json({ success: true, data })
    } catch (error: any) {
        const normalized = toHttpErrorPayload(error, 'Failed to load business profile')
        res.status(normalized.status).json(normalized.payload)
    }
})

app.post('/api/waba/business-profile', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const config = await wabaRegistry.getConfigByProfile(access.profileId)
        const bodyPhoneNumberId = readTrimmed(req.body?.phoneNumberId || req.body?.phone_number_id)
        const phoneNumberId = bodyPhoneNumberId || readTrimmed(config?.phoneNumberId)
        if (!phoneNumberId) {
            return res.status(400).json({ success: false, error: 'phoneNumberId is required (or must exist in profile config)' })
        }

        const baseProfile =
            req.body?.profile && typeof req.body.profile === 'object'
                ? { ...req.body.profile }
                : { ...req.body }

        delete (baseProfile as any).phoneNumberId
        delete (baseProfile as any).phone_number_id
        delete (baseProfile as any).profile
        delete (baseProfile as any).profileId

        const websitesRaw = baseProfile.websites
        if (typeof websitesRaw === 'string') {
            const trimmed = websitesRaw.trim()
            if (!trimmed) {
                delete baseProfile.websites
            } else {
                try {
                    const parsed = JSON.parse(trimmed)
                    if (Array.isArray(parsed)) {
                        baseProfile.websites = parsed
                            .map((item) => readTrimmed(item))
                            .filter(Boolean)
                    } else {
                        baseProfile.websites = trimmed
                            .split(/[\n,;]+/)
                            .map((item) => readTrimmed(item))
                            .filter(Boolean)
                    }
                } catch {
                    baseProfile.websites = trimmed
                        .split(/[\n,;]+/)
                        .map((item) => readTrimmed(item))
                        .filter(Boolean)
                }
            }
        } else if (Array.isArray(websitesRaw)) {
            baseProfile.websites = websitesRaw
                .map((item) => readTrimmed(item))
                .filter(Boolean)
        }

        if (!baseProfile || typeof baseProfile !== 'object' || Object.keys(baseProfile).length === 0) {
            return res.status(400).json({ success: false, error: 'Profile payload is required.' })
        }

        const data = await client.updateBusinessProfile(phoneNumberId, baseProfile)
        res.json({ success: true, data })
    } catch (error: any) {
        const normalized = toHttpErrorPayload(error, 'Failed to update business profile')
        res.status(normalized.status).json(normalized.payload)
    }
})

    const loadCallClientContext = async (access: any, reqOrBody: any, location: 'query' | 'body' = 'query') => {
        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            const error: any = new Error('WABA not configured for this profile.')
            error.status = 503
            throw error
        }

        const config = await wabaRegistry.getConfigByProfile(access.profileId)
        const source = location === 'body' ? reqOrBody?.body : reqOrBody?.query
        const phoneNumberId = readTrimmed(source?.phoneNumberId || source?.phone_number_id) || readTrimmed(config?.phoneNumberId)
        if (!phoneNumberId) {
            const error: any = new Error('phoneNumberId is required (or must exist in profile config)')
            error.status = 400
            throw error
        }

        return { client, config, phoneNumberId }
    }

    const buildPermissionRequiredPayload = () => ({
        success: false,
        error: 'CALL_PERMISSION_REQUIRED',
        details: ['Customer has not granted permission to receive WhatsApp calls.']
    })

    const shapeVersionedWhatsappCall = (row: any) => {
        if (!row) return null
        return {
            id: readTrimmed(row?.id) || null,
            call_id: readTrimmed(row?.call_id) || null,
            profile_id: readTrimmed(row?.profile_id) || null,
            company_id: readTrimmed(row?.company_id) || null,
            phone_number_id: readTrimmed(row?.phone_number_id) || null,
            customer_id: readTrimmed(row?.customer_wa_id) || null,
            customer_name: readTrimmed(row?.customer_name) || null,
            business_wa_id: readTrimmed(row?.business_wa_id) || null,
            direction: readTrimmed(row?.direction) || null,
            event: readTrimmed(row?.event) || null,
            status: readTrimmed(row?.status) || null,
            session: row?.session_sdp_type && row?.session_sdp
                ? {
                    sdp_type: row.session_sdp_type,
                    sdp: row.session_sdp
                }
                : null,
            start_time: readTrimmed(row?.start_time) || null,
            end_time: readTrimmed(row?.end_time) || null,
            duration_seconds: Number.isFinite(Number(row?.duration_seconds)) ? Number(row.duration_seconds) : null,
            deeplink_payload: readTrimmed(row?.deeplink_payload) || null,
            cta_payload: readTrimmed(row?.cta_payload) || null,
            biz_opaque_callback_data: readTrimmed(row?.biz_opaque_callback_data) || null,
            accepted_by_user_id: readTrimmed(row?.accepted_by_user_id) || null,
            accepted_by_name: readTrimmed(row?.accepted_by_name) || null,
            accepted_at: readTrimmed(row?.accepted_at) || null,
            claim_expires_at: readTrimmed(row?.claim_expires_at) || null,
            last_action: readTrimmed(row?.last_action) || null,
            last_action_at: readTrimmed(row?.last_action_at) || null,
            last_event_at: readTrimmed(row?.last_event_at) || null,
            created_at: readTrimmed(row?.created_at) || null,
            updated_at: readTrimmed(row?.updated_at) || null,
            status_history: Array.isArray(row?.status_history) ? row.status_history : [],
            meta_response: row?.meta_response ?? null,
            meta_error: row?.meta_error ?? null
        }
    }

    const performCallAction = async (params: {
        access: any
        action: 'connect' | 'pre_accept' | 'accept' | 'reject' | 'terminate'
        phoneNumberId?: string
        callId?: string
        userWaId?: string
        session?: { sdp_type: 'offer' | 'answer'; sdp: string } | undefined
        bizOpaqueCallbackData?: string | undefined
        acceptLockToken?: string | undefined
    }) => {
        const client = await wabaRegistry.getClientByProfile(params.access.profileId)
        if (!client) {
            const error: any = new Error('WABA not configured for this profile.')
            error.status = 503
            throw error
        }

        const config = await wabaRegistry.getConfigByProfile(params.access.profileId)
        const phoneNumberId = readTrimmed(params.phoneNumberId || config?.phoneNumberId)
        if (!phoneNumberId) {
            const error: any = new Error('phoneNumberId is required (or must exist in profile config)')
            error.status = 400
            throw error
        }

        const timestampIso = new Date().toISOString()
        const callId = readTrimmed(params.callId)
        const userWaId = readTrimmed(params.userWaId)
        const actor = buildVersionedActorFromUser(params.access.user)
        const actorUserId = trimText(actor.user_id)
        const actorName = trimText(actor.name) || 'Team Member'
        let acceptLockToken = readTrimmed(params.acceptLockToken)
        let currentCall: any = null
        let claimExpiresAt: string | null = null

        if (params.action === 'connect') {
            if (!userWaId) {
                const error: any = new Error('to (or user_wa_id) is required for connect action')
                error.status = 400
                throw error
            }
            const permissionData = await client.getCallPermissions(userWaId, phoneNumberId)
            const summary = extractCallPermissionSummary(permissionData)
            const storedPermission = await getStoredWhatsappCallPermission(supabase, {
                phoneNumberId,
                customerWaId: userWaId
            })
            const hasPermission = summary.canStartCall || isStoredCallPermissionCurrentlyApproved(storedPermission)
            if (!hasPermission) {
                const error: any = new Error('Customer has not granted permission to receive WhatsApp calls.')
                error.status = 409
                error.payload = buildPermissionRequiredPayload()
                throw error
            }
        }

        if ((params.action === 'reject' || params.action === 'terminate' || params.action === 'pre_accept' || params.action === 'accept') && !callId) {
            const error: any = new Error(`call_id is required for ${params.action} action`)
            error.status = 400
            throw error
        }

        if (callId) {
            currentCall = await getStoredWhatsappCall(supabase, {
                companyId: params.access.companyId,
                profileId: params.access.profileId,
                phoneNumberId,
                callId
            })
            if (!currentCall) {
                throw createCallNotFoundError()
            }
        }

        const currentStatus = normalizeCallStatusLabel(currentCall?.status)
        const currentAcceptedByUserId = trimText(currentCall?.accepted_by_user_id)
        const currentAcceptLockToken = trimText(currentCall?.accept_lock_token)
        const isActorAdmin =
            params.action === 'connect'
                ? true
                : await isAdminUser(params.access.user.id, params.access.companyId || undefined)

        if (params.action === 'pre_accept') {
            if (CALL_TERMINAL_STATUSES.has(currentStatus)) {
                throw createCallStateConflictError(currentCall)
            }
            if (CALL_OWNER_STATUSES.has(currentStatus)) {
                throw createCallAlreadyAnsweredError(currentCall)
            }

            acceptLockToken = randomBytes(18).toString('hex')
            claimExpiresAt = new Date(Date.now() + CALL_ACCEPT_LOCK_TTL_MS).toISOString()
            const claimedCall = await claimWhatsappCallAcceptLock(supabase, {
                companyId: params.access.companyId,
                profileId: params.access.profileId,
                phoneNumberId,
                callId,
                acceptedByUserId: actorUserId,
                acceptedByName: actorName,
                acceptedAt: timestampIso,
                claimExpiresAt,
                acceptLockToken,
                historyEntry: {
                    source: 'lock',
                    action: 'claim_accept',
                    status: 'accepting',
                    accepted_by_user_id: actorUserId,
                    accepted_by_name: actorName,
                    recorded_at: timestampIso
                }
            })

            if (!claimedCall) {
                currentCall = await getStoredWhatsappCall(supabase, {
                    companyId: params.access.companyId,
                    profileId: params.access.profileId,
                    phoneNumberId,
                    callId
                })
                if (CALL_OWNER_STATUSES.has(normalizeCallStatusLabel(currentCall?.status))) {
                    throw createCallAlreadyAnsweredError(currentCall)
                }
                throw createCallStateConflictError(currentCall)
            }

            currentCall = claimedCall
            broadcastStoredCallRealtimeUpdate({
                access: params.access,
                row: currentCall,
                event: 'pre_accept',
                normalizedStatus: 'accepting'
            })
        }

        if (params.action === 'accept') {
            if (!acceptLockToken) {
                throw createCallLockRequiredError()
            }
            const isOwner =
                currentAcceptedByUserId === actorUserId
                && currentAcceptLockToken
                && currentAcceptLockToken === acceptLockToken

            if (!isOwner) {
                if (CALL_OWNER_STATUSES.has(currentStatus)) {
                    throw createCallAlreadyAnsweredError(currentCall)
                }
                throw createCallStateConflictError(currentCall)
            }

            if (currentStatus === 'accepted' || currentStatus === 'answered') {
                return {
                    response: currentCall?.meta_response ?? {
                        deduplicated: true,
                        call_id: callId
                    },
                    call_id: callId,
                    stored_call: currentCall,
                    accept_lock_token: acceptLockToken
                }
            }

            if (currentStatus !== 'accepting') {
                throw createCallStateConflictError(currentCall)
            }
        }

        if (params.action === 'reject') {
            if (CALL_TERMINAL_STATUSES.has(currentStatus)) {
                return {
                    response: currentCall?.meta_response ?? null,
                    call_id: callId,
                    stored_call: currentCall
                }
            }
            if (CALL_OWNER_STATUSES.has(currentStatus) && currentAcceptedByUserId && currentAcceptedByUserId !== actorUserId && !isActorAdmin) {
                throw createCallOwnershipForbiddenError('This call is already being handled by another team member.', currentCall)
            }
        }

        if (params.action === 'terminate') {
            if (currentStatus === 'terminated') {
                return {
                    response: currentCall?.meta_response ?? null,
                    call_id: callId,
                    stored_call: currentCall
                }
            }
            if (currentAcceptedByUserId) {
                if (currentAcceptedByUserId !== actorUserId && !isActorAdmin) {
                    throw createCallOwnershipForbiddenError('Only the person handling this call, or an admin, can terminate it.', currentCall)
                }
            } else if (!isActorAdmin) {
                throw createVersionedCallError(
                    'CALL_TERMINATE_FORBIDDEN',
                    'Only an admin can terminate a call before it has been claimed.',
                    403
                )
            }
        }

        let response: any
        try {
            response = await client.manageCall({
                action: params.action,
                to: userWaId || undefined,
                call_id: callId || undefined,
                session: params.session,
                biz_opaque_callback_data: params.bizOpaqueCallbackData
            }, phoneNumberId)
        } catch (error: any) {
            if (params.action === 'pre_accept' || params.action === 'accept') {
                const failedCall = await upsertWhatsappCall(supabase, {
                    companyId: params.access.companyId,
                    profileId: params.access.profileId,
                    phoneNumberId,
                    wabaId: readTrimmed(config?.wabaId || config?.businessAccountId) || null,
                    callId: callId || '',
                    customerWaId: trimText(currentCall?.customer_wa_id) || null,
                    customerName: trimText(currentCall?.customer_name) || null,
                    businessWaId: trimText(currentCall?.business_wa_id) || null,
                    direction: trimText(currentCall?.direction) || null,
                    event: params.action,
                    status: 'failed',
                    historyEntry: {
                        source: 'action',
                        action: params.action,
                        status: 'failed',
                        error: trimText(error?.message) || 'Failed to manage call action',
                        recorded_at: timestampIso
                    },
                    metaError: error?.response || { message: error?.message || 'Failed to manage call action' },
                    lastAction: params.action,
                    lastActionAt: timestampIso,
                    lastEventAt: timestampIso,
                    acceptedByUserId: currentAcceptedByUserId || actorUserId || null,
                    acceptedByName: trimText(currentCall?.accepted_by_name) || actorName,
                    acceptedAt: trimText(currentCall?.accepted_at) || timestampIso,
                    claimExpiresAt: null,
                    acceptLockToken: acceptLockToken || currentAcceptLockToken || null
                })

                if (failedCall) {
                    broadcastStoredCallRealtimeUpdate({
                        access: params.access,
                        row: failedCall,
                        event: params.action,
                        normalizedStatus: 'failed'
                    })
                }
            }
            throw error
        }

        const responseCallId = readTrimmed(response?.call_id || response?.callId || response?.id)
        const persistedCallId =
            callId
            || responseCallId
            || `${params.action === 'connect' ? (userWaId || phoneNumberId) : phoneNumberId}:${Date.now()}`

        const nextStatus =
            params.action === 'pre_accept'
                ? 'accepting'
                : params.action === 'accept'
                    ? 'accepted'
                    : params.action === 'reject'
                        ? 'rejected'
                        : params.action === 'terminate'
                            ? 'terminated'
                            : 'ringing'

        const shouldPersistSession = params.action === 'connect'

        const storedCall = await upsertWhatsappCall(supabase, {
            companyId: params.access.companyId,
            profileId: params.access.profileId,
            phoneNumberId,
            wabaId: readTrimmed(config?.wabaId || config?.businessAccountId) || null,
            callId: persistedCallId,
            customerWaId: userWaId || trimText(currentCall?.customer_wa_id) || null,
            customerName: trimText(currentCall?.customer_name) || null,
            businessWaId: trimText(currentCall?.business_wa_id) || null,
            direction: params.action === 'connect'
                ? 'outbound'
                : (trimText(currentCall?.direction) || (params.action === 'terminate' ? null : 'inbound')),
            event: params.action,
            status: nextStatus,
            historyEntry: {
                source: 'action',
                action: params.action,
                status: nextStatus,
                recorded_at: timestampIso
            },
            sessionSdpType: shouldPersistSession ? (params.session?.sdp_type || null) : null,
            sessionSdp: shouldPersistSession ? (params.session?.sdp || null) : null,
            metaResponse: response,
            metaError: null,
            lastAction: params.action,
            lastActionAt: timestampIso,
            lastEventAt: timestampIso,
            acceptedByUserId:
                params.action === 'pre_accept' || params.action === 'accept'
                    ? actorUserId
                    : undefined,
            acceptedByName:
                params.action === 'pre_accept' || params.action === 'accept'
                    ? actorName
                    : undefined,
            acceptedAt:
                params.action === 'pre_accept'
                    ? timestampIso
                    : (params.action === 'accept'
                        ? (trimText(currentCall?.accepted_at) || timestampIso)
                        : undefined),
            claimExpiresAt:
                params.action === 'pre_accept'
                    ? claimExpiresAt
                    : (params.action === 'accept'
                        ? null
                        : undefined),
            acceptLockToken:
                params.action === 'pre_accept' || params.action === 'accept'
                    ? acceptLockToken || null
                    : undefined
        })

        if (storedCall && params.action !== 'connect' && params.action !== 'pre_accept') {
            broadcastStoredCallRealtimeUpdate({
                access: params.access,
                row: storedCall,
                event: params.action,
                normalizedStatus: nextStatus
            })
        }

        return {
            response,
            call_id: persistedCallId,
            stored_call: storedCall || null,
            ...(acceptLockToken ? { accept_lock_token: acceptLockToken } : {})
        }
    }

app.get('/api/waba/call-settings', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const { client, phoneNumberId } = await loadCallClientContext(access, req, 'query')

        const includeSipRaw = readTrimmed(req.query?.include_sip_credentials || req.query?.includeSipCredentials).toLowerCase()
        const includeSipCredentials = includeSipRaw === '1' || includeSipRaw === 'true' || includeSipRaw === 'yes'

        const data = await client.getPhoneNumberSettings(phoneNumberId, {
            includeSipCredentials
        })

        res.json({ success: true, data })
    } catch (error: any) {
        const normalized = toHttpErrorPayload(error, 'Failed to load call settings')
        res.status(normalized.status).json(normalized.payload)
    }
})

app.post('/api/waba/call-settings', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const { client, phoneNumberId } = await loadCallClientContext(access, req, 'body')

        const rawSettings = req.body?.settings && typeof req.body.settings === 'object'
            ? req.body.settings
            : req.body
        const hasCallingPayload =
            rawSettings
            && typeof rawSettings === 'object'
            && !Array.isArray(rawSettings)
            && rawSettings.calling
            && typeof rawSettings.calling === 'object'
            && !Array.isArray(rawSettings.calling)

        if (!hasCallingPayload) {
            return res.status(400).json({
                success: false,
                error: 'calling object is required. Example: { "calling": { "status": "ENABLED" } }'
            })
        }

        const payload = {
            calling: rawSettings.calling
        }

        const data = await client.updatePhoneNumberSettings(phoneNumberId, payload)
        res.json({ success: true, data })
    } catch (error: any) {
        const normalized = toHttpErrorPayload(error, 'Failed to update call settings')
        res.status(normalized.status).json(normalized.payload)
    }
})

app.get('/api/waba/templates', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const config = await wabaRegistry.getConfigByProfile(access.profileId)
        const wabaId = config?.wabaId || config?.businessAccountId
        if (!wabaId) {
            return res.status(400).json({ success: false, error: 'WABA ID missing in config for this profile.' })
        }

        const rawFields = req.query?.fields
        const rawStatus = req.query?.status
        const rawCategory = req.query?.category
        const rawName = req.query?.name
        const rawLimit = req.query?.limit
        const rawAfter = req.query?.after
        const rawBefore = req.query?.before

        const fields = Array.isArray(rawFields) ? rawFields.join(',') : readTrimmed(rawFields)
        const status = Array.isArray(rawStatus) ? readTrimmed(rawStatus[0]) : readTrimmed(rawStatus)
        const category = Array.isArray(rawCategory) ? readTrimmed(rawCategory[0]) : readTrimmed(rawCategory)
        const name = Array.isArray(rawName) ? readTrimmed(rawName[0]) : readTrimmed(rawName)
        const after = Array.isArray(rawAfter) ? readTrimmed(rawAfter[0]) : readTrimmed(rawAfter)
        const before = Array.isArray(rawBefore) ? readTrimmed(rawBefore[0]) : readTrimmed(rawBefore)
        const parsedLimit = Number(rawLimit)

        const data = await client.listMessageTemplates(wabaId, {
            fields: fields || ['id', 'name', 'status', 'category', 'language', 'quality_score', 'rejected_reason', 'created_time'],
            limit: Number.isFinite(parsedLimit) ? parsedLimit : 50,
            status: status || undefined,
            category: category || undefined,
            name: name || undefined,
            after: after || undefined,
            before: before || undefined
        })

        res.json({ success: true, data })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/waba/templates/utility', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const config = await wabaRegistry.getConfigByProfile(access.profileId)
        const wabaId = config?.wabaId || config?.businessAccountId
        if (!wabaId) {
            return res.status(400).json({ success: false, error: 'WABA ID missing in config for this profile.' })
        }

        const { payload, errors } = validateUtilityTemplateInput(req.body || {})
        if (errors.length > 0 || !payload) {
            return res.status(400).json({ success: false, error: 'Invalid utility template payload', details: errors })
        }

        const data = await client.createMessageTemplate(wabaId, payload)
        res.json({ success: true, data })
    } catch (error: any) {
        const normalized = toHttpErrorPayload(error, 'Failed to create utility template')
        if (normalized.status >= 500) {
            console.error('[WABA] Utility template creation failed:', error)
        }
        res.status(normalized.status).json(normalized.payload)
    }
})

app.post('/api/waba/templates/marketing', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const config = await wabaRegistry.getConfigByProfile(access.profileId)
        const wabaId = config?.wabaId || config?.businessAccountId
        if (!wabaId) {
            return res.status(400).json({ success: false, error: 'WABA ID missing in config for this profile.' })
        }

        const { payload, errors } = validateMarketingTemplateInput(req.body || {})
        if (errors.length > 0 || !payload) {
            return res.status(400).json({ success: false, error: 'Invalid marketing template payload', details: errors })
        }

        const data = await client.createMessageTemplate(wabaId, payload)
        res.json({ success: true, data })
    } catch (error: any) {
        const normalized = toHttpErrorPayload(error, 'Failed to create marketing template')
        if (normalized.status >= 500) {
            console.error('[WABA] Marketing template creation failed:', error)
        }
        res.status(normalized.status).json(normalized.payload)
    }
})

app.post('/api/waba/template-media/upload-handle', express.raw({ type: () => true, limit: '100mb' }), async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const config = await wabaRegistry.getConfigByProfile(access.profileId)
        if (!config) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const appId = readTrimmed(config.appId || process.env.WABA_APP_ID || process.env.APP_ID)
        if (!appId) {
            return res.status(500).json({ success: false, error: 'Missing WABA_APP_ID/APP_ID for resumable uploads.' })
        }

        const rawFileName = req.headers?.['x-file-name']
        const rawFileType = req.headers?.['x-file-type']
        const fileName = Array.isArray(rawFileName) ? readTrimmed(rawFileName[0]) : readTrimmed(rawFileName)
        const fileType = Array.isArray(rawFileType) ? readTrimmed(rawFileType[0]) : readTrimmed(rawFileType)
        const fileBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '')

        if (!fileBuffer || fileBuffer.byteLength === 0) {
            return res.status(400).json({ success: false, error: 'File body is required (binary).' })
        }

        const mediaKind = readTrimmed(req.query?.kind || '').toLowerCase()
        if (mediaKind === 'image' && fileType && !fileType.startsWith('image/')) {
            return res.status(400).json({ success: false, error: 'Please upload an image file.' })
        }
        if (mediaKind === 'video' && fileType && !fileType.startsWith('video/')) {
            return res.status(400).json({ success: false, error: 'Please upload a video file.' })
        }

        const { sessionId, headerHandle } = await createTemplateMediaHeaderHandle({
            accessToken: config.accessToken,
            appId,
            apiVersion: config.apiVersion || process.env.WABA_API_VERSION || 'v23.0',
            fileName: fileName || `template_asset_${Date.now()}`,
            fileType: fileType || 'application/octet-stream',
            fileBuffer
        })

        res.json({
            success: true,
            data: {
                sessionId,
                headerHandle,
                fileName: fileName || null,
                fileType: fileType || null,
                size: fileBuffer.byteLength
            }
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

// Upload binary media to WhatsApp media store (/PHONE_NUMBER_ID/media).
app.post('/api/waba/media/upload', express.raw({ type: () => true, limit: '100mb' }), async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        let phoneNumberId = readTrimmed(req.query?.phoneNumberId || req.query?.phone_number_id)
        let messagingProduct = readTrimmed(req.query?.messaging_product || req.query?.messagingProduct) || 'whatsapp'
        let fileName = ''
        let fileType = ''
        let fileBuffer: Buffer | null = null

        const contentTypeRaw = Array.isArray(req.headers?.['content-type'])
            ? req.headers?.['content-type'][0]
            : req.headers?.['content-type']
        const contentType = readTrimmed(contentTypeRaw).toLowerCase()
        const rawBodyBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '')

        if (!Buffer.isBuffer(req.body) && req.body && typeof req.body === 'object') {
            const jsonBody = req.body
            const rawFile = readTrimmed(jsonBody?.file || jsonBody?.file_base64 || jsonBody?.base64)
            if (rawFile) {
                const cleanedBase64 = rawFile.includes(',') ? rawFile.split(',').pop() || '' : rawFile
                fileBuffer = Buffer.from(cleanedBase64, 'base64')
                fileName = readTrimmed(jsonBody?.fileName || jsonBody?.filename)
                fileType = readTrimmed(jsonBody?.fileType || jsonBody?.mimeType || jsonBody?.mime_type)
                messagingProduct = readTrimmed(jsonBody?.messaging_product || jsonBody?.messagingProduct) || messagingProduct
                phoneNumberId = readTrimmed(jsonBody?.phoneNumberId || jsonBody?.phone_number_id) || phoneNumberId
            }
        } else if (contentType.includes('multipart/form-data')) {
            const parserRequest = new Request('http://localhost/api/waba/media/upload', {
                method: 'POST',
                headers: {
                    'content-type': contentTypeRaw as string
                },
                body: rawBodyBuffer
            })
            const form = await parserRequest.formData()
            const filePart: any = form.get('file')
            if (filePart && typeof filePart.arrayBuffer === 'function') {
                const arrayBuffer = await filePart.arrayBuffer()
                fileBuffer = Buffer.from(arrayBuffer)
                fileName = readTrimmed(filePart?.name)
                fileType = readTrimmed(filePart?.type)
            }
            const productValue = form.get('messaging_product')
            if (typeof productValue === 'string' && readTrimmed(productValue)) {
                messagingProduct = readTrimmed(productValue)
            }
            const formPhoneNumberId = form.get('phone_number_id') || form.get('phoneNumberId')
            if (typeof formPhoneNumberId === 'string' && readTrimmed(formPhoneNumberId)) {
                phoneNumberId = readTrimmed(formPhoneNumberId)
            }
        } else {
            const rawFileName = req.headers?.['x-file-name']
            const rawFileType = req.headers?.['x-file-type']
            const rawMessagingProduct = req.headers?.['x-messaging-product']
            const rawPhoneNumberId = req.headers?.['x-phone-number-id']
            fileName = Array.isArray(rawFileName) ? readTrimmed(rawFileName[0]) : readTrimmed(rawFileName)
            fileType = Array.isArray(rawFileType) ? readTrimmed(rawFileType[0]) : readTrimmed(rawFileType)
            if (Array.isArray(rawMessagingProduct) ? readTrimmed(rawMessagingProduct[0]) : readTrimmed(rawMessagingProduct)) {
                messagingProduct = Array.isArray(rawMessagingProduct) ? readTrimmed(rawMessagingProduct[0]) : readTrimmed(rawMessagingProduct)
            }
            if (Array.isArray(rawPhoneNumberId) ? readTrimmed(rawPhoneNumberId[0]) : readTrimmed(rawPhoneNumberId)) {
                phoneNumberId = Array.isArray(rawPhoneNumberId) ? readTrimmed(rawPhoneNumberId[0]) : readTrimmed(rawPhoneNumberId)
            }
            fileBuffer = rawBodyBuffer
            if (!fileType) {
                fileType = contentType || 'application/octet-stream'
            }
        }

        if (!fileBuffer || fileBuffer.byteLength === 0) {
            return res.status(400).json({ success: false, error: 'file is required (multipart file, raw body, or base64 in JSON).' })
        }

        if (!fileName) {
            fileName = `media_${Date.now()}`
        }
        if (!fileType) {
            fileType = 'application/octet-stream'
        }

        const data = await client.uploadMedia({
            fileBuffer,
            fileName,
            fileType,
            messagingProduct,
            phoneNumberId: phoneNumberId || undefined
        })

        res.json({
            success: true,
            data,
            meta: {
                fileName,
                fileType,
                size: fileBuffer.byteLength
            }
        })
    } catch (error: any) {
        const normalized = toHttpErrorPayload(error, 'Failed to upload media')
        res.status(normalized.status).json(normalized.payload)
    }
})

app.get('/api/waba/templates/authentication/previews', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const config = await wabaRegistry.getConfigByProfile(access.profileId)
        const wabaId = config?.wabaId || config?.businessAccountId
        if (!wabaId) {
            return res.status(400).json({ success: false, error: 'WABA ID missing in config for this profile.' })
        }

        const { options, errors } = parseAuthenticationPreviewOptions(req.query || {})
        if (errors.length > 0) {
            return res.status(400).json({ success: false, error: 'Invalid authentication preview query', details: errors })
        }

        const data = await client.getAuthenticationTemplatePreviews(wabaId, options)
        res.json({ success: true, data })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/waba/templates/authentication', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const config = await wabaRegistry.getConfigByProfile(access.profileId)
        const wabaId = config?.wabaId || config?.businessAccountId
        if (!wabaId) {
            return res.status(400).json({ success: false, error: 'WABA ID missing in config for this profile.' })
        }

        const { payload, errors } = validateAuthenticationTemplateInput(req.body || {})
        if (errors.length > 0 || !payload) {
            return res.status(400).json({ success: false, error: 'Invalid authentication template payload', details: errors })
        }

        const data = await client.createMessageTemplate(wabaId, payload)
        res.json({ success: true, data })
    } catch (error: any) {
        const normalized = toHttpErrorPayload(error, 'Failed to create authentication template')
        if (normalized.status >= 500) {
            console.error('[WABA] Authentication template creation failed:', error)
        }
        res.status(normalized.status).json(normalized.payload)
    }
})

app.post('/api/waba/templates/authentication/upsert', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const config = await wabaRegistry.getConfigByProfile(access.profileId)
        const wabaId = config?.wabaId || config?.businessAccountId
        if (!wabaId) {
            return res.status(400).json({ success: false, error: 'WABA ID missing in config for this profile.' })
        }

        const { payload, errors } = validateAuthenticationUpsertInput(req.body || {})
        if (errors.length > 0 || !payload) {
            return res.status(400).json({ success: false, error: 'Invalid authentication upsert payload', details: errors })
        }

        const data = await client.upsertMessageTemplates(wabaId, payload)
        res.json({ success: true, data })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.get('/api/waba/templates/:templateId/status', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const templateId = readTrimmed(req.params?.templateId)
        if (!templateId) {
            return res.status(400).json({ success: false, error: 'templateId is required' })
        }

        const data = await client.getMessageTemplate(templateId, [
            'id',
            'name',
            'status',
            'category',
            'language',
            'quality_score'
        ])
        res.json({ success: true, data })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/waba/templates/authentication/send', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const name = readTrimmed(req.body?.name)
        const language = readTrimmed(req.body?.language) || 'en_US'
        const to = readTrimmed(req.body?.to || req.body?.phone || req.body?.phoneNumber)
        const phoneNumber = normalizePhoneNumber(to)
        const { code, error: codeError } = parseAuthenticationCode(req.body?.code ?? req.body?.otp ?? req.body?.verificationCode)

        if (!name) {
            return res.status(400).json({ success: false, error: 'name is required' })
        }
        if (!phoneNumber) {
            return res.status(400).json({ success: false, error: 'to/phone is required' })
        }
        if (codeError) {
            return res.status(400).json({ success: false, error: codeError })
        }

        const user = await findOrCreateUser(access.companyId, phoneNumber, access.profileId)
        if (!user) {
            return res.status(500).json({ success: false, error: 'Failed to resolve user' })
        }

        const response = await client.sendAuthenticationTemplate(phoneNumber, name, language, code)
        const messageId = response?.messages?.[0]?.id
        if (!messageId) {
            return res.status(500).json({ success: false, error: 'Authentication template send response missing message ID', data: response })
        }

        await insertMessage({
            userId: user.id,
            profileId: access.profileId,
            direction: 'out',
            content: {
                type: 'template',
                channel: 'cloud_api',
                subcategory: 'authentication',
                to: phoneNumber,
                message_id: messageId,
                payload: {
                    name,
                    language,
                    code
                },
                status: 'sent'
            },
            workflowState: null
        })

        res.json({
            success: true,
            data: {
                messageId,
                profileId: access.profileId,
                to: phoneNumber,
                name,
                language
            }
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/waba/templates/send', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const name = readTrimmed(req.body?.name || req.body?.templateName || req.body?.template_name)
        const language = readTrimmed(req.body?.language || req.body?.languageCode || req.body?.language_code) || 'en_US'
        const to = readTrimmed(req.body?.to || req.body?.phone || req.body?.phoneNumber)
        const phoneNumber = normalizePhoneNumber(to)

        if (!name) {
            return res.status(400).json({ success: false, error: 'name/templateName is required' })
        }
        if (!phoneNumber) {
            return res.status(400).json({ success: false, error: 'to/phone is required' })
        }

        const user = await findOrCreateUser(access.companyId, phoneNumber, access.profileId)
        if (!user) {
            return res.status(500).json({ success: false, error: 'Failed to resolve user' })
        }

        const components = buildTemplateSendComponents(req.body || {})
        let bodyAttributesForSave: Array<{ scope: 'body'; index: number; key: string; value: string }> = []

        if (Array.isArray(components) && components.length > 0) {
            const bodyComponent = components.find((component: any) => {
                const type = typeof component?.type === 'string' ? component.type.trim().toLowerCase() : ''
                return type === 'body'
            })
            const bodyParameters = Array.isArray(bodyComponent?.parameters) ? bodyComponent.parameters : []
            const requestedBodyAttributeNames = req.body?.bodyAttributeNames ?? req.body?.body_attribute_names
            const bodyAttributeNames = Array.isArray(requestedBodyAttributeNames)
                ? requestedBodyAttributeNames.map((value: any) => toTemplateText(value))
                : []
            bodyAttributesForSave = bodyParameters
                .map((param: any, index: number) => {
                    const value = toTemplateText(param?.text)
                    if (!value) return null
                    return {
                        scope: 'body' as const,
                        index: index + 1,
                        key: bodyAttributeNames[index] || `Body {{${index + 1}}}`,
                        value
                    }
                })
                .filter(Boolean) as Array<{ scope: 'body'; index: number; key: string; value: string }>
        }

        const componentErrors = validateTemplateSendComponents(components)
        if (componentErrors.length > 0) {
            return res.status(400).json({ success: false, error: 'Invalid template send components', details: componentErrors })
        }

        const { messageId } = await sendWhatsAppMessage({
            client,
            userId: user.id,
            profileId: access.profileId,
            to: phoneNumber,
            type: 'template',
            content: {
                name,
                language,
                components
            }
        })
        if (typeof setUserTemplateAttributes === 'function' && bodyAttributesForSave.length > 0) {
            await setUserTemplateAttributes(user.id, name, language, bodyAttributesForSave)
        }

        res.json({
            success: true,
            data: {
                messageId,
                profileId: access.profileId,
                to: phoneNumber,
                name,
                language,
                components: components || null
            }
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/waba/marketing-messages/send', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const name = readTrimmed(req.body?.name)
        const language = readTrimmed(req.body?.language) || 'en_US'
        const to = readTrimmed(req.body?.to || req.body?.phone || req.body?.phoneNumber)
        const phoneNumber = normalizePhoneNumber(to)

        if (!name) {
            return res.status(400).json({ success: false, error: 'name is required' })
        }
        if (!phoneNumber) {
            return res.status(400).json({ success: false, error: 'to/phone is required' })
        }

        const { options, errors } = parseMarketingSendOptions(req.body || {})
        if (errors.length > 0) {
            return res.status(400).json({ success: false, error: 'Invalid marketing message payload', details: errors })
        }

        const user = await findOrCreateUser(access.companyId, phoneNumber, access.profileId)
        if (!user) {
            return res.status(500).json({ success: false, error: 'Failed to resolve user' })
        }

        const response = await client.sendMarketingTemplate(phoneNumber, name, language, options)
        const messageId = response?.messages?.[0]?.id
        if (!messageId) {
            return res.status(500).json({ success: false, error: 'Marketing API response missing message ID', data: response })
        }

        await insertMessage({
            userId: user.id,
            profileId: access.profileId,
            direction: 'out',
            content: {
                type: 'template',
                channel: 'marketing_messages',
                to: phoneNumber,
                message_id: messageId,
                payload: {
                    name,
                    language,
                    ...options
                },
                status: 'sent'
            },
            workflowState: null
        })

        res.json({
            success: true,
            data: {
                messageId,
                profileId: access.profileId,
                to: phoneNumber,
                name,
                language,
                product_policy: options.productPolicy || null
            }
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

const scheduledBroadcastInFlightIds = new Set<string>()
let scheduledBroadcastTickRunning = false
let scheduledBroadcastMissingTableLogged = false

const normalizeScheduledBroadcastStatus = (value: any): 'scheduled' | 'processing' | 'sent' | 'partial' | 'failed' | 'cancelled' => {
    const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
    if (raw === 'processing') return 'processing'
    if (raw === 'sent') return 'sent'
    if (raw === 'partial') return 'partial'
    if (raw === 'failed') return 'failed'
    if (raw === 'cancelled') return 'cancelled'
    return 'scheduled'
}

const shapeScheduledBroadcastRow = (row: any) => {
    const recipients = Array.isArray(row?.recipients) ? row.recipients : []
    return {
        id: String(row?.id || ''),
        profile_id: typeof row?.profile_id === 'string' ? row.profile_id : '',
        company_id: typeof row?.company_id === 'string' ? row.company_id : '',
        name: typeof row?.name === 'string' ? row.name : '',
        template_name: typeof row?.template_name === 'string' ? row.template_name : '',
        language: typeof row?.language === 'string' ? row.language : 'en_US',
        components: Array.isArray(row?.components) ? row.components : [],
        recipients,
        recipient_count: recipients.length,
        scheduled_at: typeof row?.scheduled_at === 'string' ? row.scheduled_at : null,
        status: normalizeScheduledBroadcastStatus(row?.status),
        created_at: typeof row?.created_at === 'string' ? row.created_at : null,
        updated_at: typeof row?.updated_at === 'string' ? row.updated_at : null,
        processed_at: typeof row?.processed_at === 'string' ? row.processed_at : null,
        sent_count: Number.isFinite(Number(row?.sent_count)) ? Number(row.sent_count) : 0,
        failed_count: Number.isFinite(Number(row?.failed_count)) ? Number(row.failed_count) : 0,
        last_error: typeof row?.last_error === 'string' ? row.last_error : null
    }
}

async function runScheduledBroadcastTick() {
    if (scheduledBroadcastTickRunning) return
    scheduledBroadcastTickRunning = true
    try {
        const nowIso = new Date().toISOString()
        const { data: dueRows, error: dueError } = await supabase
            .from('scheduled_broadcasts')
            .select('id, company_id, profile_id, name, template_name, language, components, recipients, scheduled_at, status')
            .eq('status', 'scheduled')
            .lte('scheduled_at', nowIso)
            .order('scheduled_at', { ascending: true })
            .limit(8)

        if (dueError) {
            const maybeMissingRelation = String(dueError?.code || '') === '42P01' || /does not exist/i.test(String(dueError?.message || ''))
            if (maybeMissingRelation) {
                if (!scheduledBroadcastMissingTableLogged) {
                    scheduledBroadcastMissingTableLogged = true
                    console.warn('[ScheduledBroadcasts] Table public.scheduled_broadcasts not found. Run migrations to enable this feature.')
                }
                return
            }
            console.warn('[ScheduledBroadcasts] Failed to fetch due jobs:', dueError.message)
            return
        }

        scheduledBroadcastMissingTableLogged = false
        if (!Array.isArray(dueRows) || dueRows.length === 0) return

        for (const row of dueRows) {
            const jobId = typeof row?.id === 'string' ? row.id : ''
            if (!jobId || scheduledBroadcastInFlightIds.has(jobId)) continue

            scheduledBroadcastInFlightIds.add(jobId)
            try {
                const claimedAt = new Date().toISOString()
                const { data: claimed, error: claimError } = await supabase
                    .from('scheduled_broadcasts')
                    .update({
                        status: 'processing',
                        updated_at: claimedAt,
                        last_error: null
                    })
                    .eq('id', jobId)
                    .eq('status', 'scheduled')
                    .select('id, company_id, profile_id, template_name, language, components, recipients')
                    .maybeSingle()

                if (claimError) {
                    console.warn(`[ScheduledBroadcasts] Failed to claim job ${jobId}:`, claimError.message)
                    continue
                }
                if (!claimed?.id) continue

                const companyId = typeof claimed.company_id === 'string' ? claimed.company_id : ''
                const profileId = typeof claimed.profile_id === 'string' ? claimed.profile_id : ''
                const templateName = trimText(claimed.template_name)
                const language = trimText(claimed.language) || 'en_US'
                const components = Array.isArray(claimed.components) ? claimed.components : []

                const rawRecipients = parseScheduledRecipientsInput(claimed.recipients)
                const recipients = Array.from(
                    new Set(
                        rawRecipients
                            .map((entry) => normalizePhoneNumber(entry))
                            .filter(Boolean)
                    )
                )

                let sentCount = 0
                let failedCount = 0
                let firstError = ''

                if (!companyId || !profileId) {
                    firstError = 'Missing company_id or profile_id on scheduled broadcast.'
                    failedCount = recipients.length || 1
                } else if (!templateName) {
                    firstError = 'Template name is missing.'
                    failedCount = recipients.length || 1
                } else if (recipients.length === 0) {
                    firstError = 'No valid recipients found.'
                    failedCount = 1
                } else {
                    const componentErrors = validateTemplateSendComponents(components)
                    if (componentErrors.length > 0) {
                        firstError = componentErrors[0] || 'Invalid template components.'
                        failedCount = recipients.length
                    } else {
                        const client = await wabaRegistry.getClientByProfile(profileId)
                        if (!client) {
                            firstError = 'WABA not configured for this profile.'
                            failedCount = recipients.length
                        } else {
                            for (const phoneNumber of recipients) {
                                try {
                                    const user = await findOrCreateUser(companyId, phoneNumber, profileId)
                                    if (!user?.id) {
                                        failedCount += 1
                                        if (!firstError) firstError = `Failed to resolve user for ${phoneNumber}`
                                        continue
                                    }

                                    await sendWhatsAppMessage({
                                        client,
                                        userId: user.id,
                                        profileId,
                                        to: phoneNumber,
                                        type: 'template',
                                        content: {
                                            name: templateName,
                                            language,
                                            components
                                        },
                                        workflowState: null
                                    })
                                    sentCount += 1
                                } catch (sendError: any) {
                                    failedCount += 1
                                    if (!firstError) {
                                        firstError = `Failed to send ${phoneNumber}: ${formatScheduledBroadcastError(sendError)}`
                                    }
                                }
                            }
                        }
                    }
                }

                const finalStatus = sentCount > 0
                    ? (failedCount > 0 ? 'partial' : 'sent')
                    : 'failed'

                await supabase
                    .from('scheduled_broadcasts')
                    .update({
                        status: finalStatus,
                        sent_count: sentCount,
                        failed_count: failedCount,
                        processed_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                        last_error: firstError || null
                    })
                    .eq('id', jobId)
            } catch (error: any) {
                const message = formatScheduledBroadcastError(error)
                console.warn(`[ScheduledBroadcasts] Job ${jobId} failed:`, message)
                await supabase
                    .from('scheduled_broadcasts')
                    .update({
                        status: 'failed',
                        failed_count: 1,
                        processed_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                        last_error: message
                    })
                    .eq('id', jobId)
            } finally {
                scheduledBroadcastInFlightIds.delete(jobId)
            }
        }
    } finally {
        scheduledBroadcastTickRunning = false
    }
}

setInterval(() => {
    runScheduledBroadcastTick().catch((error) => {
        console.warn('[ScheduledBroadcasts] tick failed:', formatScheduledBroadcastError(error))
    })
}, SCHEDULED_BROADCAST_TICK_MS)
runScheduledBroadcastTick().catch((error) => {
    console.warn('[ScheduledBroadcasts] initial run failed:', formatScheduledBroadcastError(error))
})

app.get('/api/waba/scheduled-broadcasts', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const { data, error } = await supabase
            .from('scheduled_broadcasts')
            .select('id, company_id, profile_id, name, template_name, language, components, recipients, scheduled_at, status, created_at, updated_at, processed_at, sent_count, failed_count, last_error')
            .eq('company_id', access.companyId)
            .eq('profile_id', access.profileId)
            .order('scheduled_at', { ascending: true })
            .limit(200)

        if (error) {
            return res.status(500).json({ success: false, error: error.message })
        }

        const rows = Array.isArray(data) ? data.map((row: any) => shapeScheduledBroadcastRow(row)) : []
        res.json({ success: true, data: rows })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error?.message || 'Failed to load scheduled broadcasts' })
    }
})

app.post('/api/waba/scheduled-broadcasts', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const templateName = readTrimmed(req.body?.template_name || req.body?.templateName)
        const language = readTrimmed(req.body?.language || req.body?.languageCode || req.body?.language_code) || 'en_US'
        const scheduleName = readTrimmed(req.body?.name || req.body?.campaignName || req.body?.campaign_name)
        const scheduledAtRaw = readTrimmed(req.body?.scheduled_at || req.body?.scheduledAt)
        const scheduledAt = scheduledAtRaw ? new Date(scheduledAtRaw) : null
        const scheduledAtIso = scheduledAt && !Number.isNaN(scheduledAt.getTime()) ? scheduledAt.toISOString() : ''

        if (!templateName) {
            return res.status(400).json({ success: false, error: 'template_name/templateName is required' })
        }
        if (!scheduledAtIso) {
            return res.status(400).json({ success: false, error: 'scheduled_at/scheduledAt must be a valid datetime' })
        }
        if (scheduledAt!.getTime() < Date.now() - 5000) {
            return res.status(400).json({ success: false, error: 'scheduled_at must be in the future' })
        }

        const inputRecipients = parseScheduledRecipientsInput(req.body?.recipients)
        const normalizedRecipients = Array.from(
            new Set(
                inputRecipients
                    .map((entry) => normalizePhoneNumber(entry))
                    .filter(Boolean)
            )
        )
        if (normalizedRecipients.length === 0) {
            return res.status(400).json({ success: false, error: 'Provide at least one valid recipient number' })
        }
        if (normalizedRecipients.length > SCHEDULED_BROADCAST_MAX_RECIPIENTS) {
            return res.status(400).json({
                success: false,
                error: `Maximum ${SCHEDULED_BROADCAST_MAX_RECIPIENTS} recipients are allowed per scheduled broadcast`
            })
        }

        const componentsInput = Array.isArray(req.body?.components)
            ? req.body.components
            : buildTemplateSendComponents(req.body || {})
        const componentErrors = validateTemplateSendComponents(componentsInput)
        if (componentErrors.length > 0) {
            return res.status(400).json({ success: false, error: 'Invalid template components', details: componentErrors })
        }

        const { data, error } = await supabase
            .from('scheduled_broadcasts')
            .insert({
                company_id: access.companyId,
                profile_id: access.profileId,
                name: scheduleName || templateName,
                template_name: templateName,
                language,
                components: componentsInput,
                recipients: normalizedRecipients,
                scheduled_at: scheduledAtIso,
                status: 'scheduled',
                created_by: access.user?.id || null,
                sent_count: 0,
                failed_count: 0,
                last_error: null
            })
            .select('id, company_id, profile_id, name, template_name, language, components, recipients, scheduled_at, status, created_at, updated_at, processed_at, sent_count, failed_count, last_error')
            .maybeSingle()

        if (error) {
            return res.status(500).json({ success: false, error: error.message })
        }

        const row = data ? shapeScheduledBroadcastRow(data) : null
        res.json({ success: true, data: row })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error?.message || 'Failed to create scheduled broadcast' })
    }
})

app.delete('/api/waba/scheduled-broadcasts/:id', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return
        const id = readTrimmed(req.params?.id)
        if (!id) {
            return res.status(400).json({ success: false, error: 'id is required' })
        }

        const { data, error } = await supabase
            .from('scheduled_broadcasts')
            .update({
                status: 'cancelled',
                updated_at: new Date().toISOString()
            })
            .eq('id', id)
            .eq('company_id', access.companyId)
            .eq('profile_id', access.profileId)
            .eq('status', 'scheduled')
            .select('id, company_id, profile_id, name, template_name, language, components, recipients, scheduled_at, status, created_at, updated_at, processed_at, sent_count, failed_count, last_error')
            .maybeSingle()

        if (error) {
            return res.status(500).json({ success: false, error: error.message })
        }
        if (!data) {
            return res.status(404).json({ success: false, error: 'Scheduled broadcast not found or already processed' })
        }

        res.json({ success: true, data: shapeScheduledBroadcastRow(data) })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error?.message || 'Failed to cancel scheduled broadcast' })
    }
})

app.get('/api/waba/clients', async (req: any, res: any) => {
    try {
        const user = await getSupabaseUserFromRequest(req, res)
        if (!user) return

        const companyId = getUserCompanyId(user)
        const admin = await isAdminUser(user.id, companyId || undefined)
        if (!admin) {
            return res.status(403).json({ success: false, error: 'Admin access required' })
        }
        if (!companyId) {
            return res.status(400).json({ success: false, error: 'Company ID missing in user metadata' })
        }

        const { data: profiles } = await supabase
            .from('profiles')
            .select('id')
            .eq('company_id', companyId)

        const profileIds = (profiles || []).map((row: any) => row.id).filter(Boolean)

        let query = supabase
            .from('waba_configs')
            .select('profile_id, company_id, app_id, phone_number_id, business_id, client_business_id, waba_id, business_account_id, enabled, connected_at, access_token_expires_at, token_source, api_version')

        if (profileIds.length > 0) {
            const inList = profileIds.map((id: string) => `"${id}"`).join(',')
            query = query.or(`company_id.eq.${companyId},profile_id.in.(${inList})`)
        } else {
            query = query.eq('company_id', companyId)
        }

        const { data, error } = await query
        if (error) {
            return res.status(500).json({ success: false, error: error.message })
        }

        res.json({ success: true, data: data || [] })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/waba/clients/disconnect', async (req: any, res: any) => {
    try {
        const user = await getSupabaseUserFromRequest(req, res)
        if (!user) return

        const companyId = getUserCompanyId(user)
        const admin = await isAdminUser(user.id, companyId || undefined)
        if (!admin) {
            return res.status(403).json({ success: false, error: 'Admin access required' })
        }
        if (!companyId) {
            return res.status(400).json({ success: false, error: 'Company ID missing in user metadata' })
        }

        const profileId = req.body?.profileId
        if (!profileId || typeof profileId !== 'string') {
            return res.status(400).json({ success: false, error: 'profileId is required' })
        }

        const ownsProfile = await assertProfileCompany(profileId, companyId)
        if (!ownsProfile) {
            return res.status(403).json({ success: false, error: 'Profile does not belong to your company' })
        }

        const revoke = Boolean(req.body?.revoke)

        const { data: config, error: fetchError } = await supabase
            .from('waba_configs')
            .select('profile_id, company_id, app_id, phone_number_id, business_id, waba_id, business_account_id, access_token, system_user_token, api_version')
            .eq('profile_id', profileId)
            .maybeSingle()

        if (fetchError || !config) {
            return res.status(404).json({ success: false, error: fetchError?.message || 'WABA config not found' })
        }

        const wabaId = config.waba_id || config.business_account_id
        let unsubscribed = false
        let unsubscribeError: string | null = null

        if (revoke && wabaId) {
            try {
                const token = decryptToken(config.system_user_token || config.access_token)
                await unsubscribeWabaApp(wabaId, token, config.api_version || process.env.WABA_API_VERSION || 'v19.0')
                unsubscribed = true
            } catch (err: any) {
                unsubscribeError = err?.message || 'Failed to unsubscribe app'
            }
        }

        const { error: updateError } = await supabase
            .from('waba_configs')
            .update({ enabled: false })
            .eq('profile_id', profileId)

        if (updateError) {
            return res.status(500).json({ success: false, error: updateError.message })
        }

        const nowIso = new Date().toISOString()
        await supabase
            .from('whatsapp_connections')
            .update({
                status: 'DISCONNECTED',
                last_synced_at: nowIso,
                updated_at: nowIso
            })
            .eq('company_id', companyId)
            .eq('profile_id', profileId)

        await wabaRegistry.refresh(true)

        if (unsubscribeError) {
            return res.json({ success: false, error: unsubscribeError, disabled: true, unsubscribed })
        }

        res.json({ success: true, disabled: true, unsubscribed })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.get('/api/waba/system-runtime-status', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return
        if (!isSuperAdminUser(access.user)) {
            return res.status(403).json({ success: false, error: 'Superadmin access required' })
        }
        if (!systemRuntimeStatus || typeof systemRuntimeStatus.getStatus !== 'function') {
            return res.status(503).json({ success: false, error: 'Runtime status service unavailable' })
        }

        const snapshot = systemRuntimeStatus.getStatus()
        return res.json({ success: true, data: serializeSystemRuntimeStatus(snapshot) })
    } catch (error: any) {
        return res.status(500).json({ success: false, error: error?.message || 'Failed to load runtime status' })
    }
})

app.post('/api/waba/system-maintenance-mode', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return
        if (!isSuperAdminUser(access.user)) {
            return res.status(403).json({ success: false, error: 'Superadmin access required' })
        }
        if (!systemRuntimeStatus || typeof systemRuntimeStatus.setMaintenanceMode !== 'function') {
            return res.status(503).json({ success: false, error: 'Runtime status service unavailable' })
        }

        const enabled = req.body?.enabled === true
        const message = trimText(req.body?.message).slice(0, 280)
        const actor = trimText(access.user?.email || access.user?.id || '')
        const snapshot = systemRuntimeStatus.setMaintenanceMode({
            enabled,
            message,
            updatedBy: actor || null
        })

        return res.json({ success: true, data: serializeSystemRuntimeStatus(snapshot) })
    } catch (error: any) {
        return res.status(500).json({ success: false, error: error?.message || 'Failed to update maintenance mode' })
    }
})

// Connected client businesses for Meta app
app.get('/api/waba/connected-client-businesses', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return
        if (!isSuperAdminUser(access.user)) {
            return res.status(403).json({ success: false, error: 'Superadmin access required' })
        }

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const config = await wabaRegistry.getConfigByProfile(access.profileId)
        const rawAppId = req.query?.appId
        const appId = readTrimmed(Array.isArray(rawAppId) ? rawAppId[0] : rawAppId)
            || readTrimmed(config?.appId || process.env.WABA_APP_ID || process.env.APP_ID)

        if (!appId) {
            return res.status(400).json({
                success: false,
                error: 'Application ID is required. Add app_id to waba_configs or pass appId query param.'
            })
        }

        const rawFields = req.query?.fields
        const fields = Array.isArray(rawFields) ? rawFields.join(',') : rawFields
        const rawLimit = req.query?.limit
        const limit = rawLimit !== undefined ? Number(rawLimit) : undefined
        const rawAfter = req.query?.after
        const rawBefore = req.query?.before

        const response = await client.getConnectedClientBusinesses(String(appId), {
            fields: typeof fields === 'string' && fields.trim() ? fields.trim() : undefined,
            limit: Number.isFinite(limit) ? limit : undefined,
            after: typeof rawAfter === 'string' ? rawAfter : Array.isArray(rawAfter) ? rawAfter[0] : undefined,
            before: typeof rawBefore === 'string' ? rawBefore : Array.isArray(rawBefore) ? rawBefore[0] : undefined
        })

        res.json({ success: true, data: response })
    } catch (error: any) {
        const normalized = toHttpErrorPayload(error, 'Failed to load connected client businesses')
        res.status(normalized.status).json(normalized.payload)
    }
})

// Check whether a WhatsApp user can be called and available call actions.
app.get('/api/waba/call-permissions', async (req: any, res: any) => {
    try {
        setDeprecatedRouteHeaders(res, '/api/v1/whatsapp/calls/permissions')
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA not configured for this profile.' })
        }

        const userWaId = readTrimmed(req.query?.user_wa_id || req.query?.userWaId)
        if (!userWaId) {
            return res.status(400).json({ success: false, error: 'user_wa_id (or userWaId) is required' })
        }

        const phoneNumberId = readTrimmed(req.query?.phoneNumberId || req.query?.phone_number_id) || undefined
        const data = await client.getCallPermissions(userWaId, phoneNumberId)
        const storedPermission = await getStoredWhatsappCallPermission(supabase, {
            phoneNumberId: phoneNumberId || client.phoneNumberId,
            customerWaId: userWaId
        })

        res.json({
            success: true,
            data,
            stored_permission: storedPermission || null
        })
    } catch (error: any) {
        const { status, payload } = toHttpErrorPayload(error, 'Failed to check call permissions')
        res.status(status).json(payload)
    }
})

app.post('/api/whatsapp/calling/request-permission', async (req: any, res: any) => {
    try {
        setDeprecatedRouteHeaders(res, '/api/v1/whatsapp/calls/request-permission')
        const access = await resolveProfileAccess(req, res)
        if (!access) return
        if (!(await requireAdminAccess(access, res))) return

        const { client, phoneNumberId } = await loadCallClientContext(access, req, 'body')
        const userWaId = readTrimmed(req.body?.user_wa_id || req.body?.userWaId || req.body?.to)
        if (!userWaId) {
            return res.status(400).json({ success: false, error: 'user_wa_id (or userWaId) is required' })
        }

        const bodyText = trimText(req.body?.body_text || req.body?.bodyText || req.body?.text)
            || 'We would like to call you to help support your request.'
        const permissionData = await client.getCallPermissions(userWaId, phoneNumberId)
        const permissionSummary = extractCallPermissionSummary(permissionData)
        if (!permissionSummary.canRequestPermission) {
            return res.status(409).json({
                success: false,
                error: 'CALL_PERMISSION_REQUEST_NOT_ALLOWED',
                details: ['Meta does not currently allow a new call permission request for this contact.']
            })
        }

        try {
            const data = await client.sendCallPermissionRequest(userWaId, bodyText, phoneNumberId)
            const messageId = trimText(data?.messages?.[0]?.id) || null
            const requestRow = await insertWhatsappCallPermissionRequest(supabase, {
                companyId: access.companyId,
                profileId: access.profileId,
                phoneNumberId,
                customerWaId: userWaId,
                customerPhoneNumber: userWaId,
                requestMessageId: messageId,
                bodyText,
                status: 'sent',
                metaResponse: data
            })

            return res.json({
                success: true,
                data,
                request: requestRow || null
            })
        } catch (error: any) {
            await insertWhatsappCallPermissionRequest(supabase, {
                companyId: access.companyId,
                profileId: access.profileId,
                phoneNumberId,
                customerWaId: userWaId,
                customerPhoneNumber: userWaId,
                bodyText,
                status: 'failed',
                metaError: error?.response || { message: error?.message || 'Failed to send call permission request' }
            })
            const { status, payload } = toHttpErrorPayload(error, 'Failed to send call permission request')
            return res.status(status).json(payload)
        }
    } catch (error: any) {
        const { status, payload } = toHttpErrorPayload(error, 'Failed to send call permission request')
        res.status(status).json(payload)
    }
})

app.get('/api/whatsapp/connections', async (req: any, res: any) => {
    try {
        const access = await resolveCompanyWhatsappAccess(req, res, 'query')
        if (!access) return

        const rows = await getCompanyWhatsappConnections(access.companyId, access.profileId || undefined)
        const activeConnection = access.profileId
            ? rows.find((row: any) => trimText(row?.profile_id) === access.profileId) || null
            : (rows[0] || null)

        return res.json(buildVersionedApiSuccess(req, {
            provider: 'meta_whatsapp_cloud_api',
            company_id: access.companyId,
            profile_id: access.profileId || null,
            connected: Boolean(activeConnection),
            connection_count: rows.length,
            active_connection: activeConnection ? shapeVersionedWhatsappConnection(activeConnection) : null,
            connections: rows.map((row: any) => shapeVersionedWhatsappConnection(row))
        }))
    } catch (error: any) {
        return sendVersionedApiError(req, res, error, 'Failed to load WhatsApp connections', 'WHATSAPP_CONNECTIONS_LOAD_FAILED')
    }
})

app.post('/api/whatsapp/connections/refresh', async (req: any, res: any) => {
    try {
        const access = await resolveCompanyWhatsappAccess(req, res, 'body')
        if (!access) return

        const { refreshed, failures } = await refreshWhatsappConnectionsForCompany({
            companyId: access.companyId,
            profileId: access.profileId,
            userId: access.user.id
        })

        return res.json(buildVersionedApiSuccess(req, {
            company_id: access.companyId,
            profile_id: access.profileId || null,
            refreshed_count: refreshed.length,
            failed_count: failures.length,
            connections: refreshed.map((row: any) => shapeVersionedWhatsappConnection(row)),
            failures
        }))
    } catch (error: any) {
        return sendVersionedApiError(req, res, error, 'Failed to refresh WhatsApp connections', 'WHATSAPP_CONNECTIONS_REFRESH_FAILED')
    }
})

app.post('/api/whatsapp/connections/disconnect', async (req: any, res: any) => {
    try {
        const access = await resolveCompanyWhatsappAccess(req, res, 'body')
        if (!access) return

        const admin = await isAdminUser(access.user.id, access.companyId || undefined)
        if (!admin) {
            return res.status(403).json(buildVersionedApiError(req, 'ADMIN_ACCESS_REQUIRED', 'Admin access required'))
        }

        if (!access.profileId) {
            return res.status(400).json(buildVersionedApiError(req, 'PROFILE_ID_REQUIRED', 'profile_id is required'))
        }

        const revoke = req.body?.revoke === true
        const result = await disconnectWhatsappConnection({
            companyId: access.companyId,
            profileId: access.profileId,
            revoke
        })

        const statusCode = result.unsubscribe_error ? 207 : 200
        return res.status(statusCode).json(buildVersionedApiSuccess(req, {
            company_id: access.companyId,
            profile_id: access.profileId,
            disabled: result.disabled,
            unsubscribed: result.unsubscribed,
            unsubscribe_error: result.unsubscribe_error
        }))
    } catch (error: any) {
        return sendVersionedApiError(req, res, error, 'Failed to disconnect WhatsApp connection', 'WHATSAPP_CONNECTION_DISCONNECT_FAILED')
    }
})

app.get('/api/whatsapp/connections/:connectionId', async (req: any, res: any) => {
    try {
        const access = await resolveCompanyWhatsappAccess(req, res, 'query')
        if (!access) return

        const connectionId = trimText(req.params?.connectionId)
        if (!connectionId) {
            return res.status(400).json(buildVersionedApiError(req, 'CONNECTION_ID_REQUIRED', 'connectionId is required'))
        }

        const rows = await getCompanyWhatsappConnections(access.companyId, access.profileId || undefined)
        const match = rows.find((row: any) => {
            const candidates = [
                trimText(row?.id),
                trimText(row?.profile_id),
                trimText(row?.phone_number_id)
            ]
            return candidates.includes(connectionId)
        }) || null

        if (!match) {
            return res.status(404).json(buildVersionedApiError(req, 'WHATSAPP_CONNECTION_NOT_FOUND', 'WhatsApp connection not found'))
        }

        return res.json(buildVersionedApiSuccess(req, {
            connection: shapeVersionedWhatsappConnection(match)
        }))
    } catch (error: any) {
        return sendVersionedApiError(req, res, error, 'Failed to load WhatsApp connection', 'WHATSAPP_CONNECTION_LOAD_FAILED')
    }
})

app.get('/api/whatsapp/conversations', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const rawLimit = Number(req.query?.limit)
        const rawOffset = Number(req.query?.offset)
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.floor(rawLimit))) : 25
        const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0
        const search = trimText(req.query?.search).toLowerCase()

        const users = await getUsersForCompany(access.companyId, access.profileId)
        const filteredUsers = users
            .filter((user: any) => {
                if (!search) return true
                const haystack = [
                    trimText(user?.alias),
                    trimText(user?.name),
                    normalizePhoneNumber(user?.phone_number),
                    Array.isArray(user?.tags) ? user.tags.join(' ') : ''
                ].join(' ').toLowerCase()
                return haystack.includes(search)
            })
            .sort((a: any, b: any) => {
                const aTime = new Date(trimText(a?.last_inbound_at) || 0).getTime()
                const bTime = new Date(trimText(b?.last_inbound_at) || 0).getTime()
                return bTime - aTime
            })

        const pageUsers = filteredUsers.slice(offset, offset + limit)
        const latestMessageMap = await loadLatestMessagesForConversationUsers(pageUsers.map((user: any) => trimText(user?.id)).filter(Boolean))

        return res.json(buildVersionedApiSuccess(req, {
            profile_id: access.profileId,
            company_id: access.companyId,
            total: filteredUsers.length,
            limit,
            offset,
            conversations: pageUsers.map((user: any) => shapeVersionedConversation(user, latestMessageMap.get(trimText(user?.id)) || null))
        }))
    } catch (error: any) {
        return sendVersionedApiError(req, res, error, 'Failed to load conversations', 'WHATSAPP_CONVERSATIONS_LOAD_FAILED')
    }
})

app.get('/api/whatsapp/conversations/:conversationId/messages', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const conversationId = trimText(req.params?.conversationId)
        if (!conversationId) {
            return res.status(400).json(buildVersionedApiError(req, 'CONVERSATION_ID_REQUIRED', 'conversationId is required'))
        }

        const conversation = await loadConversationRecord(access.companyId, access.profileId, conversationId)
        if (!conversation) {
            return res.status(404).json(buildVersionedApiError(req, 'CONVERSATION_NOT_FOUND', 'Conversation not found for this profile'))
        }

        const rawLimit = Number(req.query?.limit)
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, Math.floor(rawLimit))) : 100
        const sinceTimestamp = Number(req.query?.since_timestamp ?? req.query?.sinceTimestamp ?? 0)
        const records = Number.isFinite(sinceTimestamp) && sinceTimestamp > 0
            ? await getMessagesForUsersSince([conversation.id], sinceTimestamp, limit)
            : await getMessagesForUsers([conversation.id], limit)

        const messages = records
            .map((record: any) => shapeVersionedWhatsappMessage(record, conversation))
            .reverse()

        return res.json(buildVersionedApiSuccess(req, {
            conversation: shapeVersionedConversation(conversation, records[0] || null),
            messages,
            count: messages.length
        }))
    } catch (error: any) {
        return sendVersionedApiError(req, res, error, 'Failed to load conversation messages', 'WHATSAPP_MESSAGES_LOAD_FAILED')
    }
})

app.post('/api/whatsapp/messages/send', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json(buildVersionedApiError(req, 'WHATSAPP_NOT_CONFIGURED', 'WABA not configured for this profile.'))
        }

        const conversationId = trimText(req.body?.conversation_id || req.body?.conversationId)
        const rawRecipient = trimText(req.body?.to || req.body?.phone_number || req.body?.phoneNumber || req.body?.jid)
        const text = trimText(req.body?.text || req.body?.message)
        const rawMedia = req.body?.media && typeof req.body.media === 'object' ? req.body.media : null
        const mediaType = trimText(rawMedia?.type).toLowerCase()
        const mediaId = trimText(rawMedia?.id)
        const mediaLink = trimText(rawMedia?.link || rawMedia?.url)
        const mediaAssetKey = trimText(rawMedia?.assetKey)
        const mediaFilename = trimText(rawMedia?.filename)

        if (!conversationId && !rawRecipient) {
            return res.status(400).json(buildVersionedApiError(req, 'RECIPIENT_REQUIRED', 'conversation_id or to is required'))
        }
        if (!text && !rawMedia) {
            return res.status(400).json(buildVersionedApiError(req, 'MESSAGE_CONTENT_REQUIRED', 'text or media is required'))
        }

        let user: any = null
        let recipientId = ''
        if (conversationId) {
            user = await loadConversationRecord(access.companyId, access.profileId, conversationId)
            if (!user) {
                return res.status(404).json(buildVersionedApiError(req, 'CONVERSATION_NOT_FOUND', 'Conversation not found for this profile'))
            }
            recipientId = normalizePhoneNumber(user.phone_number)
        } else {
            recipientId = normalizePhoneNumber(rawRecipient)
            if (!recipientId) {
                return res.status(400).json(buildVersionedApiError(req, 'RECIPIENT_INVALID', 'Recipient phone number is invalid'))
            }
            user = await findOrCreateUser(access.companyId, recipientId, access.profileId)
            if (!user) {
                return res.status(500).json(buildVersionedApiError(req, 'CONVERSATION_RESOLVE_FAILED', 'Failed to resolve conversation for recipient'))
            }
        }

        const normalizedMedia =
            (mediaType === 'image' || mediaType === 'video' || mediaType === 'document')
                && (mediaId || mediaLink)
                ? {
                    type: mediaType,
                    ...(mediaId ? { id: mediaId } : { link: mediaLink }),
                    ...(mediaAssetKey ? { assetKey: mediaAssetKey } : {}),
                    ...(mediaType === 'document' && mediaFilename ? { filename: mediaFilename } : {})
                }
                : null

        if (rawMedia && !normalizedMedia) {
            return res.status(400).json(buildVersionedApiError(
                req,
                'MEDIA_INVALID',
                'media.type must be image, video, or document, and media.id or media.link is required'
            ))
        }

        const actor = buildVersionedActorFromUser(access.user)
        const sent = await sendWhatsAppMessage({
            client,
            userId: user.id,
            profileId: access.profileId,
            to: recipientId,
            type: 'text',
            content: {
                text,
                ...(normalizedMedia ? { media: normalizedMedia } : {})
            },
            actor
        })

        const recentMessages = await getMessagesForUsers([user.id], 5)
        const persisted = recentMessages.find((record: any) => {
            const contentMessageId = trimText(record?.content?.message_id)
            return contentMessageId && contentMessageId === trimText(sent?.messageId)
        }) || recentMessages[0] || null

        return res.json(buildVersionedApiSuccess(req, {
            conversation_id: user.id,
            profile_id: access.profileId,
            recipient_phone_number: recipientId,
            message: persisted
                ? shapeVersionedWhatsappMessage(persisted, user)
                : {
                    id: trimText(sent?.messageId) || null,
                    conversation_id: user.id,
                    profile_id: access.profileId,
                    direction: 'out',
                    type: normalizedMedia?.type || 'text',
                    status: 'sent',
                    text: text || null
                }
        }))
    } catch (error: any) {
        return sendVersionedApiError(req, res, error, 'Failed to send WhatsApp message', 'WHATSAPP_MESSAGE_SEND_FAILED')
    }
})

app.get('/api/whatsapp/onboarding/status', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return
        return res.json(buildVersionedApiSuccess(req, await buildOnboardingStatusData(access)))
    } catch (error: any) {
        return sendVersionedApiError(req, res, error, 'Failed to load onboarding status', 'WHATSAPP_ONBOARDING_STATUS_FAILED')
    }
})

app.post('/api/whatsapp/connect/start', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return
        if (!(await requireAdminAccess(access, res))) return

        const requestedOnboardingType = trimText(req.body?.onboarding_type || req.body?.onboardingType).toLowerCase()
        if (requestedOnboardingType === 'coexistence') {
            return res.status(400).json(buildVersionedApiError(
                req,
                'USE_COEXISTENCE_START',
                'Use /api/v1/whatsapp/coexistence/start for existing WhatsApp Business App coexistence onboarding.'
            ))
        }

        const appId = resolveMetaAppIdFromEnv()
        const appSecret = resolveMetaAppSecretFromEnv()
        const verifyToken = resolveMetaVerifyTokenFromEnv()
        if (!appId || !appSecret || !verifyToken) {
            return res.status(500).json(buildVersionedApiError(
                req,
                'META_SIGNUP_CONFIG_MISSING',
                'Missing META_APP_ID, META_APP_SECRET, or META_WEBHOOK_VERIFY_TOKEN.'
            ))
        }

        if (!getTokenEncryptionKey()) {
            return res.status(500).json(buildVersionedApiError(
                req,
                'TOKEN_ENCRYPTION_KEY_MISSING',
                'Missing ENCRYPTION_KEY.'
            ))
        }

        const configId = resolveMetaEmbeddedSignupV4ConfigIdFromEnv()
        if (!configId) {
            return res.status(500).json(buildVersionedApiError(
                req,
                'EMBEDDED_SIGNUP_CONFIGURATION_MISSING',
                'Missing META_WA_EMBEDDED_SIGNUP_V4_CONFIGURATION_ID.'
            ))
        }

        const requestedBusinessId = readTrimmed(req.body?.business_id || req.body?.businessId) || null
        const requestedWabaId = readTrimmed(req.body?.waba_id || req.body?.wabaId || req.body?.business_account_id || req.body?.businessAccountId) || null
        const requestedPhoneNumberId = readTrimmed(req.body?.phone_number_id || req.body?.phoneNumberId) || null
        const preverifiedIds = Array.from(new Set(parsePreverifiedIdsInput(
            req.body?.preverified_ids
            ?? req.body?.preverifiedIds
            ?? req.body?.preVerifiedIds
            ?? process.env.WABA_EMBEDDED_SIGNUP_PREVERIFIED_IDS
            ?? process.env.WABA_PREVERIFIED_PHONE_IDS
            ?? ''
        )))
        const sessionInfoVersion = parseEmbeddedSignupSessionInfoVersion(
            req.body?.session_info_version || req.body?.sessionInfoVersion || '3'
        ) || '3'
        const redirectUri = resolveOauthRedirectUri(req)
        const apiVersion = resolveMetaGraphVersionFromEnv('v25.0')
        const state = randomBytes(16).toString('hex')
        const stateHash = hashOAuthState(state)
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
        const redirectUrl = sanitizeReturnUrl(req.body?.return_url || req.body?.returnUrl) || resolveOauthReturnUrl(req)

        const { error } = await supabase
            .from('waba_oauth_states')
            .insert({
                state_hash: stateHash,
                profile_id: access.profileId,
                company_id: access.companyId,
                user_id: access.user.id,
                requested_business_id: requestedBusinessId,
                requested_waba_id: requestedWabaId,
                requested_phone_number_id: requestedPhoneNumberId,
                redirect_url: redirectUrl,
                expires_at: expiresAt
            })

        if (error) {
            return res.status(500).json(buildVersionedApiError(req, 'WHATSAPP_CONNECT_START_FAILED', error.message || 'Failed to create signup state'))
        }

        const signupUrl = buildEmbeddedSignupUrl({
            appId,
            redirectUri,
            state,
            scopes: WABA_OAUTH_SCOPES,
            apiVersion,
            configId,
            includeScopes: resolveOauthMode(configId) === 'user',
            extras: buildEmbeddedSignupExtras({
                preverifiedIds,
                sessionInfoVersion
            })
        })

        return res.json(buildVersionedApiSuccess(req, {
            provider: 'meta_embedded_signup',
            onboarding_type: 'new_phone_onboarding',
            start_url: signupUrl,
            configuration_id: configId,
            session_info_version: sessionInfoVersion,
            preverified_ids: preverifiedIds
        }))
    } catch (error: any) {
        return sendVersionedApiError(req, res, error, 'Failed to start WhatsApp onboarding', 'WHATSAPP_CONNECT_START_FAILED')
    }
})

app.post('/api/whatsapp/connect/complete', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return
        if (!(await requireAdminAccess(access, res))) return

        const requestedCompanyId = trimText(req.body?.company_id || req.body?.companyId) || access.companyId
        const code = trimText(req.body?.code)
        const wabaId = trimText(req.body?.waba_id || req.body?.wabaId || req.body?.business_account_id || req.body?.businessAccountId)
        const phoneNumberId = trimText(req.body?.phone_number_id || req.body?.phoneNumberId)
        const businessId = trimText(req.body?.business_id || req.body?.businessId) || null
        const flowType = trimText(req.body?.flow_type || req.body?.flowType) || 'new_phone_onboarding'
        const pin = trimText(req.body?.pin)

        if (requestedCompanyId !== access.companyId && !isSuperAdminUser(access.user)) {
            return res.status(403).json(buildVersionedApiError(req, 'COMPANY_ACCESS_DENIED', 'company_id does not belong to your account'))
        }
        if (!code || !wabaId || !phoneNumberId) {
            return res.status(400).json(buildVersionedApiError(req, 'CONNECT_COMPLETE_VALIDATION_FAILED', 'code, business_account_id, and phone_number_id are required'))
        }
        if (pin && !/^\d{6}$/.test(pin)) {
            return res.status(400).json(buildVersionedApiError(req, 'PHONE_REGISTRATION_PIN_INVALID', 'pin must be 6 digits'))
        }

        const appId = resolveMetaAppIdFromEnv()
        const appSecret = resolveMetaAppSecretFromEnv()
        const verifyToken = resolveMetaVerifyTokenFromEnv()
        const apiVersion = resolveMetaGraphVersionFromEnv('v24.0')
        if (!appId || !appSecret) {
            return res.status(500).json(buildVersionedApiError(req, 'META_SIGNUP_CONFIG_MISSING', 'Missing META_APP_ID or META_APP_SECRET'))
        }
        if (!verifyToken) {
            return res.status(500).json(buildVersionedApiError(req, 'META_VERIFY_TOKEN_MISSING', 'Missing META_WEBHOOK_VERIFY_TOKEN'))
        }
        if (!getTokenEncryptionKey()) {
            return res.status(500).json(buildVersionedApiError(req, 'TOKEN_ENCRYPTION_KEY_MISSING', 'Missing ENCRYPTION_KEY'))
        }

        const tokenData = await exchangeEmbeddedSignupCodeForToken({
            code,
            appId,
            appSecret,
            apiVersion,
            req
        })

        const accessToken = trimText(tokenData?.access_token)
        const accessTokenType = trimText(tokenData?.token_type) || null
        const expiresIn = Number(tokenData?.expires_in)
        const accessTokenExpiresAt = Number.isFinite(expiresIn) && expiresIn > 0
            ? new Date(Date.now() + expiresIn * 1000).toISOString()
            : null

        if (!accessToken) {
            return res.status(502).json(buildVersionedApiError(req, 'META_TOKEN_EXCHANGE_FAILED', 'Token exchange failed: no access token returned by Meta'))
        }

        try {
            const onboardingType = deriveOnboardingTypeFromFlow(flowType)
            const { connectionRow, phoneDetails } = await syncWhatsAppConnection({
                profileId: access.profileId,
                companyId: requestedCompanyId,
                userId: access.user.id,
                appId,
                appSecret,
                verifyToken,
                apiVersion,
                accessToken,
                accessTokenType,
                accessTokenExpiresAt,
                businessId,
                wabaId,
                phoneNumberId,
                flowType,
                skipPhoneRegistration: onboardingType === 'coexistence',
                pin: pin || null,
                onboardingType,
                coexistenceEnabled: onboardingType === 'coexistence',
                coexistenceStatus: onboardingType === 'coexistence' ? 'connected' : null,
                historySyncRequested: onboardingType === 'coexistence' ? false : undefined,
                historySyncAvailable: onboardingType === 'coexistence' ? false : undefined,
                rawOnboardingResponse: {
                    flow_type: flowType,
                    business_id: businessId,
                    waba_id: wabaId,
                    phone_number_id: phoneNumberId,
                    token_type: accessTokenType,
                    token_expires_at: accessTokenExpiresAt
                }
            })

            return res.json(buildVersionedApiSuccess(req, {
                provider: 'meta_whatsapp_cloud_api',
                connection: shapeVersionedWhatsappConnection({
                    ...connectionRow,
                    phone_number: trimText(connectionRow?.phone_number || phoneDetails?.display_phone_number) || null,
                    display_name: trimText(connectionRow?.display_name || phoneDetails?.name || phoneDetails?.display_name) || null,
                    verified_name: trimText(connectionRow?.verified_name || phoneDetails?.verified_name) || null,
                    status: trimText(connectionRow?.status || phoneDetails?.status) || 'CONNECTED',
                    waba_id: trimText(connectionRow?.waba_id) || wabaId,
                    phone_number_id: trimText(connectionRow?.phone_number_id) || phoneNumberId
                })
            }))
        } catch (error: any) {
            if (error?.needsPin) {
                return res.status(409).json(buildVersionedApiError(
                    req,
                    'PHONE_REGISTRATION_PIN_REQUIRED',
                    error.message,
                    ['Meta requires a 6-digit phone registration PIN for this number.']
                ))
            }
            return sendVersionedApiError(req, res, error, 'Failed to complete WhatsApp onboarding', 'WHATSAPP_CONNECT_COMPLETE_FAILED')
        }
    } catch (error: any) {
        return sendVersionedApiError(req, res, error, 'Failed to complete WhatsApp onboarding', 'WHATSAPP_CONNECT_COMPLETE_FAILED')
    }
})

app.post('/api/whatsapp/coexistence/complete', async (req: any, res: any) => {
    try {
        if (!isVersionedApiRequest(req)) {
            setDeprecatedRouteHeaders(res, '/api/v1/whatsapp/coexistence/complete')
        }
        const access = await resolveProfileAccess(req, res)
        if (!access) return
        if (!(await requireAdminAccess(access, res))) return

        const requestedCompanyId = trimText(req.body?.company_id || req.body?.companyId) || access.companyId
        if (requestedCompanyId !== access.companyId && !isSuperAdminUser(access.user)) {
            return res.status(403).json(buildVersionedApiError(req, 'COMPANY_ACCESS_DENIED', 'company_id does not belong to your account'))
        }

        const code = trimText(req.body?.code)
        const wabaId = trimText(req.body?.waba_id || req.body?.wabaId || req.body?.business_account_id || req.body?.businessAccountId)
        const phoneNumberId = trimText(req.body?.phone_number_id || req.body?.phoneNumberId) || null
        const businessId = trimText(req.body?.business_id || req.body?.businessId) || null

        if (!code || !wabaId) {
            return res.status(400).json(buildVersionedApiError(
                req,
                'COEXISTENCE_COMPLETE_VALIDATION_FAILED',
                'code and waba_id are required'
            ))
        }

        const result = await completeCoexistenceOnboarding({
            req,
            companyId: requestedCompanyId,
            profileId: access.profileId,
            userId: access.user.id,
            code,
            wabaId,
            phoneNumberId,
            businessId
        })

        if (!result.success && result.requiresSelection) {
            if (!isVersionedApiRequest(req)) {
                return res.status(409).json({
                    success: false,
                    code: 'COEXISTENCE_PHONE_SELECTION_REQUIRED',
                    flow_type: 'coexistence',
                    requires_selection: true,
                    waba_id: result.wabaId,
                    business_id: result.businessId,
                    phone_numbers: result.phoneNumbers
                })
            }

            return res.status(409).json(buildVersionedApiError(
                req,
                'COEXISTENCE_PHONE_SELECTION_REQUIRED',
                'Meta returned multiple phone numbers for this WABA. Select the correct phone_number_id and retry.',
                (result.phoneNumbers || []).map((entry: any) => {
                    const id = trimText(entry?.id)
                    const displayPhone = trimText(entry?.phone_number)
                    return [id, displayPhone].filter(Boolean).join(': ')
                }).filter(Boolean)
            ))
        }

        if (!isVersionedApiRequest(req)) {
            const connection = result.connection
            return res.json({
                success: true,
                flow_type: 'coexistence',
                connection: {
                    id: connection.id,
                    waba_id: connection.waba_id,
                    phone_number_id: connection.phone_number_id,
                    phone_number: connection.phone_number,
                    display_name: connection.display_name,
                    verified_name: connection.verified_name,
                    platform_type: connection.platform_type,
                    is_on_biz_app: connection.is_on_biz_app,
                    status: connection.status,
                    coexistence_enabled: connection.coexistence_enabled,
                    sync_status: connection.sync_status,
                    messaging_paused: connection.messaging_paused,
                    last_account_update_event: connection.last_account_update_event
                }
            })
        }

        return res.json(buildVersionedApiSuccess(req, {
            provider: 'meta_whatsapp_cloud_api',
            flow_type: 'coexistence',
            connection: shapeVersionedWhatsappConnection(result.connection)
        }))
    } catch (error: any) {
        return sendVersionedApiError(req, res, error, 'Failed to complete coexistence onboarding', 'WHATSAPP_COEXISTENCE_COMPLETE_FAILED')
    }
})

app.post('/api/whatsapp/coexistence/start', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return
        if (!(await requireAdminAccess(access, res))) return
        return res.json(buildVersionedApiSuccess(req, await buildCoexistenceStartData(access, req)))
    } catch (error: any) {
        return sendVersionedApiError(req, res, error, 'Failed to start coexistence onboarding', 'WHATSAPP_COEXISTENCE_START_FAILED')
    }
})

app.get('/api/whatsapp/coexistence/status/:customerId', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const customerId = trimText(req.params?.customerId)
        if (!customerId) {
            return res.status(400).json(buildVersionedApiError(req, 'CUSTOMER_ID_REQUIRED', 'customerId is required'))
        }

        const rows = await getCompanyWhatsappConnections(access.companyId)
        const matches = rows.filter((row: any) => {
            const candidates = [
                trimText(row?.id),
                trimText(row?.business_id),
                trimText(row?.waba_id),
                trimText(row?.phone_number_id)
            ]
            return candidates.includes(customerId)
        })

        return res.json(buildVersionedApiSuccess(req, {
            customer_id: customerId,
            connections: matches.map((row: any) => shapeVersionedWhatsappConnection(row))
        }))
    } catch (error: any) {
        return sendVersionedApiError(req, res, error, 'Failed to load coexistence status', 'WHATSAPP_COEXISTENCE_STATUS_FAILED')
    }
})

app.get('/api/whatsapp/webhooks/recent', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return
        if (!(await requireAdminAccess(access, res))) return

        const rows = await getRecentWhatsappRawWebhookEvents(supabase, {
            companyId: access.companyId,
            profileId: readTrimmed(req.query?.profileId || req.query?.profile_id) || undefined,
            eventType: mapRecentWebhookTypeFilter(req.query?.type) || undefined,
            limit: Number(req.query?.limit)
        })

        return res.json(buildVersionedApiSuccess(req, {
            events: rows
        }))
    } catch (error: any) {
        return sendVersionedApiError(req, res, error, 'Failed to load recent webhook events', 'WHATSAPP_RECENT_WEBHOOKS_FAILED')
    }
})

app.get('/api/whatsapp/calls/permissions', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const client = await wabaRegistry.getClientByProfile(access.profileId)
        if (!client) {
            return res.status(503).json(buildVersionedApiError(req, 'WHATSAPP_NOT_CONFIGURED', 'WABA not configured for this profile.'))
        }

        const userWaId = readTrimmed(req.query?.customer_id || req.query?.user_wa_id || req.query?.userWaId)
        if (!userWaId) {
            return res.status(400).json(buildVersionedApiError(req, 'CUSTOMER_ID_REQUIRED', 'customer_id is required'))
        }

        const phoneNumberId = readTrimmed(req.query?.phoneNumberId || req.query?.phone_number_id) || undefined
        const data = await client.getCallPermissions(userWaId, phoneNumberId)
        const storedPermission = await getStoredWhatsappCallPermission(supabase, {
            phoneNumberId: phoneNumberId || client.phoneNumberId,
            customerWaId: userWaId
        })

        return res.json(buildVersionedApiSuccess(req, {
            customer_id: userWaId,
            permission_check: data,
            stored_permission: storedPermission || null
        }))
    } catch (error: any) {
        return sendVersionedApiError(req, res, error, 'Failed to check call permissions', 'WHATSAPP_CALL_PERMISSIONS_FAILED')
    }
})

app.get('/api/whatsapp/calls/:callId', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const callId = readTrimmed(req.params?.callId)
        if (!callId) {
            return res.status(400).json(buildVersionedApiError(req, 'CALL_ID_REQUIRED', 'callId is required'))
        }

        const row = await getStoredWhatsappCall(supabase, {
            companyId: access.companyId,
            profileId: access.profileId,
            phoneNumberId: readTrimmed(req.query?.phoneNumberId || req.query?.phone_number_id) || null,
            callId
        })

        if (!row) {
            return res.status(404).json(buildVersionedApiError(req, 'WHATSAPP_CALL_NOT_FOUND', 'Call not found for this profile'))
        }

        return res.json(buildVersionedApiSuccess(req, {
            call: shapeVersionedWhatsappCall(row)
        }))
    } catch (error: any) {
        return sendVersionedApiError(req, res, error, 'Failed to load call details', 'WHATSAPP_CALL_LOAD_FAILED')
    }
})

app.post('/api/whatsapp/calls/request-permission', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return
        if (!(await requireAdminAccess(access, res))) return

        const { client, phoneNumberId } = await loadCallClientContext(access, req, 'body')
        const userWaId = readTrimmed(req.body?.customer_id || req.body?.user_wa_id || req.body?.userWaId || req.body?.to)
        if (!userWaId) {
            return res.status(400).json(buildVersionedApiError(req, 'CUSTOMER_ID_REQUIRED', 'customer_id is required'))
        }

        const bodyText = trimText(req.body?.body_text || req.body?.bodyText || req.body?.text)
            || 'We would like to call you to help support your request.'
        const permissionData = await client.getCallPermissions(userWaId, phoneNumberId)
        const permissionSummary = extractCallPermissionSummary(permissionData)
        if (!permissionSummary.canRequestPermission) {
            return res.status(409).json(buildVersionedApiError(
                req,
                'CALL_PERMISSION_REQUEST_NOT_ALLOWED',
                'Meta does not currently allow a new call permission request for this contact.'
            ))
        }

        try {
            const data = await client.sendCallPermissionRequest(userWaId, bodyText, phoneNumberId)
            const messageId = trimText(data?.messages?.[0]?.id) || null
            const requestRow = await insertWhatsappCallPermissionRequest(supabase, {
                companyId: access.companyId,
                profileId: access.profileId,
                phoneNumberId,
                customerWaId: userWaId,
                customerPhoneNumber: userWaId,
                requestMessageId: messageId,
                bodyText,
                status: 'sent',
                metaResponse: data
            })

            return res.json(buildVersionedApiSuccess(req, {
                customer_id: userWaId,
                phone_number_id: phoneNumberId,
                provider_response: data,
                request: requestRow || null
            }))
        } catch (error: any) {
            await insertWhatsappCallPermissionRequest(supabase, {
                companyId: access.companyId,
                profileId: access.profileId,
                phoneNumberId,
                customerWaId: userWaId,
                customerPhoneNumber: userWaId,
                bodyText,
                status: 'failed',
                metaError: error?.response || { message: error?.message || 'Failed to send call permission request' }
            })
            return sendVersionedApiError(req, res, error, 'Failed to send call permission request', 'WHATSAPP_CALL_PERMISSION_REQUEST_FAILED')
        }
    } catch (error: any) {
        return sendVersionedApiError(req, res, error, 'Failed to send call permission request', 'WHATSAPP_CALL_PERMISSION_REQUEST_FAILED')
    }
})

app.get('/api/whatsapp/calls/settings', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return
        const { client, phoneNumberId } = await loadCallClientContext(access, req, 'query')
        const data = await client.getPhoneNumberSettings(phoneNumberId, {
            includeSipCredentials: false
        })
        return res.json(buildVersionedApiSuccess(req, {
            phone_number_id: phoneNumberId,
            settings: data
        }))
    } catch (error: any) {
        return sendVersionedApiError(req, res, error, 'Failed to load call settings', 'WHATSAPP_CALL_SETTINGS_FAILED')
    }
})

app.post('/api/whatsapp/calls/settings/enable', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return
        if (!(await requireAdminAccess(access, res))) return

        const { client, phoneNumberId } = await loadCallClientContext(access, req, 'body')
        const data = await client.updatePhoneNumberSettings(phoneNumberId, {
            calling: {
                status: 'ENABLED'
            }
        })
        return res.json(buildVersionedApiSuccess(req, {
            phone_number_id: phoneNumberId,
            settings: data
        }))
    } catch (error: any) {
        return sendVersionedApiError(req, res, error, 'Failed to enable call settings', 'WHATSAPP_CALL_SETTINGS_ENABLE_FAILED')
    }
})

app.post('/api/whatsapp/calls/connect', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return
        if (!(await requireAdminAccess(access, res))) return

        const rawSession = req.body?.session
        const sessionSdpType = readTrimmed(rawSession?.sdp_type || rawSession?.sdpType).toLowerCase()
        const sessionSdp = readTrimmed(rawSession?.sdp)
        const session = sessionSdpType && sessionSdp
            ? {
                sdp_type: sessionSdpType as 'offer' | 'answer',
                sdp: sessionSdp
            }
            : undefined

        if (!session || session.sdp_type !== 'offer') {
            return res.status(400).json(buildVersionedApiError(
                req,
                'CALL_CONNECT_SESSION_REQUIRED',
                'connect requires session.sdp_type="offer" and session.sdp'
            ))
        }

        const data = await performCallAction({
            access,
            action: 'connect',
            phoneNumberId: readTrimmed(req.body?.phoneNumberId || req.body?.phone_number_id) || undefined,
            userWaId: readTrimmed(req.body?.customer_id || req.body?.to || req.body?.userWaId || req.body?.user_wa_id),
            session,
            bizOpaqueCallbackData: readTrimmed(req.body?.biz_opaque_callback_data || req.body?.bizOpaqueCallbackData) || undefined
        })
        return res.json(buildVersionedApiSuccess(req, {
            status: 'queued',
            ...data
        }))
    } catch (error: any) {
        return sendVersionedApiError(req, res, error, 'Failed to connect call', 'WHATSAPP_CALL_CONNECT_FAILED')
    }
})

app.post('/api/whatsapp/calls/:callId/pre-accept', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const rawSession = req.body?.session
        const sessionSdpType = readTrimmed(rawSession?.sdp_type || rawSession?.sdpType).toLowerCase()
        const sessionSdp = readTrimmed(rawSession?.sdp)
        const session = sessionSdpType && sessionSdp
            ? {
                sdp_type: sessionSdpType as 'offer' | 'answer',
                sdp: sessionSdp
            }
            : undefined

        if (!session || session.sdp_type !== 'answer') {
            return res.status(400).json(buildVersionedApiError(
                req,
                'CALL_PRE_ACCEPT_SESSION_REQUIRED',
                'pre-accept requires session.sdp_type="answer" and session.sdp'
            ))
        }

        const data = await performCallAction({
            access,
            action: 'pre_accept',
            phoneNumberId: readTrimmed(req.body?.phoneNumberId || req.body?.phone_number_id) || undefined,
            callId: readTrimmed(req.params?.callId),
            session,
            acceptLockToken: readTrimmed(req.body?.acceptLockToken || req.body?.accept_lock_token) || undefined
        })
        return res.json(buildVersionedApiSuccess(req, {
            status: 'queued',
            ...data
        }))
    } catch (error: any) {
        return sendVersionedApiError(req, res, error, 'Failed to pre-accept call', 'WHATSAPP_CALL_PRE_ACCEPT_FAILED')
    }
})

app.post('/api/whatsapp/calls/:callId/accept', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const rawSession = req.body?.session
        const sessionSdpType = readTrimmed(rawSession?.sdp_type || rawSession?.sdpType).toLowerCase()
        const sessionSdp = readTrimmed(rawSession?.sdp)
        const session = sessionSdpType && sessionSdp
            ? {
                sdp_type: sessionSdpType as 'offer' | 'answer',
                sdp: sessionSdp
            }
            : undefined

        if (!session || session.sdp_type !== 'answer') {
            return res.status(400).json(buildVersionedApiError(
                req,
                'CALL_ACCEPT_SESSION_REQUIRED',
                'accept requires session.sdp_type="answer" and session.sdp'
            ))
        }

        const data = await performCallAction({
            access,
            action: 'accept',
            phoneNumberId: readTrimmed(req.body?.phoneNumberId || req.body?.phone_number_id) || undefined,
            callId: readTrimmed(req.params?.callId),
            session,
            acceptLockToken: readTrimmed(req.body?.acceptLockToken || req.body?.accept_lock_token) || undefined
        })
        return res.json(buildVersionedApiSuccess(req, {
            status: 'queued',
            ...data
        }))
    } catch (error: any) {
        return sendVersionedApiError(req, res, error, 'Failed to accept call', 'WHATSAPP_CALL_ACCEPT_FAILED')
    }
})

app.post('/api/whatsapp/calls/:callId/reject', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const data = await performCallAction({
            access,
            action: 'reject',
            phoneNumberId: readTrimmed(req.body?.phoneNumberId || req.body?.phone_number_id) || undefined,
            callId: readTrimmed(req.params?.callId)
        })
        return res.json(buildVersionedApiSuccess(req, data))
    } catch (error: any) {
        return sendVersionedApiError(req, res, error, 'Failed to reject call', 'WHATSAPP_CALL_REJECT_FAILED')
    }
})

app.post('/api/whatsapp/calls/:callId/terminate', async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const data = await performCallAction({
            access,
            action: 'terminate',
            phoneNumberId: readTrimmed(req.body?.phoneNumberId || req.body?.phone_number_id) || undefined,
            callId: readTrimmed(req.params?.callId)
        })
        return res.json(buildVersionedApiSuccess(req, data))
    } catch (error: any) {
        return sendVersionedApiError(req, res, error, 'Failed to terminate call', 'WHATSAPP_CALL_TERMINATE_FAILED')
    }
})

app.get('/api/meta/whatsapp/onboarding/status', async (req: any, res: any) => {
    try {
        setDeprecatedRouteHeaders(res, '/api/v1/whatsapp/onboarding/status')
        const access = await resolveProfileAccess(req, res)
        if (!access) return
        res.json({
            success: true,
            ...(await buildOnboardingStatusData(access))
        })
    } catch (error: any) {
        const { status, payload } = toHttpErrorPayload(error, 'Failed to load onboarding status')
        res.status(status).json(payload)
    }
})

app.post('/api/meta/whatsapp/coexistence/start', async (req: any, res: any) => {
    try {
        setDeprecatedRouteHeaders(res, '/api/v1/whatsapp/coexistence/start')
        const access = await resolveProfileAccess(req, res)
        if (!access) return
        if (!(await requireAdminAccess(access, res))) return

        const appId = resolveMetaAppIdFromEnv()
        const appSecret = resolveMetaAppSecretFromEnv()
        const verifyToken = resolveMetaVerifyTokenFromEnv()
        if (!appId || !appSecret || !verifyToken) {
            return res.status(500).json({ success: false, error: 'Missing META_APP_ID/META_APP_SECRET/META_WEBHOOK_VERIFY_TOKEN or WABA equivalents' })
        }

        const configId = resolveMetaExistingAppConfigIdFromEnv() || resolveMetaEmbeddedSignupV4ConfigIdFromEnv()
        if (!configId) {
            return res.status(500).json({ success: false, error: 'Missing META_WA_EXISTING_APP_CONFIGURATION_ID or META_WA_EMBEDDED_SIGNUP_V4_CONFIGURATION_ID' })
        }

        const requestedBusinessId = readTrimmed(req.body?.businessId || req.query?.businessId) || null
        const requestedWabaId = readTrimmed(req.body?.wabaId || req.query?.wabaId) || null
        const requestedPhoneNumberId = readTrimmed(req.body?.phoneNumberId || req.query?.phoneNumberId) || null
        const redirectUri = resolveOauthRedirectUri(req)
        const apiVersion = resolveMetaGraphVersionFromEnv('v25.0')
        const state = randomBytes(16).toString('hex')
        const stateHash = hashOAuthState(state)
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
        const redirectUrl = sanitizeReturnUrl(req.body?.returnUrl || req.query?.returnUrl) || resolveOauthReturnUrl(req)

        const { error } = await supabase
            .from('waba_oauth_states')
            .insert({
                state_hash: stateHash,
                profile_id: access.profileId,
                company_id: access.companyId,
                user_id: access.user.id,
                requested_business_id: requestedBusinessId,
                requested_waba_id: requestedWabaId,
                requested_phone_number_id: requestedPhoneNumberId,
                redirect_url: redirectUrl,
                expires_at: expiresAt
            })

        if (error) {
            return res.status(500).json({ success: false, error: error.message })
        }

        const url = buildEmbeddedSignupUrl({
            appId,
            redirectUri,
            state,
            scopes: WABA_OAUTH_SCOPES,
            apiVersion,
            configId,
            includeScopes: resolveOauthMode(configId) === 'user',
            extras: {
                featureType: 'whatsapp_business_app_onboarding',
                sessionInfoVersion: '3'
            }
        })

        res.json({
            success: true,
            url,
            configuration_id: configId,
            feature_type: 'whatsapp_business_app_onboarding',
            session_info_version: '3'
        })
    } catch (error: any) {
        const { status, payload } = toHttpErrorPayload(error, 'Failed to start coexistence onboarding')
        res.status(status).json(payload)
    }
})

app.get('/api/meta/whatsapp/coexistence/status/:customerId', async (req: any, res: any) => {
    try {
        setDeprecatedRouteHeaders(res, '/api/v1/whatsapp/coexistence/status/:customerId')
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const customerId = trimText(req.params?.customerId)
        if (!customerId) {
            return res.status(400).json({ success: false, error: 'customerId is required' })
        }

        const rows = await getCompanyWhatsappConnections(access.companyId)
        const matches = rows.filter((row: any) => {
            const candidates = [
                trimText(row?.id),
                trimText(row?.business_id),
                trimText(row?.waba_id),
                trimText(row?.phone_number_id)
            ]
            return candidates.includes(customerId)
        })

        res.json({
            success: true,
            customer_id: customerId,
            connections: matches.map((row: any) => shapeWhatsAppConnectionRow(row))
        })
    } catch (error: any) {
        const { status, payload } = toHttpErrorPayload(error, 'Failed to load coexistence status')
        res.status(status).json(payload)
    }
})

app.get('/api/meta/whatsapp/webhooks/recent', async (req: any, res: any) => {
    try {
        setDeprecatedRouteHeaders(res, '/api/v1/whatsapp/webhooks/recent')
        const access = await resolveProfileAccess(req, res)
        if (!access) return
        if (!(await requireAdminAccess(access, res))) return

        const rows = await getRecentWhatsappRawWebhookEvents(supabase, {
            companyId: access.companyId,
            profileId: readTrimmed(req.query?.profileId || req.query?.profile_id) || undefined,
            eventType: mapRecentWebhookTypeFilter(req.query?.type) || undefined,
            limit: Number(req.query?.limit)
        })

        res.json({ success: true, events: rows })
    } catch (error: any) {
        const { status, payload } = toHttpErrorPayload(error, 'Failed to load recent webhook events')
        res.status(status).json(payload)
    }
})

app.get('/api/meta/whatsapp/calling/settings', async (req: any, res: any) => {
    try {
        setDeprecatedRouteHeaders(res, '/api/v1/whatsapp/calls/settings')
        const access = await resolveProfileAccess(req, res)
        if (!access) return
        const { client, phoneNumberId } = await loadCallClientContext(access, req, 'query')
        const data = await client.getPhoneNumberSettings(phoneNumberId, {
            includeSipCredentials: false
        })
        res.json({ success: true, data })
    } catch (error: any) {
        const normalized = toHttpErrorPayload(error, 'Failed to load call settings')
        res.status(normalized.status).json(normalized.payload)
    }
})

app.post('/api/meta/whatsapp/calling/settings/enable', async (req: any, res: any) => {
    try {
        setDeprecatedRouteHeaders(res, '/api/v1/whatsapp/calls/settings/enable')
        const access = await resolveProfileAccess(req, res)
        if (!access) return
        if (!(await requireAdminAccess(access, res))) return

        const { client, phoneNumberId } = await loadCallClientContext(access, req, 'body')
        const data = await client.updatePhoneNumberSettings(phoneNumberId, {
            calling: {
                status: 'ENABLED'
            }
        })
        res.json({ success: true, data })
    } catch (error: any) {
        const normalized = toHttpErrorPayload(error, 'Failed to enable call settings')
        res.status(normalized.status).json(normalized.payload)
    }
})

app.post('/api/meta/whatsapp/calling/connect', async (req: any, res: any) => {
    try {
        setDeprecatedRouteHeaders(res, '/api/v1/whatsapp/calls/connect')
        const access = await resolveProfileAccess(req, res)
        if (!access) return
        if (!(await requireAdminAccess(access, res))) return

        const rawSession = req.body?.session
        const sessionSdpType = readTrimmed(rawSession?.sdp_type || rawSession?.sdpType).toLowerCase()
        const sessionSdp = readTrimmed(rawSession?.sdp)
        const session = sessionSdpType && sessionSdp
            ? {
                sdp_type: sessionSdpType as 'offer' | 'answer',
                sdp: sessionSdp
            }
            : undefined

        if (!session || session.sdp_type !== 'offer') {
            return res.status(400).json({
                success: false,
                error: 'connect action requires session.sdp_type="offer" and session.sdp'
            })
        }

        await performCallAction({
            access,
            action: 'connect',
            phoneNumberId: readTrimmed(req.body?.phoneNumberId || req.body?.phone_number_id) || undefined,
            userWaId: readTrimmed(req.body?.to || req.body?.userWaId || req.body?.user_wa_id),
            session,
            bizOpaqueCallbackData: readTrimmed(req.body?.biz_opaque_callback_data || req.body?.bizOpaqueCallbackData) || undefined
        })
        res.json({ success: true })
    } catch (error: any) {
        if (error?.payload) {
            return res.status(error.status || 500).json(error.payload)
        }
        const { status, payload } = toHttpErrorPayload(error, 'Failed to connect call')
        res.status(status).json(payload)
    }
})

app.post('/api/meta/whatsapp/calling/:callId/pre-accept', async (req: any, res: any) => {
    try {
        setDeprecatedRouteHeaders(res, '/api/v1/whatsapp/calls/:callId/pre-accept')
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const rawSession = req.body?.session
        const sessionSdpType = readTrimmed(rawSession?.sdp_type || rawSession?.sdpType).toLowerCase()
        const sessionSdp = readTrimmed(rawSession?.sdp)
        const session = sessionSdpType && sessionSdp
            ? {
                sdp_type: sessionSdpType as 'offer' | 'answer',
                sdp: sessionSdp
            }
            : undefined

        if (!session || session.sdp_type !== 'answer') {
            return res.status(400).json({
                success: false,
                error: 'pre_accept action requires session.sdp_type="answer" and session.sdp'
            })
        }

        const data = await performCallAction({
            access,
            action: 'pre_accept',
            phoneNumberId: readTrimmed(req.body?.phoneNumberId || req.body?.phone_number_id) || undefined,
            callId: readTrimmed(req.params?.callId),
            session,
            acceptLockToken: readTrimmed(req.body?.acceptLockToken || req.body?.accept_lock_token) || undefined
        })
        res.json({ success: true, data })
    } catch (error: any) {
        if (error?.versionedError) {
            return res.status(error.status || 500).json({
                success: false,
                error: {
                    code: error.versionedError.code,
                    message: error.versionedError.message,
                    ...(error.versionedError.details !== undefined ? { details: error.versionedError.details } : {})
                }
            })
        }
        if (error?.payload) {
            return res.status(error.status || 500).json(error.payload)
        }
        const { status, payload } = toHttpErrorPayload(error, 'Failed to pre-accept call')
        res.status(status).json(payload)
    }
})

app.post('/api/meta/whatsapp/calling/:callId/accept', async (req: any, res: any) => {
    try {
        setDeprecatedRouteHeaders(res, '/api/v1/whatsapp/calls/:callId/accept')
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const rawSession = req.body?.session
        const sessionSdpType = readTrimmed(rawSession?.sdp_type || rawSession?.sdpType).toLowerCase()
        const sessionSdp = readTrimmed(rawSession?.sdp)
        const session = sessionSdpType && sessionSdp
            ? {
                sdp_type: sessionSdpType as 'offer' | 'answer',
                sdp: sessionSdp
            }
            : undefined

        if (!session || session.sdp_type !== 'answer') {
            return res.status(400).json({
                success: false,
                error: 'accept action requires session.sdp_type="answer" and session.sdp'
            })
        }

        const data = await performCallAction({
            access,
            action: 'accept',
            phoneNumberId: readTrimmed(req.body?.phoneNumberId || req.body?.phone_number_id) || undefined,
            callId: readTrimmed(req.params?.callId),
            session,
            acceptLockToken: readTrimmed(req.body?.acceptLockToken || req.body?.accept_lock_token) || undefined
        })
        res.json({ success: true, data })
    } catch (error: any) {
        if (error?.versionedError) {
            return res.status(error.status || 500).json({
                success: false,
                error: {
                    code: error.versionedError.code,
                    message: error.versionedError.message,
                    ...(error.versionedError.details !== undefined ? { details: error.versionedError.details } : {})
                }
            })
        }
        if (error?.payload) {
            return res.status(error.status || 500).json(error.payload)
        }
        const { status, payload } = toHttpErrorPayload(error, 'Failed to accept call')
        res.status(status).json(payload)
    }
})

app.post('/api/meta/whatsapp/calling/:callId/reject', async (req: any, res: any) => {
    try {
        setDeprecatedRouteHeaders(res, '/api/v1/whatsapp/calls/:callId/reject')
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const data = await performCallAction({
            access,
            action: 'reject',
            phoneNumberId: readTrimmed(req.body?.phoneNumberId || req.body?.phone_number_id) || undefined,
            callId: readTrimmed(req.params?.callId)
        })
        res.json({ success: true, data })
    } catch (error: any) {
        if (error?.versionedError) {
            return res.status(error.status || 500).json({
                success: false,
                error: {
                    code: error.versionedError.code,
                    message: error.versionedError.message,
                    ...(error.versionedError.details !== undefined ? { details: error.versionedError.details } : {})
                }
            })
        }
        if (error?.payload) {
            return res.status(error.status || 500).json(error.payload)
        }
        const { status, payload } = toHttpErrorPayload(error, 'Failed to reject call')
        res.status(status).json(payload)
    }
})

app.post('/api/meta/whatsapp/calling/:callId/terminate', async (req: any, res: any) => {
    try {
        setDeprecatedRouteHeaders(res, '/api/v1/whatsapp/calls/:callId/terminate')
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const data = await performCallAction({
            access,
            action: 'terminate',
            phoneNumberId: readTrimmed(req.body?.phoneNumberId || req.body?.phone_number_id) || undefined,
            callId: readTrimmed(req.params?.callId)
        })
        res.json({ success: true, data })
    } catch (error: any) {
        if (error?.versionedError) {
            return res.status(error.status || 500).json({
                success: false,
                error: {
                    code: error.versionedError.code,
                    message: error.versionedError.message,
                    ...(error.versionedError.details !== undefined ? { details: error.versionedError.details } : {})
                }
            })
        }
        if (error?.payload) {
            return res.status(error.status || 500).json(error.payload)
        }
        const { status, payload } = toHttpErrorPayload(error, 'Failed to terminate call')
        res.status(status).json(payload)
    }
})

// Start/manage/terminate WhatsApp calls.
app.post('/api/waba/calls', async (req: any, res: any) => {
    try {
        setDeprecatedRouteHeaders(res, '/api/v1/whatsapp/calls/*')
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const action = readTrimmed(req.body?.action).toLowerCase()
        const allowedActions = new Set(['connect', 'pre_accept', 'accept', 'reject', 'terminate'])
        if (!allowedActions.has(action)) {
            return res.status(400).json({ success: false, error: 'action must be one of: connect, pre_accept, accept, reject, terminate' })
        }

        if (action === 'connect' && !(await requireAdminAccess(access, res))) return

        const to = readTrimmed(req.body?.to || req.body?.userWaId || req.body?.user_wa_id) || undefined
        const callId = readTrimmed(req.body?.call_id || req.body?.callId) || undefined
        const phoneNumberId = readTrimmed(req.body?.phoneNumberId || req.body?.phone_number_id) || undefined
        const callbackData = readTrimmed(req.body?.biz_opaque_callback_data || req.body?.bizOpaqueCallbackData)
        if (callbackData.length > 512) {
            return res.status(400).json({ success: false, error: 'biz_opaque_callback_data max length is 512 characters' })
        }

        const rawSession = req.body?.session
        const sessionSdpType = readTrimmed(rawSession?.sdp_type || rawSession?.sdpType).toLowerCase()
        const sessionSdp = readTrimmed(rawSession?.sdp)
        const session = sessionSdpType && sessionSdp
            ? {
                sdp_type: sessionSdpType as 'offer' | 'answer',
                sdp: sessionSdp
            }
            : undefined

        if ((action === 'pre_accept' || action === 'accept') && (!session || session.sdp_type !== 'answer')) {
            return res.status(400).json({
                success: false,
                error: `${action} action requires session.sdp_type="answer" and session.sdp`
            })
        }

        if (action === 'connect' && (!session || session.sdp_type !== 'offer')) {
            return res.status(400).json({
                success: false,
                error: 'connect action requires session.sdp_type="offer" and session.sdp'
            })
        }

        const data = await performCallAction({
            access,
            action: action as 'connect' | 'pre_accept' | 'accept' | 'reject' | 'terminate',
            phoneNumberId,
            callId,
            userWaId: to,
            session,
            bizOpaqueCallbackData: callbackData || undefined,
            acceptLockToken: readTrimmed(req.body?.acceptLockToken || req.body?.accept_lock_token) || undefined
        })

        res.json({ success: true, data })
    } catch (error: any) {
        if (error?.versionedError) {
            return res.status(error.status || 500).json({
                success: false,
                error: {
                    code: error.versionedError.code,
                    message: error.versionedError.message,
                    ...(error.versionedError.details !== undefined ? { details: error.versionedError.details } : {})
                }
            })
        }
        if (error?.payload) {
            return res.status(error.status || 500).json(error.payload)
        }
        const { status, payload } = toHttpErrorPayload(error, 'Failed to manage call')
        res.status(status).json(payload)
    }
})

}
