-- Company-level UI visibility controls managed via /myadmin.

BEGIN;

ALTER TABLE public.company
  ADD COLUMN IF NOT EXISTS ui_hidden_features jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE public.company
SET ui_hidden_features = '[]'::jsonb
WHERE ui_hidden_features IS NULL
   OR jsonb_typeof(ui_hidden_features) <> 'array';

COMMIT;
