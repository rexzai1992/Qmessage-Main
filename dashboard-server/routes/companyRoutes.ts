import type { Express } from 'express'
import {
    assertCompanyAssetKey,
    createDownloadUrl,
    createUploadUrl,
    getMaxUploadBytes,
    isAllowedMimeType,
    isR2Configured,
    normalizeMediaMessageType,
    normalizeUploadPurpose
} from '../../src/services/r2-storage'

const UI_FEATURE_KEYS = new Set([
    'team-inbox',
    'automations',
    'broadcast',
    'chatbots',
    'contacts',
    'calls',
    'analytics',
    'settings'
])

const UI_HIDDEN_FEATURES_MISSING_MESSAGE =
    'UI controls are not initialized. Run migration 20260407_company_ui_hidden_features.sql.'
const QUICK_REPLIES_MEDIA_MISSING_MESSAGE =
    'Quick reply media fields are not initialized. Run migrations 20260408_quick_replies_media_support.sql, 20260408_quick_replies_r2_storage.sql, and 20260414_quick_replies_multi_media.sql.'
const APP_LOGO_FIELDS_MISSING_MESSAGE =
    'App logo fields are not initialized. Run migration 20260408_company_app_logo_storage.sql.'
const DEFAULT_APP_LOGO_MAX_BYTES = 2 * 1024 * 1024

function parsePositiveInt(value: unknown, fallback: number): number {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    const normalized = Math.floor(parsed)
    if (normalized <= 0) return fallback
    return normalized
}

function getAppLogoMaxBytes(): number {
    const configured = parsePositiveInt(process.env.APP_LOGO_MAX_BYTES, DEFAULT_APP_LOGO_MAX_BYTES)
    const imageMax = getMaxUploadBytes('image')
    if (imageMax > 0) return Math.min(configured, imageMax)
    return configured
}

function normalizeAppLogoStorage(value: unknown): 'none' | 'r2' {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
    if (normalized === 'r2') return 'r2'
    return 'none'
}

