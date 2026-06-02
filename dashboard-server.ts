
import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { createHash, randomBytes } from 'crypto'
import type { Socket as NetSocket } from 'net'
import webpush from 'web-push'
import * as addon from './src/addon'
import { resolvePath } from './src/config'
import { supabase, supabaseAuth } from './src/supabase'
import { WabaRegistry } from './src/waba/registry'
import { parseWabaWebhook, verifyWabaSignature } from './src/waba/webhook'
import type { WabaInboundMessage, WabaStatus, WabaConfig, WabaCallUpdate } from './src/waba/types'
import { ADS_SHOOT_SIMULATED_TAG, LEGACY_ADS_SHOOT_SIMULATED_TAG, resolveCompanyId, findOrCreateUser, getMessagesForUsers, getMessagesForUsersSince, getUsersForCompany, insertMessage, getUserByPhone, deleteMessagesForUser, deleteUserById, normalizePhoneNumber, isGroupIdentifier, updateMessageStatusByMessageId, updateUserName, setUserAlias, setUserTags, getUsersWithExpiringWindow, updateUserWindowReminder, activateUserCtaFreeWindow, getUserById, assignUserToAgentIfUnassigned, setUserAssignee, hasHumanTakeover, setUserHumanTakeover, setUserTemplateAttributes } from './src/services/wa-store'
import type { MessageRecord, User as WaStoreUser } from './src/services/wa-store'
import { sendWhatsAppMessage } from './src/services/whatsapp'
import { createDownloadUrl, isR2Configured } from './src/services/r2-storage'
import { WorkflowEngine } from './src/workflow/engine'
import { encryptToken, decryptToken, getTokenEncryptionKey } from './src/services/token-vault'
import { exchangeCodeForToken, exchangeForLongLivedToken, fetchBusinesses, fetchOwnedWabaAccounts, fetchClientWabaAccounts, fetchPhoneNumbers, subscribeWabaApp, createSystemUserToken, unsubscribeWabaApp, fetchClientBusinessId, fetchBusinessIntegrationSystemUserToken } from './src/services/meta-graph'
import { createApiKeyStore } from './dashboard-server/services/apiKeyStore'
import { createWebhookStore } from './dashboard-server/services/webhookStore'
import { registerFlowRoutes } from './dashboard-server/routes/flowRoutes'
import { registerPublicInfoRoutes } from './dashboard-server/routes/publicInfoRoutes'
import { registerPublicAuthRoutes } from './dashboard-server/routes/publicAuthRoutes'
import { registerWabaRoutes } from './dashboard-server/routes/wabaRoutes'
import { registerCompanyRoutes } from './dashboard-server/routes/companyRoutes'
import { registerStoreRoutes } from './dashboard-server/routes/storeRoutes'
import { registerAiRoutes } from './dashboard-server/routes/aiRoutes'
import { getCompanyAiSettings } from './dashboard-server/services/aiSettingsSupabase'
import { loadOpenAiMemoryForUser, requestOpenAiCompletion, type OpenAiChatMessage } from './dashboard-server/services/openaiAssistant'
import { createPushSubscriptionStore } from './dashboard-server/services/pushSubscriptionStore'
import { createNativePushTokenStore } from './dashboard-server/services/nativePushTokenStore'
import { createNativeFcmPushSender } from './dashboard-server/services/fcmNativePush'
import { createSystemRuntimeStatusStore } from './dashboard-server/services/systemRuntimeStatusStore'
import { registerSocketHandlers } from './dashboard-server/socket/registerSocketHandlers'
import { errorHandler } from './dashboard-server/middleware/error'
import { requireSupabaseUser } from './dashboard-server/middleware/auth'

// Helper functions replaced by store methods
const app = express()
app.use(cors())
app.use(express.json({
    verify: (req, _res, buf) => {
        ;(req as any).rawBody = buf
    }
}))

const httpServer = createServer(app)
const activeSockets = new Set<NetSocket>()

type ApiRequestSample = {
    ts: number
    route: string
    status: number
    durationMs: number
    inBytes: number
    outBytes: number
}

type ApiRouteAggregate = {
    count: number
    errorCount: number
    totalDurationMs: number
    maxDurationMs: number
    inBytes: number
    outBytes: number
    lastStatus: number
    lastHitAt: number
}

const API_MONITOR_WINDOW_MS = 5 * 60 * 1000
const API_MONITOR_MAX_RECENT = 4000
const apiMonitor = {
    startedAt: Date.now(),
    totalCalls: 0,
    status2xx: 0,
    status3xx: 0,
    status4xx: 0,
    status5xx: 0,
    inBytes: 0,
    outBytes: 0,
    recent: [] as ApiRequestSample[],
    routes: new Map<string, ApiRouteAggregate>()
}

let socketTrafficTotals = {
    inBytes: 0,
    outBytes: 0
}

function safeParseByteHeader(value: unknown): number {
    if (typeof value === 'number') {
        return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
    }
    if (typeof value === 'string') {
        const parsed = Number.parseInt(value, 10)
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
    }
    if (Array.isArray(value) && value.length > 0) {
        return safeParseByteHeader(value[0])
    }
    return 0
}

function normalizeApiPathForMonitoring(pathname: string): string {
    if (!pathname) return '/'
    return pathname
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, ':uuid')
        .replace(/\/\d+(?=\/|$)/g, '/:id')
        .replace(/\/[A-Za-z0-9_-]{18,}(?=\/|$)/g, '/:token')
}

function pruneRecentApiMonitorSamples(now = Date.now()) {
    const threshold = now - API_MONITOR_WINDOW_MS
    while (apiMonitor.recent.length > 0 && apiMonitor.recent[0].ts < threshold) {
        apiMonitor.recent.shift()
    }
    if (apiMonitor.recent.length > API_MONITOR_MAX_RECENT) {
        apiMonitor.recent.splice(0, apiMonitor.recent.length - API_MONITOR_MAX_RECENT)
    }
}

app.use((req: any, res: any, next: any) => {
    const rawPath = typeof req.path === 'string' ? req.path : ''
    const trackAsApi = rawPath.startsWith('/api/') || rawPath === '/health'
    if (!trackAsApi) {
        next()
        return
    }

    const startedAt = Date.now()
    const inBytes = safeParseByteHeader(req.headers?.['content-length'])
    const method = typeof req.method === 'string' ? req.method.toUpperCase() : 'GET'
    const route = `${method} ${normalizeApiPathForMonitoring(rawPath)}`

    res.on('finish', () => {
        const endedAt = Date.now()
        const status = Number.isFinite(res.statusCode) ? Number(res.statusCode) : 0
        const durationMs = Math.max(0, endedAt - startedAt)
        const outBytes = safeParseByteHeader(res.getHeader?.('content-length'))

        apiMonitor.totalCalls += 1
        apiMonitor.inBytes += inBytes
        apiMonitor.outBytes += outBytes
        if (status >= 500) apiMonitor.status5xx += 1
        else if (status >= 400) apiMonitor.status4xx += 1
        else if (status >= 300) apiMonitor.status3xx += 1
        else if (status >= 200) apiMonitor.status2xx += 1

        apiMonitor.recent.push({
            ts: endedAt,
            route,
            status,
            durationMs,
            inBytes,
            outBytes
        })
        pruneRecentApiMonitorSamples(endedAt)

        const previous = apiMonitor.routes.get(route)
        if (previous) {
            previous.count += 1
            previous.totalDurationMs += durationMs
            previous.maxDurationMs = Math.max(previous.maxDurationMs, durationMs)
            previous.inBytes += inBytes
            previous.outBytes += outBytes
            previous.lastStatus = status
            previous.lastHitAt = endedAt
            if (status >= 500) previous.errorCount += 1
        } else {
            apiMonitor.routes.set(route, {
                count: 1,
                errorCount: status >= 500 ? 1 : 0,
                totalDurationMs: durationMs,
                maxDurationMs: durationMs,
                inBytes,
                outBytes,
                lastStatus: status,
                lastHitAt: endedAt
            })
        }
    })

    next()
})

httpServer.on('connection', (socket) => {
    activeSockets.add(socket)
    socket.on('close', () => {
        activeSockets.delete(socket)
    })
})
const io = new Server(httpServer, {
    cors: { origin: '*' }
})

const systemRuntimeStatus = createSystemRuntimeStatusStore({
    filePath: resolvePath('system_runtime_status.json')
})

type TeamRole = 'owner' | 'admin' | 'agent'
type TeamDepartment = 'finance' | 'sales' | 'marketing' | 'production' | 'custom'

const TENANT_ROOT_DOMAIN = String(process.env.TENANT_ROOT_DOMAIN || '2fast.xyz').trim().toLowerCase()
const RESERVED_TENANT_SUBDOMAINS = new Set(['www', 'admin', 'myadmin'])
const TEAM_DEPARTMENTS = new Set<TeamDepartment>(['finance', 'sales', 'marketing', 'production', 'custom'])

const TEAM_ROLE_ORDER: Record<TeamRole, number> = {
    agent: 1,
    admin: 2,
    owner: 3
}

const AGENT_BADGE_COLORS = [
    '#0ea5e9',
    '#10b981',
    '#f59e0b',
    '#ef4444',
    '#8b5cf6',
    '#06b6d4',
    '#ec4899',
    '#84cc16',
    '#14b8a6',
    '#f97316'
]

function normalizeTeamRole(input: any): TeamRole {
    const value = typeof input === 'string' ? input.trim().toLowerCase() : ''
    if (value === 'owner' || value === 'admin' || value === 'agent') return value
    return 'agent'
}

function normalizeTeamDepartment(input: any): TeamDepartment {
    const value = typeof input === 'string' ? input.trim().toLowerCase() : ''
    if (TEAM_DEPARTMENTS.has(value as TeamDepartment)) return value as TeamDepartment
    return 'custom'
}

function normalizeTeamCustomDepartment(input: any): string | null {
    const value = typeof input === 'string' ? input.trim() : ''
    if (!value) return null
    return value.slice(0, 64)
}

function parseHostnameFromHeaderValue(value: any): string {
    const raw = Array.isArray(value) ? String(value[0] || '') : typeof value === 'string' ? value : ''
    const first = raw.split(',')[0]?.trim().toLowerCase() || ''
    if (!first) return ''
    return first.replace(/:\d+$/, '')
}

function getHostnameFromHeaders(headers: any): string {
    return parseHostnameFromHeaderValue(headers?.['x-forwarded-host']) || parseHostnameFromHeaderValue(headers?.host)
}

function resolveCompanyIdFromHostname(hostname: string): string | null {
    if (!hostname) return null
    if (hostname === TENANT_ROOT_DOMAIN) return null
    if (hostname === 'localhost' || hostname === '127.0.0.1' || /^[0-9.]+$/.test(hostname)) return null

    const suffix = `.${TENANT_ROOT_DOMAIN}`
    if (!hostname.endsWith(suffix)) return null

    const label = hostname.slice(0, -suffix.length)
    if (!label || label.includes('.')) return null
    if (RESERVED_TENANT_SUBDOMAINS.has(label)) return null
    if (!/^[a-z0-9-]+$/.test(label)) return null
    return label
}

function normalizeCompanyId(value: any): string {
    const raw = typeof value === 'string' ? value.trim() : value ? String(value).trim() : ''
    return raw.toLowerCase()
}

function hasRoleAtLeast(role: TeamRole, minimum: TeamRole): boolean {
    return TEAM_ROLE_ORDER[normalizeTeamRole(role)] >= TEAM_ROLE_ORDER[normalizeTeamRole(minimum)]
}

function computeAgentColor(userId: string): string {
    if (!userId) return AGENT_BADGE_COLORS[0]
    let hash = 0
    for (let i = 0; i < userId.length; i += 1) {
        hash = (hash * 31 + userId.charCodeAt(i)) >>> 0
    }
    return AGENT_BADGE_COLORS[hash % AGENT_BADGE_COLORS.length]
}

function deriveAgentName(user: any): string {
    const candidates = [
        user?.user_metadata?.full_name,
        user?.user_metadata?.name,
        user?.user_metadata?.display_name,
        user?.email ? String(user.email).split('@')[0] : null,
        user?.id
    ]
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim()
        }
    }
    return 'Agent'
}

function buildAgentIdentity(user: any): { user_id: string; name: string; color: string } {
    const userId = typeof user?.id === 'string' ? user.id : ''
    return {
        user_id: userId,
        name: deriveAgentName(user),
        color: computeAgentColor(userId)
    }
}

function getCompanyRoom(companyId: string): string {
    return `company:${companyId}`
}

function normalizeTemplateAttributesForContact(value: any): Array<{
    templateName: string
    language: string
    scope: 'body' | 'header'
    index: number
    key: string
    value: string
    savedAt: string
}> {
    if (!Array.isArray(value)) return []

    return value
        .map((row: any) => {
            const templateName = typeof row?.templateName === 'string' ? row.templateName.trim() : ''
            const key = typeof row?.key === 'string' ? row.key.trim() : ''
            const itemValue = typeof row?.value === 'string' ? row.value.trim() : ''
            if (!templateName || !key || !itemValue) return null
            const language = typeof row?.language === 'string' && row.language.trim() ? row.language.trim() : 'en_US'
            const parsedIndex = Number.parseInt(String(row?.index ?? ''), 10)
            const index = Number.isFinite(parsedIndex) && parsedIndex > 0 ? Math.min(parsedIndex, 99) : 1
            const scope = typeof row?.scope === 'string' && row.scope.toLowerCase() === 'header' ? 'header' : 'body'
            const savedAtRaw = typeof row?.savedAt === 'string' ? row.savedAt.trim() : ''
            const parsedSavedAt = savedAtRaw ? new Date(savedAtRaw).getTime() : Number.NaN
            const savedAt = Number.isNaN(parsedSavedAt) ? '' : new Date(parsedSavedAt).toISOString()
            return {
                templateName: templateName.slice(0, 128),
                language: language.slice(0, 24),
                scope,
                index,
                key: key.slice(0, 120),
                value: itemValue.slice(0, 400),
                savedAt
            }
        })
        .filter(Boolean)
        .slice(0, 80)
}

function buildContactPayload(user: any) {
    const phone = normalizePhoneNumber(user?.phone_number)
    const jidDomain = isGroupIdentifier(user?.phone_number || phone) ? '@g.us' : '@s.whatsapp.net'
    const jid = phone ? `${phone}${jidDomain}` : `${user?.phone_number || ''}${jidDomain}`
    const whatsappName = typeof user?.name === 'string' && user.name.trim() ? user.name.trim() : null
    const alias = typeof user?.alias === 'string' && user.alias.trim() ? user.alias.trim() : null
    const displayName = alias || whatsappName || phone || user?.phone_number || ''
    return {
        id: jid,
        profileId: typeof user?.profile_id === 'string' && user.profile_id.trim() ? user.profile_id.trim() : null,
        name: displayName,
        alias,
        whatsappName,
        lastInboundAt: user?.last_inbound_at || null,
        tags: user?.tags || [],
        humanTakeover: hasHumanTakeover(user),
        assigneeUserId: user?.assigned_to_user_id || null,
        assigneeName: user?.assigned_to_name || null,
        assigneeColor: user?.assigned_to_color || null,
        ctaReferralAt: user?.cta_referral_at || null,
        ctaFreeWindowStartedAt: user?.cta_free_window_started_at || null,
        ctaFreeWindowExpiresAt: user?.cta_free_window_expires_at || null,
        templateAttributes: normalizeTemplateAttributesForContact(user?.template_attributes)
    }
}

type CpuSnapshot = { idle: number; total: number }

function readCpuSnapshot(): CpuSnapshot {
    const cpus = os.cpus()
    let idle = 0
    let total = 0
    cpus.forEach(cpu => {
        const times = cpu.times
        idle += times.idle
        total += times.user + times.nice + times.sys + times.irq + times.idle
    })
    return { idle, total }
}

let lastCpuSnapshot: CpuSnapshot | null = null
type NetSnapshot = { bytesRead: number; bytesWritten: number; timestamp: number }
let lastNetSnapshot: NetSnapshot | null = null
let lastServerStats: any | null = null

function readNetworkSnapshot(): { bytesRead: number; bytesWritten: number } {
    let bytesRead = 0
    let bytesWritten = 0
    activeSockets.forEach((socket) => {
        bytesRead += socket.bytesRead || 0
        bytesWritten += socket.bytesWritten || 0
    })
    return { bytesRead, bytesWritten }
}

function broadcastServerStats() {
    const snapshot = readCpuSnapshot()
    const now = Date.now()
    let cpuUsage = 0
    if (!lastCpuSnapshot) {
        lastCpuSnapshot = snapshot
    } else {
        const idleDelta = snapshot.idle - lastCpuSnapshot.idle
        const totalDelta = snapshot.total - lastCpuSnapshot.total
        cpuUsage = totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0
        lastCpuSnapshot = snapshot
    }

    const memTotal = os.totalmem()
    const memFree = os.freemem()
    const memUsed = memTotal - memFree
    const memPct = memTotal > 0 ? (memUsed / memTotal) * 100 : 0
    const memory = process.memoryUsage()

    const netNow = readNetworkSnapshot()
    let bandwidth = { inBps: 0, outBps: 0, inBytes: 0, outBytes: 0 }
    if (!lastNetSnapshot) {
        lastNetSnapshot = { ...netNow, timestamp: now }
    } else {
        const elapsedSec = Math.max(1, (now - lastNetSnapshot.timestamp) / 1000)
        const inBytes = Math.max(0, netNow.bytesRead - lastNetSnapshot.bytesRead)
        const outBytes = Math.max(0, netNow.bytesWritten - lastNetSnapshot.bytesWritten)
        socketTrafficTotals.inBytes += inBytes
        socketTrafficTotals.outBytes += outBytes
        bandwidth = {
            inBps: inBytes / elapsedSec,
            outBps: outBytes / elapsedSec,
            inBytes,
            outBytes
        }
        lastNetSnapshot = { ...netNow, timestamp: now }
    }

    const payload = {
        cpu: Number(cpuUsage.toFixed(1)),
        memUsed,
        memTotal,
        memPct: Number(memPct.toFixed(1)),
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        bandwidth,
        timestamp: now
    }

    lastServerStats = payload
    io.emit('server.stats', payload)
}

broadcastServerStats()
setInterval(() => {
    broadcastServerStats()
}, 10_000)

const wabaRegistry = new WabaRegistry()
wabaRegistry.refresh(true).catch((err) => console.error('[WABA] Initial load failed:', err))
setInterval(() => {
    wabaRegistry.refresh().catch((err) => console.error('[WABA] Refresh failed:', err))
}, 60_000)

const WABA_OAUTH_SCOPES = [
    'whatsapp_business_management',
    'whatsapp_business_messaging',
    'business_management'
]

const WINDOW_MS = 24 * 60 * 60 * 1000
const DEFAULT_REMINDER_TEXT = 'Heads up! Our 24h reply window closes soon. Reply now if you need anything.'
const reminderRunningProfiles = new Set<string>()
const reminderCache = new Map<string, number>()
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'
const ADS_SHOOT_MODE_FILE = resolvePath('ads_shoot_mode.json')
const ADS_SHOOT_MODE_BATCH_SIZE = 15
const ADS_SHOOT_MODE_NIGHT_START_HOUR = 20
const ADS_SHOOT_MODE_NIGHT_END_HOUR = 23
const GYM_SHOWCASE_WORKFLOW_ID = 'wf-gym-auto-reply'
const GYM_SHOWCASE_SOURCE = 'gym_showcase_boost'
const GYM_SHOWCASE_BOOST_COUNT = 5
const GYM_SHOWCASE_COOLDOWN_MS = 90 * 1000
const GYM_SHOWCASE_MIN_GAP_MS = 18 * 1000

type AdsShootLeadTemplate = {
    name: string
    text: string
}

type AdsShootLead = AdsShootLeadTemplate & {
    phone: string
}

type GymShowcaseLead = {
    name: string
    phone: string
    followupButtonId: 'location' | 'hours'
    followupButtonTitle: 'Gym Location' | 'Operating Hours'
}

type AdsShootModeProfileConfig = {
    companyId: string
    profileId: string
    enabled: boolean
    lastRunLocalDate: string | null
    updatedAt: string
}

type AdsShootModeStoreData = {
    profiles: Record<string, AdsShootModeProfileConfig>
}

const ADS_SHOOT_LEAD_TEMPLATES: AdsShootLeadTemplate[] = [
    { name: 'Aiman Rahman', text: 'Hi, how much is the monthly membership?' },
    { name: 'Nurul Aisyah', text: 'Do you have free trial for new member?' },
    { name: 'Daniel Lee', text: 'Can I join tonight if I sign up now?' },
    { name: 'Siti Hajar', text: 'Is there personal trainer package available?' },
    { name: 'Jonathan Tan', text: 'Hi, what is your gym operating hour today?' },
    { name: 'Farah Nabila', text: 'Do you have ladies class or ladies area?' },
    { name: 'Marcus Lim', text: 'Can I pay by card or ewallet for membership?' },
    { name: 'Syafiq Azman', text: 'Any promo for student membership this month?' },
    { name: 'Emily Wong', text: 'I want to lose weight. Which plan is best for beginner?' },
    { name: 'Hafiz Roslan', text: 'If I register now, when can I start using the gym?' },
    { name: 'Sarah Collins', text: 'Do you offer group class like HIIT or yoga?' },
    { name: 'Amirul Hakim', text: 'How much for personal trainer per session?' },
    { name: 'Chloe Adams', text: 'Can I freeze my membership if I travel next month?' },
    { name: 'Izzati Sofea', text: 'Do you have shower, locker and parking at your gym?' },
    { name: 'Brandon Clarke', text: 'Hi there, is there any annual package discount?' },
    { name: 'Hakim Iskandar', text: 'Can my friend and I join together with better price?' },
    { name: 'Nadia Yasmin', text: 'Is there onboarding session for first timer?' },
    { name: 'Ethan Miller', text: 'Do you have 24-hour access membership?' },
    { name: 'Alicia Teoh', text: 'Can I book a gym tour before I decide to join?' },
    { name: 'Faris Danish', text: 'What documents do I need to register membership?' }
]

const adsShootModeRunningProfiles = new Set<string>()
const adsShootModeStore: AdsShootModeStoreData = loadAdsShootModeStore()
const gymShowcaseRunningProfiles = new Set<string>()
const gymShowcaseLastTriggeredByProfile = new Map<string, number>()

function normalizeAdsShootModeEnabled(value: unknown): boolean {
    if (value === true) return true
    if (value === false) return false
    if (value === 1) return true
    if (value === 0) return false
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase()
        return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
    }
    return false
}

function isAdsShootStorePayload(value: unknown): value is AdsShootModeStoreData {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const profiles = (value as any).profiles
    return !!profiles && typeof profiles === 'object' && !Array.isArray(profiles)
}

function buildAdsShootConfigKey(companyId: string, profileId: string) {
    return `${companyId}::${profileId}`
}

function buildDefaultAdsShootModeProfileConfig(companyId: string, profileId: string): AdsShootModeProfileConfig {
    return {
        companyId,
        profileId,
        enabled: false,
        lastRunLocalDate: null,
        updatedAt: new Date().toISOString()
    }
}

function loadAdsShootModeStore(): AdsShootModeStoreData {
    try {
        if (!fs.existsSync(ADS_SHOOT_MODE_FILE)) return { profiles: {} }
        const raw = fs.readFileSync(ADS_SHOOT_MODE_FILE, 'utf-8')
        const parsed = raw ? JSON.parse(raw) : null
        if (!isAdsShootStorePayload(parsed)) return { profiles: {} }

        const profiles: Record<string, AdsShootModeProfileConfig> = {}
        for (const [key, value] of Object.entries(parsed.profiles || {})) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) continue
            const companyId = typeof (value as any).companyId === 'string' ? (value as any).companyId.trim() : ''
            const profileId = typeof (value as any).profileId === 'string' ? (value as any).profileId.trim() : ''
            if (!companyId || !profileId) continue
            const normalizedKey = buildAdsShootConfigKey(companyId, profileId)
            profiles[normalizedKey || key] = {
                companyId,
                profileId,
                enabled: normalizeAdsShootModeEnabled((value as any).enabled),
                lastRunLocalDate: typeof (value as any).lastRunLocalDate === 'string' ? (value as any).lastRunLocalDate : null,
                updatedAt: typeof (value as any).updatedAt === 'string' ? (value as any).updatedAt : new Date().toISOString()
            }
        }
        return { profiles }
    } catch (error: any) {
        console.warn('[AdsShootMode] Failed to load mode store:', error?.message || error)
        return { profiles: {} }
    }
}

function saveAdsShootModeStore() {
    try {
        fs.writeFileSync(ADS_SHOOT_MODE_FILE, JSON.stringify(adsShootModeStore, null, 2), 'utf-8')
    } catch (error: any) {
        console.warn('[AdsShootMode] Failed to save mode store:', error?.message || error)
    }
}

function getAdsShootModeProfileConfig(companyId: string, profileId: string): AdsShootModeProfileConfig {
    const key = buildAdsShootConfigKey(companyId, profileId)
    const existing = adsShootModeStore.profiles[key]
    if (existing) {
        return {
            ...existing,
            companyId,
            profileId
        }
    }
    return buildDefaultAdsShootModeProfileConfig(companyId, profileId)
}

function upsertAdsShootModeProfileConfig(config: AdsShootModeProfileConfig) {
    const key = buildAdsShootConfigKey(config.companyId, config.profileId)
    adsShootModeStore.profiles[key] = {
        ...config,
        updatedAt: new Date().toISOString()
    }
    saveAdsShootModeStore()
}

function getLocalDateKey(date: Date): string {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
}

function buildAdsShootLeadPhone(profileId: string, localDateKey: string, index: number): string {
    const seed = createHash('sha256')
        .update(`${profileId}:${localDateKey}:${index}`)
        .digest('hex')
    const randomPart = 10_000_000 + (Number.parseInt(seed.slice(0, 8), 16) % 90_000_000)
    return `6011${String(randomPart)}`
}

function buildAdsShootLeads(profileId: string, localDateKey: string, count: number): AdsShootLead[] {
    const seed = createHash('sha256')
        .update(`ads-shoot:${profileId}:${localDateKey}`)
        .digest('hex')
    const offset = Number.parseInt(seed.slice(0, 6), 16) % ADS_SHOOT_LEAD_TEMPLATES.length
    const leads: AdsShootLead[] = []
    for (let index = 0; index < count; index += 1) {
        const template = ADS_SHOOT_LEAD_TEMPLATES[(offset + index) % ADS_SHOOT_LEAD_TEMPLATES.length]
        leads.push({
            name: template.name,
            text: template.text,
            phone: buildAdsShootLeadPhone(profileId, localDateKey, index)
        })
    }
    return leads
}

function createDeterministicRng(seedText: string): () => number {
    const digest = createHash('sha256').update(seedText).digest()
    let state = digest.readUInt32LE(0) || 1
    return () => {
        state = (state + 0x6D2B79F5) >>> 0
        let t = Math.imul(state ^ (state >>> 15), 1 | state)
        t ^= t + Math.imul(t ^ (t >>> 7), 61 | t)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

function buildAdsShootRandomizedTimestamps(config: AdsShootModeProfileConfig, source: 'manual' | 'nightly', count: number): number[] {
    const nowMs = Date.now()
    const now = new Date(nowMs)

    let windowStartMs = nowMs - (3 * 60 * 60 * 1000)
    let windowEndMs = nowMs
    if (source === 'nightly') {
        const start = new Date(now)
        start.setHours(ADS_SHOOT_MODE_NIGHT_START_HOUR, 0, 0, 0)
        windowStartMs = Math.min(start.getTime(), nowMs)
        windowEndMs = nowMs
    }

    if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs) || windowEndMs <= windowStartMs) {
        const fallback = Math.floor(nowMs / 1000)
        return Array.from({ length: count }, (_, index) => fallback + index)
    }

    const rng = createDeterministicRng(`ads-shoot-time:${config.profileId}:${source}:${getLocalDateKey(now)}`)
    const minGapMs = 25 * 1000
    const randomMs = Array.from({ length: count }, () => {
        const value = windowStartMs + Math.floor((windowEndMs - windowStartMs) * rng())
        return value
    }).sort((a, b) => a - b)

    for (let index = 1; index < randomMs.length; index += 1) {
        if (randomMs[index] <= randomMs[index - 1]) {
            randomMs[index] = randomMs[index - 1] + minGapMs
        }
    }

    const capMs = windowEndMs + (count * minGapMs)
    for (let index = 0; index < randomMs.length; index += 1) {
        if (randomMs[index] > capMs) randomMs[index] = capMs + (index * 1000)
    }

    return randomMs.map((value) => Math.max(1, Math.floor(value / 1000)))
}

function buildRandomizedTimelineUnixSeconds(
    seedText: string,
    count: number,
    windowStartMs: number,
    windowEndMs: number,
    minGapMs: number
): number[] {
    if (count <= 0) return []
    const nowMs = Date.now()
    if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs) || windowEndMs <= windowStartMs) {
        const fallback = Math.floor(nowMs / 1000)
        return Array.from({ length: count }, (_, index) => fallback + index)
    }

    const rng = createDeterministicRng(seedText)
    const randomMs = Array.from({ length: count }, () => {
        const value = windowStartMs + Math.floor((windowEndMs - windowStartMs) * rng())
        return value
    }).sort((a, b) => a - b)

    const gap = Math.max(1000, minGapMs)
    for (let index = 1; index < randomMs.length; index += 1) {
        if (randomMs[index] <= randomMs[index - 1]) {
            randomMs[index] = randomMs[index - 1] + gap
        }
    }

    const capMs = windowEndMs + (count * gap)
    for (let index = 0; index < randomMs.length; index += 1) {
        if (randomMs[index] > capMs) randomMs[index] = capMs + (index * 1000)
    }

    return randomMs.map((value) => Math.max(1, Math.floor(value / 1000)))
}

function buildGymShowcaseLeads(profileId: string, triggerPhone: string, count: number): GymShowcaseLead[] {
    const now = new Date()
    const seed = createHash('sha256')
        .update(`gym-showcase:${profileId}:${triggerPhone}:${now.toISOString()}:${randomBytes(4).toString('hex')}`)
        .digest('hex')
    const offset = Number.parseInt(seed.slice(0, 6), 16) % ADS_SHOOT_LEAD_TEMPLATES.length
    const phoneSeedKey = `${getLocalDateKey(now)}-gym-${seed.slice(0, 12)}`
    const leads: GymShowcaseLead[] = []
    for (let index = 0; index < count; index += 1) {
        const template = ADS_SHOOT_LEAD_TEMPLATES[(offset + index) % ADS_SHOOT_LEAD_TEMPLATES.length]
        let phone = buildAdsShootLeadPhone(profileId, phoneSeedKey, index)
        if (phone === triggerPhone) {
            phone = buildAdsShootLeadPhone(profileId, `${phoneSeedKey}-alt`, index)
        }
        const rngNibble = Number.parseInt(seed.slice((index * 2) % 60, ((index * 2) % 60) + 2), 16)
        const chooseLocation = (Number.isFinite(rngNibble) ? rngNibble : index) % 2 === 0
        leads.push({
            name: template.name,
            phone,
            followupButtonId: chooseLocation ? 'location' : 'hours',
            followupButtonTitle: chooseLocation ? 'Gym Location' : 'Operating Hours'
        })
    }
    return leads
}

function buildGymShowcaseTimestamps(profileId: string, triggerPhone: string, count: number): number[] {
    const nowMs = Date.now()
    const dynamicWindowMs = Math.max(12 * 60 * 1000, count * GYM_SHOWCASE_MIN_GAP_MS * 2)
    const windowStartMs = nowMs - dynamicWindowMs - (3 * 60 * 1000)
    const windowEndMs = nowMs - 20 * 1000
    return buildRandomizedTimelineUnixSeconds(
        `gym-showcase-time:${profileId}:${triggerPhone}:${nowMs}:${count}`,
        count,
        windowStartMs,
        windowEndMs,
        GYM_SHOWCASE_MIN_GAP_MS
    )
}

function buildGymShowcaseInbound(
    config: WabaConfig,
    lead: GymShowcaseLead,
    timestamp: number,
    leadIndex: number,
    stepIndex: number,
    payload: {
        type: string
        text?: string
        buttonId?: string
        buttonTitle?: string
        buttonDescription?: string
    },
    triggerPhone: string
): WabaInboundMessage {
    const textBody = typeof payload.text === 'string'
        ? payload.text
        : (payload.buttonTitle || payload.buttonId || '')
    return {
        phoneNumberId: config.phoneNumberId,
        from: lead.phone,
        id: `gym-showcase-${Date.now()}-${leadIndex + 1}-${stepIndex + 1}-${randomBytes(3).toString('hex')}`,
        timestamp,
        type: payload.type,
        text: textBody ? { body: textBody } : undefined,
        buttonReplyId: payload.buttonId,
        buttonReplyTitle: payload.buttonTitle,
        buttonReplyDescription: payload.buttonDescription,
        contactName: lead.name,
        raw: {
            source: GYM_SHOWCASE_SOURCE,
            simulated: true,
            profile_id: config.profileId,
            company_id: config.companyId || null,
            trigger_phone: triggerPhone,
            lead_index: leadIndex + 1,
            step_index: stepIndex + 1
        }
    }
}

async function runGymShowcaseBoost(
    config: WabaConfig,
    companyId: string,
    triggerPhone: string
): Promise<{ sent: number; failed: number; error?: string }> {
    const key = buildAdsShootConfigKey(companyId, config.profileId)
    if (gymShowcaseRunningProfiles.has(key)) {
        return { sent: 0, failed: 0, error: 'Gym showcase boost is already running for this profile' }
    }

    const modeConfig = getAdsShootModeProfileConfig(companyId, config.profileId)
    if (!modeConfig.enabled) {
        return { sent: 0, failed: 0, error: 'Ads Shoot Mode is disabled for this profile' }
    }

    const companyForProfile = await getCompanyIdForProfile(config.profileId)
    if (!companyForProfile) {
        return { sent: 0, failed: 0, error: 'Company not found for profile' }
    }
    if (companyForProfile !== companyId) {
        return { sent: 0, failed: 0, error: 'Profile does not belong to this company' }
    }

    const nowMs = Date.now()
    const lastTriggerMs = gymShowcaseLastTriggeredByProfile.get(key) || 0
    if (lastTriggerMs && (nowMs - lastTriggerMs) < GYM_SHOWCASE_COOLDOWN_MS) {
        return { sent: 0, failed: 0, error: 'Gym showcase boost is cooling down' }
    }

    const leads = buildGymShowcaseLeads(config.profileId, triggerPhone, GYM_SHOWCASE_BOOST_COUNT)
    const stepsPerLead = 6
    const timestamps = buildGymShowcaseTimestamps(config.profileId, triggerPhone, leads.length * stepsPerLead)
    let timelineIndex = 0
    let sent = 0
    let failed = 0

    gymShowcaseRunningProfiles.add(key)
    try {
        for (let leadIndex = 0; leadIndex < leads.length; leadIndex += 1) {
            const lead = leads[leadIndex]
            const steps: Array<{ type: string; text?: string; buttonId?: string; buttonTitle?: string }> = [
                { type: 'text', text: 'Hi, I want to check gym membership.' },
                { type: 'button', text: 'Membership', buttonId: 'membership', buttonTitle: 'Membership' },
                { type: 'button', text: 'Monthly Membership', buttonId: 'monthly_membership', buttonTitle: 'Monthly Membership' },
                { type: 'button', text: 'Payment Success', buttonId: 'payment_success', buttonTitle: 'Payment Success' },
                { type: 'button', text: lead.followupButtonTitle, buttonId: lead.followupButtonId, buttonTitle: lead.followupButtonTitle },
                { type: 'button', text: 'Done', buttonId: 'done', buttonTitle: 'Done' }
            ]

            for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
                const step = steps[stepIndex]
                const timestamp = timestamps[timelineIndex] || Math.floor(Date.now() / 1000)
                timelineIndex += 1
                const inbound = buildGymShowcaseInbound(
                    config,
                    lead,
                    timestamp,
                    leadIndex,
                    stepIndex,
                    step,
                    triggerPhone
                )
                try {
                    await handleInboundMessage(config, inbound)
                    sent += 1
                } catch (error: any) {
                    failed += 1
                    console.warn('[GymShowcase] Failed to inject simulated workflow message:', error?.message || error)
                }
            }
        }
        gymShowcaseLastTriggeredByProfile.set(key, Date.now())
    } finally {
        gymShowcaseRunningProfiles.delete(key)
    }

    return { sent, failed }
}

