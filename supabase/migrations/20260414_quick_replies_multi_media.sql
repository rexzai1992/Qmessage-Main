BEGIN;

ALTER TABLE public.quick_replies
  ADD COLUMN IF NOT EXISTS media_items jsonb;

UPDATE public.quick_replies
SET media_items = CASE
    WHEN lower(coalesce(message_type, 'text')) = 'text' THEN '[]'::jsonb
    WHEN coalesce(nullif(btrim(media_asset_key), ''), '') <> ''
      OR coalesce(nullif(btrim(media_url), ''), '') <> ''
      THEN jsonb_build_array(
        jsonb_build_object(
          'type', CASE
            WHEN lower(coalesce(message_type, '')) IN ('image', 'video', 'document') THEN lower(message_type)
            ELSE 'image'
          END,
          'media_storage', CASE
            WHEN coalesce(nullif(btrim(media_asset_key), ''), '') <> '' THEN 'r2'
            ELSE 'external'
          END,
          'media_asset_key', coalesce(nullif(btrim(media_asset_key), ''), ''),
          'media_mime_type', coalesce(nullif(lower(btrim(media_mime_type)), ''), ''),
          'media_size_bytes', CASE
            WHEN media_size_bytes IS NULL OR media_size_bytes <= 0 THEN NULL
            ELSE media_size_bytes
          END,
          'media_url', CASE
            WHEN coalesce(nullif(btrim(media_asset_key), ''), '') <> '' THEN ''
            ELSE coalesce(nullif(btrim(media_url), ''), '')
          END,
          'media_filename', CASE
            WHEN lower(coalesce(message_type, '')) = 'document' THEN coalesce(nullif(btrim(media_filename), ''), '')
            ELSE ''
          END
        )
      )
    ELSE '[]'::jsonb
END
WHERE media_items IS NULL;

UPDATE public.quick_replies
SET media_items = '[]'::jsonb
WHERE media_items IS NOT NULL
  AND jsonb_typeof(media_items) <> 'array';

COMMIT;
