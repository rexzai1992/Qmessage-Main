
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config()

// Default fallback to the keys provided by user in conversation
const DEFAULT_URL = 'https://hafkwvdcmfenbbzvufkv.supabase.co'
const DEFAULT_PUBLISHABLE_KEY = 'sb_publishable_McTQKF73jZv_ekbxLFw2IQ_LG8YuZ0o'

const SUPABASE_URL = process.env.SUPABASE_URL || DEFAULT_URL
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || DEFAULT_PUBLISHABLE_KEY
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || SUPABASE_PUBLISHABLE_KEY

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
