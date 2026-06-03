import { createHash } from 'crypto'

export type MetaWebhookEventType = 'message' | 'status' | 'call' | 'coexistence_history' | 'call_permission_reply' | 'unknown'
export type StoredCallStatus = 'ringing' | 'accepting' | 'accepted' | 'answered' | 'rejected' | 'terminated' | 'missed' | 'failed' | 'unknown'
export type StoredCallPermissionStatus = 'approved' | 'rejected' | 'unknown'

type SupabaseClientLike = any

function trimText(value: any): string {
    return typeof value === 'string' ? value.trim() : ''
}

function isMissingTableError(error: any, tableName: string): boolean {
    const code = typeof error?.code === 'string' ? error.code : ''
    const message = String(error?.message || '').toLowerCase()
    if (code === 'PGRST205') {
        return message.includes(tableName.toLowerCase())
    }
    if (code !== '42P01' && code !== '42703') return false
    return message.includes(tableName.toLowerCase())
}

function cloneJson<T = any>(value: T): T {
    if (value === undefined) return null as T
    try {
        return JSON.parse(JSON.stringify(value))
    } catch {
        return value
    }
}

function mergePreferred<T>(preferred: T, fallback: T): T {
    if (preferred === undefined || preferred === null) return fallback
    if (typeof preferred === 'string' && !preferred.trim()) return fallback
    return preferred
}

function normalizeNullableText(value: any): string | null {
    const text = trimText(value)
    return text || null
}

function normalizeStoredCallStatusValue(value: any): StoredCallStatus {
    const normalized = trimText(value).toLowerCase()
    switch (normalized) {
        case 'ringing':
        case 'accepting':
        case 'accepted':
        case 'answered':
        case 'rejected':
        case 'terminated':
        case 'missed':
        case 'failed':
            return normalized
        case 'connected':
            return 'answered'
        default:
            return 'unknown'
    }
}

function isTerminalStoredCallStatus(status: StoredCallStatus): boolean {
    return status === 'rejected' || status === 'terminated' || status === 'missed' || status === 'failed'
}

function getStoredCallStatusRank(status: StoredCallStatus): number {
    switch (status) {
        case 'ringing':
            return 10
        case 'accepting':
            return 20
        case 'accepted':
            return 30
        case 'answered':
            return 40
        default:
            return 0
    }
}

function mergeStoredCallStatus(preferred: any, fallback: any): StoredCallStatus | null {
    const preferredStatus = normalizeStoredCallStatusValue(preferred)
    const fallbackStatus = normalizeStoredCallStatusValue(fallback)

    if (preferredStatus === 'unknown') {
        return fallbackStatus === 'unknown' ? null : fallbackStatus
    }
    if (fallbackStatus === 'unknown') {
        return preferredStatus
    }
    if (isTerminalStoredCallStatus(preferredStatus)) {
        return preferredStatus
    }
    if (isTerminalStoredCallStatus(fallbackStatus)) {
        return fallbackStatus
    }
    return getStoredCallStatusRank(preferredStatus) >= getStoredCallStatusRank(fallbackStatus)
        ? preferredStatus
        : fallbackStatus
}

function toIsoTimestamp(value: any): string | null {
    if (value === null || value === undefined || value === '') return null
    const numeric = Number(value)
    if (Number.isFinite(numeric) && numeric > 0) {
        const millis = numeric > 10_000_000_000 ? numeric : numeric * 1000
        const date = new Date(millis)
        if (!Number.isNaN(date.getTime())) return date.toISOString()
    }

    if (typeof value === 'string') {
        const date = new Date(value)
        if (!Number.isNaN(date.getTime())) return date.toISOString()
    }

    return null
}

function normalizeArray(value: any): any[] {
    return Array.isArray(value) ? value : []
}

function appendHistory(existing: any, entry: any, maxEntries = 40): any[] {
    const current = normalizeArray(existing)
    const next = [...current, cloneJson(entry)].slice(-maxEntries)
    return next
}

export function buildWebhookDedupeKey(params: {
    entryId?: string | null
    changeField?: string | null
    phoneNumberId?: string | null
    objectId?: string | null
    timestamp?: string | number | null
    eventType?: string | null
    raw?: any
}): string {
    const basis = {
        entry_id: trimText(params.entryId),
        change_field: trimText(params.changeField),
        phone_number_id: trimText(params.phoneNumberId),
        object_id: trimText(params.objectId),
        timestamp: params.timestamp ?? null,
        event_type: trimText(params.eventType),
        raw: cloneJson(params.raw ?? null)
    }
    return createHash('sha256').update(JSON.stringify(basis)).digest('hex')
}

