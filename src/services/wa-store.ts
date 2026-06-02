import { supabase } from '../supabase'

export type Company = {
    id: string
    name?: string
    email?: string
    fallback_text?: string | null
    fallback_limit?: number | null
}

export type User = {
    id: string
    company_id: string
    profile_id?: string | null
    phone_number: string
    name?: string | null
    alias?: string | null
    tags?: string[] | null
    last_inbound_at?: string | null
    last_window_reminder_at?: string | null
    assigned_to_user_id?: string | null
    assigned_to_name?: string | null
    assigned_to_color?: string | null
    assigned_at?: string | null
    cta_referral_at?: string | null
    cta_referral_source?: string | null
    cta_free_window_started_at?: string | null
    cta_free_window_expires_at?: string | null
    template_attributes?: UserTemplateAttribute[] | null
}

export type TemplateAttributeScope = 'body' | 'header'

export type UserTemplateAttribute = {
    templateName: string
    language: string
    scope: TemplateAttributeScope
    index: number
    key: string
    value: string
    savedAt: string
}

export type TemplateAttributeInput = {
    scope?: string | null
    index?: number | null
    key?: string | null
    value?: string | null
}

export type MessageRecord = {
    id: string
    user_id: string
    profile_id?: string | null
    direction: 'in' | 'out'
    content: any
    workflow_state: any | null
    created_at: string
}

export const HUMAN_TAKEOVER_TAG = 'human_takeover'
export const ADS_SHOOT_SIMULATED_TAG = 'new_leads'
export const LEGACY_ADS_SHOOT_SIMULATED_TAG = 'ads_shoot_simulated'

const CTA_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000
const CTA_FREE_WINDOW_MS = 72 * 60 * 60 * 1000
const TEMPLATE_ATTRIBUTE_MAX_ITEMS = 80
const TEMPLATE_ATTRIBUTE_TEMPLATE_MAX_LENGTH = 128
const TEMPLATE_ATTRIBUTE_LANGUAGE_MAX_LENGTH = 24
const TEMPLATE_ATTRIBUTE_KEY_MAX_LENGTH = 120
const TEMPLATE_ATTRIBUTE_VALUE_MAX_LENGTH = 400

export function isGroupIdentifier(input: string | null | undefined): boolean {
    if (!input) return false
    const raw = String(input).trim()
    if (!raw) return false

    const lower = raw.toLowerCase()
    const atIndex = lower.indexOf('@')
    const domain = atIndex >= 0 ? lower.slice(atIndex + 1) : ''
    const localPart = atIndex >= 0 ? raw.slice(0, atIndex) : raw
    const localLower = localPart.toLowerCase()

    if (!localPart) return false
    if (domain === 'g.us') return true
    if (domain === 's.whatsapp.net' || domain === 'lid') return false

    return localLower.startsWith('y2fwav9ncm91cd') || localPart.includes(':')
}

export function normalizePhoneNumber(input: string | null | undefined): string {
    if (!input) return ''
    const raw = String(input).trim()
    if (!raw) return ''

    const lower = raw.toLowerCase()
    const atIndex = lower.indexOf('@')
    const domain = atIndex >= 0 ? lower.slice(atIndex + 1) : ''
    const localPart = (atIndex >= 0 ? raw.slice(0, atIndex) : raw).trim()
    if (!localPart) return ''

    if (domain === 'g.us') return localPart
    if (isGroupIdentifier(raw)) return localPart

    const withoutDevice = localPart.includes(':') ? (localPart.split(':')[0] || '') : localPart
    return withoutDevice.replace(/\D/g, '')
}

function normalizeOptionalProfileId(input: string | null | undefined): string | null {
    if (typeof input !== 'string') return null
    const trimmed = input.trim()
    return trimmed ? trimmed : null
}

function isMissingColumnError(error: any): boolean {
    return error?.code === '42703' || String(error?.message || '').toLowerCase().includes('does not exist')
}

function sanitizeTemplateAttributeText(value: any, maxLength: number): string {
    const raw = typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value).trim()
    if (!raw) return ''
    return raw.slice(0, maxLength)
}

function normalizeTemplateAttributeScope(value: any): TemplateAttributeScope {
    const scope = typeof value === 'string' ? value.trim().toLowerCase() : ''
    return scope === 'header' ? 'header' : 'body'
}

function sanitizeStoredTemplateAttributes(raw: any): UserTemplateAttribute[] {
    if (!Array.isArray(raw)) return []
    const sanitized: UserTemplateAttribute[] = []
    raw.forEach((item: any) => {
        const templateName = sanitizeTemplateAttributeText(item?.templateName, TEMPLATE_ATTRIBUTE_TEMPLATE_MAX_LENGTH)
        const key = sanitizeTemplateAttributeText(item?.key, TEMPLATE_ATTRIBUTE_KEY_MAX_LENGTH)
        const value = sanitizeTemplateAttributeText(item?.value, TEMPLATE_ATTRIBUTE_VALUE_MAX_LENGTH)
        if (!templateName || !key || !value) return
        const language = sanitizeTemplateAttributeText(item?.language, TEMPLATE_ATTRIBUTE_LANGUAGE_MAX_LENGTH) || 'en_US'
        const parsedIndex = Number.parseInt(String(item?.index ?? ''), 10)
        const index = Number.isFinite(parsedIndex) && parsedIndex > 0 ? Math.min(parsedIndex, 99) : 1
        sanitized.push({
            templateName,
            language,
            scope: normalizeTemplateAttributeScope(item?.scope),
            index,
            key,
            value,
            savedAt: toIsoOrNow(item?.savedAt || null)
        })
    })

    sanitized.sort((a, b) => {
        const aMs = new Date(a.savedAt).getTime()
        const bMs = new Date(b.savedAt).getTime()
        if (Number.isNaN(aMs) && Number.isNaN(bMs)) return 0
        if (Number.isNaN(aMs)) return 1
        if (Number.isNaN(bMs)) return -1
        return bMs - aMs
    })

    return sanitized.slice(0, TEMPLATE_ATTRIBUTE_MAX_ITEMS)
}

