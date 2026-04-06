-- Add workflow enabled toggle support

BEGIN;

ALTER TABLE public.workflows
  ADD COLUMN IF NOT EXISTS enabled boolean;

UPDATE public.workflows
SET enabled = true
WHERE enabled IS NULL;

ALTER TABLE public.workflows
  ALTER COLUMN enabled SET DEFAULT true;

ALTER TABLE public.workflows
  ALTER COLUMN enabled SET NOT NULL;

COMMIT;
