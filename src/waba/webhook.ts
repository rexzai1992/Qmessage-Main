import crypto from 'crypto'
import type { WabaCallUpdate, WabaInboundMessage, WabaStatus, WabaWebhookParseResult } from './types'

export function verifyWabaSignature(rawBody: Buffer, signatureHeader: string | undefined, appSecrets: string[]): boolean {
    if (!appSecrets || appSecrets.length === 0) return true
    if (!signatureHeader) return false

    const signature = signatureHeader.replace('sha256=', '')
    if (!signature) return false

    for (const secret of appSecrets) {
        if (!secret) continue
        const hmac = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
        try {
            const sigBuf = Buffer.from(signature, 'hex')
            const hmacBuf = Buffer.from(hmac, 'hex')
            if (sigBuf.length === hmacBuf.length && crypto.timingSafeEqual(sigBuf, hmacBuf)) {
                return true
            }
        } catch {
            // ignore and continue
        }
    }

    return false
}

export function parseWabaWebhook(payload: any): WabaWebhookParseResult {
    const messages: WabaInboundMessage[] = []
    const statuses: WabaStatus[] = []
    const calls: WabaCallUpdate[] = []

    const entries = payload?.entry || []

    for (const entry of entries) {
        const changes = entry?.changes || []
        for (const change of changes) {
            const webhookField = typeof change?.field === 'string' ? change.field : ''
            const normalizedField = webhookField.trim().toLowerCase()
            const isCoexistenceHistoryField = normalizedField.includes('history')
            const isCoexistenceEchoField = normalizedField.includes('smb_message_echoes')
            const isCoexistenceStateSyncField =
                normalizedField.includes('smb_app_state_sync') ||
                normalizedField.includes('state_sync')
            const value = change?.value || {}
            const metadata = value?.metadata || {}
            const phoneNumberId = metadata?.phone_number_id
            const contacts = value?.contacts || []
            const contactMap = new Map<string, string>()

            for (const contact of contacts) {
                if (contact?.wa_id) {
                    contactMap.set(contact.wa_id, contact?.profile?.name)
                }
            }

            const inboundMessages = value?.messages || []
            for (const msg of inboundMessages) {
                if (!msg?.from || !msg?.id) continue
                const contactName = contactMap.get(msg.from)
                const referral =
                    (msg?.referral && typeof msg.referral === 'object' ? msg.referral : null) ||
                    (msg?.context?.referral && typeof msg.context.referral === 'object' ? msg.context.referral : null)
                const buttonReplyId =
                    msg?.button?.payload ||
                    msg?.interactive?.button_reply?.id ||
                    msg?.interactive?.list_reply?.id
                const buttonReplyTitle =
                    msg?.button?.text ||
                    msg?.interactive?.button_reply?.title ||
                    msg?.interactive?.list_reply?.title
                const buttonReplyDescription =
                    msg?.interactive?.list_reply?.description
                const interactiveType =
                    typeof msg?.interactive?.type === 'string'
                        ? msg.interactive.type.trim().toLowerCase()
                        : ''
                const callPermissionReply =
                    interactiveType === 'call_permission_reply' && msg?.interactive?.call_permission_reply
                        ? {
                            response: typeof msg.interactive.call_permission_reply.response === 'string'
                                ? msg.interactive.call_permission_reply.response
                                : undefined,
                            isPermanent: msg.interactive.call_permission_reply.is_permanent === true,
                            expirationTimestamp:
                                msg.interactive.call_permission_reply.expiration_timestamp !== undefined
                                    ? Number(msg.interactive.call_permission_reply.expiration_timestamp || 0)
                                    : null,
                            responseSource: typeof msg.interactive.call_permission_reply.response_source === 'string'
                                ? msg.interactive.call_permission_reply.response_source
                                : undefined,
                            contextId: typeof msg?.context?.id === 'string' ? msg.context.id : null,
                            contextFrom: typeof msg?.context?.from === 'string' ? msg.context.from : null
                        }
                        : null
                const eventCategory = callPermissionReply
                    ? 'call_permission_reply'
                    : isCoexistenceEchoField
                        ? 'coexistence_echo'
                        : isCoexistenceStateSyncField
                            ? 'coexistence_state_sync'
                            : isCoexistenceHistoryField
                                ? 'coexistence_history'
                                : 'message'
                messages.push({
                    phoneNumberId,
                    from: msg.from,
                    groupId: typeof msg.group_id === 'string' ? msg.group_id : undefined,
                    id: msg.id,
                    timestamp: Number(msg.timestamp || 0),
                    type: msg.type,
                    text: msg.text,
                    button: msg.button,
                    interactive: msg.interactive,
                    context: msg?.context && typeof msg.context === 'object'
                        ? {
                            id: typeof msg.context.id === 'string' ? msg.context.id : undefined,
                            from: typeof msg.context.from === 'string' ? msg.context.from : undefined
                        }
                        : undefined,
                    image: msg.image,
                    document: msg.document,
                    audio: msg.audio,
                    video: msg.video,
                    referral,
                    contactName,
                    buttonReplyId,
                    buttonReplyTitle,
                    buttonReplyDescription,
                    webhookField,
                    eventCategory,
                    callPermissionReply,
                    raw: msg
                })
            }

            const statusUpdates = value?.statuses || []
            for (const status of statusUpdates) {
                if (!status?.id) continue
                const recipientParticipantId =
                    typeof status.recipient_participant_id === 'string'
                        ? status.recipient_participant_id
                        : undefined
                const participantRecipientId =
                    typeof status.participant_recipient_id === 'string'
                        ? status.participant_recipient_id
                        : undefined
                statuses.push({
                    phoneNumberId,
                    id: status.id,
                    status: status.status,
                    timestamp: Number(status.timestamp || 0),
                    recipientId: status.recipient_id,
                    recipientType: status.recipient_type,
                    recipientParticipantId,
                    participantRecipientId,
                    conversation: status.conversation,
                    pricing:
                        status.pricing ||
                        (status?.conversation && typeof status.conversation === 'object'
                            ? status.conversation.pricing
                            : undefined),
                    webhookField,
                    raw: status
                })
            }

            const callUpdates = value?.calls || []
            const callErrors = Array.isArray(value?.errors) ? value.errors : []
            for (const call of callUpdates) {
                if (!call?.id) continue
                const callFrom = typeof call.from === 'string' ? call.from : ''
                calls.push({
                    phoneNumberId,
                    id: call.id,
                    event: typeof call.event === 'string' ? call.event : '',
                    timestamp: Number(call.timestamp || 0),
                    to: typeof call.to === 'string' ? call.to : undefined,
                    from: callFrom || undefined,
                    direction: typeof call.direction === 'string' ? call.direction : undefined,
                    status: Array.isArray(call.status)
                        ? call.status.map((entry: any) => String(entry)).filter(Boolean)
                        : typeof call.status === 'string'
                            ? [call.status]
                            : undefined,
                    startTime: call.start_time !== undefined ? Number(call.start_time || 0) : undefined,
                    endTime: call.end_time !== undefined ? Number(call.end_time || 0) : undefined,
                    duration: call.duration !== undefined ? Number(call.duration || 0) : undefined,
                    deeplinkPayload: typeof call.deeplink_payload === 'string' ? call.deeplink_payload : undefined,
                    ctaPayload: typeof call.cta_payload === 'string' ? call.cta_payload : undefined,
                    bizOpaqueCallbackData:
                        typeof call.biz_opaque_callback_data === 'string'
                            ? call.biz_opaque_callback_data
                            : undefined,
                    session: call?.session && typeof call.session === 'object'
                        ? {
                            sdp_type: typeof call.session.sdp_type === 'string' ? call.session.sdp_type : undefined,
                            sdp: typeof call.session.sdp === 'string' ? call.session.sdp : undefined
                        }
                        : undefined,
                    contactName: callFrom ? contactMap.get(callFrom) : undefined,
                    errors: callErrors,
                    webhookField,
                    raw: call
                })
            }
        }
    }

    return { messages, statuses, calls }
}
