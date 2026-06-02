-- Signaling-first Meta WhatsApp persistence for raw webhook events, calls,
-- coexistence history, and call permission workflows.

ALTER TABLE public.whatsapp_connections
ADD COLUMN IF NOT EXISTS onboarding_type text;

ALTER TABLE public.whatsapp_connections
ADD COLUMN IF NOT EXISTS coexistence_status text;

ALTER TABLE public.whatsapp_connections
ADD COLUMN IF NOT EXISTS history_sync_requested boolean NOT NULL DEFAULT false;

ALTER TABLE public.whatsapp_connections
ADD COLUMN IF NOT EXISTS history_sync_available boolean NOT NULL DEFAULT false;

ALTER TABLE public.whatsapp_connections
ADD COLUMN IF NOT EXISTS raw_onboarding_response_json jsonb;

ALTER TABLE public.whatsapp_connections
ADD COLUMN IF NOT EXISTS last_webhook_at timestamptz;

UPDATE public.whatsapp_connections
SET onboarding_type = CASE
    WHEN COALESCE(flow_type, '') IN ('whatsapp_business_app_onboarding', 'coexistence', 'existing_business_app') THEN 'coexistence'
    ELSE 'normal'
END
WHERE onboarding_type IS NULL;

UPDATE public.whatsapp_connections
SET coexistence_status = CASE
    WHEN COALESCE(onboarding_type, 'normal') = 'coexistence' AND UPPER(COALESCE(status, '')) = 'CONNECTED' THEN 'connected'
    WHEN COALESCE(onboarding_type, 'normal') = 'coexistence' AND COALESCE(status, '') <> '' THEN 'pending'
    ELSE coexistence_status
END
WHERE coexistence_status IS NULL;

CREATE TABLE IF NOT EXISTS public.whatsapp_raw_webhook_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id text,
    profile_id text,
    phone_number_id text,
    waba_id text,
    webhook_field text,
    event_type text NOT NULL,
    object_id text,
    dedupe_key text NOT NULL,
    occurred_at timestamptz,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    processed boolean NOT NULL DEFAULT false,
    processed_at timestamptz,
    processing_error text,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.whatsapp_raw_webhook_events ADD COLUMN IF NOT EXISTS company_id text;
ALTER TABLE public.whatsapp_raw_webhook_events ADD COLUMN IF NOT EXISTS profile_id text;
ALTER TABLE public.whatsapp_raw_webhook_events ADD COLUMN IF NOT EXISTS phone_number_id text;
ALTER TABLE public.whatsapp_raw_webhook_events ADD COLUMN IF NOT EXISTS waba_id text;
ALTER TABLE public.whatsapp_raw_webhook_events ADD COLUMN IF NOT EXISTS webhook_field text;
ALTER TABLE public.whatsapp_raw_webhook_events ADD COLUMN IF NOT EXISTS event_type text;
ALTER TABLE public.whatsapp_raw_webhook_events ADD COLUMN IF NOT EXISTS object_id text;
ALTER TABLE public.whatsapp_raw_webhook_events ADD COLUMN IF NOT EXISTS dedupe_key text;
ALTER TABLE public.whatsapp_raw_webhook_events ADD COLUMN IF NOT EXISTS occurred_at timestamptz;
ALTER TABLE public.whatsapp_raw_webhook_events ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.whatsapp_raw_webhook_events ADD COLUMN IF NOT EXISTS processed boolean NOT NULL DEFAULT false;
ALTER TABLE public.whatsapp_raw_webhook_events ADD COLUMN IF NOT EXISTS processed_at timestamptz;
ALTER TABLE public.whatsapp_raw_webhook_events ADD COLUMN IF NOT EXISTS processing_error text;
ALTER TABLE public.whatsapp_raw_webhook_events ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_raw_webhook_events_dedupe_uniq
ON public.whatsapp_raw_webhook_events (dedupe_key);