export async function getDefaultCompanyId(): Promise<string | null> {
    const { data, error } = await supabase
        .from('company')
        .select('id')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()

    if (error) {
        console.warn('[DB] Failed to load default company:', error.message)
        return null
    }

    return data?.id || null
}

export async function resolveCompanyId(companyId?: string | null): Promise<string | null> {
    if (companyId) {
        const { data, error } = await supabase
            .from('company')
            .select('id')
            .eq('id', companyId)
            .maybeSingle()

        if (!error && data?.id) return data.id
    }
    return getDefaultCompanyId()
}

export async function getCompanyFallbackSettings(companyId: string): Promise<{
    fallback_text?: string | null
    fallback_limit?: number | null
} | null> {
    if (!companyId) return null
    const { data, error } = await supabase
        .from('company')
        .select('fallback_text, fallback_limit')
        .eq('id', companyId)
        .maybeSingle()

    if (error) {
        console.warn('[DB] Failed to load fallback settings:', error.message)
        return null
    }

    return data || null
}

export async function updateCompanyFallbackSettings(
    companyId: string,
    settings: { fallback_text?: string | null; fallback_limit?: number | null }
): Promise<boolean> {
    if (!companyId) return false
    const { error } = await supabase
        .from('company')
        .update({
            fallback_text: settings.fallback_text ?? null,
            fallback_limit: settings.fallback_limit ?? null
        })
        .eq('id', companyId)

    if (error) {
        console.warn('[DB] Failed to update fallback settings:', error.message)
        return false
    }

    return true
}

export async function findOrCreateUser(companyId: string, phoneNumber: string, profileId?: string | null): Promise<User | null> {
    const normalized = normalizePhoneNumber(phoneNumber)
    const normalizedProfileId = normalizeOptionalProfileId(profileId)
    if (!normalized) {
        console.warn('[DB] Invalid phone number for user lookup:', phoneNumber)
        return null
    }

    const groupJid = `${normalized}@g.us`
    const individualJid = `${normalized}@s.whatsapp.net`
    const candidates = Array.from(
        new Set(
            isGroupIdentifier(phoneNumber) || isGroupIdentifier(normalized)
                ? [normalized, groupJid]
                : [normalized, individualJid]
        )
    )

    let existing: any[] | null = null
    let fetchError: any = null

    if (normalizedProfileId) {
        const exactResult = await supabase
            .from('users')
            .select('*')
            .eq('company_id', companyId)
            .eq('profile_id', normalizedProfileId)
            .in('phone_number', candidates)
            .limit(2)

        if (exactResult.error && isMissingColumnError(exactResult.error)) {
            console.warn('[DB] users.profile_id is missing; falling back to company-scoped contact lookup.')
            const fallbackResult = await supabase
                .from('users')
                .select('*')
                .eq('company_id', companyId)
                .in('phone_number', candidates)
                .limit(2)
            existing = fallbackResult.data || null
            fetchError = fallbackResult.error
        } else if (exactResult.data && exactResult.data.length > 0) {
            existing = exactResult.data
            fetchError = exactResult.error
        } else {
            const legacyResult = await supabase
                .from('users')
                .select('*')
                .eq('company_id', companyId)
                .is('profile_id', null)
                .in('phone_number', candidates)
                .limit(2)

            if (legacyResult.error && isMissingColumnError(legacyResult.error)) {
                const fallbackResult = await supabase
                    .from('users')
                    .select('*')
                    .eq('company_id', companyId)
                    .in('phone_number', candidates)
                    .limit(2)
                existing = fallbackResult.data || null
                fetchError = fallbackResult.error
            } else {
                existing = legacyResult.data || null
                fetchError = legacyResult.error
            }
        }
    } else {
        const companyResult = await supabase
            .from('users')
            .select('*')
            .eq('company_id', companyId)
            .in('phone_number', candidates)
            .limit(2)
        existing = companyResult.data || null
        fetchError = companyResult.error
    }

    if (fetchError) {
        console.warn('[DB] Failed to fetch user:', fetchError.message)
    }

    if (existing && existing.length > 0) {
        const exact = existing.find((row: any) => row.phone_number === normalized) || existing[0]
        if (exact) {
            const updates: Record<string, any> = {}
            if (exact.phone_number !== normalized) updates.phone_number = normalized
            if (normalizedProfileId && !normalizeOptionalProfileId(exact.profile_id)) {
                updates.profile_id = normalizedProfileId
            }
            if (Object.keys(updates).length > 0) {
                const { error: updateError } = await supabase
                    .from('users')
                    .update(updates)
                    .eq('id', exact.id)
                if (updateError && !isMissingColumnError(updateError)) {
                    console.warn('[DB] Failed to normalize user row:', updateError.message)
                } else {
                    Object.assign(exact, updates)
                }
            }
        }
        return exact as User
    }

    let created: any = null
    let createError: any = null

    if (normalizedProfileId) {
        const profileInsert = await supabase
            .from('users')
            .insert({ company_id: companyId, profile_id: normalizedProfileId, phone_number: normalized, tags: [] })
            .select('*')
            .single()
        created = profileInsert.data
        createError = profileInsert.error

        if (createError && isMissingColumnError(createError)) {
            const fallbackInsert = await supabase
                .from('users')
                .insert({ company_id: companyId, phone_number: normalized, tags: [] })
                .select('*')
                .single()
            created = fallbackInsert.data
            createError = fallbackInsert.error
        }
    } else {
        const companyInsert = await supabase
            .from('users')
            .insert({ company_id: companyId, phone_number: normalized, tags: [] })
            .select('*')
            .single()
        created = companyInsert.data
        createError = companyInsert.error
    }

    if (createError) {
        console.warn('[DB] Failed to create user:', createError.message)
        return null
    }

    return created as User
}

