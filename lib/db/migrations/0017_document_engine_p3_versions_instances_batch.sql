BEGIN;

CREATE TABLE IF NOT EXISTS document_template_versions (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  template_id integer NOT NULL,
  version_no integer NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  source_object_path text NOT NULL,
  filename text NOT NULL,
  mime_type text NULL,
  template_kind text NULL,
  category text NULL,
  document_group text NULL,
  variables_snapshot jsonb NULL,
  pdf_mappings_snapshot jsonb NULL,
  applicability_rules_snapshot jsonb NULL,
  readiness_rules_snapshot jsonb NULL,
  created_by integer NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_by integer NULL,
  published_at timestamptz NULL,
  archived_by integer NULL,
  archived_at timestamptz NULL
);

ALTER TABLE document_template_versions
  DROP CONSTRAINT IF EXISTS fk_document_template_versions_firm;
ALTER TABLE document_template_versions
  ADD CONSTRAINT fk_document_template_versions_firm
  FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE;

ALTER TABLE document_template_versions
  DROP CONSTRAINT IF EXISTS fk_document_template_versions_template;
ALTER TABLE document_template_versions
  ADD CONSTRAINT fk_document_template_versions_template
  FOREIGN KEY (template_id) REFERENCES document_templates(id) ON DELETE CASCADE;

ALTER TABLE document_template_versions
  DROP CONSTRAINT IF EXISTS fk_document_template_versions_created_by;
ALTER TABLE document_template_versions
  ADD CONSTRAINT fk_document_template_versions_created_by
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE document_template_versions
  DROP CONSTRAINT IF EXISTS fk_document_template_versions_published_by;
