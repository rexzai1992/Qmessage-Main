import fs from 'fs'
import os from 'os'
import path from 'path'

export type RuntimeEnvironment = 'local' | 'docker' | 'production'

function trimText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

function parseBoolean(value: unknown, fallback = false): boolean {
    if (typeof value === 'boolean') return value
    const normalized = trimText(value).toLowerCase()
    if (!normalized) return fallback
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false
    return fallback
}

function safeOriginFromUrl(value: string): string | null {
    try {
        const parsed = new URL(value)
        return parsed.origin
    } catch {
        return null
    }
}

function normalizeOriginPattern(value: string): string {
    return value.replace(/\/+$/, '')
}

export function getRuntimeEnvironment(): RuntimeEnvironment {
    const explicit = trimText(process.env.ENVIRONMENT).toLowerCase()
    if (explicit === 'docker') return 'docker'
    if (explicit === 'production') return 'production'
    if (explicit === 'local') return 'local'

    if (fs.existsSync('/.dockerenv')) return 'docker'
    return process.env.NODE_ENV === 'production' ? 'production' : 'local'
}

export function isOfficialMetaOnlyMode(): boolean {
    const explicitMode = trimText(
        process.env.WABA_BACKEND_MODE
        || process.env.WHATSAPP_BACKEND_MODE
        || process.env.WABA_CHANNEL_MODE
    ).toLowerCase()

    if (explicitMode) {
        return explicitMode === 'official_meta_only' || explicitMode === 'official'
    }

    if (process.env.OFFICIAL_META_ONLY !== undefined) {
        return parseBoolean(process.env.OFFICIAL_META_ONLY, true)
    }

    return true
}

export function getApiBasePath(): string {
    const value = trimText(process.env.API_BASE_PATH)
    if (!value) return '/api'
    return value.startsWith('/') ? value : `/${value}`
}

export function isApiDocsEnabled(): boolean {
    return parseBoolean(process.env.ENABLE_API_DOCS, false)
}

export function getAppBaseUrl(): string | null {
    const candidates = [
        trimText(process.env.APP_BASE_URL),
        trimText(process.env.DASHBOARD_URL),
        trimText(process.env.WABA_OAUTH_RETURN_URL)
    ]

    for (const candidate of candidates) {
        const origin = safeOriginFromUrl(candidate)
        if (origin) return origin
    }

    return null
}

export function getWebhookUrl(): string | null {
    const explicit = trimText(process.env.WEBHOOK_URL)
    if (explicit) return explicit
    const appBaseUrl = getAppBaseUrl()
    return appBaseUrl ? `${appBaseUrl}/webhook` : null
}

function buildDefaultCorsOrigins(): string[] {
    const defaults = new Set<string>([
        'http://localhost:3000',
        'http://localhost:5173',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:5173'
    ])

    const appBaseUrl = getAppBaseUrl()
    if (appBaseUrl) defaults.add(appBaseUrl)

    const tenantRootDomain = trimText(process.env.TENANT_ROOT_DOMAIN).toLowerCase()
    if (tenantRootDomain) {
        defaults.add(`https://${tenantRootDomain}`)
        defaults.add(`https://*.${tenantRootDomain}`)
    }

    return Array.from(defaults)
}

export function getAllowedCorsOrigins(): string[] {
    const configured = trimText(process.env.CORS_ORIGINS)
    if (!configured) return buildDefaultCorsOrigins()

    return configured
        .split(',')
        .map((entry) => normalizeOriginPattern(trimText(entry)))
        .filter(Boolean)
}

export function isOriginAllowed(origin: string | undefined | null, allowedOrigins: string[]): boolean {
    const normalizedOrigin = normalizeOriginPattern(trimText(origin))
    if (!normalizedOrigin) return true
    if (allowedOrigins.length === 0) return true

    return allowedOrigins.some((pattern) => {
        const normalizedPattern = normalizeOriginPattern(pattern)
        if (!normalizedPattern) return false
        if (normalizedPattern === '*') return true
        if (normalizedPattern === normalizedOrigin) return true

        if (normalizedPattern.includes('*')) {
            try {
                const originUrl = new URL(normalizedOrigin)
                const patternUrl = new URL(normalizedPattern.replace('*.', 'placeholder.'))
                if (originUrl.protocol !== patternUrl.protocol) return false

                if (normalizedPattern.startsWith(`${patternUrl.protocol}//*.`)) {
                    const suffix = patternUrl.hostname.replace(/^placeholder\./, '')
                    return originUrl.hostname === suffix || originUrl.hostname.endsWith(`.${suffix}`)
                }
            } catch {
                return false
            }
        }

        return false
    })
}

export function getLegacyRepoArtifacts(): string[] {
    const repoRoot = process.cwd()
    const candidates = [
        'src/Utils/use-multi-file-auth-state.ts',
        'src/Socket/index.ts',
        'src/index.ts'
    ]

    return candidates.filter((relativePath) => fs.existsSync(path.join(repoRoot, relativePath)))
}

export function getLocalPersistenceFiles(): string[] {
    const dataDir = path.join(process.cwd(), 'data')
    const files: string[] = []

    if (fs.existsSync(dataDir)) {
        for (const name of fs.readdirSync(dataDir)) {
            files.push(path.join('data', name))
        }
    }

    const additionalCandidates = [
        'addon_webhooks.json',
        'addon_webhook_queue.json',
        'sessions_default.json',
        'flows_default.json'
    ]

    additionalCandidates.forEach((relativePath) => {
        if (fs.existsSync(path.join(process.cwd(), relativePath))) {
            files.push(relativePath)
        }
    })

    return Array.from(new Set(files)).sort()
}

export function isCloudflareTunnelDetected(): boolean {
    if (fs.existsSync(path.join(process.cwd(), 'cloudflared-2fast.yml'))) return true
    const webhookUrl = getWebhookUrl()
    const appBaseUrl = getAppBaseUrl()
    return [webhookUrl, appBaseUrl].some((value) => {
        const normalized = trimText(value).toLowerCase()
        return normalized.includes('trycloudflare.com') || normalized.includes('cloudflare')
    })
}

export function getRuntimeSnapshot() {
    const totalMemoryMb = Math.round(os.totalmem() / 1024 / 1024)
    const freeMemoryMb = Math.round(os.freemem() / 1024 / 1024)
    const processMemoryMb = Math.round(process.memoryUsage().rss / 1024 / 1024)

    return {
        environment: getRuntimeEnvironment(),
        officialMetaOnly: isOfficialMetaOnlyMode(),
        apiBasePath: getApiBasePath(),
        apiDocsEnabled: isApiDocsEnabled(),
        appBaseUrl: getAppBaseUrl(),
        webhookUrl: getWebhookUrl(),
        corsOrigins: getAllowedCorsOrigins(),
        cloudflareTunnelDetected: isCloudflareTunnelDetected(),
        legacyRepoArtifacts: getLegacyRepoArtifacts(),
        localPersistenceFiles: getLocalPersistenceFiles(),
        cpuCount: os.cpus()?.length || 0,
        totalMemoryMb,
        freeMemoryMb,
        usedMemoryMb: Math.max(0, totalMemoryMb - freeMemoryMb),
        processMemoryMb
    }
}
