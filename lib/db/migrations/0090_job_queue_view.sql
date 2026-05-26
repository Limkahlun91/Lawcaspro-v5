CREATE OR REPLACE VIEW job_queue AS
SELECT
  id AS job_id,
  firm_id,
  job_type,
  status,
  action,
  config AS payload,
  created_by,
  created_at,
  started_at,
  finished_at,
  error_summary,
  download_object_path,
  download_file_name,
  download_mime_type
FROM document_generation_jobs;

