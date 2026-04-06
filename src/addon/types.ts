
export interface WebhookEvent {
    id: string
    event: string
    payload: any
    profileId: string
    timestamp: string
    attempts: number
    nextRetry: number
    targetUrl?: string
    secret?: string
}


export interface WebhookConfig {
    url: string
    events: string[]
    secret?: string // For signature
    enabled: boolean
}

export interface AddonConfig {
    webhooks: Record<string, WebhookConfig[]> // profileId -> configs
}

export interface SendMessagePayload {
    phone: string
    message?: string
    media?: string // URL or Base64? Spec says "media (optional)"
    caption?: string
}
