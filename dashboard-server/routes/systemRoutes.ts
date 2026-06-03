import fs from 'fs'
import path from 'path'
import type { Express } from 'express'
import {
    getAllowedCorsOrigins,
    getApiBasePath,
    getAppBaseUrl,
    getLegacyRepoArtifacts,
    getLocalPersistenceFiles,
    getRuntimeEnvironment,
    getRuntimeSnapshot,
    getWebhookUrl,
    isCloudflareTunnelDetected,
    isOfficialMetaOnlyMode
} from '../../src/config/runtime-policy'

function trimText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

function buildSuccess(req: any, data: any) {
    return {
        success: true,
        data,
        error: null,
        request_id: req?.requestId || null
    }
}

async function checkDatabaseConnection(supabase: any): Promise<{ connected: boolean; error?: string | null }> {
    try {
        const { error } = await supabase
            .from('company')
            .select('id')
            .limit(1)
        if (error) {
            return { connected: false, error: error.message || 'Unknown Supabase error' }
        }
        return { connected: true, error: null }
    } catch (error: any) {
        return { connected: false, error: error?.message || 'Unknown database error' }
    }
}

function hasStudioOrigin(corsOrigins: string[]): boolean {
    return corsOrigins.some((origin) => {
        const normalized = trimText(origin).toLowerCase()
        return normalized.includes('studio.') || normalized.includes('localhost')
    })
}

function repoHasDockerCompose(): boolean {
    const cwd = process.cwd()
    return fs.existsSync(path.join(cwd, 'docker-compose.yml')) || fs.existsSync(path.join(cwd, 'docker-compose.yaml'))
}

function getDocsUrl(): string {
    return '/docs/api/'
}

