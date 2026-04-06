-- Ensure workflows has explicit name + enabled columns.
-- Backfill missing values from builder.meta for compatibility with older schema.

BEGIN;

ALTER TABLE public.workflows
  ADD COLUMN IF NOT EXISTS name text;

ALTER TABLE public.workflows
  ADD COLUMN IF NOT EXISTS enabled boolean;

-- Backfill name from builder.meta.name when name is missing/blank.
UPDATE public.workflows
SET name = NULLIF(BTRIM(COALESCE(builder #>> '{meta,name}', '')), '')
WHERE (name IS NULL OR BTRIM(name) = '')
  AND BTRIM(COALESCE(builder #>> '{meta,name}', '')) <> '';

-- Backfill enabled from builder.meta.enabled when enabled is null.
UPDATE public.workflows
SET enabled = CASE
  WHEN LOWER(COALESCE(builder #>> '{meta,enabled}', '')) IN ('true', 'false')
    THEN (builder #>> '{meta,enabled}')::boolean
  ELSE true
END
WHERE enabled IS NULL;

-- Normalize any remaining null names.
UPDATE public.workflows
SET name = ''
WHERE name IS NULL;

ALTER TABLE public.workflows
  ALTER COLUMN name SET DEFAULT '';

ALTER TABLE public.workflows
  ALTER COLUMN name SET NOT NULL;

ALTER TABLE public.workflows
  ALTER COLUMN enabled SET DEFAULT true;

ALTER TABLE public.workflows
  ALTER COLUMN enabled SET NOT NULL;

-- Ask PostgREST to refresh schema cache after DDL.
SELECT pg_notify('pgrst', 'reload schema');

COMMIT;
