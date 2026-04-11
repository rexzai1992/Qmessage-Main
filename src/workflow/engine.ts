import type { WabaClient } from '../waba/client'
import { ADS_SHOOT_SIMULATED_TAG, LEGACY_ADS_SHOOT_SIMULATED_TAG, extractCtaReferralSource, findOrCreateUser, getCompanyFallbackSettings, getLastMessage, getLatestWorkflowMemory, getWorkflowById, getWorkflows, insertMessage, setUserAssignee, setUserTags, updateMessageWorkflowState, updateUserCtaReferral, updateUserLastInbound, updateUserTags } from '../services/wa-store'
import type { User } from '../services/wa-store'
import { sendWhatsAppMessage } from '../services/whatsapp'
import type { WorkflowState } from './types'

export type InboundContext = {
    companyId: string
    profileId: string
    client: WabaClient
    phoneNumber: string
    automationDisabled?: boolean
    messageType: string
    text?: string
    buttonId?: string
    buttonTitle?: string
    media?: {
        id?: string
        mime_type?: string
        caption?: string
        filename?: string
        file_size?: number
    }
    raw?: any
}

export type WorkflowProcessResult = {
    error?: string
    handled: boolean
    replied: boolean
    completedWorkflowId?: string
}

function extractInboundReferral(raw: any): any | null {
    if (raw && typeof raw === 'object') {
        if (raw.referral && typeof raw.referral === 'object') return raw.referral
        if (raw.context && typeof raw.context === 'object' && raw.context.referral && typeof raw.context.referral === 'object') {
            return raw.context.referral
        }
    }
    return null
}

