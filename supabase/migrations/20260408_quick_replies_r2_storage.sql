-- Add R2-backed media storage fields for quick replies.

BEGIN;

ALTER TABLE public.quick_replies
  ADD COLUMN IF NOT EXISTS media_storage text NOT NULL DEFAULT 'external';

ALTER TABLE public.quick_replies
  ADD COLUMN IF NOT EXISTS media_asset_key text;

ALTER TABLE public.quick_replies
  ADD COLUMN IF NOT EXISTS media_mime_type text;

ALTER TABLE public.quick_replies
  ADD COLUMN IF NOT EXISTS media_size_bytes bigint;

UPDATE public.quick_replies
SET media_storage = CASE
    WHEN COALESCE(NULLIF(btrim(media_asset_key), ''), '') <> '' THEN 'r2'
    ELSE 'external'
END
WHERE media_storage IS NULL
   OR btrim(media_storage) = ''
   OR lower(media_storage) NOT IN ('external', 'r2');

COMMIT;
