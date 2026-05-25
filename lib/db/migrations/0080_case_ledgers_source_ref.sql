ALTER TABLE case_ledgers
  ADD COLUMN IF NOT EXISTS source_type text,
  ADD COLUMN IF NOT EXISTS source_id integer;

CREATE INDEX IF NOT EXISTS idx_case_ledgers_source
  ON case_ledgers (firm_id, case_id, source_type, source_id);