function normalizeText(text?: string) {
    return (text || '').replace(/[^\w\s]/gi, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function isFirstMessageTrigger(keyword: string) {
    const cleaned = normalizeText(keyword)
    return cleaned === 'first_message' || cleaned === 'first message' || cleaned === 'firstmessage'
}

function matchTrigger(keyword: string, text: string) {
    const cleanedKeyword = normalizeText(keyword)
    if (!cleanedKeyword) return false
    const normalizedText = normalizeText(text)
    if (!normalizedText) return false
    if (normalizedText === cleanedKeyword) return true
    // If the trigger is a phrase, allow substring match.
    if (cleanedKeyword.includes(' ')) {
        return normalizedText.includes(cleanedKeyword)
    }
    const tokens = normalizedText.split(' ')
    return tokens.includes(cleanedKeyword)
}

function parseActions(actions: any): any[] {
    if (!Array.isArray(actions)) return []
    return actions as any[]
}

function resolveRoute(
    routes: Record<string, number | { next_step?: number; state?: string }> | undefined,
    buttonId: string
) {
    if (!routes) return null
    const route = routes[buttonId]
    if (route === undefined) return null
    if (typeof route === 'number') {
        return { next_step: route }
    }
    return route
}

const MAX_BUTTONS = 3
const STORE_INBOUND_RAW_PAYLOAD = process.env.STORE_INBOUND_RAW_PAYLOAD === 'true'
const DEFAULT_FALLBACK_TEXT = process.env.WORKFLOW_FALLBACK_TEXT || 'automation not in setting'
const DEFAULT_FALLBACK_LIMIT = (() => {
    const raw = process.env.WORKFLOW_FALLBACK_LIMIT
    if (raw === undefined || raw === null || raw === '') return 3
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return 3
    return Math.max(0, Math.floor(parsed))
})()

function normalizeFallbackLimit(value: number | null | undefined, fallback: number) {
    if (value === null || value === undefined) return fallback
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.max(0, Math.floor(parsed))
}

function normalizeButtons(buttons: Array<{ id: string; title: string }> = []) {
    if (buttons.length <= MAX_BUTTONS) return buttons
    console.warn(`[Workflow] Buttons capped at ${MAX_BUTTONS}; trimming ${buttons.length} -> ${MAX_BUTTONS}`)
    return buttons.slice(0, MAX_BUTTONS)
}

function extractListRowIds(
    sections: Array<{ rows: Array<{ id: string }> }> = []
): string[] {
    const ids: string[] = []
    for (const section of sections) {
        const rows = section?.rows || []
        for (const row of rows) {
            if (row?.id) ids.push(row.id)
        }
    }
    return ids
}

function normalizeVariableKey(value: unknown): string {
    if (typeof value !== 'string') return ''
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
}

function sanitizeVars(raw: any): Record<string, string> {
    if (!raw || typeof raw !== 'object') return {}
    const vars: Record<string, string> = {}
    Object.entries(raw as Record<string, unknown>).forEach(([key, value]) => {
        const normalized = normalizeVariableKey(key)
        if (!normalized) return
        if (value === null || value === undefined) return
        vars[normalized] = String(value)
    })
    return vars
}

function sanitizeQaHistory(raw: any): Array<{ key: string; question: string; answer: string; at: string }> {
    if (!Array.isArray(raw)) return []
    return raw
        .map((entry: any) => ({
            key: normalizeVariableKey(entry?.key),
            question: typeof entry?.question === 'string' ? entry.question : '',
            answer: typeof entry?.answer === 'string' ? entry.answer : '',
            at: typeof entry?.at === 'string' ? entry.at : ''
        }))
        .filter((entry: any) => entry.key && entry.answer)
}

type AwaitingConfirmationState = {
    fields: Array<{ key: string; label: string }>
    question?: string
    fallback_text?: string
    retry_limit?: number
    edit_prompt?: string
}

type AwaitingPaymentState = {
    body?: string
    payment_url: string
    button_text?: string
    amount?: string
    currency?: string
    success_keywords?: string[]
    pending_text?: string
    receipt_text?: string
    expired_text?: string
    expires_at?: string
    next_step?: number
    expired_notified?: boolean
}

const PAYMENT_SUCCESS_BUTTON_ID = 'payment_success'
const PAYMENT_NOT_SUCCESS_BUTTON_ID = 'payment_not_success'
const PAYMENT_SUCCESS_BUTTON_TITLE = 'Payment Success'
const PAYMENT_NOT_SUCCESS_BUTTON_TITLE = 'Payment Not Success'
const DEFAULT_PAYMENT_SUCCESS_KEYWORDS = [PAYMENT_SUCCESS_BUTTON_ID, 'paid', 'done', 'payment_done', 'success']
const DEFAULT_PAYMENT_PENDING_TEXT = 'I still have not received payment. Please complete payment and tap "Payment Success".'
const DEFAULT_PAYMENT_RECEIPT_TEXT = 'Payment received. Receipt ID: {{receipt_id}}.'
const DEFAULT_PAYMENT_EXPIRED_TEXT = 'This payment link has expired.'

function humanizeVariableLabel(key: string): string {
    const normalized = normalizeVariableKey(key)
    if (!normalized) return ''
    return normalized
        .split('_')
        .map((chunk) => (chunk ? chunk.charAt(0).toUpperCase() + chunk.slice(1) : ''))
        .join(' ')
        .trim()
}

function sanitizeAwaitingConfirmation(raw: any): AwaitingConfirmationState | undefined {
    if (!raw || typeof raw !== 'object') return undefined
    const fieldsRaw: unknown[] = Array.isArray(raw.fields) ? raw.fields : []
    const fields = fieldsRaw
        .map((entry: unknown): { key: string; label: string } | null => {
            const entryObj =
                entry && typeof entry === 'object'
                    ? (entry as { key?: unknown; label?: unknown })
                    : null
            const key = normalizeVariableKey(entryObj?.key ?? entry)
            if (!key) return null
            const labelRaw = typeof entryObj?.label === 'string' ? entryObj.label.trim() : ''
            return {
                key,
                label: labelRaw || humanizeVariableLabel(key) || key
            }
        })
        .filter((entry): entry is { key: string; label: string } => entry !== null)
    if (fields.length === 0) return undefined
    return {
        fields,
        question: typeof raw.question === 'string' ? raw.question : undefined,
        fallback_text: typeof raw.fallback_text === 'string' ? raw.fallback_text : undefined,
        retry_limit: normalizeFallbackLimit(raw.retry_limit, DEFAULT_FALLBACK_LIMIT),
        edit_prompt: typeof raw.edit_prompt === 'string' ? raw.edit_prompt : undefined
    }
}

function resolveConfirmationFields(action: any, state: WorkflowState): Array<{ key: string; label: string }> {
    const actionFields: unknown[] = Array.isArray(action?.fields) ? action.fields : []
    const normalizedActionFields = actionFields
        .map((value: unknown): string => normalizeVariableKey(value))
        .filter((value): boolean => Boolean(value))
    if (normalizedActionFields.length > 0) {
        const uniqueActionFields = Array.from(new Set<string>(normalizedActionFields))
        return uniqueActionFields.map((key) => ({
            key,
            label: humanizeVariableLabel(key) || key
        }))
    }

    const keys: string[] = []
    const seen = new Set<string>()
    sanitizeQaHistory(state.qa_history).forEach((entry) => {
        if (!entry.key || seen.has(entry.key)) return
        seen.add(entry.key)
        keys.push(entry.key)
    })
    Object.keys(sanitizeVars(state.vars)).forEach((key) => {
        if (!key || seen.has(key)) return
        seen.add(key)
        keys.push(key)
    })
    return keys.map((key) => ({
        key,
        label: humanizeVariableLabel(key) || key
    }))
}

function buildConfirmationPrompt(
    confirmation: AwaitingConfirmationState,
    state: WorkflowState,
    user: User,
    ctx: InboundContext
): string {
    const introRaw = renderDynamicText(
        confirmation.question || 'Please confirm your details below:',
        state,
        user,
        ctx
    ).trim()
    const intro = introRaw || 'Please confirm your details below:'
    const vars = sanitizeVars(state.vars)
    const lines = confirmation.fields.map((field, index) => {
        const value = (vars[field.key] || '').trim()
        return `${index + 1}. ${field.label}: ${value || '-'}`
    })
    return [
        intro,
        ...lines,
        'Reply "yes" to confirm, or "no <field>" to change one value.'
    ].join('\n')
}

function isAffirmativeReply(value: string): boolean {
    const normalized = normalizeChoiceKey(value)
    return normalized === 'yes'
        || normalized === 'y'
        || normalized === 'ok'
        || normalized === 'confirm'
        || normalized === 'confirmed'
        || normalized === 'correct'
        || normalized === 'true'
        || normalized === 'betul'
}

function isNegativeReply(value: string): boolean {
    const normalized = normalizeChoiceKey(value)
    return normalized === 'no'
        || normalized === 'n'
        || normalized === 'edit'
        || normalized === 'change'
        || normalized === 'update'
        || normalized === 'false'
        || normalized === 'tak'
}

function extractConfirmationFieldHint(answer: string): string {
    const trimmed = answer.trim()
    if (!trimmed) return ''
    const pattern = /^(?:no|edit|change|update)\s+(.+)$/i
    const match = pattern.exec(trimmed)
    if (!match?.[1]) return ''
    return match[1].trim()
}

function resolveFieldForEdit(
    hint: string,
    fields: Array<{ key: string; label: string }>
): { key: string; label: string } | null {
    const trimmedHint = hint.trim()
    if (!trimmedHint) return null
    const numeric = Number.parseInt(trimmedHint, 10)
    if (Number.isFinite(numeric) && numeric >= 1 && numeric <= fields.length) {
        return fields[numeric - 1] || null
    }
    const byKey = normalizeVariableKey(trimmedHint)
    const byLabel = normalizeChoiceKey(trimmedHint)
    for (const field of fields) {
        if (byKey && normalizeVariableKey(field.key) === byKey) return field
        if (byLabel && normalizeChoiceKey(field.label) === byLabel) return field
    }
    return null
}

function getInboundAnswer(ctx: InboundContext): string {
    const text = typeof ctx.text === 'string' ? ctx.text.trim() : ''
    if (text) return text
    const buttonTitle = typeof ctx.buttonTitle === 'string' ? ctx.buttonTitle.trim() : ''
    if (buttonTitle) return buttonTitle
    const buttonId = typeof ctx.buttonId === 'string' ? ctx.buttonId.trim() : ''
    if (buttonId) return buttonId
    const caption = typeof ctx.media?.caption === 'string' ? ctx.media.caption.trim() : ''
    if (caption) return caption
    return ''
}

function normalizeChoiceKey(value: unknown): string {
    if (typeof value !== 'string') return ''
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
}

function normalizePaymentKeywords(raw: unknown): string[] {
    if (Array.isArray(raw)) {
        const cleaned = raw
            .map((value) => normalizeChoiceKey(value))
            .filter(Boolean)
        return cleaned.length > 0 ? Array.from(new Set(cleaned)) : [...DEFAULT_PAYMENT_SUCCESS_KEYWORDS]
    }
    if (typeof raw === 'string') {
        const cleaned = raw
            .split(',')
            .map((value) => normalizeChoiceKey(value))
            .filter(Boolean)
        return cleaned.length > 0 ? Array.from(new Set(cleaned)) : [...DEFAULT_PAYMENT_SUCCESS_KEYWORDS]
    }
    return [...DEFAULT_PAYMENT_SUCCESS_KEYWORDS]
}

function parsePositiveInt(value: unknown): number | null {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return null
    const rounded = Math.floor(parsed)
    if (rounded <= 0) return null
    return rounded
}

function sanitizeAwaitingPayment(raw: any): AwaitingPaymentState | undefined {
    if (!raw || typeof raw !== 'object') return undefined
    const paymentUrl = typeof raw.payment_url === 'string' ? raw.payment_url.trim() : ''
    if (!paymentUrl) return undefined
    const expiresAt = (() => {
        if (typeof raw.expires_at !== 'string' || !raw.expires_at.trim()) return undefined
        const parsed = new Date(raw.expires_at)
        if (Number.isNaN(parsed.getTime())) return undefined
        return parsed.toISOString()
    })()

    return {
        payment_url: paymentUrl,
        body: typeof raw.body === 'string' ? raw.body : undefined,
        button_text: typeof raw.button_text === 'string' ? raw.button_text : undefined,
        amount: typeof raw.amount === 'string' ? raw.amount.trim() : undefined,
        currency: typeof raw.currency === 'string' ? raw.currency.trim().toUpperCase() : undefined,
        success_keywords: normalizePaymentKeywords(raw.success_keywords),
        pending_text: typeof raw.pending_text === 'string' ? raw.pending_text : undefined,
        receipt_text: typeof raw.receipt_text === 'string' ? raw.receipt_text : undefined,
        expired_text: typeof raw.expired_text === 'string' ? raw.expired_text : undefined,
        expires_at: expiresAt,
        next_step: typeof raw.next_step === 'number' && Number.isFinite(raw.next_step) ? raw.next_step : undefined,
        expired_notified: Boolean(raw.expired_notified)
    }
}

function hasPaymentExpired(expiresAt?: string): boolean {
    if (!expiresAt) return false
    const parsed = new Date(expiresAt).getTime()
    if (!Number.isFinite(parsed)) return false
    return Date.now() >= parsed
}

function isPaymentSuccessReply(answer: string, keywords: string[]): boolean {
    const normalizedAnswer = normalizeChoiceKey(answer)
    if (!normalizedAnswer) return false
    const keys = normalizePaymentKeywords(keywords)
    if (keys.includes(normalizedAnswer)) return true
    const tokens = normalizedAnswer.split('_').filter(Boolean)
    return tokens.some((token) => keys.includes(token))
}

function generateReceiptId(): string {
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
    const randomSuffix = Math.floor(1000 + Math.random() * 9000)
    return `RCP-${stamp}-${randomSuffix}`
}

function buildSimulatedPaymentPrompt(
    body: string,
    paymentUrl: string,
    amount?: string,
    currency?: string
): string {
    const cleanedBody = body.trim() || 'Please complete your payment using the link below.'
    const normalizedAmount = (amount || '').trim()
    const normalizedCurrency = (currency || '').trim().toUpperCase()
    const lines = [cleanedBody]
    if (normalizedAmount) {
        lines.push(`Amount: ${normalizedCurrency ? `${normalizedCurrency} ` : ''}${normalizedAmount}`)
    }
    lines.push(`Payment link: ${paymentUrl}`)
    lines.push('Testing simulation: tap one button below.')
    return lines.join('\n')
}

function isPaymentNotSuccessReply(answer: string): boolean {
    const normalized = normalizeChoiceKey(answer)
    return normalized === PAYMENT_NOT_SUCCESS_BUTTON_ID
        || normalized === 'payment_failed'
        || normalized === 'not_paid'
        || normalized === 'failed'
}

function resolveAwaitingButtonId(
    ctx: InboundContext,
    awaitingRaw?: string[] | null
): string | null {
    const rawId = typeof ctx.buttonId === 'string' ? ctx.buttonId.trim() : ''
    const rawTitle = typeof ctx.buttonTitle === 'string' ? ctx.buttonTitle.trim() : ''

    const awaiting = Array.isArray(awaitingRaw)
        ? awaitingRaw.map((value) => (typeof value === 'string' ? value.trim() : '')).filter(Boolean)
        : []

    if (awaiting.length === 0) {
        return rawId || null
    }

    const candidates: string[] = []
    if (rawId) candidates.push(rawId)
    if (rawTitle) candidates.push(rawTitle)

    const normalizedId = normalizeChoiceKey(rawId)
    if (normalizedId && !candidates.includes(normalizedId)) candidates.push(normalizedId)
    const normalizedTitle = normalizeChoiceKey(rawTitle)
    if (normalizedTitle && !candidates.includes(normalizedTitle)) candidates.push(normalizedTitle)

    for (const candidate of candidates) {
        const exact = awaiting.find((value) => value === candidate)
        if (exact) return exact
    }

    const awaitingByLower = new Map<string, string>()
    awaiting.forEach((value) => {
        const lower = value.toLowerCase()
        if (!awaitingByLower.has(lower)) awaitingByLower.set(lower, value)
    })

    for (const candidate of candidates) {
        const match = awaitingByLower.get(candidate.toLowerCase())
        if (match) return match
    }

    if (normalizedTitle) {
        for (const value of awaiting) {
            if (normalizeChoiceKey(value) === normalizedTitle) return value
        }
    }

    return null
}

function resolveDynamicContext(state: WorkflowState, user: User, ctx: InboundContext) {
    const vars = sanitizeVars(state.vars)
    const contactName = (user.name || '').trim()
    const phone = user.phone_number || ctx.phoneNumber || ''
    const context: Record<string, string> = {
        ...vars,
        company_id: ctx.companyId || '',
        profile_id: ctx.profileId || '',
        contact_name: contactName,
        name: contactName,
        phone_number: phone,
        phone,
        workflow_state: state.state || '',
        state: state.state || '',
        inbound_text: getInboundAnswer(ctx)
    }
    return context
}

function renderDynamicText(value: unknown, state: WorkflowState, user: User, ctx: InboundContext): string {
    if (typeof value !== 'string') return ''
    const map = resolveDynamicContext(state, user, ctx)
    return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, keyRaw) => {
        const key = normalizeVariableKey(String(keyRaw))
        if (!key) return match
        const next = map[key]
        if (next === undefined || next === null) return match
        return String(next)
    })
}

