import type { WabaConfig } from './types'

const DEFAULT_TIMEOUT_MS = 15000
const MAX_LIST_BODY_LEN = 1024
const MAX_LIST_HEADER_LEN = 60
const MAX_LIST_FOOTER_LEN = 60
const MAX_LIST_BUTTON_LEN = 20
const MAX_LIST_SECTION_TITLE_LEN = 24
const MAX_LIST_ROW_TITLE_LEN = 24
const MAX_LIST_ROW_DESC_LEN = 72
const MAX_LIST_ROW_ID_LEN = 200
const MAX_LIST_TOTAL_ROWS = 10

function trimToMax(value: unknown, max: number): string {
    if (typeof value !== 'string') return ''
    const trimmed = value.trim()
    if (!trimmed) return ''
    return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

export class WabaClient {
    private baseUrl: string

    constructor(private config: WabaConfig) {
        this.baseUrl = `https://graph.facebook.com/${config.apiVersion}`
    }

    public get profileId() {
        return this.config.profileId
    }

    public get phoneNumberId() {
        return this.config.phoneNumberId
    }

    public get verifyToken() {
        return this.config.verifyToken
    }

    public get appSecret() {
        return this.config.appSecret
    }

    private isLikelyGroupId(value: string) {
        const normalized = (value || '').trim().toLowerCase()
        if (!normalized) return false
        return normalized.startsWith('y2fwav9ncm91cd') || normalized.includes(':')
    }

    private normalizeRecipient(to: string) {
        if (!to) return ''
        const withoutDomain = to.includes('@') ? (to.split('@')[0] || '') : to
        const withoutDevice = withoutDomain.includes(':') ? (withoutDomain.split(':')[0] || '') : withoutDomain
        return withoutDevice.replace(/\D/g, '')
    }

    private parseMessageRecipient(to: string): { to: string; recipientType: 'individual' | 'group' } {
        if (!to) return { to: '', recipientType: 'individual' }
        const raw = to.trim()
        if (!raw) return { to: '', recipientType: 'individual' }

        const lower = raw.toLowerCase()
        if (lower.endsWith('@g.us')) {
            return {
                to: raw.slice(0, raw.length - '@g.us'.length).trim(),
                recipientType: 'group'
            }
        }

        if (lower.endsWith('@s.whatsapp.net') || lower.endsWith('@lid')) {
            return {
                to: this.normalizeRecipient(raw),
                recipientType: 'individual'
            }
        }

        const withoutDomain = raw.includes('@') ? (raw.split('@')[0] || '').trim() : raw
        if (this.isLikelyGroupId(withoutDomain)) {
            return {
                to: withoutDomain,
                recipientType: 'group'
            }
        }

        return {
            to: this.normalizeRecipient(withoutDomain),
            recipientType: 'individual'
        }
    }

    private sanitizeInteractiveListPayload(
        bodyText: string,
        buttonText: string,
        sections: Array<{ title?: string; rows: Array<{ id: string; title: string; description?: string }> }>
    ) {
        const body = trimToMax(bodyText, MAX_LIST_BODY_LEN) || 'Please choose an option:'
        const button = trimToMax(buttonText, MAX_LIST_BUTTON_LEN) || 'View options'
        const inputSections = Array.isArray(sections) ? sections : []
        const usedIds = new Set<string>()
        let globalRowCount = 0

        const normalizeRowId = (rawId: unknown, fallbackIndex: number) => {
            const trimmed = trimToMax(rawId, MAX_LIST_ROW_ID_LEN)
            const normalized =
                trimmed
                    .replace(/[^a-zA-Z0-9_.-]+/g, '_')
                    .replace(/^_+|_+$/g, '')
                    .slice(0, MAX_LIST_ROW_ID_LEN) || `row_${fallbackIndex + 1}`
            let next = normalized
            let suffix = 2
            while (usedIds.has(next)) {
                const base = normalized.slice(0, Math.max(1, MAX_LIST_ROW_ID_LEN - (`_${suffix}`.length)))
                next = `${base}_${suffix}`
                suffix += 1
            }
            usedIds.add(next)
            return next
        }

        const normalizedSections = inputSections
            .map((section: any) => {
                const rows = Array.isArray(section?.rows) ? section.rows : []
                const normalizedRows: Array<{ id: string; title: string; description?: string }> = []

                for (const row of rows) {
                    if (globalRowCount >= MAX_LIST_TOTAL_ROWS) break
                    const title =
                        trimToMax(row?.title, MAX_LIST_ROW_TITLE_LEN) ||
                        trimToMax(row?.id, MAX_LIST_ROW_TITLE_LEN) ||
                        `Option ${globalRowCount + 1}`
                    const id = normalizeRowId(row?.id, globalRowCount)
                    const description = trimToMax(row?.description, MAX_LIST_ROW_DESC_LEN)
                    normalizedRows.push({
                        id,
                        title,
                        ...(description ? { description } : {})
                    })
                    globalRowCount += 1
                }

                if (normalizedRows.length === 0) return null

                const sectionTitle = trimToMax(section?.title, MAX_LIST_SECTION_TITLE_LEN)
                return {
                    ...(sectionTitle ? { title: sectionTitle } : {}),
                    rows: normalizedRows
                }
            })
            .filter((section): section is { title?: string; rows: Array<{ id: string; title: string; description?: string }> } => Boolean(section))

        if (normalizedSections.length === 0) {
            throw new Error('sendInteractiveList requires at least one valid row')
        }

        if (normalizedSections.length > 1) {
            return {
                body,
                button,
                sections: normalizedSections.map((section, index) => ({
                    ...section,
                    title: section.title || `Section ${index + 1}`
                }))
            }
        }

        return {
            body,
            button,
            sections: normalizedSections
        }
    }

    private normalizeUserWaId(userWaId: string) {
        if (!userWaId) return ''
        const withoutDomain = userWaId.includes('@') ? (userWaId.split('@')[0] || '') : userWaId
        return withoutDomain.replace(/\D/g, '')
    }

    private async request(path: string, init: RequestInit & { json?: any } = {}) {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

        const headers: Record<string, string> = {
            Authorization: `Bearer ${this.config.accessToken}`
        }

        if (init.json !== undefined) {
            headers['Content-Type'] = 'application/json'
        }

        try {
            const res = await fetch(`${this.baseUrl}/${path}`, {
                ...init,
                body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
                headers: { ...headers, ...(init.headers || {}) },
                signal: controller.signal
            })

            const text = await res.text()
            const data = text ? JSON.parse(text) : null

            if (!res.ok) {
                const errMsg = data?.error?.message || res.statusText
                const error: any = new Error(`WABA API error ${res.status}: ${errMsg}`)
                error.status = res.status
                error.response = data || null
                throw error
            }

            if (data?.error) {
                const errMsg = data?.error?.message || 'Unknown API error'
                const error: any = new Error(`WABA API error: ${errMsg}`)
                error.status = 502
                error.response = data
                throw error
            }

            return data
        } finally {
            clearTimeout(timeout)
        }
    }

    public async sendText(to: string, body: string, previewUrl = false) {
        const recipient = this.parseMessageRecipient(to)
        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: recipient.recipientType,
            to: recipient.to,
            type: 'text',
            text: {
                body,
                preview_url: previewUrl
            }
        }

        return this.request(`${this.config.phoneNumberId}/messages`, {
            method: 'POST',
            json: payload
        })
    }

    public async sendImage(to: string, link: string, caption?: string) {
        const recipient = this.parseMessageRecipient(to)
        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: recipient.recipientType,
            to: recipient.to,
            type: 'image',
            image: {
                link,
                caption: caption || undefined
            }
        }

        return this.request(`${this.config.phoneNumberId}/messages`, {
            method: 'POST',
            json: payload
        })
    }

    public async sendInteractiveButtons(
        to: string,
        bodyText: string,
        buttons: Array<{ id: string; title: string }>,
        options: {
            header?: { type: 'text'; text: string } | { type: 'image' | 'video' | 'document'; id?: string; link?: string }
            footer?: string
        } = {}
    ) {
        const interactive: any = {
            type: 'button',
            body: { text: bodyText },
            action: {
                buttons: buttons.map(button => ({
                    type: 'reply',
                    reply: { id: button.id, title: button.title }
                }))
            }
        }

        if (options.header) {
            if (options.header.type === 'text') {
                interactive.header = { type: 'text', text: options.header.text }
            } else {
                const mediaKey = options.header.type
                const payload: any = {}
                if (options.header.id) payload.id = options.header.id
                if (options.header.link) payload.link = options.header.link
                if (Object.keys(payload).length > 0) {
                    interactive.header = { type: options.header.type, [mediaKey]: payload }
                }
            }
        }

        if (options.footer) {
            interactive.footer = { text: options.footer }
        }

        const recipient = this.parseMessageRecipient(to)
        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: recipient.recipientType,
            to: recipient.to,
            type: 'interactive',
            interactive
        }

        return this.request(`${this.config.phoneNumberId}/messages`, {
            method: 'POST',
            json: payload
        })
    }

    public async sendInteractiveList(
        to: string,
        bodyText: string,
        buttonText: string,
        sections: Array<{
            title?: string
            rows: Array<{ id: string; title: string; description?: string }>
        }>,
        options: { header?: { type: 'text'; text: string }; footer?: string } = {}
    ) {
        const normalizedPayload = this.sanitizeInteractiveListPayload(bodyText, buttonText, sections)
        const headerText = trimToMax(options.header?.text, MAX_LIST_HEADER_LEN)
        const footerText = trimToMax(options.footer, MAX_LIST_FOOTER_LEN)

        const interactive: any = {
            type: 'list',
            body: { text: normalizedPayload.body },
            action: {
                button: normalizedPayload.button,
                sections: normalizedPayload.sections
            }
        }

        if (headerText) {
            interactive.header = { type: 'text', text: headerText }
        }

        if (footerText) {
            interactive.footer = { text: footerText }
        }

        const recipient = this.parseMessageRecipient(to)
        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: recipient.recipientType,
            to: recipient.to,
            type: 'interactive',
            interactive
        }

        return this.request(`${this.config.phoneNumberId}/messages`, {
            method: 'POST',
            json: payload
        })
    }

    public async sendCtaUrl(
        to: string,
        bodyText: string,
        buttonText: string,
        url: string,
        options: {
            header?: { type: 'text'; text: string } | { type: 'image' | 'video' | 'document'; link: string }
            footer?: string
        } = {}
    ) {
        const interactive: any = {
            type: 'cta_url',
            body: { text: bodyText },
            action: {
                name: 'cta_url',
                parameters: {
                    display_text: buttonText,
                    url
                }
            }
        }

        if (options.header) {
            if (options.header.type === 'text') {
                interactive.header = { type: 'text', text: options.header.text }
            } else {
                interactive.header = {
                    type: options.header.type,
                    [options.header.type]: { link: options.header.link }
                }
            }
        }

        if (options.footer) {
            interactive.footer = { text: options.footer }
        }

        const recipient = this.parseMessageRecipient(to)
        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: recipient.recipientType,
            to: recipient.to,
            type: 'interactive',
            interactive
        }

        return this.request(`${this.config.phoneNumberId}/messages`, {
            method: 'POST',
            json: payload
        })
    }

    public async sendTemplate(
        to: string,
        name: string,
        language: string,
        components?: any[]
    ) {
        const recipient = this.parseMessageRecipient(to)
        const payload: any = {
            messaging_product: 'whatsapp',
            recipient_type: recipient.recipientType,
            to: recipient.to,
            type: 'template',
            template: {
                name,
                language: { code: language }
            }
        }

        if (components && components.length > 0) {
            payload.template.components = components
        }

        return this.request(`${this.config.phoneNumberId}/messages`, {
            method: 'POST',
            json: payload
        })
    }

    public async sendMarketingTemplate(
        to: string,
        name: string,
        language: string,
        options: {
            components?: any[]
            productPolicy?: 'STRICT' | 'CLOUD_API_FALLBACK'
            messageActivitySharing?: boolean
            ttl?: number
            degreesOfFreedomSpec?: Record<string, any>
        } = {}
    ) {
        const payload: any = {
            messaging_product: 'whatsapp',
            to: this.normalizeRecipient(to),
            type: 'template',
            template: {
                name,
                language: { code: language }
            }
        }

        if (Array.isArray(options.components) && options.components.length > 0) {
            payload.template.components = options.components
        }

        if (options.productPolicy) payload.product_policy = options.productPolicy
        if (typeof options.messageActivitySharing === 'boolean') {
            payload.message_activity_sharing = options.messageActivitySharing
        }
        if (typeof options.ttl === 'number' && Number.isFinite(options.ttl)) {
            payload.ttl = Math.max(1, Math.floor(options.ttl))
        }
        if (options.degreesOfFreedomSpec && typeof options.degreesOfFreedomSpec === 'object') {
            payload.degrees_of_freedom_spec = options.degreesOfFreedomSpec
        }

        return this.request(`${this.config.phoneNumberId}/marketing_messages`, {
            method: 'POST',
            json: payload
        })
    }

    public async sendAuthenticationTemplate(
        to: string,
        name: string,
        language: string,
        code: string
    ) {
        const recipient = this.parseMessageRecipient(to)
        const payload: any = {
            messaging_product: 'whatsapp',
            recipient_type: recipient.recipientType,
            to: recipient.to,
            type: 'template',
            template: {
                name,
                language: { code: language },
                components: [
                    {
                        type: 'body',
                        parameters: [{ type: 'text', text: code }]
                    },
                    {
                        type: 'button',
                        sub_type: 'url',
                        index: '0',
                        parameters: [{ type: 'text', text: code }]
                    }
                ]
            }
        }

        return this.request(`${this.config.phoneNumberId}/messages`, {
            method: 'POST',
            json: payload
        })
    }

    public async createMessageTemplate(
        wabaId: string,
        payload: {
            name: string
            category: string
            language: string
            parameter_format?: string
            components?: any[]
        }
    ) {
        if (!wabaId) throw new Error('wabaId is required')
        return this.request(`${wabaId}/message_templates`, {
            method: 'POST',
            json: payload
        })
    }

    public async upsertMessageTemplates(wabaId: string, payload: Record<string, any>) {
        if (!wabaId) throw new Error('wabaId is required')
        return this.request(`${wabaId}/upsert_message_templates`, {
            method: 'POST',
            json: payload
        })
    }

    public async getAuthenticationTemplatePreviews(
        wabaId: string,
        options: {
            language?: string[] | string
            addSecurityRecommendation?: boolean
            codeExpirationMinutes?: number
        } = {}
    ) {
        if (!wabaId) throw new Error('wabaId is required')
        const params = new URLSearchParams()
        params.set('category', 'AUTHENTICATION')
        params.set('button_types', 'OTP')
        if (options.language) {
            const language = Array.isArray(options.language) ? options.language.join(',') : options.language
            if (language.trim()) params.set('language', language)
        }
        if (typeof options.addSecurityRecommendation === 'boolean') {
            params.set('add_security_recommendation', String(options.addSecurityRecommendation))
        }
        if (typeof options.codeExpirationMinutes === 'number' && Number.isFinite(options.codeExpirationMinutes)) {
            params.set('code_expiration_minutes', String(Math.max(1, Math.min(90, Math.floor(options.codeExpirationMinutes)))))
        }
        return this.request(`${wabaId}/message_template_previews?${params.toString()}`, {
            method: 'GET'
        })
    }

    public async getMessageTemplate(
        templateId: string,
        fields: string[] = ['id', 'name', 'status', 'category', 'language']
    ) {
        if (!templateId) throw new Error('templateId is required')
        const query = new URLSearchParams()
        if (fields.length > 0) query.set('fields', fields.join(','))
        const suffix = query.toString()
        return this.request(`${templateId}${suffix ? `?${suffix}` : ''}`, {
            method: 'GET'
        })
    }

    public async listMessageTemplates(
        wabaId: string,
        options: {
            fields?: string[] | string
            limit?: number
            status?: string
            category?: string
            name?: string
            after?: string
            before?: string
        } = {}
    ) {
        if (!wabaId) throw new Error('wabaId is required')
        const params = new URLSearchParams()
        if (options.fields) {
            params.set('fields', Array.isArray(options.fields) ? options.fields.join(',') : options.fields)
        }
        if (typeof options.limit === 'number' && Number.isFinite(options.limit)) {
            params.set('limit', String(Math.max(1, Math.min(100, Math.floor(options.limit)))))
        }
        const status = typeof options.status === 'string' ? options.status.trim() : ''
        const category = typeof options.category === 'string' ? options.category.trim() : ''
        const name = typeof options.name === 'string' ? options.name.trim() : ''
        if (status) params.set('status', status)
        if (category) params.set('category', category)
        if (name) params.set('name', name)
        if (options.after) params.set('after', options.after)
        if (options.before) params.set('before', options.before)

        const query = params.toString()
        return this.request(`${wabaId}/message_templates${query ? `?${query}` : ''}`, {
            method: 'GET'
        })
    }

    public async getConversationalAutomation() {
        return this.request(`${this.config.phoneNumberId}?fields=conversational_automation`, {
            method: 'GET'
        })
    }

    public async setConversationalAutomation(payload: {
        enable_welcome_message?: boolean
        commands?: Array<{ command_name: string; command_description: string }>
        prompts?: string[]
    }) {
        return this.request(`${this.config.phoneNumberId}/conversational_automation`, {
            method: 'POST',
            json: payload
        })
    }

    public async getCallPermissions(userWaId: string, phoneNumberId?: string) {
        const targetPhoneNumberId = phoneNumberId || this.config.phoneNumberId
        if (!targetPhoneNumberId) {
            throw new Error('phoneNumberId is required')
        }
        const normalizedWaId = this.normalizeUserWaId(userWaId)
        if (!normalizedWaId) {
            throw new Error('user_wa_id is required')
        }

        const params = new URLSearchParams({ user_wa_id: normalizedWaId })
        return this.request(`${targetPhoneNumberId}/call_permissions?${params.toString()}`, {
            method: 'GET'
        })
    }

    public async sendCallPermissionRequest(userWaId: string, bodyText: string, phoneNumberId?: string) {
        const targetPhoneNumberId = phoneNumberId || this.config.phoneNumberId
        if (!targetPhoneNumberId) {
            throw new Error('phoneNumberId is required')
        }
        const normalizedWaId = this.normalizeUserWaId(userWaId)
        if (!normalizedWaId) {
            throw new Error('user_wa_id is required')
        }

        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: normalizedWaId,
            type: 'interactive',
            interactive: {
                type: 'call_permission_request',
                action: {
                    name: 'call_permission_request'
                },
                body: {
                    text: bodyText || 'We would like to call you to help support your request.'
                }
            }
        }

        return this.request(`${targetPhoneNumberId}/messages`, {
            method: 'POST',
            json: payload
        })
    }

    public async manageCall(payload: {
        action: 'connect' | 'pre_accept' | 'accept' | 'reject' | 'terminate'
        to?: string
        call_id?: string
        session?: {
            sdp_type: 'offer' | 'answer'
            sdp: string
        }
        biz_opaque_callback_data?: string
    }, phoneNumberId?: string) {
        const targetPhoneNumberId = phoneNumberId || this.config.phoneNumberId
        if (!targetPhoneNumberId) {
            throw new Error('phoneNumberId is required')
        }

        const action = payload?.action
        if (!action) {
            throw new Error('action is required')
        }

        const body: any = {
            messaging_product: 'whatsapp',
            action
        }

        const callId = typeof payload?.call_id === 'string' ? payload.call_id.trim() : ''
        const to = typeof payload?.to === 'string' ? this.normalizeUserWaId(payload.to) : ''
        const session = payload?.session
        const callbackData = typeof payload?.biz_opaque_callback_data === 'string'
            ? payload.biz_opaque_callback_data.trim()
            : ''

        if (action === 'terminate') {
            if (!callId) throw new Error('call_id is required for terminate action')
            body.call_id = callId
        } else if (action === 'connect') {
            if (!to) throw new Error('to is required for connect action')
            if (!session?.sdp || !session?.sdp_type) throw new Error('session.sdp and session.sdp_type are required for connect action')
            if (session.sdp_type !== 'offer') throw new Error('session.sdp_type must be "offer" for connect action')
            body.to = to
            body.session = session
        } else if (action === 'pre_accept' || action === 'accept') {
            if (!callId) throw new Error(`call_id is required for ${action} action`)
            if (!session?.sdp || !session?.sdp_type) throw new Error(`session.sdp and session.sdp_type are required for ${action} action`)
            if (session.sdp_type !== 'answer') throw new Error(`session.sdp_type must be "answer" for ${action} action`)
            body.call_id = callId
            body.session = session
        } else if (action === 'reject') {
            if (!callId) throw new Error(`call_id is required for ${action} action`)
            body.call_id = callId
        }

        if (callbackData) {
            body.biz_opaque_callback_data = callbackData.slice(0, 512)
        }

        return this.request(`${targetPhoneNumberId}/calls`, {
            method: 'POST',
            json: body
        })
    }

    public async getConnectedClientBusinesses(
        appId: string,
        options: {
            fields?: string[] | string
            limit?: number
            after?: string
            before?: string
        } = {}
    ) {
        const params = new URLSearchParams()
        if (options.fields) {
            params.set('fields', Array.isArray(options.fields) ? options.fields.join(',') : options.fields)
        }
        if (typeof options.limit === 'number' && Number.isFinite(options.limit)) {
            params.set('limit', String(Math.max(1, Math.min(100, Math.round(options.limit)))))
        }
        if (options.after) params.set('after', options.after)
        if (options.before) params.set('before', options.before)

        const query = params.toString()
        const path = `${appId}/connected_client_businesses${query ? `?${query}` : ''}`
        return this.request(path, { method: 'GET' })
    }

    public async getPhoneNumbers(wabaId?: string) {
        const targetWabaId = wabaId || this.config.wabaId || this.config.businessAccountId
        if (!targetWabaId) {
            throw new Error('WABA ID is required to fetch phone numbers')
        }
        return this.request(`${targetWabaId}/phone_numbers`, {
            method: 'GET'
        })
    }

    public async addPreverifiedPhoneNumber(businessPortfolioId: string, phoneNumber: string) {
        if (!businessPortfolioId) throw new Error('businessPortfolioId is required')
        if (!phoneNumber) throw new Error('phoneNumber is required')
        const query = new URLSearchParams({ phone_number: phoneNumber })
        return this.request(`${businessPortfolioId}/add_phone_numbers?${query.toString()}`, {
            method: 'POST'
        })
    }

    public async getPreverifiedNumbers(
        businessPortfolioId: string,
        options: { codeVerificationStatus?: string } = {}
    ) {
        if (!businessPortfolioId) throw new Error('businessPortfolioId is required')
        const params = new URLSearchParams()
        if (options.codeVerificationStatus) {
            params.set('code_verification_status', options.codeVerificationStatus)
        }
        const path = `${businessPortfolioId}/preverified_numbers${params.toString() ? `?${params.toString()}` : ''}`
        return this.request(path, {
            method: 'GET'
        })
    }

    public async requestPreverifiedNumberCode(
        preverifiedPhoneNumberId: string,
        codeMethod: 'SMS' | 'VOICE',
        language = 'en_US'
    ) {
        if (!preverifiedPhoneNumberId) throw new Error('preverifiedPhoneNumberId is required')
        const params = new URLSearchParams({
            code_method: codeMethod,
            language
        })
        return this.request(`${preverifiedPhoneNumberId}/request_code?${params.toString()}`, {
            method: 'POST'
        })
    }

    public async verifyPreverifiedNumberCode(preverifiedPhoneNumberId: string, code: string) {
        if (!preverifiedPhoneNumberId) throw new Error('preverifiedPhoneNumberId is required')
        if (!code) throw new Error('code is required')
        const params = new URLSearchParams({ code })
        return this.request(`${preverifiedPhoneNumberId}/verify_code?${params.toString()}`, {
            method: 'POST'
        })
    }

    public async sharePreverifiedNumber(businessId: string, partnerBusinessId: string, preverifiedId: string) {
        if (!businessId) throw new Error('businessId is required')
        if (!partnerBusinessId) throw new Error('partnerBusinessId is required')
        if (!preverifiedId) throw new Error('preverifiedId is required')
        const params = new URLSearchParams({
            partner_business_id: partnerBusinessId,
            preverified_id: preverifiedId
        })
        return this.request(`${businessId}/share_preverified_numbers?${params.toString()}`, {
            method: 'POST'
        })
    }

    public async unsharePreverifiedNumber(businessId: string, partnerBusinessId: string, preverifiedId: string) {
        if (!businessId) throw new Error('businessId is required')
        if (!partnerBusinessId) throw new Error('partnerBusinessId is required')
        if (!preverifiedId) throw new Error('preverifiedId is required')
        const params = new URLSearchParams({
            partner_business_id: partnerBusinessId,
            preverified_id: preverifiedId
        })
        return this.request(`${businessId}/share_preverified_numbers?${params.toString()}`, {
            method: 'DELETE'
        })
    }

    public async requestVerificationCode(phoneNumberId: string, codeMethod: 'SMS' | 'VOICE', language = 'en_US') {
        if (!phoneNumberId) throw new Error('phoneNumberId is required')
        const params = new URLSearchParams({
            code_method: codeMethod,
            language
        })
        return this.request(`${phoneNumberId}/request_code?${params.toString()}`, {
            method: 'POST'
        })
    }

    public async verifyPhoneNumberCode(phoneNumberId: string, code: string) {
        if (!phoneNumberId) throw new Error('phoneNumberId is required')
        if (!code) throw new Error('code is required')
        return this.request(`${phoneNumberId}/verify_code`, {
            method: 'POST',
            json: { code }
        })
    }

    public async registerPhoneNumber(
        phoneNumberId: string,
        pin: string,
        options: { dataLocalizationRegion?: string } = {}
    ) {
        if (!phoneNumberId) throw new Error('phoneNumberId is required')
        if (!pin) throw new Error('pin is required')
        const dataLocalizationRegion = typeof options.dataLocalizationRegion === 'string'
            ? options.dataLocalizationRegion.trim().toUpperCase()
            : ''
        const payload: Record<string, any> = {
            messaging_product: 'whatsapp',
            pin
        }
        if (dataLocalizationRegion) {
            payload.data_localization_region = dataLocalizationRegion
        }
        return this.request(`${phoneNumberId}/register`, {
            method: 'POST',
            json: payload
        })
    }

    public async deregisterPhoneNumber(phoneNumberId: string) {
        if (!phoneNumberId) throw new Error('phoneNumberId is required')
        return this.request(`${phoneNumberId}/deregister`, {
            method: 'POST'
        })
    }

    public async updateBusinessProfile(phoneNumberId: string, profile: Record<string, any>) {
        if (!phoneNumberId) throw new Error('phoneNumberId is required')
        return this.request(`${phoneNumberId}/whatsapp_business_profile`, {
            method: 'POST',
            json: {
                messaging_product: 'whatsapp',
                ...profile
            }
        })
    }

    public async getBusinessProfile(
        phoneNumberId: string,
        fields: string[] = ['about', 'address', 'description', 'email', 'profile_picture_url', 'websites', 'vertical']
    ) {
        if (!phoneNumberId) throw new Error('phoneNumberId is required')
        const params = new URLSearchParams()
        if (Array.isArray(fields) && fields.length > 0) {
            params.set('fields', fields.join(','))
        }
        const query = params.toString()
        return this.request(`${phoneNumberId}/whatsapp_business_profile${query ? `?${query}` : ''}`, {
            method: 'GET'
        })
    }

    public async getPhoneNumberSettings(
        phoneNumberId: string,
        options: { includeSipCredentials?: boolean } = {}
    ) {
        if (!phoneNumberId) throw new Error('phoneNumberId is required')
        const params = new URLSearchParams()
        if (options.includeSipCredentials) {
            params.set('include_sip_credentials', 'true')
        }
        const query = params.toString()
        return this.request(`${phoneNumberId}/settings${query ? `?${query}` : ''}`, {
            method: 'GET'
        })
    }

    public async updatePhoneNumberSettings(phoneNumberId: string, settings: Record<string, any>) {
        if (!phoneNumberId) throw new Error('phoneNumberId is required')
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
            throw new Error('settings object is required')
        }
        return this.request(`${phoneNumberId}/settings`, {
            method: 'POST',
            json: settings
        })
    }

    public async sendMedia(
        to: string,
        type: 'image' | 'video' | 'audio' | 'document',
        link: string,
        options: { caption?: string; filename?: string; mimeType?: string } = {}
    ) {
        const recipient = this.parseMessageRecipient(to)
        const payload: any = {
            messaging_product: 'whatsapp',
            recipient_type: recipient.recipientType,
            to: recipient.to,
            type,
            [type]: {
                link
            }
        }

        if (options.caption && (type === 'image' || type === 'video' || type === 'document')) {
            payload[type].caption = options.caption
        }

        if (type === 'document' && options.filename) {
            payload[type].filename = options.filename
        }

        return this.request(`${this.config.phoneNumberId}/messages`, {
            method: 'POST',
            json: payload
        })
    }

    public async sendMediaById(
        to: string,
        type: 'image' | 'video' | 'audio' | 'document',
        id: string,
        options: { caption?: string; filename?: string; mimeType?: string } = {}
    ) {
        const recipient = this.parseMessageRecipient(to)
        const payload: any = {
            messaging_product: 'whatsapp',
            recipient_type: recipient.recipientType,
            to: recipient.to,
            type,
            [type]: {
                id
            }
        }

        if (options.caption && (type === 'image' || type === 'video' || type === 'document')) {
            payload[type].caption = options.caption
        }

        if (type === 'document' && options.filename) {
            payload[type].filename = options.filename
        }

        return this.request(`${this.config.phoneNumberId}/messages`, {
            method: 'POST',
            json: payload
        })
    }

    public async uploadMedia(params: {
        fileBuffer: Buffer
        fileName?: string
        fileType?: string
        messagingProduct?: string
        phoneNumberId?: string
    }) {
        const targetPhoneNumberId = params.phoneNumberId || this.config.phoneNumberId
        if (!targetPhoneNumberId) throw new Error('phoneNumberId is required')
        if (!Buffer.isBuffer(params.fileBuffer) || params.fileBuffer.byteLength === 0) {
            throw new Error('fileBuffer is required')
        }

        const fileName = (params.fileName || '').trim() || `media_${Date.now()}`
        const fileType = (params.fileType || '').trim() || 'application/octet-stream'
        const messagingProduct = (params.messagingProduct || '').trim() || 'whatsapp'

        const form = new FormData()
        const blob = new Blob([params.fileBuffer], { type: fileType })
        form.append('file', blob, fileName)
        form.append('messaging_product', messagingProduct)

        return this.request(`${targetPhoneNumberId}/media`, {
            method: 'POST',
            body: form
        })
    }

    public async getMediaMetadata(mediaId: string) {
        return this.request(mediaId, { method: 'GET' })
    }

    public async downloadMedia(mediaId: string) {
        const metadata = await this.getMediaMetadata(mediaId)
        const url = metadata?.url
        if (!url) {
            throw new Error('Media URL not found in metadata')
        }

        const res = await fetch(url, {
            headers: {
                Authorization: `Bearer ${this.config.accessToken}`
            }
        })

        if (!res.ok) {
            throw new Error(`Media download failed: ${res.status} ${res.statusText}`)
        }

        const arrayBuffer = await res.arrayBuffer()
        return {
            buffer: Buffer.from(arrayBuffer),
            mimeType: metadata?.mime_type || res.headers.get('content-type') || 'application/octet-stream',
            fileName: metadata?.file_name
        }
    }
}
