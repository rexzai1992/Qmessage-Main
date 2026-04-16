import { readJsonFile, writeJsonFile } from './fileJsonStore'

type MaintenanceModeState = {
    enabled: boolean
    message: string
    updatedAt: string
    updatedBy: string | null
}

type DowntimeLogEntry = {
    id: string
    offlineFrom: string
    offlineUntil: string
    durationMs: number
    reason: string
}

type PersistedRuntimeStatus = {
    heartbeatAt: string | null
    maintenance: MaintenanceModeState
    downtimeLog: DowntimeLogEntry[]
    updatedAt: string
}

export type SystemRuntimeStatusSnapshot = {
    online: boolean
    startedAt: string
    currentTime: string
    uptimeMs: number
    heartbeatAt: string | null
    maintenance: MaintenanceModeState
    lastOfflineAt: string | null
    lastOfflineEndedAt: string | null
    lastOfflineDurationMs: number | null
    downtimeLog: DowntimeLogEntry[]
}

type CreateSystemRuntimeStatusStoreArgs = {
    filePath: string
    heartbeatIntervalMs?: number
    offlineThresholdMs?: number
    maxLogEntries?: number
}

function toIsoOrNull(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    if (!trimmed) return null
    const parsed = new Date(trimmed).getTime()
    if (!Number.isFinite(parsed)) return null
    return new Date(parsed).toISOString()
}

function toPositiveInt(value: unknown, fallback: number): number {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    const normalized = Math.floor(parsed)
    if (normalized <= 0) return fallback
    return normalized
}

function sanitizeMaintenanceMode(value: unknown): MaintenanceModeState {
    const source = value && typeof value === 'object' ? (value as any) : {}
    const updatedAt = toIsoOrNull(source.updatedAt) || new Date().toISOString()
    const updatedByRaw = typeof source.updatedBy === 'string' ? source.updatedBy.trim() : ''
    const message = typeof source.message === 'string' ? source.message.trim().slice(0, 280) : ''
    return {
        enabled: source.enabled === true,
        message,
        updatedAt,
        updatedBy: updatedByRaw || null
    }
}

function sanitizeDowntimeLog(value: unknown, maxEntries: number): DowntimeLogEntry[] {
    if (!Array.isArray(value)) return []
    const output: DowntimeLogEntry[] = []
    value.forEach((entry: any, index) => {
        const offlineFrom = toIsoOrNull(entry?.offlineFrom)
        const offlineUntil = toIsoOrNull(entry?.offlineUntil)
        if (!offlineFrom || !offlineUntil) return
        const fromMs = new Date(offlineFrom).getTime()
        const untilMs = new Date(offlineUntil).getTime()
        if (!Number.isFinite(fromMs) || !Number.isFinite(untilMs) || untilMs <= fromMs) return
        const durationRaw = Number(entry?.durationMs)
        const durationMs = Number.isFinite(durationRaw)
            ? Math.max(1, Math.floor(durationRaw))
            : Math.max(1, untilMs - fromMs)
        const reason = typeof entry?.reason === 'string' && entry.reason.trim()
            ? entry.reason.trim().slice(0, 120)
            : 'server_unavailable'
        const idRaw = typeof entry?.id === 'string' ? entry.id.trim() : ''
        const id = idRaw || `downtime-${fromMs}-${index}`
        output.push({
            id,
            offlineFrom,
            offlineUntil,
            durationMs,
            reason
        })
    })
    output.sort((a, b) => new Date(b.offlineUntil).getTime() - new Date(a.offlineUntil).getTime())
    return output.slice(0, maxEntries)
}

function createDowntimeLogEntry(offlineFromMs: number, offlineUntilMs: number, reason: string): DowntimeLogEntry {
    const startedAt = new Date(offlineFromMs).toISOString()
    const endedAt = new Date(offlineUntilMs).toISOString()
    return {
        id: `downtime-${offlineUntilMs}-${Math.random().toString(36).slice(2, 8)}`,
        offlineFrom: startedAt,
        offlineUntil: endedAt,
        durationMs: Math.max(1, Math.floor(offlineUntilMs - offlineFromMs)),
        reason: reason.trim() || 'server_unavailable'
    }
}

