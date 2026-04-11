export type RequestAuditKind =
    | 'initial-load'
    | 'polling'
    | 'realtime'
    | 'retry'
    | 'user-action'
    | 'background'
    | 'unknown';

export type RequestAuditMeta = {
    source?: string;
    trigger?: string;
    kind?: RequestAuditKind;
    attempt?: string;
};

type FetchTrackRecord = {
    id: number;
    method: string;
    route: string;
    key: string;
    source: string;
    trigger: string;
    kind: RequestAuditKind;
    attempt: string;
    startedAt: number;
    duplicate: boolean;
};

type RequestInitWithAudit = RequestInit & {
    __qmAuditMeta?: RequestAuditMeta;
};

type FetchAggregate = {
    count: number;
    duplicateCount: number;
    lastStartedAt: number;
    totalDurationMs: number;
    totalOutBytes: number;
};

type SocketAggregate = {
    count: number;
    duplicateCount: number;
    lastEmittedAt: number;
};

const FETCH_DUPLICATE_WINDOW_MS = 2500;
const SOCKET_DUPLICATE_WINDOW_MS = 1500;
const MAX_TRACKED_KEYS = 500;

let fetchSeq = 0;
const activeFetches = new Map<number, FetchTrackRecord>();
const fetchAggregates = new Map<string, FetchAggregate>();
const socketAggregates = new Map<string, SocketAggregate>();

let fetchAuditInstalled = false;

const parseContentLength = (value: string | null): number => {
    if (!value) return 0;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const normalizeRoute = (input: RequestInfo | URL): string => {
    if (typeof input === 'string') {
        try {
            const parsed = new URL(input, window.location.origin);
            return `${parsed.pathname}${parsed.search}`;
        } catch {
            return input;
        }
    }

    if (input instanceof URL) {
        return `${input.pathname}${input.search}`;
    }

    try {
        const parsed = new URL(input.url, window.location.origin);
        return `${parsed.pathname}${parsed.search}`;
    } catch {
        return input.url || 'unknown';
    }
};

const trimForLog = (value: unknown, fallback: string, max = 96): string => {
    if (typeof value !== 'string') return fallback;
    const normalized = value.trim();
    if (!normalized) return fallback;
    return normalized.slice(0, max);
};

const normalizeKind = (value: unknown): RequestAuditKind => {
    const normalized = trimForLog(value, 'unknown', 24).toLowerCase();
    if (
        normalized === 'initial-load'
        || normalized === 'polling'
        || normalized === 'realtime'
        || normalized === 'retry'
        || normalized === 'user-action'
        || normalized === 'background'
    ) {
        return normalized;
    }
    return 'unknown';
};

const pruneMapIfNeeded = <T>(map: Map<string, T>) => {
    if (map.size <= MAX_TRACKED_KEYS) return;
    const overflow = map.size - MAX_TRACKED_KEYS;
    const keys = Array.from(map.keys()).slice(0, overflow);
    keys.forEach((key) => map.delete(key));
};

const registerFetchStart = (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    meta: RequestAuditMeta | undefined
): number => {
    const method = trimForLog(init?.method, 'GET', 12).toUpperCase();
    const route = normalizeRoute(input);
    const source = trimForLog(meta?.source, 'unknown-source');
    const trigger = trimForLog(meta?.trigger, 'unspecified-trigger', 72);
    const kind = normalizeKind(meta?.kind);
    const attempt = trimForLog(meta?.attempt, 'primary', 24);

    const now = Date.now();
    const key = `${method} ${route} :: ${source}`;
    const previous = fetchAggregates.get(key);
    const duplicate = Boolean(previous) && (now - previous!.lastStartedAt) < FETCH_DUPLICATE_WINDOW_MS;
    const nextAggregate: FetchAggregate = previous
        ? {
            ...previous,
            count: previous.count + 1,
            duplicateCount: previous.duplicateCount + (duplicate ? 1 : 0),
            lastStartedAt: now
        }
        : {
            count: 1,
            duplicateCount: duplicate ? 1 : 0,
            lastStartedAt: now,
            totalDurationMs: 0,
            totalOutBytes: 0
        };
    fetchAggregates.set(key, nextAggregate);
    pruneMapIfNeeded(fetchAggregates);

    const id = ++fetchSeq;
    activeFetches.set(id, {
        id,
        method,
        route,
        key,
        source,
        trigger,
        kind,
        attempt,
        startedAt: now,
        duplicate
    });

    if (import.meta.env.DEV) {
        console.log(
            `[net] fetch:start id=${id} method=${method} route=${route} source=${source} trigger=${trigger} kind=${kind} attempt=${attempt} duplicate=${duplicate}`
        );
    }
    return id;
};

const registerFetchEnd = (id: number, response?: Response, error?: unknown) => {
    const tracked = activeFetches.get(id);
    if (!tracked) return;
    activeFetches.delete(id);

    const finishedAt = Date.now();
    const durationMs = Math.max(0, finishedAt - tracked.startedAt);
    const outBytes = parseContentLength(response?.headers?.get('content-length') || null);
    const status = response?.status || 0;
    const ok = !error && Boolean(response?.ok);
    const message = error instanceof Error
        ? error.message
        : typeof error === 'string'
            ? error
            : '';

    const aggregate = fetchAggregates.get(tracked.key);
    if (aggregate) {
        aggregate.totalDurationMs += durationMs;
        aggregate.totalOutBytes += outBytes;
        fetchAggregates.set(tracked.key, aggregate);
    }

    if (import.meta.env.DEV || tracked.duplicate || durationMs >= 1200 || Boolean(error)) {
        const avgDurationMs = aggregate ? aggregate.totalDurationMs / Math.max(1, aggregate.count) : durationMs;
        const avgOutBytes = aggregate ? aggregate.totalOutBytes / Math.max(1, aggregate.count) : outBytes;
        console.log(
            `[net] fetch:end id=${id} method=${tracked.method} route=${tracked.route} status=${status} ok=${ok} durationMs=${durationMs} outBytes=${outBytes} avgMs=${avgDurationMs.toFixed(1)} avgOutBytes=${avgOutBytes.toFixed(0)} duplicate=${tracked.duplicate}${message ? ` error=${message}` : ''}`
        );
    }
};

export function installFetchAudit() {
    if (fetchAuditInstalled) return;
    if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
    fetchAuditInstalled = true;

    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const requestInit = (init || {}) as RequestInitWithAudit;
        const outOfBandMeta = requestInit.__qmAuditMeta;
        const headers = new Headers(requestInit.headers || undefined);
        const source = outOfBandMeta?.source || headers.get('x-qm-request-source') || undefined;
        const trigger = outOfBandMeta?.trigger || headers.get('x-qm-request-trigger') || undefined;
        const kind = outOfBandMeta?.kind || headers.get('x-qm-request-kind') || undefined;
        const attempt = outOfBandMeta?.attempt || headers.get('x-qm-request-attempt') || undefined;
        const requestId = registerFetchStart(input, requestInit, {
            source,
            trigger,
            kind: normalizeKind(kind),
            attempt
        });

        try {
            const forwardInit: RequestInit = { ...requestInit };
            delete (forwardInit as RequestInitWithAudit).__qmAuditMeta;
            const response = await nativeFetch(input, forwardInit);
            registerFetchEnd(requestId, response);
            return response;
        } catch (error) {
            registerFetchEnd(requestId, undefined, error);
            throw error;
        }
    };
}