export async function getUserByPhone(companyId: string, phoneNumber: string, profileId?: string | null): Promise<User | null> {
    const normalized = normalizePhoneNumber(phoneNumber)
    const normalizedProfileId = normalizeOptionalProfileId(profileId)
    if (!normalized) return null
    const groupJid = `${normalized}@g.us`
    const individualJid = `${normalized}@s.whatsapp.net`
    const candidates = Array.from(
        new Set(
            isGroupIdentifier(phoneNumber) || isGroupIdentifier(normalized)
                ? [normalized, groupJid]
                : [normalized, individualJid]
        )
    )

    let data: any[] | null = null
    let error: any = null

    if (normalizedProfileId) {
        const exactResult = await supabase
            .from('users')
            .select('*')
            .eq('company_id', companyId)
            .eq('profile_id', normalizedProfileId)
            .in('phone_number', candidates)
            .limit(2)
        if (exactResult.error && isMissingColumnError(exactResult.error)) {
            const fallbackResult = await supabase
                .from('users')
                .select('*')
                .eq('company_id', companyId)
                .in('phone_number', candidates)
                .limit(2)
            data = fallbackResult.data || null
            error = fallbackResult.error
        } else if (exactResult.data && exactResult.data.length > 0) {
            data = exactResult.data
            error = exactResult.error
        } else {
            const legacyResult = await supabase
                .from('users')
                .select('*')
                .eq('company_id', companyId)
                .is('profile_id', null)
                .in('phone_number', candidates)
                .limit(2)
            if (legacyResult.error && isMissingColumnError(legacyResult.error)) {
                data = []
                error = null
            } else {
                data = legacyResult.data || null
                error = legacyResult.error
            }
        }
    } else {
        const companyResult = await supabase
            .from('users')
            .select('*')
            .eq('company_id', companyId)
            .in('phone_number', candidates)
            .limit(2)
        data = companyResult.data || null
        error = companyResult.error
    }

    if (error) {
        console.warn('[DB] Failed to fetch user by phone:', error.message)
        return null
    }

    if (!data || data.length === 0) return null
    const exact = data.find((row: any) => row.phone_number === normalized) || data[0]
    if (exact && exact.phone_number !== normalized) {
        const { error: updateError } = await supabase
            .from('users')
            .update({ phone_number: normalized })
            .eq('id', exact.id)
        if (updateError) {
            console.warn('[DB] Failed to normalize user phone_number:', updateError.message)
        } else {
            exact.phone_number = normalized
        }
    }
    return exact as User
}

export async function getUserById(userId: string): Promise<User | null> {
    if (!userId) return null
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('id', userId)
        .maybeSingle()

    if (error) {
        console.warn('[DB] Failed to fetch user by id:', error.message)
        return null
    }

    return (data || null) as User | null
}

function toIsoOrNow(value?: string | null): string {
    if (!value) return new Date().toISOString()
    const parsed = new Date(value).getTime()
    if (Number.isNaN(parsed)) return new Date().toISOString()
    return new Date(parsed).toISOString()
}

export function extractCtaReferralSource(referral: any): string | null {
    if (!referral || typeof referral !== 'object') return null
    const sourceId = typeof referral.source_id === 'string' ? referral.source_id.trim() : ''
    const sourceType = typeof referral.source_type === 'string' ? referral.source_type.trim() : ''
    const ctwaClid = typeof referral.ctwa_clid === 'string' ? referral.ctwa_clid.trim() : ''
    if (sourceType && sourceId) return `${sourceType}:${sourceId}`
    if (sourceId) return sourceId
    if (ctwaClid) return ctwaClid
    return sourceType || null
}

export async function updateUserCtaReferral(
    userId: string,
    referralAt?: string | null,
    referralSource?: string | null
): Promise<void> {
    if (!userId) return
    const timestamp = toIsoOrNow(referralAt)
    const { error } = await supabase
        .from('users')
        .update({
            cta_referral_at: timestamp,
            cta_referral_source: referralSource || null,
            cta_free_window_started_at: null,
            cta_free_window_expires_at: null
        })
        .eq('id', userId)

    if (error) {
        console.warn('[DB] Failed to update CTA referral state:', error.message)
    }
}

export async function shouldMarkCtaReplyCandidate(userId: string, sentAt?: string | null): Promise<boolean> {
    if (!userId) return false
    const user = await getUserById(userId)
    if (!user?.cta_referral_at) return false

    const sentTime = new Date(toIsoOrNow(sentAt)).getTime()
    const referralTime = new Date(user.cta_referral_at).getTime()
    if (Number.isNaN(sentTime) || Number.isNaN(referralTime)) return false

    // If free window already started for this referral, no need to mark again.
    if (user.cta_free_window_started_at) {
        const started = new Date(user.cta_free_window_started_at).getTime()
        if (!Number.isNaN(started) && started >= referralTime) {
            return false
        }
    }

    return sentTime <= referralTime + CTA_REPLY_WINDOW_MS
}

