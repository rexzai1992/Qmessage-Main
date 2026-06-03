export type WabaConfig = {
    profileId: string
    companyId?: string
    appId?: string
    phoneNumberId: string
    businessId?: string
    clientBusinessId?: string
    wabaId?: string
    businessAccountId?: string
    accessToken: string
    accessTokenType?: string
    accessTokenExpiresAt?: string | null
    tokenSource?: 'user' | 'system_user' | 'business_integration'
    verifyToken: string
    appSecret?: string
    apiVersion: string
    windowReminderEnabled?: boolean
    windowReminderMinutes?: number
    windowReminderText?: string
}

export type WabaMedia = {
    id: string
    mime_type?: string
    sha256?: string
    caption?: string
    filename?: string
    file_size?: number
}

export type WabaInboundMessage = {
    phoneNumberId: string
    from: string
    groupId?: string
    id: string
    timestamp: number
    type: string
    text?: { body?: string }
    button?: { payload?: string; text?: string }
    interactive?: {
        type?: string
        button_reply?: { id?: string; title?: string }
        list_reply?: { id?: string; title?: string; description?: string }
        call_permission_reply?: {
            response?: string
            is_permanent?: boolean
            expiration_timestamp?: string | number
            response_source?: string
        }
    }
    context?: {
        id?: string
        from?: string
    }
    image?: WabaMedia
    document?: WabaMedia
    audio?: WabaMedia
    video?: WabaMedia
    referral?: {
        source_url?: string
        source_type?: string
        source_id?: string
        headline?: string
        body?: string
        media_type?: string
        image_url?: string
        video_url?: string
        thumbnail_url?: string
        ctwa_clid?: string
        [key: string]: any
    } | null
    contactName?: string
    buttonReplyId?: string
    buttonReplyTitle?: string
    buttonReplyDescription?: string
    webhookField?: string
    eventCategory?: 'message' | 'coexistence_history' | 'coexistence_echo' | 'coexistence_state_sync' | 'call_permission_reply'
    callPermissionReply?: {
        response?: string
        isPermanent?: boolean
        expirationTimestamp?: number | null
        responseSource?: string
        contextId?: string | null
        contextFrom?: string | null
    } | null
    raw: any
}

export type WabaStatus = {
    phoneNumberId: string
    id: string
    status: string
    timestamp: number
    recipientId?: string
    recipientType?: string
    recipientParticipantId?: string
    participantRecipientId?: string
    conversation?: any
    pricing?: any
    webhookField?: string
    raw: any
}

export type WabaCallUpdate = {
    phoneNumberId: string
    id: string
    event: string
    timestamp: number
    to?: string
    from?: string
    direction?: string
    status?: string[]
    startTime?: number
    endTime?: number
    duration?: number
    deeplinkPayload?: string
    ctaPayload?: string
    bizOpaqueCallbackData?: string
    session?: {
        sdp_type?: string
        sdp?: string
    }
    contactName?: string
    errors?: any[]
    webhookField?: string
    raw: any
}

export type WabaWebhookParseResult = {
    messages: WabaInboundMessage[]
    statuses: WabaStatus[]
    calls: WabaCallUpdate[]
}
