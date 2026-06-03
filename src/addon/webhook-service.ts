import fs from 'fs'
import crypto from 'crypto'
import type { WebhookConfig, WebhookEvent } from './types'
import { resolvePath } from '../config'
import { supabase } from '../supabase'
import { decryptToken, encryptToken, getTokenEncryptionKey } from '../services/token-vault'

const CONFIG_FILE = resolvePath('addon_webhooks.json')
const QUEUE_FILE = resolvePath('addon_webhook_queue.json')
const LEGACY_CONFIG_FILE = resolvePath('webhooks.json')
const ADDON_WEBHOOKS_TABLE = 'addon_webhooks'

const WEBHOOK_QUEUE_PROCESS_INTERVAL_MS = (() => {
    const parsed = Number.parseInt(process.env.ADDON_WEBHOOK_QUEUE_PROCESS_INTERVAL_MS || '1000', 10)
    if (!Number.isFinite(parsed)) return 1000
    return Math.max(250, parsed)
})()

const WEBHOOK_QUEUE_PERSIST_INTERVAL_MS = (() => {
    const parsed = Number.parseInt(process.env.ADDON_WEBHOOK_QUEUE_PERSIST_INTERVAL_MS || '15000', 10)
    if (!Number.isFinite(parsed)) return 15000
    return Math.max(3000, parsed)
})()

function trimText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

function normalizeEvents(value: unknown): string[] {
    const source = Array.isArray(value) ? value : []
    const seen = new Set<string>()
    source.forEach((item) => {
        const normalized = trimText(item)
        if (normalized) seen.add(normalized)
    })
    return Array.from(seen)
}

function normalizeWebhookConfig(value: Partial<WebhookConfig> | null | undefined): WebhookConfig | null {
    const url = trimText(value?.url)
    if (!url) return null
    const events = normalizeEvents(value?.events)
    const secret = trimText(value?.secret)
    return {
        url,
        events: events.length > 0 ? events : ['message', 'status'],
        enabled: value?.enabled !== false,
        ...(secret ? { secret } : {})
    }
}

function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value))
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

