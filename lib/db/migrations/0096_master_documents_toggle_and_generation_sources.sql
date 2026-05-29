ALTER TABLE firms
  ADD COLUMN IF NOT EXISTS show_master_documents boolean NOT NULL DEFAULT true;

ALTER TABLE document_generation_jobs
  ADD COLUMN IF NOT EXISTS platform_document_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE document_generation_job_items
  ADD COLUMN IF NOT EXISTS template_source text NOT NULL DEFAULT 'firm';

ALTER TABLE document_generation_job_items
  ADD COLUMN IF NOT EXISTS platform_document_id integer;

ALTER TABLE document_generation_job_items
  ALTER COLUMN template_id DROP NOT NULL;

ALTER TABLE platform_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_documents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_documents_read ON platform_documents;

CREATE POLICY platform_documents_read ON platform_documents FOR SELECT TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
    OR (
      firm_id IS NULL
      AND NULLIF(current_setting('app.current_firm_id', true), '') IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM firms f
        WHERE f.id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
          AND COALESCE(f.show_master_documents, true) = true
      )
    )
  );
