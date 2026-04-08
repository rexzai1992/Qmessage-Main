-- Add company app logo storage fields (R2-backed).

BEGIN;

ALTER TABLE public.company
  ADD COLUMN IF NOT EXISTS app_logo_storage text NOT NULL DEFAULT 'none';

ALTER TABLE public.company
  ADD COLUMN IF NOT EXISTS app_logo_asset_key text;

ALTER TABLE public.company
  ADD COLUMN IF NOT EXISTS app_logo_mime_type text;

ALTER TABLE public.company
  ADD COLUMN IF NOT EXISTS app_logo_size_bytes bigint;

ALTER TABLE public.company
  ADD COLUMN IF NOT EXISTS app_logo_filename text;

UPDATE public.company
SET app_logo_storage = CASE
    WHEN COALESCE(NULLIF(btrim(app_logo_asset_key), ''), '') <> '' THEN 'r2'
    ELSE 'none'
END
WHERE app_logo_storage IS NULL
   OR btrim(app_logo_storage) = ''
   OR lower(app_logo_storage) NOT IN ('none', 'r2');

COMMIT;
