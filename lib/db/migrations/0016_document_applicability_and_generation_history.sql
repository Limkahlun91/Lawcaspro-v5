-- Add document template applicability/grouping fields and case document generation metadata.
-- Safe and repeatable.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'document_templates'
  ) THEN
    ALTER TABLE public.document_templates
      ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS applies_to_purchase_mode text,
      ADD COLUMN IF NOT EXISTS applies_to_title_type text NOT NULL DEFAULT 'any',
      ADD COLUMN IF NOT EXISTS applies_to_case_type text,
      ADD COLUMN IF NOT EXISTS document_group text NOT NULL DEFAULT 'Others',
      ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'platform_documents'
  ) THEN
    ALTER TABLE public.platform_documents
      ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS applies_to_purchase_mode text,
      ADD COLUMN IF NOT EXISTS applies_to_title_type text NOT NULL DEFAULT 'any',
      ADD COLUMN IF NOT EXISTS applies_to_case_type text,
      ADD COLUMN IF NOT EXISTS document_group text NOT NULL DEFAULT 'Others',
      ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'case_documents'
  ) THEN
    ALTER TABLE public.case_documents
      ADD COLUMN IF NOT EXISTS template_source text,
      ADD COLUMN IF NOT EXISTS platform_document_id integer,
      ADD COLUMN IF NOT EXISTS template_snapshot_name text,
      ADD COLUMN IF NOT EXISTS template_snapshot_updated_at timestamptz;
  END IF;
END $$;

