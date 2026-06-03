import type { WabaClient } from '../waba/client'
import { supabase } from '../supabase'
import { getLastInboundTimestamp, insertMessage, shouldMarkCtaReplyCandidate } from './wa-store'

const WINDOW_MS = 24 * 60 * 60 * 1000

export type SendMessageInput = {
    client: WabaClient
    userId: string
    profileId?: string | null
    to: string
    type: 'text' | 'buttons' | 'list' | 'cta_url' | 'template'
    content: any
    actor?: {
        user_id: string
        name: string
        color: string
    } | null
    workflowState?: any | null
}

const MAX_BUTTONS = 3

type PausedWhatsappConnectionSnapshot = {
    profile_id?: string | null
    status?: string | null
    coexistence_status?: string | null
    messaging_paused?: boolean | null
    last_account_update_event?: string | null
    phone_number?: string | null
    phone_number_id?: string | null
    waba_id?: string | null
}

function trimText(value: any): string {
    return typeof value === 'string' ? value.trim() : ''
}

function isMissingWhatsappConnectionsSchemaError(error: any): boolean {
    const code = typeof error?.code === 'string' ? error.code : ''
    const message = String(error?.message || '').toLowerCase()
    if (code === 'PGRST205') return message.includes('whatsapp_connections')
    if (code === '42P01') return message.includes('whatsapp_connections')
    if (code === '42703') {
        return (
            message.includes('messaging_paused') ||
            message.includes('last_account_update_event') ||
            message.includes('coexistence_status')
        )
    }
    return false
}

async function getPausedWhatsappConnectionSnapshot(profileId?: string | null): Promise<PausedWhatsappConnectionSnapshot | null> {
    const resolvedProfileId = trimText(profileId)
    if (!resolvedProfileId) return null

    const { data, error } = await supabase
        .from('whatsapp_connections')
        .select('profile_id, status, coexistence_status, messaging_paused, last_account_update_event, phone_number, phone_number_id, waba_id')
        .eq('profile_id', resolvedProfileId)
        .eq('messaging_paused', true)
        .order('updated_at', { ascending: false })
        .limit(1)

    if (error) {
        if (isMissingWhatsappConnectionsSchemaError(error)) return null
        throw error
    }

    const row = Array.isArray(data) ? data[0] : null
    return row?.messaging_paused === true ? row : null
}

function buildMessagingPausedError(snapshot: PausedWhatsappConnectionSnapshot): Error {
    const numberLabel =
        trimText(snapshot.phone_number) ||
        trimText(snapshot.phone_number_id) ||
        trimText(snapshot.waba_id) ||
        'this WhatsApp number'
    const lastEvent = trimText(snapshot.last_account_update_event).toUpperCase()
    const status = trimText(snapshot.coexistence_status || snapshot.status).toLowerCase()

    let detail = 'Cloud API messaging is currently paused for this coexistence connection.'
    if (lastEvent === 'ACCOUNT_OFFBOARDED' || status === 'offboarded_reconnecting') {
        detail = 'Meta reported ACCOUNT_OFFBOARDED. Cloud API messaging stays paused until Meta sends ACCOUNT_RECONNECTED.'
    } else if (lastEvent === 'PARTNER_REMOVED') {
        detail = 'Meta reported PARTNER_REMOVED. Reconnect the number through the WhatsApp Business App coexistence flow before sending again.'
    } else if (lastEvent) {
        detail = `Meta reported ${lastEvent}. Cloud API messaging stays paused until the coexistence connection is active again.`
    }

    return new Error(`Cloud API sending is paused for ${numberLabel}. ${detail}`)
}

function normalizeButtons(buttons: Array<{ id: string; title: string }> = []) {
    if (buttons.length <= MAX_BUTTONS) return buttons
    console.warn(`[WhatsApp] Buttons capped at ${MAX_BUTTONS}; trimming ${buttons.length} -> ${MAX_BUTTONS}`)
    return buttons.slice(0, MAX_BUTTONS)
}

type OutboundInlineMedia = {
    type: 'image' | 'video' | 'document'
    id?: string
    link?: string
    assetKey?: string
    filename?: string
}

function normalizeInlineMedia(raw: any): OutboundInlineMedia | null {
    const type = typeof raw?.type === 'string' ? raw.type.toLowerCase() : ''
    const id = typeof raw?.id === 'string' ? raw.id.trim() : ''
    const link = typeof raw?.link === 'string' ? raw.link.trim() : ''
    const assetKey = typeof raw?.assetKey === 'string' ? raw.assetKey.trim() : ''
    if (!id && !link) return null
    if (type !== 'image' && type !== 'video' && type !== 'document') return null
    const filename = typeof raw?.filename === 'string' ? raw.filename.trim() : ''
    return {
        type,
        ...(id ? { id } : {}),
        ...(link ? { link } : {}),
        ...(assetKey ? { assetKey } : {}),
        ...(type === 'document' && filename ? { filename } : {})
    }
}

function normalizeErrorMessage(error: any): string {
    if (!error) return ''
    if (typeof error === 'string') return error
    if (typeof error?.message === 'string') return error.message
    try {
        return JSON.stringify(error)
    } catch {
        return String(error)
    }
}

