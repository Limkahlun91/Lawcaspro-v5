CREATE TABLE IF NOT EXISTS document_generation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id integer NOT NULL,
  job_type text NOT NULL DEFAULT 'document_automation',
  status text NOT NULL DEFAULT 'pending',
  action text NOT NULL DEFAULT 'download',
  case_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  template_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_count integer NOT NULL DEFAULT 0,
  success_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  pending_count integer NOT NULL DEFAULT 0,
  created_by integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  download_object_path text,
  download_file_name text,
  download_mime_type text,
  error_summary text
);

CREATE INDEX IF NOT EXISTS idx_document_generation_jobs_firm
  ON document_generation_jobs (firm_id);
CREATE INDEX IF NOT EXISTS idx_document_generation_jobs_status
  ON document_generation_jobs (firm_id, status);
CREATE INDEX IF NOT EXISTS idx_document_generation_jobs_created_at
  ON document_generation_jobs (firm_id, created_at);

ALTER TABLE document_generation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_generation_jobs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON document_generation_jobs;
CREATE POLICY tenant_isolation ON document_generation_jobs FOR ALL TO PUBLIC
  USING (
    firm_id = nullif(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  )
  WITH CHECK (
    firm_id = nullif(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  );

CREATE TABLE IF NOT EXISTS document_generation_job_items (
  id serial PRIMARY KEY,
  job_id uuid NOT NULL,
  firm_id integer NOT NULL,
  case_id integer NOT NULL,
  template_id integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  object_path text,
  file_name text,
  mime_type text,
  file_size integer,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_document_generation_job_items_job
  ON document_generation_job_items (job_id);
CREATE INDEX IF NOT EXISTS idx_document_generation_job_items_firm
  ON document_generation_job_items (firm_id);
CREATE INDEX IF NOT EXISTS idx_document_generation_job_items_case
  ON document_generation_job_items (firm_id, case_id);
CREATE INDEX IF NOT EXISTS idx_document_generation_job_items_status
  ON document_generation_job_items (firm_id, status);
CREATE INDEX IF NOT EXISTS idx_document_generation_job_items_created_at
  ON document_generation_job_items (firm_id, case_id, created_at);

ALTER TABLE document_generation_job_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_generation_job_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON document_generation_job_items;
CREATE POLICY tenant_isolation ON document_generation_job_items FOR ALL TO PUBLIC
  USING (
    firm_id = nullif(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  )
  WITH CHECK (
    firm_id = nullif(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  );
