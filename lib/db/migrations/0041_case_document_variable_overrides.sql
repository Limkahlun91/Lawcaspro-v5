-- Case-level document variable overrides (persisted)

CREATE TABLE IF NOT EXISTS case_document_variable_overrides (
  firm_id integer NOT NULL,
  case_id integer NOT NULL,
  overrides_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by integer NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT pk_case_document_variable_overrides PRIMARY KEY (firm_id, case_id)
);

ALTER TABLE case_document_variable_overrides
  DROP CONSTRAINT IF EXISTS fk_case_document_variable_overrides_updated_by;
ALTER TABLE case_document_variable_overrides
  ADD CONSTRAINT fk_case_document_variable_overrides_updated_by
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_case_document_variable_overrides_case
  ON case_document_variable_overrides (firm_id, case_id);

ALTER TABLE case_document_variable_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_document_variable_overrides FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON case_document_variable_overrides;
CREATE POLICY tenant_isolation ON case_document_variable_overrides FOR ALL TO PUBLIC
  USING (firm_id = nullif(current_setting('app.current_firm_id', true), '')::int)
  WITH CHECK (firm_id = nullif(current_setting('app.current_firm_id', true), '')::int);