CREATE INDEX IF NOT EXISTS idx_whatsapp_raw_webhook_events_event_phone_created
ON public.whatsapp_raw_webhook_events (event_type, phone_number_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.whatsapp_imported_history_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id text,
    profile_id text,
    phone_number_id text,
    waba_id text,
    source text NOT NULL DEFAULT 'coexistence_history',
    dedupe_key text NOT NULL,
    message_id text,
    customer_wa_id text,
    direction text,
    message_type text,
    message_timestamp timestamptz,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.whatsapp_imported_history_messages ADD COLUMN IF NOT EXISTS company_id text;
ALTER TABLE public.whatsapp_imported_history_messages ADD COLUMN IF NOT EXISTS profile_id text;
ALTER TABLE public.whatsapp_imported_history_messages ADD COLUMN IF NOT EXISTS phone_number_id text;
ALTER TABLE public.whatsapp_imported_history_messages ADD COLUMN IF NOT EXISTS waba_id text;
ALTER TABLE public.whatsapp_imported_history_messages ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'coexistence_history';
ALTER TABLE public.whatsapp_imported_history_messages ADD COLUMN IF NOT EXISTS dedupe_key text;
ALTER TABLE public.whatsapp_imported_history_messages ADD COLUMN IF NOT EXISTS message_id text;
ALTER TABLE public.whatsapp_imported_history_messages ADD COLUMN IF NOT EXISTS customer_wa_id text;
ALTER TABLE public.whatsapp_imported_history_messages ADD COLUMN IF NOT EXISTS direction text;
ALTER TABLE public.whatsapp_imported_history_messages ADD COLUMN IF NOT EXISTS message_type text;
ALTER TABLE public.whatsapp_imported_history_messages ADD COLUMN IF NOT EXISTS message_timestamp timestamptz;
ALTER TABLE public.whatsapp_imported_history_messages ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.whatsapp_imported_history_messages ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_imported_history_messages_dedupe_uniq
ON public.whatsapp_imported_history_messages (dedupe_key);

CREATE INDEX IF NOT EXISTS idx_whatsapp_imported_history_messages_company_phone_created
ON public.whatsapp_imported_history_messages (company_id, phone_number_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.whatsapp_calls (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id text,
    profile_id text,
    phone_number_id text NOT NULL,
    waba_id text,
    call_id text NOT NULL,
    customer_wa_id text,
    customer_name text,
    business_wa_id text,
    direction text,
    event text,
    status text,
    status_history jsonb NOT NULL DEFAULT '[]'::jsonb,
    session_sdp_type text,
    session_sdp text,
    start_time timestamptz,
    end_time timestamptz,
    duration_seconds integer,
    deeplink_payload text,
    cta_payload text,
    biz_opaque_callback_data text,
    raw_payload jsonb,
    meta_response jsonb,
    meta_error jsonb,
    last_action text,
    last_action_at timestamptz,
    last_event_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.whatsapp_calls ADD COLUMN IF NOT EXISTS company_id text;
ALTER TABLE public.whatsapp_calls ADD COLUMN IF NOT EXISTS profile_id text;
ALTER TABLE public.whatsapp_calls ADD COLUMN IF NOT EXISTS phone_number_id text;
ALTER TABLE public.whatsapp_calls ADD COLUMN IF NOT EXISTS waba_id text;
ALTER TABLE public.whatsapp_calls ADD COLUMN IF NOT EXISTS call_id text;
ALTER TABLE public.whatsapp_calls ADD COLUMN IF NOT EXISTS customer_wa_id text;
ALTER TABLE public.whatsapp_calls ADD COLUMN IF NOT EXISTS customer_name text;
ALTER TABLE public.whatsapp_calls ADD COLUMN IF NOT EXISTS business_wa_id text;
ALTER TABLE public.whatsapp_calls ADD COLUMN IF NOT EXISTS direction text;
ALTER TABLE public.whatsapp_calls ADD COLUMN IF NOT EXISTS event text;
ALTER TABLE public.whatsapp_calls ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE public.whatsapp_calls ADD COLUMN IF NOT EXISTS status_history jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.whatsapp_calls ADD COLUMN IF NOT EXISTS session_sdp_type text;
ALTER TABLE public.whatsapp_calls ADD COLUMN IF NOT EXISTS session_sdp text;
ALTER TABLE public.whatsapp_calls ADD COLUMN IF NOT EXISTS start_time timestamptz;
ALTER TABLE public.whatsapp_calls ADD COLUMN IF NOT EXISTS end_time timestamptz;
ALTER TABLE public.whatsapp_calls ADD COLUMN IF NOT EXISTS duration_seconds integer;
ALTER TABLE public.whatsapp_calls ADD COLUMN IF NOT EXISTS deeplink_payload text;
ALTER TABLE public.whatsapp_calls ADD COLUMN IF NOT EXISTS cta_payload text;
ALTER TABLE public.whatsapp_calls ADD COLUMN IF NOT EXISTS biz_opaque_callback_data text;
ALTER TABLE public.whatsapp_calls ADD COLUMN IF NOT EXISTS raw_payload jsonb;
ALTER TABLE public.whatsapp_calls ADD COLUMN IF NOT EXISTS meta_response jsonb;
ALTER TABLE public.whatsapp_calls ADD COLUMN IF NOT EXISTS meta_error jsonb;
ALTER TABLE public.whatsapp_calls ADD COLUMN IF NOT EXISTS last_action text;
ALTER TABLE public.whatsapp_calls ADD COLUMN IF NOT EXISTS last_action_at timestamptz;
ALTER TABLE public.whatsapp_calls ADD COLUMN IF NOT EXISTS last_event_at timestamptz;
ALTER TABLE public.whatsapp_calls ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.whatsapp_calls ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_calls_phone_call_uniq
ON public.whatsapp_calls (phone_number_id, call_id);

CREATE INDEX IF NOT EXISTS idx_whatsapp_calls_company_profile_status
ON public.whatsapp_calls (company_id, profile_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_whatsapp_calls_call_id
ON public.whatsapp_calls (call_id);

CREATE TABLE IF NOT EXISTS public.whatsapp_call_permission_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id text,
    profile_id text,
    phone_number_id text NOT NULL,
    customer_wa_id text NOT NULL,
    customer_phone_number text,
    request_message_id text,
    body_text text,
    status text NOT NULL DEFAULT 'pending',
    meta_response jsonb,
    meta_error jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.whatsapp_call_permission_requests ADD COLUMN IF NOT EXISTS company_id text;
ALTER TABLE public.whatsapp_call_permission_requests ADD COLUMN IF NOT EXISTS profile_id text;
ALTER TABLE public.whatsapp_call_permission_requests ADD COLUMN IF NOT EXISTS phone_number_id text;
ALTER TABLE public.whatsapp_call_permission_requests ADD COLUMN IF NOT EXISTS customer_wa_id text;
ALTER TABLE public.whatsapp_call_permission_requests ADD COLUMN IF NOT EXISTS customer_phone_number text;
ALTER TABLE public.whatsapp_call_permission_requests ADD COLUMN IF NOT EXISTS request_message_id text;
ALTER TABLE public.whatsapp_call_permission_requests ADD COLUMN IF NOT EXISTS body_text text;
ALTER TABLE public.whatsapp_call_permission_requests ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';
ALTER TABLE public.whatsapp_call_permission_requests ADD COLUMN IF NOT EXISTS meta_response jsonb;
ALTER TABLE public.whatsapp_call_permission_requests ADD COLUMN IF NOT EXISTS meta_error jsonb;
ALTER TABLE public.whatsapp_call_permission_requests ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.whatsapp_call_permission_requests ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_whatsapp_call_permission_requests_company_customer_created
ON public.whatsapp_call_permission_requests (company_id, customer_wa_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_whatsapp_call_permission_requests_message_id
ON public.whatsapp_call_permission_requests (request_message_id);

CREATE TABLE IF NOT EXISTS public.whatsapp_call_permissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id text,
    profile_id text,
    phone_number_id text NOT NULL,
    customer_wa_id text NOT NULL,
    customer_phone_number text,
    permission_status text NOT NULL DEFAULT 'unknown',
    is_permanent boolean NOT NULL DEFAULT false,
    expiration_timestamp timestamptz,
    response_source text,
    context_id text,
    context_from text,
    last_request_message_id text,
    raw_payload jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.whatsapp_call_permissions ADD COLUMN IF NOT EXISTS company_id text;
ALTER TABLE public.whatsapp_call_permissions ADD COLUMN IF NOT EXISTS profile_id text;
ALTER TABLE public.whatsapp_call_permissions ADD COLUMN IF NOT EXISTS phone_number_id text;
ALTER TABLE public.whatsapp_call_permissions ADD COLUMN IF NOT EXISTS customer_wa_id text;
ALTER TABLE public.whatsapp_call_permissions ADD COLUMN IF NOT EXISTS customer_phone_number text;
ALTER TABLE public.whatsapp_call_permissions ADD COLUMN IF NOT EXISTS permission_status text NOT NULL DEFAULT 'unknown';
ALTER TABLE public.whatsapp_call_permissions ADD COLUMN IF NOT EXISTS is_permanent boolean NOT NULL DEFAULT false;
ALTER TABLE public.whatsapp_call_permissions ADD COLUMN IF NOT EXISTS expiration_timestamp timestamptz;
ALTER TABLE public.whatsapp_call_permissions ADD COLUMN IF NOT EXISTS response_source text;
ALTER TABLE public.whatsapp_call_permissions ADD COLUMN IF NOT EXISTS context_id text;
ALTER TABLE public.whatsapp_call_permissions ADD COLUMN IF NOT EXISTS context_from text;
ALTER TABLE public.whatsapp_call_permissions ADD COLUMN IF NOT EXISTS last_request_message_id text;
ALTER TABLE public.whatsapp_call_permissions ADD COLUMN IF NOT EXISTS raw_payload jsonb;
ALTER TABLE public.whatsapp_call_permissions ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.whatsapp_call_permissions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_call_permissions_phone_customer_uniq
ON public.whatsapp_call_permissions (phone_number_id, customer_wa_id);

CREATE INDEX IF NOT EXISTS idx_whatsapp_call_permissions_company_status
ON public.whatsapp_call_permissions (company_id, permission_status, updated_at DESC);