export function registerSystemRoutes(app: Express, ctx: any) {
    const {
        supabase,
        resolveCompanyAccess
    } = ctx

    app.get('/health', async (req: any, res: any) => {
        const db = await checkDatabaseConnection(supabase)
        res.json({
            ok: db.connected,
            service: 'waba-backend',
            environment: getRuntimeEnvironment(),
            mode: isOfficialMetaOnlyMode() ? 'official_meta_only' : 'mixed',
            database: db.connected ? 'connected' : 'disconnected',
            timestamp: new Date().toISOString(),
            request_id: req?.requestId || null
        })
    })

    const handleConfigCheck = async (req: any, res: any) => {
        const access = await resolveCompanyAccess(req, res, 'admin')
        if (!access) return

        const db = await checkDatabaseConnection(supabase)
        const runtime = getRuntimeSnapshot()
        const corsOrigins = getAllowedCorsOrigins()
        const supabaseUrlConfigured = Boolean(trimText(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL))
        const databaseUrlConfigured = Boolean(trimText(process.env.DATABASE_URL))
        const directUrlConfigured = Boolean(trimText(process.env.DIRECT_URL))
        const usingPostgres = supabaseUrlConfigured || /postgres/i.test(trimText(process.env.DATABASE_URL))
        const usingSqlite = /sqlite/i.test(trimText(process.env.DATABASE_URL))
        const migrationsFound = fs.existsSync(path.join(process.cwd(), 'supabase', 'migrations'))
        const dockerfileFound = fs.existsSync(path.join(process.cwd(), 'Dockerfile'))
        const composeFound = repoHasDockerCompose()
        const openapiEnabled = false
        const apiBasePath = getApiBasePath()
        const officialMode = isOfficialMetaOnlyMode()
        const legacyArtifacts = getLegacyRepoArtifacts()
        const localPersistenceFiles = getLocalPersistenceFiles()

        const issues: string[] = []
        if (!db.connected) issues.push(`Database check failed: ${db.error || 'unknown error'}`)
        if (!supabaseUrlConfigured) issues.push('SUPABASE_URL is missing.')
        if (!trimText(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)) {
            issues.push('SUPABASE_SERVICE_ROLE_KEY is missing.')
        }
        if (!trimText(process.env.META_APP_ID || process.env.WABA_APP_ID)) issues.push('META_APP_ID is missing.')
        if (!trimText(process.env.META_APP_SECRET || process.env.WABA_APP_SECRET)) issues.push('META_APP_SECRET is missing.')
        if (!trimText(process.env.META_WEBHOOK_VERIFY_TOKEN || process.env.WABA_VERIFY_TOKEN)) {
            issues.push('META_WEBHOOK_VERIFY_TOKEN is missing.')
        }
        if (!getWebhookUrl()) issues.push('WEBHOOK_URL/APP_BASE_URL is not configured.')
        if (apiBasePath !== '/api/v1') issues.push(`API_BASE_PATH is "${apiBasePath}". Versioned compatibility aliases are enabled, but "/api/v1" is recommended for Studio integration.`)
        if (!openapiEnabled) issues.push('OpenAPI docs are not implemented in the current Express backend.')
        if (legacyArtifacts.length > 0) {
            issues.push('Legacy Baileys source files are still present in the repo. Runtime is fenced to official Meta only, but the repo is not physically trimmed yet.')
        }
        if (localPersistenceFiles.length > 0) {
            issues.push('Some runtime/admin state is persisted locally under data/.')
        }
        if (!officialMode) {
            issues.push('OFFICIAL_META_ONLY is disabled. Mixed runtime mode is not recommended.')
        }

        res.json(buildSuccess(req, {
            fastapi: {
                detected: false,
                entrypoint: null
            },
            backend: {
                framework: 'express',
                entrypoint: 'dashboard-server.ts',
                official_meta_only_mode: officialMode,
                legacy_runtime_actions_disabled: true,
                legacy_repo_artifacts_present: legacyArtifacts.length > 0,
                legacy_repo_artifacts: legacyArtifacts
            },
            database: {
                supabase_url_configured: supabaseUrlConfigured,
                database_url_configured: databaseUrlConfigured,
                direct_url_configured: directUrlConfigured,
                using_postgres: usingPostgres,
                using_sqlite: usingSqlite,
                migrations_found: migrationsFound,
                connected: db.connected
            },
            meta: {
                app_id_configured: Boolean(trimText(process.env.META_APP_ID || process.env.WABA_APP_ID)),
                verify_token_configured: Boolean(trimText(process.env.META_WEBHOOK_VERIFY_TOKEN || process.env.WABA_VERIFY_TOKEN)),
                webhook_url_configured: Boolean(getWebhookUrl()),
                coexistence_config_found: Boolean(trimText(process.env.META_WA_EXISTING_APP_CONFIGURATION_ID)),
                embedded_signup_config_found: Boolean(trimText(process.env.META_WA_EMBEDDED_SIGNUP_V4_CONFIGURATION_ID))
            },
            deployment: {
                environment: runtime.environment,
                dockerfile_found: dockerfileFound,
                compose_found: composeFound,
                cloudflare_tunnel_detected: isCloudflareTunnelDetected(),
                app_base_url: getAppBaseUrl(),
                webhook_url: getWebhookUrl()
            },
            api_engine: {
                api_v1_found: true,
                api_v1_alias_enabled: true,
                api_base_path: apiBasePath,
                legacy_api_base_path: '/api',
                cors_configured: corsOrigins.length > 0,
                studio_origin_allowed: hasStudioOrigin(corsOrigins),
                openapi_enabled: openapiEnabled,
                docs_url: getDocsUrl(),
                openapi_url: null
            },
            storage: {
                local_persistence_files: localPersistenceFiles
            },
            runtime: runtime,
            issues
        }))
    }

    app.get('/api/system/config-check', handleConfigCheck)
    app.get('/api/v1/system/config-check', handleConfigCheck)

    const handlePublicConfig = async (req: any, res: any) => {
        res.json(buildSuccess(req, {
            app_name: 'WABA Engine',
            api_version: 'v1',
            environment: getRuntimeEnvironment(),
            features: {
                waba: true,
                coexistence: true,
                calling: false,
                deployment_analytics: false
            },
            meta: {
                app_id: trimText(process.env.META_APP_ID || process.env.WABA_APP_ID) || null
            },
            api: {
                base_path: getApiBasePath(),
                aliases: ['/api', '/api/v1'],
                docs_url: getDocsUrl()
            },
            official_mode: {
                enabled: isOfficialMetaOnlyMode()
            }
        }))
    }

    app.get('/api/public/config', handlePublicConfig)
    app.get('/api/v1/public/config', handlePublicConfig)
}
