-- Remove invoice-related database objects

BEGIN;

-- Remove storage policies for invoice bucket objects if they exist
DROP POLICY IF EXISTS invoices_objects_public_read ON storage.objects;
DROP POLICY IF EXISTS invoices_objects_auth_insert ON storage.objects;
DROP POLICY IF EXISTS invoices_objects_auth_update ON storage.objects;
DROP POLICY IF EXISTS invoices_objects_auth_delete ON storage.objects;

-- Remove invoice files and bucket metadata (if present)
DELETE FROM storage.objects WHERE bucket_id = 'invoices';
DELETE FROM storage.buckets WHERE id = 'invoices';

-- Remove invoice tables
DROP TABLE IF EXISTS public.invoice_items CASCADE;
DROP TABLE IF EXISTS public.invoices CASCADE;

-- Remove invoice-specific company settings columns
ALTER TABLE public.company DROP COLUMN IF EXISTS default_invoice_prefix;
ALTER TABLE public.company DROP COLUMN IF EXISTS default_invoice_notes;
ALTER TABLE public.company DROP COLUMN IF EXISTS default_payment_instructions;
ALTER TABLE public.company DROP COLUMN IF EXISTS invoice_template_name;
ALTER TABLE public.company DROP COLUMN IF EXISTS invoice_template_config;

COMMIT;