export async function activateUserCtaFreeWindow(
    userId: string,
    deliveredAt?: string | null
): Promise<{ startedAt: string; expiresAt: string } | null> {
    if (!userId) return null
    const user = await getUserById(userId)
    if (!user?.cta_referral_at) return null

    const startedAt = toIsoOrNow(deliveredAt)
    const startedMs = new Date(startedAt).getTime()
    const referralMs = new Date(user.cta_referral_at).getTime()
    if (Number.isNaN(startedMs) || Number.isNaN(referralMs)) return null

    // Keep idempotent for the same referral cycle.
    if (user.cta_free_window_started_at) {
        const existingStartedMs = new Date(user.cta_free_window_started_at).getTime()
        if (!Number.isNaN(existingStartedMs) && existingStartedMs >= referralMs) {
            const existingExpires = user.cta_free_window_expires_at || new Date(existingStartedMs + CTA_FREE_WINDOW_MS).toISOString()
            return {
                startedAt: user.cta_free_window_started_at,
                expiresAt: existingExpires
            }
        }
    }

    const expiresAt = new Date(startedMs + CTA_FREE_WINDOW_MS).toISOString()
    const { error } = await supabase
        .from('users')
        .update({
            cta_free_window_started_at: startedAt,
            cta_free_window_expires_at: expiresAt
        })
        .eq('id', userId)

    if (error) {
        console.warn('[DB] Failed to activate CTA free window:', error.message)
        return null
    }

    return { startedAt, expiresAt }
}

export async function getCtaFreeWindowExpiresAt(userId: string): Promise<string | null> {
    const user = await getUserById(userId)
    if (!user?.cta_free_window_expires_at) return null
    const expiresMs = new Date(user.cta_free_window_expires_at).getTime()
    if (Number.isNaN(expiresMs)) return null
    if (expiresMs <= Date.now()) return null
    return user.cta_free_window_expires_at
}

export async function deleteMessagesForUser(userId: string): Promise<boolean> {
    const { error } = await supabase
        .from('messages')
        .delete({ count: 'exact' })
        .eq('user_id', userId)

    if (error) {
        console.warn('[DB] Failed to delete messages:', error.message)
        return false
    }

    return true
}

export async function deleteUserById(userId: string): Promise<boolean> {
    if (!userId) return false
    const { error } = await supabase
        .from('users')
        .delete({ count: 'exact' })
        .eq('id', userId)

    if (error) {
        console.warn('[DB] Failed to delete user:', error.message)
        return false
    }

    return true
}

export async function updateUserTags(userId: string, tag: string): Promise<void> {
    const { data: existing, error } = await supabase
        .from('users')
        .select('tags')
        .eq('id', userId)
        .maybeSingle()

    if (error) {
        console.warn('[DB] Failed to load user tags:', error.message)
        return
    }

    const tags = Array.isArray(existing?.tags) ? existing?.tags : []
    if (tags.includes(tag)) return

    const nextTags = [...tags, tag]
    const { error: updateError } = await supabase
        .from('users')
        .update({ tags: nextTags })
        .eq('id', userId)

    if (updateError) {
        console.warn('[DB] Failed to update user tags:', updateError.message)
    }
}

export async function setUserTags(userId: string, tags: string[]): Promise<void> {
    const nextTags = Array.from(new Set((tags || []).map(t => t.trim()).filter(Boolean)))
    const { error } = await supabase
        .from('users')
        .update({ tags: nextTags })
        .eq('id', userId)

    if (error) {
        console.warn('[DB] Failed to set user tags:', error.message)
    }
}

export function hasHumanTakeover(user: { tags?: string[] | null } | null | undefined): boolean {
    if (!user || !Array.isArray(user.tags)) return false
    return user.tags.some((tag) => String(tag).trim().toLowerCase() === HUMAN_TAKEOVER_TAG)
}

export async function setUserHumanTakeover(userId: string, enabled: boolean): Promise<User | null> {
    const user = await getUserById(userId)
    if (!user) return null

    const tags = Array.isArray(user.tags) ? user.tags : []
    const normalized = Array.from(
        new Set(
            tags
                .map((tag) => (typeof tag === 'string' ? tag.trim() : ''))
                .filter(Boolean)
        )
    )

    const hasTag = normalized.some((tag) => tag.toLowerCase() === HUMAN_TAKEOVER_TAG)
    if (enabled && !hasTag) {
        normalized.push(HUMAN_TAKEOVER_TAG)
    } else if (!enabled && hasTag) {
        for (let i = normalized.length - 1; i >= 0; i -= 1) {
            const current = normalized[i] || ''
            if (current.toLowerCase() === HUMAN_TAKEOVER_TAG) {
                normalized.splice(i, 1)
            }
        }
    }

    const { data, error } = await supabase
        .from('users')
        .update({ tags: normalized })
        .eq('id', userId)
        .select('*')
        .maybeSingle()

    if (error) {
        console.warn('[DB] Failed to set human takeover:', error.message)
        return null
    }

    return (data || null) as User | null
}

export async function updateUserName(userId: string, name: string): Promise<void> {
    const nextName = (name || '').trim()
    if (!nextName) return

    const { error } = await supabase
        .from('users')
        .update({ name: nextName })
        .eq('id', userId)

    if (error) {
        console.warn('[DB] Failed to update user name:', error.message)
    }
}

