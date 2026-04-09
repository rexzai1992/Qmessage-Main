
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

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
