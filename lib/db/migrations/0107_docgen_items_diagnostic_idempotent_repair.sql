ALTER TABLE document_generation_job_items
  ADD COLUMN IF NOT EXISTS diagnostic jsonb;

ALTER TABLE document_generation_job_items
  ALTER COLUMN diagnostic SET DEFAULT '{}'::jsonb;

UPDATE document_generation_job_items
  SET diagnostic = '{}'::jsonb
  WHERE diagnostic IS NULL;

ALTER TABLE document_generation_job_items
  ALTER COLUMN diagnostic SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_document_generation_jobs_heartbeat
  ON document_generation_jobs (firm_id, last_heartbeat_at);

CREATE INDEX IF NOT EXISTS idx_document_generation_job_items_started
  ON document_generation_job_items (firm_id, status, started_at);

