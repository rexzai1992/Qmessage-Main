-- Store company-level WhatsApp connection metadata without replacing the
-- existing waba_configs runtime table.

CREATE TABLE IF NOT EXISTS public.whatsapp_connections (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id text NOT NULL,
    profile_id text,
    user_id uuid,
    waba_id text NOT NULL,
    phone_number_id text NOT NULL,
    business_id text,
    phone_number text,
    display_name text,
    verified_name text,
    access_token_encrypted text NOT NULL,
    token_expires_at timestamptz,
    account_review_status text,
    business_verification_status text,
    quality_rating text,
    platform_type text,
    status text,
    flow_type text,
    last_synced_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.whatsapp_connections ADD COLUMN IF NOT EXISTS company_id text;
ALTER TABLE public.whatsapp_connections ADD COLUMN IF NOT EXISTS profile_id text;
ALTER TABLE public.whatsapp_connections ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE public.whatsapp_connections ADD COLUMN IF NOT EXISTS waba_id text;
ALTER TABLE public.whatsapp_connections ADD COLUMN IF NOT EXISTS phone_number_id text;
ALTER TABLE public.whatsapp_connections ADD COLUMN IF NOT EXISTS business_id text;
ALTER TABLE public.whatsapp_connections ADD COLUMN IF NOT EXISTS phone_number text;
ALTER TABLE public.whatsapp_connections ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE public.whatsapp_connections ADD COLUMN IF NOT EXISTS verified_name text;
ALTER TABLE public.whatsapp_connections ADD COLUMN IF NOT EXISTS access_token_encrypted text;
ALTER TABLE public.whatsapp_connections ADD COLUMN IF NOT EXISTS token_expires_at timestamptz;
ALTER TABLE public.whatsapp_connections ADD COLUMN IF NOT EXISTS account_review_status text;
ALTER TABLE public.whatsapp_connections ADD COLUMN IF NOT EXISTS business_verification_status text;
ALTER TABLE public.whatsapp_connections ADD COLUMN IF NOT EXISTS quality_rating text;
ALTER TABLE public.whatsapp_connections ADD COLUMN IF NOT EXISTS platform_type text;
ALTER TABLE public.whatsapp_connections ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE public.whatsapp_connections ADD COLUMN IF NOT EXISTS flow_type text;
ALTER TABLE public.whatsapp_connections ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;
ALTER TABLE public.whatsapp_connections ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.whatsapp_connections ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_connections_company_waba_phone_uniq
ON public.whatsapp_connections (company_id, waba_id, phone_number_id);

CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_company_id
ON public.whatsapp_connections (company_id);

CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_profile_id
ON public.whatsapp_connections (profile_id);

CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_user_id
ON public.whatsapp_connections (user_id);

CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_waba_id
ON public.whatsapp_connections (waba_id);

CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_phone_number_id
ON public.whatsapp_connections (phone_number_id);

CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_status
ON public.whatsapp_connections (status);

INSERT INTO public.whatsapp_connections (
    company_id,
    profile_id,
    waba_id,
    phone_number_id,
    business_id,
    access_token_encrypted,
    token_expires_at,
    account_review_status,
    business_verification_status,
    platform_type,
    status,
    flow_type,
    last_synced_at,
    created_at,
    updated_at
)
SELECT
    wc.company_id,
    wc.profile_id,
    COALESCE(wc.waba_id, wc.business_account_id),
    wc.phone_number_id,
    wc.business_id,
    wc.access_token,
    wc.access_token_expires_at,
    NULL,
    NULL,
    NULL,
    CASE WHEN wc.enabled IS TRUE THEN 'CONNECTED' ELSE 'DISCONNECTED' END,
    COALESCE(NULLIF(wc.token_source, ''), 'legacy_connection'),
    now(),
    COALESCE(wc.connected_at, now()),
    now()
FROM public.waba_configs wc
WHERE wc.company_id IS NOT NULL
  AND COALESCE(wc.waba_id, wc.business_account_id) IS NOT NULL
  AND wc.phone_number_id IS NOT NULL
ON CONFLICT (company_id, waba_id, phone_number_id) DO UPDATE
SET
    profile_id = COALESCE(EXCLUDED.profile_id, public.whatsapp_connections.profile_id),
    business_id = COALESCE(EXCLUDED.business_id, public.whatsapp_connections.business_id),
    access_token_encrypted = COALESCE(EXCLUDED.access_token_encrypted, public.whatsapp_connections.access_token_encrypted),
    token_expires_at = COALESCE(EXCLUDED.token_expires_at, public.whatsapp_connections.token_expires_at),
    status = COALESCE(EXCLUDED.status, public.whatsapp_connections.status),
    flow_type = COALESCE(EXCLUDED.flow_type, public.whatsapp_connections.flow_type),
    last_synced_at = COALESCE(EXCLUDED.last_synced_at, public.whatsapp_connections.last_synced_at),
    updated_at = now();
