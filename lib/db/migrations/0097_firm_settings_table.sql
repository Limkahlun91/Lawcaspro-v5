CREATE TABLE IF NOT EXISTS firm_settings (
  firm_id integer PRIMARY KEY REFERENCES firms(id) ON DELETE CASCADE,
  use_master_documents boolean NOT NULL DEFAULT true,
  enable_firm_letterhead boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE firm_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE firm_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS firm_settings_rw ON firm_settings;

CREATE POLICY firm_settings_rw ON firm_settings FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