function isOutside24hWindowError(error: any): boolean {
    const message = normalizeErrorMessage(error).toLowerCase()
    if (!message) return false
    return (
        message.includes('outside 24h') ||
        message.includes('outside the 24') ||
        message.includes('more than 24 hours') ||
        message.includes('24-hour') ||
        message.includes('24 hour') ||
        message.includes('template message') ||
        message.includes('requires a template')
    )
}

export async function canReplyFreely(userId: string): Promise<boolean> {
    const lastInbound = await getLastInboundTimestamp(userId)
    if (!lastInbound) return false
    const lastTime = new Date(lastInbound).getTime()
    return Date.now() - lastTime <= WINDOW_MS
}

export async function sendWhatsAppMessage(input: SendMessageInput) {
    const { client, userId, profileId, to, type, workflowState, actor } = input
    let { content } = input
    const resolvedProfileId = trimText(profileId) || trimText(client?.profileId)
    const messageActor =
        actor ||
        (workflowState
            ? {
                user_id: 'automation',
                name: 'Automation',
                color: '#2563eb'
            }
            : null)
    const pausedConnection = await getPausedWhatsappConnectionSnapshot(resolvedProfileId)
    if (pausedConnection) {
        throw buildMessagingPausedError(pausedConnection)
    }
    const withinWindow = await canReplyFreely(userId)
    const sentAtIso = new Date().toISOString()
    const inlineMedia = type === 'text' ? normalizeInlineMedia(content?.media) : null

    let response: any = null

    try {
        if (type === 'template') {
            response = await client.sendTemplate(to, content.name, content.language || 'en_US', content.components)
        } else if (!withinWindow && content?.template) {
            response = await client.sendTemplate(to, content.template.name, content.template.language || 'en_US', content.template.components)
        } else if (type === 'text') {
            if (inlineMedia) {
                if (inlineMedia.id) {
                    response = await client.sendMediaById(to, inlineMedia.type, inlineMedia.id, {
                        caption: content.text || undefined,
                        ...(inlineMedia.type === 'document' && inlineMedia.filename ? { filename: inlineMedia.filename } : {})
                    })
                } else if (inlineMedia.link) {
                    response = await client.sendMedia(to, inlineMedia.type, inlineMedia.link, {
                        caption: content.text || undefined,
                        ...(inlineMedia.type === 'document' && inlineMedia.filename ? { filename: inlineMedia.filename } : {})
                    })
                } else {
                    throw new Error('Inline media is missing both id and link.')
                }
            } else {
                response = await client.sendText(to, content.text)
            }
        } else if (type === 'buttons') {
            const buttons = normalizeButtons(content.buttons || [])
            content = { ...content, buttons }
            response = await client.sendInteractiveButtons(to, content.text, buttons, {
                header: content.header,
                footer: content.footer
            })
        } else if (type === 'list') {
            response = await client.sendInteractiveList(
                to,
                content.text || content.body || '',
                content.button_text || content.buttonText || content.button || '',
                content.sections || [],
                {
                    header: content.header,
                    footer: content.footer
                }
            )
        } else if (type === 'cta_url') {
            response = await client.sendCtaUrl(
                to,
                content.body || content.text || '',
                content.button_text || content.display_text || '',
                content.url,
                {
                    header: content.header,
                    footer: content.footer
                }
            )
        } else {
            throw new Error(`Unsupported message type: ${type}`)
        }
    } catch (error: any) {
        if (isOutside24hWindowError(error)) {
            throw new Error('Outside 24h window: template required')
        }
        throw error
    }

    const messageId = response?.messages?.[0]?.id
    if (!messageId) {
        throw new Error('WABA API response missing message ID')
    }

    const persistedType = type === 'text' && inlineMedia ? inlineMedia.type : type
    const ctaReplyCandidate = await shouldMarkCtaReplyCandidate(userId, sentAtIso)
    const persistedContent: any = {
        type: persistedType,
        to,
        message_id: messageId,
        payload: content,
        status: 'sent',
        sent_at: sentAtIso,
        cta_entry_candidate: ctaReplyCandidate,
        agent: messageActor
    }
    if (inlineMedia) {
        if (inlineMedia.id) {
            persistedContent.media_id = inlineMedia.id
        }
        if (inlineMedia.assetKey) {
            persistedContent.media_asset_key = inlineMedia.assetKey
        }
        if (inlineMedia.type === 'image') {
            if (inlineMedia.link) persistedContent.image_url = inlineMedia.link
            persistedContent.caption = content.text || ''
        } else if (inlineMedia.type === 'video') {
            if (inlineMedia.link) persistedContent.video_url = inlineMedia.link
            persistedContent.caption = content.text || ''
        } else if (inlineMedia.type === 'document') {
            if (inlineMedia.link) persistedContent.document_url = inlineMedia.link
            persistedContent.filename = inlineMedia.filename || 'document'
            persistedContent.caption = content.text || ''
        }
    }
    await insertMessage({
        userId,
        profileId,
        direction: 'out',
        content: persistedContent,
        workflowState: workflowState ?? null
    })

    return { response, messageId }
}
