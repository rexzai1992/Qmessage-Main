
import { createClient } from '@supabase/supabase-js'

function readRequiredEnv(value: string | undefined, description: string): string {
    const trimmed = value?.trim()
    if (!trimmed) {
        throw new Error(`Missing required Supabase frontend env: ${description}`)
    }
    return trimmed
}

const SUPABASE_URL = readRequiredEnv(import.meta.env.VITE_SUPABASE_URL, 'VITE_SUPABASE_URL')
const SUPABASE_KEY = readRequiredEnv(
    import.meta.env.VITE_SUPABASE_ANON_KEY || import.meta.env.VITE_SUPABASE_KEY,
    'VITE_SUPABASE_ANON_KEY or VITE_SUPABASE_KEY'
)

const SUPABASE_HTTP_TIMEOUT_MS = 12_000

const timedFetch: typeof fetch = async (input, init) => {
    const timeoutController = new AbortController()
    const externalSignal = init?.signal
    const onExternalAbort = () => timeoutController.abort()

    if (externalSignal) {
        if (externalSignal.aborted) {
            timeoutController.abort()
        } else {
            externalSignal.addEventListener('abort', onExternalAbort, { once: true })
        }
    }

    const timeoutId = globalThis.setTimeout(() => {
        timeoutController.abort()
    }, SUPABASE_HTTP_TIMEOUT_MS)

    try {
        return await fetch(input, {
            ...init,
            signal: timeoutController.signal
        })
    } finally {
        globalThis.clearTimeout(timeoutId)
        if (externalSignal) {
            externalSignal.removeEventListener('abort', onExternalAbort)
        }
    }
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    global: {
        fetch: timedFetch
    }
})
