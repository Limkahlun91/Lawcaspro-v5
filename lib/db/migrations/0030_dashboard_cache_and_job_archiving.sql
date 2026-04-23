-- Dashboard stats cache + job archiving helpers (Founder Maintenance support)

CREATE TABLE IF NOT EXISTS firm_dashboard_stats_cache (
  firm_id integer PRIMARY KEY REFERENCES firms(id) ON DELETE CASCADE,
  payload_json jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  schema_version integer NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_firm_dashboard_stats_cache_expires
  ON firm_dashboard_stats_cache (expires_at);

ALTER TABLE firm_dashboard_stats_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE firm_dashboard_stats_cache FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON firm_dashboard_stats_cache;
CREATE POLICY tenant_isolation ON firm_dashboard_stats_cache FOR ALL TO PUBLIC
  USING (
    firm_id = nullif(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  )
  WITH CHECK (
    firm_id = nullif(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  );

ALTER TABLE document_batch_jobs
  ADD COLUMN IF NOT EXISTS archived_at timestamptz NULL;
ALTER TABLE document_batch_jobs
  ADD COLUMN IF NOT EXISTS archived_by integer NULL REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE document_batch_jobs
  ADD COLUMN IF NOT EXISTS archived_reason text NULL;

CREATE INDEX IF NOT EXISTS idx_document_batch_jobs_archived
  ON document_batch_jobs (firm_id, archived_at DESC);

ALTER TABLE document_extraction_jobs
  ADD COLUMN IF NOT EXISTS archived_at timestamptz NULL;
ALTER TABLE document_extraction_jobs
  ADD COLUMN IF NOT EXISTS archived_by integer NULL REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE document_extraction_jobs
  ADD COLUMN IF NOT EXISTS archived_reason text NULL;

CREATE INDEX IF NOT EXISTS idx_document_extraction_jobs_archived
  ON document_extraction_jobs (firm_id, archived_at DESC);