function getConditionLeftValue(action: any, state: WorkflowState, user: User, ctx: InboundContext): string {
    const rawSource = typeof action?.source === 'string' ? action.source.trim() : ''
    if (!rawSource) return ''
    const source = rawSource.toLowerCase()
    const vars = sanitizeVars(state.vars)

    if (source.startsWith('vars.')) {
        const key = normalizeVariableKey(source.slice(5))
        return vars[key] || ''
    }
    if (source.startsWith('contact.')) {
        const field = source.slice(8)
        if (field === 'name') return user.name || ''
        if (field === 'phone' || field === 'phone_number') return user.phone_number || ctx.phoneNumber || ''
        if (field === 'tags') return Array.isArray(user.tags) ? user.tags.join(',') : ''
        if (field === 'last_inbound_at') return user.last_inbound_at || ''
        return ''
    }

    const normalized = normalizeVariableKey(source)
    if (normalized && vars[normalized] !== undefined) return vars[normalized]
    if (normalized === 'contact_name' || normalized === 'name') return user.name || ''
    if (normalized === 'phone' || normalized === 'phone_number') return user.phone_number || ctx.phoneNumber || ''
    if (normalized === 'inbound_text' || normalized === 'last_message') return getInboundAnswer(ctx)
    return ''
}

function evaluateCondition(action: any, state: WorkflowState, user: User, ctx: InboundContext): boolean {
    const left = getConditionLeftValue(action, state, user, ctx)
    const operatorRaw = typeof action?.operator === 'string' ? action.operator.trim().toLowerCase() : ''
    const operator = operatorRaw || 'contains'
    const right = renderDynamicText(
        action?.value === null || action?.value === undefined ? '' : String(action.value),
        state,
        user,
        ctx
    )

    if (operator === 'exists') {
        return left.trim().length > 0
    }
    if (operator === 'equals' || operator === '==') {
        return left.trim().toLowerCase() === right.trim().toLowerCase()
    }
    if (operator === 'not_equals' || operator === '!=') {
        return left.trim().toLowerCase() !== right.trim().toLowerCase()
    }
    if (operator === 'starts_with') {
        return left.trim().toLowerCase().startsWith(right.trim().toLowerCase())
    }
    if (operator === 'greater_than' || operator === '>') {
        const leftNum = Number(left)
        const rightNum = Number(right)
        if (!Number.isFinite(leftNum) || !Number.isFinite(rightNum)) return false
        return leftNum > rightNum
    }
    if (operator === 'less_than' || operator === '<') {
        const leftNum = Number(left)
        const rightNum = Number(right)
        if (!Number.isFinite(leftNum) || !Number.isFinite(rightNum)) return false
        return leftNum < rightNum
    }

    return left.trim().toLowerCase().includes(right.trim().toLowerCase())
}

