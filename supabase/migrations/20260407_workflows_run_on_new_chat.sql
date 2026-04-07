-- Allow selecting exactly one workflow per company to run on unmatched first inbound chat.

BEGIN;

ALTER TABLE public.workflows
  ADD COLUMN IF NOT EXISTS run_on_new_chat boolean NOT NULL DEFAULT false;

UPDATE public.workflows
SET run_on_new_chat = false
WHERE run_on_new_chat IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_one_new_chat_default_per_company
ON public.workflows (company_id)
WHERE run_on_new_chat = true;

-- Ask PostgREST to refresh schema cache after DDL.
SELECT pg_notify('pgrst', 'reload schema');

COMMIT;