export function deriveStoredCallStatus(params: {
    event?: any
    status?: any[]
    hasErrors?: boolean
    timestamp?: any
}): StoredCallStatus {
    if (params.hasErrors) return 'failed'
    const event = trimText(params.event).toLowerCase()
    const statusValues = normalizeArray(params.status)
        .map((value) => trimText(value).toLowerCase())
        .filter(Boolean)

    if (statusValues.includes('rejected') || event === 'reject') return 'rejected'
    if (statusValues.includes('terminated') || event === 'terminate') return 'terminated'
    if (statusValues.includes('failed') || event === 'fail' || event === 'failed') return 'failed'
    if (statusValues.includes('missed')) return 'missed'
    if (statusValues.includes('accepted') || statusValues.includes('connected') || event === 'accept') return 'answered'

    const timestampIso = toIsoTimestamp(params.timestamp)
    if (event === 'connect') {
        if (timestampIso) {
            const ageMs = Date.now() - new Date(timestampIso).getTime()
            if (Number.isFinite(ageMs) && ageMs > 3 * 60 * 1000) {
                return 'missed'
            }
        }
        return 'ringing'
    }

    return 'unknown'
}

export function normalizeStoredCallPermissionStatus(params: {
    response?: any
    isPermanent?: any
    expirationTimestamp?: any
}): StoredCallPermissionStatus {
    const response = trimText(params.response).toLowerCase()
    if (response === 'reject' || response === 'rejected' || response === 'deny' || response === 'denied') {
        return 'rejected'
    }
    if (response === 'accept' || response === 'approved') {
        const expirationIso = toIsoTimestamp(params.expirationTimestamp)
        const isPermanent = params.isPermanent === true
        if (isPermanent) return 'approved'
        if (expirationIso && new Date(expirationIso).getTime() > Date.now()) return 'approved'
        if (expirationIso) return 'unknown'
        return 'approved'
    }
    return 'unknown'
}

export function isStoredCallPermissionCurrentlyApproved(row: any): boolean {
    const status = trimText(row?.permission_status).toLowerCase()
    if (status !== 'approved') return false
    if (row?.is_permanent === true) return true
    const expirationIso = toIsoTimestamp(row?.expiration_timestamp)
    if (!expirationIso) return false
    return new Date(expirationIso).getTime() > Date.now()
}

export async function persistRawWebhookEvent(supabase: SupabaseClientLike, params: {
    companyId?: string | null
    profileId?: string | null
    phoneNumberId?: string | null
    wabaId?: string | null
    webhookField?: string | null
    eventType: MetaWebhookEventType
    objectId?: string | null
    dedupeKey: string
    occurredAt?: string | null
    payload: any
    processed?: boolean
    processedAt?: string | null
    processingError?: string | null
}) {
    const payload = {
        company_id: trimText(params.companyId) || null,
        profile_id: trimText(params.profileId) || null,
        phone_number_id: trimText(params.phoneNumberId) || null,
        waba_id: trimText(params.wabaId) || null,
        webhook_field: trimText(params.webhookField) || null,
        event_type: params.eventType,
        object_id: trimText(params.objectId) || null,
        dedupe_key: params.dedupeKey,
        occurred_at: trimText(params.occurredAt) || null,
        payload: cloneJson(params.payload ?? null),
        processed: params.processed === true,
        processed_at: params.processedAt || (params.processed ? new Date().toISOString() : null),
        processing_error: trimText(params.processingError) || null
    }

    const { data, error } = await supabase
        .from('whatsapp_raw_webhook_events')
        .upsert(payload, { onConflict: 'dedupe_key' })
        .select('*')
        .maybeSingle()

    if (error) {
        if (isMissingTableError(error, 'whatsapp_raw_webhook_events')) return null
        throw error
    }

    return data || payload
}