async function runAdsShootModeBatch(
    config: AdsShootModeProfileConfig,
    source: 'manual' | 'nightly'
): Promise<{ sent: number; failed: number; leads: AdsShootLead[]; error?: string }> {
    const companyId = await getCompanyIdForProfile(config.profileId)
    if (!companyId) {
        return { sent: 0, failed: 0, leads: [], error: 'Company not found for profile' }
    }
    if (companyId !== config.companyId) {
        return { sent: 0, failed: 0, leads: [], error: 'Profile does not belong to this company' }
    }

    const wabaConfig = await wabaRegistry.getConfigByProfile(config.profileId)
    if (!wabaConfig) {
        return { sent: 0, failed: 0, leads: [], error: 'WABA config is not available for this profile' }
    }

    const localDateKey = getLocalDateKey(new Date())
    const leads = buildAdsShootLeads(config.profileId, localDateKey, ADS_SHOOT_MODE_BATCH_SIZE)
    const timestamps = buildAdsShootRandomizedTimestamps(config, source, leads.length)
    let sent = 0
    let failed = 0

    for (let index = 0; index < leads.length; index += 1) {
        const lead = leads[index]
        const nowUnix = timestamps[index] || Math.floor(Date.now() / 1000)
        const inbound: WabaInboundMessage = {
            phoneNumberId: wabaConfig.phoneNumberId,
            from: lead.phone,
            id: `ads-shoot-${source}-${Date.now()}-${index + 1}-${randomBytes(3).toString('hex')}`,
            timestamp: nowUnix,
            type: 'text',
            text: { body: lead.text },
            contactName: lead.name,
            raw: {
                source: 'ads_shoot_mode',
                mode: source,
                profile_id: config.profileId,
                company_id: config.companyId,
                simulated: true,
                lead_index: index + 1
            }
        }
        try {
            await handleInboundMessage(wabaConfig, inbound)
            sent += 1
        } catch (error: any) {
            failed += 1
            console.warn('[AdsShootMode] Failed to inject simulated lead:', error?.message || error)
        }
    }

    return { sent, failed, leads }
}

async function runAdsShootModeTick() {
    const now = new Date()
    const localHour = now.getHours()
    if (localHour < ADS_SHOOT_MODE_NIGHT_START_HOUR || localHour > ADS_SHOOT_MODE_NIGHT_END_HOUR) return

    const localDateKey = getLocalDateKey(now)
    const entries = Object.values(adsShootModeStore.profiles)
    for (const config of entries) {
        if (!config.enabled) continue
        if (config.lastRunLocalDate === localDateKey) continue

        const key = buildAdsShootConfigKey(config.companyId, config.profileId)
        if (adsShootModeRunningProfiles.has(key)) continue
        adsShootModeRunningProfiles.add(key)
        try {
            const result = await runAdsShootModeBatch(config, 'nightly')
            if (result.error) {
                console.warn(`[AdsShootMode] ${config.profileId}: ${result.error}`)
                continue
            }
            const nextConfig: AdsShootModeProfileConfig = {
                ...config,
                lastRunLocalDate: localDateKey
            }
            upsertAdsShootModeProfileConfig(nextConfig)
            console.log(`[AdsShootMode] ${config.profileId}: injected ${result.sent}/${ADS_SHOOT_MODE_BATCH_SIZE} nightly leads.`)
        } finally {
            adsShootModeRunningProfiles.delete(key)
        }
    }
}

function chunkArray<T>(items: T[], size: number): T[][] {
    const nextSize = Math.max(1, Math.floor(size))
    const chunks: T[][] = []
    for (let index = 0; index < items.length; index += nextSize) {
        chunks.push(items.slice(index, index + nextSize))
    }
    return chunks
}

const ADS_SHOOT_SIMULATED_TAG_VALUES = new Set([
    ADS_SHOOT_SIMULATED_TAG,
    LEGACY_ADS_SHOOT_SIMULATED_TAG
].map((tag) => String(tag || '').trim().toLowerCase()))

function hasAdsShootSimulatedTag(tags: unknown): boolean {
    if (!Array.isArray(tags)) return false
    return tags.some((tag) => ADS_SHOOT_SIMULATED_TAG_VALUES.has(String(tag || '').trim().toLowerCase()))
}

async function collectSimulatedUserIdsByMessageMarker(candidateUserIds: string[], profileId: string): Promise<Set<string>> {
    const result = new Set<string>()
    if (candidateUserIds.length === 0) return result

    const contentMarkers: any[] = [
        { simulated: true, simulated_profile_id: profileId },
        { raw: { source: 'ads_shoot_mode', profile_id: profileId } },
        { raw: { source: GYM_SHOWCASE_SOURCE, profile_id: profileId } }
    ]
    const userChunks = chunkArray(candidateUserIds, 120)
    for (const userChunk of userChunks) {
        for (const marker of contentMarkers) {
            let offset = 0
            const pageSize = 500
            while (true) {
                const { data, error } = await supabase
                    .from('messages')
                    .select('user_id')
                    .in('user_id', userChunk)
                    .contains('content', marker)
                    .range(offset, offset + pageSize - 1)

                if (error) {
                    console.warn('[AdsShootMode] Failed to collect simulated message markers:', error.message)
                    break
                }

                const rows = Array.isArray(data) ? data : []
                rows.forEach((row: any) => {
                    if (row?.user_id) result.add(String(row.user_id))
                })

                if (rows.length < pageSize) break
                offset += pageSize
            }
        }
    }

    return result
}

async function clearAdsShootSimulatedConversations(
    companyId: string,
    profileId: string
): Promise<{ candidate_users: number; deleted_messages: number; deleted_users: number }> {
    const users = await getUsersForCompany(companyId, profileId)
    if (users.length === 0) {
        return { candidate_users: 0, deleted_messages: 0, deleted_users: 0 }
    }

    const userIds = users.map((user) => user.id).filter(Boolean)
    const userById = new Map(users.map((user) => [user.id, user]))
    const candidateUserIds = new Set<string>()
    const simulatedByMarker = await collectSimulatedUserIdsByMessageMarker(userIds, profileId)
    simulatedByMarker.forEach((userId) => candidateUserIds.add(userId))

    if (candidateUserIds.size === 0) {
        // Fallback for older payloads without simulated_profile_id markers.
        users.forEach((user) => {
            if (hasAdsShootSimulatedTag(user.tags)) {
                candidateUserIds.add(user.id)
            }
        })
    }

    if (candidateUserIds.size === 0) {
        return { candidate_users: 0, deleted_messages: 0, deleted_users: 0 }
    }

    let deletedMessages = 0
    let deletedUsers = 0
    const candidateList = Array.from(candidateUserIds)

    const messageChunks = chunkArray(candidateList, 80)
    for (const userChunk of messageChunks) {
        const { count, error } = await supabase
            .from('messages')
            .delete({ count: 'exact' })
            .in('user_id', userChunk)

        if (error) {
            console.warn(`[AdsShootMode] Failed to delete simulated messages for profile ${profileId}:`, error.message)
            continue
        }
        deletedMessages += Number(count || 0)
    }

    const userChunks = chunkArray(candidateList, 80)
    for (const userChunk of userChunks) {
        const { count, error } = await supabase
            .from('users')
            .delete({ count: 'exact' })
            .eq('company_id', companyId)
            .in('id', userChunk)

        if (error) {
            console.warn(`[AdsShootMode] Failed to delete simulated users for profile ${profileId}:`, error.message)
            for (const userId of userChunk) {
                const user = userById.get(userId)
                if (!user || !Array.isArray(user.tags)) continue
                const nextTags = user.tags.filter((tag) => !ADS_SHOOT_SIMULATED_TAG_VALUES.has(String(tag || '').trim().toLowerCase()))
                await setUserTags(user.id, nextTags)
            }
            continue
        }
        deletedUsers += Number(count || 0)
    }

    return {
        candidate_users: candidateList.length,
        deleted_messages: deletedMessages,
        deleted_users: deletedUsers
    }
}

async function runWindowReminders() {
    const configs = await wabaRegistry.getProfileIds()
    for (const profileId of configs) {
        if (reminderRunningProfiles.has(profileId)) continue
        reminderRunningProfiles.add(profileId)
        try {
            const config = await wabaRegistry.getConfigByProfile(profileId)
            if (!config || !config.windowReminderEnabled) continue
            const minutes = Number(config.windowReminderMinutes || 0)
            if (!minutes || minutes <= 0) continue

            const companyId = await getCompanyIdForProfile(profileId)
            if (!companyId) continue
            const client = await wabaRegistry.getClientByProfile(profileId)
            if (!client) continue

            const users = await getUsersWithExpiringWindow(companyId, minutes, profileId)
            for (const user of users) {
                const lastInboundMs = user.last_inbound_at ? new Date(user.last_inbound_at).getTime() : null
                if (!lastInboundMs || Number.isNaN(lastInboundMs)) continue
                const remainingMs = lastInboundMs + WINDOW_MS - Date.now()
                if (remainingMs <= 0) continue
                const cachedReminder = reminderCache.get(user.id)
                if (cachedReminder && cachedReminder >= lastInboundMs) continue

                const fallbackText = config.windowReminderText || DEFAULT_REMINDER_TEXT
                const message = fallbackText.replace('{minutes}', String(Math.max(1, Math.ceil(remainingMs / 60000))))

                try {
                    await sendWhatsAppMessage({
                        client,
                        userId: user.id,
                        profileId,
                        to: user.phone_number,
                        type: 'text',
                        content: { text: message },
                        workflowState: null
                    })
                    await updateUserWindowReminder(user.id)
                    reminderCache.set(user.id, lastInboundMs)
                } catch (err: any) {
                    console.warn('[Reminder] Failed to send window reminder:', err?.message || err)
                }
            }
        } finally {
            reminderRunningProfiles.delete(profileId)
        }
    }
}

setInterval(() => {
    runWindowReminders().catch(err => console.error('[Reminder] tick failed:', err))
}, 60_000)

setInterval(() => {
    runAdsShootModeTick().catch(err => console.error('[AdsShootMode] tick failed:', err))
}, 60_000)

setTimeout(() => {
    runAdsShootModeTick().catch(err => console.error('[AdsShootMode] initial tick failed:', err))
}, 8_000)

const workflowEngine = new WorkflowEngine()

function parseDateInput(raw: any, endOfDay = false) {
    if (!raw || typeof raw !== 'string') return null
    const suffix = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z'
    const date = new Date(`${raw}${suffix}`)
    if (Number.isNaN(date.getTime())) return null
    return date
}

function toDayKey(date: Date) {
    return date.toISOString().slice(0, 10)
}

function lowerBound(nums: number[], target: number) {
    let lo = 0
    let hi = nums.length
    while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2)
        if (nums[mid] < target) lo = mid + 1
        else hi = mid
    }
    return lo
}

async function getCompanyIdForProfile(profileId: string) {
    if (!profileId) return null

    let profileCompanyId = ''
    try {
        const { data, error } = await supabase
            .from('profiles')
            .select('company_id')
            .eq('id', profileId)
            .maybeSingle()

        profileCompanyId = typeof data?.company_id === 'string' ? data.company_id.trim() : ''
        if (error) {
            console.warn(`[${profileId}] Failed to read company_id from profiles:`, error.message)
        }
    } catch (error: any) {
        console.warn(`[${profileId}] Failed to resolve company_id from profiles:`, error?.message || error)
    }

    const config = await wabaRegistry.getConfigByProfile(profileId)
    const configCompanyId = typeof config?.companyId === 'string' ? config.companyId.trim() : ''

    // WABA mapping is the explicit reviewer/operator-controlled source in Settings.
    if (configCompanyId) {
        if (profileCompanyId && profileCompanyId !== configCompanyId) {
            console.warn(
                `[${profileId}] Company mismatch: profiles.company_id="${profileCompanyId}" vs waba_configs.company_id="${configCompanyId}". Using waba_configs mapping.`
            )
        }
        return resolveCompanyId(configCompanyId)
    }

    if (profileCompanyId) return profileCompanyId

    try {
        const { data: fallback } = await supabase
            .from('waba_configs')
            .select('company_id')
            .eq('profile_id', profileId)
            .maybeSingle()
        const fallbackCompanyId = typeof fallback?.company_id === 'string' ? fallback.company_id.trim() : ''
        if (fallbackCompanyId) return resolveCompanyId(fallbackCompanyId)
    } catch {
        // no-op fallback
    }

    return null
}

async function getProfileIdsForCompany(companyId: string, fallbackProfileId?: string): Promise<string[]> {
    if (!companyId) {
        return fallbackProfileId ? [fallbackProfileId] : []
    }

    try {
        const { data, error } = await supabase
            .from('profiles')
            .select('id')
            .eq('company_id', companyId)

        if (error) {
            console.warn(`[${companyId}] Failed to load profile IDs for company broadcast:`, error.message)
            return fallbackProfileId ? [fallbackProfileId] : []
        }

        const ids = Array.from(
            new Set(
                (data || [])
                    .map((row: any) => (typeof row?.id === 'string' ? row.id.trim() : ''))
                    .filter(Boolean)
            )
        )

        if (fallbackProfileId && !ids.includes(fallbackProfileId)) {
            ids.push(fallbackProfileId)
        }

        return ids.length > 0 ? ids : (fallbackProfileId ? [fallbackProfileId] : [])
    } catch (error: any) {
        console.warn(`[${companyId}] Profile broadcast fallback due to error:`, error?.message || error)
        return fallbackProfileId ? [fallbackProfileId] : []
    }
}

async function getCompanyIdForProfileOrProfileTable(profileId: string) {
    return getCompanyIdForProfile(profileId)
}

async function findConflictingActivePhoneNumberConfig(phoneNumberId: string, profileId: string): Promise<{ profileId: string; companyId: string | null } | null> {
    const { data, error } = await supabase
        .from('waba_configs')
        .select('profile_id, company_id')
        .eq('phone_number_id', phoneNumberId)
        .eq('enabled', true)
        .neq('profile_id', profileId)
        .limit(1)
        .maybeSingle()

    if (error) {
        throw new Error(error.message)
    }

    if (!data?.profile_id) return null
    return {
        profileId: String(data.profile_id),
        companyId: data.company_id ? String(data.company_id) : null
    }
}

function hashOAuthState(state: string) {
    return createHash('sha256').update(state).digest('hex')
}

async function getSupabaseUserFromRequest(req: any, res: any) {
    const requestHostname = getHostnameFromHeaders(req?.headers)
    const hostCompanyId = resolveCompanyIdFromHostname(requestHostname)
    const rawAuth = req.headers['authorization'] || ''
    const token = typeof rawAuth === 'string' && rawAuth.startsWith('Bearer ')
        ? rawAuth.slice(7)
        : rawAuth

    if (!token) {
        res.status(401).json({ success: false, error: 'Authorization token required' })
        return null
    }

    const { data: { user }, error } = await supabaseAuth.auth.getUser(token)
    if (error || !user) {
        res.status(401).json({ success: false, error: 'Invalid or expired session' })
        return null
    }

    const directCompanyId = normalizeCompanyId(getUserCompanyId(user))
    if (hostCompanyId && !directCompanyId) {
        res.status(403).json({
            success: false,
            error: 'This account is not assigned to any company. Ask your admin to set up your account first.'
        })
        return null
    }
    if (hostCompanyId && directCompanyId && directCompanyId !== hostCompanyId) {
        res.status(403).json({
            success: false,
            error: `This account belongs to "${directCompanyId}" and cannot access "${hostCompanyId}.${TENANT_ROOT_DOMAIN}".`
        })
        return null
    }

    const { user: ensuredUser } = await ensureUserCompanyId(user)
    const ensuredCompanyId = normalizeCompanyId(getUserCompanyId(ensuredUser))
    if (hostCompanyId && ensuredCompanyId !== hostCompanyId) {
        res.status(403).json({
            success: false,
            error: `Company mismatch for this subdomain. Expected "${hostCompanyId}".`
        })
        return null
    }

    const runtimeSnapshot = systemRuntimeStatus?.getStatus?.()
    if (runtimeSnapshot?.maintenance?.enabled && !isSuperAdminUser(ensuredUser)) {
        const maintenanceMessage = typeof runtimeSnapshot.maintenance.message === 'string'
            ? runtimeSnapshot.maintenance.message.trim()
            : ''
        res.status(503).json({
            success: false,
            error: maintenanceMessage || 'Server is currently in maintenance mode',
            maintenance: {
                enabled: true,
                message: maintenanceMessage,
                updated_at: runtimeSnapshot.maintenance.updatedAt || null,
                updated_by: runtimeSnapshot.maintenance.updatedBy || null
            }
        })
        return null
    }

    return ensuredUser
}

function getUserCompanyId(user: any): string | null {
    const raw = user?.user_metadata?.company_id || user?.app_metadata?.company_id || null
    if (typeof raw !== 'string') return raw ? String(raw) : null
    const trimmed = raw.trim()
    return trimmed ? trimmed : null
}

async function deriveCompanyIdFromProfiles(userId: string): Promise<string | null> {
    try {
        const { data, error } = await supabase
            .from('profiles')
            .select('id, company_id, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: true })

        if (error) {
            console.warn(`[${userId}] Failed to load profiles for company resolution:`, error.message)
            return null
        }

        if (!data || data.length === 0) return null

        const distinctCompanyIds = Array.from(new Set(
            data
                .map(row => (typeof row.company_id === 'string' ? row.company_id.trim() : ''))
                .filter(Boolean)
        ))

        if (distinctCompanyIds.length === 1) return distinctCompanyIds[0]
        if (distinctCompanyIds.length === 0 && data.length === 1) {
            const profileId = typeof data[0].id === 'string' ? data[0].id.trim() : ''
            return profileId || null
        }
        if (distinctCompanyIds.length > 1) {
            console.warn(`[${userId}] Multiple company_id values found for profiles; using the first match.`)
            return distinctCompanyIds[0]
        }
    } catch (err: any) {
        console.warn(`[${userId}] Failed to resolve company from profiles:`, err?.message || err)
    }
    return null
}

async function ensureCompanyRecord(companyId: string, user: any) {
    if (!companyId) return
    const userId = user?.id || 'unknown'
    try {
        const { data: existingCompany, error: companyCheckError } = await supabase
            .from('company')
            .select('id')
            .eq('id', companyId)
            .maybeSingle()

        if (companyCheckError) {
            console.warn(`[${userId}] Failed to check company ${companyId}:`, companyCheckError.message)
        } else if (!existingCompany?.id) {
            const { error: companyInsertError } = await supabase
                .from('company')
                .insert({
                    id: companyId,
                    name: companyId,
                    email: user?.email || null
                })

            if (companyInsertError) {
                const isDuplicate = companyInsertError.code === '23505' || /duplicate/i.test(companyInsertError.message)
                if (!isDuplicate) {
                    console.warn(`[${userId}] Failed to create company ${companyId}:`, companyInsertError.message)
                }
            } else {
                console.log(`[${userId}] Created company: ${companyId}`)
            }
        }
    } catch (err: any) {
        console.warn(`[${userId}] Failed to ensure company ${companyId}:`, err?.message || err)
    }
}

async function ensureUserCompanyId(user: any): Promise<{ user: any; companyId: string | null }> {
    const existingCompanyId = getUserCompanyId(user)
    if (existingCompanyId) {
        await ensureUserRoleMembership(user, existingCompanyId)
        return { user, companyId: existingCompanyId }
    }

    let companyId = await deriveCompanyIdFromProfiles(user.id)
    if (!companyId && typeof user?.id === 'string') companyId = user.id.trim()
    if (!companyId) return { user, companyId: null }

    await ensureCompanyRecord(companyId, user)

    const updatedMetadata = { ...(user?.user_metadata || {}), company_id: companyId }
    const hasServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)

    if (hasServiceRole) {
        try {
            const { data, error } = await supabase.auth.admin.updateUserById(user.id, {
                user_metadata: updatedMetadata
            })
            if (error) {
                console.warn(`[${user.id}] Failed to update user metadata company_id:`, error.message)
            } else if (data?.user) {
                user = data.user
            }
        } catch (err: any) {
            console.warn(`[${user.id}] Failed to update user metadata company_id:`, err?.message || err)
        }
    } else {
        console.warn(`[${user.id}] Missing service role key; cannot persist company_id to auth metadata.`)
    }

    if (!user?.user_metadata) user.user_metadata = {}
    user.user_metadata.company_id = companyId

    try {
        const { error: updateError } = await supabase
            .from('profiles')
            .update({ company_id: companyId })
            .eq('user_id', user.id)
            .is('company_id', null)

        if (updateError) {
            console.warn(`[${user.id}] Failed to backfill profile company_id:`, updateError.message)
        }
    } catch (err: any) {
        console.warn(`[${user.id}] Failed to backfill profile company_id:`, err?.message || err)
    }

    await ensureUserRoleMembership(user, companyId)

    return { user, companyId }
}

async function getUserRoleInCompany(userId: string, companyId: string): Promise<TeamRole | null> {
    if (!userId || !companyId) return null
    const { data, error } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', userId)
        .eq('company_id', companyId)
        .maybeSingle()
    if (error) return null
    if (data?.role) return normalizeTeamRole(data.role)

    const { data: fallback, error: fallbackError } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', userId)
        .is('company_id', null)
        .maybeSingle()
    if (fallbackError) return null
    return fallback?.role ? normalizeTeamRole(fallback.role) : null
}

async function ensureUserRoleMembership(user: any, companyId: string): Promise<TeamRole> {
    const userId = typeof user?.id === 'string' ? user.id : ''
    if (!userId || !companyId) return 'agent'

    const { data: companyMembership, error: companyMembershipError } = await supabase
        .from('user_roles')
        .select('user_id, role, company_id')
        .eq('user_id', userId)
        .eq('company_id', companyId)
        .maybeSingle()

    if (companyMembershipError) {
        console.warn(`[${userId}] Failed to load company role:`, companyMembershipError.message)
    }

    if (companyMembership?.user_id) {
        const role = normalizeTeamRole(companyMembership.role)
        if (companyMembership.role !== role) {
            const { error: updateError } = await supabase
                .from('user_roles')
                .update({ role })
                .eq('user_id', userId)
                .eq('company_id', companyId)
            if (updateError) {
                console.warn(`[${userId}] Failed to normalize company role:`, updateError.message)
            }
        }
        return role
    }

    // Legacy fallback: upgrade old rows where company_id was null into the scoped company row.
    const { data: legacyMembership, error: legacyMembershipError } = await supabase
        .from('user_roles')
        .select('user_id, role')
        .eq('user_id', userId)
        .is('company_id', null)
        .maybeSingle()

    if (legacyMembershipError) {
        console.warn(`[${userId}] Failed to load legacy role:`, legacyMembershipError.message)
    }

    if (legacyMembership?.user_id) {
        const role = normalizeTeamRole(legacyMembership.role)
        const { error: updateError } = await supabase
            .from('user_roles')
            .update({
                company_id: companyId,
                role
            })
            .eq('user_id', userId)
            .is('company_id', null)

        if (updateError) {
            const fallbackRole = await getUserRoleInCompany(userId, companyId)
            if (fallbackRole) return fallbackRole
            console.warn(`[${userId}] Failed to migrate legacy role:`, updateError.message)
        } else {
            return role
        }
    }

    const { count: companyRoleCount, error: countError } = await supabase
        .from('user_roles')
        .select('user_id', { count: 'exact', head: true })
        .eq('company_id', companyId)

    if (countError) {
        console.warn(`[${userId}] Failed to count company roles:`, countError.message)
    }

    const initialRole: TeamRole = (companyRoleCount || 0) === 0 ? 'owner' : 'agent'
    const { error: insertError } = await supabase
        .from('user_roles')
        .insert({
            user_id: userId,
            company_id: companyId,
            role: initialRole
        })

    if (insertError) {
        const isDuplicate = insertError.code === '23505' || /duplicate/i.test(insertError.message)
        if (!isDuplicate) {
            console.warn(`[${userId}] Failed to create user role:`, insertError.message)
        }
        const fallbackRole = await getUserRoleInCompany(userId, companyId)
        return fallbackRole || 'agent'
    }

    return initialRole
}

async function isAdminUser(userId: string, companyId?: string): Promise<boolean> {
    if (!userId) return false
    const role = companyId ? await getUserRoleInCompany(userId, companyId) : null
    if (role) return hasRoleAtLeast(role, 'admin')
    const { data, error } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', userId)
        .maybeSingle()
    if (error) return false
    const fallback = data?.role ? normalizeTeamRole(data.role) : null
    return fallback ? hasRoleAtLeast(fallback, 'admin') : false
}

async function assertProfileCompany(profileId: string, companyId: string): Promise<boolean> {
    const { data } = await supabase
        .from('profiles')
        .select('company_id')
        .eq('id', profileId)
        .maybeSingle()

    if (!data?.company_id) return false
    return data.company_id === companyId
}

async function resolveProfileAccess(req: any, res: any) {
    const user = req?.supabaseUser || await getSupabaseUserFromRequest(req, res)
    if (!user) return null

    const profileId = typeof req.query?.profileId === 'string'
        ? req.query.profileId
        : typeof req.body?.profileId === 'string'
            ? req.body.profileId
            : undefined

    if (!profileId) {
        res.status(400).json({ success: false, error: 'profileId is required' })
        return null
    }

    const companyId = getUserCompanyId(user)
    if (!companyId) {
        res.status(400).json({ success: false, error: 'Company ID missing in user metadata' })
        return null
    }

    const ownsProfile = await assertProfileCompany(profileId, companyId)
    if (!ownsProfile) {
        res.status(403).json({ success: false, error: 'Profile does not belong to your company' })
        return null
    }

    return { user, profileId, companyId }
}

async function resolveCompanyAccess(
    req: any,
    res: any,
    minimumRole: TeamRole = 'agent'
): Promise<{ user: any; companyId: string; role: TeamRole } | null> {
    const user = req?.supabaseUser || await getSupabaseUserFromRequest(req, res)
    if (!user) return null

    const companyId = getUserCompanyId(user)
    if (!companyId) {
        res.status(400).json({ success: false, error: 'Company ID missing in user metadata' })
        return null
    }

    const role = await ensureUserRoleMembership(user, companyId)
    if (!hasRoleAtLeast(role, minimumRole)) {
        res.status(403).json({ success: false, error: `${minimumRole} role required` })
        return null
    }

    return { user, companyId, role }
}

function readTrimmed(value: any): string {
    return typeof value === 'string' ? value.trim() : ''
}

function isObject(value: any): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function extractPositionalVars(text: string): number[] {
    const vars = new Set<number>()
    const regex = /{{\s*(\d+)\s*}}/g
    let match = regex.exec(text)
    while (match) {
        const capture = match[1] || ''
        const value = Number.parseInt(capture, 10)
        if (Number.isFinite(value)) vars.add(value)
        match = regex.exec(text)
    }
    return Array.from(vars).sort((a, b) => a - b)
}