function normalizeAppLogoAssetKey(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

function normalizeAppLogoMimeType(value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function normalizeAppLogoFilename(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

function normalizeAppLogoSizeBytes(value: unknown): number | null {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return null
    const normalized = Math.max(0, Math.floor(parsed))
    return normalized || null
}

function normalizeUiFeatureKey(value: unknown): string {
    if (typeof value !== 'string') return ''
    const normalized = value.trim().toLowerCase().replace(/\s+/g, '-')
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

function isQuickRepliesMediaColumnsMissingError(error: any): boolean {
    const code = typeof error?.code === 'string' ? error.code.trim().toUpperCase() : ''
    const message = String(error?.message || '').toLowerCase()
    if (code !== '42703') return false
    return (
        message.includes('message_type')
        || message.includes('media_url')
        || message.includes('media_filename')
        || message.includes('media_storage')
        || message.includes('media_asset_key')
        || message.includes('media_mime_type')
        || message.includes('media_size_bytes')
        || message.includes('media_items')
    )
}

function isAppLogoFieldsMissingError(error: any): boolean {
    const code = typeof error?.code === 'string' ? error.code.trim().toUpperCase() : ''
    const message = String(error?.message || '').toLowerCase()
    if (code !== '42703') return false
    return (
        message.includes('app_logo_storage')
        || message.includes('app_logo_asset_key')
        || message.includes('app_logo_mime_type')
        || message.includes('app_logo_size_bytes')
        || message.includes('app_logo_filename')
    )
}

async function serializeCompanyAppLogo(companyId: string, row: any): Promise<{
    logo_storage: 'none' | 'r2'
    logo_asset_key: string | null
    logo_mime_type: string | null
    logo_size_bytes: number | null
    logo_filename: string | null
    logo_url: string | null
    logo_max_bytes: number
}> {
    const logoStorage = normalizeAppLogoStorage(row?.app_logo_storage)
    const logoAssetKeyRaw = normalizeAppLogoAssetKey(row?.app_logo_asset_key)
    const logoMimeType = normalizeAppLogoMimeType(row?.app_logo_mime_type)
    const logoSizeBytes = normalizeAppLogoSizeBytes(row?.app_logo_size_bytes)
    const logoFilename = normalizeAppLogoFilename(row?.app_logo_filename)
    let logoAssetKey = ''
    if (logoStorage === 'r2' && logoAssetKeyRaw) {
        try {
            logoAssetKey = assertCompanyAssetKey(companyId, logoAssetKeyRaw)
        } catch {
            logoAssetKey = ''
        }
    }

    let logoUrl = ''
    if (logoAssetKey && isR2Configured()) {
        try {
            logoUrl = await createDownloadUrl({
                companyId,
                assetKey: logoAssetKey
            })
        } catch {
            logoUrl = ''
        }
    }

    return {
        logo_storage: logoAssetKey ? 'r2' : 'none',
        logo_asset_key: logoAssetKey || null,
        logo_mime_type: logoAssetKey ? (logoMimeType || null) : null,
        logo_size_bytes: logoAssetKey ? logoSizeBytes : null,
        logo_filename: logoAssetKey ? (logoFilename || null) : null,
        logo_url: logoUrl || null,
        logo_max_bytes: getAppLogoMaxBytes()
    }
}

export function registerCompanyRoutes(app: Express, ctx: any) {
    const {
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
    } = ctx

app.get('/api/company/fallback-settings', requireSupabaseUserMiddleware, async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const { data, error } = await supabase
            .from('company')
            .select('fallback_text, fallback_limit')
            .eq('id', access.companyId)
            .maybeSingle()

        if (error) {
            if (isQuickRepliesMediaColumnsMissingError(error)) {
                return res.status(503).json({
                    success: false,
                    code: 'QUICK_REPLIES_MEDIA_MISSING',
                    error: QUICK_REPLIES_MEDIA_MISSING_MESSAGE
                })
            }
            return res.status(500).json({ success: false, error: error.message })
        }

        res.json({
            success: true,
            data: {
                fallback_text: data?.fallback_text ?? null,
                fallback_limit: data?.fallback_limit ?? null
            }
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/company/fallback-settings', requireSupabaseUserMiddleware, async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const rawText = req.body?.fallback_text
        const rawLimit = req.body?.fallback_limit

        const fallbackText = typeof rawText === 'string' ? rawText.trim() : undefined
        let fallbackLimit: number | null | undefined
        if (rawLimit === '' || rawLimit === null || rawLimit === undefined) {
            fallbackLimit = null
        } else {
            const parsed = Number(rawLimit)
            fallbackLimit = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : null
        }

        const { error } = await supabase
            .from('company')
            .update({
                fallback_text: fallbackText,
                fallback_limit: fallbackLimit
            })
            .eq('id', access.companyId)

        if (error) {
            if (isQuickRepliesMediaColumnsMissingError(error)) {
                return res.status(503).json({
                    success: false,
                    code: 'QUICK_REPLIES_MEDIA_MISSING',
                    error: QUICK_REPLIES_MEDIA_MISSING_MESSAGE
                })
            }
            return res.status(500).json({ success: false, error: error.message })
        }

        res.json({
            success: true,
            data: { fallback_text: fallbackText ?? null, fallback_limit: fallbackLimit ?? null }
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.get('/api/company/ui-controls', requireSupabaseUserMiddleware, async (req: any, res: any) => {
    try {
        const access = await resolveCompanyAccess(req, res, 'agent')
        if (!access) return

        let data: any = null
        let error: any = null

        const withLogoResponse = await supabase
            .from('company')
            .select('id, ui_hidden_features, app_logo_storage, app_logo_asset_key, app_logo_mime_type, app_logo_size_bytes, app_logo_filename')
            .eq('id', access.companyId)
            .maybeSingle()
        data = withLogoResponse.data
        error = withLogoResponse.error

        if (error && isAppLogoFieldsMissingError(error)) {
            const fallbackResponse = await supabase
                .from('company')
                .select('id, ui_hidden_features')
                .eq('id', access.companyId)
                .maybeSingle()
            data = fallbackResponse.data
            error = fallbackResponse.error
        }

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
            return res.status(404).json({ success: false, error: 'Company profile not found' })
        }

        const logo = await serializeCompanyAppLogo(access.companyId, data)
        return res.json({
            success: true,
            data: {
                company_id: data.id || access.companyId,
                hidden_features: sanitizeUiHiddenFeatures((data as any).ui_hidden_features),
                app_logo_storage: logo.logo_storage,
                app_logo_asset_key: logo.logo_asset_key,
                app_logo_mime_type: logo.logo_mime_type,
                app_logo_size_bytes: logo.logo_size_bytes,
                app_logo_filename: logo.logo_filename,
                app_logo_url: logo.logo_url,
                app_logo_max_bytes: logo.logo_max_bytes
            }
        })
    } catch (error: any) {
        return res.status(500).json({ success: false, error: error.message })
    }
})

app.get('/api/company/app-logo', requireSupabaseUserMiddleware, async (req: any, res: any) => {
    try {
        const access = await resolveCompanyAccess(req, res, 'agent')
        if (!access) return

        const { data, error } = await supabase
            .from('company')
            .select('id, app_logo_storage, app_logo_asset_key, app_logo_mime_type, app_logo_size_bytes, app_logo_filename')
            .eq('id', access.companyId)
            .maybeSingle()

        if (error) {
            if (isAppLogoFieldsMissingError(error)) {
                return res.status(503).json({
                    success: false,
                    code: 'APP_LOGO_FIELDS_MISSING',
                    error: APP_LOGO_FIELDS_MISSING_MESSAGE
                })
            }
            return res.status(500).json({ success: false, error: error.message })
        }

        if (!data) {
            return res.status(404).json({ success: false, error: 'Company profile not found' })
        }

        const logo = await serializeCompanyAppLogo(access.companyId, data)
        return res.json({
            success: true,
            data: {
                company_id: data.id || access.companyId,
                ...logo
            }
        })
    } catch (error: any) {
        return res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/company/app-logo', requireSupabaseUserMiddleware, async (req: any, res: any) => {
    try {
        const access = await resolveCompanyAccess(req, res, 'admin')
        if (!access) return

        const clear = req.body?.clear === true || req.body?.remove === true
        const nextAssetKeyRaw = typeof req.body?.app_logo_asset_key === 'string'
            ? req.body.app_logo_asset_key
            : typeof req.body?.logoAssetKey === 'string'
                ? req.body.logoAssetKey
                : ''
        const nextMimeType = normalizeAppLogoMimeType(req.body?.app_logo_mime_type || req.body?.logoMimeType)
        const nextSizeBytes = normalizeAppLogoSizeBytes(req.body?.app_logo_size_bytes ?? req.body?.logoSizeBytes)
        const nextFilename = normalizeAppLogoFilename(req.body?.app_logo_filename || req.body?.logoFilename)

        let appLogoStorage: 'none' | 'r2' = 'none'
        let appLogoAssetKey: string | null = null

        if (!clear) {
            if (!nextAssetKeyRaw) {
                return res.status(400).json({ success: false, error: 'app_logo_asset_key is required.' })
            }
            try {
                appLogoAssetKey = assertCompanyAssetKey(access.companyId, nextAssetKeyRaw)
            } catch (error: any) {
                return res.status(400).json({ success: false, error: error?.message || 'Invalid app_logo_asset_key.' })
            }
            if (nextMimeType && !nextMimeType.startsWith('image/')) {
                return res.status(400).json({ success: false, error: 'App logo must be an image MIME type.' })
            }
            const maxBytes = getAppLogoMaxBytes()
            if (nextSizeBytes && maxBytes > 0 && nextSizeBytes > maxBytes) {
                return res.status(413).json({
                    success: false,
                    error: `App logo file too large. Max ${maxBytes} bytes.`,
                    maxBytes
                })
            }
            appLogoStorage = 'r2'
        }

        const { data, error } = await supabase
            .from('company')
            .update({
                app_logo_storage: appLogoStorage,
                app_logo_asset_key: appLogoAssetKey,
                app_logo_mime_type: appLogoAssetKey ? (nextMimeType || null) : null,
                app_logo_size_bytes: appLogoAssetKey ? nextSizeBytes : null,
                app_logo_filename: appLogoAssetKey ? (nextFilename || null) : null
            })
            .eq('id', access.companyId)
            .select('id, app_logo_storage, app_logo_asset_key, app_logo_mime_type, app_logo_size_bytes, app_logo_filename')
            .maybeSingle()

        if (error) {
            if (isAppLogoFieldsMissingError(error)) {
                return res.status(503).json({
                    success: false,
                    code: 'APP_LOGO_FIELDS_MISSING',
                    error: APP_LOGO_FIELDS_MISSING_MESSAGE
                })
            }
            return res.status(500).json({ success: false, error: error.message })
        }

        if (!data) {
            return res.status(404).json({ success: false, error: 'Company profile not found' })
        }

        const logo = await serializeCompanyAppLogo(access.companyId, data)
        return res.json({
            success: true,
            data: {
                company_id: data.id || access.companyId,
                ...logo
            }
        })
    } catch (error: any) {
        return res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/company/media/upload-url', requireSupabaseUserMiddleware, async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        if (!isR2Configured()) {
            return res.status(503).json({ success: false, error: 'R2 storage is not configured on this server.' })
        }

        const purpose = normalizeUploadPurpose(req.body?.purpose)
        const messageType = normalizeMediaMessageType(req.body?.messageType)
        const fileName = readTrimmed(req.body?.fileName || '')
        const mimeType = readTrimmed(req.body?.mimeType || '').toLowerCase()
        const sizeBytes = Number(req.body?.sizeBytes)

        if (!purpose) {
            return res.status(400).json({ success: false, error: 'purpose must be quick_reply, chat_message, or app_logo.' })
        }
        if (!messageType) {
            return res.status(400).json({ success: false, error: 'messageType must be image, video, or document.' })
        }
        if (!fileName) {
            return res.status(400).json({ success: false, error: 'fileName is required.' })
        }
        if (!mimeType || !isAllowedMimeType(messageType, mimeType)) {
            return res.status(400).json({ success: false, error: `Invalid MIME type for ${messageType}.` })
        }
        if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
            return res.status(400).json({ success: false, error: 'sizeBytes must be a positive number.' })
        }

        let maxBytes = getMaxUploadBytes(messageType)
        if (purpose === 'app_logo') {
            if (messageType !== 'image') {
                return res.status(400).json({ success: false, error: 'App logo uploads only support image messageType.' })
            }
            const logoMaxBytes = getAppLogoMaxBytes()
            maxBytes = maxBytes > 0 ? Math.min(maxBytes, logoMaxBytes) : logoMaxBytes
        }
        if (maxBytes > 0 && sizeBytes > maxBytes) {
            return res.status(413).json({
                success: false,
                error: `File too large for ${messageType}. Max ${maxBytes} bytes.`,
                maxBytes
            })
        }

        const upload = await createUploadUrl({
            companyId: access.companyId,
            purpose,
            messageType,
            fileName,
            mimeType,
            sizeBytes
        })

        return res.json({
            success: true,
            data: {
                ...upload,
                maxBytes
            }
        })
    } catch (error: any) {
        return res.status(500).json({ success: false, error: error.message })
    }
})

const normalizeQuickReplyShortcut = (value: unknown): string => {
    if (typeof value !== 'string') return ''
    const trimmed = value.trim()
    if (!trimmed) return ''
    const withoutSlash = trimmed.replace(/^\/+/, '')
    const token = withoutSlash.split(/\s+/)[0]
    return token.toLowerCase()
}

const QUICK_REPLY_MESSAGE_TYPES = new Set(['text', 'image', 'video', 'document'])

const normalizeQuickReplyMessageType = (value: unknown): 'text' | 'image' | 'video' | 'document' => {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
    if (normalized === 'image' || normalized === 'video' || normalized === 'document') return normalized
    return 'text'
}

const normalizeQuickReplyText = (value: unknown): string =>
    typeof value === 'string' ? value.trim() : ''

const normalizeQuickReplyMediaUrl = (value: unknown): string =>
    typeof value === 'string' ? value.trim() : ''

const normalizeQuickReplyMediaFilename = (value: unknown): string =>
    typeof value === 'string' ? value.trim() : ''

const normalizeQuickReplyMediaStorage = (value: unknown): 'external' | 'r2' => {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
    if (normalized === 'r2') return 'r2'
    return 'external'
}

const normalizeQuickReplyMediaAssetKey = (value: unknown): string =>
    typeof value === 'string' ? value.trim() : ''

const normalizeQuickReplyMediaMimeType = (value: unknown): string =>
    typeof value === 'string' ? value.trim().toLowerCase() : ''

const normalizeQuickReplyMediaSizeBytes = (value: unknown): number | null => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return null
    const normalized = Math.max(0, Math.floor(parsed))
    return normalized || null
}

const normalizeQuickReplyMediaItemType = (
    value: unknown,
    fallback: 'image' | 'video' | 'document'
): 'image' | 'video' | 'document' => {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
    if (normalized === 'image' || normalized === 'video' || normalized === 'document') return normalized
    return fallback
}

const normalizeQuickReplyMediaItems = (
    value: unknown,
    messageType: 'image' | 'video' | 'document',
    companyId: string
): Array<{
    type: 'image' | 'video' | 'document'
    media_storage: 'external' | 'r2'
    media_asset_key: string
    media_mime_type: string
    media_size_bytes: number | null
    media_url: string
    media_filename: string
}> => {
    if (!Array.isArray(value)) return []
    const normalized: Array<{
        type: 'image' | 'video' | 'document'
        media_storage: 'external' | 'r2'
        media_asset_key: string
        media_mime_type: string
        media_size_bytes: number | null
        media_url: string
        media_filename: string
    }> = []

    value.forEach((entry: any) => {
        const mediaType = normalizeQuickReplyMediaItemType(entry?.type, messageType)
        if (mediaType !== messageType) return
        const mediaAssetKeyRaw = normalizeQuickReplyMediaAssetKey(entry?.media_asset_key)
        const mediaStorage: 'external' | 'r2' = mediaAssetKeyRaw ? 'r2' : normalizeQuickReplyMediaStorage(entry?.media_storage)
        const mediaUrl = normalizeQuickReplyMediaUrl(entry?.media_url)
        let mediaAssetKey = ''

        if (mediaStorage === 'r2') {
            if (!mediaAssetKeyRaw) return
            try {
                mediaAssetKey = assertCompanyAssetKey(companyId, mediaAssetKeyRaw)
            } catch {
                return
            }
        } else if (!mediaUrl) {
            return
        }

        normalized.push({
            type: mediaType,
            media_storage: mediaStorage,
            media_asset_key: mediaAssetKey,
            media_mime_type: normalizeQuickReplyMediaMimeType(entry?.media_mime_type),
            media_size_bytes: normalizeQuickReplyMediaSizeBytes(entry?.media_size_bytes),
            media_url: mediaStorage === 'r2' ? '' : mediaUrl,
            media_filename: mediaType === 'document' ? normalizeQuickReplyMediaFilename(entry?.media_filename) : ''
        })
    })

    return normalized
}

const buildQuickReplyLegacyMediaItems = (
    row: any,
    messageType: 'image' | 'video' | 'document',
    companyId: string
) => {
    const mediaAssetKeyRaw = normalizeQuickReplyMediaAssetKey(row?.media_asset_key)
    const mediaStorage: 'external' | 'r2' = mediaAssetKeyRaw ? 'r2' : normalizeQuickReplyMediaStorage(row?.media_storage)
    const mediaUrl = normalizeQuickReplyMediaUrl(row?.media_url)
    let mediaAssetKey = ''

    if (mediaStorage === 'r2') {
        if (!mediaAssetKeyRaw) return []
        try {
            mediaAssetKey = assertCompanyAssetKey(companyId, mediaAssetKeyRaw)
        } catch {
            return []
        }
    } else if (!mediaUrl) {
        return []
    }

    return [{
        type: messageType,
        media_storage: mediaStorage,
        media_asset_key: mediaAssetKey,
        media_mime_type: normalizeQuickReplyMediaMimeType(row?.media_mime_type),
        media_size_bytes: normalizeQuickReplyMediaSizeBytes(row?.media_size_bytes),
        media_url: mediaStorage === 'r2' ? '' : mediaUrl,
        media_filename: messageType === 'document' ? normalizeQuickReplyMediaFilename(row?.media_filename) : ''
    }]
}

const serializeQuickReplyRow = async (companyId: string, row: any) => {
    const messageType = normalizeQuickReplyMessageType(row?.message_type)
    let mediaItems = messageType === 'text'
        ? []
        : normalizeQuickReplyMediaItems(row?.media_items, messageType, companyId)
    if (messageType !== 'text' && mediaItems.length === 0) {
        mediaItems = buildQuickReplyLegacyMediaItems(row, messageType, companyId)
    }

    const resolvedMediaItems = await Promise.all(mediaItems.map(async (entry) => {
        let mediaUrl = normalizeQuickReplyMediaUrl(entry?.media_url)
        if (entry.media_storage === 'r2' && entry.media_asset_key && isR2Configured()) {
            try {
                mediaUrl = await createDownloadUrl({
                    companyId,
                    assetKey: entry.media_asset_key
                })
            } catch {
                mediaUrl = ''
            }
        }
        return {
            ...entry,
            media_url: mediaUrl
        }
    }))

    const primaryMedia = resolvedMediaItems[0] || null
    const primaryStorage: 'external' | 'r2' = primaryMedia
        ? (primaryMedia.media_asset_key ? 'r2' : normalizeQuickReplyMediaStorage(primaryMedia.media_storage))
        : 'external'

    return {
        ...row,
        message_type: messageType,
        media_storage: messageType === 'text' ? 'external' : primaryStorage,
        media_asset_key: messageType === 'text' || primaryStorage !== 'r2' ? null : (primaryMedia?.media_asset_key || null),
        media_url: messageType === 'text' || primaryStorage === 'r2' ? '' : (primaryMedia?.media_url || ''),
        media_mime_type: messageType === 'text' || primaryStorage !== 'r2' ? null : (normalizeQuickReplyMediaMimeType(primaryMedia?.media_mime_type) || null),
        media_size_bytes: messageType === 'text' || primaryStorage !== 'r2' ? null : normalizeQuickReplyMediaSizeBytes(primaryMedia?.media_size_bytes),
        media_filename: messageType === 'document' ? normalizeQuickReplyMediaFilename(primaryMedia?.media_filename) : '',
        media_items: resolvedMediaItems
    }
}

// Configure quick replies (company-level)
app.get('/api/company/quick-replies', requireSupabaseUserMiddleware, async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const { data, error } = await supabase
            .from('quick_replies')
            .select('id, shortcut, text, message_type, media_url, media_filename, media_storage, media_asset_key, media_mime_type, media_size_bytes, media_items, created_at, updated_at')
            .eq('company_id', access.companyId)
            .order('shortcut', { ascending: true })

        if (error) {
            if (isQuickRepliesMediaColumnsMissingError(error)) {
                return res.status(503).json({
                    success: false,
                    code: 'QUICK_REPLIES_MEDIA_MISSING',
                    error: QUICK_REPLIES_MEDIA_MISSING_MESSAGE
                })
            }
            return res.status(500).json({ success: false, error: error.message })
        }

        const normalized = await Promise.all((data || []).map((row: any) => serializeQuickReplyRow(access.companyId, row)))

        res.json({ success: true, data: normalized })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/company/quick-replies', requireSupabaseUserMiddleware, async (req: any, res: any) => {
    try {
        const access = await resolveProfileAccess(req, res)
        if (!access) return

        const rawItems = req.body?.items
        if (!Array.isArray(rawItems)) {
            return res.status(400).json({ success: false, error: 'items must be an array' })
        }

        const seen = new Set<string>()
        const cleaned: Array<{
            shortcut: string
            text: string
            message_type: 'text' | 'image' | 'video' | 'document'
            media_storage: 'external' | 'r2'
            media_url: string | null
            media_asset_key: string | null
            media_mime_type: string | null
            media_size_bytes: number | null
            media_filename: string | null
            media_items: Array<{
                type: 'image' | 'video' | 'document'
                media_storage: 'external' | 'r2'
                media_asset_key: string
                media_mime_type: string
                media_size_bytes: number | null
                media_url: string
                media_filename: string
            }>
        }> = []
        rawItems.forEach((item: any) => {
            const shortcut = normalizeQuickReplyShortcut(item?.shortcut)
            const text = normalizeQuickReplyText(item?.text)
            const messageType = normalizeQuickReplyMessageType(item?.message_type)
            const requestedStorage = normalizeQuickReplyMediaStorage(item?.media_storage)
            const mediaUrl = normalizeQuickReplyMediaUrl(item?.media_url)
            const mediaAssetKeyRaw = normalizeQuickReplyMediaAssetKey(item?.media_asset_key)
            const mediaMimeType = normalizeQuickReplyMediaMimeType(item?.media_mime_type)
            const mediaSizeBytes = normalizeQuickReplyMediaSizeBytes(item?.media_size_bytes)
            const mediaFilename = normalizeQuickReplyMediaFilename(item?.media_filename)
            const mediaStorage: 'external' | 'r2' = mediaAssetKeyRaw ? 'r2' : requestedStorage
            let mediaAssetKey = ''
            let mediaItems = messageType === 'text'
                ? []
                : normalizeQuickReplyMediaItems(item?.media_items, messageType, access.companyId)
            if (messageType !== 'text' && mediaItems.length === 0) {
                mediaItems = buildQuickReplyLegacyMediaItems(item, messageType, access.companyId)
            }
            const primaryMedia = mediaItems[0] || null
            const primaryStorage: 'external' | 'r2' = primaryMedia
                ? (primaryMedia.media_asset_key ? 'r2' : normalizeQuickReplyMediaStorage(primaryMedia.media_storage))
                : mediaStorage
            const primaryAssetKey = primaryMedia ? primaryMedia.media_asset_key : mediaAssetKeyRaw
            const primaryMimeType = primaryMedia ? primaryMedia.media_mime_type : mediaMimeType
            const primarySizeBytes = primaryMedia ? primaryMedia.media_size_bytes : mediaSizeBytes
            const primaryUrl = primaryMedia ? primaryMedia.media_url : mediaUrl
            const primaryFilename = primaryMedia ? primaryMedia.media_filename : mediaFilename
            if (!shortcut) return
            if (!QUICK_REPLY_MESSAGE_TYPES.has(messageType)) return
            if (seen.has(shortcut)) {
                return
            }
            if (messageType === 'text') {
                if (!text) return
            } else if (mediaItems.length === 0) {
                return
            }
            if (messageType !== 'text' && primaryStorage === 'r2' && primaryAssetKey) {
                try {
                    mediaAssetKey = assertCompanyAssetKey(access.companyId, primaryAssetKey)
                } catch {
                    return
                }
            }
            seen.add(shortcut)
            cleaned.push({
                shortcut,
                text,
                message_type: messageType,
                media_storage: messageType === 'text' ? 'external' : primaryStorage,
                media_url: messageType === 'text' || primaryStorage === 'r2' ? null : primaryUrl,
                media_asset_key: messageType === 'text' || primaryStorage !== 'r2' ? null : mediaAssetKey,
                media_mime_type: messageType === 'text' || primaryStorage !== 'r2' ? null : (primaryMimeType || null),
                media_size_bytes: messageType === 'text' || primaryStorage !== 'r2' ? null : primarySizeBytes,
                media_filename: messageType === 'document' && primaryFilename ? primaryFilename : null,
                media_items: messageType === 'text'
                    ? []
                    : mediaItems.map((entry) => ({
                        type: normalizeQuickReplyMediaItemType(entry.type, messageType),
                        media_storage: entry.media_asset_key ? 'r2' : normalizeQuickReplyMediaStorage(entry.media_storage),
                        media_asset_key: entry.media_asset_key,
                        media_mime_type: normalizeQuickReplyMediaMimeType(entry.media_mime_type),
                        media_size_bytes: normalizeQuickReplyMediaSizeBytes(entry.media_size_bytes),
                        media_url: normalizeQuickReplyMediaUrl(entry.media_url),
                        media_filename: normalizeQuickReplyMediaItemType(entry.type, messageType) === 'document'
                            ? normalizeQuickReplyMediaFilename(entry.media_filename)
                            : ''
                    }))
            })
        })

        const { error: deleteError } = await supabase
            .from('quick_replies')
            .delete()
            .eq('company_id', access.companyId)

        if (deleteError) {
            return res.status(500).json({ success: false, error: deleteError.message })
        }

        if (cleaned.length > 0) {
            const { error: insertError } = await supabase
                .from('quick_replies')
                .insert(cleaned.map(item => ({
                    company_id: access.companyId,
                    shortcut: item.shortcut,
                    text: item.text,
                    message_type: item.message_type,
                    media_storage: item.media_storage,
                    media_url: item.media_url,
                    media_asset_key: item.media_asset_key,
                    media_mime_type: item.media_mime_type,
                    media_size_bytes: item.media_size_bytes,
                    media_filename: item.media_filename,
                    media_items: item.message_type === 'text' ? null : item.media_items,
                    updated_at: new Date().toISOString()
                })))

            if (insertError) {
                if (isQuickRepliesMediaColumnsMissingError(insertError)) {
                    return res.status(503).json({
                        success: false,
                        code: 'QUICK_REPLIES_MEDIA_MISSING',
                        error: QUICK_REPLIES_MEDIA_MISSING_MESSAGE
                    })
                }
                return res.status(500).json({ success: false, error: insertError.message })
            }
        }

        const { data, error } = await supabase
            .from('quick_replies')
            .select('id, shortcut, text, message_type, media_url, media_filename, media_storage, media_asset_key, media_mime_type, media_size_bytes, media_items, created_at, updated_at')
            .eq('company_id', access.companyId)
            .order('shortcut', { ascending: true })

        if (error) {
            if (isQuickRepliesMediaColumnsMissingError(error)) {
                return res.status(503).json({
                    success: false,
                    code: 'QUICK_REPLIES_MEDIA_MISSING',
                    error: QUICK_REPLIES_MEDIA_MISSING_MESSAGE
                })
            }
            return res.status(500).json({ success: false, error: error.message })
        }

        const normalized = await Promise.all((data || []).map((row: any) => serializeQuickReplyRow(access.companyId, row)))

        res.json({ success: true, data: normalized })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.get('/api/company/me', requireSupabaseUserMiddleware, async (req: any, res: any) => {
    try {
        const access = await resolveCompanyAccess(req, res, 'agent')
        if (!access) return

        return res.json({
            success: true,
            data: {
                id: access.user.id,
                role: access.role,
                companyId: access.companyId
            }
        })
    } catch (error: any) {
        return res.status(500).json({ success: false, error: error.message })
    }
})

// Team user management (company-level)
app.get('/api/company/team-users', requireSupabaseUserMiddleware, async (req: any, res: any) => {
    try {
        const access = await resolveCompanyAccess(req, res, 'agent')
        if (!access) return

        const { user, companyId, role } = access
        const { data: rows, error } = await supabase
            .from('user_roles')
            .select('user_id, role, company_id, created_at')
            .eq('company_id', companyId)
            .order('created_at', { ascending: true })

        if (error) {
            return res.status(500).json({ success: false, error: error.message })
        }

        const users: any[] = []
        const hasServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)

        for (const row of rows || []) {
            const entry: any = {
                id: row.user_id,
                role: normalizeTeamRole(row.role),
                department: 'custom',
                customDepartment: null as string | null,
                color: computeAgentColor(row.user_id),
                createdAt: row.created_at || null
            }
            if (hasServiceRole) {
                const { data: authData, error: authError } = await supabase.auth.admin.getUserById(row.user_id)
                if (!authError && authData?.user) {
                    const authUser = authData.user
                    entry.email = authUser.email || null
                    entry.name = deriveAgentName(authUser)
                    entry.lastSignInAt = authUser.last_sign_in_at || null
                    const metadata = authUser.user_metadata || {}
                    entry.department = normalizeTeamDepartment(metadata.team_department)
                    entry.customDepartment = entry.department === 'custom'
                        ? normalizeTeamCustomDepartment(metadata.team_department_custom)
                        : null
                }
            }
            if (!entry.name) entry.name = row.user_id
            users.push(entry)
        }

        res.json({
            success: true,
            data: {
                currentUserId: user.id,
                currentUserRole: role,
                users
            }
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.post('/api/company/team-users/invite', requireSupabaseUserMiddleware, async (req: any, res: any) => {
    try {
        const access = await resolveCompanyAccess(req, res, 'admin')
        if (!access) return

        const hasServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)
        if (!hasServiceRole) {
            return res.status(500).json({ success: false, error: 'SUPABASE_SERVICE_ROLE_KEY is required to invite users' })
        }

        const email = readTrimmed(req.body?.email).toLowerCase()
        const requestedRole = normalizeTeamRole(req.body?.role)
        const role = requestedRole === 'owner' ? 'admin' : requestedRole
        const password = typeof req.body?.password === 'string' ? req.body.password : ''
        const department = normalizeTeamDepartment(req.body?.department)
        const customDepartment = normalizeTeamCustomDepartment(req.body?.customDepartment)
        if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
            return res.status(400).json({ success: false, error: 'Valid email is required' })
        }
        if (password.length < 8) {
            return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' })
        }
        if (department === 'custom' && !customDepartment) {
            return res.status(400).json({ success: false, error: 'Custom department label is required' })
        }

        const created = await supabase.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
            user_metadata: {
                company_id: access.companyId,
                team_department: department,
                team_department_custom: department === 'custom' ? customDepartment : null
            }
        } as any)

        if (created.error || !created.data?.user?.id) {
            const message = created.error?.message || 'Failed to create user'
            const isConflict = /already|exists|registered/i.test(message)
            return res.status(isConflict ? 409 : 500).json({ success: false, error: message })
        }

        const invitedUserId = created.data.user.id
        const { error: upsertError } = await supabase
            .from('user_roles')
            .upsert({
                user_id: invitedUserId,
                company_id: access.companyId,
                role
            }, {
                onConflict: 'user_id'
            })

        if (upsertError) {
            return res.status(500).json({ success: false, error: upsertError.message })
        }

        res.json({
            success: true,
            data: {
                id: invitedUserId,
                email,
                role,
                department,
                customDepartment: department === 'custom' ? customDepartment : null
            }
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.patch('/api/company/team-users/:userId/role', requireSupabaseUserMiddleware, async (req: any, res: any) => {
    try {
        const access = await resolveCompanyAccess(req, res, 'admin')
        if (!access) return

        const targetUserId = readTrimmed(req.params?.userId)
        if (!targetUserId) {
            return res.status(400).json({ success: false, error: 'userId is required' })
        }

        const nextRole = normalizeTeamRole(req.body?.role)
        if (nextRole === 'owner' && access.role !== 'owner') {
            return res.status(403).json({ success: false, error: 'Only owner can grant owner role' })
        }

        const { data: targetRoleRow, error: roleError } = await supabase
            .from('user_roles')
            .select('user_id, role, company_id')
            .eq('user_id', targetUserId)
            .eq('company_id', access.companyId)
            .maybeSingle()

        if (roleError) {
            return res.status(500).json({ success: false, error: roleError.message })
        }
        if (!targetRoleRow?.user_id) {
            return res.status(404).json({ success: false, error: 'Team user not found in your company' })
        }

        if (access.user.id === targetUserId && normalizeTeamRole(targetRoleRow.role) === 'owner' && nextRole !== 'owner') {
            return res.status(400).json({ success: false, error: 'Owner cannot demote self. Promote another owner first.' })
        }

        const { error: updateError } = await supabase
            .from('user_roles')
            .update({ role: nextRole, company_id: access.companyId })
            .eq('user_id', targetUserId)
            .eq('company_id', access.companyId)

        if (updateError) {
            return res.status(500).json({ success: false, error: updateError.message })
        }

        res.json({
            success: true,
            data: {
                id: targetUserId,
                role: nextRole
            }
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

app.patch('/api/company/team-users/:userId/department', requireSupabaseUserMiddleware, async (req: any, res: any) => {
    try {
        const access = await resolveCompanyAccess(req, res, 'admin')
        if (!access) return

        const hasServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)
        if (!hasServiceRole) {
            return res.status(500).json({ success: false, error: 'SUPABASE_SERVICE_ROLE_KEY is required to update departments' })
        }

        const targetUserId = readTrimmed(req.params?.userId)
        if (!targetUserId) {
            return res.status(400).json({ success: false, error: 'userId is required' })
        }

        const department = normalizeTeamDepartment(req.body?.department)
        const customDepartment = normalizeTeamCustomDepartment(req.body?.customDepartment)
        if (department === 'custom' && !customDepartment) {
            return res.status(400).json({ success: false, error: 'Custom department label is required' })
        }

        const { data: targetRoleRow, error: roleError } = await supabase
            .from('user_roles')
            .select('user_id, company_id')
            .eq('user_id', targetUserId)
            .eq('company_id', access.companyId)
            .maybeSingle()

        if (roleError) {
            return res.status(500).json({ success: false, error: roleError.message })
        }
        if (!targetRoleRow?.user_id) {
            return res.status(404).json({ success: false, error: 'Team user not found in your company' })
        }

        const { data: authUserData, error: authUserError } = await supabase.auth.admin.getUserById(targetUserId)
        if (authUserError || !authUserData?.user) {
            return res.status(500).json({ success: false, error: authUserError?.message || 'Failed to load target user' })
        }

        const previousMetadata = authUserData.user.user_metadata || {}
        const nextMetadata = {
            ...previousMetadata,
            company_id: access.companyId,
            team_department: department,
            team_department_custom: department === 'custom' ? customDepartment : null
        }

        const { error: updateError } = await supabase.auth.admin.updateUserById(targetUserId, {
            user_metadata: nextMetadata
        } as any)

        if (updateError) {
            return res.status(500).json({ success: false, error: updateError.message })
        }

        res.json({
            success: true,
            data: {
                id: targetUserId,
                department,
                customDepartment: department === 'custom' ? customDepartment : null
            }
        })
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message })
    }
})

}
