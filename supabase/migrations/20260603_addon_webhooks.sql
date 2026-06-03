-- Move addon webhook configuration out of local addon_webhooks.json while
-- keeping the retry queue file-backed for now.

CREATE TABLE IF NOT EXISTS public.addon_webhooks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id text NOT NULL,
    company_id text,
    url text NOT NULL,
    events jsonb NOT NULL DEFAULT '[]'::jsonb,
    enabled boolean NOT NULL DEFAULT true,
    secret_encrypted text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.addon_webhooks ADD COLUMN IF NOT EXISTS profile_id text;
ALTER TABLE public.addon_webhooks ADD COLUMN IF NOT EXISTS company_id text;
ALTER TABLE public.addon_webhooks ADD COLUMN IF NOT EXISTS url text;
ALTER TABLE public.addon_webhooks ADD COLUMN IF NOT EXISTS events jsonb DEFAULT '[]'::jsonb;
ALTER TABLE public.addon_webhooks ADD COLUMN IF NOT EXISTS enabled boolean DEFAULT true;
ALTER TABLE public.addon_webhooks ADD COLUMN IF NOT EXISTS secret_encrypted text;
ALTER TABLE public.addon_webhooks ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.addon_webhooks ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS addon_webhooks_profile_url_uniq
ON public.addon_webhooks (profile_id, url);

CREATE INDEX IF NOT EXISTS idx_addon_webhooks_profile_id
ON public.addon_webhooks (profile_id);

CREATE INDEX IF NOT EXISTS idx_addon_webhooks_company_id
ON public.addon_webhooks (company_id);