export function withRequestAuditMeta(init: RequestInit = {}, meta?: RequestAuditMeta): RequestInitWithAudit {
    const next: RequestInitWithAudit = { ...init };
    if (!meta) return next;
    next.__qmAuditMeta = {
        source: trimForLog(meta.source, 'unknown-source'),
        trigger: trimForLog(meta.trigger, 'unspecified-trigger', 72),
        kind: normalizeKind(meta.kind),
        attempt: trimForLog(meta.attempt, 'primary', 24)
    };
    return next;
}

export function trackSocketEmit(eventName: string, payload: any, meta?: RequestAuditMeta) {
    const event = trimForLog(eventName, 'unknown-event', 48);
    const profileId = trimForLog(payload?.profileId, 'n/a', 72);
    const source = trimForLog(meta?.source, 'unknown-source');
    const trigger = trimForLog(meta?.trigger, 'unspecified-trigger', 72);
    const kind = normalizeKind(meta?.kind);
    const key = `${event}::${profileId}::${source}`;
    const now = Date.now();
    const previous = socketAggregates.get(key);
    const duplicate = Boolean(previous) && (now - previous!.lastEmittedAt) < SOCKET_DUPLICATE_WINDOW_MS;
    const next: SocketAggregate = previous
        ? {
            count: previous.count + 1,
            duplicateCount: previous.duplicateCount + (duplicate ? 1 : 0),
            lastEmittedAt: now
        }
        : {
            count: 1,
            duplicateCount: duplicate ? 1 : 0,
            lastEmittedAt: now
        };
    socketAggregates.set(key, next);
    pruneMapIfNeeded(socketAggregates);

    if (import.meta.env.DEV || duplicate) {
        console.log(
            `[net] socket:emit event=${event} profile=${profileId} source=${source} trigger=${trigger} kind=${kind} count=${next.count} duplicates=${next.duplicateCount} duplicate=${duplicate}`
        );
    }
}