export async function setUserAlias(userId: string, alias: string | null | undefined): Promise<void> {
    if (!userId) return
    const nextAlias = typeof alias === 'string' ? alias.trim() : ''
    const payload = nextAlias ? nextAlias : null

    const { error } = await supabase
        .from('users')
        .update({ alias: payload })
        .eq('id', userId)

    if (error) {
        console.warn('[DB] Failed to set user alias:', error.message)
        throw new Error(error.message || 'Failed to set user alias')
    }
}

export async function assignUserToAgentIfUnassigned(
    userId: string,
    agent: { userId: string; name: string; color: string }
): Promise<User | null> {
    if (!userId || !agent?.userId) return getUserById(userId)
    const agentName = (agent.name || '').trim() || agent.userId
    const agentColor = (agent.color || '').trim() || '#6b7280'
    const assignedAt = new Date().toISOString()

    const { data, error } = await supabase
        .from('users')
        .update({
            assigned_to_user_id: agent.userId,
            assigned_to_name: agentName,
            assigned_to_color: agentColor,
            assigned_at: assignedAt
        })
        .eq('id', userId)
        .is('assigned_to_user_id', null)
        .select('*')
        .maybeSingle()

    if (error) {
        console.warn('[DB] Failed to assign user to agent:', error.message)
        return null
    }

    if (data) return data as User
    return getUserById(userId)
}

export async function setUserAssignee(
    userId: string,
    agent: { userId: string; name?: string; color?: string } | null
): Promise<User | null> {
    if (!userId) return null

    const updates = agent?.userId
        ? {
            assigned_to_user_id: agent.userId,
            assigned_to_name: (agent.name || '').trim() || agent.userId,
            assigned_to_color: (agent.color || '').trim() || '#6b7280',
            assigned_at: new Date().toISOString()
        }
        : {
            assigned_to_user_id: null,
            assigned_to_name: null,
            assigned_to_color: null,
            assigned_at: null
        }

    const { data, error } = await supabase
        .from('users')
        .update(updates)
        .eq('id', userId)
        .select('*')
        .maybeSingle()

    if (error) {
        console.warn('[DB] Failed to set user assignee:', error.message)
        return null
    }

    if (data) return data as User
    return getUserById(userId)
}

export async function setUserTemplateAttributes(
    userId: string,
    templateNameInput: string,
    languageInput: string,
    attributesInput: TemplateAttributeInput[]
): Promise<User | null> {
    if (!userId) return null

    const templateName = sanitizeTemplateAttributeText(templateNameInput, TEMPLATE_ATTRIBUTE_TEMPLATE_MAX_LENGTH)
    if (!templateName) return getUserById(userId)
    const language = sanitizeTemplateAttributeText(languageInput, TEMPLATE_ATTRIBUTE_LANGUAGE_MAX_LENGTH) || 'en_US'
    const nowIso = new Date().toISOString()

    const incomingBySlot = new Map<string, UserTemplateAttribute>()
    if (Array.isArray(attributesInput)) {
        attributesInput.forEach((item: TemplateAttributeInput, index: number) => {
            const value = sanitizeTemplateAttributeText(item?.value, TEMPLATE_ATTRIBUTE_VALUE_MAX_LENGTH)
            if (!value) return
            const parsedIndex = Number.parseInt(String(item?.index ?? index + 1), 10)
            const slotIndex = Number.isFinite(parsedIndex) && parsedIndex > 0 ? Math.min(parsedIndex, 99) : index + 1
            const scope = normalizeTemplateAttributeScope(item?.scope)
            const fallbackKey = `${scope === 'header' ? 'Header' : 'Body'} {{${slotIndex}}}`
            const key = sanitizeTemplateAttributeText(item?.key, TEMPLATE_ATTRIBUTE_KEY_MAX_LENGTH) || fallbackKey
            const slot = `${scope}:${slotIndex}`
            incomingBySlot.set(slot, {
                templateName,
                language,
                scope,
                index: slotIndex,
                key,
                value,
                savedAt: nowIso
            })
        })
    }

    if (incomingBySlot.size === 0) return getUserById(userId)

    const current = await getUserById(userId)
    const existing = sanitizeStoredTemplateAttributes(current?.template_attributes)
    const normalizedTemplateName = templateName.toLowerCase()
    const incomingSlots = new Set(incomingBySlot.keys())

    const carry = existing.filter((item) => {
        if (item.templateName.toLowerCase() !== normalizedTemplateName) return true
        return !incomingSlots.has(`${item.scope}:${item.index}`)
    })

    const merged = [...incomingBySlot.values(), ...carry]
        .sort((a, b) => {
            const aMs = new Date(a.savedAt).getTime()
            const bMs = new Date(b.savedAt).getTime()
            if (Number.isNaN(aMs) && Number.isNaN(bMs)) return 0
            if (Number.isNaN(aMs)) return 1
            if (Number.isNaN(bMs)) return -1
            return bMs - aMs
        })
        .slice(0, TEMPLATE_ATTRIBUTE_MAX_ITEMS)

    const { data, error } = await supabase
        .from('users')
        .update({ template_attributes: merged })
        .eq('id', userId)
        .select('*')
        .maybeSingle()

    if (error) {
        console.warn('[DB] Failed to set user template attributes:', error.message)
        return null
    }

    if (data) return data as User
    return getUserById(userId)
}

