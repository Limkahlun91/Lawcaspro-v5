ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS file_listing_status text NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS file_listing_reason text;

CREATE INDEX IF NOT EXISTS idx_cases_firm_file_listing_status
  ON cases (firm_id, file_listing_status);

