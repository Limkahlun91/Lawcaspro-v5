ALTER TABLE document_generation_jobs
  ADD COLUMN IF NOT EXISTS platform_document_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE document_generation_jobs
  ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS timeout_at timestamptz,
  ADD COLUMN IF NOT EXISTS error_code text,
  ADD COLUMN IF NOT EXISTS runner_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recovered_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE document_generation_job_items
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS phase text,
  ADD COLUMN IF NOT EXISTS template_version_id integer,
  ADD COLUMN IF NOT EXISTS output_checksum text,
  ADD COLUMN IF NOT EXISTS diagnostic jsonb,
  ADD COLUMN IF NOT EXISTS template_source text NOT NULL DEFAULT 'firm',
  ADD COLUMN IF NOT EXISTS platform_document_id integer;

ALTER TABLE document_generation_job_items
  ALTER COLUMN template_id DROP NOT NULL;
