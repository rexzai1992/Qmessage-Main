-- Add maintenance controls per company for MyAdmin.
-- These settings are used to broadcast maintenance mode and notice text to tenant dashboards.

BEGIN;

ALTER TABLE public.company
    ADD COLUMN IF NOT EXISTS maintenance_mode boolean NOT NULL DEFAULT false;

ALTER TABLE public.company
    ADD COLUMN IF NOT EXISTS maintenance_notice text;

COMMENT ON COLUMN public.company.maintenance_mode IS
    'When true, tenant UI should display maintenance mode and restrict write actions.';

COMMENT ON COLUMN public.company.maintenance_notice IS
    'Optional notice text shown during maintenance mode.';

COMMIT;
