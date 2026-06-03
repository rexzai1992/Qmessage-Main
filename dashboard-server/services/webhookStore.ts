import { readJsonFile, writeJsonFile } from './fileJsonStore'

export type WebhookConfig = {
    url: string
    events: string[]
}

type SupabaseClientLike = any

type StoredWebhookRow = {
    profile_id?: string | null
    company_id?: string | null
    url?: string | null
    events?: unknown
}

function trimText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value))
}

function normalizeEvents(value: unknown): string[] {
    const source = Array.isArray(value) ? value : []
    const deduped = new Set<string>()
    source.forEach((item) => {
        const normalized = trimText(item)
        if (normalized) deduped.add(normalized)
    })
    return Array.from(deduped)
}

function normalizeWebhookConfig(value: WebhookConfig | null | undefined): WebhookConfig | null {
    const url = trimText(value?.url)
    if (!url) return null
    const events = normalizeEvents(value?.events)
    return {
        url,
        events: events.length > 0 ? events : ['message', 'status']
    }
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

function mapRowToConfig(row: StoredWebhookRow): WebhookConfig | null {
    return normalizeWebhookConfig({
        url: trimText(row?.url),
        events: normalizeEvents(row?.events)
    })
}

export function createWebhookStore(filePath: string, options?: { supabase?: SupabaseClientLike }) {
    let webhooks = readJsonFile<Record<string, WebhookConfig>>(filePath, {})
    const supabase = options?.supabase || null
    const dbTableName = 'outbound_webhooks'
    let dbUnavailable = !supabase
    let bootstrapAttempted = false

    const persist = () => writeJsonFile(filePath, webhooks)

    const getFileSnapshot = () => cloneJson(webhooks)

    const updateFileEntry = (profileId: string, value: WebhookConfig | null) => {
        const trimmedProfileId = trimText(profileId)
        if (!trimmedProfileId) return
        if (!value) {
            delete webhooks[trimmedProfileId]
        } else {
            webhooks[trimmedProfileId] = value
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

    const syncFileEntriesToDb = async () => {
        if (!supabase || dbUnavailable) return
        const entries = Object.entries(webhooks)
        if (entries.length === 0) return

        for (const [profileId, config] of entries) {
            const normalizedConfig = normalizeWebhookConfig(config)
            if (!normalizedConfig) continue
            const companyId = await resolveCompanyIdForProfile(supabase, profileId)
            const { error } = await supabase
                .from(dbTableName)
                .upsert({
                    profile_id: trimText(profileId),
                    company_id: companyId,
                    url: normalizedConfig.url,
                    events: normalizedConfig.events,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'profile_id' })
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
                console.warn('[WebhookStore] Failed to bootstrap webhooks into Supabase:', (error as any)?.message || error)
            }
        }
    }

    const loadAllFromDb = async (): Promise<Record<string, WebhookConfig> | null> => {
        if (!supabase || dbUnavailable) return null
        await ensureBootstrap()
        if (dbUnavailable) return null

        const { data, error } = await supabase
            .from(dbTableName)
            .select('profile_id, url, events')
            .order('created_at', { ascending: true })

        if (error) {
            if (markDbUnavailableIfNeeded(error)) return null
            throw error
        }

        const snapshot: Record<string, WebhookConfig> = {}
        for (const row of data || []) {
            const profileId = trimText(row?.profile_id)
            const config = mapRowToConfig(row)
            if (!profileId || !config) continue
            snapshot[profileId] = config
        }

        if (Object.keys(snapshot).length > 0) {
            webhooks = snapshot
            persist()
            return snapshot
        }

        return null
    }

    const getFromDb = async (profileId: string): Promise<WebhookConfig | null> => {
        if (!supabase || dbUnavailable) return null
        await ensureBootstrap()
        if (dbUnavailable) return null

        const { data, error } = await supabase
            .from(dbTableName)
            .select('profile_id, url, events')
            .eq('profile_id', trimText(profileId))
            .maybeSingle()

        if (error) {
            if (markDbUnavailableIfNeeded(error)) return null
            throw error
        }

        const config = mapRowToConfig(data || {})
        if (!config) return null
        updateFileEntry(profileId, config)
        return config
    }

    const store = {
        get: async (profileId: string) => {
            const trimmedProfileId = trimText(profileId)
            if (!trimmedProfileId) return null
            const dbValue = await getFromDb(trimmedProfileId)
            return dbValue || webhooks[trimmedProfileId] || null
        },
        set: async (profileId: string, value: WebhookConfig) => {
            const trimmedProfileId = trimText(profileId)
            if (!trimmedProfileId) throw new Error('Profile ID is required')
            const normalizedConfig = normalizeWebhookConfig(value)
            if (!normalizedConfig) throw new Error('Webhook URL is required')

            updateFileEntry(trimmedProfileId, normalizedConfig)

            if (!supabase || dbUnavailable) return normalizedConfig
            await ensureBootstrap()
            if (dbUnavailable) return normalizedConfig

            const companyId = await resolveCompanyIdForProfile(supabase, trimmedProfileId)
            const { error } = await supabase
                .from(dbTableName)
                .upsert({
                    profile_id: trimmedProfileId,
                    company_id: companyId,
                    url: normalizedConfig.url,
                    events: normalizedConfig.events,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'profile_id' })
            if (error && !markDbUnavailableIfNeeded(error)) {
                throw error
            }

            return normalizedConfig
        },
        remove: async (profileId: string) => {
            const trimmedProfileId = trimText(profileId)
            if (!trimmedProfileId) return false
            const existed = Boolean(webhooks[trimmedProfileId])
            updateFileEntry(trimmedProfileId, null)

            if (!supabase || dbUnavailable) return existed
            await ensureBootstrap()
            if (dbUnavailable) return existed

            const { error } = await supabase
                .from(dbTableName)
                .delete()
                .eq('profile_id', trimmedProfileId)
            if (error && !markDbUnavailableIfNeeded(error)) {
                throw error
            }

            return existed
        },
        getAll: async () => {
            const dbSnapshot = await loadAllFromDb()
            return cloneJson(dbSnapshot || getFileSnapshot())
        },
        async send(profileId: string, event: string, data: any) {
            try {
                const webhook = await store.get(profileId)
                if (!webhook?.url) return

                await fetch(webhook.url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Webhook-Event': event,
                        'X-Profile-Id': profileId
                    },
                    body: JSON.stringify({
                        event,
                        profileId,
                        timestamp: new Date().toISOString(),
                        data
                    })
                })
            } catch (error) {
                console.error(`Webhook error for ${profileId}:`, error)
            }
        }
    }

    return store
}