function extractNamedVars(text: string): string[] {
    const vars = new Set<string>()
    const regex = /{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g
    let match = regex.exec(text)
    while (match) {
        const capture = match[1]
        if (capture) vars.add(capture)
        match = regex.exec(text)
    }
    return Array.from(vars)
}

const MARKETING_NAMED_PARAM_REGEX = /^[a-z_][a-z0-9_]*$/

function hasBodyExamples(bodyComponent: any): boolean {
    if (!isObject(bodyComponent)) return false
    const example = bodyComponent.example
    if (!isObject(example)) return false
    if (Array.isArray(example.body_text) && example.body_text.length > 0) return true
    if (Array.isArray(example.body_text_named_params) && example.body_text_named_params.length > 0) return true
    return false
}

function countBodyExamples(bodyComponent: any): number {
    if (!isObject(bodyComponent)) return 0
    const example = bodyComponent.example
    if (!isObject(example)) return 0

    if (Array.isArray(example.body_text) && example.body_text.length > 0) {
        const first = example.body_text[0]
        if (Array.isArray(first)) return first.filter((item: any) => readTrimmed(String(item)).length > 0).length
    }
    if (Array.isArray(example.body_text_named_params)) {
        return example.body_text_named_params.length
    }

    return 0
}

function hasHeaderHandle(component: any): boolean {
    if (!isObject(component)) return false
    const topLevelHandle = component.header_handle
    if (typeof topLevelHandle === 'string' && topLevelHandle.trim()) return true
    if (Array.isArray(topLevelHandle) && topLevelHandle.some((item: any) => typeof item === 'string' && item.trim())) return true

    const example = component.example
    if (!isObject(example)) return false
    const exampleHandle = example.header_handle
    if (typeof exampleHandle === 'string' && exampleHandle.trim()) return true
    if (Array.isArray(exampleHandle) && exampleHandle.some((item: any) => typeof item === 'string' && item.trim())) return true
    return false
}

function extractHeaderHandle(component: any): string {
    if (!isObject(component)) return ''

    const topLevelHandle = component.header_handle
    if (typeof topLevelHandle === 'string' && topLevelHandle.trim()) return topLevelHandle.trim()
    if (Array.isArray(topLevelHandle)) {
        const first = topLevelHandle.find((item: any) => typeof item === 'string' && item.trim())
        if (typeof first === 'string') return first.trim()
    }

    const example = component.example
    if (!isObject(example)) return ''
    const exampleHandle = example.header_handle
    if (typeof exampleHandle === 'string' && exampleHandle.trim()) return exampleHandle.trim()
    if (Array.isArray(exampleHandle)) {
        const first = exampleHandle.find((item: any) => typeof item === 'string' && item.trim())
        if (typeof first === 'string') return first.trim()
    }

    return ''
}

function normalizeTemplateCreationComponents(raw: any[]): any[] {
    const normalized: any[] = []
    for (const component of raw) {
        if (!isObject(component)) continue
        const type = readTrimmed(component.type).toUpperCase()
        if (!type) continue

        const next: any = { ...component, type }
        if (type === 'HEADER') {
            const format = readTrimmed(component.format).toUpperCase()
            if (format) next.format = format
        }
        if (type === 'BUTTONS' && Array.isArray(component.buttons)) {
            next.buttons = component.buttons
                .filter((button: any) => isObject(button))
                .map((button: any) => ({
                    ...button,
                    type: readTrimmed(button.type).toUpperCase()
                }))
        }

        normalized.push(next)
    }

    return normalized
}

function validateUtilityTemplateInput(input: any): { payload: any | null; errors: string[] } {
    const errors: string[] = []

    const name = readTrimmed(input?.name)
    if (!name) {
        errors.push('name is required')
    } else {
        if (name.length > 512) errors.push('name must be <= 512 characters')
        if (!/^[a-z0-9_]+$/.test(name)) errors.push('name must use lowercase letters, numbers, and underscores only')
    }

    const language = readTrimmed(input?.language)
    if (!language) errors.push('language is required (example: en_US)')

    const category = readTrimmed(input?.category || 'utility').toLowerCase()
    if (category !== 'utility') errors.push('category must be utility')

    const parameterFormat = readTrimmed(input?.parameter_format || input?.parameterFormat || 'positional').toLowerCase()
    if (parameterFormat !== 'named' && parameterFormat !== 'positional') {
        errors.push('parameter_format must be named or positional')
    }

    const rawComponents = Array.isArray(input?.components) ? input.components : []
    if (rawComponents.length === 0) errors.push('components array is required')
    const components = normalizeTemplateCreationComponents(rawComponents)

    const headerComponents = components.filter((component: any) => component.type === 'HEADER')
    const bodyComponents = components.filter((component: any) => component.type === 'BODY')
    const footerComponents = components.filter((component: any) => component.type === 'FOOTER')
    const buttonComponents = components.filter((component: any) => component.type === 'BUTTONS')

    if (headerComponents.length > 1) errors.push('only one HEADER component is allowed')
    if (bodyComponents.length !== 1) errors.push('exactly one BODY component is required')
    if (footerComponents.length > 1) errors.push('only one FOOTER component is allowed')
    if (buttonComponents.length > 1) errors.push('only one BUTTONS component is allowed')

    const bodyComponent = bodyComponents[0]
    if (bodyComponent) {
        const bodyText = readTrimmed(bodyComponent.text)
        if (!bodyText) {
            errors.push('BODY.text is required')
        } else {
            if (bodyText.length > 1024) errors.push('BODY.text must be <= 1024 characters')

            const positionalVars = extractPositionalVars(bodyText)
            const namedVars = extractNamedVars(bodyText)

            if (parameterFormat === 'positional') {
                if (namedVars.length > 0) errors.push('BODY uses named variables but parameter_format is positional')
                positionalVars.forEach((value, index) => {
                    const expected = index + 1
                    if (value !== expected) errors.push('positional BODY variables must be sequential like {{1}}, {{2}}, {{3}}')
                })
            }

            if (parameterFormat === 'named' && positionalVars.length > 0) {
                errors.push('BODY uses positional variables but parameter_format is named')
            }

            if ((positionalVars.length > 0 || namedVars.length > 0) && !hasBodyExamples(bodyComponent)) {
                errors.push('BODY variables require example values')
            }

            const requiredExampleCount = parameterFormat === 'named' ? namedVars.length : positionalVars.length
            if (requiredExampleCount > 0) {
                const actualExamples = countBodyExamples(bodyComponent)
                if (actualExamples > 0 && actualExamples < requiredExampleCount) {
                    errors.push(`BODY example count (${actualExamples}) is less than variable count (${requiredExampleCount})`)
                }
            }
        }
    }

    const headerComponent = headerComponents[0]
    if (headerComponent) {
        const format = readTrimmed(headerComponent.format).toUpperCase()
        const allowedFormats = new Set(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION'])
        if (!format || !allowedFormats.has(format)) {
            errors.push('HEADER.format must be one of TEXT, IMAGE, VIDEO, DOCUMENT, LOCATION')
        } else if (format === 'TEXT') {
            const headerText = readTrimmed(headerComponent.text)
            if (!headerText) errors.push('HEADER.text is required when HEADER.format is TEXT')
            if (headerText.length > 60) errors.push('HEADER.text must be <= 60 characters')
        } else if (format === 'IMAGE' || format === 'VIDEO' || format === 'DOCUMENT') {
            if (!hasHeaderHandle(headerComponent)) {
                errors.push(`HEADER.format ${format} requires header_handle (usually in HEADER.example.header_handle)`)
            }
        }
    }

    const footerComponent = footerComponents[0]
    if (footerComponent) {
        const footerText = readTrimmed(footerComponent.text)
        if (!footerText) errors.push('FOOTER.text is required when FOOTER exists')
        if (footerText.length > 60) errors.push('FOOTER.text must be <= 60 characters')
    }

    const buttonsComponent = buttonComponents[0]
    if (buttonsComponent) {
        const buttons = Array.isArray(buttonsComponent.buttons) ? buttonsComponent.buttons : []
        if (buttons.length === 0) {
            errors.push('BUTTONS.buttons must contain at least one button')
        }
        if (buttons.length > 10) {
            errors.push('BUTTONS supports up to 10 buttons')
        }

        const allowedButtonTypes = new Set(['URL', 'PHONE_NUMBER', 'QUICK_REPLY', 'COPY_CODE', 'CALL_REQUEST'])
        buttons.forEach((button: any, index: number) => {
            const buttonType = readTrimmed(button?.type).toUpperCase()
            if (!allowedButtonTypes.has(buttonType)) {
                errors.push(`BUTTONS.buttons[${index}].type is invalid`)
                return
            }

            const label = readTrimmed(button?.text || button?.title)
            if (label && label.length > 25) {
                errors.push(`BUTTONS.buttons[${index}] label must be <= 25 characters`)
            }

            if (buttonType !== 'CALL_REQUEST' && !label) {
                errors.push(`BUTTONS.buttons[${index}] label is required`)
            }

            if (buttonType === 'PHONE_NUMBER') {
                const phone = readTrimmed(button?.phone_number || button?.phoneNumber)
                if (!phone) {
                    errors.push(`BUTTONS.buttons[${index}].phone_number is required`)
                } else if (phone.length > 20) {
                    errors.push(`BUTTONS.buttons[${index}].phone_number must be <= 20 characters`)
                }
            }

            if (buttonType === 'URL') {
                const url = readTrimmed(button?.url)
                if (!url) errors.push(`BUTTONS.buttons[${index}].url is required`)
            }
        })
    }

    if (errors.length > 0) return { payload: null, errors }

    return {
        payload: {
            name,
            category: 'UTILITY',
            language,
            parameter_format: parameterFormat.toUpperCase(),
            components
        },
        errors: []
    }
}

function normalizeMarketingToken(value: any): string {
    const normalized = readTrimmed(value).toLowerCase().replace(/[\s-]+/g, '_')
    if (normalized === 'quickreply') return 'quick_reply'
    if (normalized === 'phonenumber' || normalized === 'phone') return 'phone_number'
    if (normalized === 'copycode') return 'copy_code'
    if (normalized === 'limitedtimeoffer') return 'limited_time_offer'
    return normalized
}

function normalizeMarketingCreateComponents(raw: any[]): any[] {
    const normalizeButtons = (buttons: any[]): any[] => {
        return buttons
            .filter((button: any) => isObject(button))
            .map((button: any) => {
                const type = normalizeMarketingToken(button.type)
                return {
                    ...button,
                    type: type || readTrimmed(button.type).toLowerCase()
                }
            })
    }

    return raw
        .filter((component: any) => isObject(component))
        .map((component: any) => {
            const type = normalizeMarketingToken(component.type)
            if (!type) return null

            const next: any = {
                ...component,
                type
            }

            if (type === 'header') {
                const format = normalizeMarketingToken(component.format)
                if (format) next.format = format
            }

            if (type === 'buttons' && Array.isArray(component.buttons)) {
                next.buttons = normalizeButtons(component.buttons)
            }

            if (type === 'carousel' && Array.isArray(component.cards)) {
                next.cards = component.cards
                    .filter((card: any) => isObject(card))
                    .map((card: any) => ({
                        ...card,
                        components: normalizeMarketingCreateComponents(Array.isArray(card.components) ? card.components : [])
                    }))
            }

            return next
        })
        .filter(Boolean)
}

function countMarketingComponents(components: any[], type: string): number {
    return components.filter((component: any) => component?.type === type).length
}

function firstMarketingComponent(components: any[], type: string): any | null {
    return components.find((component: any) => component?.type === type) || null
}

function ensureOnlyMarketingTopTypes(components: any[], allowed: Set<string>, errors: string[], prefix = '') {
    components.forEach((component: any) => {
        const type = readTrimmed(component?.type)
        if (!type) return
        if (allowed.has(type)) return
        const label = prefix ? `${prefix}.components` : 'components'
        errors.push(`${label} does not support type "${type}"`)
    })
}

function toStringArray(raw: any): string[] {
    if (Array.isArray(raw)) {
        return raw.map((value) => readTrimmed(String(value))).filter(Boolean)
    }
    const single = readTrimmed(raw)
    return single ? [single] : []
}

function readBodyPositionalExamples(bodyComponent: any): string[] {
    const example = isObject(bodyComponent?.example) ? bodyComponent.example : null
    const bodyTextRows = Array.isArray(example?.body_text) ? example.body_text : []
    const firstRow = Array.isArray(bodyTextRows[0]) ? bodyTextRows[0] : []
    return firstRow.map((value: any) => readTrimmed(String(value))).filter(Boolean)
}

function readBodyNamedExamples(bodyComponent: any): Array<{ param_name: string; example: string }> {
    const example = isObject(bodyComponent?.example) ? bodyComponent.example : null
    const rawEntries = Array.isArray(example?.body_text_named_params) ? example.body_text_named_params : []
    const output: Array<{ param_name: string; example: string }> = []
    rawEntries.forEach((entry: any) => {
        if (!isObject(entry)) return
        const rawName = readTrimmed(entry.param_name)
        const paramName = rawName.replace(/^{{\s*|\s*}}$/g, '')
        const exampleValue = readTrimmed(entry.example)
        if (!paramName || !exampleValue) return
        output.push({
            param_name: paramName,
            example: exampleValue
        })
    })
    return output
}

function hasAlphaNumericOnly(value: string): boolean {
    if (!value) return false
    return /^[a-z0-9]+$/i.test(value)
}

function buildNormalizedBodyComponent(
    bodyComponent: any,
    options: {
        label: string
        maxLength: number
        parameterFormat: 'named' | 'positional'
        allowNamed: boolean
        allowPositional: boolean
        requireExamples: boolean
        enforceNamedRegex?: RegExp
    },
    errors: string[]
): {
    component: any | null
    namedVars: string[]
    positionalVars: number[]
    effectiveParameterFormat: 'named' | 'positional'
} {
    const fallback = {
        component: null,
        namedVars: [] as string[],
        positionalVars: [] as number[],
        effectiveParameterFormat: options.parameterFormat
    }

    if (!isObject(bodyComponent)) {
        errors.push(`${options.label} component is required`)
        return fallback
    }

    const text = readTrimmed(bodyComponent.text)
    if (!text) {
        errors.push(`${options.label}.text is required`)
        return fallback
    }

    if (text.length > options.maxLength) {
        errors.push(`${options.label}.text must be <= ${options.maxLength} characters`)
    }

    const namedVars = extractNamedVars(text)
    const positionalVars = extractPositionalVars(text)

    if (namedVars.length > 0 && positionalVars.length > 0) {
        errors.push(`${options.label} cannot mix named and positional variables`)
    }

    if (!options.allowNamed && namedVars.length > 0) {
        errors.push(`${options.label} supports positional variables only`)
    }
    if (!options.allowPositional && positionalVars.length > 0) {
        errors.push(`${options.label} supports named variables only`)
    }

    positionalVars.forEach((value, index) => {
        const expected = index + 1
        if (value !== expected) {
            errors.push(`${options.label} positional variables must be sequential like {{1}}, {{2}}, {{3}}`)
        }
    })

    if (options.enforceNamedRegex) {
        namedVars.forEach((name) => {
            if (!options.enforceNamedRegex!.test(name)) {
                errors.push(`${options.label} named variable "${name}" must use lowercase letters, numbers, and underscores`)
            }
        })
    }

    let effectiveParameterFormat: 'named' | 'positional' = options.parameterFormat
    if (namedVars.length > 0) effectiveParameterFormat = 'named'
    if (positionalVars.length > 0) effectiveParameterFormat = 'positional'

    if (options.parameterFormat === 'named' && positionalVars.length > 0) {
        errors.push(`${options.label} uses positional variables but parameter_format is named`)
    }
    if (options.parameterFormat === 'positional' && namedVars.length > 0) {
        errors.push(`${options.label} uses named variables but parameter_format is positional`)
    }

    const normalized: any = {
        type: 'body',
        text
    }

    if (namedVars.length > 0 || positionalVars.length > 0) {
        if (effectiveParameterFormat === 'named') {
            const parsedNamedExamples = readBodyNamedExamples(bodyComponent)
            if (options.requireExamples && parsedNamedExamples.length === 0) {
                errors.push(`${options.label}.example.body_text_named_params is required for named variables`)
            }

            const seen = new Set<string>()
            const normalizedNamed = parsedNamedExamples.filter((entry) => {
                if (seen.has(entry.param_name)) return false
                seen.add(entry.param_name)
                return true
            })

            if (options.enforceNamedRegex) {
                normalizedNamed.forEach((entry) => {
                    if (!options.enforceNamedRegex!.test(entry.param_name)) {
                        errors.push(`${options.label}.example named param "${entry.param_name}" must use lowercase letters, numbers, and underscores`)
                    }
                })
            }

            namedVars.forEach((name) => {
                if (!seen.has(name)) {
                    errors.push(`${options.label}.example is missing value for ${name}`)
                }
            })

            if (normalizedNamed.length > 0) {
                normalized.example = {
                    body_text_named_params: normalizedNamed
                }
            }
        } else {
            const positionalExamples = readBodyPositionalExamples(bodyComponent)
            if (options.requireExamples && positionalExamples.length === 0) {
                errors.push(`${options.label}.example.body_text[0] is required for positional variables`)
            }
            if (positionalExamples.length > 0 && positionalExamples.length < positionalVars.length) {
                errors.push(`${options.label}.example count (${positionalExamples.length}) is less than variable count (${positionalVars.length})`)
            }
            if (positionalExamples.length > 0) {
                normalized.example = {
                    body_text: [positionalExamples]
                }
            }
        }
    }

    return {
        component: normalized,
        namedVars,
        positionalVars,
        effectiveParameterFormat
    }
}

function validateMarketingTemplateInput(input: any): { payload: any | null; errors: string[] } {
    const errors: string[] = []

    const name = readTrimmed(input?.name)
    if (!name) {
        errors.push('name is required')
    } else {
        if (name.length > 512) errors.push('name must be <= 512 characters')
        if (!/^[a-z0-9_]+$/.test(name)) errors.push('name must use lowercase letters, numbers, and underscores only')
    }

    const category = readTrimmed(input?.category || 'marketing').toLowerCase()
    if (category !== 'marketing') errors.push('category must be marketing')

    const language = readTrimmed(input?.language)
    if (!language) errors.push('language is required (example: en_US)')

    const inputParameterFormat = readTrimmed(input?.parameter_format || input?.parameterFormat || 'positional').toLowerCase()
    if (inputParameterFormat !== 'named' && inputParameterFormat !== 'positional') {
        errors.push('parameter_format must be named or positional')
    }
    const parameterFormat = inputParameterFormat === 'named' ? 'named' : 'positional'

    const rawComponents = Array.isArray(input?.components) ? input.components : []
    if (rawComponents.length === 0) errors.push('components array is required')
    const components = normalizeMarketingCreateComponents(rawComponents)

    const topLevelTypes = components.map((component: any) => component.type)
    const hasLimitedTimeOffer = topLevelTypes.includes('limited_time_offer')
    const hasCarousel = topLevelTypes.includes('carousel')

    const topButtonsComponent = firstMarketingComponent(components, 'buttons')
    const topButtons = Array.isArray(topButtonsComponent?.buttons) ? topButtonsComponent.buttons : []
    const hasMpmButton = topButtons.some((button: any) => button?.type === 'mpm')
    const hasCopyCodeButton = topButtons.some((button: any) => button?.type === 'copy_code')

    let marketingPattern: 'standard' | 'limited_time_offer' | 'coupon_code' | 'media_card_carousel' | 'product_card_carousel' | 'mpm' = 'standard'
    if (hasCarousel) {
        const carousel = firstMarketingComponent(components, 'carousel')
        const cards = Array.isArray(carousel?.cards) ? carousel.cards : []
        const hasProductHeader = cards.some((card: any) => {
            const cardComponents = Array.isArray(card?.components) ? card.components : []
            const header = firstMarketingComponent(cardComponents, 'header')
            return readTrimmed(header?.format).toLowerCase() === 'product'
        })
        marketingPattern = hasProductHeader ? 'product_card_carousel' : 'media_card_carousel'
    } else if (hasLimitedTimeOffer) {
        marketingPattern = 'limited_time_offer'
    } else if (hasMpmButton) {
        marketingPattern = 'mpm'
    } else if (hasCopyCodeButton) {
        marketingPattern = 'coupon_code'
    }

    const normalizedComponents: any[] = []
    let outputParameterFormat: 'named' | 'positional' = parameterFormat

    if (marketingPattern === 'limited_time_offer') {
        ensureOnlyMarketingTopTypes(components, new Set(['header', 'limited_time_offer', 'body', 'buttons']), errors)
        if (countMarketingComponents(components, 'header') !== 1) errors.push('limited_time_offer template requires exactly one HEADER')
        if (countMarketingComponents(components, 'limited_time_offer') !== 1) errors.push('limited_time_offer template requires exactly one LIMITED_TIME_OFFER component')
        if (countMarketingComponents(components, 'body') !== 1) errors.push('limited_time_offer template requires exactly one BODY')
        if (countMarketingComponents(components, 'buttons') !== 1) errors.push('limited_time_offer template requires exactly one BUTTONS')
        if (countMarketingComponents(components, 'footer') > 0) errors.push('limited_time_offer template does not allow FOOTER')

        const ordered = components.map((component: any) => component.type).join(',')
        if (ordered !== 'header,limited_time_offer,body,buttons') {
            errors.push('limited_time_offer components must be in order: header, limited_time_offer, body, buttons')
        }

        const headerComponent = firstMarketingComponent(components, 'header')
        const headerFormat = readTrimmed(headerComponent?.format).toLowerCase()
        if (headerFormat !== 'image' && headerFormat !== 'video') {
            errors.push('limited_time_offer HEADER.format must be image or video')
        }
        const headerHandle = extractHeaderHandle(headerComponent)
        if (!headerHandle) errors.push('limited_time_offer HEADER requires example.header_handle')
        normalizedComponents.push({
            type: 'header',
            format: headerFormat || 'image',
            example: {
                header_handle: headerHandle ? [headerHandle] : []
            }
        })

        const offerComponent = firstMarketingComponent(components, 'limited_time_offer')
        const offerData = isObject(offerComponent?.limited_time_offer) ? offerComponent.limited_time_offer : null
        const offerText = readTrimmed(offerData?.text)
        if (!offerText) errors.push('limited_time_offer.text is required')
        if (offerText.length > 16) errors.push('limited_time_offer.text must be <= 16 characters')
        const hasExpiration = parseBooleanOption(offerData?.has_expiration)
        if (hasExpiration === undefined) errors.push('limited_time_offer.has_expiration must be true or false')
        normalizedComponents.push({
            type: 'limited_time_offer',
            limited_time_offer: {
                text: offerText,
                has_expiration: Boolean(hasExpiration)
            }
        })

        const bodyValidation = buildNormalizedBodyComponent(
            firstMarketingComponent(components, 'body'),
            {
                label: 'BODY',
                maxLength: 600,
                parameterFormat: 'positional',
                allowNamed: false,
                allowPositional: true,
                requireExamples: true
            },
            errors
        )
        if (bodyValidation.component) normalizedComponents.push(bodyValidation.component)
        outputParameterFormat = 'positional'

        const buttonsComponent = firstMarketingComponent(components, 'buttons')
        const buttons = Array.isArray(buttonsComponent?.buttons) ? buttonsComponent.buttons : []
        if (buttons.length !== 2) {
            errors.push('limited_time_offer buttons must contain exactly 2 buttons: copy_code and url')
        }

        const normalizedButtons: any[] = []
        buttons.forEach((button: any, index: number) => {
            const type = normalizeMarketingToken(button?.type)
            if (index === 0 && type !== 'copy_code') {
                errors.push('limited_time_offer button[0] must be type copy_code')
            }
            if (index === 1 && type !== 'url') {
                errors.push('limited_time_offer button[1] must be type url')
            }

            if (type === 'copy_code') {
                const example = readTrimmed(button?.example)
                if (!example) errors.push('limited_time_offer copy_code button requires example')
                if (example.length > 15) errors.push('limited_time_offer copy_code example must be <= 15 characters')
                normalizedButtons.push({
                    type: 'copy_code',
                    example
                })
                return
            }

            if (type === 'url') {
                const text = readTrimmed(button?.text || button?.title)
                const url = readTrimmed(button?.url)
                const urlExamples = toStringArray(button?.example)
                if (!text) errors.push('limited_time_offer url button text is required')
                if (text.length > 25) errors.push('limited_time_offer url button text must be <= 25 characters')
                if (!url) errors.push('limited_time_offer url button url is required')
                if (url.length > 2000) errors.push('limited_time_offer url button url must be <= 2000 characters')
                if (urlExamples.length !== 1) errors.push('limited_time_offer url button requires one example URL')
                normalizedButtons.push({
                    type: 'url',
                    text,
                    url,
                    example: urlExamples.slice(0, 1)
                })
                return
            }

            errors.push(`limited_time_offer button[${index}] has unsupported type ${type || '(empty)'}`)
        })

        normalizedComponents.push({
            type: 'buttons',
            buttons: normalizedButtons
        })
    } else if (marketingPattern === 'coupon_code') {
        ensureOnlyMarketingTopTypes(components, new Set(['header', 'body', 'buttons']), errors)
        if (countMarketingComponents(components, 'body') !== 1) errors.push('coupon_code template requires exactly one BODY')
        if (countMarketingComponents(components, 'buttons') !== 1) errors.push('coupon_code template requires exactly one BUTTONS')
        if (countMarketingComponents(components, 'footer') > 0) errors.push('coupon_code template does not allow FOOTER')

        const headerComponent = firstMarketingComponent(components, 'header')
        if (countMarketingComponents(components, 'header') > 1) errors.push('coupon_code template allows at most one HEADER')
        if (headerComponent) {
            const format = readTrimmed(headerComponent.format || 'text').toLowerCase()
            if (format !== 'text') errors.push('coupon_code HEADER.format must be text')
            const text = readTrimmed(headerComponent.text)
            if (!text) errors.push('coupon_code HEADER.text is required')
            if (text.length > 60) errors.push('coupon_code HEADER.text must be <= 60 characters')
            normalizedComponents.push({
                type: 'header',
                format: 'text',
                text
            })
        }

        const bodyValidation = buildNormalizedBodyComponent(
            firstMarketingComponent(components, 'body'),
            {
                label: 'BODY',
                maxLength: 1024,
                parameterFormat: 'positional',
                allowNamed: false,
                allowPositional: true,
                requireExamples: true
            },
            errors
        )
        if (bodyValidation.component) normalizedComponents.push(bodyValidation.component)
        outputParameterFormat = 'positional'

        const buttonsComponent = firstMarketingComponent(components, 'buttons')
        const buttons = Array.isArray(buttonsComponent?.buttons) ? buttonsComponent.buttons : []
        if (buttons.length === 0) errors.push('coupon_code BUTTONS.buttons must contain at least one button')
        if (buttons.length > 2) errors.push('coupon_code BUTTONS.buttons supports at most 2 buttons')

        const copyCodeButtons = buttons.filter((button: any) => normalizeMarketingToken(button?.type) === 'copy_code')
        if (copyCodeButtons.length !== 1) errors.push('coupon_code template requires exactly one copy_code button')

        const normalizedButtons: any[] = []
        buttons.forEach((button: any, index: number) => {
            const type = normalizeMarketingToken(button?.type)
            if (type === 'quick_reply') {
                const text = readTrimmed(button?.text || button?.title)
                if (!text) errors.push(`coupon_code BUTTONS.buttons[${index}] quick_reply text is required`)
                if (text.length > 25) errors.push(`coupon_code BUTTONS.buttons[${index}] quick_reply text must be <= 25 characters`)
                if (text && !hasAlphaNumericOnly(text.replace(/\s+/g, ''))) {
                    errors.push(`coupon_code BUTTONS.buttons[${index}] quick_reply text must be alphanumeric`)
                }
                normalizedButtons.push({
                    type: 'quick_reply',
                    text
                })
                return
            }
            if (type === 'copy_code') {
                const example = readTrimmed(button?.example)
                if (!example) errors.push(`coupon_code BUTTONS.buttons[${index}] copy_code example is required`)
                if (example.length > 20) errors.push(`coupon_code BUTTONS.buttons[${index}] copy_code example must be <= 20 characters`)
                if (example && !hasAlphaNumericOnly(example)) {
                    errors.push(`coupon_code BUTTONS.buttons[${index}] copy_code example must be alphanumeric`)
                }
                normalizedButtons.push({
                    type: 'copy_code',
                    example
                })
                return
            }
            errors.push(`coupon_code BUTTONS.buttons[${index}].type must be quick_reply or copy_code`)
        })

        if (normalizedButtons.length === 2) {
            if (normalizedButtons[0]?.type !== 'quick_reply' || normalizedButtons[1]?.type !== 'copy_code') {
                errors.push('coupon_code buttons must be ordered: quick_reply (optional), then copy_code')
            }
        }

        normalizedComponents.push({
            type: 'buttons',
            buttons: normalizedButtons
        })
    } else if (marketingPattern === 'media_card_carousel' || marketingPattern === 'product_card_carousel') {
        ensureOnlyMarketingTopTypes(components, new Set(['body', 'carousel']), errors)
        if (countMarketingComponents(components, 'body') !== 1) errors.push('carousel template requires exactly one BODY component')
        if (countMarketingComponents(components, 'carousel') !== 1) errors.push('carousel template requires exactly one CAROUSEL component')

        const bodyValidation = buildNormalizedBodyComponent(
            firstMarketingComponent(components, 'body'),
            {
                label: 'BODY',
                maxLength: 1024,
                parameterFormat: 'positional',
                allowNamed: false,
                allowPositional: true,
                requireExamples: true
            },
            errors
        )
        if (bodyValidation.component) normalizedComponents.push(bodyValidation.component)
        outputParameterFormat = 'positional'

        const carouselComponent = firstMarketingComponent(components, 'carousel')
        const cards = Array.isArray(carouselComponent?.cards) ? carouselComponent.cards : []
        if (cards.length < 2) errors.push('carousel.cards must contain at least 2 cards')
        if (cards.length > 10) errors.push('carousel.cards must contain at most 10 cards')
        if (marketingPattern === 'product_card_carousel' && cards.length !== 2) {
            errors.push('product_card_carousel create requires exactly 2 cards')
        }

        let expectedSignature = ''
        let expectedHasBody: boolean | null = null
        const normalizedCards: any[] = []

        cards.forEach((card: any, cardIndex: number) => {
            const label = `carousel.cards[${cardIndex}]`
            const cardComponents = Array.isArray(card?.components) ? normalizeMarketingCreateComponents(card.components) : []
            ensureOnlyMarketingTopTypes(cardComponents, new Set(['header', 'body', 'buttons']), errors, label)

            if (countMarketingComponents(cardComponents, 'header') !== 1) {
                errors.push(`${label} requires exactly one header`)
            }
            if (countMarketingComponents(cardComponents, 'buttons') !== 1) {
                errors.push(`${label} requires exactly one buttons component`)
            }
            if (countMarketingComponents(cardComponents, 'body') > 1) {
                errors.push(`${label} allows at most one body component`)
            }

            const cardHeader = firstMarketingComponent(cardComponents, 'header')
            const cardHeaderFormat = readTrimmed(cardHeader?.format).toLowerCase()
            const cardBody = firstMarketingComponent(cardComponents, 'body')
            const cardButtonsComponent = firstMarketingComponent(cardComponents, 'buttons')
            const cardButtons = Array.isArray(cardButtonsComponent?.buttons) ? cardButtonsComponent.buttons : []

            const normalizedCardComponents: any[] = []
            if (marketingPattern === 'product_card_carousel') {
                if (cardHeaderFormat !== 'product') {
                    errors.push(`${label}.header.format must be product`)
                }
                normalizedCardComponents.push({
                    type: 'header',
                    format: 'product'
                })
            } else {
                if (cardHeaderFormat !== 'image' && cardHeaderFormat !== 'video') {
                    errors.push(`${label}.header.format must be image or video`)
                }
                const handle = extractHeaderHandle(cardHeader)
                if (!handle) errors.push(`${label}.header requires example.header_handle`)
                normalizedCardComponents.push({
                    type: 'header',
                    format: cardHeaderFormat || 'image',
                    example: {
                        header_handle: handle ? [handle] : []
                    }
                })
            }

            if (cardBody) {
                const cardBodyValidation = buildNormalizedBodyComponent(
                    cardBody,
                    {
                        label: `${label}.body`,
                        maxLength: 160,
                        parameterFormat: 'positional',
                        allowNamed: false,
                        allowPositional: true,
                        requireExamples: true
                    },
                    errors
                )
                if (cardBodyValidation.component) normalizedCardComponents.push(cardBodyValidation.component)
            }

            const normalizedCardButtons: any[] = []
            if (cardButtons.length === 0) errors.push(`${label}.buttons.buttons must not be empty`)

            cardButtons.forEach((button: any, buttonIndex: number) => {
                const buttonType = normalizeMarketingToken(button?.type)
                const buttonLabel = `${label}.buttons.buttons[${buttonIndex}]`
                if (!buttonType) {
                    errors.push(`${buttonLabel}.type is required`)
                    return
                }

                if (marketingPattern === 'product_card_carousel' && buttonType !== 'spm' && buttonType !== 'url') {
                    errors.push(`${buttonLabel}.type must be spm or url`)
                    return
                }

                if (marketingPattern === 'product_card_carousel' && cardButtons.length !== 1) {
                    errors.push(`${label} must have exactly one button`)
                }

                if (marketingPattern === 'media_card_carousel' && !new Set(['quick_reply', 'url', 'phone_number']).has(buttonType)) {
                    errors.push(`${buttonLabel}.type must be quick_reply, url, or phone_number`)
                    return
                }

                if (buttonType === 'quick_reply') {
                    const text = readTrimmed(button?.text || button?.title)
                    if (!text) errors.push(`${buttonLabel}.text is required`)
                    if (text.length > 25) errors.push(`${buttonLabel}.text must be <= 25 characters`)
                    normalizedCardButtons.push({
                        type: 'quick_reply',
                        text
                    })
                    return
                }

                if (buttonType === 'phone_number') {
                    const text = readTrimmed(button?.text || button?.title)
                    const phone = readTrimmed(button?.phone_number || button?.phoneNumber)
                    if (!text) errors.push(`${buttonLabel}.text is required`)
                    if (text.length > 25) errors.push(`${buttonLabel}.text must be <= 25 characters`)
                    if (!phone) errors.push(`${buttonLabel}.phone_number is required`)
                    if (phone.length > 20) errors.push(`${buttonLabel}.phone_number must be <= 20 characters`)
                    normalizedCardButtons.push({
                        type: 'phone_number',
                        text,
                        phone_number: phone
                    })
                    return
                }

                if (buttonType === 'spm') {
                    const text = readTrimmed(button?.text || 'View')
                    if (text.length > 25) errors.push(`${buttonLabel}.text must be <= 25 characters`)
                    normalizedCardButtons.push({
                        type: 'spm',
                        text: text || 'View'
                    })
                    return
                }

                if (buttonType === 'url') {
                    const text = readTrimmed(button?.text || button?.title)
                    const url = readTrimmed(button?.url)
                    const example = toStringArray(button?.example)
                    if (!text) errors.push(`${buttonLabel}.text is required`)
                    if (text.length > 25) errors.push(`${buttonLabel}.text must be <= 25 characters`)
                    if (!url) errors.push(`${buttonLabel}.url is required`)
                    if (url.length > 2000) errors.push(`${buttonLabel}.url must be <= 2000 characters`)
                    if (url.includes('{{') && example.length === 0) {
                        errors.push(`${buttonLabel}.example is required when URL uses variables`)
                    }
                    const normalizedUrl: any = {
                        type: 'url',
                        text,
                        url
                    }
                    if (example.length > 0) normalizedUrl.example = [example[0]]
                    normalizedCardButtons.push(normalizedUrl)
                }
            })

            normalizedCardComponents.push({
                type: 'buttons',
                buttons: normalizedCardButtons
            })

            const hasCardBody = Boolean(cardBody)
            if (marketingPattern === 'media_card_carousel') {
                if (expectedHasBody === null) expectedHasBody = hasCardBody
                else if (expectedHasBody !== hasCardBody) {
                    errors.push('If one media carousel card has a body, all cards must include a body')
                }
            }

            const signature = JSON.stringify({
                types: normalizedCardComponents.map((item) => item.type),
                buttonTypes: normalizedCardButtons.map((item) => item.type),
                headerFormat: normalizedCardComponents[0]?.format || ''
            })
            if (!expectedSignature) expectedSignature = signature
            else if (expectedSignature !== signature) {
                errors.push('All carousel cards must have the same component structure and button order')
            }

            normalizedCards.push({
                components: normalizedCardComponents
            })
        })

        normalizedComponents.push({
            type: 'carousel',
            cards: normalizedCards
        })
    } else if (marketingPattern === 'mpm') {
        ensureOnlyMarketingTopTypes(components, new Set(['header', 'body', 'footer', 'buttons']), errors)
        if (countMarketingComponents(components, 'body') !== 1) errors.push('mpm template requires exactly one BODY')
        if (countMarketingComponents(components, 'buttons') !== 1) errors.push('mpm template requires exactly one BUTTONS')

        const headerComponent = firstMarketingComponent(components, 'header')
        if (countMarketingComponents(components, 'header') > 1) errors.push('mpm template allows at most one HEADER')
        if (headerComponent) {
            const format = readTrimmed(headerComponent.format || 'text').toLowerCase()
            if (format !== 'text') errors.push('mpm HEADER.format must be text')
            const text = readTrimmed(headerComponent.text)
            if (!text) errors.push('mpm HEADER.text is required')
            if (text.length > 60) errors.push('mpm HEADER.text must be <= 60 characters')
            const headerVars = extractPositionalVars(text)
            if (headerVars.length > 1) errors.push('mpm HEADER supports at most one variable')
            const headerExamples = toStringArray(headerComponent?.example?.header_text)
            if (headerVars.length > 0 && headerExamples.length === 0) {
                errors.push('mpm HEADER.example.header_text is required when header has variables')
            }
            const normalizedHeader: any = {
                type: 'header',
                format: 'text',
                text
            }
            if (headerExamples.length > 0) normalizedHeader.example = { header_text: [headerExamples[0]] }
            normalizedComponents.push(normalizedHeader)
        }

        const bodyValidation = buildNormalizedBodyComponent(
            firstMarketingComponent(components, 'body'),
            {
                label: 'BODY',
                maxLength: 1024,
                parameterFormat: 'positional',
                allowNamed: false,
                allowPositional: true,
                requireExamples: true
            },
            errors
        )
        if (bodyValidation.component) normalizedComponents.push(bodyValidation.component)
        outputParameterFormat = 'positional'

        const footerComponent = firstMarketingComponent(components, 'footer')
        if (countMarketingComponents(components, 'footer') > 1) errors.push('mpm template allows at most one FOOTER')
        if (footerComponent) {
            const footerText = readTrimmed(footerComponent.text)
            if (!footerText) errors.push('mpm FOOTER.text is required')
            if (footerText.length > 60) errors.push('mpm FOOTER.text must be <= 60 characters')
            if (extractPositionalVars(footerText).length > 0 || extractNamedVars(footerText).length > 0) {
                errors.push('mpm FOOTER.text must not contain variables')
            }
            normalizedComponents.push({
                type: 'footer',
                text: footerText
            })
        }

        const buttonsComponent = firstMarketingComponent(components, 'buttons')
        const buttons = Array.isArray(buttonsComponent?.buttons) ? buttonsComponent.buttons : []
        if (buttons.length !== 1) {
            errors.push('mpm BUTTONS must contain exactly one button')
        }
        const mpmButton = buttons[0]
        const mpmButtonType = normalizeMarketingToken(mpmButton?.type)
        if (mpmButtonType !== 'mpm') errors.push('mpm BUTTONS.buttons[0].type must be mpm')
        const mpmButtonText = readTrimmed(mpmButton?.text || mpmButton?.title)
        if (!mpmButtonText) errors.push('mpm button text is required')
        if (mpmButtonText.length > 25) errors.push('mpm button text must be <= 25 characters')
        normalizedComponents.push({
            type: 'buttons',
            buttons: [
                {
                    type: 'mpm',
                    text: mpmButtonText
                }
            ]
        })
    } else {
        ensureOnlyMarketingTopTypes(components, new Set(['header', 'body', 'footer', 'buttons']), errors)
        if (countMarketingComponents(components, 'header') > 1) errors.push('only one HEADER component is allowed')
        if (countMarketingComponents(components, 'body') !== 1) errors.push('exactly one BODY component is required')
        if (countMarketingComponents(components, 'footer') > 1) errors.push('only one FOOTER component is allowed')
        if (countMarketingComponents(components, 'buttons') > 1) errors.push('only one BUTTONS component is allowed')

        const headerComponent = firstMarketingComponent(components, 'header')
        if (headerComponent) {
            const format = readTrimmed(headerComponent.format).toLowerCase()
            if (!new Set(['text', 'image', 'video', 'document', 'location']).has(format)) {
                errors.push('HEADER.format must be one of text, image, video, document, location')
            } else if (format === 'text') {
                const text = readTrimmed(headerComponent.text)
                if (!text) errors.push('HEADER.text is required when HEADER.format is text')
                if (text.length > 60) errors.push('HEADER.text must be <= 60 characters')
                normalizedComponents.push({
                    type: 'header',
                    format: 'text',
                    text
                })
            } else if (format === 'image' || format === 'video' || format === 'document') {
                const handle = extractHeaderHandle(headerComponent)
                if (!handle) errors.push(`HEADER.format ${format} requires example.header_handle`)
                normalizedComponents.push({
                    type: 'header',
                    format,
                    example: {
                        header_handle: handle ? [handle] : []
                    }
                })
            } else {
                normalizedComponents.push({
                    type: 'header',
                    format: 'location'
                })
            }
        }

        const bodyValidation = buildNormalizedBodyComponent(
            firstMarketingComponent(components, 'body'),
            {
                label: 'BODY',
                maxLength: 1024,
                parameterFormat,
                allowNamed: true,
                allowPositional: true,
                requireExamples: true,
                enforceNamedRegex: MARKETING_NAMED_PARAM_REGEX
            },
            errors
        )
        if (bodyValidation.component) normalizedComponents.push(bodyValidation.component)
        outputParameterFormat = bodyValidation.effectiveParameterFormat

        const footerComponent = firstMarketingComponent(components, 'footer')
        if (footerComponent) {
            const footerText = readTrimmed(footerComponent.text)
            if (!footerText) errors.push('FOOTER.text is required when FOOTER exists')
            if (footerText.length > 60) errors.push('FOOTER.text must be <= 60 characters')
            normalizedComponents.push({
                type: 'footer',
                text: footerText
            })
        }

        const buttonsComponent = firstMarketingComponent(components, 'buttons')
        if (buttonsComponent) {
            const buttons = Array.isArray(buttonsComponent.buttons) ? buttonsComponent.buttons : []
            if (buttons.length === 0) errors.push('BUTTONS.buttons must contain at least one button')
            if (buttons.length > 10) errors.push('BUTTONS supports up to 10 buttons')

            const normalizedButtons: any[] = []
            buttons.forEach((button: any, index: number) => {
                const type = normalizeMarketingToken(button?.type)
                const label = readTrimmed(button?.text || button?.title)
                const buttonLabel = `BUTTONS.buttons[${index}]`

                if (!new Set(['url', 'phone_number', 'quick_reply', 'copy_code', 'call_request', 'spm', 'mpm']).has(type)) {
                    errors.push(`${buttonLabel}.type is invalid`)
                    return
                }

                const nextButton: any = { type }
                if (label) {
                    if (label.length > 25) errors.push(`${buttonLabel}.text must be <= 25 characters`)
                    nextButton.text = label
                } else if (type !== 'call_request' && type !== 'copy_code') {
                    errors.push(`${buttonLabel}.text is required`)
                }

                if (type === 'url') {
                    const url = readTrimmed(button?.url)
                    if (!url) errors.push(`${buttonLabel}.url is required`)
                    nextButton.url = url
                    const example = toStringArray(button?.example)
                    if (url.includes('{{') && example.length === 0) {
                        errors.push(`${buttonLabel}.example is required when URL uses variables`)
                    }
                    if (example.length > 0) nextButton.example = [example[0]]
                }
                if (type === 'phone_number') {
                    const phone = readTrimmed(button?.phone_number || button?.phoneNumber)
                    if (!phone) errors.push(`${buttonLabel}.phone_number is required`)
                    if (phone.length > 20) errors.push(`${buttonLabel}.phone_number must be <= 20 characters`)
                    nextButton.phone_number = phone
                }
                if (type === 'copy_code') {
                    const example = readTrimmed(button?.example)
                    if (example) {
                        if (example.length > 20) errors.push(`${buttonLabel}.example must be <= 20 characters`)
                        nextButton.example = example
                    }
                }

                normalizedButtons.push(nextButton)
            })

            normalizedComponents.push({
                type: 'buttons',
                buttons: normalizedButtons
            })
        }
    }

    if (errors.length > 0) return { payload: null, errors }

    return {
        payload: {
            name,
            category: 'marketing',
            language,
            parameter_format: outputParameterFormat,
            components: normalizedComponents
        },
        errors: []
    }
}

function hasEmoji(value: string): boolean {
    if (!value) return false
    return /(?:[\u2600-\u27BF]|[\uD83C-\uDBFF][\uDC00-\uDFFF])/.test(value)
}

function hasUrlLikeText(value: string): boolean {
    if (!value) return false
    return /(https?:\/\/|www\.)/i.test(value)
}

function parseBooleanOption(value: any): boolean | undefined {
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase()
        if (normalized === 'true') return true
        if (normalized === 'false') return false
    }
    return undefined
}

function parseLanguageCodes(value: any): string[] {
    if (Array.isArray(value)) {
        return value.map((item) => readTrimmed(item)).filter(Boolean)
    }
    if (typeof value === 'string') {
        return value.split(',').map((part) => part.trim()).filter(Boolean)
    }
    return []
}

function hasUnsupportedAuthUpsertButtonFields(components: any[]): string[] {
    const errors: string[] = []
    components.forEach((component: any, componentIndex: number) => {
        if (!isObject(component) || component.type !== 'BUTTONS' || !Array.isArray(component.buttons)) return
        component.buttons.forEach((button: any, buttonIndex: number) => {
            if (!isObject(button)) return
            if (Object.prototype.hasOwnProperty.call(button, 'text')) {
                errors.push(`components[${componentIndex}].buttons[${buttonIndex}].text is not supported in upsert_message_templates`)
            }
            if (Object.prototype.hasOwnProperty.call(button, 'autofill_text')) {
                errors.push(`components[${componentIndex}].buttons[${buttonIndex}].autofill_text is not supported in upsert_message_templates`)
            }
        })
    })
    return errors
}

function validateAuthenticationTemplateInput(input: any): { payload: any | null; errors: string[] } {
    const errors: string[] = []

    const name = readTrimmed(input?.name)
    if (!name) {
        errors.push('name is required')
    } else {
        if (name.length > 512) errors.push('name must be <= 512 characters')
        if (!/^[a-z0-9_]+$/.test(name)) errors.push('name must use lowercase letters, numbers, and underscores only')
    }

    const category = readTrimmed(input?.category || 'authentication').toLowerCase()
    if (category !== 'authentication') {
        errors.push('category must be authentication')
    }

    const language = readTrimmed(input?.language)
    if (!language) errors.push('language is required (example: en_US)')

    const ttlRaw = input?.message_send_ttl_seconds
    let messageSendTtlSeconds: number | undefined
    if (ttlRaw !== undefined && ttlRaw !== null && `${ttlRaw}`.trim() !== '') {
        const parsed = Number(ttlRaw)
        if (!Number.isFinite(parsed) || parsed <= 0) {
            errors.push('message_send_ttl_seconds must be a positive number')
        } else {
            messageSendTtlSeconds = Math.floor(parsed)
        }
    }

    const addSecurityRecommendationRaw = input?.add_security_recommendation
    const addSecurityRecommendation = parseBooleanOption(addSecurityRecommendationRaw)
    if (addSecurityRecommendationRaw !== undefined && addSecurityRecommendation === undefined) {
        errors.push('add_security_recommendation must be true or false')
    }

    const expirationRaw = input?.code_expiration_minutes
    let codeExpirationMinutes: number | undefined
    if (expirationRaw !== undefined && expirationRaw !== null && `${expirationRaw}`.trim() !== '') {
        const parsed = Number(expirationRaw)
        if (!Number.isFinite(parsed) || parsed < 1 || parsed > 90) {
            errors.push('code_expiration_minutes must be between 1 and 90')
        } else {
            codeExpirationMinutes = Math.floor(parsed)
        }
    }

    const rawComponents = Array.isArray(input?.components) ? input.components : []
    const components = normalizeTemplateCreationComponents(rawComponents)

    if (components.some((component: any) => component.type === 'HEADER')) {
        errors.push('authentication templates do not support HEADER/media components')
    }

    const bodyComponents = components.filter((component: any) => component.type === 'BODY')
    const footerComponents = components.filter((component: any) => component.type === 'FOOTER')
    const buttonsComponents = components.filter((component: any) => component.type === 'BUTTONS')

    if (components.length > 0 && bodyComponents.length !== 1) {
        errors.push('exactly one BODY component is required when components are provided')
    }
    if (footerComponents.length > 1) errors.push('only one FOOTER component is allowed')
    if (buttonsComponents.length > 1) errors.push('only one BUTTONS component is allowed')

    const body = bodyComponents[0]
    if (body) {
        const bodyText = readTrimmed(body.text)
        if (!bodyText) {
            errors.push('BODY.text is required')
        } else {
            if (bodyText.length > 1024) errors.push('BODY.text must be <= 1024 characters')
            if (!bodyText.includes('{{1}}')) errors.push('BODY.text must include OTP placeholder {{1}}')
            if (hasUrlLikeText(bodyText)) errors.push('BODY.text must not contain URLs')
            if (hasEmoji(bodyText)) errors.push('BODY.text must not contain emojis')
        }
    }

    const footer = footerComponents[0]
    if (footer) {
        const footerText = readTrimmed(footer.text)
        if (!footerText) errors.push('FOOTER.text is required when FOOTER exists')
        if (footerText.length > 60) errors.push('FOOTER.text must be <= 60 characters')
        if (hasUrlLikeText(footerText)) errors.push('FOOTER.text must not contain URLs')
        if (hasEmoji(footerText)) errors.push('FOOTER.text must not contain emojis')
    }

    const buttonsBlock = buttonsComponents[0]
    if (buttonsBlock) {
        const buttons = Array.isArray(buttonsBlock.buttons) ? buttonsBlock.buttons : []
        if (buttons.length === 0) errors.push('BUTTONS.buttons must contain at least one button')
        if (buttons.length > 1) errors.push('authentication templates support only one OTP button')

        const allowedTypes = new Set(['OTP', 'COPY_CODE', 'ONE_TAP', 'ZERO_TAP', 'URL'])
        buttons.forEach((button: any, index: number) => {
            const type = readTrimmed(button?.type).toUpperCase()
            if (!allowedTypes.has(type)) {
                errors.push(`BUTTONS.buttons[${index}].type must be OTP-compatible`)
            }
            const label = readTrimmed(button?.text || button?.title)
            if (hasEmoji(label)) errors.push(`BUTTONS.buttons[${index}] label must not contain emojis`)
            if (button?.url) errors.push(`BUTTONS.buttons[${index}] must not define a custom URL for authentication`)
        })
    }

    if (errors.length > 0) return { payload: null, errors }

    const payload: any = {
        name,
        language,
        category: 'AUTHENTICATION'
    }
    if (components.length > 0) payload.components = components
    if (messageSendTtlSeconds !== undefined) payload.message_send_ttl_seconds = messageSendTtlSeconds
    if (addSecurityRecommendation !== undefined) payload.add_security_recommendation = addSecurityRecommendation
    if (codeExpirationMinutes !== undefined) payload.code_expiration_minutes = codeExpirationMinutes

    return { payload, errors: [] }
}

function validateAuthenticationUpsertInput(input: any): { payload: any | null; errors: string[] } {
    const errors: string[] = []

    const languages = parseLanguageCodes(input?.languages)
    if (languages.length === 0) {
        errors.push('languages is required and must contain at least one language code')
    }

    const baseValidation = validateAuthenticationTemplateInput({
        ...input,
        language: languages[0] || input?.language || 'en_US'
    })
    if (baseValidation.errors.length > 0 || !baseValidation.payload) {
        return { payload: null, errors: baseValidation.errors }
    }

    const components = Array.isArray(baseValidation.payload.components) ? baseValidation.payload.components : []
    errors.push(...hasUnsupportedAuthUpsertButtonFields(components))

    if (errors.length > 0) return { payload: null, errors }

    const payload: any = {
        ...baseValidation.payload,
        languages,
        category: 'AUTHENTICATION'
    }
    delete payload.language

    return { payload, errors: [] }
}

function parseAuthenticationPreviewOptions(input: any): { options: any; errors: string[] } {
    const errors: string[] = []
    const options: any = {}

    const languages = parseLanguageCodes(input?.language)
    if (languages.length > 0) options.language = languages

    const addSecurityRaw = input?.add_security_recommendation
    if (addSecurityRaw !== undefined) {
        const parsed = parseBooleanOption(addSecurityRaw)
        if (parsed === undefined) errors.push('add_security_recommendation must be true or false')
        else options.addSecurityRecommendation = parsed
    }

    const codeExpirationRaw = input?.code_expiration_minutes
    if (codeExpirationRaw !== undefined && codeExpirationRaw !== null && `${codeExpirationRaw}`.trim() !== '') {
        const parsed = Number(codeExpirationRaw)
        if (!Number.isFinite(parsed) || parsed < 1 || parsed > 90) {
            errors.push('code_expiration_minutes must be between 1 and 90')
        } else {
            options.codeExpirationMinutes = Math.floor(parsed)
        }
    }

    return { options, errors }
}

function parseAuthenticationCode(value: any): { code: string; error: string | null } {
    const code = readTrimmed(value)
    if (!code) return { code: '', error: 'code is required' }
    if (code.length > 15) return { code: '', error: 'code must be <= 15 characters' }
    if (hasEmoji(code)) return { code: '', error: 'code must not contain emojis' }
    return { code, error: null }
}

function normalizeTemplateSendComponents(raw: any): any[] | undefined {
    if (!Array.isArray(raw) || raw.length === 0) return undefined
    const components = raw
        .filter((component: any) => isObject(component))
        .map((component: any) => {
            const normalizedType = readTrimmed(component.type).toLowerCase()
            const normalizedSubType = readTrimmed(component.sub_type).toLowerCase()
            const next: any = { ...component }
            if (normalizedType) next.type = normalizedType
            if (normalizedSubType) next.sub_type = normalizedSubType
            return next
        })
        .filter((component: any) => readTrimmed(component.type))
    return components.length > 0 ? components : undefined
}

function normalizeTemplateSendParameters(raw: any): any[] {
    if (!Array.isArray(raw)) return []
    const params: any[] = []
    raw.forEach((item) => {
        if (isObject(item)) {
            params.push(item)
            return
        }
        if (item === null || item === undefined) return
        params.push({
            type: 'text',
            text: String(item)
        })
    })
    return params
}

function buildTemplateSendComponents(input: any): any[] | undefined {
    const direct = normalizeTemplateSendComponents(input?.components)
    if (direct) return direct

    const headerParameters = normalizeTemplateSendParameters(input?.headerParameters || input?.header_parameters)
    const bodyParameters = normalizeTemplateSendParameters(input?.bodyParameters || input?.body_parameters || input?.parameters)

    if (headerParameters.length === 0) {
        const headerType = readTrimmed(input?.headerType || input?.header_type).toLowerCase()
        const headerText = readTrimmed(input?.headerText || input?.header_text)
        const headerLink = readTrimmed(
            input?.documentLink
            || input?.document_link
            || input?.mediaLink
            || input?.media_link
            || input?.headerLink
            || input?.header_link
        )
        let headerFilename = readTrimmed(input?.documentFilename || input?.document_filename || input?.headerFilename || input?.header_filename)

        if (headerType === 'text' && headerText) {
            headerParameters.push({ type: 'text', text: headerText })
        } else if ((headerType === 'image' || headerType === 'video' || headerType === 'document') && headerLink) {
            if (headerType === 'document' && headerFilename && !headerFilename.toLowerCase().endsWith('.pdf')) {
                headerFilename = `${headerFilename}.pdf`
            }
            headerParameters.push({
                type: headerType,
                [headerType]: {
                    link: headerLink,
                    ...(headerType === 'document' && headerFilename ? { filename: headerFilename } : {})
                }
            })
        }
    }

    if (bodyParameters.length === 0) {
        const bodyAttributes = input?.bodyAttributes ?? input?.body_attributes
        if (Array.isArray(bodyAttributes)) {
            bodyAttributes.forEach((value: any) => {
                bodyParameters.push({
                    type: 'text',
                    text: value === null || value === undefined ? '' : String(value)
                })
            })
        }
    }

    const built: any[] = []
    if (headerParameters.length > 0) built.push({ type: 'header', parameters: headerParameters })
    if (bodyParameters.length > 0) built.push({ type: 'body', parameters: bodyParameters })
    return built.length > 0 ? built : undefined
}

function validateTemplateSendComponents(components: any[] | undefined): string[] {
    const errors: string[] = []
    if (!Array.isArray(components) || components.length === 0) return errors

    const validateList = (list: any[], path: string, insideCarouselCard: boolean) => {
        list.forEach((component: any, index: number) => {
            if (!isObject(component)) {
                errors.push(`${path}[${index}] must be an object`)
                return
            }

            const type = readTrimmed(component.type).toLowerCase()
            if (!type) {
                errors.push(`${path}[${index}].type is required`)
                return
            }

            const componentPath = `${path}[${index}]`

            if (type === 'header' || type === 'body') {
                if (component.parameters !== undefined && !Array.isArray(component.parameters)) {
                    errors.push(`${componentPath}.parameters must be an array`)
                }
                return
            }

            if (type === 'limited_time_offer') {
                if (insideCarouselCard) {
                    errors.push(`${componentPath}.type limited_time_offer is not supported inside carousel cards`)
                }
                const parameters = Array.isArray(component.parameters) ? component.parameters : []
                if (parameters.length !== 1) {
                    errors.push(`${componentPath}.parameters must contain one limited_time_offer parameter`)
                    return
                }
                const param = parameters[0]
                if (!isObject(param) || readTrimmed(param.type).toLowerCase() !== 'limited_time_offer') {
                    errors.push(`${componentPath}.parameters[0].type must be limited_time_offer`)
                    return
                }
                const expiration = Number(param?.limited_time_offer?.expiration_time_ms)
                if (!Number.isFinite(expiration) || expiration <= 0) {
                    errors.push(`${componentPath}.parameters[0].limited_time_offer.expiration_time_ms must be a positive unix timestamp (ms)`)
                }
                return
            }

            if (type === 'carousel') {
                if (insideCarouselCard) {
                    errors.push(`${componentPath}.type carousel is not supported inside carousel cards`)
                    return
                }
                const cards = Array.isArray(component.cards) ? component.cards : []
                if (cards.length === 0) {
                    errors.push(`${componentPath}.cards must contain at least one card`)
                    return
                }
                if (cards.length > 10) {
                    errors.push(`${componentPath}.cards must contain at most 10 cards`)
                }
                cards.forEach((card: any, cardIndex: number) => {
                    if (!isObject(card)) {
                        errors.push(`${componentPath}.cards[${cardIndex}] must be an object`)
                        return
                    }
                    const parsedCardIndex = Number(card.card_index)
                    if (!Number.isFinite(parsedCardIndex) || parsedCardIndex < 0) {
                        errors.push(`${componentPath}.cards[${cardIndex}].card_index must be a non-negative number`)
                    }
                    const cardComponents = Array.isArray(card.components) ? card.components : []
                    if (cardComponents.length === 0) {
                        errors.push(`${componentPath}.cards[${cardIndex}].components must not be empty`)
                        return
                    }
                    validateList(cardComponents, `${componentPath}.cards[${cardIndex}].components`, true)
                })
                return
            }

            if (type === 'button') {
                const subType = normalizeMarketingToken(component.sub_type || component.subType)
                if (!subType) {
                    errors.push(`${componentPath}.sub_type is required`)
                    return
                }

                const supported = new Set(['url', 'quick_reply', 'copy_code', 'mpm', 'spm', 'phone_number'])
                if (!supported.has(subType)) {
                    errors.push(`${componentPath}.sub_type "${subType}" is not supported`)
                    return
                }

                const parameters = Array.isArray(component.parameters) ? component.parameters : []
                if (parameters.length === 0) {
                    errors.push(`${componentPath}.parameters is required`)
                    return
                }
                const first = parameters[0]
                if (!isObject(first)) {
                    errors.push(`${componentPath}.parameters[0] must be an object`)
                    return
                }

                const parsedIndex = Number.parseInt(String(component.index ?? ''), 10)
                if (!Number.isFinite(parsedIndex)) {
                    errors.push(`${componentPath}.index is required`)
                }

                if (subType === 'url') {
                    const text = readTrimmed(first.text)
                    if (!text) errors.push(`${componentPath}.parameters[0].text is required for url button`)
                } else if (subType === 'copy_code') {
                    const code = readTrimmed(first.coupon_code)
                    if (!code) errors.push(`${componentPath}.parameters[0].coupon_code is required`)
                    if (code.length > 20) errors.push(`${componentPath}.parameters[0].coupon_code must be <= 20 characters`)
                } else if (subType === 'mpm') {
                    if (parsedIndex !== 0) errors.push(`${componentPath}.index must be 0 for mpm button`)
                    if (readTrimmed(first.type).toLowerCase() !== 'action') {
                        errors.push(`${componentPath}.parameters[0].type must be action`)
                    }
                    const action = isObject(first.action) ? first.action : null
                    if (!action) {
                        errors.push(`${componentPath}.parameters[0].action is required`)
                    } else {
                        const thumb = readTrimmed(action.thumbnail_product_retailer_id)
                        if (!thumb) errors.push(`${componentPath}.parameters[0].action.thumbnail_product_retailer_id is required`)
                        const sections = Array.isArray(action.sections) ? action.sections : []
                        if (sections.length === 0) errors.push(`${componentPath}.parameters[0].action.sections must not be empty`)
                        if (sections.length > 10) errors.push(`${componentPath}.parameters[0].action.sections supports at most 10 sections`)
                        let productCount = 0
                        sections.forEach((section: any, sectionIndex: number) => {
                            if (!isObject(section)) {
                                errors.push(`${componentPath}.parameters[0].action.sections[${sectionIndex}] must be an object`)
                                return
                            }
                            const title = readTrimmed(section.title)
                            if (!title) errors.push(`${componentPath}.parameters[0].action.sections[${sectionIndex}].title is required`)
                            if (title.length > 24) errors.push(`${componentPath}.parameters[0].action.sections[${sectionIndex}].title must be <= 24 characters`)
                            const items = Array.isArray(section.product_items) ? section.product_items : []
                            if (items.length === 0) errors.push(`${componentPath}.parameters[0].action.sections[${sectionIndex}].product_items must not be empty`)
                            productCount += items.length
                            items.forEach((item: any, itemIndex: number) => {
                                if (!isObject(item) || !readTrimmed(item.product_retailer_id)) {
                                    errors.push(`${componentPath}.parameters[0].action.sections[${sectionIndex}].product_items[${itemIndex}].product_retailer_id is required`)
                                }
                            })
                        })
                        if (productCount > 30) {
                            errors.push(`${componentPath}.parameters[0].action.sections contains more than 30 product_items`)
                        }
                    }
                }
                return
            }

            if (insideCarouselCard) {
                errors.push(`${componentPath}.type "${type}" is not supported in carousel cards`)
            } else {
                errors.push(`${componentPath}.type "${type}" is not supported`)
            }
        })
    }

    validateList(components, 'components', false)
    return errors
}

function parseMarketingProductPolicy(value: any): 'STRICT' | 'CLOUD_API_FALLBACK' | undefined {
    const normalized = readTrimmed(value).toUpperCase()
    if (!normalized) return undefined
    if (normalized === 'STRICT' || normalized === 'CLOUD_API_FALLBACK') return normalized
    return undefined
}

async function createTemplateMediaHeaderHandle(params: {
    accessToken: string
    appId: string
    apiVersion: string
    fileName: string
    fileType: string
    fileBuffer: Buffer
}): Promise<{ sessionId: string; headerHandle: string }> {
    const cleanApiVersion = readTrimmed(params.apiVersion || '').replace(/^\/+|\/+$/g, '') || 'v23.0'
    const cleanFileName = readTrimmed(params.fileName) || `template_asset_${Date.now()}`
    const cleanFileType = readTrimmed(params.fileType) || 'application/octet-stream'

    const initUrl = new URL(`https://graph.facebook.com/${cleanApiVersion}/${params.appId}/uploads`)
    initUrl.searchParams.set('file_name', cleanFileName)
    initUrl.searchParams.set('file_length', String(params.fileBuffer.byteLength))
    initUrl.searchParams.set('file_type', cleanFileType)

    const initRes = await fetch(initUrl.toString(), {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${params.accessToken}`
        }
    })
    const initText = await initRes.text()
    const initData = initText ? JSON.parse(initText) : null
    if (!initRes.ok || initData?.error) {
        const message = initData?.error?.message || initRes.statusText || 'Failed to start upload session'
        const code = initData?.error?.code
        throw new Error(`Upload session error ${initRes.status}${code ? ` (${code})` : ''}: ${message}`)
    }

    const sessionId = readTrimmed(initData?.id)
    if (!sessionId) {
        throw new Error('Upload session ID missing from Graph response')
    }

    const uploadBody = Uint8Array.from(params.fileBuffer)

    const uploadRes = await fetch(`https://graph.facebook.com/${cleanApiVersion}/${sessionId}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${params.accessToken}`,
            'file_offset': '0',
            'Content-Type': 'application/octet-stream'
        },
        body: uploadBody
    })
    const uploadText = await uploadRes.text()
    const uploadData = uploadText ? JSON.parse(uploadText) : null
    if (!uploadRes.ok || uploadData?.error) {
        const message = uploadData?.error?.message || uploadRes.statusText || 'Failed to upload binary data'
        const code = uploadData?.error?.code
        throw new Error(`Upload binary error ${uploadRes.status}${code ? ` (${code})` : ''}: ${message}`)
    }

    const headerHandle = readTrimmed(uploadData?.h)
    if (!headerHandle) {
        throw new Error('header_handle missing from upload response')
    }

    return {
        sessionId,
        headerHandle
    }
}