export async function insertMessage(record: {
    userId: string
    profileId?: string | null
    direction: 'in' | 'out'
    content: any
    workflowState?: any | null
    createdAt?: string | null
}): Promise<MessageRecord | null> {
    const normalizedProfileId = normalizeOptionalProfileId(record.profileId)
    const payload: any = {
        user_id: record.userId,
        direction: record.direction,
        content: record.content,
        workflow_state: record.workflowState ?? null,
        ...(normalizedProfileId ? { profile_id: normalizedProfileId } : {})
    }
    if (record.createdAt) {
        payload.created_at = record.createdAt
    }

    let data: any = null
    let error: any = null

    const insertResult = await supabase
        .from('messages')
        .insert(payload)
        .select('*')
        .single()
    data = insertResult.data
    error = insertResult.error

    if (error && normalizedProfileId && isMissingColumnError(error)) {
        const fallbackPayload = { ...payload }
        delete fallbackPayload.profile_id
        const fallbackResult = await supabase
            .from('messages')
            .insert(fallbackPayload)
            .select('*')
            .single()
        data = fallbackResult.data
        error = fallbackResult.error
    }

    if (error) {
        console.warn('[DB] Failed to insert message:', error.message)
        return null
    }

    return data as MessageRecord
}

export async function getLastMessage(userId: string): Promise<MessageRecord | null> {
    const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (error) {
        console.warn('[DB] Failed to load last message:', error.message)
        return null
    }

    return data as MessageRecord | null
}

export async function getLatestWorkflowMemory(
    userId: string
): Promise<{
    vars: Record<string, string>
    qa_history: Array<{ key: string; question: string; answer: string; at: string }>
}> {
    if (!userId) {
        return { vars: {}, qa_history: [] }
    }

    const { data, error } = await supabase
        .from('messages')
        .select('workflow_state')
        .eq('user_id', userId)
        .not('workflow_state', 'is', null)
        .order('created_at', { ascending: false })
        .limit(200)

    if (error) {
        console.warn('[DB] Failed to load workflow memory:', error.message)
        return { vars: {}, qa_history: [] }
    }

    let vars: Record<string, string> | null = null
    let qaHistory:
        | Array<{ key: string; question: string; answer: string; at: string }>
        | null = null

    for (const row of data || []) {
        const state = row?.workflow_state
        if (!state || typeof state !== 'object') continue

        if (!vars && state.vars && typeof state.vars === 'object') {
            const nextVars: Record<string, string> = {}
            Object.entries(state.vars as Record<string, unknown>).forEach(([k, v]) => {
                if (typeof k !== 'string') return
                const key = k.trim()
                if (!key) return
                if (v === null || v === undefined) return
                nextVars[key] = String(v)
            })
            if (Object.keys(nextVars).length > 0) {
                vars = nextVars
            }
        }

        if (!qaHistory && Array.isArray(state.qa_history)) {
            const nextHistory = state.qa_history
                .map((entry: any) => ({
                    key: typeof entry?.key === 'string' ? entry.key : '',
                    question: typeof entry?.question === 'string' ? entry.question : '',
                    answer: typeof entry?.answer === 'string' ? entry.answer : '',
                    at: typeof entry?.at === 'string' ? entry.at : ''
                }))
                .filter((entry: any) => entry.key && entry.answer)
            if (nextHistory.length > 0) {
                qaHistory = nextHistory
            }
        }

        if (vars && qaHistory) break
    }

    return {
        vars: vars || {},
        qa_history: qaHistory || []
    }
}

export async function getLastInboundTimestamp(userId: string): Promise<string | null> {
    const { data: userData, error: userError } = await supabase
        .from('users')
        .select('last_inbound_at')
        .eq('id', userId)
        .maybeSingle()

    if (userError) {
        console.warn('[DB] Failed to load user last_inbound_at:', userError.message)
    } else if (userData?.last_inbound_at) {
        return userData.last_inbound_at
    }

    const { data, error } = await supabase
        .from('messages')
        .select('created_at')
        .eq('user_id', userId)
        .eq('direction', 'in')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (error) {
        console.warn('[DB] Failed to load last inbound timestamp:', error.message)
        return null
    }

    return data?.created_at || null
}

export async function updateUserLastInbound(userId: string, inboundAt?: string | null): Promise<void> {
    const timestamp = inboundAt || new Date().toISOString()
    const { error } = await supabase
        .from('users')
        .update({ last_inbound_at: timestamp })
        .eq('id', userId)

    if (error) {
        console.warn('[DB] Failed to update last_inbound_at:', error.message)
    }
}

function shouldAdvanceMessageStatus(currentStatus: string, nextStatus: string): boolean {
    const current = (currentStatus || '').toLowerCase().trim()
    const next = (nextStatus || '').toLowerCase().trim()
    if (!next) return false
    if (!current) return true
    if (current === next) return false

    // Never downgrade from final positive delivery states.
    if (current === 'read') return false
    if (current === 'delivered' && (next === 'sent' || next === 'failed' || next === 'pending')) return false

    const rank: Record<string, number> = {
        pending: 0,
        sent: 1,
        failed: 1,
        delivered: 2,
        read: 3
    }
    const currentRank = rank[current] ?? -1
    const nextRank = rank[next] ?? -1

    const sentRank = rank.sent ?? 1
    if (current === 'failed' && nextRank >= sentRank) return true
    return nextRank >= currentRank
}

type StatusUpdateMeta = {
    timestamp?: number
    recipientId?: string
    recipientType?: string
    recipientParticipantId?: string
    participantRecipientId?: string
    conversation?: any
    pricing?: any
}