export async function upsertWhatsappImportedHistoryMessage(supabase: SupabaseClientLike, params: {
    companyId?: string | null
    profileId?: string | null
    phoneNumberId?: string | null
    wabaId?: string | null
    dedupeKey: string
    source?: string | null
    messageId?: string | null
    customerWaId?: string | null
    direction?: string | null
    messageType?: string | null
    messageTimestamp?: string | null
    payload: any
}) {
    const row = {
        company_id: trimText(params.companyId) || null,
        profile_id: trimText(params.profileId) || null,
        phone_number_id: trimText(params.phoneNumberId) || null,
        waba_id: trimText(params.wabaId) || null,
        source: trimText(params.source) || 'coexistence_history',
        dedupe_key: params.dedupeKey,
        message_id: trimText(params.messageId) || null,
        customer_wa_id: trimText(params.customerWaId) || null,
        direction: trimText(params.direction) || null,
        message_type: trimText(params.messageType) || null,
        message_timestamp: trimText(params.messageTimestamp) || null,
        payload: cloneJson(params.payload ?? null)
    }

    const { data, error } = await supabase
        .from('whatsapp_imported_history_messages')
        .upsert(row, { onConflict: 'dedupe_key' })
        .select('*')
        .maybeSingle()

    if (error) {
        if (isMissingTableError(error, 'whatsapp_imported_history_messages')) return null
        throw error
    }

    return data || row
}

export async function touchWhatsappConnectionWebhook(supabase: SupabaseClientLike, params: {
    companyId?: string | null
    profileId?: string | null
    phoneNumberId?: string | null
    wabaId?: string | null
    lastWebhookAt?: string | null
}) {
    const companyId = trimText(params.companyId)
    const profileId = trimText(params.profileId)
    const phoneNumberId = trimText(params.phoneNumberId)
    const wabaId = trimText(params.wabaId)
    if (!companyId && !profileId && !phoneNumberId && !wabaId) return null

    let query = supabase
        .from('whatsapp_connections')
        .update({
            last_webhook_at: params.lastWebhookAt || new Date().toISOString(),
            updated_at: new Date().toISOString()
        })

    if (companyId) query = query.eq('company_id', companyId)
    if (profileId) query = query.eq('profile_id', profileId)
    if (phoneNumberId) query = query.eq('phone_number_id', phoneNumberId)
    if (wabaId) query = query.eq('waba_id', wabaId)

    const { error } = await query
    if (error && !isMissingTableError(error, 'whatsapp_connections')) {
        throw error
    }
    return true
}

