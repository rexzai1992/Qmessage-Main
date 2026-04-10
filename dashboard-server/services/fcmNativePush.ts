import fs from 'fs'
import { cert, getApps, initializeApp } from 'firebase-admin/app'
import { getMessaging, type MulticastMessage } from 'firebase-admin/messaging'

type ServiceAccountShape = {
    project_id?: string
    client_email?: string
    private_key?: string
    [key: string]: any
}

export type NativeFcmPushSendInput = {
    tokens: string[]
    title: string
    body: string
    data?: Record<string, unknown>
    ttlSeconds?: number
    channelId?: string
    sound?: string
    iosSound?: string
    iosCategory?: string
    tag?: string
}

export type NativeFcmPushSendResult = {
    attempted: number
    successCount: number
    failureCount: number
    staleTokens: string[]
}

const isStaleTokenErrorCode = (code: string): boolean => {
    if (!code) return false
    return (
        code === 'messaging/registration-token-not-registered'
        || code === 'messaging/invalid-registration-token'
        || code === 'messaging/invalid-argument'
    )
}

const normalizeString = (value: unknown): string => {
    return typeof value === 'string' ? value.trim() : ''
}

const normalizeDataValue = (value: unknown): string => {
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    if (value === null || value === undefined) return ''
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

function loadServiceAccountFromEnv(): { account: ServiceAccountShape | null; projectId: string } {
    const envProjectId = normalizeString(process.env.FCM_PROJECT_ID)
    const rawJson = normalizeString(process.env.FCM_SERVICE_ACCOUNT_JSON)
    const rawBase64 = normalizeString(process.env.FCM_SERVICE_ACCOUNT_BASE64)
    const serviceAccountFile = normalizeString(process.env.FCM_SERVICE_ACCOUNT_FILE || process.env.GOOGLE_APPLICATION_CREDENTIALS)

    let jsonPayload = ''
    if (rawJson) {
        jsonPayload = rawJson
    } else if (rawBase64) {
        try {
            jsonPayload = Buffer.from(rawBase64, 'base64').toString('utf-8')
        } catch {
            jsonPayload = ''
        }
    } else if (serviceAccountFile && fs.existsSync(serviceAccountFile)) {
        try {
            jsonPayload = fs.readFileSync(serviceAccountFile, 'utf-8')
        } catch {
            jsonPayload = ''
        }
    }

    if (!jsonPayload) {
        return {
            account: null,
            projectId: envProjectId
        }
    }

    try {
        const parsed = JSON.parse(jsonPayload) as ServiceAccountShape
        if (typeof parsed.private_key === 'string') {
            parsed.private_key = parsed.private_key.replace(/\\n/g, '\n')
        }
        return {
            account: parsed,
            projectId: envProjectId || normalizeString(parsed.project_id)
        }
    } catch {
        return {
            account: null,
            projectId: envProjectId
        }
    }
}

export function createNativeFcmPushSender(logger: Pick<Console, 'log' | 'warn'> = console) {
    const senderName = 'qmessage-native-fcm'
    const loaded = loadServiceAccountFromEnv()

    if (!loaded.account) {
        logger.log('[native-push] FCM credentials are not configured. Native FCM push is disabled.')
        return {
            enabled: false as const,
            send: async (_input: NativeFcmPushSendInput): Promise<NativeFcmPushSendResult> => ({
                attempted: 0,
                successCount: 0,
                failureCount: 0,
                staleTokens: []
            })
        }
    }

    try {
        const existingApp = getApps().find((app) => app.name === senderName)
        const app = existingApp || initializeApp(
            {
                credential: cert(loaded.account as any),
                ...(loaded.projectId ? { projectId: loaded.projectId } : {})
            },
            senderName
        )
        const messaging = getMessaging(app)

        const send = async (input: NativeFcmPushSendInput): Promise<NativeFcmPushSendResult> => {
            const tokens = Array.from(new Set((Array.isArray(input.tokens) ? input.tokens : [])
                .map((item) => normalizeString(item))
                .filter(Boolean)))

            if (tokens.length === 0) {
                return {
                    attempted: 0,
                    successCount: 0,
                    failureCount: 0,
                    staleTokens: []
                }
            }

            const ttlSeconds = Math.max(30, Math.min(3600, Math.floor(Number(input.ttlSeconds || 120))))
            const sound = normalizeString(input.sound) || 'iphone_glass'
            const iosSound = normalizeString(input.iosSound) || `${sound}.caf`
            const channelId = normalizeString(input.channelId) || 'qmessage-chat'
            const iosCategory = normalizeString(input.iosCategory) || 'QMESSAGE_CHAT'
            const normalizedData: Record<string, string> = {}

            Object.entries(input.data || {}).forEach(([key, value]) => {
                const normalizedKey = normalizeString(key)
                if (!normalizedKey) return
                normalizedData[normalizedKey] = normalizeDataValue(value).slice(0, 1024)
            })

            const chunks: string[][] = []
            for (let index = 0; index < tokens.length; index += 450) {
                chunks.push(tokens.slice(index, index + 450))
            }

            let attempted = 0
            let successCount = 0
            let failureCount = 0
            const staleTokens: string[] = []

            for (const chunk of chunks) {
                const message: MulticastMessage = {
                    tokens: chunk,
                    notification: {
                        title: normalizeString(input.title).slice(0, 120) || 'QMessage',
                        body: normalizeString(input.body).slice(0, 240) || 'New WhatsApp update available.'
                    },
                    data: normalizedData,
                    android: {
                        priority: 'high',
                        ttl: ttlSeconds * 1000,
                        notification: {
                            channelId,
                            sound,
                            ...(input.tag ? { tag: normalizeString(input.tag).slice(0, 120) } : {})
                        }
                    },
                    apns: {
                        headers: {
                            'apns-priority': '10'
                        },
                        payload: {
                            aps: {
                                sound: iosSound,
                                category: iosCategory
                            }
                        }
                    }
                }

                attempted += chunk.length

                try {
                    const response = await messaging.sendEachForMulticast(message)
                    successCount += response.successCount
                    failureCount += response.failureCount

                    response.responses.forEach((item, index) => {
                        if (item.success) return
                        const code = normalizeString(item.error?.code)
                        if (!isStaleTokenErrorCode(code)) return
                        const token = chunk[index]
                        if (token) staleTokens.push(token)
                    })
                } catch (error: any) {
                    failureCount += chunk.length
                    logger.warn('[native-push] FCM multicast request failed:', error?.message || error)
                }
            }

            return {
                attempted,
                successCount,
                failureCount,
                staleTokens: Array.from(new Set(staleTokens))
            }
        }

        logger.log('[native-push] FCM sender initialized.')
        return {
            enabled: true as const,
            send
        }
    } catch (error: any) {
        logger.warn('[native-push] Failed to initialize FCM sender. Native push is disabled.', error?.message || error)
        return {
            enabled: false as const,
            send: async (_input: NativeFcmPushSendInput): Promise<NativeFcmPushSendResult> => ({
                attempted: 0,
                successCount: 0,
                failureCount: 0,
                staleTokens: []
            })
        }
    }
}
