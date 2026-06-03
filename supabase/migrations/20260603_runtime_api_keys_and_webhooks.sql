-- Move small runtime stores out of local JSON files and into Supabase-backed
-- tables while keeping the app compatible with legacy file mirrors.

CREATE TABLE IF NOT EXISTS public.api_keys (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    api_key_hash text NOT NULL,
    api_key_encrypted text NOT NULL,
    api_key_hint text,
    profile_id text NOT NULL,
    company_id text,
    name text,
    last_used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS api_key_hash text;
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS api_key_encrypted text;
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS api_key_hint text;
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS profile_id text;
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS company_id text;
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS last_used_at timestamptz;
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS api_keys_api_key_hash_uniq
ON public.api_keys (api_key_hash);

CREATE INDEX IF NOT EXISTS idx_api_keys_profile_id
ON public.api_keys (profile_id);

CREATE INDEX IF NOT EXISTS idx_api_keys_company_id
ON public.api_keys (company_id);

CREATE TABLE IF NOT EXISTS public.outbound_webhooks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id text NOT NULL,
    company_id text,
    url text NOT NULL,
    events jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.outbound_webhooks ADD COLUMN IF NOT EXISTS profile_id text;
ALTER TABLE public.outbound_webhooks ADD COLUMN IF NOT EXISTS company_id text;
ALTER TABLE public.outbound_webhooks ADD COLUMN IF NOT EXISTS url text;
ALTER TABLE public.outbound_webhooks ADD COLUMN IF NOT EXISTS events jsonb DEFAULT '[]'::jsonb;
ALTER TABLE public.outbound_webhooks ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.outbound_webhooks ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS outbound_webhooks_profile_id_uniq
ON public.outbound_webhooks (profile_id);

CREATE INDEX IF NOT EXISTS idx_outbound_webhooks_company_id
ON public.outbound_webhooks (company_id);
