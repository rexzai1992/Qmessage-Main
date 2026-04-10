import { readJsonFile, writeJsonFile } from './fileJsonStore'

export type NativePushPlatform = 'android' | 'ios'

export type StoredNativePushDeviceToken = {
    token: string
    platform: NativePushPlatform
    userId: string
    companyId: string
    appId?: string | null
    userAgent?: string | null
    createdAt: string
    updatedAt: string
}

type NativePushTokenInput = {
    token?: unknown
    platform?: unknown
    appId?: unknown
} | null | undefined

function normalizeNativePushTokenInput(input: NativePushTokenInput): {
    token: string
    platform: NativePushPlatform
    appId: string | null
} | null {
    const token = typeof input?.token === 'string' ? input.token.trim() : ''
    const platformRaw = typeof input?.platform === 'string' ? input.platform.trim().toLowerCase() : ''
    const appIdRaw = typeof input?.appId === 'string' ? input.appId.trim() : ''

    if (!token) return null
    if (platformRaw !== 'android' && platformRaw !== 'ios') return null

    return {
        token,
        platform: platformRaw,
        appId: appIdRaw ? appIdRaw.slice(0, 128) : null
    }
}

export function createNativePushTokenStore(filePath: string) {
    let tokens = readJsonFile<Record<string, StoredNativePushDeviceToken>>(filePath, {})

    const persist = () => writeJsonFile(filePath, tokens)

    const removeUnsafe = (token: string) => {
        if (!token) return
        if (tokens[token]) {
            delete tokens[token]
        }
    }

    return {
        upsert: (input: NativePushTokenInput, meta: { userId: string; companyId: string; userAgent?: string | null }) => {
            const normalized = normalizeNativePushTokenInput(input)
            if (!normalized) {
                return { success: false as const, error: 'Invalid native push token payload.' }
            }
            const nowIso = new Date().toISOString()
            const previous = tokens[normalized.token]
            tokens[normalized.token] = {
                token: normalized.token,
                platform: normalized.platform,
                userId: meta.userId,
                companyId: meta.companyId,
                appId: normalized.appId,
                userAgent: typeof meta.userAgent === 'string' ? meta.userAgent.slice(0, 512) : null,
                createdAt: previous?.createdAt || nowIso,
                updatedAt: nowIso
            }
            persist()
            return {
                success: true as const,
                token: normalized.token,
                platform: normalized.platform
            }
        },
        removeByToken: (token: string) => {
            const trimmed = typeof token === 'string' ? token.trim() : ''
            if (!trimmed) return false
            if (!tokens[trimmed]) return false
            delete tokens[trimmed]
            persist()
            return true
        },
        removeManyByToken: (tokenList: string[]) => {
            let changed = false
            for (const token of tokenList) {
                const trimmed = typeof token === 'string' ? token.trim() : ''
                if (!trimmed) continue
                if (!tokens[trimmed]) continue
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
            for (const token of Object.keys(tokens)) {
                if (tokens[token]?.userId !== target) continue
                removeUnsafe(token)
                changed = true
            }
            if (changed) persist()
            return changed
        },
        getByUsers: (userIds: string[], companyId?: string | null): StoredNativePushDeviceToken[] => {
            const userIdSet = new Set(
                (Array.isArray(userIds) ? userIds : [])
                    .map((value) => (typeof value === 'string' ? value.trim() : ''))
                    .filter(Boolean)
            )
            if (userIdSet.size === 0) return []

            const company = typeof companyId === 'string' ? companyId.trim() : ''
            return Object.values(tokens).filter((item) => {
                if (!item?.token) return false
                if (!userIdSet.has(item.userId)) return false
                if (company && item.companyId !== company) return false
                return true
            })
        },
        getByUser: (userId: string, companyId?: string | null): StoredNativePushDeviceToken[] => {
            const target = typeof userId === 'string' ? userId.trim() : ''
            if (!target) return []
            return Object.values(tokens).filter((item) => {
                if (!item?.token || item.userId !== target) return false
                if (companyId && item.companyId !== companyId) return false
                return true
            })
        },
        getAll: () => tokens
    }
}