export async function upsertWhatsappCall(supabase: SupabaseClientLike, params: {
    companyId?: string | null
    profileId?: string | null
    phoneNumberId: string
    wabaId?: string | null
    callId: string
    customerWaId?: string | null
    customerName?: string | null
    businessWaId?: string | null
    direction?: string | null
    event?: string | null
    status?: string | null
    historyEntry?: any
    sessionSdpType?: string | null
    sessionSdp?: string | null
    startTime?: string | null
    endTime?: string | null
    durationSeconds?: number | null
    deeplinkPayload?: string | null
    ctaPayload?: string | null
    bizOpaqueCallbackData?: string | null
    rawPayload?: any
    metaResponse?: any
    metaError?: any
    lastAction?: string | null
    lastActionAt?: string | null
    lastEventAt?: string | null
    acceptedByUserId?: string | null
    acceptedByName?: string | null
    acceptedAt?: string | null
    claimExpiresAt?: string | null
    acceptLockToken?: string | null
}) {
    const phoneNumberId = trimText(params.phoneNumberId)
    const callId = trimText(params.callId)
    if (!phoneNumberId || !callId) return null

    const { data: existing, error: fetchError } = await supabase
        .from('whatsapp_calls')
        .select('*')
        .eq('phone_number_id', phoneNumberId)
        .eq('call_id', callId)
        .maybeSingle()

    if (fetchError && !isMissingTableError(fetchError, 'whatsapp_calls')) {
        throw fetchError
    }

    const nextHistory = params.historyEntry
        ? appendHistory(existing?.status_history, params.historyEntry)
        : normalizeArray(existing?.status_history)
    const nowIso = new Date().toISOString()
    const row = {
        company_id: trimText(params.companyId) || trimText(existing?.company_id) || null,
        profile_id: trimText(params.profileId) || trimText(existing?.profile_id) || null,
        phone_number_id: phoneNumberId,
        waba_id: trimText(params.wabaId) || trimText(existing?.waba_id) || null,
        call_id: callId,
        customer_wa_id: mergePreferred(trimText(params.customerWaId) || null, trimText(existing?.customer_wa_id) || null),
        customer_name: mergePreferred(trimText(params.customerName) || null, trimText(existing?.customer_name) || null),
        business_wa_id: mergePreferred(trimText(params.businessWaId) || null, trimText(existing?.business_wa_id) || null),
        direction: mergePreferred(trimText(params.direction) || null, trimText(existing?.direction) || null),
        event: mergePreferred(trimText(params.event) || null, trimText(existing?.event) || null),
        status: mergeStoredCallStatus(params.status, existing?.status),
        status_history: nextHistory,
        session_sdp_type: mergePreferred(trimText(params.sessionSdpType) || null, trimText(existing?.session_sdp_type) || null),
        session_sdp: mergePreferred(trimText(params.sessionSdp) || null, trimText(existing?.session_sdp) || null),
        start_time: mergePreferred(trimText(params.startTime) || null, trimText(existing?.start_time) || null),
        end_time: mergePreferred(trimText(params.endTime) || null, trimText(existing?.end_time) || null),
        duration_seconds: params.durationSeconds ?? existing?.duration_seconds ?? null,
        deeplink_payload: mergePreferred(trimText(params.deeplinkPayload) || null, trimText(existing?.deeplink_payload) || null),
        cta_payload: mergePreferred(trimText(params.ctaPayload) || null, trimText(existing?.cta_payload) || null),
        biz_opaque_callback_data: mergePreferred(trimText(params.bizOpaqueCallbackData) || null, trimText(existing?.biz_opaque_callback_data) || null),
        raw_payload: params.rawPayload !== undefined ? cloneJson(params.rawPayload) : (existing?.raw_payload ?? null),
        meta_response: params.metaResponse !== undefined ? cloneJson(params.metaResponse) : (existing?.meta_response ?? null),
        meta_error: params.metaError !== undefined ? cloneJson(params.metaError) : (existing?.meta_error ?? null),
        last_action: mergePreferred(trimText(params.lastAction) || null, trimText(existing?.last_action) || null),
        last_action_at: mergePreferred(trimText(params.lastActionAt) || null, trimText(existing?.last_action_at) || null),
        last_event_at: mergePreferred(trimText(params.lastEventAt) || null, trimText(existing?.last_event_at) || null),
        accepted_by_user_id: params.acceptedByUserId !== undefined
            ? normalizeNullableText(params.acceptedByUserId)
            : normalizeNullableText(existing?.accepted_by_user_id),
        accepted_by_name: params.acceptedByName !== undefined
            ? normalizeNullableText(params.acceptedByName)
            : normalizeNullableText(existing?.accepted_by_name),
        accepted_at: params.acceptedAt !== undefined
            ? params.acceptedAt || null
            : (existing?.accepted_at ?? null),
        claim_expires_at: params.claimExpiresAt !== undefined
            ? params.claimExpiresAt || null
            : (existing?.claim_expires_at ?? null),
        accept_lock_token: params.acceptLockToken !== undefined
            ? normalizeNullableText(params.acceptLockToken)
            : normalizeNullableText(existing?.accept_lock_token),
        updated_at: nowIso,
        created_at: trimText(existing?.created_at) || nowIso
    }

    const { data, error } = await supabase
        .from('whatsapp_calls')
        .upsert(row, { onConflict: 'phone_number_id,call_id' })
        .select('*')
        .maybeSingle()

    if (error) {
        if (isMissingTableError(error, 'whatsapp_calls')) return null
        throw error
    }

    return data || row
}

export async function insertWhatsappCallPermissionRequest(supabase: SupabaseClientLike, params: {
    companyId?: string | null
    profileId?: string | null
    phoneNumberId: string
    customerWaId: string
    customerPhoneNumber?: string | null
    requestMessageId?: string | null
    bodyText?: string | null
    status?: string | null
    metaResponse?: any
    metaError?: any
}) {
    const nowIso = new Date().toISOString()
    const row = {
        company_id: trimText(params.companyId) || null,
        profile_id: trimText(params.profileId) || null,
        phone_number_id: trimText(params.phoneNumberId),
        customer_wa_id: trimText(params.customerWaId),
        customer_phone_number: trimText(params.customerPhoneNumber) || null,
        request_message_id: trimText(params.requestMessageId) || null,
        body_text: trimText(params.bodyText) || null,
        status: trimText(params.status) || 'pending',
        meta_response: params.metaResponse !== undefined ? cloneJson(params.metaResponse) : null,
        meta_error: params.metaError !== undefined ? cloneJson(params.metaError) : null,
        created_at: nowIso,
        updated_at: nowIso
    }

    const { data, error } = await supabase
        .from('whatsapp_call_permission_requests')
        .insert(row)
        .select('*')
        .maybeSingle()

    if (error) {
        if (isMissingTableError(error, 'whatsapp_call_permission_requests')) return null
        throw error
    }

    return data || row
}

