-- Store per-company AI chatbot settings in Supabase (instead of local JSON file).

BEGIN;

CREATE TABLE IF NOT EXISTS public.company_ai_settings (
  company_id text PRIMARY KEY REFERENCES public.company(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  model text NOT NULL DEFAULT 'gpt-4o-mini',
  system_prompt text NOT NULL DEFAULT 'You are a concise, helpful WhatsApp business assistant.',
  temperature double precision NOT NULL DEFAULT 0.4,
  max_tokens integer NOT NULL DEFAULT 512,
  memory_enabled boolean NOT NULL DEFAULT true,
  memory_messages integer NOT NULL DEFAULT 16,
  api_key text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

ALTER TABLE public.company_ai_settings ADD COLUMN IF NOT EXISTS company_id text;
ALTER TABLE public.company_ai_settings ADD COLUMN IF NOT EXISTS enabled boolean DEFAULT false;
ALTER TABLE public.company_ai_settings ADD COLUMN IF NOT EXISTS model text DEFAULT 'gpt-4o-mini';
ALTER TABLE public.company_ai_settings ADD COLUMN IF NOT EXISTS system_prompt text DEFAULT 'You are a concise, helpful WhatsApp business assistant.';
ALTER TABLE public.company_ai_settings ADD COLUMN IF NOT EXISTS temperature double precision DEFAULT 0.4;
ALTER TABLE public.company_ai_settings ADD COLUMN IF NOT EXISTS max_tokens integer DEFAULT 512;
ALTER TABLE public.company_ai_settings ADD COLUMN IF NOT EXISTS memory_enabled boolean DEFAULT true;
ALTER TABLE public.company_ai_settings ADD COLUMN IF NOT EXISTS memory_messages integer DEFAULT 16;
ALTER TABLE public.company_ai_settings ADD COLUMN IF NOT EXISTS api_key text;
ALTER TABLE public.company_ai_settings ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.company_ai_settings ADD COLUMN IF NOT EXISTS updated_by uuid;

UPDATE public.company_ai_settings
SET
  enabled = COALESCE(enabled, false),
  model = COALESCE(NULLIF(BTRIM(model), ''), 'gpt-4o-mini'),
  system_prompt = COALESCE(NULLIF(BTRIM(system_prompt), ''), 'You are a concise, helpful WhatsApp business assistant.'),
  temperature = COALESCE(temperature, 0.4),
  max_tokens = COALESCE(max_tokens, 512),
  memory_enabled = COALESCE(memory_enabled, true),
  memory_messages = COALESCE(memory_messages, 16),
  updated_at = COALESCE(updated_at, now());

ALTER TABLE public.company_ai_settings ALTER COLUMN enabled SET DEFAULT false;
ALTER TABLE public.company_ai_settings ALTER COLUMN model SET DEFAULT 'gpt-4o-mini';
ALTER TABLE public.company_ai_settings ALTER COLUMN system_prompt SET DEFAULT 'You are a concise, helpful WhatsApp business assistant.';
ALTER TABLE public.company_ai_settings ALTER COLUMN temperature SET DEFAULT 0.4;
ALTER TABLE public.company_ai_settings ALTER COLUMN max_tokens SET DEFAULT 512;
ALTER TABLE public.company_ai_settings ALTER COLUMN memory_enabled SET DEFAULT true;
ALTER TABLE public.company_ai_settings ALTER COLUMN memory_messages SET DEFAULT 16;
ALTER TABLE public.company_ai_settings ALTER COLUMN updated_at SET DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'company_ai_settings_company_id_fkey'
      AND conrelid = 'public.company_ai_settings'::regclass
  ) THEN
    ALTER TABLE public.company_ai_settings
      ADD CONSTRAINT company_ai_settings_company_id_fkey
      FOREIGN KEY (company_id)
      REFERENCES public.company(id)
      ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_company_ai_settings_updated_at
ON public.company_ai_settings(updated_at DESC);

COMMIT;
