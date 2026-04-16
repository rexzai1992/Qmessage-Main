
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config()

function readRequiredEnv(keys: string[]): string {
    for (const key of keys) {
        const value = process.env[key]?.trim()
        if (value) return value
    }
    throw new Error(`Missing required Supabase env var. Set one of: ${keys.join(', ')}`)
}

const SUPABASE_URL = readRequiredEnv(['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL'])
const SUPABASE_PUBLISHABLE_KEY = readRequiredEnv([
    'SUPABASE_KEY',
    'SUPABASE_ANON_KEY',
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY'
])
const SUPABASE_SERVICE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_KEY?.trim() ||
    SUPABASE_PUBLISHABLE_KEY

if (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY) {
    console.log('Supabase: Using Service Role Key (Admin Access)')
} else {
    console.log('Supabase: Using Publishable Key (Restricted by RLS)')
}

// Use a dedicated admin client for DB writes and admin APIs.
export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
})

// Use a separate auth client for validating user access tokens.
// Keeping this isolated avoids leaking per-request user auth into admin DB calls.
export const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
})