export async function updateWhatsappCallPermissionRequestByMessageId(supabase: SupabaseClientLike, params: {
    requestMessageId: string
    status: string
    metaResponse?: any
    metaError?: any
}) {
    const requestMessageId = trimText(params.requestMessageId)
    if (!requestMessageId) return null

    const { data, error } = await supabase
        .from('whatsapp_call_permission_requests')
        .update({
            status: trimText(params.status) || 'updated',
            meta_response: params.metaResponse !== undefined ? cloneJson(params.metaResponse) : undefined,
            meta_error: params.metaError !== undefined ? cloneJson(params.metaError) : undefined,
            updated_at: new Date().toISOString()
        })
        .eq('request_message_id', requestMessageId)
        .select('*')

    if (error) {
        if (isMissingTableError(error, 'whatsapp_call_permission_requests')) return null
        throw error
    }

    return Array.isArray(data) ? data : []
}

export async function upsertWhatsappCallPermission(supabase: SupabaseClientLike, params: {
    companyId?: string | null
    profileId?: string | null
    phoneNumberId: string
    customerWaId: string
    customerPhoneNumber?: string | null
    permissionStatus: StoredCallPermissionStatus
    isPermanent?: boolean
    expirationTimestamp?: string | null
    responseSource?: string | null
    contextId?: string | null
    contextFrom?: string | null
    lastRequestMessageId?: string | null
    rawPayload?: any
}) {
    const phoneNumberId = trimText(params.phoneNumberId)
    const customerWaId = trimText(params.customerWaId)
    if (!phoneNumberId || !customerWaId) return null

    const { data: existing, error: fetchError } = await supabase
        .from('whatsapp_call_permissions')
        .select('*')
        .eq('phone_number_id', phoneNumberId)
        .eq('customer_wa_id', customerWaId)
        .maybeSingle()

    if (fetchError && !isMissingTableError(fetchError, 'whatsapp_call_permissions')) {
        throw fetchError
    }

    const nowIso = new Date().toISOString()
    const row = {
        company_id: trimText(params.companyId) || trimText(existing?.company_id) || null,
        profile_id: trimText(params.profileId) || trimText(existing?.profile_id) || null,
        phone_number_id: phoneNumberId,
        customer_wa_id: customerWaId,
        customer_phone_number: mergePreferred(trimText(params.customerPhoneNumber) || null, trimText(existing?.customer_phone_number) || null),
        permission_status: params.permissionStatus,
        is_permanent: params.isPermanent === true,
        expiration_timestamp: params.expirationTimestamp || null,
        response_source: mergePreferred(trimText(params.responseSource) || null, trimText(existing?.response_source) || null),
        context_id: mergePreferred(trimText(params.contextId) || null, trimText(existing?.context_id) || null),
        context_from: mergePreferred(trimText(params.contextFrom) || null, trimText(existing?.context_from) || null),
        last_request_message_id: mergePreferred(trimText(params.lastRequestMessageId) || null, trimText(existing?.last_request_message_id) || null),
        raw_payload: params.rawPayload !== undefined ? cloneJson(params.rawPayload) : (existing?.raw_payload ?? null),
        updated_at: nowIso,
        created_at: trimText(existing?.created_at) || nowIso
    }

    const { data, error } = await supabase
        .from('whatsapp_call_permissions')
        .upsert(row, { onConflict: 'phone_number_id,customer_wa_id' })
        .select('*')
        .maybeSingle()

    if (error) {
        if (isMissingTableError(error, 'whatsapp_call_permissions')) return null
        throw error
    }

    return data || row
}

export async function getStoredWhatsappCallPermission(supabase: SupabaseClientLike, params: {
    phoneNumberId: string
    customerWaId: string
}) {
    const { data, error } = await supabase
        .from('whatsapp_call_permissions')
        .select('*')
        .eq('phone_number_id', trimText(params.phoneNumberId))
        .eq('customer_wa_id', trimText(params.customerWaId))
        .maybeSingle()

    if (error) {
        if (isMissingTableError(error, 'whatsapp_call_permissions')) return null
        throw error
    }

    return data || null
}

