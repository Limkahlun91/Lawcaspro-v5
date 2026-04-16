-- Document Engine P11: Document extraction jobs/results/suggestions (safe suggestion mode)

CREATE TABLE IF NOT EXISTS document_extraction_jobs (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  case_id integer NOT NULL,
  case_document_id integer NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  extraction_method text,
  document_type_guess text,
  created_by integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error_message text
);

CREATE INDEX IF NOT EXISTS idx_document_extraction_jobs_case
  ON document_extraction_jobs (firm_id, case_id, case_document_id, created_at DESC);

CREATE TABLE IF NOT EXISTS document_extraction_results (
  id serial PRIMARY KEY,
  job_id integer NOT NULL REFERENCES document_extraction_jobs(id) ON DELETE CASCADE,
  raw_text text,
  structured_result_json jsonb,
  warnings jsonb,
  confidence_summary jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_extraction_results_job
  ON document_extraction_results (job_id);

CREATE TABLE IF NOT EXISTS document_extraction_suggestions (
  id serial PRIMARY KEY,
  job_id integer NOT NULL REFERENCES document_extraction_jobs(id) ON DELETE CASCADE,
  field_key text NOT NULL,
  suggested_value text,
  confidence numeric(5,4),
  source_page integer,
  source_snippet text,
  document_type_guess text,
  target_entity_type text,
  target_entity_id integer,
  accepted_by integer,
  accepted_at timestamptz,
  rejected_by integer,
  rejected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_extraction_suggestions_job
  ON document_extraction_suggestions (job_id);

