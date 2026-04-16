-- Contact alias support:
-- - users.name keeps the latest WhatsApp profile name (auto-synced)
-- - users.alias stores operator-defined custom contact name (stable)

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS alias text;
