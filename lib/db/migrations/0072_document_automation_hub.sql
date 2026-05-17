ALTER TABLE document_templates
  ADD COLUMN IF NOT EXISTS category text;

CREATE INDEX IF NOT EXISTS idx_document_templates_firm_category
  ON document_templates (firm_id, category);

CREATE TABLE IF NOT EXISTS document_generation_logs (
  id bigserial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  case_id integer REFERENCES cases(id) ON DELETE SET NULL,
  action_type text NOT NULL,
  file_names jsonb NOT NULL DEFAULT '[]'::jsonb,
  copies_configured integer,
  print_settings jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_generation_logs_action_type_check CHECK (action_type IN ('download_zip','system_print'))
);

CREATE INDEX IF NOT EXISTS idx_document_generation_logs_firm_created_at
  ON document_generation_logs (firm_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_document_generation_logs_firm_case
  ON document_generation_logs (firm_id, case_id);

CREATE INDEX IF NOT EXISTS idx_document_generation_logs_firm_action
  ON document_generation_logs (firm_id, action_type);

CREATE TABLE IF NOT EXISTS document_generation_log_cases (
  id bigserial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  log_id bigint NOT NULL REFERENCES document_generation_logs(id) ON DELETE CASCADE,
  case_id integer NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_generation_log_cases_log_case_key UNIQUE (log_id, case_id)
);

CREATE INDEX IF NOT EXISTS idx_document_generation_log_cases_firm_log
  ON document_generation_log_cases (firm_id, log_id);

CREATE INDEX IF NOT EXISTS idx_document_generation_log_cases_firm_case
  ON document_generation_log_cases (firm_id, case_id);

