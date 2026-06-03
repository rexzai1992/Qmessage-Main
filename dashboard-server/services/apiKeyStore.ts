import { createHash } from 'crypto'
import { decryptToken, encryptToken, getTokenEncryptionKey } from '../../src/services/token-vault'
import { createApiKeyVerifier } from '../middleware/auth'
import { readJsonFile, writeJsonFile } from './fileJsonStore'

export type ApiKeyMeta = {
    profileId: string
    companyId?: string | null
    name?: string
}

type SupabaseClientLike = any

type StoredApiKeyRow = {
    api_key_hash: string
    api_key_encrypted?: string | null
    api_key_hint?: string | null
    profile_id?: string | null
    company_id?: string | null
    name?: string | null
    created_at?: string | null
    updated_at?: string | null
    last_used_at?: string | null
}

function trimText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value))
}

function buildApiKeyHash(apiKey: string): string {
    return createHash('sha256').update(apiKey).digest('hex')
}

function buildApiKeyHint(apiKey: string): string {
    const trimmed = trimText(apiKey)
    if (!trimmed) return ''
    const prefix = trimmed.slice(0, Math.min(8, trimmed.length))
    const suffix = trimmed.length > 4 ? trimmed.slice(-4) : trimmed
    return `${prefix}...${suffix}`
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

async function resolveCompanyIdForProfile(supabase: SupabaseClientLike, profileId: string): Promise<string | null> {
    const trimmedProfileId = trimText(profileId)
    if (!trimmedProfileId) return null
    try {
        const { data, error } = await supabase
            .from('profiles')
            .select('company_id')
            .eq('id', trimmedProfileId)
            .maybeSingle()
        if (error) return null
        return trimText(data?.company_id) || null
    } catch {
        return null
    }
}

function mapRowToMeta(row: StoredApiKeyRow): ApiKeyMeta | null {
    const profileId = trimText(row?.profile_id)
    if (!profileId) return null
    return {
        profileId,
        companyId: trimText(row?.company_id) || null,
        name: trimText(row?.name) || undefined
    }
}

function buildRowFromMeta(apiKey: string, meta: ApiKeyMeta): StoredApiKeyRow {
    const nowIso = new Date().toISOString()
    return {
        api_key_hash: buildApiKeyHash(apiKey),
        api_key_encrypted: encryptToken(apiKey),
        api_key_hint: buildApiKeyHint(apiKey),
        profile_id: trimText(meta.profileId),
        company_id: trimText(meta.companyId) || null,
        name: trimText(meta.name) || null,
        created_at: nowIso,
        updated_at: nowIso,
        last_used_at: null
    }
}

export function createApiKeyStore(filePath: string, options?: { supabase?: SupabaseClientLike }) {
    let keys = readJsonFile<Record<string, ApiKeyMeta>>(filePath, {})
    const supabase = options?.supabase || null
    const dbTableName = 'api_keys'
    let dbUnavailable = !supabase || !getTokenEncryptionKey()
    let bootstrapAttempted = false

    const persist = () => writeJsonFile(filePath, keys)

    const getFileSnapshot = () => cloneJson(keys)

    const updateFileEntry = (apiKey: string, value: ApiKeyMeta | null) => {
        if (!apiKey) return
        if (!value) {
            delete keys[apiKey]
        } else {
            keys[apiKey] = {
                profileId: trimText(value.profileId),
                companyId: trimText(value.companyId) || null,
                name: trimText(value.name) || undefined
            }
        }
        persist()
    }

    const markDbUnavailableIfNeeded = (error: any) => {
        if (isMissingTableError(error, dbTableName)) {
            dbUnavailable = true
            return true
        }
        return false
    }

    const ensureCompanyId = async (meta: ApiKeyMeta): Promise<ApiKeyMeta> => {
        const companyId = trimText(meta.companyId)
        if (companyId || !supabase) return meta
        const resolvedCompanyId = await resolveCompanyIdForProfile(supabase, meta.profileId)
        return {
            ...meta,
            companyId: resolvedCompanyId
        }
    }

    const syncFileEntriesToDb = async () => {
        if (!supabase || dbUnavailable) return
        const entries = Object.entries(keys)
        if (entries.length === 0) return

        for (const [apiKey, meta] of entries) {
            const normalizedMeta = await ensureCompanyId(meta)
            const row = buildRowFromMeta(apiKey, normalizedMeta)
            const { error } = await supabase
                .from(dbTableName)
                .upsert(row, { onConflict: 'api_key_hash' })
            if (error) {
                if (markDbUnavailableIfNeeded(error)) return
                throw error
            }
        }
    }

    const ensureBootstrap = async () => {
        if (bootstrapAttempted || !supabase || dbUnavailable) return
        bootstrapAttempted = true
        try {
            await syncFileEntriesToDb()
        } catch (error) {
            if (!markDbUnavailableIfNeeded(error)) {
                console.warn('[ApiKeyStore] Failed to bootstrap API keys into Supabase:', (error as any)?.message || error)
            }
        }
    }

    const loadFromDb = async (): Promise<Record<string, ApiKeyMeta> | null> => {
        if (!supabase || dbUnavailable) return null
        await ensureBootstrap()
        if (dbUnavailable) return null

        const { data, error } = await supabase
            .from(dbTableName)
            .select('api_key_encrypted, api_key_hint, profile_id, company_id, name')
            .order('created_at', { ascending: true })

        if (error) {
            if (markDbUnavailableIfNeeded(error)) return null
            throw error
        }

        const snapshot: Record<string, ApiKeyMeta> = {}
        for (const row of data || []) {
            const encrypted = trimText(row?.api_key_encrypted)
            if (!encrypted) continue
            try {
                const apiKey = decryptToken(encrypted)
                const mapped = mapRowToMeta(row)
                if (!apiKey || !mapped) continue
                snapshot[apiKey] = mapped
            } catch (error: any) {
                console.warn('[ApiKeyStore] Failed to decrypt API key row:', error?.message || error)
            }
        }

        if (Object.keys(snapshot).length > 0) {
            keys = snapshot
            persist()
            return snapshot
        }

        return null
    }

    const getByHashFromDb = async (apiKey: string): Promise<ApiKeyMeta | null> => {
        if (!supabase || dbUnavailable) return null
        await ensureBootstrap()
        if (dbUnavailable) return null

        const { data, error } = await supabase
            .from(dbTableName)
            .select('api_key_hash, profile_id, company_id, name')
            .eq('api_key_hash', buildApiKeyHash(apiKey))
            .maybeSingle()

        if (error) {
            if (markDbUnavailableIfNeeded(error)) return null
            throw error
        }

        const mapped = mapRowToMeta(data || {})
        if (!mapped) return null
        updateFileEntry(apiKey, mapped)
        return mapped
    }

    const touchLastUsed = async (apiKey: string) => {
        if (!supabase || dbUnavailable) return
        try {
            const { error } = await supabase
                .from(dbTableName)
                .update({
                    last_used_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                })
                .eq('api_key_hash', buildApiKeyHash(apiKey))
            if (error) markDbUnavailableIfNeeded(error)
        } catch {
            // best effort only
        }
    }

    const store = {
        getAll: async () => {
            const dbSnapshot = await loadFromDb()
            return cloneJson(dbSnapshot || getFileSnapshot())
        },
        get: async (apiKey: string) => {
            const trimmedApiKey = trimText(apiKey)
            if (!trimmedApiKey) return null
            const dbValue = await getByHashFromDb(trimmedApiKey)
            return dbValue || keys[trimmedApiKey] || null
        },
        set: async (apiKey: string, value: ApiKeyMeta) => {
            const trimmedApiKey = trimText(apiKey)
            if (!trimmedApiKey) throw new Error('API key is required')

            const normalizedMeta = await ensureCompanyId({
                profileId: trimText(value.profileId),
                companyId: trimText(value.companyId) || null,
                name: trimText(value.name) || undefined
            })

            updateFileEntry(trimmedApiKey, normalizedMeta)

            if (!supabase || dbUnavailable) return normalizedMeta
            await ensureBootstrap()
            if (dbUnavailable) return normalizedMeta

            const row = buildRowFromMeta(trimmedApiKey, normalizedMeta)
            const { error } = await supabase
                .from(dbTableName)
                .upsert(row, { onConflict: 'api_key_hash' })
            if (error && !markDbUnavailableIfNeeded(error)) {
                throw error
            }

            return normalizedMeta
        },
        remove: async (apiKey: string) => {
            const trimmedApiKey = trimText(apiKey)
            if (!trimmedApiKey) return false

            const existed = Boolean(keys[trimmedApiKey])
            updateFileEntry(trimmedApiKey, null)

            if (!supabase || dbUnavailable) return existed
            await ensureBootstrap()
            if (dbUnavailable) return existed

            const { error } = await supabase
                .from(dbTableName)
                .delete()
                .eq('api_key_hash', buildApiKeyHash(trimmedApiKey))
            if (error && !markDbUnavailableIfNeeded(error)) {
                throw error
            }

            return existed
        },
        middleware: createApiKeyVerifier(async (apiKey) => {
            const value = await store.get(apiKey)
            if (value) {
                void touchLastUsed(apiKey)
            }
            return value
        })
    }

    return store
}