export function createSystemRuntimeStatusStore(args: CreateSystemRuntimeStatusStoreArgs) {
    const heartbeatIntervalMs = Math.max(10_000, toPositiveInt(args.heartbeatIntervalMs, 30_000))
    const offlineThresholdMs = Math.max(heartbeatIntervalMs * 2, toPositiveInt(args.offlineThresholdMs, 90_000))
    const maxLogEntries = Math.max(10, toPositiveInt(args.maxLogEntries, 80))

    const defaultMaintenance = sanitizeMaintenanceMode(null)
    const rawPersisted = readJsonFile<any>(args.filePath, {})
    const persistedHeartbeat = toIsoOrNull(rawPersisted?.heartbeatAt)
    const persistedMaintenance = sanitizeMaintenanceMode(rawPersisted?.maintenance || defaultMaintenance)
    const persistedDowntimeLog = sanitizeDowntimeLog(rawPersisted?.downtimeLog, maxLogEntries)

    const nowMs = Date.now()
    const startedAtIso = new Date(nowMs).toISOString()
    const heartbeatMs = persistedHeartbeat ? new Date(persistedHeartbeat).getTime() : Number.NaN
    const downtimeLog = [...persistedDowntimeLog]

    if (Number.isFinite(heartbeatMs)) {
        const downtimeMs = nowMs - heartbeatMs
        if (downtimeMs >= offlineThresholdMs) {
            downtimeLog.unshift(createDowntimeLogEntry(heartbeatMs, nowMs, 'server_unavailable'))
        }
    }

    const state: PersistedRuntimeStatus = {
        heartbeatAt: startedAtIso,
        maintenance: persistedMaintenance,
        downtimeLog: downtimeLog.slice(0, maxLogEntries),
        updatedAt: startedAtIso
    }

    const persistState = () => {
        try {
            writeJsonFile(args.filePath, state)
        } catch (error: any) {
            console.warn('[SystemRuntimeStatus] Failed to persist state:', error?.message || error)
        }
    }

    const buildSnapshot = (): SystemRuntimeStatusSnapshot => {
        const now = Date.now()
        const latestDowntime = state.downtimeLog[0] || null
        return {
            online: true,
            startedAt: startedAtIso,
            currentTime: new Date(now).toISOString(),
            uptimeMs: Math.max(0, now - new Date(startedAtIso).getTime()),
            heartbeatAt: state.heartbeatAt,
            maintenance: {
                enabled: state.maintenance.enabled,
                message: state.maintenance.message,
                updatedAt: state.maintenance.updatedAt,
                updatedBy: state.maintenance.updatedBy
            },
            lastOfflineAt: latestDowntime?.offlineFrom || null,
            lastOfflineEndedAt: latestDowntime?.offlineUntil || null,
            lastOfflineDurationMs: latestDowntime?.durationMs ?? null,
            downtimeLog: state.downtimeLog.slice(0, maxLogEntries)
        }
    }

    const recordHeartbeat = () => {
        const nowIso = new Date().toISOString()
        state.heartbeatAt = nowIso
        state.updatedAt = nowIso
        persistState()
    }

    const setMaintenanceMode = (input: { enabled: boolean; message?: string; updatedBy?: string | null }) => {
        const nowIso = new Date().toISOString()
        const updatedBy = typeof input.updatedBy === 'string' ? input.updatedBy.trim() : ''
        state.maintenance = {
            enabled: input.enabled === true,
            message: typeof input.message === 'string' ? input.message.trim().slice(0, 280) : '',
            updatedAt: nowIso,
            updatedBy: updatedBy || null
        }
        state.updatedAt = nowIso
        persistState()
        return buildSnapshot()
    }

    persistState()
    const heartbeatTimer = setInterval(() => {
        recordHeartbeat()
    }, heartbeatIntervalMs)
    if (typeof (heartbeatTimer as any).unref === 'function') {
        ;(heartbeatTimer as any).unref()
    }

    return {
        getStatus: buildSnapshot,
        setMaintenanceMode,
        recordHeartbeat,
        stop: () => clearInterval(heartbeatTimer)
    }
}

