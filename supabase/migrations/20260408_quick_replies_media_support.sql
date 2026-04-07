-- Extend company quick replies to support media payloads (image/video/document).

BEGIN;

ALTER TABLE public.quick_replies
  ADD COLUMN IF NOT EXISTS message_type text NOT NULL DEFAULT 'text';

ALTER TABLE public.quick_replies
  ADD COLUMN IF NOT EXISTS media_url text;

ALTER TABLE public.quick_replies
  ADD COLUMN IF NOT EXISTS media_filename text;

UPDATE public.quick_replies
SET message_type = 'text'
WHERE message_type IS NULL
   OR btrim(message_type) = ''
   OR lower(message_type) NOT IN ('text', 'image', 'video', 'document');

COMMIT;