export async function updateMessageStatusByMessageId(
    messageId: string,
    status: string,
    meta: StatusUpdateMeta = {},
    profileId?: string | null
): Promise<MessageRecord | null> {
    if (!messageId) return null

    const normalizedProfileId = normalizeOptionalProfileId(profileId)

    let existing: any = null
    let fetchError: any = null

    let lookupQuery = supabase
        .from('messages')
        .select('id, content')
        .eq('content->>message_id', messageId)
        .order('created_at', { ascending: false })
        .limit(1)

    if (normalizedProfileId) {
        const scopedLookup = await lookupQuery.eq('profile_id', normalizedProfileId).maybeSingle()
        existing = scopedLookup.data
        fetchError = scopedLookup.error
        if (fetchError && isMissingColumnError(fetchError)) {
            const fallbackLookup = await supabase
                .from('messages')
                .select('id, content')
                .eq('content->>message_id', messageId)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle()
            existing = fallbackLookup.data
            fetchError = fallbackLookup.error
        }
    } else {
        const unscopedLookup = await lookupQuery.maybeSingle()
        existing = unscopedLookup.data
        fetchError = unscopedLookup.error
    }

    if (fetchError) {
        console.warn('[DB] Failed to lookup message by message_id:', fetchError.message)
        return null
    }

    if (!existing) return null

    const currentContent = (existing.content && typeof existing.content === 'object') ? existing.content : {}
    const currentStatus = typeof currentContent.status === 'string' ? currentContent.status : ''
    const shouldUpdateStatus = shouldAdvanceMessageStatus(currentStatus, status)
    const participantId = meta.recipientParticipantId || meta.participantRecipientId || ''
    const timestamp = Number.isFinite(Number(meta.timestamp)) ? Number(meta.timestamp) : 0

    const groupStatusesRaw =
        currentContent.group_statuses && typeof currentContent.group_statuses === 'object'
            ? currentContent.group_statuses
            : {}
    const groupStatuses = { ...groupStatusesRaw } as Record<string, any>
    if ((meta.recipientType || '').toLowerCase() === 'group') {
        const participantKey = participantId || 'group'
        const previous = groupStatuses[participantKey]
        const previousStatus = typeof previous?.status === 'string' ? previous.status : ''
        if (!previousStatus || shouldAdvanceMessageStatus(previousStatus, status)) {
            groupStatuses[participantKey] = {
                status,
                timestamp: timestamp || previous?.timestamp || 0,
                recipient_id: meta.recipientId || null,
                recipient_type: meta.recipientType || null,
                recipient_participant_id: participantId || null,
                conversation: meta.conversation || null,
                pricing: meta.pricing || null
            }
        }
    }

    const nextContent: Record<string, any> = {
        ...currentContent,
        ...(shouldUpdateStatus ? { status } : {}),
        ...(Object.keys(groupStatuses).length > 0 ? { group_statuses: groupStatuses } : {})
    }

    if (meta.recipientId || meta.recipientType || participantId || meta.conversation || meta.pricing || timestamp) {
        nextContent.last_status_event = {
            status,
            timestamp: timestamp || null,
            recipient_id: meta.recipientId || null,
            recipient_type: meta.recipientType || null,
            recipient_participant_id: participantId || null,
            conversation: meta.conversation || null,
            pricing: meta.pricing || null
        }
    }

    const { data, error } = await supabase
        .from('messages')
        .update({ content: nextContent })
        .eq('id', existing.id)
        .select('*')
        .maybeSingle()

    if (error) {
        console.warn('[DB] Failed to update message status:', error.message)
        return null
    }

    return data as MessageRecord | null
}

export async function updateMessageWorkflowState(messageId: string, workflowState: any): Promise<MessageRecord | null> {
    if (!messageId) return null

    const { data, error } = await supabase
        .from('messages')
        .update({ workflow_state: workflowState ?? null })
        .eq('id', messageId)
        .select('*')
        .maybeSingle()

    if (error) {
        console.warn('[DB] Failed to update message workflow_state:', error.message)
        return null
    }

    return data as MessageRecord | null
}

const WINDOW_MS = 24 * 60 * 60 * 1000

export async function getUsersWithExpiringWindow(companyId: string, minutes: number, profileId?: string | null): Promise<User[]> {
    if (!minutes || minutes <= 0) return []
    const thresholdMs = minutes * 60 * 1000
    const earliestInbound = new Date(Date.now() - WINDOW_MS).toISOString()
    const normalizedProfileId = normalizeOptionalProfileId(profileId)

    let data: any[] | null = null
    let error: any = null

    let query = supabase
        .from('users')
        .select('*')
        .eq('company_id', companyId)
        .not('last_inbound_at', 'is', null)
        .gte('last_inbound_at', earliestInbound)

    if (normalizedProfileId) {
        const scopedResult = await query.eq('profile_id', normalizedProfileId)
        data = scopedResult.data || null
        error = scopedResult.error
        if (error && isMissingColumnError(error)) {
            const fallbackResult = await supabase
                .from('users')
                .select('*')
                .eq('company_id', companyId)
                .not('last_inbound_at', 'is', null)
                .gte('last_inbound_at', earliestInbound)
            data = fallbackResult.data || null
            error = fallbackResult.error
        }
    } else {
        const unscopedResult = await query
        data = unscopedResult.data || null
        error = unscopedResult.error
    }

    if (error) {
        console.warn('[DB] Failed to load users for window reminder:', error.message)
        return []
    }

    const now = Date.now()
    return (data || []).filter((u: any) => {
        if (!u.last_inbound_at) return false
        const lastInboundMs = new Date(u.last_inbound_at).getTime()
        if (Number.isNaN(lastInboundMs)) return false
        const remaining = lastInboundMs + WINDOW_MS - now
        if (remaining <= 0 || remaining > thresholdMs) return false
        if (u.last_window_reminder_at) {
            const lastReminderMs = new Date(u.last_window_reminder_at).getTime()
            if (!Number.isNaN(lastReminderMs) && lastReminderMs >= lastInboundMs) {
                return false
            }
        }
        return true
    }) as User[]
}

