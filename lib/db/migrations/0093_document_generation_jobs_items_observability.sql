ALTER TABLE document_generation_jobs
  ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz;

ALTER TABLE document_generation_jobs
  ADD COLUMN IF NOT EXISTS timeout_at timestamptz;

ALTER TABLE document_generation_jobs
  ADD COLUMN IF NOT EXISTS error_code text;

ALTER TABLE document_generation_jobs
  ADD COLUMN IF NOT EXISTS runner_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE document_generation_jobs
  ADD COLUMN IF NOT EXISTS recovered_at timestamptz;

ALTER TABLE document_generation_job_items
  ADD COLUMN IF NOT EXISTS started_at timestamptz;

ALTER TABLE document_generation_job_items
  ADD COLUMN IF NOT EXISTS phase text;

ALTER TABLE document_generation_job_items
  ADD COLUMN IF NOT EXISTS template_version_id integer;

ALTER TABLE document_generation_job_items
  ADD COLUMN IF NOT EXISTS output_checksum text;

ALTER TABLE document_generation_job_items
  ADD COLUMN IF NOT EXISTS diagnostic jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_document_generation_jobs_heartbeat ON document_generation_jobs (firm_id, last_heartbeat_at);

CREATE INDEX IF NOT EXISTS idx_document_generation_job_items_started ON document_generation_job_items (firm_id, status, started_at);

