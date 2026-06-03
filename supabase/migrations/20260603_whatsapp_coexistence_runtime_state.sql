-- Coexistence runtime state for existing WhatsApp Business App onboarding.
-- Keeps the schema additive so existing Cloud API connections continue to work.

ALTER TABLE public.whatsapp_connections
ALTER COLUMN flow_type SET DEFAULT 'cloud_api';

UPDATE public.whatsapp_connections
SET flow_type = 'cloud_api'
WHERE flow_type IS NULL OR btrim(flow_type) = '';

ALTER TABLE public.whatsapp_connections
ADD COLUMN IF NOT EXISTS coexistence_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE public.whatsapp_connections
ADD COLUMN IF NOT EXISTS is_on_biz_app boolean;

ALTER TABLE public.whatsapp_connections
ADD COLUMN IF NOT EXISTS sync_status text;

ALTER TABLE public.whatsapp_connections
ADD COLUMN IF NOT EXISTS contacts_sync_request_id text;

ALTER TABLE public.whatsapp_connections
ADD COLUMN IF NOT EXISTS history_sync_request_id text;

ALTER TABLE public.whatsapp_connections
ADD COLUMN IF NOT EXISTS sync_started_at timestamptz;

ALTER TABLE public.whatsapp_connections
ADD COLUMN IF NOT EXISTS history_sync_progress integer;

ALTER TABLE public.whatsapp_connections
ADD COLUMN IF NOT EXISTS messaging_paused boolean NOT NULL DEFAULT false;

ALTER TABLE public.whatsapp_connections
ADD COLUMN IF NOT EXISTS disconnection_reason text;

ALTER TABLE public.whatsapp_connections
ADD COLUMN IF NOT EXISTS disconnection_initiated_by text;

ALTER TABLE public.whatsapp_connections
ADD COLUMN IF NOT EXISTS last_account_update_event text;

UPDATE public.whatsapp_connections
SET
    coexistence_enabled = COALESCE(coexistence_enabled, false),
    messaging_paused = COALESCE(messaging_paused, false),
    history_sync_progress = CASE
        WHEN history_sync_progress IS NULL THEN NULL
        WHEN history_sync_progress < 0 THEN 0
        WHEN history_sync_progress > 100 THEN 100
        ELSE history_sync_progress
    END,
    updated_at = now()
WHERE
    coexistence_enabled IS NULL
    OR messaging_paused IS NULL
    OR history_sync_progress IS DISTINCT FROM CASE
        WHEN history_sync_progress IS NULL THEN NULL
        WHEN history_sync_progress < 0 THEN 0
        WHEN history_sync_progress > 100 THEN 100
        ELSE history_sync_progress
    END;

CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_profile_paused
ON public.whatsapp_connections (profile_id, messaging_paused, updated_at DESC);