export async function updateUserWindowReminder(userId: string, timestamp?: string | null): Promise<void> {
    const value = timestamp || new Date().toISOString()
    const { error } = await supabase
        .from('users')
        .update({ last_window_reminder_at: value })
        .eq('id', userId)

    if (error) {
        console.warn('[DB] Failed to update last_window_reminder_at:', error.message)
    }
}

export async function getWorkflows(companyId: string): Promise<any[]> {
    const { data, error } = await supabase
        .from('workflows')
        .select('*')
        .eq('company_id', companyId)

    if (error) {
        console.warn('[DB] Failed to load workflows:', error.message)
        return []
    }

    return (data || []).filter((workflow: any) => {
        const builderEnabled =
            typeof workflow?.builder?.meta?.enabled === 'boolean'
                ? workflow.builder.meta.enabled
                : undefined
        if (workflow?.enabled === false) return false
        if (builderEnabled === false) return false
        return true
    })
}

export async function getWorkflowById(workflowId: string, companyId?: string): Promise<any | null> {
    let query = supabase
        .from('workflows')
        .select('*')
        .eq('id', workflowId)
    if (companyId) {
        query = query.eq('company_id', companyId)
    }
    const { data, error } = await query.maybeSingle()

    if (error) {
        console.warn('[DB] Failed to load workflow:', error.message)
        return null
    }

    return data
}

export async function getUsersForCompany(companyId: string, profileId?: string | null): Promise<User[]> {
    const normalizedProfileId = normalizeOptionalProfileId(profileId)
    const primarySelect = 'id, company_id, profile_id, phone_number, name, alias, tags, last_inbound_at, last_window_reminder_at, assigned_to_user_id, assigned_to_name, assigned_to_color, assigned_at, cta_referral_at, cta_referral_source, cta_free_window_started_at, cta_free_window_expires_at, template_attributes'
    const fallbackSelectWithAlias = 'id, company_id, phone_number, name, alias, tags, last_inbound_at, last_window_reminder_at, assigned_to_user_id, assigned_to_name, assigned_to_color, assigned_at'
    const fallbackSelectLegacy = 'id, company_id, phone_number, name, tags, last_inbound_at, last_window_reminder_at, assigned_to_user_id, assigned_to_name, assigned_to_color, assigned_at'

    let data: any[] | null = null
    let error: any = null

    let primaryQuery = supabase
        .from('users')
        .select(primarySelect)
        .eq('company_id', companyId)
    if (normalizedProfileId) {
        primaryQuery = primaryQuery.eq('profile_id', normalizedProfileId)
    }
    const primaryResult = await primaryQuery
    data = primaryResult.data || null
    error = primaryResult.error

    if (error && isMissingColumnError(error)) {
        console.warn('[DB] users schema is missing newer columns, using fallback user projection.')
        let fallbackData: any[] | null = null
        let fallbackError: any = null

        const withAliasResult = await supabase
            .from('users')
            .select(fallbackSelectWithAlias)
            .eq('company_id', companyId)
        fallbackData = withAliasResult.data || null
        fallbackError = withAliasResult.error

        if (fallbackError && isMissingColumnError(fallbackError)) {
            const legacyResult = await supabase
                .from('users')
                .select(fallbackSelectLegacy)
                .eq('company_id', companyId)
            fallbackData = legacyResult.data || null
            fallbackError = legacyResult.error
        }

        if (fallbackError) {
            console.warn('[DB] Failed to load users (fallback):', fallbackError.message)
            return []
        }

        return (fallbackData || []).map((row: any) => {
            const alias = typeof row?.alias === 'string' ? row.alias : null
            return {
                ...row,
                alias,
                profile_id: normalizeOptionalProfileId(row?.profile_id),
                cta_referral_at: null,
                cta_referral_source: null,
                cta_free_window_started_at: null,
                cta_free_window_expires_at: null,
                template_attributes: []
            }
        }) as User[]
    }

    if (error) {
        console.warn('[DB] Failed to load users:', error.message)
        return []
    }

    return (data || []) as User[]
}

export async function getMessagesForUsers(userIds: string[], limit = 500): Promise<MessageRecord[]> {
    if (userIds.length === 0) return []

    const { data, error } = await supabase
        .from('messages')
        .select('*')
        .in('user_id', userIds)
        .order('created_at', { ascending: false })
        .limit(limit)

    if (error) {
        console.warn('[DB] Failed to load messages:', error.message)
        return []
    }

    return (data || []) as MessageRecord[]
}

export async function getMessagesForUsersSince(
    userIds: string[],
    sinceTimestamp: number,
    limit = 200
): Promise<MessageRecord[]> {
    if (userIds.length === 0) return []

    const parsedSince = Number(sinceTimestamp)
    if (!Number.isFinite(parsedSince) || parsedSince <= 0) {
        return getMessagesForUsers(userIds, limit)
    }

    const sinceIso = new Date(Math.floor(parsedSince) * 1000).toISOString()
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)))

    const { data, error } = await supabase
        .from('messages')
        .select('*')
        .in('user_id', userIds)
        .gt('created_at', sinceIso)
        .order('created_at', { ascending: false })
        .limit(boundedLimit)

    if (error) {
        console.warn('[DB] Failed to load incremental messages:', error.message)
        return []
    }

    return (data || []) as MessageRecord[]
}