function parseMarketingSendOptions(input: any): {
    options: {
        components?: any[]
        productPolicy?: 'STRICT' | 'CLOUD_API_FALLBACK'
        messageActivitySharing?: boolean
        ttl?: number
        degreesOfFreedomSpec?: Record<string, any>
    }
    errors: string[]
} {
    const errors: string[] = []
    const options: {
        components?: any[]
        productPolicy?: 'STRICT' | 'CLOUD_API_FALLBACK'
        messageActivitySharing?: boolean
        ttl?: number
        degreesOfFreedomSpec?: Record<string, any>
    } = {}

    const components = buildTemplateSendComponents(input)
    if (components) {
        const componentErrors = validateTemplateSendComponents(components)
        componentErrors.forEach((error) => errors.push(error))
        options.components = components
    }

    const productPolicy = parseMarketingProductPolicy(input?.product_policy || input?.productPolicy)
    if ((input?.product_policy || input?.productPolicy) && !productPolicy) {
        errors.push('product_policy must be STRICT or CLOUD_API_FALLBACK')
    }
    if (productPolicy) options.productPolicy = productPolicy

    if (input?.message_activity_sharing !== undefined || input?.messageActivitySharing !== undefined) {
        const rawSharing = input?.message_activity_sharing ?? input?.messageActivitySharing
        if (typeof rawSharing !== 'boolean') {
            errors.push('message_activity_sharing must be boolean')
        } else {
            options.messageActivitySharing = rawSharing
        }
    }

    if (input?.ttl !== undefined) {
        const rawTtl = Number(input.ttl)
        if (!Number.isFinite(rawTtl) || rawTtl <= 0) {
            errors.push('ttl must be a positive number (seconds)')
        } else {
            options.ttl = Math.floor(rawTtl)
        }
    }

    const degrees = input?.degrees_of_freedom_spec ?? input?.degreesOfFreedomSpec
    if (degrees !== undefined) {
        if (!isObject(degrees)) {
            errors.push('degrees_of_freedom_spec must be an object')
        } else {
            options.degreesOfFreedomSpec = degrees
        }
    }

    return { options, errors }
}

function resolveOauthRedirectUri(req: any) {
    if (process.env.WABA_OAUTH_REDIRECT_URI) return process.env.WABA_OAUTH_REDIRECT_URI
    const origin = resolveRequestOrigin(req)
    return `${origin}/auth/waba/callback`
}

function resolveOauthReturnUrl(req: any) {
    return process.env.WABA_OAUTH_RETURN_URL || process.env.DASHBOARD_URL || resolveRequestOrigin(req)
}

function resolveRequestOrigin(req: any): string {
    const protocol = resolveRequestProtocol(req)
    const host = resolveRequestHost(req)
    if (host) return `${protocol}://${host}`
    return `${protocol}://localhost`
}

function resolveRequestProtocol(req: any): 'http' | 'https' {
    const forwardedProtoRaw = req?.headers?.['x-forwarded-proto']
    const forwardedProto = Array.isArray(forwardedProtoRaw)
        ? String(forwardedProtoRaw[0] || '')
        : typeof forwardedProtoRaw === 'string'
            ? forwardedProtoRaw
            : ''
    const normalizedForwarded = forwardedProto
        .split(',')[0]
        ?.trim()
        .toLowerCase()
    if (normalizedForwarded === 'http' || normalizedForwarded === 'https') {
        return normalizedForwarded
    }

    const requestProtocol = typeof req?.protocol === 'string' ? req.protocol.trim().toLowerCase() : ''
    if (requestProtocol === 'http' || requestProtocol === 'https') return requestProtocol
    if (req?.secure === true) return 'https'
    return 'http'
}

function resolveRequestHost(req: any): string {
    const forwardedHostRaw = req?.headers?.['x-forwarded-host']
    const hostHeaderRaw = forwardedHostRaw || req?.headers?.host || req?.get?.('host') || ''
    const hostHeader = Array.isArray(hostHeaderRaw) ? String(hostHeaderRaw[0] || '') : String(hostHeaderRaw || '')
    const firstHost = hostHeader.split(',')[0]?.trim() || ''
    if (!firstHost) return ''
    return firstHost.replace(/[\r\n]/g, '')
}

function buildEmbeddedSignupUrl(params: {
    appId: string
    redirectUri: string
    state: string
    scopes: string[]
    apiVersion: string
    configId?: string
    includeScopes?: boolean
    extras?: Record<string, any>
}) {
    const base = `https://www.facebook.com/${params.apiVersion}/dialog/oauth`
    const search = new URLSearchParams({
        client_id: params.appId,
        redirect_uri: params.redirectUri,
        response_type: 'code',
        state: params.state
    })
    if (params.includeScopes !== false && params.scopes.length) {
        search.set('scope', params.scopes.join(','))
    }
    if (params.configId) search.set('config_id', params.configId)
    if (params.extras && Object.keys(params.extras).length > 0) {
        search.set('extras', JSON.stringify(params.extras))
    }
    return `${base}?${search.toString()}`
}

function resolveOauthMode(configId?: string | null) {
    const raw = (process.env.WABA_OAUTH_MODE || '').trim().toLowerCase()
    if (raw === 'user' || raw === 'user_token') return 'user'
    if (raw === 'business_integration' || raw === 'business' || raw === 'bisuat') return 'business_integration'
    return configId ? 'business_integration' : 'user'
}

const requireSupabaseUserMiddleware = requireSupabaseUser(getSupabaseUserFromRequest)

const WEB_PUSH_VAPID_FILE = resolvePath('webpush_vapid.json')
const WEB_PUSH_SUBSCRIPTIONS_FILE = resolvePath('push_subscriptions.json')
const WEB_PUSH_NOTIFICATION_ICON = '/icons/icon-192.png'
const WEB_PUSH_NOTIFICATION_BADGE = '/icons/icon-192.png'
const NATIVE_PUSH_TOKENS_FILE = resolvePath('native_push_tokens.json')
const NATIVE_PUSH_CHANNEL_ID = 'qmessage-chat-v4'
const NATIVE_PUSH_SOUND = 'default'
const INBOUND_PUSH_DEDUPE_TTL_MS = 2 * 60 * 1000
const MAX_INBOUND_PUSH_DEDUPE_KEYS = 3000
const recentInboundPushDispatchAt = new Map<string, number>()

const pushSubscriptionStore = createPushSubscriptionStore(WEB_PUSH_SUBSCRIPTIONS_FILE)
const nativePushTokenStore = createNativePushTokenStore(NATIVE_PUSH_TOKENS_FILE)
const nativeFcmPushSender = createNativeFcmPushSender(console)

type WebPushVapidDetails = {
    publicKey: string
    privateKey: string
    subject: string
}

type SendPushNotificationInput = {
    companyId: string
    userIds: string[]
    title: string
    body: string
    url?: string
    tag?: string
    icon?: string
    badge?: string
    data?: Record<string, any>
    ttlSeconds?: number
}

