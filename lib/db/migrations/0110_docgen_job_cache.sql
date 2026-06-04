ALTER TABLE document_generation_jobs
  ADD COLUMN IF NOT EXISTS job_cache jsonb;

ALTER TABLE document_generation_jobs
  ALTER COLUMN job_cache SET DEFAULT '{}'::jsonb;

UPDATE document_generation_jobs
  SET job_cache = '{}'::jsonb
  WHERE job_cache IS NULL;

ALTER TABLE document_generation_jobs
  ALTER COLUMN job_cache SET NOT NULL;
