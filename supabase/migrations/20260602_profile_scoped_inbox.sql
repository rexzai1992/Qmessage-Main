-- Separate conversations by sender profile so the same contact can safely
-- exist under multiple business phone numbers in one company.

ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS profile_id text;

ALTER TABLE public.messages
ADD COLUMN IF NOT EXISTS profile_id text;

-- Backfill older single-profile companies automatically.
WITH single_profile_companies AS (
  SELECT company_id, MIN(id) AS profile_id
  FROM public.profiles
  WHERE company_id IS NOT NULL
  GROUP BY company_id
  HAVING COUNT(*) = 1
)
UPDATE public.users u
SET profile_id = spc.profile_id
FROM single_profile_companies spc
WHERE u.company_id = spc.company_id
  AND u.profile_id IS NULL;

UPDATE public.messages m
SET profile_id = u.profile_id
FROM public.users u
WHERE m.user_id = u.id
  AND m.profile_id IS NULL
  AND u.profile_id IS NOT NULL;

-- Preserve older simulated inbound markers where they already carry profile ownership.
UPDATE public.messages
SET profile_id = NULLIF(content ->> 'simulated_profile_id', '')
WHERE profile_id IS NULL
  AND content ? 'simulated_profile_id';

-- Replace any older uniqueness on company+phone with profile-scoped uniqueness.
DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'users'
      AND con.contype = 'u'
      AND (
        SELECT array_agg(att.attname::text ORDER BY ord.ordinality)
        FROM unnest(con.conkey) WITH ORDINALITY ord(attnum, ordinality)
        JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ord.attnum
      ) = ARRAY['company_id', 'phone_number']::text[]
  LOOP
    EXECUTE format('ALTER TABLE public.users DROP CONSTRAINT %I', rec.conname);
  END LOOP;
END $$;

DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'users'
      AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
      AND indexdef ILIKE '%(company_id, phone_number)%'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', rec.indexname);
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS users_company_profile_phone_uniq
ON public.users (company_id, profile_id, phone_number)
WHERE profile_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_company_profile_id
ON public.users (company_id, profile_id);

CREATE INDEX IF NOT EXISTS idx_messages_profile_id_created_at
ON public.messages (profile_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_profile_user_created_at
ON public.messages (profile_id, user_id, created_at DESC);
