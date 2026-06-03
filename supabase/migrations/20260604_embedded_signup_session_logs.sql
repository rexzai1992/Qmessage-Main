-- Embedded Signup session logging for Meta WhatsApp onboarding diagnostics.
-- Stores non-secret postMessage metadata so Meta Support can inspect session_id/error_code.

CREATE TABLE IF NOT EXISTS public.embedded_signup_session_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id text,
    profile_id text,
    flow_type text NOT NULL DEFAULT 'coexistence',
    source text NOT NULL DEFAULT 'embedded_signup',
    event text,
    current_step text,
    error_message text,
    error_code text,
    session_id text,
    timestamp text,
    waba_id text,
    phone_number_id text,
    business_id text,
    is_wa_login_user boolean,
    config_id text,
    feature_type text,
    session_info_version text,
    raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.embedded_signup_session_logs ADD COLUMN IF NOT EXISTS company_id text;
ALTER TABLE public.embedded_signup_session_logs ADD COLUMN IF NOT EXISTS profile_id text;
ALTER TABLE public.embedded_signup_session_logs ADD COLUMN IF NOT EXISTS flow_type text NOT NULL DEFAULT 'coexistence';
ALTER TABLE public.embedded_signup_session_logs ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'embedded_signup';
ALTER TABLE public.embedded_signup_session_logs ADD COLUMN IF NOT EXISTS event text;
ALTER TABLE public.embedded_signup_session_logs ADD COLUMN IF NOT EXISTS current_step text;
ALTER TABLE public.embedded_signup_session_logs ADD COLUMN IF NOT EXISTS error_message text;
ALTER TABLE public.embedded_signup_session_logs ADD COLUMN IF NOT EXISTS error_code text;
ALTER TABLE public.embedded_signup_session_logs ADD COLUMN IF NOT EXISTS session_id text;
ALTER TABLE public.embedded_signup_session_logs ADD COLUMN IF NOT EXISTS timestamp text;
ALTER TABLE public.embedded_signup_session_logs ADD COLUMN IF NOT EXISTS waba_id text;
ALTER TABLE public.embedded_signup_session_logs ADD COLUMN IF NOT EXISTS phone_number_id text;
ALTER TABLE public.embedded_signup_session_logs ADD COLUMN IF NOT EXISTS business_id text;
ALTER TABLE public.embedded_signup_session_logs ADD COLUMN IF NOT EXISTS is_wa_login_user boolean;
ALTER TABLE public.embedded_signup_session_logs ADD COLUMN IF NOT EXISTS config_id text;
ALTER TABLE public.embedded_signup_session_logs ADD COLUMN IF NOT EXISTS feature_type text;
ALTER TABLE public.embedded_signup_session_logs ADD COLUMN IF NOT EXISTS session_info_version text;
ALTER TABLE public.embedded_signup_session_logs ADD COLUMN IF NOT EXISTS raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.embedded_signup_session_logs ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_embedded_signup_session_logs_company_profile_created
ON public.embedded_signup_session_logs (company_id, profile_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_embedded_signup_session_logs_session_created
ON public.embedded_signup_session_logs (session_id, created_at DESC);

ALTER TABLE public.embedded_signup_session_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS embedded_signup_session_logs_select_by_company ON public.embedded_signup_session_logs;
CREATE POLICY embedded_signup_session_logs_select_by_company
ON public.embedded_signup_session_logs
FOR SELECT
TO authenticated
USING (
    company_id in (
        select c.company_id
        from public.current_company_ids() c
    )
);
