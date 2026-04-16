import { readJsonFile, writeJsonFile } from './fileJsonStore'

export type StoredPushSubscription = {
    endpoint: string
    expirationTime?: number | null
    keys: {
        p256dh: string
        auth: string
    }
    userId: string
    companyId: string
    userAgent?: string | null
    createdAt: string
    updatedAt: string
}

type PushSubscriptionInput = {
    endpoint?: unknown
    expirationTime?: unknown
    keys?: {
        p256dh?: unknown
        auth?: unknown
    } | null
} | null | undefined

function normalizePushSubscriptionInput(input: PushSubscriptionInput): {
    endpoint: string
    expirationTime: number | null
    keys: {
        p256dh: string
        auth: string
    }
} | null {
    const endpoint = typeof input?.endpoint === 'string' ? input.endpoint.trim() : ''
    const p256dh = typeof input?.keys?.p256dh === 'string' ? input.keys.p256dh.trim() : ''
    const auth = typeof input?.keys?.auth === 'string' ? input.keys.auth.trim() : ''
    const expirationTimeRaw = Number(input?.expirationTime)
    const expirationTime = Number.isFinite(expirationTimeRaw) ? Math.floor(expirationTimeRaw) : null

    if (!endpoint || !p256dh || !auth) return null
    return {
        endpoint,
        expirationTime,
        keys: {
            p256dh,
            auth
        }
    }
}

export function createPushSubscriptionStore(filePath: string) {
    let subscriptions = readJsonFile<Record<string, StoredPushSubscription>>(filePath, {})

    const persist = () => writeJsonFile(filePath, subscriptions)

    const removeUnsafe = (endpoint: string) => {
        if (!endpoint) return
        if (subscriptions[endpoint]) {
            delete subscriptions[endpoint]
        }
    }

    return {
        upsert: (input: PushSubscriptionInput, meta: { userId: string; companyId: string; userAgent?: string | null }) => {
            const normalized = normalizePushSubscriptionInput(input)
            if (!normalized) {
                return { success: false as const, error: 'Invalid push subscription payload.' }
            }
            const nowIso = new Date().toISOString()
            const previous = subscriptions[normalized.endpoint]
            subscriptions[normalized.endpoint] = {
                endpoint: normalized.endpoint,
                expirationTime: normalized.expirationTime,
                keys: normalized.keys,
                userId: meta.userId,
                companyId: meta.companyId,
                userAgent: typeof meta.userAgent === 'string' ? meta.userAgent.slice(0, 512) : null,
                createdAt: previous?.createdAt || nowIso,
                updatedAt: nowIso
            }
            persist()
            return { success: true as const, endpoint: normalized.endpoint }
        },
        removeByEndpoint: (endpoint: string) => {
            const trimmed = typeof endpoint === 'string' ? endpoint.trim() : ''
            if (!trimmed) return false
            if (!subscriptions[trimmed]) return false
            delete subscriptions[trimmed]
            persist()
            return true
        },
        removeManyByEndpoint: (endpoints: string[]) => {
            let changed = false
            for (const endpoint of endpoints) {
                const trimmed = typeof endpoint === 'string' ? endpoint.trim() : ''
                if (!trimmed) continue
                if (!subscriptions[trimmed]) continue
                removeUnsafe(trimmed)
                changed = true
            }
            if (changed) persist()
            return changed
        },
        removeByUser: (userId: string) => {
            const target = typeof userId === 'string' ? userId.trim() : ''
            if (!target) return false
            let changed = false
            for (const endpoint of Object.keys(subscriptions)) {
                if (subscriptions[endpoint]?.userId !== target) continue
                removeUnsafe(endpoint)
                changed = true
            }
            if (changed) persist()
            return changed
        },
        getByUsers: (userIds: string[], companyId?: string | null): StoredPushSubscription[] => {
            const userIdSet = new Set(
                (Array.isArray(userIds) ? userIds : [])
                    .map((value) => (typeof value === 'string' ? value.trim() : ''))
                    .filter(Boolean)
            )
            if (userIdSet.size === 0) return []

            const company = typeof companyId === 'string' ? companyId.trim() : ''
            return Object.values(subscriptions).filter((item) => {
                if (!item?.endpoint || !item?.keys?.auth || !item?.keys?.p256dh) return false
                if (!userIdSet.has(item.userId)) return false
                if (company && item.companyId !== company) return false
                return true
            })
        },
        getByUser: (userId: string, companyId?: string | null): StoredPushSubscription[] => {
            const target = typeof userId === 'string' ? userId.trim() : ''
            if (!target) return []
            return Object.values(subscriptions).filter((item) => {
                if (!item?.endpoint || item.userId !== target) return false
                if (companyId && item.companyId !== companyId) return false
                return true
            })
        },
        getAll: () => subscriptions
    }
}