ALTER TABLE document_template_versions
  ADD CONSTRAINT fk_document_template_versions_published_by
  FOREIGN KEY (published_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE document_template_versions
  DROP CONSTRAINT IF EXISTS fk_document_template_versions_archived_by;
ALTER TABLE document_template_versions
  ADD CONSTRAINT fk_document_template_versions_archived_by
  FOREIGN KEY (archived_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE document_template_versions
  DROP CONSTRAINT IF EXISTS chk_document_template_versions_status;
ALTER TABLE document_template_versions
  ADD CONSTRAINT chk_document_template_versions_status
  CHECK (status IN ('draft','published','archived'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_document_template_versions_template_version_no
  ON document_template_versions (template_id, version_no);
CREATE INDEX IF NOT EXISTS idx_document_template_versions_firm ON document_template_versions (firm_id);
CREATE INDEX IF NOT EXISTS idx_document_template_versions_template ON document_template_versions (template_id);
CREATE INDEX IF NOT EXISTS idx_document_template_versions_status ON document_template_versions (firm_id, status);
CREATE INDEX IF NOT EXISTS idx_document_template_versions_created_at ON document_template_versions (firm_id, created_at DESC);

CREATE TABLE IF NOT EXISTS document_generation_runs (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  case_id integer NOT NULL,
  template_source text NOT NULL,
  template_id integer NULL,
  template_version_id integer NULL,
  platform_document_id integer NULL,
  case_document_id integer NULL,
  document_name text NOT NULL,
  render_mode text NOT NULL DEFAULT 'docx',
  status text NOT NULL DEFAULT 'pending',
  rendered_variables_snapshot jsonb NULL,
  checklist_snapshot jsonb NULL,
  readiness_snapshot jsonb NULL,
  triggered_by integer NULL,
  triggered_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NULL,
  error_code text NULL,
  error_message text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE document_generation_runs
  DROP CONSTRAINT IF EXISTS fk_document_generation_runs_firm;
ALTER TABLE document_generation_runs
  ADD CONSTRAINT fk_document_generation_runs_firm
  FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE;

ALTER TABLE document_generation_runs
  DROP CONSTRAINT IF EXISTS fk_document_generation_runs_case;
ALTER TABLE document_generation_runs
  ADD CONSTRAINT fk_document_generation_runs_case
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE;

ALTER TABLE document_generation_runs
  DROP CONSTRAINT IF EXISTS fk_document_generation_runs_template;
ALTER TABLE document_generation_runs
  ADD CONSTRAINT fk_document_generation_runs_template
  FOREIGN KEY (template_id) REFERENCES document_templates(id) ON DELETE SET NULL;

ALTER TABLE document_generation_runs
  DROP CONSTRAINT IF EXISTS fk_document_generation_runs_template_version;
ALTER TABLE document_generation_runs
  ADD CONSTRAINT fk_document_generation_runs_template_version
  FOREIGN KEY (template_version_id) REFERENCES document_template_versions(id) ON DELETE SET NULL;

ALTER TABLE document_generation_runs
  DROP CONSTRAINT IF EXISTS fk_document_generation_runs_platform_document;
ALTER TABLE document_generation_runs
  ADD CONSTRAINT fk_document_generation_runs_platform_document
  FOREIGN KEY (platform_document_id) REFERENCES platform_documents(id) ON DELETE SET NULL;

ALTER TABLE document_generation_runs
  DROP CONSTRAINT IF EXISTS fk_document_generation_runs_case_document;
ALTER TABLE document_generation_runs
  ADD CONSTRAINT fk_document_generation_runs_case_document
  FOREIGN KEY (case_document_id) REFERENCES case_documents(id) ON DELETE SET NULL;

ALTER TABLE document_generation_runs
  DROP CONSTRAINT IF EXISTS fk_document_generation_runs_triggered_by;
ALTER TABLE document_generation_runs
  ADD CONSTRAINT fk_document_generation_runs_triggered_by
  FOREIGN KEY (triggered_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE document_generation_runs
  DROP CONSTRAINT IF EXISTS chk_document_generation_runs_template_source;
ALTER TABLE document_generation_runs
  ADD CONSTRAINT chk_document_generation_runs_template_source
  CHECK (template_source IN ('firm','master'));

ALTER TABLE document_generation_runs
  DROP CONSTRAINT IF EXISTS chk_document_generation_runs_status;
ALTER TABLE document_generation_runs
  ADD CONSTRAINT chk_document_generation_runs_status
  CHECK (status IN ('pending','running','success','failed'));

ALTER TABLE document_generation_runs
  DROP CONSTRAINT IF EXISTS chk_document_generation_runs_render_mode;
ALTER TABLE document_generation_runs
  ADD CONSTRAINT chk_document_generation_runs_render_mode
  CHECK (render_mode IN ('docx','pdf','print'));

CREATE INDEX IF NOT EXISTS idx_document_generation_runs_firm ON document_generation_runs (firm_id);
CREATE INDEX IF NOT EXISTS idx_document_generation_runs_case ON document_generation_runs (firm_id, case_id);
CREATE INDEX IF NOT EXISTS idx_document_generation_runs_status ON document_generation_runs (firm_id, status);
CREATE INDEX IF NOT EXISTS idx_document_generation_runs_triggered_at ON document_generation_runs (firm_id, case_id, triggered_at DESC);

CREATE TABLE IF NOT EXISTS document_batch_jobs (
  id uuid PRIMARY KEY,
  firm_id integer NOT NULL,
  case_id integer NOT NULL,
  job_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  total_count integer NOT NULL DEFAULT 0,
  success_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  pending_count integer NOT NULL DEFAULT 0,
  created_by integer NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  download_object_path text NULL,
  download_file_name text NULL,
  download_mime_type text NULL,
  error_summary text NULL
);

ALTER TABLE document_batch_jobs
  DROP CONSTRAINT IF EXISTS fk_document_batch_jobs_firm;
ALTER TABLE document_batch_jobs
  ADD CONSTRAINT fk_document_batch_jobs_firm
  FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE;

ALTER TABLE document_batch_jobs
  DROP CONSTRAINT IF EXISTS fk_document_batch_jobs_case;
ALTER TABLE document_batch_jobs
  ADD CONSTRAINT fk_document_batch_jobs_case
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE;

ALTER TABLE document_batch_jobs
  DROP CONSTRAINT IF EXISTS fk_document_batch_jobs_created_by;
ALTER TABLE document_batch_jobs
  ADD CONSTRAINT fk_document_batch_jobs_created_by
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE document_batch_jobs
  DROP CONSTRAINT IF EXISTS chk_document_batch_jobs_type;
ALTER TABLE document_batch_jobs
  ADD CONSTRAINT chk_document_batch_jobs_type
  CHECK (job_type IN ('generate','export'));

ALTER TABLE document_batch_jobs
  DROP CONSTRAINT IF EXISTS chk_document_batch_jobs_status;
ALTER TABLE document_batch_jobs
  ADD CONSTRAINT chk_document_batch_jobs_status
  CHECK (status IN ('pending','running','completed','failed'));

CREATE INDEX IF NOT EXISTS idx_document_batch_jobs_firm ON document_batch_jobs (firm_id);
CREATE INDEX IF NOT EXISTS idx_document_batch_jobs_case ON document_batch_jobs (firm_id, case_id);
CREATE INDEX IF NOT EXISTS idx_document_batch_jobs_status ON document_batch_jobs (firm_id, status);
CREATE INDEX IF NOT EXISTS idx_document_batch_jobs_created_at ON document_batch_jobs (firm_id, created_at DESC);

CREATE TABLE IF NOT EXISTS document_batch_job_items (
  id serial PRIMARY KEY,
  job_id uuid NOT NULL,
  firm_id integer NOT NULL,
  case_id integer NOT NULL,
  template_source text NOT NULL,
  template_id integer NULL,
  template_version_id integer NULL,
  platform_document_id integer NULL,
  case_document_id integer NULL,
  status text NOT NULL DEFAULT 'pending',
  error_code text NULL,
  error_message text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NULL
);

ALTER TABLE document_batch_job_items
  DROP CONSTRAINT IF EXISTS fk_document_batch_job_items_job;
ALTER TABLE document_batch_job_items
  ADD CONSTRAINT fk_document_batch_job_items_job
  FOREIGN KEY (job_id) REFERENCES document_batch_jobs(id) ON DELETE CASCADE;

ALTER TABLE document_batch_job_items
  DROP CONSTRAINT IF EXISTS fk_document_batch_job_items_firm;
ALTER TABLE document_batch_job_items
  ADD CONSTRAINT fk_document_batch_job_items_firm
  FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE;

ALTER TABLE document_batch_job_items
  DROP CONSTRAINT IF EXISTS fk_document_batch_job_items_case;
ALTER TABLE document_batch_job_items
  ADD CONSTRAINT fk_document_batch_job_items_case
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE;

ALTER TABLE document_batch_job_items
  DROP CONSTRAINT IF EXISTS fk_document_batch_job_items_template;
ALTER TABLE document_batch_job_items
  ADD CONSTRAINT fk_document_batch_job_items_template
  FOREIGN KEY (template_id) REFERENCES document_templates(id) ON DELETE SET NULL;

ALTER TABLE document_batch_job_items
  DROP CONSTRAINT IF EXISTS fk_document_batch_job_items_template_version;
ALTER TABLE document_batch_job_items
  ADD CONSTRAINT fk_document_batch_job_items_template_version
  FOREIGN KEY (template_version_id) REFERENCES document_template_versions(id) ON DELETE SET NULL;

ALTER TABLE document_batch_job_items
  DROP CONSTRAINT IF EXISTS fk_document_batch_job_items_platform_document;
ALTER TABLE document_batch_job_items
  ADD CONSTRAINT fk_document_batch_job_items_platform_document
  FOREIGN KEY (platform_document_id) REFERENCES platform_documents(id) ON DELETE SET NULL;

ALTER TABLE document_batch_job_items
  DROP CONSTRAINT IF EXISTS fk_document_batch_job_items_case_document;
ALTER TABLE document_batch_job_items
  ADD CONSTRAINT fk_document_batch_job_items_case_document
  FOREIGN KEY (case_document_id) REFERENCES case_documents(id) ON DELETE SET NULL;

ALTER TABLE document_batch_job_items
  DROP CONSTRAINT IF EXISTS chk_document_batch_job_items_template_source;
ALTER TABLE document_batch_job_items
  ADD CONSTRAINT chk_document_batch_job_items_template_source
  CHECK (template_source IN ('firm','master'));

ALTER TABLE document_batch_job_items
  DROP CONSTRAINT IF EXISTS chk_document_batch_job_items_status;
ALTER TABLE document_batch_job_items
  ADD CONSTRAINT chk_document_batch_job_items_status
  CHECK (status IN ('pending','running','success','failed'));

CREATE INDEX IF NOT EXISTS idx_document_batch_job_items_job ON document_batch_job_items (job_id);
CREATE INDEX IF NOT EXISTS idx_document_batch_job_items_firm ON document_batch_job_items (firm_id);
CREATE INDEX IF NOT EXISTS idx_document_batch_job_items_case ON document_batch_job_items (firm_id, case_id);
CREATE INDEX IF NOT EXISTS idx_document_batch_job_items_status ON document_batch_job_items (firm_id, status);
CREATE INDEX IF NOT EXISTS idx_document_batch_job_items_created_at ON document_batch_job_items (firm_id, case_id, created_at DESC);

ALTER TABLE document_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_template_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE document_generation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_generation_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE document_batch_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_batch_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE document_batch_job_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_batch_job_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON document_template_versions;
DROP POLICY IF EXISTS tenant_isolation ON document_generation_runs;
DROP POLICY IF EXISTS tenant_isolation ON document_batch_jobs;
DROP POLICY IF EXISTS tenant_isolation ON document_batch_job_items;

CREATE POLICY tenant_isolation ON document_template_versions FOR ALL TO PUBLIC
  USING (
    (firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer)
    OR current_setting('app.is_founder',true)='true'
  )
  WITH CHECK (
    (firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer)
    OR current_setting('app.is_founder',true)='true'
  );

CREATE POLICY tenant_isolation ON document_generation_runs FOR ALL TO PUBLIC
  USING (
    (firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer)
    OR current_setting('app.is_founder',true)='true'
  )
  WITH CHECK (
    (firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer)
    OR current_setting('app.is_founder',true)='true'
  );

CREATE POLICY tenant_isolation ON document_batch_jobs FOR ALL TO PUBLIC
  USING (
    (firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer)
    OR current_setting('app.is_founder',true)='true'
  )
  WITH CHECK (
    (firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer)
    OR current_setting('app.is_founder',true)='true'
  );

CREATE POLICY tenant_isolation ON document_batch_job_items FOR ALL TO PUBLIC
  USING (
    (firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer)
    OR current_setting('app.is_founder',true)='true'
  )
  WITH CHECK (
    (firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer)
    OR current_setting('app.is_founder',true)='true'
  );

INSERT INTO document_template_versions (
  firm_id,
  template_id,
  version_no,
  status,
  source_object_path,
  filename,
  mime_type,
  template_kind,
  category,
  document_group,
  variables_snapshot,
  pdf_mappings_snapshot,
  applicability_rules_snapshot,
  readiness_rules_snapshot,
  created_by,
  created_at,
  published_by,
  published_at
)
SELECT
  t.firm_id,
  t.id,
  1,
  'published',
  t.object_path,
  t.file_name,
  t.mime_type,
  t.kind,
  t.document_type,
  t.document_group,
  NULL,
  NULL,
  jsonb_build_object(
    'applies_to_purchase_mode', t.applies_to_purchase_mode,
    'applies_to_title_type', t.applies_to_title_type,
    'applies_to_case_type', t.applies_to_case_type,
    'is_active', t.is_active
  ),
  jsonb_build_object(
    'document_group', t.document_group
  ),
  t.created_by,
  t.created_at,
  t.created_by,
  t.created_at
FROM document_templates t
WHERE t.is_template_capable = true
  AND LOWER(COALESCE(t.extension, '')) = 'docx'
  AND NOT EXISTS (
    SELECT 1 FROM document_template_versions v
    WHERE v.template_id = t.id
  );

COMMIT;