export async function getStoredWhatsappCall(supabase: SupabaseClientLike, params: {
    companyId?: string | null
    profileId?: string | null
    phoneNumberId?: string | null
    callId: string
}) {
    const callId = trimText(params.callId)
    if (!callId) return null

    let query = supabase
        .from('whatsapp_calls')
        .select('*')
        .eq('call_id', callId)
        .order('updated_at', { ascending: false })
        .limit(1)

    const companyId = trimText(params.companyId)
    const profileId = trimText(params.profileId)
    const phoneNumberId = trimText(params.phoneNumberId)

    if (companyId) query = query.eq('company_id', companyId)
    if (profileId) query = query.eq('profile_id', profileId)
    if (phoneNumberId) query = query.eq('phone_number_id', phoneNumberId)

    const { data, error } = await query.maybeSingle()
    if (error) {
        if (isMissingTableError(error, 'whatsapp_calls')) return null
        throw error
    }

    return data || null
}

export async function claimWhatsappCallAcceptLock(supabase: SupabaseClientLike, params: {
    companyId?: string | null
    profileId?: string | null
    phoneNumberId: string
    callId: string
    acceptedByUserId: string
    acceptedByName?: string | null
    acceptedAt: string
    claimExpiresAt: string
    acceptLockToken: string
    historyEntry?: any
}) {
    const phoneNumberId = trimText(params.phoneNumberId)
    const callId = trimText(params.callId)
    const acceptedByUserId = trimText(params.acceptedByUserId)
    const acceptLockToken = trimText(params.acceptLockToken)
    if (!phoneNumberId || !callId || !acceptedByUserId || !acceptLockToken) return null

    let query = supabase
        .from('whatsapp_calls')
        .update({
            status: 'accepting',
            accepted_by_user_id: acceptedByUserId,
            accepted_by_name: normalizeNullableText(params.acceptedByName),
            accepted_at: params.acceptedAt,
            claim_expires_at: params.claimExpiresAt,
            accept_lock_token: acceptLockToken,
            last_action: 'pre_accept',
            last_action_at: params.acceptedAt,
            last_event_at: params.acceptedAt,
            updated_at: params.acceptedAt
        })
        .eq('phone_number_id', phoneNumberId)
        .eq('call_id', callId)
        .in('status', ['ringing'])

    const companyId = trimText(params.companyId)
    const profileId = trimText(params.profileId)
    if (companyId) query = query.eq('company_id', companyId)
    if (profileId) query = query.eq('profile_id', profileId)

    const { data, error } = await query.select('*')
    if (error) {
        if (isMissingTableError(error, 'whatsapp_calls')) return null
        throw error
    }

    const claimedRow = Array.isArray(data) ? data[0] || null : null
    if (!claimedRow) return null

    const historyEntry = params.historyEntry ?? {
        source: 'lock',
        action: 'claim_accept',
        status: 'accepting',
        accepted_by_user_id: acceptedByUserId,
        accepted_by_name: normalizeNullableText(params.acceptedByName),
        recorded_at: params.acceptedAt
    }
    const nextHistory = appendHistory(claimedRow?.status_history, historyEntry)

    const { data: finalized, error: finalizeError } = await supabase
        .from('whatsapp_calls')
        .update({
            status_history: nextHistory,
            updated_at: params.acceptedAt
        })
        .eq('phone_number_id', phoneNumberId)
        .eq('call_id', callId)
        .eq('accepted_by_user_id', acceptedByUserId)
        .eq('accept_lock_token', acceptLockToken)
        .select('*')
        .maybeSingle()

    if (finalizeError) {
        if (isMissingTableError(finalizeError, 'whatsapp_calls')) return claimedRow
        throw finalizeError
    }

    return finalized || {
        ...claimedRow,
        status_history: nextHistory
    }
}

export async function getRecentWhatsappRawWebhookEvents(supabase: SupabaseClientLike, params: {
    companyId: string
    profileId?: string | null
    eventType?: MetaWebhookEventType | null
    limit?: number
}) {
    let query = supabase
        .from('whatsapp_raw_webhook_events')
        .select('*')
        .eq('company_id', trimText(params.companyId))
        .order('created_at', { ascending: false })
        .limit(Math.max(1, Math.min(100, Number(params.limit) || 20)))

    if (params.profileId) {
        query = query.eq('profile_id', trimText(params.profileId))
    }
    if (params.eventType) {
        query = query.eq('event_type', params.eventType)
    }

    const { data, error } = await query
    if (error) {
        if (isMissingTableError(error, 'whatsapp_raw_webhook_events')) return []
        throw error
    }

    return Array.isArray(data) ? data : []
}