const normalizeWebPushSubject = (value: string | null | undefined): string => {
    const raw = typeof value === 'string' ? value.trim() : ''
    if (!raw) return `mailto:no-reply@${TENANT_ROOT_DOMAIN}`
    if (raw.startsWith('mailto:')) return raw
    if (/^https?:\/\//i.test(raw)) return raw
    if (raw.includes('@')) return `mailto:${raw}`
    return `mailto:${raw}`
}

const loadOrCreateWebPushVapidDetails = (): WebPushVapidDetails | null => {
    const envPublic = typeof process.env.WEB_PUSH_VAPID_PUBLIC_KEY === 'string' ? process.env.WEB_PUSH_VAPID_PUBLIC_KEY.trim() : ''
    const envPrivate = typeof process.env.WEB_PUSH_VAPID_PRIVATE_KEY === 'string' ? process.env.WEB_PUSH_VAPID_PRIVATE_KEY.trim() : ''
    const envSubject = normalizeWebPushSubject(process.env.WEB_PUSH_VAPID_SUBJECT || process.env.WEB_PUSH_SUBJECT || '')

    if (envPublic && envPrivate) {
        return {
            publicKey: envPublic,
            privateKey: envPrivate,
            subject: envSubject
        }
    }

    if (envPublic || envPrivate) {
        console.warn('[push] WEB_PUSH_VAPID_PUBLIC_KEY / WEB_PUSH_VAPID_PRIVATE_KEY must both be set. Web push is disabled.')
        return null
    }

    try {
        if (fs.existsSync(WEB_PUSH_VAPID_FILE)) {
            const raw = JSON.parse(fs.readFileSync(WEB_PUSH_VAPID_FILE, 'utf-8')) as any
            const filePublic = typeof raw?.publicKey === 'string' ? raw.publicKey.trim() : ''
            const filePrivate = typeof raw?.privateKey === 'string' ? raw.privateKey.trim() : ''
            const fileSubject = normalizeWebPushSubject(raw?.subject || envSubject)
            if (filePublic && filePrivate) {
                return {
                    publicKey: filePublic,
                    privateKey: filePrivate,
                    subject: fileSubject
                }
            }
        }
    } catch (error: any) {
        console.warn('[push] Failed to read persisted VAPID key file:', error?.message || error)
    }

    try {
        const generated = webpush.generateVAPIDKeys()
        const subject = envSubject
        const payload = {
            publicKey: generated.publicKey,
            privateKey: generated.privateKey,
            subject,
            createdAt: new Date().toISOString()
        }
        fs.writeFileSync(WEB_PUSH_VAPID_FILE, JSON.stringify(payload, null, 2))
        console.log(`[push] Generated VAPID key pair at ${WEB_PUSH_VAPID_FILE}`)
        return {
            publicKey: generated.publicKey,
            privateKey: generated.privateKey,
            subject
        }
    } catch (error: any) {
        console.warn('[push] Failed to generate VAPID keys. Web push is disabled.', error?.message || error)
        return null
    }
}

const webPushVapidDetails = loadOrCreateWebPushVapidDetails()
if (webPushVapidDetails) {
    try {
        webpush.setVapidDetails(
            webPushVapidDetails.subject,
            webPushVapidDetails.publicKey,
            webPushVapidDetails.privateKey
        )
    } catch (error: any) {
        console.warn('[push] Failed to configure web-push VAPID details. Web push is disabled.', error?.message || error)
    }
}

const getCompanyRecipientUserIdsForPush = async (companyId: string, fallbackUserId?: string | null): Promise<string[]> => {
    const result = new Set<string>()
    const normalizedCompanyId = normalizeCompanyId(companyId)
    if (!normalizedCompanyId) return []

    try {
        const { data: roleRows, error: roleError } = await supabase
            .from('user_roles')
            .select('user_id')
            .eq('company_id', normalizedCompanyId)

        if (roleError) {
            console.warn(`[push] Failed to load user_roles for company ${normalizedCompanyId}:`, roleError.message)
        } else {
            ;(roleRows || []).forEach((row: any) => {
                const userId = typeof row?.user_id === 'string' ? row.user_id.trim() : ''
                if (userId) result.add(userId)
            })
        }
    } catch (error: any) {
        console.warn(`[push] Failed to query user roles for company ${normalizedCompanyId}:`, error?.message || error)
    }

    if (result.size === 0) {
        try {
            const { data: profileRows, error: profileError } = await supabase
                .from('profiles')
                .select('user_id')
                .eq('company_id', normalizedCompanyId)

            if (profileError) {
                console.warn(`[push] Failed to load profiles for company ${normalizedCompanyId}:`, profileError.message)
            } else {
                ;(profileRows || []).forEach((row: any) => {
                    const userId = typeof row?.user_id === 'string' ? row.user_id.trim() : ''
                    if (userId) result.add(userId)
                })
            }
        } catch (error: any) {
            console.warn(`[push] Failed to query profiles for company ${normalizedCompanyId}:`, error?.message || error)
        }
    }

    const fallback = typeof fallbackUserId === 'string' ? fallbackUserId.trim() : ''
    if (fallback) result.add(fallback)
    return Array.from(result)
}

const getPushPresenceForUserId = (userId: string): 'active' | 'background' | 'offline' => {
    const PUSH_ACTIVE_VISIBILITY_TTL_MS = 90_000
    const normalizedUserId = typeof userId === 'string' ? userId.trim() : ''
    if (!normalizedUserId) return 'offline'

    const room = io.sockets.adapter.rooms.get(normalizedUserId)
    if (!room || room.size === 0) return 'offline'

    for (const socketId of room) {
        const socket = io.sockets.sockets.get(socketId)
        if (!socket) continue
        const visibility = typeof socket.data?.appVisibility === 'string'
            ? socket.data.appVisibility.trim().toLowerCase()
            : ''
        const visibilityUpdatedAt = Number(socket.data?.appVisibilityUpdatedAt || 0)
        const hasFreshVisibleState = visibilityUpdatedAt > 0 && (Date.now() - visibilityUpdatedAt) <= PUSH_ACTIVE_VISIBILITY_TTL_MS
        if (visibility === 'visible' && hasFreshVisibleState) {
            return 'active'
        }
    }

    return 'background'
}

const selectBackgroundPushUserIds = (userIds: string[]): string[] => {
    const uniqueUserIds = Array.from(new Set(
        (Array.isArray(userIds) ? userIds : [])
            .map((value) => (typeof value === 'string' ? value.trim() : ''))
            .filter(Boolean)
    ))
    if (uniqueUserIds.length === 0) return []
    return uniqueUserIds.filter((userId) => getPushPresenceForUserId(userId) !== 'active')
}

const shouldSkipInboundPushDispatch = (dedupeKey: string): boolean => {
    const key = typeof dedupeKey === 'string' ? dedupeKey.trim() : ''
    if (!key) return false

    const now = Date.now()
    const cutoff = now - INBOUND_PUSH_DEDUPE_TTL_MS
    for (const [entryKey, timestamp] of recentInboundPushDispatchAt) {
        if (timestamp >= cutoff) continue
        recentInboundPushDispatchAt.delete(entryKey)
    }

    const previous = recentInboundPushDispatchAt.get(key) || 0
    if (previous > 0 && (now - previous) <= INBOUND_PUSH_DEDUPE_TTL_MS) {
        return true
    }

    recentInboundPushDispatchAt.set(key, now)

    if (recentInboundPushDispatchAt.size > MAX_INBOUND_PUSH_DEDUPE_KEYS) {
        let oldestKey: string | null = null
        let oldestTimestamp = Number.POSITIVE_INFINITY
        for (const [entryKey, timestamp] of recentInboundPushDispatchAt) {
            if (timestamp >= oldestTimestamp) continue
            oldestTimestamp = timestamp
            oldestKey = entryKey
        }
        if (oldestKey) {
            recentInboundPushDispatchAt.delete(oldestKey)
        }
    }

    return false
}

const sendPushNotificationToUsers = async (input: SendPushNotificationInput): Promise<void> => {
    if (!webPushVapidDetails) return

    const userIds = Array.from(new Set((Array.isArray(input.userIds) ? input.userIds : [])
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean)))
    if (userIds.length === 0) return

    const companyId = normalizeCompanyId(input.companyId)
    if (!companyId) return

    const subscriptions = pushSubscriptionStore.getByUsers(userIds, companyId)
    if (subscriptions.length === 0) {
        console.log(`[push] No active subscriptions for company ${companyId} (${userIds.length} user target(s)).`)
        return
    }
    const startedAt = Date.now()

    const payload = JSON.stringify({
        title: (input.title || 'QMessage').slice(0, 120),
        body: (input.body || 'New WhatsApp update available.').slice(0, 240),
        icon: input.icon || WEB_PUSH_NOTIFICATION_ICON,
        badge: input.badge || WEB_PUSH_NOTIFICATION_BADGE,
        tag: input.tag || `company:${companyId}`,
        url: input.url || '/',
        data: {
            ...(input.data || {})
        }
    })

    const staleEndpoints: string[] = []
    let deliveredCount = 0
    await Promise.all(subscriptions.map(async (entry) => {
        try {
            await webpush.sendNotification(
                {
                    endpoint: entry.endpoint,
                    expirationTime: entry.expirationTime ?? null,
                    keys: entry.keys
                },
                payload,
                {
                    TTL: Math.max(30, Math.min(3600, Math.floor(input.ttlSeconds || 120))),
                    urgency: 'high'
                }
            )
            deliveredCount += 1
        } catch (error: any) {
            const statusCode = Number(error?.statusCode || error?.status || 0)
            if (statusCode === 404 || statusCode === 410) {
                staleEndpoints.push(entry.endpoint)
                return
            }
            console.warn('[push] Failed to send push notification:', error?.message || error)
        }
    }))

    if (staleEndpoints.length > 0) {
        pushSubscriptionStore.removeManyByEndpoint(staleEndpoints)
    }

    const durationMs = Date.now() - startedAt
    const summary = `[push] Delivered ${deliveredCount}/${subscriptions.length} push notification(s) in ${durationMs}ms.`
    if (durationMs > 1500) {
        console.warn(summary)
    } else {
        console.log(summary)
    }
}

const sendNativePushNotificationToUsers = async (input: SendPushNotificationInput): Promise<void> => {
    if (!nativeFcmPushSender.enabled) return

    const userIds = Array.from(new Set((Array.isArray(input.userIds) ? input.userIds : [])
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean)))
    if (userIds.length === 0) return

    const companyId = normalizeCompanyId(input.companyId)
    if (!companyId) return

    const deviceTokens = nativePushTokenStore.getByUsers(userIds, companyId)
    if (deviceTokens.length === 0) return

    const startedAt = Date.now()
    const tokens = Array.from(new Set(deviceTokens.map((entry) => entry.token).filter(Boolean)))
    if (tokens.length === 0) return

    const sendResult = await nativeFcmPushSender.send({
        tokens,
        title: (input.title || 'QMessage').slice(0, 120),
        body: (input.body || 'New WhatsApp update available.').slice(0, 240),
        ttlSeconds: Math.max(30, Math.min(3600, Math.floor(input.ttlSeconds || 120))),
        channelId: NATIVE_PUSH_CHANNEL_ID,
        sound: NATIVE_PUSH_SOUND,
        iosCategory: 'QMESSAGE_CHAT',
        tag: input.tag || `company:${companyId}`,
        data: {
            url: input.url || '/',
            ...(input.data || {})
        }
    })

    if (sendResult.staleTokens.length > 0) {
        nativePushTokenStore.removeManyByToken(sendResult.staleTokens)
    }

    const durationMs = Date.now() - startedAt
    const summary = `[native-push] Delivered ${sendResult.successCount}/${sendResult.attempted} FCM push notification(s) in ${durationMs}ms.`
    if (durationMs > 1500) {
        console.warn(summary)
    } else {
        console.log(summary)
    }
}

const getInboundNotificationPreview = (inbound: WabaInboundMessage, text: string): string => {
    const normalizedText = typeof text === 'string' ? text.trim() : ''
    if (normalizedText) return normalizedText
    if (inbound.image) return 'Photo'
    if (inbound.video) return 'Video'
    if (inbound.document) return 'Document'
    if (inbound.audio) return 'Voice message'
    if (inbound.buttonReplyTitle) return inbound.buttonReplyTitle
    if (inbound.buttonReplyId) return `Button response: ${inbound.buttonReplyId}`
    return 'New message'
}

app.get('/api/push/public-key', requireSupabaseUserMiddleware, async (_req: any, res: any) => {
    return res.json({
        success: true,
        enabled: Boolean(webPushVapidDetails),
        publicKey: webPushVapidDetails?.publicKey || null
    })
})

app.post('/api/push/subscribe', requireSupabaseUserMiddleware, async (req: any, res: any) => {
    if (!webPushVapidDetails) {
        return res.status(503).json({
            success: false,
            error: 'Push notifications are not configured on the server.'
        })
    }

    const baseUser = req?.supabaseUser
    if (!baseUser) {
        return res.status(401).json({ success: false, error: 'Authentication required.' })
    }

    const { user, companyId } = await ensureUserCompanyId(baseUser)
    const normalizedCompanyId = normalizeCompanyId(companyId || getUserCompanyId(user))
    if (!normalizedCompanyId) {
        return res.status(400).json({ success: false, error: 'Company ID is missing for this account.' })
    }

    const input = req?.body?.subscription || req?.body
    const result = pushSubscriptionStore.upsert(input, {
        userId: user.id,
        companyId: normalizedCompanyId,
        userAgent: typeof req?.headers?.['user-agent'] === 'string' ? req.headers['user-agent'] : null
    })

    if (!result.success) {
        return res.status(400).json({ success: false, error: result.error })
    }

    return res.json({
        success: true,
        endpoint: result.endpoint
    })
})

app.post('/api/push/unsubscribe', requireSupabaseUserMiddleware, async (req: any, res: any) => {
    const baseUser = req?.supabaseUser
    if (!baseUser) {
        return res.status(401).json({ success: false, error: 'Authentication required.' })
    }

    const { user, companyId } = await ensureUserCompanyId(baseUser)
    const normalizedCompanyId = normalizeCompanyId(companyId || getUserCompanyId(user))
    const endpoint = typeof req?.body?.endpoint === 'string'
        ? req.body.endpoint.trim()
        : typeof req?.body?.subscription?.endpoint === 'string'
            ? req.body.subscription.endpoint.trim()
            : ''

    if (!endpoint) {
        return res.status(400).json({ success: false, error: 'Push subscription endpoint is required.' })
    }

    const userSubscriptions = pushSubscriptionStore.getByUser(user.id, normalizedCompanyId)
    const belongsToUser = userSubscriptions.some((item) => item.endpoint === endpoint)
    if (!belongsToUser) {
        return res.status(404).json({ success: false, error: 'Subscription not found for this user.' })
    }

    const removed = pushSubscriptionStore.removeByEndpoint(endpoint)
    return res.json({ success: true, removed })
})

app.post('/api/push/native/register', requireSupabaseUserMiddleware, async (req: any, res: any) => {
    const baseUser = req?.supabaseUser
    if (!baseUser) {
        return res.status(401).json({ success: false, error: 'Authentication required.' })
    }

    const { user, companyId } = await ensureUserCompanyId(baseUser)
    const normalizedCompanyId = normalizeCompanyId(companyId || getUserCompanyId(user))
    if (!normalizedCompanyId) {
        return res.status(400).json({ success: false, error: 'Company ID is missing for this account.' })
    }

    const input = req?.body?.device || req?.body
    const result = nativePushTokenStore.upsert(input, {
        userId: user.id,
        companyId: normalizedCompanyId,
        userAgent: typeof req?.headers?.['user-agent'] === 'string' ? req.headers['user-agent'] : null
    })

    if (!result.success) {
        return res.status(400).json({ success: false, error: result.error })
    }

    return res.json({
        success: true,
        token: result.token,
        platform: result.platform
    })
})

app.post('/api/push/native/unregister', requireSupabaseUserMiddleware, async (req: any, res: any) => {
    const baseUser = req?.supabaseUser
    if (!baseUser) {
        return res.status(401).json({ success: false, error: 'Authentication required.' })
    }

    const { user, companyId } = await ensureUserCompanyId(baseUser)
    const normalizedCompanyId = normalizeCompanyId(companyId || getUserCompanyId(user))
    const token = typeof req?.body?.token === 'string'
        ? req.body.token.trim()
        : typeof req?.body?.device?.token === 'string'
            ? req.body.device.token.trim()
            : ''

    if (!token) {
        return res.status(400).json({ success: false, error: 'Native push token is required.' })
    }

    const userTokens = nativePushTokenStore.getByUser(user.id, normalizedCompanyId)
    const belongsToUser = userTokens.some((entry) => entry.token === token)
    if (!belongsToUser) {
        return res.status(404).json({ success: false, error: 'Native token not found for this user.' })
    }

    const removed = nativePushTokenStore.removeByToken(token)
    return res.json({ success: true, removed })
})

app.post('/api/push/promo', requireSupabaseUserMiddleware, async (req: any, res: any) => {
    try {
        const baseUser = req?.supabaseUser
        if (!baseUser) {
            return res.status(401).json({ success: false, error: 'Authentication required.' })
        }

        const { user, companyId } = await ensureUserCompanyId(baseUser)
        const profileId = readTrimmed(req?.body?.profileId)
        let normalizedCompanyId = normalizeCompanyId(companyId || getUserCompanyId(user))
        if (!normalizedCompanyId && profileId && isSuperAdminUser(user)) {
            const fallbackCompanyId = await getCompanyIdForProfile(profileId)
            normalizedCompanyId = normalizeCompanyId(fallbackCompanyId)
        }
        if (!normalizedCompanyId) {
            return res.status(400).json({ success: false, error: 'Company ID is missing for this account.' })
        }

        const hasCompanyAdminAccess = await isAdminUser(user.id, normalizedCompanyId)
        if (!isSuperAdminUser(user) && !hasCompanyAdminAccess) {
            return res.status(403).json({ success: false, error: 'Admin access required to send promo notifications.' })
        }

        const title = readTrimmed(req?.body?.title || 'QMessage Promotion').slice(0, 120)
        const body = readTrimmed(req?.body?.body).slice(0, 240)
        const targetUrl = readTrimmed(req?.body?.url || '/').slice(0, 512)
        const promoTag = readTrimmed(req?.body?.tag || '').slice(0, 120)
        const promoCode = readTrimmed(req?.body?.promoCode || '').slice(0, 64)
        const includeActiveUsers = req?.body?.includeActiveUsers !== false
        const ttlSecondsRaw = Number(req?.body?.ttlSeconds)
        const ttlSeconds = Number.isFinite(ttlSecondsRaw)
            ? Math.max(30, Math.min(3600, Math.floor(ttlSecondsRaw)))
            : 600

        if (!title) {
            return res.status(400).json({ success: false, error: 'title is required.' })
        }
        if (!body) {
            return res.status(400).json({ success: false, error: 'body is required.' })
        }

        const allUserIds = await getCompanyRecipientUserIdsForPush(normalizedCompanyId, user.id)
        const targetUserIds = includeActiveUsers ? allUserIds : selectBackgroundPushUserIds(allUserIds)
        if (targetUserIds.length === 0) {
            return res.status(200).json({
                success: true,
                data: {
                    targetedUsers: 0,
                    webSubscriptions: 0,
                    nativeDevices: 0,
                    includeActiveUsers,
                    delivered: false
                }
            })
        }

        const webSubscriptions = pushSubscriptionStore.getByUsers(targetUserIds, normalizedCompanyId).length
        const nativeDevices = nativePushTokenStore.getByUsers(targetUserIds, normalizedCompanyId).length
        const resolvedTag = promoTag || `promo:${Date.now()}`

        await sendPushNotificationToUsers({
            companyId: normalizedCompanyId,
            userIds: targetUserIds,
            title,
            body,
            url: targetUrl || '/',
            tag: resolvedTag,
            ttlSeconds,
            data: {
                type: 'promo',
                promoCode
            }
        })

        await sendNativePushNotificationToUsers({
            companyId: normalizedCompanyId,
            userIds: targetUserIds,
            title,
            body,
            url: targetUrl || '/',
            tag: resolvedTag,
            ttlSeconds,
            data: {
                type: 'promo',
                promoCode
            }
        })

        return res.json({
            success: true,
            data: {
                targetedUsers: targetUserIds.length,
                webSubscriptions,
                nativeDevices,
                includeActiveUsers,
                ttlSeconds,
                tag: resolvedTag,
                delivered: webSubscriptions > 0 || nativeDevices > 0
            }
        })
    } catch (error: any) {
        return res.status(500).json({ success: false, error: error?.message || 'Failed to send promo push notification.' })
    }
})

registerFlowRoutes(app, {
    supabase,
    parseDateInput,
    toDayKey,
    lowerBound,
    WINDOW_MS,
    resolveProfileAccess,
    requireSupabaseUserMiddleware
})

registerPublicAuthRoutes(app, { supabase })

// ============================================
// API KEY AUTHENTICATION MIDDLEWARE
// API KEY AUTHENTICATION MIDDLEWARE
// ============================================
const apiKeyStore = createApiKeyStore(resolvePath('api_keys.json'))
const verifyApiKey = apiKeyStore.middleware

const webhookStore = createWebhookStore(resolvePath('webhooks.json'))
const INCLUDE_RAW_WEBHOOK_EVENT_PAYLOAD = process.env.WABA_INCLUDE_RAW_WEBHOOK_PAYLOAD === 'true'
const WEBHOOK_QUEUE_MAX_SIZE = 3000
const WEBHOOK_PROCESS_CONCURRENCY = Math.max(
    1,
    Math.min(16, Number.parseInt(process.env.WABA_WEBHOOK_CONCURRENCY || '4', 10) || 4)
)
type QueuedWebhookEvent =
    | { kind: 'message'; event: WabaInboundMessage }
    | { kind: 'status'; event: WabaStatus }
    | { kind: 'call'; event: WabaCallUpdate }

const queuedWebhookEvents: QueuedWebhookEvent[] = []
let webhookProcessorActive = false

function enqueueWebhookEvents(events: QueuedWebhookEvent[]) {
    if (!Array.isArray(events) || events.length === 0) return
    events.forEach((event) => {
        if (queuedWebhookEvents.length >= WEBHOOK_QUEUE_MAX_SIZE) {
            queuedWebhookEvents.shift()
        }
        queuedWebhookEvents.push(event)
    })
    if (!webhookProcessorActive) {
        webhookProcessorActive = true
        queueMicrotask(() => {
            void processWebhookQueue()
        })
    }
}

function toMinimalInboundRaw(inbound: WabaInboundMessage): any | null {
    if (INCLUDE_RAW_WEBHOOK_EVENT_PAYLOAD) return inbound.raw
    const raw = inbound.raw && typeof inbound.raw === 'object' ? inbound.raw : null
    const source = readTrimmed(raw?.source)
    const minimal: any = {
        timestamp: inbound.timestamp,
        referral: inbound.referral || null
    }
    if (source) minimal.source = source
    if (raw && typeof raw.simulated === 'boolean') minimal.simulated = raw.simulated
    if (raw && typeof raw.mode === 'string') minimal.mode = raw.mode
    if (raw && typeof raw.lead_index === 'number') minimal.lead_index = raw.lead_index
    if (raw && typeof raw.trigger_phone === 'string') minimal.trigger_phone = raw.trigger_phone
    return minimal
}

function toMinimalStatusRaw(status: WabaStatus): any | null {
    if (INCLUDE_RAW_WEBHOOK_EVENT_PAYLOAD) return status.raw
    return {
        status: status.status,
        timestamp: status.timestamp
    }
}

function toMinimalCallRaw(call: WabaCallUpdate): any | null {
    if (INCLUDE_RAW_WEBHOOK_EVENT_PAYLOAD) return call.raw
    return {
        event: call.event,
        timestamp: call.timestamp
    }
}

async function processWebhookQueue() {
    try {
        while (queuedWebhookEvents.length > 0) {
            const batch = queuedWebhookEvents.splice(0, WEBHOOK_PROCESS_CONCURRENCY)
            const settled = await Promise.allSettled(batch.map(async (item) => {
                const config = await wabaRegistry.getConfigByPhoneNumberId(item.event.phoneNumberId)
                if (!config) {
                    if (item.kind === 'message') {
                        console.warn('[WABA] No config for phone_number_id:', item.event.phoneNumberId)
                    }
                    return
                }
                if (item.kind === 'message') {
                    await handleInboundMessage(config, item.event)
                    return
                }
                if (item.kind === 'status') {
                    await handleStatusUpdate(config, item.event)
                    return
                }
                await handleCallUpdate(config, item.event)
            }))
            settled.forEach((result, index) => {
                if (result.status !== 'rejected') return
                const item = batch[index]
                const phoneNumberId = item?.event?.phoneNumberId || 'unknown'
                console.error(
                    `[WABA] Failed to process ${item?.kind || 'unknown'} webhook event for phone_number_id ${phoneNumberId}:`,
                    result.reason
                )
            })
        }
    } catch (error) {
        console.error('WABA webhook queue error:', error)
    } finally {
        webhookProcessorActive = false
        if (queuedWebhookEvents.length > 0) {
            webhookProcessorActive = true
            queueMicrotask(() => {
                void processWebhookQueue()
            })
        }
    }
}

// ============================================
// PUBLIC API ENDPOINTS
// ============================================

// Send text message
app.post('/api/send-message', verifyApiKey, async (req: any, res: any) => {
    try {
        const { phone, message, mediaType, mediaUrl, filename } = req.body
        const profileId = req.apiKeyInfo.profileId

        const cleanMessage = typeof message === 'string' ? message.trim() : ''
        const cleanMediaType = typeof mediaType === 'string' ? mediaType.toLowerCase().trim() : ''
        const cleanMediaUrl = typeof mediaUrl === 'string' ? mediaUrl.trim() : ''
        const cleanFilename = typeof filename === 'string' ? filename.trim() : ''
        const normalizedMedia =
            (cleanMediaType === 'image' || cleanMediaType === 'video' || cleanMediaType === 'document') && cleanMediaUrl
                ? {
                    type: cleanMediaType,
                    link: cleanMediaUrl,
                    ...(cleanMediaType === 'document' && cleanFilename ? { filename: cleanFilename } : {})
                }
                : null

        if (!phone || (!cleanMessage && !normalizedMedia)) {
            return res.status(400).json({
                success: false,
                error: 'Phone and message or media are required'
            })
        }

        const rawTarget = typeof phone === 'string' ? phone.trim() : ''
        const isGroupTarget = isGroupIdentifier(rawTarget) || rawTarget.includes(':')
        const normalizedTarget = normalizePhoneNumber(rawTarget)
        const jid = rawTarget.includes('@')
            ? rawTarget
            : normalizedTarget
                ? buildChatJid(normalizedTarget, isGroupTarget)
                : ''
        if (!jid) {
            return res.status(400).json({
                success: false,
                error: 'Invalid phone/group target'
            })
        }

        const client = await wabaRegistry.getClientByProfile(profileId)
        if (!client) {
            return res.status(503).json({
                success: false,
                error: 'WABA not configured for this profile.'
            })
        }

        const companyId = await getCompanyIdForProfile(profileId)
        if (!companyId) {
            return res.status(400).json({ success: false, error: 'Company not found' })
        }

        const recipientId = normalizePhoneNumber(jid)
        const user = await findOrCreateUser(companyId, recipientId, profileId)
        if (!user) {
            return res.status(500).json({ success: false, error: 'Failed to resolve user' })
        }

        const { messageId } = await sendWhatsAppMessage({
            client,
            userId: user.id,
            profileId,
            to: recipientId,
            type: 'text',
            content: {
                text: cleanMessage,
                ...(normalizedMedia ? { media: normalizedMedia } : {})
            }
        })

        res.json({
            success: true,
            data: {
                messageId: messageId || Date.now().toString(),
                phone: jid,
                message: cleanMessage,
                ...(normalizedMedia ? { media: normalizedMedia } : {}),
                timestamp: new Date().toISOString()
            }
        })
    } catch (error: any) {
        console.error('Send message error:', error)
        const status = error?.message?.includes('Outside 24h') ? 400 : 500
        res.status(status).json({
            success: false,
            error: error.message || 'Failed to send message'
        })
    }
})

// Send image message
app.post('/api/send-image', verifyApiKey, async (req: any, res: any) => {
    try {
        const { phone, imageUrl, caption } = req.body
        const profileId = req.apiKeyInfo.profileId

        if (!phone || !imageUrl) {
            return res.status(400).json({
                success: false,
                error: 'Phone and imageUrl are required'
            })
        }

        const rawTarget = typeof phone === 'string' ? phone.trim() : ''
        const isGroupTarget = isGroupIdentifier(rawTarget) || rawTarget.includes(':')
        const normalizedTarget = normalizePhoneNumber(rawTarget)
        const jid = rawTarget.includes('@')
            ? rawTarget
            : normalizedTarget
                ? buildChatJid(normalizedTarget, isGroupTarget)
                : ''
        if (!jid) {
            return res.status(400).json({
                success: false,
                error: 'Invalid phone/group target'
            })
        }

        const client = await wabaRegistry.getClientByProfile(profileId)
        if (!client) {
            return res.status(503).json({
                success: false,
                error: 'WABA not configured for this profile.'
            })
        }

        const companyId = await getCompanyIdForProfile(profileId)
        if (!companyId) {
            return res.status(400).json({ success: false, error: 'Company not found' })
        }

        const recipientId = normalizePhoneNumber(jid)
        const user = await findOrCreateUser(companyId, recipientId, profileId)
        if (!user) {
            return res.status(500).json({ success: false, error: 'Failed to resolve user' })
        }

        const response = await client.sendImage(recipientId, imageUrl, caption || '')
        const messageId = response?.messages?.[0]?.id

        await insertMessage({
            userId: user.id,
            profileId,
            direction: 'out',
            content: {
                type: 'image',
                to: recipientId,
                message_id: messageId,
                image_url: imageUrl,
                caption: caption || '',
                status: 'sent'
            },
            workflowState: null
        })

        res.json({
            success: true,
            data: {
                messageId: messageId || Date.now().toString(),
                phone: jid,
                imageUrl,
                caption,
                timestamp: new Date().toISOString()
            }
        })
    } catch (error: any) {
        console.error('Send image error:', error)
        const status = error?.message?.includes('Outside 24h') ? 400 : 500
        res.status(status).json({
            success: false,
            error: error.message || 'Failed to send image'
        })
    }
})

// Get connection status
app.get('/api/status', verifyApiKey, (req: any, res: any) => {
    const profileId = req.apiKeyInfo.profileId
    wabaRegistry.getClientByProfile(profileId).then(client => {
        const status = client ? 'open' : 'close'
        res.json({
            success: true,
            data: {
                profileId,
                status,
                connected: status === 'open',
                user: client ? { phoneNumberId: client.phoneNumberId } : null
            }
        })
    }).catch(err => {
        console.error('Status error:', err)
        res.status(500).json({ success: false, error: 'Failed to check status' })
    })
})

// Configure conversational components (welcome message, commands, prompts)
registerWabaRoutes(app, {
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
    getCompanyIdForProfile,
    getSupabaseUserFromRequest,
    getTokenEncryptionKey,
    getUserCompanyId,
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
    subscribeWabaApp,
    supabase,
    unsubscribeWabaApp,
    validateAuthenticationTemplateInput,
    validateAuthenticationUpsertInput,
    validateMarketingTemplateInput,
    validateTemplateSendComponents,
    validateUtilityTemplateInput,
    systemRuntimeStatus,
    wabaRegistry,
    WABA_OAUTH_SCOPES
})

registerCompanyRoutes(app, {
    requireSupabaseUserMiddleware,
    resolveProfileAccess,
    resolveCompanyAccess,
    supabase,
    normalizeTeamRole,
    normalizeTeamDepartment,
    normalizeTeamCustomDepartment,
    computeAgentColor,
    deriveAgentName,
    readTrimmed
})

registerStoreRoutes(app, {
    requireSupabaseUserMiddleware,
    resolveCompanyAccess,
    supabase
})

registerAiRoutes(app, {
    requireSupabaseUserMiddleware,
    resolveProfileAccess,
    readTrimmed,
    supabase,
    encryptToken,
    decryptToken,
    getTokenEncryptionKey
})

app.get('/api/company/ads-shoot-mode', requireSupabaseUserMiddleware, async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const mode = getAdsShootModeProfileConfig(access.companyId, access.profileId)
        return res.json({
            success: true,
            data: {
                company_id: mode.companyId,
                profile_id: mode.profileId,
                enabled: mode.enabled,
                batch_size: ADS_SHOOT_MODE_BATCH_SIZE,
                night_start_hour: ADS_SHOOT_MODE_NIGHT_START_HOUR,
                night_end_hour: ADS_SHOOT_MODE_NIGHT_END_HOUR,
                last_run_local_date: mode.lastRunLocalDate,
                updated_at: mode.updatedAt
            }
        })
    } catch (error: any) {
        return res.status(500).json({ success: false, error: error?.message || 'Failed to load Ads Shoot Mode settings' })
    }
})

app.post('/api/company/ads-shoot-mode', requireSupabaseUserMiddleware, async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const admin = await isAdminUser(access.user.id, access.companyId)
        if (!admin) {
            return res.status(403).json({ success: false, error: 'Admin access required to update Ads Shoot Mode' })
        }

        const existing = getAdsShootModeProfileConfig(access.companyId, access.profileId)
        const nextConfig: AdsShootModeProfileConfig = {
            ...existing,
            enabled: normalizeAdsShootModeEnabled(req.body?.enabled)
        }
        upsertAdsShootModeProfileConfig(nextConfig)
        const shouldClearSimulated = nextConfig.enabled === false
        const cleanup = shouldClearSimulated
            ? await clearAdsShootSimulatedConversations(access.companyId, access.profileId)
            : null

        return res.json({
            success: true,
            data: {
                company_id: nextConfig.companyId,
                profile_id: nextConfig.profileId,
                enabled: nextConfig.enabled,
                batch_size: ADS_SHOOT_MODE_BATCH_SIZE,
                night_start_hour: ADS_SHOOT_MODE_NIGHT_START_HOUR,
                night_end_hour: ADS_SHOOT_MODE_NIGHT_END_HOUR,
                last_run_local_date: nextConfig.lastRunLocalDate,
                updated_at: nextConfig.updatedAt,
                cleanup
            }
        })
    } catch (error: any) {
        return res.status(500).json({ success: false, error: error?.message || 'Failed to update Ads Shoot Mode settings' })
    }
})

app.post('/api/company/ads-shoot-mode/run', requireSupabaseUserMiddleware, async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const admin = await isAdminUser(access.user.id, access.companyId)
        if (!admin) {
            return res.status(403).json({ success: false, error: 'Admin access required to run Ads Shoot Mode' })
        }

        const config = getAdsShootModeProfileConfig(access.companyId, access.profileId)
        const key = buildAdsShootConfigKey(config.companyId, config.profileId)
        if (adsShootModeRunningProfiles.has(key)) {
            return res.status(409).json({ success: false, error: 'Ads Shoot Mode is already running for this profile' })
        }

        adsShootModeRunningProfiles.add(key)
        try {
            const result = await runAdsShootModeBatch(config, 'manual')
            if (result.error) {
                return res.status(503).json({ success: false, error: result.error })
            }
            return res.json({
                success: true,
                data: {
                    sent: result.sent,
                    failed: result.failed,
                    batch_size: ADS_SHOOT_MODE_BATCH_SIZE,
                    sample_leads: result.leads.map((lead) => ({
                        name: lead.name,
                        phone: lead.phone,
                        message: lead.text
                    }))
                }
            })
        } finally {
            adsShootModeRunningProfiles.delete(key)
        }
    } catch (error: any) {
        return res.status(500).json({ success: false, error: error?.message || 'Failed to run Ads Shoot Mode' })
    }
})

// WABA WEBHOOK (Meta Cloud API)
// ============================================
const handleMetaWhatsappWebhookVerify = async (req: any, res: any) => {
    const mode = req.query['hub.mode']
    const token = Array.isArray(req.query['hub.verify_token']) ? req.query['hub.verify_token'][0] : req.query['hub.verify_token']
    const challenge = Array.isArray(req.query['hub.challenge']) ? req.query['hub.challenge'][0] : req.query['hub.challenge']

    if (mode !== 'subscribe' || !token) {
        return res.status(400).send('Invalid webhook verification request')
    }

    const envVerifyToken = [
        process.env.META_WEBHOOK_VERIFY_TOKEN,
        process.env.WABA_VERIFY_TOKEN,
        process.env.VERIFY_TOKEN
    ]
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean)
    const tokens = Array.from(new Set([...(await wabaRegistry.getVerifyTokens()), ...envVerifyToken]))
    if (tokens.includes(token)) {
        return res.status(200).send(challenge)
    }

    return res.status(403).send('Verification failed')
}

const handleMetaWhatsappWebhook = async (req: any, res: any) => {
    try {
        const rawBody: Buffer = (req as any).rawBody || Buffer.from(JSON.stringify(req.body || {}))
        const signature = req.headers['x-hub-signature-256'] as string | undefined
        const envSecrets = [
            process.env.META_APP_SECRET,
            process.env.WABA_APP_SECRET,
            process.env.APP_SECRET
        ]
            .map((value) => (typeof value === 'string' ? value.trim() : ''))
            .filter(Boolean)
        const appSecrets = Array.from(new Set([...(await wabaRegistry.getAppSecrets()), ...envSecrets]))

        const valid = verifyWabaSignature(rawBody, signature, appSecrets)
        if (!valid) {
            console.warn('[WABA] Invalid webhook signature.', {
                hasSignature: Boolean(signature),
                payloadSize: rawBody.length
            })
            return res.status(401).send('Invalid signature')
        }

        const { messages, statuses, calls } = parseWabaWebhook(req.body || {})
        const uniquePhoneNumberIds = Array.from(
            new Set(
                [...messages, ...statuses, ...calls]
                    .map((event) => (typeof event.phoneNumberId === 'string' ? event.phoneNumberId.trim() : ''))
                    .filter(Boolean)
            )
        )
        console.log(
            `[WABA] Webhook received: messages=${messages.length}, statuses=${statuses.length}, calls=${calls.length}, phone_number_ids=${uniquePhoneNumberIds.join(',') || 'none'}`
        )
        const queueItems: QueuedWebhookEvent[] = []

        messages.forEach((msg) => {
            queueItems.push({
                kind: 'message',
                event: {
                    ...msg,
                    raw: toMinimalInboundRaw(msg)
                }
            })
        })

        statuses.forEach((status) => {
            queueItems.push({
                kind: 'status',
                event: {
                    ...status,
                    raw: toMinimalStatusRaw(status)
                }
            })
        })

        calls.forEach((call) => {
            queueItems.push({
                kind: 'call',
                event: {
                    ...call,
                    raw: toMinimalCallRaw(call)
                }
            })
        })

        enqueueWebhookEvents(queueItems)
        return res.sendStatus(200)
    } catch (error) {
        console.error('WABA webhook error:', error)
        return res.sendStatus(500)
    }
}