async function resolveCompanyIdForProfile(profileId: string): Promise<string | null> {
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

type StoredAddonWebhookRow = {
    profile_id?: string | null
    company_id?: string | null
    url?: string | null
    events?: unknown
    enabled?: boolean | null
    secret_encrypted?: string | null
}

export class WebhookService {
    private configs: Record<string, WebhookConfig[]> = {}
    private queue: WebhookEvent[] = []
    private processing = false
    private queueDirty = false
    private storeReadyPromise: Promise<void> | null = null
    private dbUnavailable = !getTokenEncryptionKey()

    constructor() {
        this.loadConfig()
        this.loadQueue()
        void this.ensureStoreReady()

        // Process queue frequently
        setInterval(() => this.processQueue(), WEBHOOK_QUEUE_PROCESS_INTERVAL_MS)

        // Persist queue periodically (Debounced I/O)
        setInterval(() => this.persistQueue(), WEBHOOK_QUEUE_PERSIST_INTERVAL_MS)
    }

    private loadConfig() {
        let loadedConfig: Record<string, WebhookConfig[]> = {}

        if (fs.existsSync(CONFIG_FILE)) {
            try {
                loadedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) || {}
            } catch (e) {
                console.error('Failed to load webhook config', e)
                loadedConfig = {}
            }
        }

        const legacyConfig = this.loadLegacyConfig()
        let changed = false

        for (const [profileId, hooks] of Object.entries(legacyConfig)) {
            const existingHooks = loadedConfig[profileId]
            if (!Array.isArray(existingHooks) || existingHooks.length === 0) {
                loadedConfig[profileId] = hooks
                changed = true
            }
        }

        this.configs = loadedConfig

        if (changed && Object.keys(this.configs).length > 0) {
            this.saveConfig()
        }
    }

    private loadLegacyConfig(): Record<string, WebhookConfig[]> {
        if (!fs.existsSync(LEGACY_CONFIG_FILE)) return {}

        try {
            const parsed = JSON.parse(fs.readFileSync(LEGACY_CONFIG_FILE, 'utf-8')) || {}
            const migrated: Record<string, WebhookConfig[]> = {}

            for (const [profileId, value] of Object.entries(parsed)) {
                const legacy = value as { url?: unknown; events?: unknown }
                const normalized = normalizeWebhookConfig({
                    url: legacy?.url as string,
                    events: Array.isArray(legacy?.events) ? legacy.events as string[] : ['message', 'status'],
                    enabled: true
                })
                if (!normalized) continue

                migrated[profileId] = [normalized]
            }

            return migrated
        } catch (error) {
            console.error('Failed to load legacy webhook config', error)
            return {}
        }
    }

    public saveConfig() {
        // Config changes are rare, sync write is acceptable
        try {
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.configs, null, 2))
        } catch (e) {
            console.error('Failed to save config', e)
        }
    }

    private loadQueue() {
        if (fs.existsSync(QUEUE_FILE)) {
            try {
                this.queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'))
            } catch (e) {
                this.queue = []
            }
        }
    }

    private async persistQueue() {
        if (!this.queueDirty) return

        // Reset dirty flag
        this.queueDirty = false

        try {
            // Async write to strictly avoid blocking event loop
            await fs.promises.writeFile(QUEUE_FILE, JSON.stringify(this.queue))
        } catch (e) {
            console.error('Failed to persist webhook queue', e)
            // If save failed, mark dirty again to retry next cycle
            this.queueDirty = true
        }
    }

    private hasProfileHooks(profileId: string): boolean {
        return Array.isArray(this.configs[profileId]) && this.configs[profileId].length > 0
    }

    private resolveReadProfile(profileId: string): string {
        if (this.hasProfileHooks(profileId)) return profileId
        if (profileId !== 'default' && this.hasProfileHooks('default')) return 'default'
        return profileId
    }

    private resolveWriteProfile(profileId: string): string {
        if (profileId === 'default') return 'default'
        if (this.hasProfileHooks(profileId)) return profileId
        if (this.hasProfileHooks('default')) return 'default'
        return profileId
    }

    private markDbUnavailableIfNeeded(error: any): boolean {
        if (isMissingTableError(error, ADDON_WEBHOOKS_TABLE)) {
            this.dbUnavailable = true
            return true
        }
        return false
    }

    private serializeConfigs(): Record<string, WebhookConfig[]> {
        return cloneJson(this.configs)
    }

    private upsertMemoryWebhook(profileId: string, config: WebhookConfig) {
        const targetProfile = this.resolveWriteProfile(profileId)
        if (!this.configs[targetProfile]) this.configs[targetProfile] = []

        const existingIndex = this.configs[targetProfile].findIndex(item => item.url === config.url)
        if (existingIndex >= 0) {
            this.configs[targetProfile][existingIndex] = {
                ...this.configs[targetProfile][existingIndex],
                ...config
            }
        } else {
            this.configs[targetProfile].push(config)
        }
        this.saveConfig()
        return targetProfile
    }

    private removeMemoryWebhook(profileId: string, url: string) {
        const targetProfile = this.resolveWriteProfile(profileId)
        if (!this.configs[targetProfile]) return targetProfile
        this.configs[targetProfile] = this.configs[targetProfile].filter(w => w.url !== url)
        if (this.configs[targetProfile].length === 0) {
            delete this.configs[targetProfile]
        }
        this.saveConfig()
        return targetProfile
    }

    private async syncFileConfigToDb() {
        if (this.dbUnavailable) return
        const snapshot = this.serializeConfigs()

        for (const [profileId, hooks] of Object.entries(snapshot)) {
            const companyId = await resolveCompanyIdForProfile(profileId)
            for (const hook of hooks) {
                const normalized = normalizeWebhookConfig(hook)
                if (!normalized) continue

                const payload = {
                    profile_id: profileId,
                    company_id: companyId,
                    url: normalized.url,
                    events: normalized.events,
                    enabled: normalized.enabled !== false,
                    secret_encrypted: normalized.secret ? encryptToken(normalized.secret) : null,
                    updated_at: new Date().toISOString()
                }

                const { error } = await supabase
                    .from(ADDON_WEBHOOKS_TABLE)
                    .upsert(payload, { onConflict: 'profile_id,url' })

                if (error) {
                    if (this.markDbUnavailableIfNeeded(error)) return
                    throw error
                }
            }
        }
    }

    private async loadConfigFromDb(): Promise<Record<string, WebhookConfig[]> | null> {
        if (this.dbUnavailable) return null

        const { data, error } = await supabase
            .from(ADDON_WEBHOOKS_TABLE)
            .select('profile_id, company_id, url, events, enabled, secret_encrypted')
            .order('created_at', { ascending: true })

        if (error) {
            if (this.markDbUnavailableIfNeeded(error)) return null
            throw error
        }

        const fromDb: Record<string, WebhookConfig[]> = {}
        for (const row of (data || []) as StoredAddonWebhookRow[]) {
            const profileId = trimText(row.profile_id)
            if (!profileId) continue

            let secret = ''
            const encryptedSecret = trimText(row.secret_encrypted)
            if (encryptedSecret) {
                try {
                    secret = decryptToken(encryptedSecret)
                } catch (error: any) {
                    console.warn('[AddonWebhookService] Failed to decrypt webhook secret:', error?.message || error)
                    continue
                }
            }

            const normalized = normalizeWebhookConfig({
                url: row.url as string,
                events: normalizeEvents(row.events),
                enabled: row.enabled !== false,
                secret
            })
            if (!normalized) continue

            if (!fromDb[profileId]) fromDb[profileId] = []
            fromDb[profileId].push(normalized)
        }

        if (Object.keys(fromDb).length === 0) return null

        this.configs = fromDb
        this.saveConfig()
        return fromDb
    }

    private async ensureStoreReady() {
        if (this.dbUnavailable) return
        if (this.storeReadyPromise) return this.storeReadyPromise

        this.storeReadyPromise = (async () => {
            try {
                await this.syncFileConfigToDb()
                await this.loadConfigFromDb()
            } catch (error: any) {
                if (!this.markDbUnavailableIfNeeded(error)) {
                    console.warn('[AddonWebhookService] Failed to initialize Supabase-backed config:', error?.message || error)
                }
            }
        })()

        return this.storeReadyPromise
    }

    public async getWebhooks(profileId: string) {
        await this.ensureStoreReady()
        const sourceProfile = this.resolveReadProfile(profileId)
        return cloneJson(this.configs[sourceProfile] || [])
    }

    public async addWebhook(profileId: string, config: WebhookConfig) {
        const normalized = normalizeWebhookConfig(config)
        if (!normalized) throw new Error('Webhook URL is required')

        await this.ensureStoreReady()
        const targetProfile = this.upsertMemoryWebhook(profileId, normalized)

        if (!this.dbUnavailable) {
            try {
                const companyId = await resolveCompanyIdForProfile(targetProfile)
                const { error } = await supabase
                    .from(ADDON_WEBHOOKS_TABLE)
                    .upsert({
                        profile_id: targetProfile,
                        company_id: companyId,
                        url: normalized.url,
                        events: normalized.events,
                        enabled: normalized.enabled !== false,
                        secret_encrypted: normalized.secret ? encryptToken(normalized.secret) : null,
                        updated_at: new Date().toISOString()
                    }, { onConflict: 'profile_id,url' })
                if (error && !this.markDbUnavailableIfNeeded(error)) {
                    throw error
                }
            } catch (error: any) {
                if (!this.markDbUnavailableIfNeeded(error)) {
                    throw error
                }
            }
        }

        return cloneJson(this.configs[targetProfile] || [])
    }

    public async removeWebhook(profileId: string, url: string) {
        await this.ensureStoreReady()
        const targetProfile = this.removeMemoryWebhook(profileId, trimText(url))

        if (!this.dbUnavailable) {
            try {
                const { error } = await supabase
                    .from(ADDON_WEBHOOKS_TABLE)
                    .delete()
                    .eq('profile_id', targetProfile)
                    .eq('url', trimText(url))
                if (error && !this.markDbUnavailableIfNeeded(error)) {
                    throw error
                }
            } catch (error: any) {
                if (!this.markDbUnavailableIfNeeded(error)) {
                    throw error
                }
            }
        }

        return cloneJson(this.configs[targetProfile] || [])
    }

    public trigger(profileId: string, eventName: string, data: any) {
        const sourceProfile = this.resolveReadProfile(profileId)
        const hooks = this.configs[sourceProfile] || []
        // Fast filter
        const relevantHooks = hooks.filter(h => h.enabled && h.events.includes(eventName))

        if (relevantHooks.length === 0) return

        const timestamp = new Date().toISOString()
        let added = false

        relevantHooks.forEach(hook => {
            const payload = {
                event: eventName,
                from: data.from || profileId,
                ...data,
                timestamp
            }

            const wrapper: WebhookEvent = {
                id: crypto.randomUUID(),
                event: eventName,
                payload,
                profileId,
                timestamp,
                attempts: 0,
                nextRetry: Date.now(),
                targetUrl: hook.url,
                secret: hook.secret
            }

            this.queue.push(wrapper)
            added = true
        })

        if (added) {
            this.queueDirty = true
            // Optional: trigger process immediately if not running
            if (!this.processing) this.processQueue()
        }
    }

    private async processQueue() {
        if (this.processing) return
        this.processing = true

        try {
            const now = Date.now()
            const dueItems = this.queue.filter(item => item.nextRetry <= now)

            if (dueItems.length === 0) {
                this.processing = false
                return
            }

            // Process sequentially to manage load
            for (const item of dueItems) {
                let remove = false
                let updated = false

                try {
                    await this.send(item)
                    remove = true
                } catch (e) {
                    item.attempts++
                    updated = true
                    if (item.attempts >= 3) {
                        remove = true
                    } else {
                        // Exponential Backoff: 2s, 4s, 8s
                        item.nextRetry = Date.now() + (Math.pow(2, item.attempts) * 2000)
                    }
                }

                if (remove) {
                    this.queue = this.queue.filter(i => i.id !== item.id)
                    this.queueDirty = true
                } else if (updated) {
                    this.queueDirty = true
                }
            }
        } catch (e) {
            console.error('Queue processing error', e)
        } finally {
            this.processing = false
        }
    }

    private async send(item: WebhookEvent) {
        const url = (item as any).targetUrl
        if (!url) throw new Error('No target URL')

        const secret = (item as any).secret
        const body = JSON.stringify(item.payload)

        const headers: any = {
            'Content-Type': 'application/json',
            'User-Agent': 'Barley-Webhook-Service/1.0',
            'X-Barley-Event': item.event
        }

        if (secret) {
            const signature = crypto.createHmac('sha256', secret).update(body).digest('hex')
            headers['X-Hub-Signature'] = `sha256=${signature}`
        }

        const response = await fetch(url, {
            method: 'POST',
            headers,
            body
        })

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        }
    }
}

export const webhookService = new WebhookService()
