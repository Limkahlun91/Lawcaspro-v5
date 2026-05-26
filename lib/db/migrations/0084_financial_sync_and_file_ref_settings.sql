ALTER TABLE users
  ADD COLUMN IF NOT EXISTS initials varchar(5);

CREATE TABLE IF NOT EXISTS firm_file_ref_settings (
  id bigserial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  case_type text NOT NULL,
  format_pattern text NOT NULL,
  current_sequence integer NOT NULL DEFAULT 0,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT firm_file_ref_settings_firm_case_type_key UNIQUE (firm_id, case_type)
);

CREATE INDEX IF NOT EXISTS idx_firm_file_ref_settings_firm
  ON firm_file_ref_settings (firm_id);

ALTER TABLE firm_file_ref_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE firm_file_ref_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON firm_file_ref_settings;
CREATE POLICY tenant_isolation ON firm_file_ref_settings FOR ALL TO PUBLIC
  USING (firm_id = nullif(current_setting('app.current_firm_id', true), '')::int)
  WITH CHECK (firm_id = nullif(current_setting('app.current_firm_id', true), '')::int);

ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS amount_paid numeric(18, 2) NOT NULL DEFAULT '0';

ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS outstanding_balance numeric(18, 2) NOT NULL DEFAULT '0';

CREATE INDEX IF NOT EXISTS idx_cases_firm_outstanding_balance
  ON cases (firm_id, outstanding_balance);