export class WorkflowEngine {
    public async processInbound(ctx: InboundContext): Promise<WorkflowProcessResult> {
        const user = await findOrCreateUser(ctx.companyId, ctx.phoneNumber)
        if (!user) return { handled: false, replied: false }
        const isSimulatedInbound = Boolean(ctx.raw?.simulated)
        if (isSimulatedInbound) {
            const existingTags = Array.isArray(user.tags) ? user.tags : []
            const hasLegacyTag = existingTags.some(
                (tag) => String(tag || '').trim().toLowerCase() === LEGACY_ADS_SHOOT_SIMULATED_TAG
            )
            if (hasLegacyTag) {
                const nextTags = Array.from(
                    new Set(
                        [
                            ...existingTags.filter(
                                (tag) => String(tag || '').trim().toLowerCase() !== LEGACY_ADS_SHOOT_SIMULATED_TAG
                            ),
                            ADS_SHOOT_SIMULATED_TAG
                        ]
                            .map((tag) => String(tag || '').trim())
                            .filter(Boolean)
                    )
                )
                await setUserTags(user.id, nextTags)
                user.tags = nextTags
            } else {
                await updateUserTags(user.id, ADS_SHOOT_SIMULATED_TAG)
            }
        }

        const inboundTimestamp = ctx.raw?.timestamp ? Number(ctx.raw.timestamp) * 1000 : null
        const inboundIso = inboundTimestamp && !Number.isNaN(inboundTimestamp)
            ? new Date(inboundTimestamp).toISOString()
            : new Date().toISOString()
        if (inboundTimestamp && !Number.isNaN(inboundTimestamp)) {
            await updateUserLastInbound(user.id, inboundIso)
        } else {
            await updateUserLastInbound(user.id)
        }

        const referral = extractInboundReferral(ctx.raw)
        if (referral) {
            const referralSource = extractCtaReferralSource(referral)
            await updateUserCtaReferral(user.id, inboundIso, referralSource)
        }

        const lastMessage = await getLastMessage(user.id)
        let currentState = (lastMessage?.workflow_state || null) as WorkflowState | null
        const memory = await getLatestWorkflowMemory(user.id)
        if (currentState) {
            currentState.vars = {
                ...sanitizeVars(memory.vars),
                ...sanitizeVars(currentState.vars)
            }
            const existingQa = sanitizeQaHistory(currentState.qa_history)
            if (existingQa.length > 0) {
                currentState.qa_history = existingQa
            } else {
                currentState.qa_history = sanitizeQaHistory(memory.qa_history)
            }
            currentState.awaiting_confirmation = sanitizeAwaitingConfirmation(currentState.awaiting_confirmation)
            currentState.awaiting_payment = sanitizeAwaitingPayment((currentState as any).awaiting_payment)
        }
        const isFirstMessage = !lastMessage
        const matchedIncomingButtonId = resolveAwaitingButtonId(ctx, currentState?.awaiting_buttons)
        if (matchedIncomingButtonId) {
            ctx = { ...ctx, buttonId: matchedIncomingButtonId }
        }

        const simulatedSourceRaw = typeof ctx.raw?.source === 'string' ? ctx.raw.source.trim().toLowerCase() : ''
        const inboundContent: any = {
            type: ctx.messageType,
            text: ctx.text,
            button_id: ctx.buttonId,
            button_title: ctx.buttonTitle,
            media_id: ctx.media?.id,
            mimetype: ctx.media?.mime_type,
            caption: ctx.media?.caption,
            filename: ctx.media?.filename,
            file_size: ctx.media?.file_size,
            referral: referral || null,
            ...(isSimulatedInbound
                ? {
                    simulated: true,
                    simulated_source: simulatedSourceRaw || 'simulated',
                    simulated_profile_id: ctx.profileId
                }
                : {}),
            ...(STORE_INBOUND_RAW_PAYLOAD ? { raw: ctx.raw } : {})
        }

        const inboundRecord = await insertMessage({
            userId: user.id,
            direction: 'in',
            content: inboundContent,
            workflowState: currentState,
            createdAt:
                isSimulatedInbound
                && inboundTimestamp
                && !Number.isNaN(inboundTimestamp)
                    ? inboundIso
                    : undefined
        })

        const inboundAnswer = getInboundAnswer(ctx)
        const canContinueAwaitingButtons =
            Array.isArray(currentState?.awaiting_buttons) &&
            currentState.awaiting_buttons.length > 0 &&
            Boolean(ctx.buttonId)
        const canContinueAwaitingInput = Boolean(currentState?.awaiting_input?.save_as && inboundAnswer)
        const canContinueAwaitingConfirmation = Boolean(
            currentState?.awaiting_confirmation?.fields?.length && inboundAnswer
        )
        const canContinueAwaitingPayment = Boolean(currentState?.awaiting_payment?.payment_url)
        const canContinueActiveWorkflow =
            Boolean(currentState?.workflow_id) &&
            (canContinueAwaitingButtons || canContinueAwaitingInput || canContinueAwaitingConfirmation || canContinueAwaitingPayment)

        // Human takeover pauses new automation while still allowing active workflow replies to complete.
        if (ctx.automationDisabled && !canContinueActiveWorkflow) {
            if (inboundRecord?.id && currentState) {
                await updateMessageWorkflowState(inboundRecord.id, currentState)
            }
            return { handled: false, replied: false }
        }

        let workflow = null
        let state: WorkflowState | null = currentState

        if (state?.workflow_id) {
            workflow = await getWorkflowById(state.workflow_id)
        }

        // If the saved state points past the end of actions (or to end_flow),
        // treat it as completed so new triggers can start. Keep waiting states alive.
        if (workflow) {
            const actions = parseActions(workflow.actions)
            const stepIndex = state?.step_index ?? 0
            const awaiting = Boolean(
                (state?.awaiting_buttons && state.awaiting_buttons.length > 0) ||
                state?.awaiting_input?.save_as ||
                (state?.awaiting_confirmation && state.awaiting_confirmation.fields?.length > 0) ||
                state?.awaiting_payment?.payment_url
            )
            const completed =
                actions.length === 0 ||
                (!awaiting && (stepIndex >= actions.length || actions[stepIndex]?.type === 'end_flow'))
            if (completed) {
                workflow = null
                state = null
            }
        } else {
            state = null
        }

        if (state?.awaiting_payment?.payment_url) {
            const awaitingPayment = sanitizeAwaitingPayment(state.awaiting_payment)
            if (!awaitingPayment) {
                state.awaiting_payment = undefined
            } else {
                state.awaiting_payment = awaitingPayment
                const answer = getInboundAnswer(ctx)
                const success = Boolean(answer) && isPaymentSuccessReply(answer, awaitingPayment.success_keywords || [])
                const notSuccess = Boolean(answer) && isPaymentNotSuccessReply(answer)

                if (success) {
                    const paidAt = new Date().toISOString()
                    const receiptId = generateReceiptId()
                    state.vars = {
                        ...sanitizeVars(state.vars),
                        payment_status: 'paid',
                        payment_link: awaitingPayment.payment_url,
                        payment_paid_at: paidAt,
                        receipt_id: receiptId,
                        ...(awaitingPayment.amount ? { payment_amount: awaitingPayment.amount } : {}),
                        ...(awaitingPayment.currency ? { payment_currency: awaitingPayment.currency } : {})
                    }
                    state.awaiting_payment = undefined
                    if (typeof awaitingPayment.next_step === 'number' && Number.isFinite(awaitingPayment.next_step)) {
                        state.step_index = awaitingPayment.next_step
                    }
                    state.fallback_count = 0

                    const receiptTemplate = awaitingPayment.receipt_text || DEFAULT_PAYMENT_RECEIPT_TEXT
                    const receiptText = renderDynamicText(receiptTemplate, state, user, ctx).trim() || DEFAULT_PAYMENT_RECEIPT_TEXT
                    let sentReceipt = false
                    try {
                        await sendWhatsAppMessage({
                            client: ctx.client,
                            userId: user.id,
                            to: ctx.phoneNumber,
                            type: 'text',
                            content: { text: receiptText },
                            workflowState: state
                        })
                        sentReceipt = true
                    } catch (error: any) {
                        console.warn('[Workflow] simulate_payment receipt failed:', error?.message || error)
                    }

                    if (inboundRecord?.id) {
                        await updateMessageWorkflowState(inboundRecord.id, state)
                    }

                    if (workflow) {
                        const continued = await this.runWorkflowActions(ctx, user, workflow, state)
                        if (continued.error) {
                            return {
                                error: continued.error,
                                handled: true,
                                replied: sentReceipt || continued.replied,
                                ...(continued.completedWorkflowId
                                    ? { completedWorkflowId: continued.completedWorkflowId }
                                    : {})
                            }
                        }
                        return {
                            handled: true,
                            replied: sentReceipt || continued.replied,
                            ...(continued.completedWorkflowId
                                ? { completedWorkflowId: continued.completedWorkflowId }
                                : {})
                        }
                    }

                    return { handled: true, replied: sentReceipt }
                }

                if (hasPaymentExpired(awaitingPayment.expires_at)) {
                    state.awaiting_payment = undefined
                    state.fallback_count = 0
                    const workflowActions = workflow ? parseActions(workflow.actions) : []
                    if (workflowActions.length > 0) {
                        state.step_index = workflowActions.length
                    }
                    const expiredTemplate = awaitingPayment.expired_text || DEFAULT_PAYMENT_EXPIRED_TEXT
                    const expiredMessage = renderDynamicText(expiredTemplate, state, user, ctx).trim() || DEFAULT_PAYMENT_EXPIRED_TEXT
                    let sentExpired = false
                    try {
                        await sendWhatsAppMessage({
                            client: ctx.client,
                            userId: user.id,
                            to: ctx.phoneNumber,
                            type: 'text',
                            content: { text: expiredMessage },
                            workflowState: state
                        })
                        sentExpired = true
                    } catch (error: any) {
                        console.warn('[Workflow] simulate_payment expired message failed:', error?.message || error)
                    }
                    if (inboundRecord?.id) {
                        await updateMessageWorkflowState(inboundRecord.id, state)
                    }
                    return { handled: true, replied: sentExpired }
                }

                const pendingTemplate = awaitingPayment.pending_text || DEFAULT_PAYMENT_PENDING_TEXT
                const pendingIntroRaw = notSuccess
                    ? 'Payment marked not successful. Please try again and tap "Payment Success" once paid.'
                    : pendingTemplate
                const pendingIntro = renderDynamicText(pendingIntroRaw, state, user, ctx).trim() || DEFAULT_PAYMENT_PENDING_TEXT
                const pendingBody = buildSimulatedPaymentPrompt(
                    pendingIntro,
                    awaitingPayment.payment_url,
                    awaitingPayment.amount,
                    awaitingPayment.currency
                )
                let sentPending = false
                try {
                    await sendWhatsAppMessage({
                        client: ctx.client,
                        userId: user.id,
                        to: ctx.phoneNumber,
                        type: 'buttons',
                        content: {
                            text: pendingBody,
                            buttons: normalizeButtons([
                                { id: PAYMENT_SUCCESS_BUTTON_ID, title: PAYMENT_SUCCESS_BUTTON_TITLE },
                                { id: PAYMENT_NOT_SUCCESS_BUTTON_ID, title: PAYMENT_NOT_SUCCESS_BUTTON_TITLE }
                            ])
                        },
                        workflowState: state
                    })
                    sentPending = true
                } catch (error: any) {
                    console.warn('[Workflow] simulate_payment pending buttons failed:', error?.message || error)
                    try {
                        await sendWhatsAppMessage({
                            client: ctx.client,
                            userId: user.id,
                            to: ctx.phoneNumber,
                            type: 'text',
                            content: {
                                text: `${pendingBody}\n${awaitingPayment.payment_url}`
                            },
                            workflowState: state
                        })
                        sentPending = true
                    } catch (textError: any) {
                        console.warn('[Workflow] simulate_payment pending text failed:', textError?.message || textError)
                    }
                }
                if (inboundRecord?.id) {
                    await updateMessageWorkflowState(inboundRecord.id, state)
                }
                return { handled: true, replied: sentPending }
            }
        }

        if (state?.awaiting_input?.save_as) {
            const answer = getInboundAnswer(ctx)
            const companyFallback = await getCompanyFallbackSettings(ctx.companyId)
            const retryLimit = normalizeFallbackLimit(
                state.awaiting_input.retry_limit,
                normalizeFallbackLimit(companyFallback?.fallback_limit, DEFAULT_FALLBACK_LIMIT)
            )
            if (!answer) {
                const nextFallbackCount = (state.fallback_count || 0) + 1
                state.fallback_count = nextFallbackCount

                if (retryLimit > 0 && nextFallbackCount > retryLimit) {
                    if (inboundRecord?.id) {
                        await updateMessageWorkflowState(inboundRecord.id, state)
                    }
                    return { handled: false, replied: false }
                }

                const fallbackText =
                    state.awaiting_input.fallback_text ||
                    companyFallback?.fallback_text ||
                    'Please type your answer.'
                const trimmedFallback = typeof fallbackText === 'string' ? fallbackText.trim() : ''
                if (!trimmedFallback) {
                    if (inboundRecord?.id) {
                        await updateMessageWorkflowState(inboundRecord.id, state)
                    }
                    return { handled: false, replied: false }
                }

                let sentFallback = false
                try {
                    await sendWhatsAppMessage({
                        client: ctx.client,
                        userId: user.id,
                        to: ctx.phoneNumber,
                        type: 'text',
                        content: { text: renderDynamicText(trimmedFallback, state, user, ctx) },
                        workflowState: state
                    })
                    sentFallback = true
                } catch (error: any) {
                    console.warn('[Workflow] ask_question fallback failed:', error?.message || error)
                }
                return { handled: true, replied: sentFallback }
            }

            const key = normalizeVariableKey(state.awaiting_input.save_as)
            if (key) {
                const nextVars = {
                    ...sanitizeVars(state.vars),
                    [key]: answer
                }
                state.vars = nextVars
                const nextHistory = sanitizeQaHistory(state.qa_history)
                nextHistory.push({
                    key,
                    question: state.awaiting_input.question || '',
                    answer,
                    at: new Date().toISOString()
                })
                state.qa_history = nextHistory.slice(-100)
            }

            state.awaiting_input = undefined
            state.fallback_count = 0
            if (inboundRecord?.id) {
                await updateMessageWorkflowState(inboundRecord.id, state)
            }
            if (state.awaiting_confirmation?.fields?.length) {
                const confirmation = sanitizeAwaitingConfirmation(state.awaiting_confirmation)
                if (confirmation) {
                    state.awaiting_confirmation = confirmation
                    const confirmationPrompt = buildConfirmationPrompt(confirmation, state, user, ctx)
                    let sentConfirmPrompt = false
                    try {
                        await sendWhatsAppMessage({
                            client: ctx.client,
                            userId: user.id,
                            to: ctx.phoneNumber,
                            type: 'text',
                            content: { text: confirmationPrompt },
                            workflowState: state
                        })
                        sentConfirmPrompt = true
                    } catch (error: any) {
                        console.warn('[Workflow] confirm_attributes follow-up failed:', error?.message || error)
                    }
                    return { handled: true, replied: sentConfirmPrompt }
                }
                state.awaiting_confirmation = undefined
            }
        }

        if (state?.awaiting_confirmation?.fields?.length) {
            const companyFallback = await getCompanyFallbackSettings(ctx.companyId)
            const confirmation = sanitizeAwaitingConfirmation(state.awaiting_confirmation)
            if (!confirmation) {
                state.awaiting_confirmation = undefined
            } else {
                state.awaiting_confirmation = confirmation
                const answer = getInboundAnswer(ctx)
                const retryLimit = normalizeFallbackLimit(
                    confirmation.retry_limit,
                    normalizeFallbackLimit(companyFallback?.fallback_limit, DEFAULT_FALLBACK_LIMIT)
                )
                const fallbackMessage =
                    confirmation.fallback_text ||
                    companyFallback?.fallback_text ||
                    'Reply "yes" to confirm, or "no <field>" to change one value.'

                if (!answer) {
                    const nextFallbackCount = (state.fallback_count || 0) + 1
                    state.fallback_count = nextFallbackCount
                    if (retryLimit > 0 && nextFallbackCount > retryLimit) {
                        if (inboundRecord?.id) {
                            await updateMessageWorkflowState(inboundRecord.id, state)
                        }
                        return { handled: false, replied: false }
                    }
                    let sentFallback = false
                    try {
                        await sendWhatsAppMessage({
                            client: ctx.client,
                            userId: user.id,
                            to: ctx.phoneNumber,
                            type: 'text',
                            content: { text: renderDynamicText(fallbackMessage, state, user, ctx) },
                            workflowState: state
                        })
                        sentFallback = true
                    } catch (error: any) {
                        console.warn('[Workflow] confirm_attributes fallback failed:', error?.message || error)
                    }
                    return { handled: true, replied: sentFallback }
                }

                if (isAffirmativeReply(answer)) {
                    state.awaiting_confirmation = undefined
                    state.fallback_count = 0
                    if (inboundRecord?.id) {
                        await updateMessageWorkflowState(inboundRecord.id, state)
                    }
                } else {
                    const editHint = extractConfirmationFieldHint(answer)
                    const wantsEdit = isNegativeReply(answer) || Boolean(editHint)
                    if (!wantsEdit) {
                        const nextFallbackCount = (state.fallback_count || 0) + 1
                        state.fallback_count = nextFallbackCount
                        if (retryLimit > 0 && nextFallbackCount > retryLimit) {
                            if (inboundRecord?.id) {
                                await updateMessageWorkflowState(inboundRecord.id, state)
                            }
                            return { handled: false, replied: false }
                        }
                        const fieldList = confirmation.fields.map((field) => field.key).join(', ')
                        let sentGuidance = false
                        try {
                            await sendWhatsAppMessage({
                                client: ctx.client,
                                userId: user.id,
                                to: ctx.phoneNumber,
                                type: 'text',
                                content: {
                                    text: `Please reply "yes" to confirm, or "no <field>" to edit.\nFields: ${fieldList}`
                                },
                                workflowState: state
                            })
                            sentGuidance = true
                        } catch (error: any) {
                            console.warn('[Workflow] confirm_attributes guidance failed:', error?.message || error)
                        }
                        return { handled: true, replied: sentGuidance }
                    }

                    const selectedField = resolveFieldForEdit(editHint, confirmation.fields)
                        || (!editHint && confirmation.fields.length === 1 ? confirmation.fields[0] : null)
                    if (!selectedField) {
                        state.fallback_count = (state.fallback_count || 0) + 1
                        const fieldList = confirmation.fields.map((field) => field.key).join(', ')
                        let sentFieldHint = false
                        try {
                            await sendWhatsAppMessage({
                                client: ctx.client,
                                userId: user.id,
                                to: ctx.phoneNumber,
                                type: 'text',
                                content: {
                                    text: `Tell me which field to change.\nReply like: no ${confirmation.fields[0]?.key || 'field_key'}\nFields: ${fieldList}`
                                },
                                workflowState: state
                            })
                            sentFieldHint = true
                        } catch (error: any) {
                            console.warn('[Workflow] confirm_attributes field hint failed:', error?.message || error)
                        }
                        return { handled: true, replied: sentFieldHint }
                    }

                    const editPromptTemplate =
                        confirmation.edit_prompt ||
                        'Please type the correct value for {{field_label}}.'
                    const editPrompt = renderDynamicText(
                        editPromptTemplate
                            .replace(/\{\{\s*field_label\s*\}\}/gi, selectedField.label)
                            .replace(/\{\{\s*field_key\s*\}\}/gi, selectedField.key),
                        state,
                        user,
                        ctx
                    ).trim() || `Please type the correct value for ${selectedField.label}.`

                    state.awaiting_input = {
                        save_as: selectedField.key,
                        question: editPrompt,
                        fallback_text: 'Please type the updated value.',
                        retry_limit: retryLimit
                    }
                    state.fallback_count = 0
                    let sentEditPrompt = false
                    try {
                        await sendWhatsAppMessage({
                            client: ctx.client,
                            userId: user.id,
                            to: ctx.phoneNumber,
                            type: 'text',
                            content: { text: editPrompt },
                            workflowState: state
                        })
                        sentEditPrompt = true
                    } catch (error: any) {
                        console.warn('[Workflow] confirm_attributes edit prompt failed:', error?.message || error)
                    }
                    if (inboundRecord?.id) {
                        await updateMessageWorkflowState(inboundRecord.id, state)
                    }
                    return { handled: true, replied: sentEditPrompt }
                }
            }
        }

        if (state?.awaiting_buttons && state.awaiting_buttons.length > 0) {
            const awaiting = state.awaiting_buttons
            const matchedButtonId = resolveAwaitingButtonId(ctx, awaiting)
            if (!matchedButtonId) {
                console.warn('[Workflow] Unmatched button reply while awaiting choice', {
                    workflowId: state.workflow_id,
                    stepIndex: state.step_index,
                    incomingButtonId: ctx.buttonId || null,
                    incomingButtonTitle: ctx.buttonTitle || null,
                    awaiting
                })
                const actions = workflow ? parseActions(workflow.actions) : []
                const actionIndex = Math.max(0, (state.step_index || 1) - 1)
                const action = actions[actionIndex] as any
                const companyFallback = await getCompanyFallbackSettings(ctx.companyId)
                const fallbackText =
                    action?.fallback_text ||
                    action?.fallback ||
                    companyFallback?.fallback_text ||
                    DEFAULT_FALLBACK_TEXT
                const fallbackLimit = normalizeFallbackLimit(
                    companyFallback?.fallback_limit,
                    DEFAULT_FALLBACK_LIMIT
                )

                const nextFallbackCount = (state.fallback_count || 0) + 1
                state.fallback_count = nextFallbackCount
                if (fallbackLimit > 0 && nextFallbackCount > fallbackLimit) {
                    if (inboundRecord?.id) {
                        await updateMessageWorkflowState(inboundRecord.id, state)
                    }
                    return { handled: false, replied: false }
                }

                const trimmedFallback = typeof fallbackText === 'string' ? fallbackText.trim() : ''
                if (!trimmedFallback) {
                    if (inboundRecord?.id) {
                        await updateMessageWorkflowState(inboundRecord.id, state)
                    }
                    return { handled: false, replied: false }
                }

                let sentFallback = false
                try {
                    await sendWhatsAppMessage({
                        client: ctx.client,
                        userId: user.id,
                        to: ctx.phoneNumber,
                        type: 'text',
                        content: { text: trimmedFallback },
                        workflowState: state
                    })
                    sentFallback = true
                } catch (error: any) {
                    console.warn('[Workflow] fallback message failed:', error?.message || error)
                }
                return { handled: true, replied: sentFallback }
            }
            if (matchedButtonId !== ctx.buttonId) {
                ctx = { ...ctx, buttonId: matchedButtonId }
            }
        }

        const canUseTrigger = !workflow || (state?.awaiting_buttons && !ctx.buttonId)
        if (canUseTrigger) {
            const workflows = await getWorkflows(ctx.companyId)
            let triggered: any = null
            let bestLen = -1
            for (const wf of workflows) {
                const key = normalizeText(wf?.trigger_keyword || '')
                if (!key) continue
                let matched = false
                if (isFirstMessage && isFirstMessageTrigger(key)) {
                    matched = true
                } else if (ctx.text) {
                    matched = matchTrigger(key, ctx.text)
                }
                if (!matched) continue
                if (key.length > bestLen) {
                    bestLen = key.length
                    triggered = wf
                }
            }
            if (!triggered && isFirstMessage) {
                const newChatWorkflow = workflows.find((wf: any) => wf?.run_on_new_chat === true)
                if (newChatWorkflow) {
                    triggered = newChatWorkflow
                }
            }
            if (triggered) {
                workflow = triggered
                state = {
                    workflow_id: triggered.id,
                    step_index: 0,
                    vars: sanitizeVars(memory.vars),
                    qa_history: sanitizeQaHistory(memory.qa_history)
                }
            }
        }

        if (!workflow || !state) {
            return { handled: false, replied: false }
        }

        return this.runWorkflowActions(ctx, user, workflow, state)
    }

