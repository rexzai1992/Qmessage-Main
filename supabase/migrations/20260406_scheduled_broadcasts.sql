-- Queue table for scheduled template broadcasts
CREATE TABLE IF NOT EXISTS public.scheduled_broadcasts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id text NOT NULL REFERENCES public.company(id) ON DELETE CASCADE,
    profile_id text NOT NULL,
    name text NOT NULL,
    template_name text NOT NULL,
    language text NOT NULL DEFAULT 'en_US',
    components jsonb NOT NULL DEFAULT '[]'::jsonb,
    recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
    scheduled_at timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'processing', 'sent', 'partial', 'failed', 'cancelled')),
    sent_count integer NOT NULL DEFAULT 0,
    failed_count integer NOT NULL DEFAULT 0,
    last_error text,
    created_by uuid,
    processed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_broadcasts_company_profile
    ON public.scheduled_broadcasts(company_id, profile_id);

CREATE INDEX IF NOT EXISTS idx_scheduled_broadcasts_status_time
    ON public.scheduled_broadcasts(status, scheduled_at);

ALTER TABLE public.scheduled_broadcasts ADD COLUMN IF NOT EXISTS company_id text;
ALTER TABLE public.scheduled_broadcasts ADD COLUMN IF NOT EXISTS profile_id text;
ALTER TABLE public.scheduled_broadcasts ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE public.scheduled_broadcasts ADD COLUMN IF NOT EXISTS template_name text;
ALTER TABLE public.scheduled_broadcasts ADD COLUMN IF NOT EXISTS language text DEFAULT 'en_US';
ALTER TABLE public.scheduled_broadcasts ADD COLUMN IF NOT EXISTS components jsonb DEFAULT '[]'::jsonb;
ALTER TABLE public.scheduled_broadcasts ADD COLUMN IF NOT EXISTS recipients jsonb DEFAULT '[]'::jsonb;
ALTER TABLE public.scheduled_broadcasts ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;
ALTER TABLE public.scheduled_broadcasts ADD COLUMN IF NOT EXISTS status text DEFAULT 'scheduled';
ALTER TABLE public.scheduled_broadcasts ADD COLUMN IF NOT EXISTS sent_count integer DEFAULT 0;
ALTER TABLE public.scheduled_broadcasts ADD COLUMN IF NOT EXISTS failed_count integer DEFAULT 0;
ALTER TABLE public.scheduled_broadcasts ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE public.scheduled_broadcasts ADD COLUMN IF NOT EXISTS created_by uuid;
ALTER TABLE public.scheduled_broadcasts ADD COLUMN IF NOT EXISTS processed_at timestamptz;
ALTER TABLE public.scheduled_broadcasts ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.scheduled_broadcasts ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