app.get('/webhook', handleMetaWhatsappWebhookVerify)
app.get('/api/webhooks/meta/whatsapp', handleMetaWhatsappWebhookVerify)

app.post('/webhook', handleMetaWhatsappWebhook)
app.post('/api/webhooks/meta/whatsapp', handleMetaWhatsappWebhook)

// Configure webhook
app.post('/api/webhook', verifyApiKey, (req: any, res: any) => {
    const { url, events } = req.body
    const profileId = req.apiKeyInfo.profileId

    if (!url) {
        return res.status(400).json({
            success: false,
            error: 'Webhook URL is required'
        })
    }

    webhookStore.set(profileId, {
        url,
        events: events || ['message', 'status']
    })

    res.json({
        success: true,
        data: {
            profileId,
            webhook: webhookStore.get(profileId)
        }
    })
})

// Get webhook config
app.get('/api/webhook', verifyApiKey, (req: any, res: any) => {
    const profileId = req.apiKeyInfo.profileId
    res.json({
        success: true,
        data: webhookStore.get(profileId)
    })
})

// Delete webhook
app.delete('/api/webhook', verifyApiKey, (req: any, res: any) => {
    const profileId = req.apiKeyInfo.profileId
    webhookStore.remove(profileId)
    res.json({ success: true })
})

// API Key management endpoints
app.post('/api/admin/api-keys', (req: any, res: any) => {
    const { adminPassword, profileId, name } = req.body

    // Simple admin password (you should change this!)
    if (adminPassword !== ADMIN_PASSWORD) {
        return res.status(403).json({ success: false, error: 'Invalid admin password' })
    }

    const apiKey = `barly_${Date.now()}_${Math.random().toString(36).substring(7)}`
    apiKeyStore.set(apiKey, { profileId, name })

    res.json({ success: true, data: { apiKey, profileId, name } })
})

app.get('/api/admin/api-keys', (req: any, res: any) => {
    const { adminPassword } = req.query

    if (adminPassword !== ADMIN_PASSWORD) {
        return res.status(403).json({ success: false, error: 'Invalid admin password' })
    }

    res.json({ success: true, data: apiKeyStore.getAll() })
})

const SUPER_ADMIN_ROLE_VALUES = new Set(['super_admin', 'superadmin', 'super-admin'])
const BUILT_IN_SUPER_ADMIN_EMAILS = ['izzulfitreee@gmail.com']

function normalizeEmailAddress(value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function parseSuperAdminEmailList(value: unknown): string[] {
    if (typeof value !== 'string') return []
    return value
        .split(/[,\n;]/g)
        .map((item) => normalizeEmailAddress(item))
        .filter((item) => Boolean(item) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item))
}

const SUPER_ADMIN_EMAIL_ALLOWLIST = new Set<string>(
    [
        ...BUILT_IN_SUPER_ADMIN_EMAILS,
        ...parseSuperAdminEmailList(process.env.SUPER_ADMIN_EMAILS || '')
    ].map((item) => normalizeEmailAddress(item)).filter(Boolean)
)

function isSuperAdminUser(user: any): boolean {
    const email = normalizeEmailAddress(user?.email)
    if (email && SUPER_ADMIN_EMAIL_ALLOWLIST.has(email)) return true

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

    const hasSuperAdminRole = roleCandidates.some((value) => {
        if (typeof value !== 'string') return false
        return SUPER_ADMIN_ROLE_VALUES.has(value.trim().toLowerCase())
    })
    if (hasSuperAdminRole) return true

    return flagCandidates.some((value) => {
        if (value === true) return true
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase()
            return normalized === 'true' || normalized === '1' || normalized === 'yes'
        }
        return false
    })
}

function isLegacyWabaAdminUser(user: any): boolean {
    const userMeta = user?.user_metadata || {}
    const appMeta = user?.app_metadata || {}
    const candidates = [
        userMeta.waba_admin,
        userMeta.is_waba_admin,
        appMeta.waba_admin,
        appMeta.is_waba_admin
    ]
    return candidates.some((value) => {
        if (value === true) return true
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase()
            return normalized === 'true' || normalized === 'waba_admin'
        }
        return false
    })
}

function extractAdminEmail(req: any): string {
    const bodyEmail = req.body?.email ?? req.body?.adminId
    const queryEmail = req.query?.email ?? req.query?.adminId
    const headerEmail = req.headers?.['x-admin-email']
    if (Array.isArray(bodyEmail) && bodyEmail.length > 0) return String(bodyEmail[0] || '').trim().toLowerCase()
    if (typeof bodyEmail === 'string') return bodyEmail.trim().toLowerCase()
    if (Array.isArray(queryEmail) && queryEmail.length > 0) return String(queryEmail[0] || '').trim().toLowerCase()
    if (typeof queryEmail === 'string') return queryEmail.trim().toLowerCase()
    if (Array.isArray(headerEmail) && headerEmail.length > 0) return String(headerEmail[0] || '').trim().toLowerCase()
    if (typeof headerEmail === 'string') return headerEmail.trim().toLowerCase()
    return ''
}

function extractAdminPassword(req: any): string {
    const bodyPassword = req.body?.password ?? req.body?.adminPassword
    const queryPassword = req.query?.password ?? req.query?.adminPassword
    const headerPassword = req.headers?.['x-admin-password']
    if (Array.isArray(bodyPassword) && bodyPassword.length > 0) return String(bodyPassword[0] || '')
    if (typeof bodyPassword === 'string') return bodyPassword
    if (Array.isArray(queryPassword) && queryPassword.length > 0) return String(queryPassword[0] || '')
    if (typeof queryPassword === 'string') return queryPassword
    if (Array.isArray(headerPassword) && headerPassword.length > 0) return String(headerPassword[0] || '')
    if (typeof headerPassword === 'string') return headerPassword
    return ''
}

function extractBearerToken(req: any): string {
    const rawAuth = req.headers?.authorization
    if (!rawAuth || typeof rawAuth !== 'string') return ''
    if (rawAuth.startsWith('Bearer ')) return rawAuth.slice(7).trim()
    return rawAuth.trim()
}

async function countSuperAdminUsers(): Promise<number> {
    const hasServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)
    if (!hasServiceRole) {
        throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for superadmin setup')
    }

    let page = 1
    const perPage = 200
    let count = 0

    while (true) {
        const { data, error } = await supabase.auth.admin.listUsers({ page, perPage })
        if (error) {
            throw new Error(error.message)
        }

        const users = Array.isArray(data?.users) ? data.users : []
        users.forEach((user: any) => {
            if (isSuperAdminUser(user)) count += 1
        })

        if (users.length < perPage || page >= 50) break
        page += 1
    }

    return count
}

async function countLegacyWabaAdminUsers(): Promise<number> {
    const hasServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)
    if (!hasServiceRole) {
        throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for superadmin setup')
    }

    let page = 1
    const perPage = 200
    let count = 0

    while (true) {
        const { data, error } = await supabase.auth.admin.listUsers({ page, perPage })
        if (error) {
            throw new Error(error.message)
        }

        const users = Array.isArray(data?.users) ? data.users : []
        users.forEach((user: any) => {
            if (isLegacyWabaAdminUser(user) && !isSuperAdminUser(user)) count += 1
        })

        if (users.length < perPage || page >= 50) break
        page += 1
    }

    return count
}

async function resolveSuperAdminAccess(req: any, res: any) {
    const token = extractBearerToken(req)
    if (!token) {
        res.status(401).json({ success: false, error: 'Authorization token required' })
        return null
    }

    const { data: { user }, error } = await supabaseAuth.auth.getUser(token)
    if (error || !user) {
        res.status(401).json({ success: false, error: 'Invalid or expired session' })
        return null
    }

    if (!isSuperAdminUser(user)) {
        res.status(403).json({ success: false, error: 'Superadmin access required' })
        return null
    }

    return { user, token }
}

const UI_FEATURE_KEYS = new Set([
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
])
const UI_FEATURE_ALIASES: Record<string, string> = {
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
    'ads-shoot-mode': 'settings-ads-shoot'
}

const UI_HIDDEN_FEATURES_MISSING_MESSAGE =
    'UI controls are not initialized. Run migration 20260407_company_ui_hidden_features.sql.'

function normalizeUiFeatureKey(value: unknown): string {
    if (typeof value !== 'string') return ''
    const raw = value.trim().toLowerCase()
    const normalizedBase = raw.replace(/\s+/g, '-')
    const normalized = UI_FEATURE_ALIASES[normalizedBase]
        || UI_FEATURE_ALIASES[normalizedBase.replace(/-/g, '')]
        || normalizedBase
    return UI_FEATURE_KEYS.has(normalized) ? normalized : ''
}

function sanitizeUiHiddenFeatures(value: unknown): string[] {
    const unique = new Set<string>()
    const push = (entry: unknown) => {
        const normalized = normalizeUiFeatureKey(entry)
        if (normalized) unique.add(normalized)
    }

    if (Array.isArray(value)) {
        value.forEach((entry) => push(entry))
        return Array.from(unique)
    }

    if (typeof value === 'string') {
        const trimmed = value.trim()
        if (!trimmed) return []
        try {
            const parsed = JSON.parse(trimmed)
            if (Array.isArray(parsed)) {
                parsed.forEach((entry) => push(entry))
                return Array.from(unique)
            }
        } catch {
            // fall through to CSV parsing
        }
        trimmed
            .split(/[,\n;]/g)
            .map((entry) => entry.trim())
            .filter(Boolean)
            .forEach((entry) => push(entry))
    }

    return Array.from(unique)
}

function isUiHiddenFeaturesMissingError(error: any): boolean {
    const code = typeof error?.code === 'string' ? error.code.trim().toUpperCase() : ''
    const message = String(error?.message || '').toLowerCase()
    return code === '42703' && message.includes('ui_hidden_features')
}

function serializeSystemRuntimeStatus(value: any) {
    const maintenance = value?.maintenance && typeof value.maintenance === 'object'
        ? value.maintenance
        : {}
    const downtimeLog = Array.isArray(value?.downtimeLog) ? value.downtimeLog : []
    return {
        online: value?.online === true,
        started_at: readTrimmed(value?.startedAt),
        current_time: readTrimmed(value?.currentTime),
        uptime_ms: Number.isFinite(Number(value?.uptimeMs)) ? Math.max(0, Math.floor(Number(value?.uptimeMs))) : 0,
        heartbeat_at: readTrimmed(value?.heartbeatAt) || null,
        maintenance: {
            enabled: maintenance?.enabled === true,
            message: readTrimmed(maintenance?.message),
            updated_at: readTrimmed(maintenance?.updatedAt) || null,
            updated_by: readTrimmed(maintenance?.updatedBy) || null
        },
        last_offline_at: readTrimmed(value?.lastOfflineAt) || null,
        last_offline_ended_at: readTrimmed(value?.lastOfflineEndedAt) || null,
        last_offline_duration_ms: Number.isFinite(Number(value?.lastOfflineDurationMs))
            ? Math.max(0, Math.floor(Number(value?.lastOfflineDurationMs)))
            : null,
        downtime_log: downtimeLog.map((entry: any) => ({
            id: readTrimmed(entry?.id),
            offline_from: readTrimmed(entry?.offlineFrom),
            offline_until: readTrimmed(entry?.offlineUntil),
            duration_ms: Number.isFinite(Number(entry?.durationMs)) ? Math.max(0, Math.floor(Number(entry?.durationMs))) : 0,
            reason: readTrimmed(entry?.reason)
        }))
    }
}

function buildAdminMonitorPayload() {
    const now = Date.now()
    pruneRecentApiMonitorSamples(now)
    const recent = [...apiMonitor.recent]

    const windowCalls = recent.length
    const window5xx = recent.filter((entry) => entry.status >= 500).length
    const window4xx = recent.filter((entry) => entry.status >= 400 && entry.status < 500).length
    const windowInBytes = recent.reduce((sum, entry) => sum + (entry.inBytes || 0), 0)
    const windowOutBytes = recent.reduce((sum, entry) => sum + (entry.outBytes || 0), 0)
    const windowAvgDurationMs = windowCalls > 0
        ? recent.reduce((sum, entry) => sum + (entry.durationMs || 0), 0) / windowCalls
        : 0
    const sortedDurations = recent
        .map((entry) => Number(entry.durationMs || 0))
        .filter((value) => Number.isFinite(value))
        .sort((a, b) => a - b)
    const p95Index = sortedDurations.length > 0
        ? Math.min(sortedDurations.length - 1, Math.floor((sortedDurations.length - 1) * 0.95))
        : -1
    const windowP95DurationMs = p95Index >= 0 ? sortedDurations[p95Index] : 0

    const oldestWindowTs = recent.length > 0 ? recent[0].ts : now
    const windowSpanSec = Math.max(1, (now - oldestWindowTs) / 1000)
    const apiInBps = windowInBytes / windowSpanSec
    const apiOutBps = windowOutBytes / windowSpanSec

    const socketInBps = Number(lastServerStats?.bandwidth?.inBps || 0)
    const socketOutBps = Number(lastServerStats?.bandwidth?.outBps || 0)

    const topRoutes = Array.from(apiMonitor.routes.entries())
        .map(([route, value]) => {
            const calls = Number(value.count || 0)
            const avgDurationMs = calls > 0 ? value.totalDurationMs / calls : 0
            const errorRatePct = calls > 0 ? (value.errorCount / calls) * 100 : 0
            return {
                route,
                calls,
                errorCount: Number(value.errorCount || 0),
                errorRatePct: Number(errorRatePct.toFixed(2)),
                avgDurationMs: Number(avgDurationMs.toFixed(1)),
                maxDurationMs: Number((value.maxDurationMs || 0).toFixed(1)),
                inBytes: Number(value.inBytes || 0),
                outBytes: Number(value.outBytes || 0),
                lastStatus: Number(value.lastStatus || 0),
                lastHitAt: value.lastHitAt ? new Date(value.lastHitAt).toISOString() : null
            }
        })
        .sort((a, b) => {
            if (b.calls !== a.calls) return b.calls - a.calls
            return b.avgDurationMs - a.avgDurationMs
        })
        .slice(0, 12)

    const memUsed = Number(lastServerStats?.memUsed || 0)
    const memTotal = Number(lastServerStats?.memTotal || 0)
    const memPct = memTotal > 0 ? (memUsed / memTotal) * 100 : Number(lastServerStats?.memPct || 0)

    const totalInBytes = apiMonitor.inBytes + socketTrafficTotals.inBytes
    const totalOutBytes = apiMonitor.outBytes + socketTrafficTotals.outBytes
    const windowErrorRatePct = windowCalls > 0 ? (window5xx / windowCalls) * 100 : 0
    const windowSuccessRatePct = windowCalls > 0 ? ((windowCalls - window5xx) / windowCalls) * 100 : 100

    return {
        generatedAt: new Date(now).toISOString(),
        runtime: {
            uptimeSec: Math.floor(process.uptime()),
            activeSockets: activeSockets.size,
            cpuPct: Number(lastServerStats?.cpu || 0),
            memUsed,
            memTotal,
            memPct: Number(memPct.toFixed(1)),
            heapUsed: Number(lastServerStats?.heapUsed || 0),
            rss: Number(lastServerStats?.rss || 0)
        },
        systemRuntime: serializeSystemRuntimeStatus(systemRuntimeStatus?.getStatus?.()),
        api: {
            windowMs: API_MONITOR_WINDOW_MS,
            totalCalls: apiMonitor.totalCalls,
            status2xx: apiMonitor.status2xx,
            status3xx: apiMonitor.status3xx,
            status4xx: apiMonitor.status4xx,
            status5xx: apiMonitor.status5xx,
            windowCalls,
            window4xx,
            window5xx,
            windowErrorRatePct: Number(windowErrorRatePct.toFixed(2)),
            windowSuccessRatePct: Number(windowSuccessRatePct.toFixed(2)),
            windowAvgDurationMs: Number(windowAvgDurationMs.toFixed(1)),
            windowP95DurationMs: Number(windowP95DurationMs.toFixed(1)),
            topRoutes
        },
        traffic: {
            apiInBytes: apiMonitor.inBytes,
            apiOutBytes: apiMonitor.outBytes,
            socketInBytes: socketTrafficTotals.inBytes,
            socketOutBytes: socketTrafficTotals.outBytes,
            totalInBytes,
            totalOutBytes,
            inBps: Number((apiInBps + socketInBps).toFixed(1)),
            outBps: Number((apiOutBps + socketOutBps).toFixed(1)),
            socketInBps: Number(socketInBps.toFixed(1)),
            socketOutBps: Number(socketOutBps.toFixed(1)),
            apiInBps: Number(apiInBps.toFixed(1)),
            apiOutBps: Number(apiOutBps.toFixed(1))
        }
    }
}

async function buildAdminSummaryPayload() {
    const { data: companies, error } = await supabase
        .from('company')
        .select('*')
        .order('created_at', { ascending: false })

    if (error) {
        throw new Error(error.message)
    }

    const companyRows = Array.isArray(companies) ? [...companies] : []
    const knownCompanyIds = new Set<string>(
        companyRows
            .map((row: any) => (typeof row?.id === 'string' ? row.id.trim() : ''))
            .filter(Boolean)
    )

    const [
        profileCompanyRowsResult,
        userCompanyRowsResult,
        workflowCompanyRowsResult,
        wabaCompanyRowsResult
    ] = await Promise.all([
        supabase.from('profiles').select('company_id').not('company_id', 'is', null),
        supabase.from('users').select('company_id').not('company_id', 'is', null),
        supabase.from('workflows').select('company_id').not('company_id', 'is', null),
        supabase.from('waba_configs').select('company_id').not('company_id', 'is', null)
    ])

    const operationalCompanyIds = new Set<string>()
    ;[
        profileCompanyRowsResult,
        userCompanyRowsResult,
        workflowCompanyRowsResult,
        wabaCompanyRowsResult
    ].forEach((result: any) => {
        const rows = Array.isArray(result?.data) ? result.data : []
        rows.forEach((row: any) => {
            const companyId = typeof row?.company_id === 'string' ? row.company_id.trim() : ''
            if (companyId) operationalCompanyIds.add(companyId)
        })
    })

    operationalCompanyIds.forEach((companyId) => {
        if (knownCompanyIds.has(companyId)) return
        knownCompanyIds.add(companyId)
        companyRows.push({
            id: companyId,
            name: companyId,
            email: null,
            created_at: null,
            ui_hidden_features: []
        })
    })

    companyRows.sort((a: any, b: any) => {
        const aTime = a?.created_at ? new Date(a.created_at).getTime() : 0
        const bTime = b?.created_at ? new Date(b.created_at).getTime() : 0
        return bTime - aTime
    })

    const activeProfileIds = new Set(await wabaRegistry.getProfileIds())
    const hasServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)
    const authUserEmailCache = new Map<string, string>()

    const resolveAuthEmailByUserId = async (userId: string): Promise<string> => {
        if (!userId) return ''
        const cached = authUserEmailCache.get(userId)
        if (cached !== undefined) return cached
        if (!hasServiceRole) {
            authUserEmailCache.set(userId, '')
            return ''
        }
        try {
            const { data, error: authError } = await supabase.auth.admin.getUserById(userId)
            const email = !authError && data?.user?.email ? String(data.user.email) : ''
            authUserEmailCache.set(userId, email)
            return email
        } catch {
            authUserEmailCache.set(userId, '')
            return ''
        }
    }

    const companyStats = await Promise.all(companyRows.map(async (company: any) => {
        const [
            profileRowsResult,
            usersCount,
            workflowsCount,
            wabaRowsResult,
            messagesCountResult
        ] = await Promise.all([
            supabase.from('profiles').select('id, name, user_id').eq('company_id', company.id),
            supabase.from('users').select('id', { count: 'exact', head: true }).eq('company_id', company.id),
            supabase.from('workflows').select('id', { count: 'exact', head: true }).eq('company_id', company.id),
            supabase.from('waba_configs').select('profile_id, phone_number_id, waba_id, enabled').eq('company_id', company.id),
            supabase
                .from('messages')
                .select('id, users!inner(company_id)', { count: 'exact', head: true })
                .eq('users.company_id', company.id)
        ])

        const problems: string[] = []
        if (profileRowsResult.error) problems.push('Failed to read profiles')
        if (usersCount.error) problems.push('Failed to read contacts')
        if (workflowsCount.error) problems.push('Failed to read workflows')
        if (wabaRowsResult.error) problems.push('Failed to read WABA configs')
        if (messagesCountResult.error) problems.push('Failed to read messages')

        const profileRows = Array.isArray(profileRowsResult.data) ? profileRowsResult.data : []
        const wabaRows = Array.isArray(wabaRowsResult.data) ? wabaRowsResult.data : []
        const enabledWabaRows = wabaRows.filter((row: any) => row?.enabled === true)

        const profileById = new Map<string, any>()
        profileRows.forEach((row: any) => {
            const profileId = typeof row?.id === 'string' ? row.id.trim() : ''
            if (!profileId) return
            profileById.set(profileId, row)
        })

        const activeWabaUsers = await Promise.all(
            enabledWabaRows
                .filter((row: any) => typeof row?.profile_id === 'string' && row.profile_id.trim())
                .map(async (row: any) => {
                    const profileId = String(row.profile_id).trim()
                    const profile = profileById.get(profileId) || {}
                    const userId = typeof profile?.user_id === 'string' ? profile.user_id : ''
                    const userEmail = userId ? await resolveAuthEmailByUserId(userId) : ''
                    return {
                        profile_id: profileId,
                        profile_name: typeof profile?.name === 'string' && profile.name.trim() ? profile.name.trim() : profileId,
                        user_id: userId || null,
                        user_email: userEmail || null,
                        phone_number_id: typeof row?.phone_number_id === 'string' ? row.phone_number_id : null,
                        waba_id: typeof row?.waba_id === 'string' ? row.waba_id : null,
                        active: activeProfileIds.has(profileId)
                    }
                })
        )

        const activeWabaConnections = activeWabaUsers.filter((entry: any) => entry.active).length
        const profileCount = profileRows.length
        const wabaCount = wabaRows.length
        const wabaEnabledCount = enabledWabaRows.length
        const contactsCount = usersCount.count || 0
        const workflowsCountValue = workflowsCount.count || 0
        const messagesCount = messagesCountResult.count || 0

        if (profileCount === 0) problems.push('No profiles')
        if (wabaEnabledCount === 0) {
            problems.push('No enabled WABA config')
        } else if (activeWabaConnections === 0) {
            problems.push('Enabled WABA found but inactive')
        }
        if (workflowsCountValue > 0 && wabaEnabledCount === 0) {
            problems.push('Workflows exist but WABA is not enabled')
        }

        return {
            id: company.id,
            name: company.name,
            email: company.email,
            created_at: company.created_at,
            ui_hidden_features: sanitizeUiHiddenFeatures(company?.ui_hidden_features),
            active_waba_users: activeWabaUsers,
            problems: Array.from(new Set(problems)),
            counts: {
                profiles: profileCount,
                contacts: contactsCount,
                workflows: workflowsCountValue,
                waba_configs: wabaCount,
                waba_enabled: wabaEnabledCount,
                waba_active: activeWabaConnections,
                messages: messagesCount
            }
        }
    }))

    const totals = companyStats.reduce(
        (acc, row) => {
            acc.companies += 1
            acc.profiles += row.counts.profiles
            acc.contacts += row.counts.contacts
            acc.workflows += row.counts.workflows
            acc.waba_configs += row.counts.waba_configs
            acc.waba_enabled += row.counts.waba_enabled
            acc.waba_active += row.counts.waba_active
            acc.messages += row.counts.messages
            return acc
        },
        { companies: 0, profiles: 0, contacts: 0, workflows: 0, waba_configs: 0, waba_enabled: 0, waba_active: 0, messages: 0 }
    )

    return {
        totals,
        monitor: buildAdminMonitorPayload(),
        companies: companyStats
    }
}

// ============================================
// MYADMIN (Super Admin Monitor)
// ============================================
app.get('/api/admin/setup-status', async (_req: any, res: any) => {
    try {
        const superadmins = await countSuperAdminUsers()
        const legacyAdmins = await countLegacyWabaAdminUsers()

        return res.json({
            success: true,
            data: {
                setupOpen: superadmins === 0 && legacyAdmins === 0,
                superadmins,
                legacyAdmins
            }
        })
    } catch (error: any) {
        return res.status(500).json({ success: false, error: error?.message || 'Failed to load setup status' })
    }
})

app.post('/api/admin/setup', async (req: any, res: any) => {
    try {
        const hasServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)
        if (!hasServiceRole) {
            return res.status(500).json({ success: false, error: 'SUPABASE_SERVICE_ROLE_KEY is required to create superadmin' })
        }

        const email = extractAdminEmail(req)
        const password = extractAdminPassword(req)
        if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
            return res.status(400).json({ success: false, error: 'Valid email is required' })
        }
        if (password.length < 8) {
            return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' })
        }

        const superadmins = await countSuperAdminUsers()
        const legacyAdmins = await countLegacyWabaAdminUsers()
        if (superadmins > 0) {
            return res.status(409).json({ success: false, error: 'Setup is already closed. Superadmin already exists.' })
        }
        if (legacyAdmins > 0) {
            return res.status(409).json({
                success: false,
                error: 'Setup is already closed. Legacy WABA admin accounts detected. Promote one account to super_admin.'
            })
        }

        const created = await supabase.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
            user_metadata: {
                super_admin: true,
                role: 'super_admin'
            },
            app_metadata: {
                super_admin: true,
                role: 'super_admin'
            }
        } as any)

        if (created.error || !created.data?.user?.id) {
            const message = created.error?.message || 'Failed to create superadmin'
            const isConflict = /already|exists|registered/i.test(message)
            return res.status(isConflict ? 409 : 500).json({ success: false, error: message })
        }

        return res.json({
            success: true,
            data: {
                userId: created.data.user.id,
                email
            }
        })
    } catch (error: any) {
        return res.status(500).json({ success: false, error: error?.message || 'Failed to create superadmin' })
    }
})

app.post('/api/admin/login', async (req: any, res: any) => {
    try {
        const email = extractAdminEmail(req)
        const password = extractAdminPassword(req)
        if (!email || !password) {
            return res.status(400).json({ success: false, error: 'Email and password are required' })
        }

        const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password })
        if (error || !data?.user || !data?.session) {
            return res.status(401).json({ success: false, error: error?.message || 'Invalid email or password' })
        }

        if (!isSuperAdminUser(data.user)) {
            return res.status(403).json({ success: false, error: 'Superadmin access required' })
        }

        return res.json({
            success: true,
            data: {
                email: data.user.email || email,
                accessToken: data.session.access_token,
                refreshToken: data.session.refresh_token,
                expiresAt: data.session.expires_at || null
            }
        })
    } catch (error: any) {
        return res.status(500).json({ success: false, error: error?.message || 'Login failed' })
    }
})

app.get('/api/admin/summary', async (req: any, res: any) => {
    try {
        const access = await resolveSuperAdminAccess(req, res)
        if (!access) return
        const payload = await buildAdminSummaryPayload()
        return res.json({ success: true, ...payload })
    } catch (error: any) {
        return res.status(500).json({ success: false, error: error?.message || 'Failed to load admin summary' })
    }
})

app.post('/api/admin/maintenance-mode', async (req: any, res: any) => {
    try {
        const access = await resolveSuperAdminAccess(req, res)
        if (!access) return
        if (!systemRuntimeStatus || typeof systemRuntimeStatus.setMaintenanceMode !== 'function') {
            return res.status(503).json({ success: false, error: 'Runtime status service unavailable' })
        }

        const enabled = req.body?.enabled === true
        const message = readTrimmed(req.body?.message).slice(0, 280)
        const actor = readTrimmed(access.user?.email || access.user?.id || '')
        const snapshot = systemRuntimeStatus.setMaintenanceMode({
            enabled,
            message,
            updatedBy: actor || null
        })

        return res.json({
            success: true,
            data: serializeSystemRuntimeStatus(snapshot)
        })
    } catch (error: any) {
        return res.status(500).json({ success: false, error: error?.message || 'Failed to update maintenance mode' })
    }
})

app.post('/api/admin/company-ui', async (req: any, res: any) => {
    try {
        const access = await resolveSuperAdminAccess(req, res)
        if (!access) return

        const companyId = normalizeCompanyId(req.body?.companyId || req.body?.company_id || '')
        if (!companyId) {
            return res.status(400).json({ success: false, error: 'companyId is required' })
        }

        const hiddenFeatures = sanitizeUiHiddenFeatures(req.body?.hiddenFeatures ?? req.body?.hidden_features ?? req.body?.ui_hidden_features)

        const { data, error } = await supabase
            .from('company')
            .update({
                ui_hidden_features: hiddenFeatures
            })
            .eq('id', companyId)
            .select('id, ui_hidden_features')
            .maybeSingle()

        if (error) {
            if (isUiHiddenFeaturesMissingError(error)) {
                return res.status(503).json({
                    success: false,
                    code: 'UI_CONTROLS_MISSING',
                    error: UI_HIDDEN_FEATURES_MISSING_MESSAGE
                })
            }
            return res.status(500).json({ success: false, error: error.message })
        }

        if (!data) {
            return res.status(404).json({ success: false, error: 'Company not found' })
        }

        return res.json({
            success: true,
            data: {
                company_id: data.id,
                hidden_features: sanitizeUiHiddenFeatures((data as any).ui_hidden_features)
            }
        })
    } catch (error: any) {
        return res.status(500).json({ success: false, error: error?.message || 'Failed to update UI controls' })
    }
})

// Backward-compatible JSON endpoint
app.get('/my', async (req: any, res: any) => {
    try {
        const access = await resolveSuperAdminAccess(req, res)
        if (!access) return
        const payload = await buildAdminSummaryPayload()
        return res.json({ success: true, ...payload })
    } catch (error: any) {
        return res.status(500).json({ success: false, error: error?.message || 'Failed to load admin summary' })
    }
})

function escapeHtml(value: string) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