    public async startWorkflow(ctx: InboundContext, workflowId: string): Promise<WorkflowProcessResult> {
        const user = await findOrCreateUser(ctx.companyId, ctx.phoneNumber)
        if (!user) return { handled: false, replied: false }

        const workflow = await getWorkflowById(workflowId)
        if (!workflow) return { error: 'Workflow not found.', handled: false, replied: false }
        if (workflow.company_id && workflow.company_id !== ctx.companyId) {
            return { error: 'Workflow not found for this company.', handled: false, replied: false }
        }
        if (workflow.enabled === false) {
            return { error: 'Workflow is turned off.', handled: false, replied: false }
        }

        const memory = await getLatestWorkflowMemory(user.id)

        const state: WorkflowState = {
            workflow_id: workflow.id,
            step_index: 0,
            vars: sanitizeVars(memory.vars),
            qa_history: sanitizeQaHistory(memory.qa_history)
        }

        return this.runWorkflowActions(ctx, user, workflow, state)
    }

    private async runWorkflowActions(
        ctx: InboundContext,
        user: User,
        workflow: any,
        state: WorkflowState
    ): Promise<WorkflowProcessResult> {
        state.vars = sanitizeVars(state.vars)
        state.qa_history = sanitizeQaHistory(state.qa_history)
        state.awaiting_confirmation = sanitizeAwaitingConfirmation(state.awaiting_confirmation)
        state.awaiting_payment = sanitizeAwaitingPayment((state as any).awaiting_payment)
        let replied = false

        if (state.awaiting_buttons && state.awaiting_buttons.length > 0) {
            const matchedButtonId = resolveAwaitingButtonId(ctx, state.awaiting_buttons)
            if (!matchedButtonId) return { handled: true, replied: false }
            state.fallback_count = 0

            const route = resolveRoute(state.awaiting_routes, matchedButtonId)
            if (route?.state) {
                state.state = route.state
            }
            if (route?.next_step !== undefined) {
                state.step_index = route.next_step
            }
        }
        if (state.awaiting_input?.save_as) {
            return { handled: true, replied: false }
        }
        if (state.awaiting_confirmation?.fields?.length) {
            return { handled: true, replied: false }
        }
        if (state.awaiting_payment?.payment_url) {
            return { handled: true, replied: false }
        }

        state.awaiting_buttons = undefined
        state.awaiting_routes = undefined

        const actions = parseActions(workflow.actions)
        let index = state.step_index || 0
        let lastError: string | null = null
        let completedWorkflowId: string | undefined
        let safety = 0
        const maxSteps = Math.max(actions.length * 3, 50)

        while (index < actions.length) {
            if (safety++ > maxSteps) {
                lastError = 'Workflow aborted: too many steps without waiting for input.'
                break
            }
            const action = actions[index]

            if (action.type === 'set_tag') {
                await updateUserTags(user.id, action.tag)
                const nextIndex =
                    typeof (action as any).next_step === 'number' && (action as any).next_step > index
                        ? (action as any).next_step
                        : index + 1
                index = nextIndex
                state.step_index = index
                continue
            }

            if (action.type === 'update_state') {
                state.state = action.state
                const nextIndex =
                    typeof (action as any).next_step === 'number' && (action as any).next_step > index
                        ? (action as any).next_step
                        : index + 1
                index = nextIndex
                state.step_index = index
                continue
            }

            if (action.type === 'condition') {
                const matched = evaluateCondition(action, state, user, ctx)
                const preferredIndex = matched ? action.true_step : action.false_step
                let nextIndex =
                    typeof preferredIndex === 'number' && preferredIndex >= 0
                        ? preferredIndex
                        : index + 1
                if (nextIndex === index) nextIndex = index + 1
                index = nextIndex
                state.step_index = index
                continue
            }

            if (action.type === 'send_text') {
                state.step_index = index + 1
                try {
                    const mediaType = (action as any)?.media?.type
                    const mediaLink = (action as any)?.media?.link
                    const mediaFilename = (action as any)?.media?.filename
                    const media =
                        (mediaType === 'image' || mediaType === 'video' || mediaType === 'document') &&
                        typeof mediaLink === 'string' &&
                        mediaLink.trim()
                            ? {
                                type: mediaType,
                                link: mediaLink.trim(),
                                ...(mediaType === 'document' && typeof mediaFilename === 'string' && mediaFilename.trim()
                                    ? { filename: mediaFilename.trim() }
                                    : {})
                            }
                            : undefined

                    await sendWhatsAppMessage({
                        client: ctx.client,
                        userId: user.id,
                        to: ctx.phoneNumber,
                        type: 'text',
                        content: {
                            text: renderDynamicText(action.text, state, user, ctx),
                            ...(media ? { media } : {}),
                            template: action.template
                        },
                        workflowState: state
                    })
                    replied = true
                } catch (error: any) {
                    const msg = error?.message || String(error)
                    console.warn('[Workflow] send_text failed:', msg)
                    lastError = `send_text failed: ${msg}`
                    break
                }
                const nextIndex =
                    typeof (action as any).next_step === 'number'
                        ? (action as any).next_step
                        : index + 1
                const nextAction = actions[nextIndex]
                const chainInteractive =
                    nextAction &&
                    ['send_buttons', 'send_list', 'send_cta_url', 'simulate_payment'].includes(nextAction.type)
                if (chainInteractive || (nextAction && ['send_text', 'send_template', 'add_tags', 'assign_staff', 'ask_question', 'confirm_attributes', 'condition', 'set_tag', 'update_state', 'simulate_payment'].includes(nextAction.type))) {
                    index = nextIndex
                    continue
                }
                break
            }

            if (action.type === 'confirm_attributes') {
                state.step_index = index + 1
                const fields = resolveConfirmationFields(action, state)
                if (fields.length === 0) {
                    index = state.step_index
                    continue
                }
                const confirmation: AwaitingConfirmationState = {
                    fields,
                    question: typeof action.question === 'string' ? action.question : undefined,
                    fallback_text: typeof action.fallback_text === 'string' ? action.fallback_text : undefined,
                    retry_limit: normalizeFallbackLimit(action.retry_limit, DEFAULT_FALLBACK_LIMIT),
                    edit_prompt: typeof action.edit_prompt === 'string' ? action.edit_prompt : undefined
                }
                state.awaiting_confirmation = confirmation
                state.fallback_count = 0
                const prompt = buildConfirmationPrompt(confirmation, state, user, ctx)
                try {
                    await sendWhatsAppMessage({
                        client: ctx.client,
                        userId: user.id,
                        to: ctx.phoneNumber,
                        type: 'text',
                        content: { text: prompt },
                        workflowState: state
                    })
                    replied = true
                } catch (error: any) {
                    const msg = error?.message || String(error)
                    console.warn('[Workflow] confirm_attributes failed:', msg)
                    lastError = `confirm_attributes failed: ${msg}`
                }
                break
            }

            if (action.type === 'ask_question') {
                state.step_index = index + 1
                const variableKey = normalizeVariableKey(action.save_as)
                if (!variableKey) {
                    lastError = 'ask_question failed: save_as is required'
                    break
                }
                const question = renderDynamicText(action.question, state, user, ctx)
                if (!question.trim()) {
                    lastError = 'ask_question failed: question text is required'
                    break
                }
                state.awaiting_input = {
                    save_as: variableKey,
                    question,
                    fallback_text: typeof action.fallback_text === 'string' ? action.fallback_text : undefined,
                    retry_limit: normalizeFallbackLimit(action.retry_limit, DEFAULT_FALLBACK_LIMIT)
                }
                state.fallback_count = 0
                try {
                    await sendWhatsAppMessage({
                        client: ctx.client,
                        userId: user.id,
                        to: ctx.phoneNumber,
                        type: 'text',
                        content: {
                            text: question
                        },
                        workflowState: state
                    })
                    replied = true
                } catch (error: any) {
                    const msg = error?.message || String(error)
                    console.warn('[Workflow] ask_question failed:', msg)
                    lastError = `ask_question failed: ${msg}`
                }
                break
            }

            if (action.type === 'send_template') {
                state.step_index = index + 1
                const templateName = renderDynamicText(action.name, state, user, ctx).trim()
                if (!templateName) {
                    lastError = 'send_template failed: template name is required'
                    break
                }
                try {
                    await sendWhatsAppMessage({
                        client: ctx.client,
                        userId: user.id,
                        to: ctx.phoneNumber,
                        type: 'template',
                        content: {
                            name: templateName,
                            language: renderDynamicText(
                                (typeof action.language === 'string' && action.language.trim()) ? action.language : 'en_US',
                                state,
                                user,
                                ctx
                            ) || 'en_US',
                            components: Array.isArray(action.components) ? action.components : undefined
                        },
                        workflowState: state
                    })
                    replied = true
                } catch (error: any) {
                    const msg = error?.message || String(error)
                    console.warn('[Workflow] send_template failed:', msg)
                    lastError = `send_template failed: ${msg}`
                    break
                }
                const nextIndex =
                    typeof (action as any).next_step === 'number'
                        ? (action as any).next_step
                        : index + 1
                if (nextIndex > index && nextIndex < actions.length) {
                    index = nextIndex
                    continue
                }
                break
            }

            if (action.type === 'add_tags') {
                const nextTags = Array.isArray(action.tags)
                    ? action.tags.map((tag: any) => (typeof tag === 'string' ? tag.trim() : '')).filter(Boolean)
                    : []
                for (const tag of nextTags) {
                    await updateUserTags(user.id, tag)
                }
                const nextIndex =
                    typeof (action as any).next_step === 'number' && (action as any).next_step > index
                        ? (action as any).next_step
                        : index + 1
                index = nextIndex
                state.step_index = index
                continue
            }

            if (action.type === 'assign_staff') {
                const assigneeUserId = typeof action.assignee_user_id === 'string' ? action.assignee_user_id.trim() : ''
                if (!assigneeUserId) {
                    await setUserAssignee(user.id, null)
                } else {
                    await setUserAssignee(user.id, {
                        userId: assigneeUserId,
                        name: typeof action.assignee_name === 'string' ? action.assignee_name.trim() : assigneeUserId,
                        color: typeof action.assignee_color === 'string' ? action.assignee_color.trim() : '#6b7280'
                    })
                }
                const nextIndex =
                    typeof (action as any).next_step === 'number' && (action as any).next_step > index
                        ? (action as any).next_step
                        : index + 1
                index = nextIndex
                state.step_index = index
                continue
            }

            if (action.type === 'trigger_workflow') {
                const targetWorkflowId = typeof action.workflow_id === 'string' ? action.workflow_id.trim() : ''
                if (!targetWorkflowId) {
                    lastError = 'trigger_workflow failed: workflow_id is required'
                    break
                }
                if (targetWorkflowId === workflow.id) {
                    lastError = 'trigger_workflow failed: cannot trigger the same workflow.'
                    break
                }
                const targetWorkflow = await getWorkflowById(targetWorkflowId)
                if (!targetWorkflow) {
                    lastError = `trigger_workflow failed: workflow not found (${targetWorkflowId})`
                    break
                }
                if (targetWorkflow.company_id && targetWorkflow.company_id !== ctx.companyId) {
                    lastError = 'trigger_workflow failed: target workflow is outside this company.'
                    break
                }
                const targetState: WorkflowState = {
                    workflow_id: targetWorkflow.id,
                    step_index: 0,
                    vars: sanitizeVars(state.vars),
                    qa_history: sanitizeQaHistory(state.qa_history),
                    ...(state.state ? { state: state.state } : {})
                }
                return this.runWorkflowActions(ctx, user, targetWorkflow, targetState)
            }

            if (action.type === 'send_buttons') {
                state.step_index = index + 1
                const buttons = normalizeButtons(action.buttons || []).map((button: any, buttonIndex: number) => ({
                    id: typeof button?.id === 'string' && button.id.trim() ? button.id.trim() : `option_${buttonIndex + 1}`,
                    title: renderDynamicText(button?.title || '', state, user, ctx) || `Option ${buttonIndex + 1}`
                }))
                state.awaiting_buttons = buttons.map(b => b.id)
                state.awaiting_routes = action.routes
                const header =
                    action.header?.type === 'text'
                        ? { ...action.header, text: renderDynamicText(action.header?.text || '', state, user, ctx) }
                        : action.header

                try {
                    await sendWhatsAppMessage({
                        client: ctx.client,
                        userId: user.id,
                        to: ctx.phoneNumber,
                        type: 'buttons',
                        content: {
                            text: renderDynamicText(action.text, state, user, ctx),
                            buttons,
                            header,
                            footer: renderDynamicText(action.footer || '', state, user, ctx),
                            template: action.template
                        },
                        workflowState: state
                    })
                    replied = true
                } catch (error: any) {
                    const msg = error?.message || String(error)
                    console.warn('[Workflow] send_buttons failed:', msg)
                    lastError = `send_buttons failed: ${msg}`
                }

                break
            }

            if (action.type === 'send_list') {
                state.step_index = index + 1
                const usedRowIds = new Set<string>()
                let rowGlobalIndex = 0
                const rawSections = Array.isArray(action.sections) ? action.sections : []
                const sections = rawSections.map((section: any, sectionIndex: number) => {
                    const renderedTitle = section?.title
                        ? renderDynamicText(section.title, state, user, ctx).trim()
                        : ''
                    const fallbackTitle = rawSections.length > 1 ? `Section ${sectionIndex + 1}` : 'Options'
                    return {
                        // Cloud API rejects some list payloads when section title is omitted.
                        title: (renderedTitle || fallbackTitle).slice(0, 24),
                        rows: Array.isArray(section?.rows)
                            ? section.rows.map((row: any, rowIndex: number) => ({
                                id: (() => {
                                    const fallbackIndex = rowGlobalIndex
                                    rowGlobalIndex += 1
                                    const preferredId =
                                        typeof row?.id === 'string' && row.id.trim()
                                            ? row.id.trim()
                                            : ''
                                    const baseId =
                                        normalizeChoiceKey(preferredId) ||
                                        normalizeChoiceKey(row?.title || '') ||
                                        `row_${fallbackIndex + 1}`
                                    let nextId = baseId
                                    let suffix = 2
                                    while (usedRowIds.has(nextId)) {
                                        nextId = `${baseId}_${suffix}`
                                        suffix += 1
                                    }
                                    usedRowIds.add(nextId)
                                    return nextId
                                })(),
                                title:
                                    renderDynamicText(row?.title || '', state, user, ctx).trim() ||
                                    `Option ${rowIndex + 1}`,
                                ...(() => {
                                    const renderedDescription = row?.description
                                        ? renderDynamicText(row.description, state, user, ctx).trim()
                                        : ''
                                    return renderedDescription ? { description: renderedDescription } : {}
                                })()
                            }))
                            : []
                    }
                })
                const rowIds = extractListRowIds(sections)
                state.awaiting_buttons = rowIds
                state.awaiting_routes = action.routes
                const header =
                    action.header?.type === 'text'
                        ? { ...action.header, text: renderDynamicText(action.header?.text || '', state, user, ctx) }
                        : action.header

                try {
                    await sendWhatsAppMessage({
                        client: ctx.client,
                        userId: user.id,
                        to: ctx.phoneNumber,
                        type: 'list',
                        content: {
                            text: renderDynamicText(action.text, state, user, ctx).trim() || 'Please choose an option:',
                            button_text: renderDynamicText(action.button_text, state, user, ctx).trim() || 'View options',
                            sections,
                            header,
                            footer: renderDynamicText(action.footer || '', state, user, ctx),
                            template: action.template
                        },
                        workflowState: state
                    })
                    replied = true
                } catch (error: any) {
                    const msg = error?.message || String(error)
                    console.warn('[Workflow] send_list failed:', msg)
                    lastError = `send_list failed: ${msg}`
                }

                break
            }

            if (action.type === 'send_cta_url') {
                state.step_index = index + 1
                const header =
                    action.header?.type === 'text'
                        ? { ...action.header, text: renderDynamicText(action.header?.text || '', state, user, ctx) }
                        : action.header
                try {
                    await sendWhatsAppMessage({
                        client: ctx.client,
                        userId: user.id,
                        to: ctx.phoneNumber,
                        type: 'cta_url',
                        content: {
                            body: renderDynamicText(action.body, state, user, ctx),
                            button_text: renderDynamicText(action.button_text, state, user, ctx),
                            url: renderDynamicText(action.url, state, user, ctx),
                            header,
                            footer: renderDynamicText(action.footer || '', state, user, ctx),
                            template: action.template
                        },
                        workflowState: state
                    })
                    replied = true
                } catch (error: any) {
                    const msg = error?.message || String(error)
                    console.warn('[Workflow] send_cta_url failed:', msg)
                    lastError = `send_cta_url failed: ${msg}`
                }
                break
            }

            if (action.type === 'simulate_payment') {
                const paymentUrl = renderDynamicText(action.payment_url || '', state, user, ctx).trim()
                if (!paymentUrl) {
                    lastError = 'simulate_payment failed: payment_url is required'
                    break
                }

                const bodyTemplate =
                    typeof action.body === 'string' && action.body.trim()
                        ? action.body
                        : 'Please complete your payment using the link below.'
                const pendingTemplate =
                    typeof action.pending_text === 'string' && action.pending_text.trim()
                        ? action.pending_text
                        : DEFAULT_PAYMENT_PENDING_TEXT
                const receiptTemplate =
                    typeof action.receipt_text === 'string' && action.receipt_text.trim()
                        ? action.receipt_text
                        : DEFAULT_PAYMENT_RECEIPT_TEXT
                const expiredTemplate =
                    typeof action.expired_text === 'string' && action.expired_text.trim()
                        ? action.expired_text
                        : DEFAULT_PAYMENT_EXPIRED_TEXT

                const amount = typeof action.amount === 'string' ? renderDynamicText(action.amount, state, user, ctx).trim() : ''
                const currencyRaw = typeof action.currency === 'string' ? renderDynamicText(action.currency, state, user, ctx).trim() : ''
                const currency = currencyRaw ? currencyRaw.toUpperCase() : ''
                const expiresInMinutes = parsePositiveInt(action.expires_in_minutes)
                const nextStep =
                    typeof (action as any).next_step === 'number' && (action as any).next_step > index
                        ? (action as any).next_step
                        : index + 1

                state.awaiting_payment = {
                    body: bodyTemplate,
                    payment_url: paymentUrl,
                    button_text: typeof action.button_text === 'string' ? action.button_text : 'Pay now',
                    ...(amount ? { amount } : {}),
                    ...(currency ? { currency } : {}),
                    success_keywords: normalizePaymentKeywords(action.success_keywords),
                    pending_text: pendingTemplate,
                    receipt_text: receiptTemplate,
                    expired_text: expiredTemplate,
                    ...(expiresInMinutes ? { expires_at: new Date(Date.now() + (expiresInMinutes * 60 * 1000)).toISOString() } : {}),
                    next_step: nextStep,
                    expired_notified: false
                }
                state.fallback_count = 0
                state.step_index = index

                try {
                    await sendWhatsAppMessage({
                        client: ctx.client,
                        userId: user.id,
                        to: ctx.phoneNumber,
                        type: 'buttons',
                        content: {
                            text: buildSimulatedPaymentPrompt(
                                renderDynamicText(bodyTemplate, state, user, ctx),
                                paymentUrl,
                                amount,
                                currency
                            ),
                            buttons: normalizeButtons([
                                { id: PAYMENT_SUCCESS_BUTTON_ID, title: PAYMENT_SUCCESS_BUTTON_TITLE },
                                { id: PAYMENT_NOT_SUCCESS_BUTTON_ID, title: PAYMENT_NOT_SUCCESS_BUTTON_TITLE }
                            ])
                        },
                        workflowState: state
                    })
                    replied = true
                } catch (error: any) {
                    const msg = error?.message || String(error)
                    console.warn('[Workflow] simulate_payment failed:', msg)
                    lastError = `simulate_payment failed: ${msg}`
                }
                break
            }

            if (action.type === 'end_flow') {
                if (typeof workflow?.id === 'string' && workflow.id.trim()) {
                    completedWorkflowId = workflow.id.trim()
                }
                state.step_index = index + 1
                break
            }

            index += 1
            state.step_index = index
        }

        const result: WorkflowProcessResult = lastError
            ? { error: lastError, handled: true, replied }
            : { handled: true, replied }
        if (completedWorkflowId) {
            result.completedWorkflowId = completedWorkflowId
        }
        return result
    }
}
