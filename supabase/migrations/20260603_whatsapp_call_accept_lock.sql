ALTER TABLE public.whatsapp_calls
    ADD COLUMN IF NOT EXISTS accepted_by_user_id text,
    ADD COLUMN IF NOT EXISTS accepted_by_name text,
    ADD COLUMN IF NOT EXISTS accepted_at timestamptz,
    ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz,
    ADD COLUMN IF NOT EXISTS accept_lock_token text;

CREATE INDEX IF NOT EXISTS idx_whatsapp_calls_status_claim_expires
ON public.whatsapp_calls (status, claim_expires_at);

CREATE INDEX IF NOT EXISTS idx_whatsapp_calls_accepted_by_user
ON public.whatsapp_calls (accepted_by_user_id, updated_at DESC);