function renderPublicInfoPage(payload: {
    title: string
    subtitle: string
    paragraphs: string[]
}) {
    const paragraphs = payload.paragraphs
        .map((line) => `<p>${escapeHtml(line)}</p>`)
        .join('')
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(payload.title)} · 2fast</title>
  <style>
    :root { --bg:#f5f7f8; --card:#fff; --line:#d9e2e6; --text:#111b21; --muted:#54656f; --brand:#00a884; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Arial, sans-serif; background:var(--bg); color:var(--text); }
    .wrap { max-width: 900px; margin: 0 auto; padding: 28px 18px; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 22px; }
    h1 { margin: 0 0 8px; font-size: 30px; }
    .sub { margin: 0 0 18px; color: var(--muted); font-size: 14px; }
    p { color: #1f2937; line-height: 1.65; margin: 0 0 12px; font-size: 15px; }
    a { color: #0f766e; text-decoration: none; font-weight: 700; }
    a:hover { text-decoration: underline; }
    .nav { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: 12px; font-size: 13px; }
    .pill { background: #eef6f4; border: 1px solid #d3e8e3; border-radius: 999px; padding: 7px 12px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>${escapeHtml(payload.title)}</h1>
      <p class="sub">${escapeHtml(payload.subtitle)}</p>
      ${paragraphs}
      <div class="nav">
        <a class="pill" href="/support">Support</a>
        <a class="pill" href="/privacy-policy">Privacy Policy</a>
        <a class="pill" href="/data-deletion">User Data Deletion</a>
        <a class="pill" href="/terms-and-conditions">Terms & Conditions</a>
        <a class="pill" href="/">Back to Login</a>
      </div>
    </div>
  </div>
</body>
</html>`
}

registerPublicInfoRoutes(app, { renderPublicInfoPage })

app.get('/myadmin', (_req: any, res: any) => {
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MyAdmin Company Monitor</title>
  <style>
    :root { --bg:#f4f7f8; --card:#ffffff; --line:#d9e2e6; --text:#111b21; --muted:#54656f; --brand:#00a884; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, sans-serif; background: var(--bg); color: var(--text); }
    .wrap { max-width: 1200px; margin: 0 auto; padding: 24px; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; }
    .login { max-width: 440px; margin: 80px auto; padding: 20px; display: grid; gap: 10px; }
    .panel-head { display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; padding: 16px; margin-bottom: 16px; }
    .inline { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    input, button { font: inherit; }
    input { width: 100%; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
    button { border: 0; border-radius: 10px; padding: 10px 14px; cursor: pointer; font-weight: 700; }
    .btn-primary { background: var(--brand); color: #fff; }
    .btn-secondary { background: #eaf4f2; color: #0b6f59; }
    .status { padding: 12px 16px; margin-bottom: 16px; color: var(--muted); }
    .totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; padding: 16px; margin-bottom: 16px; }
    .metric { padding: 12px; border: 1px solid var(--line); border-radius: 10px; background: #fcfdfd; }
    .metric b { display: block; font-size: 20px; margin-top: 4px; }
    .table-wrap { overflow: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); font-size: 13px; white-space: nowrap; }
    th { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
    .mono { font-family: Menlo, Consolas, monospace; }
    .right { text-align: right; }
	    .hidden { display: none; }
	    .title { margin: 0; font-size: 18px; font-weight: 700; }
	    .hint { color: var(--muted); font-size: 13px; }
	    .list-stack { display: grid; gap: 4px; min-width: 260px; }
	    .tiny { font-size: 11px; color: #475467; }
	    .pill {
	      display: inline-flex;
	      align-items: center;
	      border: 1px solid #d7e5df;
	      border-radius: 999px;
	      padding: 2px 8px;
	      background: #f4fbf8;
	      color: #0f766e;
	      font-size: 10px;
	      font-weight: 700;
	      margin-right: 6px;
	    }
	    .feature-grid { display: grid; grid-template-columns: repeat(2, minmax(96px, 1fr)); gap: 6px; min-width: 250px; }
	    .feature-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: #344054; }
	    .feature-chip input { width: 14px; height: 14px; margin: 0; }
	    .problem-ok { color: #027a48; font-weight: 700; font-size: 11px; }
	    .problem-bad { color: #b42318; font-size: 11px; display: block; margin-bottom: 2px; }
	    .btn-save { background: #111b21; color: #fff; padding: 8px 10px; border-radius: 8px; font-size: 11px; }
	    .btn-save:disabled { opacity: 0.65; cursor: not-allowed; }
	    .route-muted { color: #667085; font-size: 11px; }
	    .ops-label { display: block; color: #54656f; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
	    .ops-value { display: block; font-size: 20px; font-weight: 800; margin-top: 4px; }
	    .ops-meta { display: block; color: #667085; font-size: 11px; margin-top: 4px; }
	    .runtime-card { padding: 16px; margin-bottom: 16px; }
	    .runtime-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-bottom: 12px; }
	    .runtime-kpi { border: 1px solid var(--line); border-radius: 10px; background: #fcfdfd; padding: 10px 12px; }
	    .runtime-kpi b { display: block; font-size: 18px; margin-top: 4px; }
	    .runtime-maint { border: 1px solid var(--line); border-radius: 10px; background: #fcfdfd; padding: 12px; margin-bottom: 12px; }
	    .runtime-maint textarea { width: 100%; min-height: 84px; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; resize: vertical; font: inherit; }
	    .runtime-maint-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
	    .runtime-maint-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
	    .runtime-state-online { color: #027a48; }
	    .runtime-state-offline { color: #b42318; }
	    #maintenanceEnabled { width: 14px; height: 14px; margin: 0; }
	  </style>
</head>
<body>
  <div class="wrap">
    <div id="loginPanel" class="card login">
      <h1 class="title">MyAdmin Login</h1>
      <div class="hint">Use superadmin credentials to monitor all companies.</div>
      <input id="adminIdInput" type="email" placeholder="Admin email" />
      <input id="adminPasswordInput" type="password" placeholder="Password" />
      <button id="setupBtn" class="btn-secondary hidden">Create First Superadmin</button>
      <button id="loginBtn" class="btn-primary">Login</button>
      <div id="loginStatus" class="hint"></div>
    </div>

    <div id="monitorPanel" class="hidden">
      <div class="card panel-head">
        <div class="inline">
          <h2 class="title">MyAdmin Company Monitor</h2>
          <span id="adminBadge" class="hint"></span>
        </div>
        <div class="inline">
          <button id="refreshBtn" class="btn-primary">Refresh</button>
          <button id="logoutBtn" class="btn-secondary">Logout</button>
        </div>
      </div>

      <div id="status" class="card status">Ready.</div>
      <div id="totals" class="card totals" style="display:none"></div>
      <div id="opsMetrics" class="card totals" style="display:none"></div>
      <div id="systemRuntimeCard" class="card runtime-card" style="display:none">
        <div class="panel-head" style="padding:0;margin-bottom:12px;">
          <div class="inline">
            <h3 class="title">System Runtime</h3>
            <span class="hint">Downtime log and maintenance mode</span>
          </div>
        </div>
        <div id="systemRuntimeMetrics" class="runtime-grid"></div>
        <div class="runtime-maint">
          <div class="runtime-maint-head">
            <label class="feature-chip">
              <input id="maintenanceEnabled" type="checkbox" />
              <span>Maintenance mode enabled</span>
            </label>
          </div>
          <textarea id="maintenanceMessage" maxlength="280" placeholder="Optional maintenance message shown to users"></textarea>
          <div class="runtime-maint-row">
            <span id="maintenanceMeta" class="tiny"></span>
            <button id="saveMaintenanceBtn" class="btn-save" type="button">Save Maintenance</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Offline From</th>
                <th>Back Online</th>
                <th>Duration</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody id="downtimeRows"></tbody>
          </table>
        </div>
      </div>

      <div id="apiRoutesCard" class="card table-wrap" style="display:none">
        <table>
          <thead>
            <tr>
              <th>API Route</th>
              <th class="right">Calls</th>
              <th class="right">Error %</th>
              <th class="right">Avg (ms)</th>
              <th class="right">Avg/Max (ms)</th>
              <th class="right">Traffic In</th>
              <th class="right">Traffic Out</th>
              <th>Last Status</th>
              <th>Last Hit</th>
            </tr>
          </thead>
          <tbody id="apiRouteRows"></tbody>
        </table>
      </div>

	      <div class="card table-wrap">
	        <table>
	          <thead>
	            <tr>
	              <th>Company ID</th>
	              <th>Name</th>
	              <th>Email</th>
	              <th class="right">Profiles</th>
	              <th class="right">Contacts</th>
	              <th class="right">Workflows</th>
	              <th class="right">WABA</th>
	              <th class="right">WABA On</th>
	              <th class="right">WABA Active</th>
	              <th class="right">Messages</th>
	              <th>Active WABA Users</th>
	              <th>UI Controls</th>
	              <th>Problems</th>
	              <th>Action</th>
	              <th>Created</th>
	            </tr>
	          </thead>
	          <tbody id="companyRows"></tbody>
	        </table>
      </div>
    </div>
  </div>

  <script>
    const STORAGE_KEY_EMAIL = 'myadmin_email';
    const STORAGE_KEY_TOKEN = 'myadmin_token';

    const loginPanel = document.getElementById('loginPanel');
    const monitorPanel = document.getElementById('monitorPanel');
    const adminEmailInput = document.getElementById('adminIdInput');
    const adminPasswordInput = document.getElementById('adminPasswordInput');
    const setupBtn = document.getElementById('setupBtn');
    const loginBtn = document.getElementById('loginBtn');
    const loginStatus = document.getElementById('loginStatus');
    const adminBadge = document.getElementById('adminBadge');
    const refreshBtn = document.getElementById('refreshBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const statusEl = document.getElementById('status');
    const totalsEl = document.getElementById('totals');
    const opsMetricsEl = document.getElementById('opsMetrics');
    const systemRuntimeCardEl = document.getElementById('systemRuntimeCard');
    const systemRuntimeMetricsEl = document.getElementById('systemRuntimeMetrics');
    const maintenanceEnabledEl = document.getElementById('maintenanceEnabled');
    const maintenanceMessageEl = document.getElementById('maintenanceMessage');
    const maintenanceMetaEl = document.getElementById('maintenanceMeta');
    const saveMaintenanceBtn = document.getElementById('saveMaintenanceBtn');
    const downtimeRowsEl = document.getElementById('downtimeRows');
    const apiRoutesCardEl = document.getElementById('apiRoutesCard');
    const apiRouteRowsEl = document.getElementById('apiRouteRows');
    const rowsEl = document.getElementById('companyRows');
    const FEATURE_OPTIONS = [
      { key: 'team-inbox', label: 'Team Inbox' },
      { key: 'automations', label: 'Automation' },
      { key: 'broadcast', label: 'Broadcast' },
      { key: 'chatbots', label: 'Chatbot' },
      { key: 'contacts', label: 'Contacts' },
      { key: 'calls', label: 'Calls' },
      { key: 'analytics', label: 'Analytics' },
      { key: 'settings', label: 'Settings' },
      { key: 'settings-review', label: 'Permission Console' },
      { key: 'settings-manual', label: 'Manual WABA Setup' },
      { key: 'settings-register', label: 'Register Number' },
      { key: 'settings-webhooks', label: 'Outgoing Webhooks' },
      { key: 'settings-ads-shoot', label: 'Ads Shoot Mode' }
    ];
    const FEATURE_KEYS = new Set(FEATURE_OPTIONS.map(function(item) { return item.key; }));
    const FEATURE_ALIASES = {
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
      'ads-shoot-mode': 'settings-ads-shoot'
    };

    function setStatus(message, isError) {
      statusEl.textContent = message;
      statusEl.style.color = isError ? '#b42318' : '#54656f';
    }

    function showLogin(message, isError) {
      loginPanel.classList.remove('hidden');
      monitorPanel.classList.add('hidden');
      loginStatus.textContent = message || '';
      loginStatus.style.color = isError ? '#b42318' : '#54656f';
    }

    function showMonitor(adminEmail) {
      adminBadge.textContent = adminEmail ? 'Signed in as ' + adminEmail : '';
      loginPanel.classList.add('hidden');
      monitorPanel.classList.remove('hidden');
      loginStatus.textContent = '';
    }

    function readStoredCreds() {
      return {
        email: sessionStorage.getItem(STORAGE_KEY_EMAIL) || '',
        token: sessionStorage.getItem(STORAGE_KEY_TOKEN) || ''
      };
    }

    function saveCreds(email, token) {
      sessionStorage.setItem(STORAGE_KEY_EMAIL, email);
      sessionStorage.setItem(STORAGE_KEY_TOKEN, token);
    }

    function clearCreds() {
      sessionStorage.removeItem(STORAGE_KEY_EMAIL);
      sessionStorage.removeItem(STORAGE_KEY_TOKEN);
    }

    async function fetchSetupStatus() {
      const res = await fetch('/api/admin/setup-status');
      const data = await res.json().catch(function() { return null; });
      if (!res.ok || !data || !data.success) {
        throw new Error((data && data.error) || 'Failed to load setup status');
      }
      return data.data || { setupOpen: false, superadmins: 0, legacyAdmins: 0 };
    }

    async function createFirstSuperAdmin(email, password) {
      const res = await fetch('/api/admin/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: password })
      });
      const data = await res.json().catch(function() { return null; });
      if (!res.ok || !data || !data.success) {
        throw new Error((data && data.error) || 'Failed to create superadmin');
      }
      return data;
    }

    async function login(email, password) {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: password })
      });
      const data = await res.json().catch(function() { return null; });
      if (!res.ok || !data || !data.success) {
        throw new Error((data && data.error) || 'Login failed');
      }
      return data.data || {};
    }

    async function saveCompanyUi(companyId, hiddenFeatures) {
      const creds = readStoredCreds();
      if (!creds.token) {
        throw new Error('Session expired. Please login again.');
      }
      const res = await fetch('/api/admin/company-ui', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + creds.token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          companyId: companyId,
          hiddenFeatures: hiddenFeatures
        })
      });
      const data = await res.json().catch(function() { return null; });
      if (!res.ok || !data || !data.success) {
        throw new Error((data && data.error) || 'Failed to save UI controls');
      }
      return (data.data && data.data.hidden_features) || [];
    }

    async function saveMaintenanceMode(enabled, message) {
      const creds = readStoredCreds();
      if (!creds.token) {
        throw new Error('Session expired. Please login again.');
      }
      const res = await fetch('/api/admin/maintenance-mode', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + creds.token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          enabled: enabled === true,
          message: String(message || '').trim().slice(0, 280)
        })
      });
      const data = await res.json().catch(function() { return null; });
      if (!res.ok || !data || !data.success) {
        throw new Error((data && data.error) || 'Failed to update maintenance mode');
      }
      return data.data || null;
    }

    function normalizeHiddenFeatures(value) {
      const output = [];
      const seen = new Set();
      const push = function(entry) {
        const raw = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
        const normalizedBase = raw.replace(/\\s+/g, '-');
        const normalized = FEATURE_ALIASES[normalizedBase] || FEATURE_ALIASES[normalizedBase.replace(/-/g, '')] || normalizedBase;
        if (!normalized || !FEATURE_KEYS.has(normalized) || seen.has(normalized)) return;
        seen.add(normalized);
        output.push(normalized);
      };

      if (Array.isArray(value)) {
        value.forEach(push);
        return output;
      }

      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return output;
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            parsed.forEach(push);
            return output;
          }
        } catch (_err) {
          // continue to CSV parser
        }
        trimmed
          .split(/[,\\n;]/g)
          .map(function(entry) { return entry.trim(); })
          .filter(Boolean)
          .forEach(push);
      }

      return output;
    }

    function renderTotals(totals) {
      totalsEl.innerHTML = '';
      totalsEl.style.display = 'grid';
      const keys = ['companies', 'profiles', 'contacts', 'workflows', 'waba_configs', 'waba_enabled', 'waba_active', 'messages'];
      keys.forEach(function(key) {
        const box = document.createElement('div');
        box.className = 'metric';
        const label = document.createElement('span');
        label.textContent = key.replace(/_/g, ' ');
        const value = document.createElement('b');
        value.textContent = String(totals[key] || 0);
        box.appendChild(label);
        box.appendChild(value);
        totalsEl.appendChild(box);
      });
    }

    function formatNumber(value) {
      const num = Number(value || 0);
      if (!Number.isFinite(num)) return '0';
      return num.toLocaleString();
    }

    function formatBytes(value) {
      const num = Number(value || 0);
      if (!Number.isFinite(num) || num <= 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let idx = 0;
      let cur = num;
      while (cur >= 1024 && idx < units.length - 1) {
        cur = cur / 1024;
        idx += 1;
      }
      return (cur >= 100 || idx === 0 ? cur.toFixed(0) : cur.toFixed(1)) + ' ' + units[idx];
    }

    function formatBps(value) {
      return formatBytes(value) + '/s';
    }

    function formatDuration(seconds) {
      const total = Math.max(0, Math.floor(Number(seconds || 0)));
      const d = Math.floor(total / 86400);
      const h = Math.floor((total % 86400) / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      if (d > 0) return d + 'd ' + h + 'h';
      if (h > 0) return h + 'h ' + m + 'm';
      if (m > 0) return m + 'm ' + s + 's';
      return s + 's';
    }

    function formatDurationMs(value) {
      const num = Number(value);
      if (!Number.isFinite(num) || num <= 0) return '--';
      return formatDuration(num / 1000);
    }

    function formatDateTime(value) {
      if (!value) return '--';
      const dt = new Date(value);
      if (Number.isNaN(dt.getTime())) return '--';
      return dt.toLocaleString();
    }

    function renderMonitor(monitor) {
      opsMetricsEl.innerHTML = '';
      const runtime = monitor && monitor.runtime ? monitor.runtime : {};
      const api = monitor && monitor.api ? monitor.api : {};
      const traffic = monitor && monitor.traffic ? monitor.traffic : {};

      const metricCards = [
        {
          label: 'API Calls (Total)',
          value: formatNumber(api.totalCalls),
          meta: '2xx ' + formatNumber(api.status2xx) + ' | 4xx ' + formatNumber(api.status4xx) + ' | 5xx ' + formatNumber(api.status5xx)
        },
        {
          label: 'API Calls (5m)',
          value: formatNumber(api.windowCalls),
          meta: 'Err ' + String(Number(api.windowErrorRatePct || 0).toFixed(2)) + '% | Success ' + String(Number(api.windowSuccessRatePct || 0).toFixed(2)) + '%'
        },
        {
          label: 'Latency (5m)',
          value: String(Number(api.windowAvgDurationMs || 0).toFixed(1)) + ' ms',
          meta: 'P95 ' + String(Number(api.windowP95DurationMs || 0).toFixed(1)) + ' ms'
        },
        {
          label: 'Traffic In / Out',
          value: formatBytes(traffic.totalInBytes) + ' / ' + formatBytes(traffic.totalOutBytes),
          meta: formatBps(traffic.inBps) + ' in | ' + formatBps(traffic.outBps) + ' out'
        },
        {
          label: 'CPU / RAM',
          value: String(Number(runtime.cpuPct || 0).toFixed(1)) + '% / ' + String(Number(runtime.memPct || 0).toFixed(1)) + '%',
          meta: formatBytes(runtime.memUsed) + ' of ' + formatBytes(runtime.memTotal)
        },
        {
          label: 'Uptime / Sockets',
          value: formatDuration(runtime.uptimeSec) + ' / ' + formatNumber(runtime.activeSockets),
          meta: 'Generated ' + (monitor && monitor.generatedAt ? new Date(monitor.generatedAt).toLocaleString() : '-')
        }
      ];

      metricCards.forEach(function(item) {
        const box = document.createElement('div');
        box.className = 'metric';

        const label = document.createElement('span');
        label.className = 'ops-label';
        label.textContent = item.label;

        const value = document.createElement('span');
        value.className = 'ops-value';
        value.textContent = item.value;

        const meta = document.createElement('span');
        meta.className = 'ops-meta';
        meta.textContent = item.meta;

        box.appendChild(label);
        box.appendChild(value);
        box.appendChild(meta);
        opsMetricsEl.appendChild(box);
      });

      opsMetricsEl.style.display = 'grid';
      renderSystemRuntime(monitor && monitor.systemRuntime ? monitor.systemRuntime : {});
      renderApiRoutes(api.topRoutes);
    }

    function renderSystemRuntime(systemRuntime) {
      const runtime = systemRuntime && typeof systemRuntime === 'object' ? systemRuntime : {};
      const maintenance = runtime.maintenance && typeof runtime.maintenance === 'object'
        ? runtime.maintenance
        : {};
      const downtime = Array.isArray(runtime.downtime_log) ? runtime.downtime_log : [];

      systemRuntimeMetricsEl.innerHTML = '';
      const metricCards = [
        {
          label: 'Server State',
          value: runtime.online === true ? 'ONLINE' : 'OFFLINE',
          meta: 'Heartbeat: ' + formatDateTime(runtime.heartbeat_at),
          state: runtime.online === true ? 'online' : 'offline'
        },
        {
          label: 'Current Uptime',
          value: formatDurationMs(runtime.uptime_ms),
          meta: 'Started: ' + formatDateTime(runtime.started_at)
        },
        {
          label: 'Last Downtime',
          value: formatDurationMs(runtime.last_offline_duration_ms),
          meta: 'Offline at: ' + formatDateTime(runtime.last_offline_at)
        }
      ];

      metricCards.forEach(function(item) {
        const box = document.createElement('div');
        box.className = 'runtime-kpi';
        const label = document.createElement('span');
        label.className = 'ops-label';
        label.textContent = item.label;
        const value = document.createElement('b');
        value.textContent = item.value;
        if (item.state === 'online') value.classList.add('runtime-state-online');
        if (item.state === 'offline') value.classList.add('runtime-state-offline');
        const meta = document.createElement('span');
        meta.className = 'ops-meta';
        meta.textContent = item.meta;
        box.appendChild(label);
        box.appendChild(value);
        box.appendChild(meta);
        systemRuntimeMetricsEl.appendChild(box);
      });

      maintenanceEnabledEl.checked = maintenance.enabled === true;
      maintenanceMessageEl.value = typeof maintenance.message === 'string' ? maintenance.message : '';
      maintenanceMetaEl.textContent =
        'Updated: ' + formatDateTime(maintenance.updated_at) +
        (maintenance.updated_by ? ' by ' + maintenance.updated_by : '');

      downtimeRowsEl.innerHTML = '';
      if (downtime.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 4;
        td.className = 'route-muted';
        td.textContent = 'No downtime entries logged yet.';
        tr.appendChild(td);
        downtimeRowsEl.appendChild(tr);
      } else {
        downtime.forEach(function(entry) {
          const tr = document.createElement('tr');
          const values = [
            formatDateTime(entry && entry.offline_from),
            formatDateTime(entry && entry.offline_until),
            formatDurationMs(entry && entry.duration_ms),
            (entry && entry.reason) ? String(entry.reason) : 'server_unavailable'
          ];
          values.forEach(function(item) {
            const td = document.createElement('td');
            td.textContent = item;
            tr.appendChild(td);
          });
          downtimeRowsEl.appendChild(tr);
        });
      }

      systemRuntimeCardEl.style.display = 'block';
    }

    function renderApiRoutes(routes) {
      apiRouteRowsEl.innerHTML = '';
      const list = Array.isArray(routes) ? routes : [];
      if (list.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 9;
        td.className = 'route-muted';
        td.textContent = 'No API route activity yet.';
        tr.appendChild(td);
        apiRouteRowsEl.appendChild(tr);
        apiRoutesCardEl.style.display = 'block';
        return;
      }

      list.forEach(function(route) {
        const tr = document.createElement('tr');
        const values = [
          { v: route.route || '-', mono: true },
          { v: formatNumber(route.calls), right: true },
          { v: String(Number(route.errorRatePct || 0).toFixed(2)) + '%', right: true },
          { v: String(Number(route.avgDurationMs || 0).toFixed(1)), right: true },
          { v: 'Avg ' + String(Number(route.avgDurationMs || 0).toFixed(1)) + ' / Max ' + String(Number(route.maxDurationMs || 0).toFixed(1)), right: true },
          { v: formatBytes(route.inBytes), right: true },
          { v: formatBytes(route.outBytes), right: true },
          { v: route.lastStatus == null ? '-' : String(route.lastStatus) },
          { v: route.lastHitAt ? new Date(route.lastHitAt).toLocaleString() : '-' }
        ];

        values.forEach(function(item) {
          const td = document.createElement('td');
          td.textContent = item.v == null ? '-' : String(item.v);
          if (item.mono) td.className = 'mono';
          if (item.right) td.className = (td.className ? td.className + ' ' : '') + 'right';
          tr.appendChild(td);
        });

        apiRouteRowsEl.appendChild(tr);
      });

      apiRoutesCardEl.style.display = 'block';
    }

    function renderRows(companies) {
      rowsEl.innerHTML = '';
      companies.forEach(function(company) {
        const tr = document.createElement('tr');
        const hiddenFeatures = normalizeHiddenFeatures(company.ui_hidden_features);
        const values = [
          { v: company.id, mono: true },
          { v: company.name || '-' },
          { v: company.email || '-' },
          { v: company.counts && company.counts.profiles, right: true },
          { v: company.counts && company.counts.contacts, right: true },
          { v: company.counts && company.counts.workflows, right: true },
          { v: company.counts && company.counts.waba_configs, right: true },
          { v: company.counts && company.counts.waba_enabled, right: true },
          { v: company.counts && company.counts.waba_active, right: true },
          { v: company.counts && company.counts.messages, right: true }
        ];
        values.forEach(function(item) {
          const td = document.createElement('td');
          td.textContent = item.v == null ? '-' : String(item.v);
          if (item.mono) td.className = 'mono';
          if (item.right) td.className = (td.className ? td.className + ' ' : '') + 'right';
          tr.appendChild(td);
        });

        const activeUsers = Array.isArray(company.active_waba_users)
          ? company.active_waba_users.filter(function(entry) { return entry && entry.active; })
          : [];
        const activeUsersTd = document.createElement('td');
        if (activeUsers.length === 0) {
          activeUsersTd.textContent = '-';
        } else {
          const stack = document.createElement('div');
          stack.className = 'list-stack';
          activeUsers.forEach(function(entry) {
            const line = document.createElement('div');
            line.className = 'tiny';
            const profileName = entry.profile_name || entry.profile_id || '-';
            const owner = entry.user_email || entry.user_id || 'unknown user';
            const phone = entry.phone_number_id || '-';
            line.textContent = profileName + ' | ' + owner + ' | ' + phone;
            stack.appendChild(line);
          });
          activeUsersTd.appendChild(stack);
        }
        tr.appendChild(activeUsersTd);

        const uiControlsTd = document.createElement('td');
        const grid = document.createElement('div');
        grid.className = 'feature-grid';
        FEATURE_OPTIONS.forEach(function(feature) {
          const label = document.createElement('label');
          label.className = 'feature-chip';
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.checked = hiddenFeatures.indexOf(feature.key) !== -1;
          input.setAttribute('data-company-id', String(company.id || ''));
          input.setAttribute('data-feature', feature.key);
          label.appendChild(input);
          const text = document.createElement('span');
          text.textContent = feature.label;
          label.appendChild(text);
          grid.appendChild(label);
        });
        uiControlsTd.appendChild(grid);
        tr.appendChild(uiControlsTd);

        const problemsTd = document.createElement('td');
        const problems = Array.isArray(company.problems) ? company.problems : [];
        if (problems.length === 0) {
          const ok = document.createElement('span');
          ok.className = 'problem-ok';
          ok.textContent = 'OK';
          problemsTd.appendChild(ok);
        } else {
          problems.forEach(function(problem) {
            const line = document.createElement('span');
            line.className = 'problem-bad';
            line.textContent = String(problem || '');
            problemsTd.appendChild(line);
          });
        }
        tr.appendChild(problemsTd);

        const actionTd = document.createElement('td');
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'btn-save';
        saveBtn.textContent = 'Save UI';
        saveBtn.addEventListener('click', async function() {
          if (!company.id) return;
          const selected = [];
          const selectors = tr.querySelectorAll('input[data-company-id="' + String(company.id) + '"][data-feature]');
          selectors.forEach(function(node) {
            if (node && node.checked) {
              const featureKey = node.getAttribute('data-feature') || '';
              if (FEATURE_KEYS.has(featureKey)) selected.push(featureKey);
            }
          });
          saveBtn.disabled = true;
          setStatus('Saving UI controls for ' + String(company.id) + '...', false);
          try {
            const saved = await saveCompanyUi(String(company.id), selected);
            company.ui_hidden_features = normalizeHiddenFeatures(saved);
            setStatus('Saved UI controls for ' + String(company.id) + '.', false);
          } catch (err) {
            setStatus(err && err.message ? err.message : 'Failed to save UI controls.', true);
          } finally {
            saveBtn.disabled = false;
          }
        });
        actionTd.appendChild(saveBtn);
        tr.appendChild(actionTd);

        const createdTd = document.createElement('td');
        createdTd.textContent = company.created_at ? new Date(company.created_at).toLocaleString() : '-';
        tr.appendChild(createdTd);

        rowsEl.appendChild(tr);
      });
    }

    async function loadSummary() {
      const creds = readStoredCreds();
      if (!creds.token) {
        showLogin('Please login first.', true);
        return;
      }
      setStatus('Loading company monitor...', false);
      refreshBtn.disabled = true;
      try {
        const res = await fetch('/api/admin/summary', {
          headers: {
            'Authorization': 'Bearer ' + creds.token
          }
        });
        const data = await res.json().catch(function() { return null; });
        if (!res.ok || !data || !data.success) {
          throw new Error((data && data.error) || 'Failed to load admin summary');
        }
        renderTotals(data.totals || {});
        renderMonitor(data.monitor || {});
        renderRows(Array.isArray(data.companies) ? data.companies : []);
        const companyCount = String((data.totals && data.totals.companies) || 0);
        const apiCalls5m = String((data.monitor && data.monitor.api && data.monitor.api.windowCalls) || 0);
        const errorRate = Number(data.monitor && data.monitor.api ? data.monitor.api.windowErrorRatePct || 0 : 0).toFixed(2);
        setStatus('Loaded ' + companyCount + ' companies. API calls (5m): ' + apiCalls5m + ', 5xx error rate: ' + errorRate + '%.', false);
      } catch (err) {
        clearCreds();
        showLogin(err && err.message ? err.message : 'Session expired. Please login again.', true);
      } finally {
        refreshBtn.disabled = false;
      }
    }

    async function refreshSetupControls() {
      try {
        const setup = await fetchSetupStatus();
        if (setup.setupOpen) {
          setupBtn.classList.remove('hidden');
          if (!loginStatus.textContent) {
            showLogin('Setup is open. Create the first superadmin account.', false);
          }
        } else {
          setupBtn.classList.add('hidden');
          if (setup.legacyAdmins > 0 && !loginStatus.textContent) {
            showLogin('Legacy WABA admin accounts found. Promote one account to super_admin in Supabase metadata.', false);
          }
        }
      } catch (err) {
        showLogin(err && err.message ? err.message : 'Failed to load setup status.', true);
      }
    }

    loginBtn.addEventListener('click', async function() {
      const email = (adminEmailInput.value || '').trim().toLowerCase();
      const password = adminPasswordInput.value || '';
      if (!email || !password) {
        showLogin('Enter admin email and password.', true);
        return;
      }
      loginBtn.disabled = true;
      try {
        const data = await login(email, password);
        if (!data.accessToken) throw new Error('Missing access token');
        saveCreds(data.email || email, data.accessToken);
        showMonitor(data.email || email);
        await loadSummary();
      } catch (err) {
        showLogin(err && err.message ? err.message : 'Login failed.', true);
      } finally {
        loginBtn.disabled = false;
      }
    });

    setupBtn.addEventListener('click', async function() {
      const email = (adminEmailInput.value || '').trim().toLowerCase();
      const password = adminPasswordInput.value || '';
      if (!email || !password) {
        showLogin('Enter admin email and password first.', true);
        return;
      }
      setupBtn.disabled = true;
      try {
        await createFirstSuperAdmin(email, password);
        const data = await login(email, password);
        if (!data.accessToken) throw new Error('Missing access token');
        saveCreds(data.email || email, data.accessToken);
        showMonitor(data.email || email);
        await loadSummary();
      } catch (err) {
        showLogin(err && err.message ? err.message : 'Failed to create admin.', true);
      } finally {
        setupBtn.disabled = false;
        await refreshSetupControls();
      }
    });

    adminPasswordInput.addEventListener('keydown', function(event) {
      if (event.key === 'Enter') loginBtn.click();
    });

    saveMaintenanceBtn.addEventListener('click', async function() {
      const enabled = maintenanceEnabledEl.checked === true;
      const message = (maintenanceMessageEl.value || '').trim().slice(0, 280);
      saveMaintenanceBtn.disabled = true;
      setStatus('Saving maintenance mode...', false);
      try {
        const runtime = await saveMaintenanceMode(enabled, message);
        if (runtime) {
          renderSystemRuntime(runtime);
        }
        setStatus('Maintenance mode updated.', false);
      } catch (err) {
        setStatus(err && err.message ? err.message : 'Failed to update maintenance mode.', true);
      } finally {
        saveMaintenanceBtn.disabled = false;
      }
    });

    refreshBtn.addEventListener('click', loadSummary);
    logoutBtn.addEventListener('click', function() {
      clearCreds();
      totalsEl.style.display = 'none';
      totalsEl.innerHTML = '';
      opsMetricsEl.style.display = 'none';
      opsMetricsEl.innerHTML = '';
      systemRuntimeCardEl.style.display = 'none';
      systemRuntimeMetricsEl.innerHTML = '';
      downtimeRowsEl.innerHTML = '';
      maintenanceMessageEl.value = '';
      maintenanceMetaEl.textContent = '';
      apiRoutesCardEl.style.display = 'none';
      apiRouteRowsEl.innerHTML = '';
      rowsEl.innerHTML = '';
      adminPasswordInput.value = '';
      showLogin('Logged out.', false);
    });

    async function init() {
      await refreshSetupControls();
      const stored = readStoredCreds();
      if (stored.email && stored.token) {
        adminEmailInput.value = stored.email;
        showMonitor(stored.email);
        await loadSummary();
      } else {
        showLogin('', false);
      }
    }

    init();
  </script>
</body>
</html>`

    res.setHeader('content-type', 'text/html; charset=utf-8')
    return res.send(html)
})

const getClient = async (profileId: string) => wabaRegistry.getClientByProfile(profileId)
app.use(
    '/addon',
    addon.createAddonRouter(
        getClient,
        getCompanyIdForProfile,
        workflowEngine,
        verifyApiKey,
        { resolveProfileAccess }
    )
)

function normalizeSimulatedPaymentStatus(value: unknown): 'payment_success' | 'payment_not_success' | null {
    const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
    if (!raw) return null
    if (raw === 'payment_success' || raw === 'success' || raw === 'paid' || raw === 'done' || raw === 'ok') {
        return 'payment_success'
    }
    if (raw === 'payment_not_success' || raw === 'not_success' || raw === 'failed' || raw === 'fail' || raw === 'not_paid' || raw === 'pending') {
        return 'payment_not_success'
    }
    return null
}

function normalizeSimulatedPaymentReturnUrl(value: unknown): string {
    const raw = typeof value === 'string' ? value.trim() : ''
    if (!raw) return ''
    try {
        const parsed = new URL(raw)
        const protocol = parsed.protocol.toLowerCase()
        if (protocol === 'https:' || protocol === 'http:' || protocol === 'whatsapp:') {
            return raw
        }
        return ''
    } catch {
        return ''
    }
}

app.get('/simulated-payment', async (req: any, res: any) => {
    const profileId = typeof req.query?.profileId === 'string' ? req.query.profileId.trim() : ''
    const phoneRaw = typeof req.query?.phone === 'string' ? req.query.phone : ''
    const phone = normalizePhoneNumber(phoneRaw)
    const merchant = (typeof req.query?.merchant === 'string' ? req.query.merchant.trim() : '') || '2Fast Merchant Simulation'
    const amount = (typeof req.query?.amount === 'string' ? req.query.amount.trim() : '') || '59.90'
    const currency = (typeof req.query?.currency === 'string' ? req.query.currency.trim().toUpperCase() : '') || 'MYR'
    const invoice = (typeof req.query?.invoice === 'string' ? req.query.invoice.trim() : '') || `SIM-${Date.now().toString().slice(-8)}`
    const reference = (typeof req.query?.reference === 'string' ? req.query.reference.trim() : '') || invoice
    const returnUrl = normalizeSimulatedPaymentReturnUrl(req.query?.returnUrl)
    const returnFallback = normalizeSimulatedPaymentReturnUrl(req.query?.returnFallback)
    const returnSuccessUrl = normalizeSimulatedPaymentReturnUrl(req.query?.returnSuccessUrl)
    const returnFailUrl = normalizeSimulatedPaymentReturnUrl(req.query?.returnFailUrl)
    const returnSuccessFallback = normalizeSimulatedPaymentReturnUrl(req.query?.returnSuccessFallback)
    const returnFailFallback = normalizeSimulatedPaymentReturnUrl(req.query?.returnFailFallback)

    const missingRequired = !profileId || !phone
    const defaultWhatsappDeepLink = phone ? `whatsapp://send?phone=${phone}` : 'whatsapp://'
    const defaultWhatsappWebLink = phone ? `https://wa.me/${phone}` : 'https://wa.me/'
    const qrPayload = JSON.stringify({
        merchant,
        amount,
        currency,
        invoice,
        reference,
        profileId,
        phone
    })
    const qrImageUrl = `https://quickchart.io/qr?size=280&margin=1&text=${encodeURIComponent(qrPayload)}`

    const cfgJson = JSON.stringify({
        profileId,
        phone,
        reference,
        merchant,
        amount,
        currency,
        invoice,
        returnUrl: returnUrl || defaultWhatsappDeepLink,
        returnFallback: returnFallback || defaultWhatsappWebLink,
        returnSuccessUrl: returnSuccessUrl || '',
        returnFailUrl: returnFailUrl || '',
        returnSuccessFallback: returnSuccessFallback || '',
        returnFailFallback: returnFailFallback || '',
        redirectFallbackDelayMs: 850
    }).replace(/</g, '\\u003c')

    const missingMessage = missingRequired
        ? 'Missing profileId or phone in URL. Add ?profileId=...&phone=... to allow workflow updates.'
        : ''

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Simulated Merchant Payment</title>
  <style>
    :root {
      --bg: #f5f7f9;
      --panel: #ffffff;
      --line: #d8e2e8;
      --text: #0f1720;
      --muted: #536471;
      --brand: #0f766e;
      --accent: #134e4a;
      --good: #0f8f49;
      --bad: #b42318;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Space Grotesk", "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(1200px 480px at 15% -10%, #d1fae5 0%, transparent 55%),
        radial-gradient(1000px 420px at 95% 110%, #dbeafe 0%, transparent 55%),
        var(--bg);
    }
    .page { max-width: 1080px; margin: 0 auto; padding: 24px 18px 28px; }
    .hero {
      display: grid;
      grid-template-columns: 1.1fr 0.9fr;
      gap: 16px;
      margin-bottom: 16px;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 18px;
      box-shadow: 0 12px 30px rgba(15, 23, 32, 0.08);
    }
    h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: -0.03em; }
    .sub { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.5; }
    .meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 16px; }
    .meta div { background: #f8fbfc; border: 1px solid #e7eef2; border-radius: 12px; padding: 10px 12px; }
    .meta b { display: block; font-size: 11px; color: #647481; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 3px; }
    .meta span { font-size: 14px; font-weight: 700; }
    .amount { font-size: 34px; font-weight: 800; line-height: 1; margin-top: 14px; color: var(--accent); }

    .qr-wrap { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; }
    .qr {
      width: 280px;
      height: 280px;
      border-radius: 16px;
      border: 1px solid #dce7ee;
      background: #fff;
      object-fit: cover;
    }
    .caption { font-size: 12px; color: var(--muted); text-align: center; }

    .methods { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 16px; }
    .method {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 10px 12px;
      background: #fff;
      cursor: pointer;
      text-align: left;
      transition: transform .12s ease, border-color .12s ease, background .12s ease;
    }
    .method:hover { transform: translateY(-1px); border-color: #9fc8c5; }
    .method.active { border-color: #0f766e; background: #effcf8; }
    .method b { display: block; font-size: 12px; margin-bottom: 4px; letter-spacing: 0.03em; }
    .method span { display: block; font-size: 11px; color: var(--muted); line-height: 1.4; }

    .detail {
      margin-top: 12px;
      border: 1px dashed #c6d6df;
      border-radius: 12px;
      padding: 12px;
      background: #fbfdff;
      font-size: 13px;
      color: #384956;
      min-height: 72px;
      line-height: 1.5;
    }

    .controls {
      margin-top: 18px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .btn {
      border: 0;
      border-radius: 14px;
      padding: 14px 16px;
      font-weight: 800;
      font-size: 13px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      cursor: pointer;
      transition: transform .12s ease, opacity .12s ease;
    }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .btn:hover:not(:disabled) { transform: translateY(-1px); }
    .btn.success { background: #0f8f49; color: #fff; }
    .btn.fail { background: #b42318; color: #fff; }

    .status {
      margin-top: 12px;
      font-size: 13px;
      border-radius: 12px;
      padding: 10px 12px;
      border: 1px solid #d7e3ea;
      background: #fff;
      color: #334155;
      min-height: 40px;
    }
    .status.good { border-color: #9dd9b8; background: #f1fcf5; color: #166534; }
    .status.bad { border-color: #f3b3af; background: #fff4f3; color: #991b1b; }

    .warn {
      margin-top: 12px;
      border: 1px solid #f6c3b8;
      background: #fff3f0;
      color: #9f1f10;
      border-radius: 12px;
      padding: 10px 12px;
      font-size: 12px;
      line-height: 1.45;
    }

    @media (max-width: 980px) {
      .hero { grid-template-columns: 1fr; }
      .methods { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .qr { width: 240px; height: 240px; }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="hero">
      <section class="panel">
        <h1>Simulated Payment Merchant</h1>
        <p class="sub">Use this page for testing only. Choose a payment method preview, then press success or not success.</p>
        <div class="amount">${escapeHtml(currency)} ${escapeHtml(amount)}</div>
        <div class="meta">
          <div><b>Merchant</b><span>${escapeHtml(merchant)}</span></div>
          <div><b>Invoice</b><span>${escapeHtml(invoice)}</span></div>
          <div><b>Reference</b><span>${escapeHtml(reference)}</span></div>
          <div><b>Phone</b><span>${escapeHtml(phone || '-')}</span></div>
        </div>

        <div class="methods" id="methodGrid">
          <button class="method active" data-method="qr"><b>QR</b><span>Scan for instant payment simulation</span></button>
          <button class="method" data-method="card"><b>Card</b><span>Visa / Mastercard simulation</span></button>
          <button class="method" data-method="ewallet"><b>E-Wallet</b><span>TNG / GrabPay / ShopeePay style flow</span></button>
          <button class="method" data-method="bank"><b>Bank Transfer</b><span>Virtual account and FPX simulation</span></button>
        </div>
        <div class="detail" id="methodDetail"></div>

        ${missingMessage ? `<div class="warn">${escapeHtml(missingMessage)}</div>` : ''}

        <div class="controls">
          <button id="btnSuccess" class="btn success">Payment Success</button>
          <button id="btnFail" class="btn fail">Payment Not Success</button>
        </div>
        <div id="statusLine" class="status">Waiting for your action.</div>
      </section>

      <section class="panel qr-wrap">
        <img class="qr" src="${qrImageUrl}" alt="Simulated payment QR code" />
        <div class="caption">QR payload is simulated for testing. No real transaction is processed.</div>
      </section>
    </div>
  </div>

  <script>
    const cfg = ${cfgJson};
    const statusLine = document.getElementById('statusLine');
    const btnSuccess = document.getElementById('btnSuccess');
    const btnFail = document.getElementById('btnFail');
    const methodGrid = document.getElementById('methodGrid');
    const methodDetail = document.getElementById('methodDetail');

    const methodCopy = {
      qr: 'QR simulation mode: customer scans QR and confirms inside banking app.',
      card: 'Card simulation mode: enter card, expiry, CVV and complete 3DS challenge.',
      ewallet: 'E-wallet simulation mode: redirect to wallet app, approve, and return.',
      bank: 'Bank transfer simulation mode: customer pays via FPX/VA and callback updates status.'
    };

    function setStatus(text, type) {
      statusLine.textContent = text;
      statusLine.classList.remove('good', 'bad');
      if (type === 'good') statusLine.classList.add('good');
      if (type === 'bad') statusLine.classList.add('bad');
    }

    function setBusy(busy) {
      btnSuccess.disabled = busy;
      btnFail.disabled = busy;
      btnSuccess.textContent = busy ? 'Processing...' : 'Payment Success';
      btnFail.textContent = busy ? 'Processing...' : 'Payment Not Success';
    }

    function updateMethod(method) {
      const nodes = Array.from(methodGrid.querySelectorAll('.method'));
      nodes.forEach((node) => node.classList.toggle('active', node.dataset.method === method));
      methodDetail.textContent = methodCopy[method] || methodCopy.qr;
    }

    function getRedirectTargets(status) {
      if (status === 'payment_success') {
        return {
          primary: cfg.returnSuccessUrl || cfg.returnUrl || '',
          fallback: cfg.returnSuccessFallback || cfg.returnFallback || ''
        };
      }
      return {
        primary: cfg.returnFailUrl || cfg.returnUrl || '',
        fallback: cfg.returnFailFallback || cfg.returnFallback || ''
      };
    }

    function navigateTo(url) {
      if (!url) return false;
      try {
        window.location.assign(url);
        return true;
      } catch {
        return false;
      }
    }

    function redirectAfterUpdate(status) {
      const targets = getRedirectTargets(status);
      const primary = typeof targets.primary === 'string' ? targets.primary : '';
      const fallback = typeof targets.fallback === 'string' ? targets.fallback : '';
      const delay = Number(cfg.redirectFallbackDelayMs);
      const fallbackDelayMs = Number.isFinite(delay) ? Math.max(300, delay) : 850;
      if (!primary && !fallback) return;

      setStatus('Update sent. Redirecting back to WhatsApp...', 'good');
      if (fallback) {
        setTimeout(() => {
          if (document.visibilityState === 'visible') {
            navigateTo(fallback);
          }
        }, fallbackDelayMs);
      }

      if (!navigateTo(primary) && fallback) {
        navigateTo(fallback);
      }
    }

    methodGrid.addEventListener('click', (event) => {
      const btn = event.target && event.target.closest ? event.target.closest('.method') : null;
      if (!btn) return;
      updateMethod(btn.dataset.method || 'qr');
    });

    updateMethod('qr');

    async function submit(status) {
      if (!cfg.profileId || !cfg.phone) {
        setStatus('Missing profileId or phone. Cannot notify workflow.', 'bad');
        return;
      }
      setBusy(true);
      setStatus('Sending update to automation component...', '');
      try {
        const response = await fetch('/api/simulated-payment/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            profileId: cfg.profileId,
            phone: cfg.phone,
            status,
            reference: cfg.reference,
            invoice: cfg.invoice,
            merchant: cfg.merchant,
            amount: cfg.amount,
            currency: cfg.currency
          })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data?.success === false) {
          throw new Error(data?.error || 'Failed to update simulated payment status');
        }
        redirectAfterUpdate(status);
      } catch (error) {
        const message = error && error.message ? error.message : String(error || 'Unknown error');
        setStatus(message, 'bad');
      } finally {
        setBusy(false);
      }
    }

    btnSuccess.addEventListener('click', () => submit('payment_success'));
    btnFail.addEventListener('click', () => submit('payment_not_success'));
  </script>
</body>
</html>`

    res.setHeader('content-type', 'text/html; charset=utf-8')
    return res.send(html)
})

app.post('/api/simulated-payment/update', async (req: any, res: any) => {
    try {
        const profileId = typeof req.body?.profileId === 'string' ? req.body.profileId.trim() : ''
        const phoneRaw = typeof req.body?.phone === 'string' ? req.body.phone : ''
        const phoneNumber = normalizePhoneNumber(phoneRaw)
        const status = normalizeSimulatedPaymentStatus(req.body?.status)

        if (!profileId) {
            return res.status(400).json({ success: false, error: 'profileId is required' })
        }
        if (!phoneNumber) {
            return res.status(400).json({ success: false, error: 'phone is required' })
        }
        if (!status) {
            return res.status(400).json({ success: false, error: 'status must be payment_success or payment_not_success' })
        }

        const companyId = await getCompanyIdForProfile(profileId)
        if (!companyId) {
            return res.status(404).json({ success: false, error: 'Company not found for profile' })
        }

        const client = await wabaRegistry.getClientByProfile(profileId)
        if (!client) {
            return res.status(503).json({ success: false, error: 'WABA client not available for profile' })
        }

        const result = await workflowEngine.processInbound({
            companyId,
            profileId,
            client,
            phoneNumber,
            messageType: 'button',
            text: status,
            buttonId: status,
            buttonTitle: status === 'payment_success' ? 'Payment Success' : 'Payment Not Success',
            raw: {
                source: 'simulated-payment-web',
                simulated_payment: true,
                status,
                invoice: req.body?.invoice || null,
                reference: req.body?.reference || null,
                merchant: req.body?.merchant || null,
                amount: req.body?.amount || null,
                currency: req.body?.currency || null
            }
        })

        if (result?.error) {
            return res.status(500).json({
                success: false,
                error: result.error,
                handled: result.handled,
                replied: result.replied
            })
        }

        return res.json({
            success: true,
            handled: Boolean(result?.handled),
            replied: Boolean(result?.replied),
            status
        })
    } catch (error: any) {
        return res.status(500).json({ success: false, error: error?.message || 'Failed to update simulated payment status' })
    }
})

function buildChatJid(target: string | null | undefined, preferGroup = false) {
    const normalized = normalizePhoneNumber(target)
    if (!normalized) return ''
    if (preferGroup || isGroupIdentifier(target || normalized)) {
        return `${normalized}@g.us`
    }
    return `${normalized}@s.whatsapp.net`
}

function buildSyntheticMessage(inbound: WabaInboundMessage) {
    const from = normalizePhoneNumber(inbound.from || '')
    const groupId = normalizePhoneNumber(inbound.groupId || '')
    const remoteJid = groupId ? buildChatJid(groupId, true) : buildChatJid(from)
    const timestamp = inbound.timestamp ? Number(inbound.timestamp) : Math.floor(Date.now() / 1000)

    let text = inbound.text?.body || ''
    if (inbound.buttonReplyTitle && !text) {
        text = inbound.buttonReplyTitle
    }
    if (inbound.type === 'request_welcome' && !text) {
        text = 'request_welcome'
    }

    const message: any = {}

    if (inbound.type === 'text' || inbound.type === 'interactive' || inbound.type === 'button' || inbound.type === 'request_welcome') {
        message.conversation = text
    } else if (inbound.type === 'image') {
        message.imageMessage = {
            mimetype: inbound.image?.mime_type,
            caption: inbound.image?.caption,
            mediaId: inbound.image?.id
        }
    } else if (inbound.type === 'document') {
        message.documentMessage = {
            mimetype: inbound.document?.mime_type,
            fileName: inbound.document?.filename,
            fileLength: inbound.document?.file_size,
            caption: inbound.document?.caption,
            mediaId: inbound.document?.id
        }
    } else if (inbound.type === 'audio') {
        message.audioMessage = {
            mimetype: inbound.audio?.mime_type,
            mediaId: inbound.audio?.id
        }
    } else if (inbound.type === 'video') {
        message.videoMessage = {
            mimetype: inbound.video?.mime_type,
            caption: inbound.video?.caption,
            mediaId: inbound.video?.id
        }
    }

    const syntheticMsg = {
        key: {
            remoteJid,
            fromMe: false,
            id: inbound.id,
            ...(groupId && from ? { participant: buildChatJid(from) } : {})
        },
        messageTimestamp: timestamp,
        pushName: inbound.contactName,
        message
    }

    return { syntheticMsg, remoteJid, text }
}

async function recordToSyntheticMessage(
    record: MessageRecord,
    userMap: Map<string, { phone: string; name?: string | null }>,
    companyId?: string
) {
    const info = userMap.get(record.user_id)
    const cleanPhone = normalizePhoneNumber(info?.phone || '')
    if (!cleanPhone) return null

    const remoteJid = buildChatJid(cleanPhone, isGroupIdentifier(info?.phone || cleanPhone))
    const timestamp = Math.floor(new Date(record.created_at).getTime() / 1000)
    const content = record.content || {}
    const type = content.type || content.payload?.type || 'text'
    const mediaAssetKey =
        typeof content.media_asset_key === 'string' && content.media_asset_key.trim()
            ? content.media_asset_key.trim()
            : typeof content.payload?.media?.assetKey === 'string'
                ? content.payload.media.assetKey.trim()
                : ''
    let signedMediaUrl = ''
    if (
        mediaAssetKey
        && companyId
        && (type === 'image' || type === 'video' || type === 'document')
        && isR2Configured()
    ) {
        try {
            signedMediaUrl = await createDownloadUrl({
                companyId,
                assetKey: mediaAssetKey
            })
        } catch {
            signedMediaUrl = ''
        }
    }

    const message: any = {}

    if (type === 'text') {
        message.conversation = content.text || content.payload?.text || ''
        if (!message.conversation && content.payload?.template?.name) {
            message.conversation = `Template: ${content.payload.template.name}`
        }
    } else if (type === 'buttons') {
        const payload = content.payload || {}
        const text = payload.text || content.text || ''
        message.conversation = text
        if (!message.conversation && payload.template?.name) {
            message.conversation = `Template: ${payload.template.name}`
        }
        const buttons = Array.isArray(payload.buttons) ? payload.buttons : []
        message.buttonsMessage = {
            contentText: text,
            footerText: payload.footer || payload.footerText || undefined,
            buttons: buttons.map((button: any, idx: number) => ({
                buttonId: button?.id || button?.buttonId || `button_${idx + 1}`,
                buttonText: { displayText: button?.title || button?.text || button?.id || `Button ${idx + 1}` },
                type: 1
            }))
        }
    } else if (type === 'list') {
        const payload = content.payload || {}
        const description = payload.text || payload.body || content.text || ''
        message.conversation = description
        if (!message.conversation && payload.template?.name) {
            message.conversation = `Template: ${payload.template.name}`
        }
        const sections = Array.isArray(payload.sections) ? payload.sections : []
        message.listMessage = {
            title: payload.header?.text || payload.headerText || undefined,
            description,
            buttonText: payload.button_text || payload.buttonText || payload.button || '',
            footerText: payload.footer || payload.footerText || undefined,
            listType: 1,
            sections: sections.map((section: any, sectionIdx: number) => ({
                title: section?.title || undefined,
                rows: (Array.isArray(section?.rows) ? section.rows : []).map((row: any, rowIdx: number) => ({
                    rowId: row?.id || row?.rowId || `row_${sectionIdx}_${rowIdx}`,
                    title: row?.title || row?.id || `Option ${rowIdx + 1}`,
                    description: row?.description || undefined
                }))
            }))
        }
    } else if (type === 'image') {
        message.imageMessage = {
            caption: content.caption,
            mediaId: content.media_id,
            assetKey: mediaAssetKey || undefined,
            url: signedMediaUrl || content.image_url || content.payload?.media?.link || content.payload?.image_url
        }
    } else if (type === 'document') {
        message.documentMessage = {
            caption: content.caption,
            fileName: content.filename || content.payload?.media?.filename,
            fileLength: content.file_size,
            mediaId: content.media_id,
            mimetype: content.mimetype || content.payload?.mimetype,
            assetKey: mediaAssetKey || undefined,
            url: signedMediaUrl || content.document_url || content.payload?.media?.link || content.payload?.document_url
        }
    } else if (type === 'audio') {
        message.audioMessage = {
            mediaId: content.media_id
        }
    } else if (type === 'video') {
        message.videoMessage = {
            caption: content.caption,
            mediaId: content.media_id,
            assetKey: mediaAssetKey || undefined,
            url: signedMediaUrl || content.video_url || content.payload?.media?.link || content.payload?.video_url
        }
    } else {
        message.conversation = content.text || type
    }

    return {
        profileId: typeof record?.profile_id === 'string' && record.profile_id.trim() ? record.profile_id.trim() : null,
        key: {
            remoteJid,
            fromMe: record.direction === 'out',
            id: content.message_id || record.id
        },
        status: content.status,
        messageTimestamp: timestamp,
        pushName: info?.name || cleanPhone,
        message,
        agent: content.agent || content.payload?.agent || null,
        workflowState: record.workflow_state || null
    }
}

function isAiAutoReplyInboundType(type: string) {
    const normalized = (type || '').toLowerCase()
    return normalized === 'text' || normalized === 'interactive' || normalized === 'button' || normalized === 'request_welcome'
}

function decryptAiApiKey(storedValue: string | null | undefined): string {
    if (!storedValue) return ''
    if (!storedValue.startsWith('enc:v1:')) return storedValue
    try {
        return decryptToken(storedValue)
    } catch {
        return ''
    }
}

async function maybeSendAutoAiReply(params: {
    companyId: string
    profileId: string
    client: any
    user: WaStoreUser | null
    phoneNumber: string
    inboundType: string
    inboundText: string
    workflowHandled: boolean
}): Promise<{ sent: boolean; reason?: string }> {
    if (params.workflowHandled) return { sent: false, reason: 'workflow_handled' }
    if (!params.user) return { sent: false, reason: 'missing_user' }
    if (hasHumanTakeover(params.user)) return { sent: false, reason: 'human_takeover' }
    if (!isAiAutoReplyInboundType(params.inboundType)) return { sent: false, reason: 'unsupported_inbound_type' }

    const inboundText = (params.inboundText || '').trim()
    if (!inboundText) return { sent: false, reason: 'empty_inbound_text' }

    const settings = await getCompanyAiSettings(supabase, params.companyId)
    if (!settings.enabled) return { sent: false, reason: 'ai_disabled' }

    const apiKey = decryptAiApiKey(settings.api_key)
    if (!apiKey) return { sent: false, reason: 'missing_api_key' }

    const memoryMessages = settings.memory_enabled
        ? await loadOpenAiMemoryForUser(supabase, params.user.id, settings.memory_messages)
        : []

    const promptMessages: OpenAiChatMessage[] = []
    const systemPrompt = (settings.system_prompt || '').trim()
    if (systemPrompt) {
        promptMessages.push({
            role: 'system',
            content: systemPrompt
        })
    }
    promptMessages.push(...memoryMessages)

    const lastMemoryMessage = promptMessages[promptMessages.length - 1]
    const duplicateUserInput =
        lastMemoryMessage?.role === 'user' &&
        typeof lastMemoryMessage.content === 'string' &&
        lastMemoryMessage.content.trim() === inboundText

    if (!duplicateUserInput) {
        promptMessages.push({
            role: 'user',
            content: inboundText
        })
    }

    const completion = await requestOpenAiCompletion({
        apiKey,
        model: settings.model,
        temperature: settings.temperature,
        maxTokens: settings.max_tokens,
        messages: promptMessages,
        timeoutMs: 45000
    })

    const reply = (completion.reply || '').trim()
    if (!reply) {
        return { sent: false, reason: 'empty_ai_reply' }
    }

    await sendWhatsAppMessage({
        client: params.client,
        userId: params.user.id,
        profileId: params.profileId,
        to: params.phoneNumber,
        type: 'text',
        content: {
            text: reply
        },
        workflowState: null
    })

    return { sent: true }
}

async function handleInboundMessage(config: WabaConfig, inbound: WabaInboundMessage) {
    const { syntheticMsg, remoteJid, text } = buildSyntheticMessage(inbound)
    const profileId = config.profileId
    const companyId = await getCompanyIdForProfile(profileId)
    const phoneNumber = normalizePhoneNumber(remoteJid)
    const isGroupMessage = Boolean(inbound.groupId || remoteJid.endsWith('@g.us'))
    const inboundSource = readTrimmed((inbound.raw as any)?.source).toLowerCase()
    const isGymShowcaseSource = inboundSource === GYM_SHOWCASE_SOURCE
    const isSimulatedInbound = Boolean((inbound.raw as any)?.simulated) || inboundSource === 'simulated-payment-web'

    const client = await wabaRegistry.getClientByProfile(profileId)
    if (!client || !companyId) {
        console.warn(`[${profileId}] Missing WABA client or companyId.`)
        return
    }

    const baseUser = await findOrCreateUser(companyId, phoneNumber, profileId)
    const humanTakeoverActive = hasHumanTakeover(baseUser)

    const workflowResult = await workflowEngine.processInbound({
        companyId,
        profileId,
        client,
        phoneNumber,
        messageId: inbound.id,
        automationDisabled: humanTakeoverActive || isGroupMessage,
        messageType: inbound.type,
        text,
        buttonId: inbound.buttonReplyId,
        buttonTitle: inbound.buttonReplyTitle,
        media: inbound.image || inbound.document || inbound.audio || inbound.video,
        raw: toMinimalInboundRaw(inbound)
    })

    const user = (await getUserByPhone(companyId, phoneNumber, profileId)) || baseUser
    if (user && inbound.contactName && !isGroupMessage) {
        const trimmedName = inbound.contactName.trim()
        const nameDigits = trimmedName.replace(/\D/g, '')
        const looksLikePhone = nameDigits.length >= 6 && nameDigits === phoneNumber
        if (!looksLikePhone && trimmedName && trimmedName !== user.name) {
            await updateUserName(user.id, trimmedName)
            user.name = trimmedName
        }
    }

    let profileUnreadCount: number | null = null
    try {
        const { data: profile } = await supabase
            .from('profiles')
            .select('id, unreadCount')
            .eq('id', profileId)
            .maybeSingle()

        if (profile) {
            const newCount = (profile.unreadCount || 0) + 1
            const { error: updateUnreadError } = await supabase
                .from('profiles')
                .update({ unreadCount: newCount })
                .eq('id', profileId)

            if (updateUnreadError) {
                console.warn(`[${profileId}] Failed to update profile unread count:`, updateUnreadError.message)
            } else {
                profileUnreadCount = newCount
            }
        }
    } catch (error: any) {
        console.warn(`[${profileId}] Profile unread update skipped:`, error?.message || error)
    }

    if (typeof profileUnreadCount === 'number') {
        io.to(getCompanyRoom(companyId)).emit('profile.unread', { profileId, unreadCount: profileUnreadCount })
    }

    if (workflowResult?.error) {
        io.to(getCompanyRoom(companyId)).emit('profile.error', { message: `Workflow error: ${workflowResult.error}` })
    }

    if (
        !workflowResult?.error &&
        workflowResult?.completedWorkflowId === GYM_SHOWCASE_WORKFLOW_ID &&
        !isGroupMessage &&
        !isGymShowcaseSource
    ) {
        const modeConfig = getAdsShootModeProfileConfig(companyId, profileId)
        if (modeConfig.enabled) {
            void runGymShowcaseBoost(config, companyId, phoneNumber)
                .then((result) => {
                    if (result.error) {
                        console.log(`[GymShowcase] ${profileId}: skipped (${result.error}).`)
                        return
                    }
                    console.log(`[GymShowcase] ${profileId}: injected ${result.sent} simulated workflow messages.`)
                })
                .catch((error: any) => {
                    console.warn('[GymShowcase] Failed to run boost:', error?.message || error)
                })
        }
    }

    if (user && !isSimulatedInbound) {
        try {
            const aiResult = await maybeSendAutoAiReply({
                companyId,
                profileId,
                client,
                user,
                phoneNumber,
                inboundType: inbound.type,
                inboundText: text || '',
                workflowHandled: isGroupMessage || Boolean(workflowResult?.handled && workflowResult?.replied)
            })
            if (aiResult.sent) {
                console.log(`[${profileId}] Auto AI reply sent to ${phoneNumber}`)
            } else if (aiResult.reason) {
                console.log(`[${profileId}] Auto AI skipped (${aiResult.reason}) for ${phoneNumber}`)
            }
        } catch (error: any) {
            console.warn(`[${profileId}] Auto AI reply skipped:`, error?.message || error)
        }
    }

    const inboundAt = inbound.timestamp ? new Date(Number(inbound.timestamp) * 1000).toISOString() : null
    const contact = user
        ? {
            ...buildContactPayload(user),
            id: remoteJid,
            lastInboundAt: inboundAt
        }
        : {
            id: remoteJid,
            name: isGroupMessage ? `Group ${phoneNumber}` : (inbound.contactName || phoneNumber),
            alias: null,
            whatsappName: isGroupMessage ? null : (inbound.contactName || null),
            lastInboundAt: inboundAt,
            tags: [],
            assigneeUserId: null,
            assigneeName: null,
            assigneeColor: null,
            ctaReferralAt: null,
            ctaFreeWindowStartedAt: null,
            ctaFreeWindowExpiresAt: null
        }
    io.to(getCompanyRoom(companyId)).emit('contacts.update', {
        profileId,
        contacts: [contact]
    })

    const buttonReply = inbound.buttonReplyId
        ? {
            id: inbound.buttonReplyId,
            title: inbound.buttonReplyTitle,
            description: inbound.buttonReplyDescription
        }
        : null

    webhookStore.send(profileId, 'message', {
        message: syntheticMsg,
        sender: {
            jid: remoteJid,
            name: inbound.contactName || null
        },
        group_id: inbound.groupId || null,
        participant_wa_id: inbound.from || null,
        referral: inbound.referral || null,
        button_reply: buttonReply,
        interactive: inbound.interactive || null,
        raw: INCLUDE_RAW_WEBHOOK_EVENT_PAYLOAD ? inbound.raw : null
    })

    addon.webhookService.trigger(profileId, 'message_received', {
        messageId: inbound.id,
        from: remoteJid,
        groupId: inbound.groupId || null,
        participantWaId: inbound.from || null,
        message: text || inbound.type,
        type: inbound.type,
        timestamp: inbound.timestamp,
        pushName: inbound.contactName,
        referral: inbound.referral || null,
        button_reply: buttonReply,
        interactive: inbound.interactive || null,
        raw: INCLUDE_RAW_WEBHOOK_EVENT_PAYLOAD ? inbound.raw : null
    })

    io.to(getCompanyRoom(companyId)).emit('messages.upsert', {
        profileId,
        messages: [syntheticMsg],
        type: 'notify'
    })

    const notificationRecipientUserIds = await getCompanyRecipientUserIdsForPush(companyId)
    const backgroundNotificationRecipientUserIds = selectBackgroundPushUserIds(notificationRecipientUserIds)
    const notificationPreview = getInboundNotificationPreview(inbound, text)
    const inboundDedupId = readTrimmed(inbound.id)
        || `${remoteJid}:${readTrimmed(inbound.timestamp)}:${notificationPreview.slice(0, 48)}`
    const inboundPushDedupKey = `${companyId}:${profileId}:${inboundDedupId}`
    const skipPushDispatch = shouldSkipInboundPushDispatch(inboundPushDedupKey)
    const senderName =
        (contact && typeof contact.name === 'string' && contact.name.trim())
        || (typeof inbound.contactName === 'string' && inbound.contactName.trim())
        || (isGroupMessage ? `Group ${phoneNumber}` : phoneNumber)
        || 'New message'

    if (skipPushDispatch) {
        console.log(`[push] Skipping duplicate inbound push for key=${inboundPushDedupKey}`)
    } else {
        void sendPushNotificationToUsers({
            companyId,
            userIds: notificationRecipientUserIds,
            title: senderName,
            body: notificationPreview,
            url: `/?chat=${encodeURIComponent(remoteJid)}`,
            tag: `chat:${remoteJid}`,
            data: {
                profileId,
                chat: remoteJid
            },
            ttlSeconds: 120
        })

        void sendNativePushNotificationToUsers({
            companyId,
            userIds: backgroundNotificationRecipientUserIds,
            title: senderName,
            body: notificationPreview,
            url: `/?chat=${encodeURIComponent(remoteJid)}`,
            tag: `chat:${remoteJid}:${inboundDedupId}`,
            data: {
                profileId,
                chat: remoteJid,
                messageId: inboundDedupId
            },
            ttlSeconds: 120
        })
    }
}

async function handleStatusUpdate(config: WabaConfig, status: WabaStatus) {
    const profileId = config.profileId
    const companyId = await getCompanyIdForProfile(profileId)
    const statusName = status.status
    let eventName: string | null = null

    if (statusName === 'delivered') eventName = 'message_delivered'
    else if (statusName === 'read') eventName = 'message_read'
    else if (statusName === 'sent') eventName = 'message_sent'
    else if (statusName === 'failed') eventName = 'message_failed'

    if (!eventName) return

    const recipientParticipantId = status.recipientParticipantId || status.participantRecipientId || null
    const updatedMessage = await updateMessageStatusByMessageId(status.id, statusName, {
        timestamp: status.timestamp,
        recipientId: status.recipientId,
        recipientType: status.recipientType,
        recipientParticipantId: status.recipientParticipantId,
        participantRecipientId: status.participantRecipientId,
        conversation: status.conversation,
        pricing: status.pricing
    }, profileId)

    if (statusName === 'delivered' && updatedMessage?.content?.cta_entry_candidate) {
        const deliveredAt = status.timestamp
            ? new Date(Number(status.timestamp) * 1000).toISOString()
            : new Date().toISOString()
        await activateUserCtaFreeWindow(updatedMessage.user_id, deliveredAt)
    }

    const { data: profile } = await supabase
        .from('profiles')
        .select('user_id')
        .eq('id', profileId)
        .maybeSingle()

    if (profile?.user_id && companyId) {
        const room = getCompanyRoom(companyId)
        io.to(room).emit('message.status', {
            profileId,
            messageId: status.id,
            status: statusName,
            recipientId: status.recipientId || null,
            recipientType: status.recipientType || null,
            recipientParticipantId
        })

        if (statusName === 'delivered' && updatedMessage?.user_id) {
            const user = await getUserById(updatedMessage.user_id)
            if (user) {
                const contact = buildContactPayload(user)
                io.to(room).emit('contacts.update', {
                    profileId,
                    contacts: [contact]
                })
            }
        }
    }

    addon.webhookService.trigger(profileId, eventName, {
        messageId: status.id,
        to: status.recipientId,
        recipientType: status.recipientType || null,
        recipientParticipantId,
        status: statusName,
        timestamp: status.timestamp,
        conversation: status.conversation,
        pricing: status.pricing
    })
}

async function handleCallUpdate(config: WabaConfig, call: WabaCallUpdate) {
    const profileId = config.profileId
    const companyId = await getCompanyIdForProfile(profileId)
    if (!companyId) return

    const room = getCompanyRoom(companyId)
    const eventName = readTrimmed(call.event).toLowerCase()
    const payload = {
        profileId,
        callId: call.id,
        event: eventName || call.event || 'unknown',
        phoneNumberId: call.phoneNumberId,
        from: call.from || null,
        to: call.to || null,
        direction: call.direction || null,
        timestamp: call.timestamp || 0,
        status: Array.isArray(call.status) ? call.status : [],
        startTime: call.startTime || null,
        endTime: call.endTime || null,
        duration: call.duration ?? null,
        deeplinkPayload: call.deeplinkPayload || null,
        ctaPayload: call.ctaPayload || null,
        bizOpaqueCallbackData: call.bizOpaqueCallbackData || null,
        session: call.session || null,
        contactName: call.contactName || null,
        errors: Array.isArray(call.errors) ? call.errors : [],
        raw: INCLUDE_RAW_WEBHOOK_EVENT_PAYLOAD ? call.raw : null
    }

    io.to(room).emit('calls.update', payload)

    const statusSummary = payload.status.length > 0 ? ` [${payload.status.join(', ')}]` : ''
    console.log(
        `[${profileId}] [Calls] ${payload.event.toUpperCase()} id=${payload.callId} from=${payload.from || '-'} to=${payload.to || '-'}${statusSummary}`
    )

    webhookStore.send(profileId, 'call', payload)

    addon.webhookService.trigger(profileId, `call_${payload.event}`, payload)
}

registerSocketHandlers(io, {
    supabase,
    supabaseAuth,
    systemRuntimeStatus,
    getHostnameFromHeaders,
    resolveCompanyIdFromHostname,
    normalizeCompanyId,
    getUserCompanyId,
    ensureUserCompanyId,
    getCompanyRoom,
    lastServerStats,
    ensureCompanyRecord,
    wabaRegistry,
    getCompanyIdForProfile,
    getUsersForCompany,
    buildContactPayload,
    getMessagesForUsers,
    getMessagesForUsersSince,
    normalizePhoneNumber,
    recordToSyntheticMessage,
    findOrCreateUser,
    setUserAlias,
    setUserTags,
    setUserHumanTakeover,
    getUserByPhone,
    readTrimmed,
    deriveAgentName,
    computeAgentColor,
    setUserAssignee,
    fs,
    resolvePath,
    assignUserToAgentIfUnassigned,
    buildAgentIdentity,
    setUserTemplateAttributes,
    sendWhatsAppMessage,
    workflowEngine,
    resolveCompanyId,
    hasRoleAtLeast,
    normalizeTeamRole,
    deleteMessagesForUser,
    deleteUserById,
    sendPushNotificationToUsers,
    sendNativePushNotificationToUsers
})

app.use(errorHandler)

// Serve Frontend (Deployment Support)
const frontendPath = path.join(process.cwd(), 'dashboard/dist')
if (fs.existsSync(frontendPath)) {
    console.log('Serving frontend from:', frontendPath)
    const assetsPath = path.join(frontendPath, 'assets')
    if (fs.existsSync(assetsPath)) {
        app.use('/assets', express.static(assetsPath, {
            fallthrough: false,
            immutable: true,
            maxAge: '1y'
        }))
    }
    app.use(express.static(frontendPath, {
        index: false,
        setHeaders: (res, filePath) => {
            const baseName = path.basename(filePath || '').toLowerCase()
            if (baseName === 'sw.js') {
                res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
                res.setHeader('Pragma', 'no-cache')
                res.setHeader('Expires', '0')
            }
            if (filePath.endsWith('.html')) {
                res.setHeader('Cache-Control', 'no-cache')
            }
        }
    }))
    // Express 5 + path-to-regexp v6: use regex fallback instead of '*' patterns.
    // Do not fallback requests that look like static files (e.g. *.js, *.css).
    app.get(/^(?!\/api|\/addon|\/socket\.io|\/assets\/).*/, (req: any, res: any) => {
        if (path.extname(req.path || '')) {
            return res.status(404).send('Not Found')
        }
        res.setHeader('Cache-Control', 'no-cache')
        res.sendFile(path.join(frontendPath, 'index.html'))
    })
}

const PORT = Number(process.env.PORT || 3000)
httpServer.listen(PORT, async () => {
    console.log(`Dashboard Server listening on port ${PORT}`)

    const activeProfiles = await wabaRegistry.getProfileIds()
    console.log(`[WABA] Loaded configs for ${activeProfiles.length} profile(s).`)
})
