
import fs from 'fs'
import crypto from 'crypto'
import type { WebhookConfig, WebhookEvent } from './types'
import { resolvePath } from '../config'

const CONFIG_FILE = resolvePath('addon_webhooks.json')
const QUEUE_FILE = resolvePath('addon_webhook_queue.json')
const LEGACY_CONFIG_FILE = resolvePath('webhooks.json')

export class WebhookService {
    private configs: Record<string, WebhookConfig[]> = {}
    private queue: WebhookEvent[] = []
    private processing = false
    private queueDirty = false

    constructor() {
        this.loadConfig()
        this.loadQueue()

        // Process queue frequently
        setInterval(() => this.processQueue(), 1000)

        // Persist queue periodically (Debounced I/O)
        setInterval(() => this.persistQueue(), 3000)
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
                const url = typeof legacy?.url === 'string' ? legacy.url.trim() : ''
                if (!url) continue

                const rawEvents = Array.isArray(legacy?.events) ? legacy.events : ['message', 'status']
                const events = rawEvents
                    .map(event => (typeof event === 'string' ? event.trim() : ''))
                    .filter(Boolean)

                migrated[profileId] = [{
                    url,
                    events: events.length > 0 ? events : ['message', 'status'],
                    enabled: true
                }]
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
            await fs.promises.writeFile(QUEUE_FILE, JSON.stringify(this.queue, null, 2))
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

    public getWebhooks(profileId: string) {
        const sourceProfile = this.resolveReadProfile(profileId)
        return this.configs[sourceProfile] || []
    }

    public addWebhook(profileId: string, config: WebhookConfig) {
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
    }

    public removeWebhook(profileId: string, url: string) {
        const targetProfile = this.resolveWriteProfile(profileId)
        if (!this.configs[targetProfile]) return
        this.configs[targetProfile] = this.configs[targetProfile].filter(w => w.url !== url)
        this.saveConfig()
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
