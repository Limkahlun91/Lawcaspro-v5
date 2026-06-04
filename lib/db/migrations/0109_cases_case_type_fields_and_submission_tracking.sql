-- 0109_cases_case_type_fields_and_submission_tracking.sql

ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS encumbrances text,
  ADD COLUMN IF NOT EXISTS submitted_by integer,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz;

UPDATE cases
SET case_type = 'developer_sales'
WHERE case_type IS NULL OR btrim(case_type) = '' OR lower(btrim(case_type)) IN (
  'primary market',
  'primary_market',
  'primarymarket',
  'developer sales',
  'developer_sales'
);

ALTER TABLE cases
  ALTER COLUMN case_type SET DEFAULT 'developer_sales';

UPDATE cases
SET case_type = 'developer_sales'
WHERE case_type IS NULL OR btrim(case_type) = '';

ALTER TABLE cases
  ALTER COLUMN case_type SET NOT NULL;

UPDATE cases
SET
  submitted_at = COALESCE(submitted_at, created_at, now()),
  submitted_by = COALESCE(submitted_by, created_by)
WHERE submitted_at IS NULL OR submitted_by IS NULL;

ALTER TABLE cases
  DROP CONSTRAINT IF EXISTS cases_encumbrances_check;

ALTER TABLE cases
  ADD CONSTRAINT cases_encumbrances_check
  CHECK (encumbrances IS NULL OR encumbrances IN ('no_encumbrance','has_encumbrance','to_confirm'));

CREATE UNIQUE INDEX IF NOT EXISTS cases_firm_reference_no_unique
  ON cases (firm_id, reference_no)
  WHERE reference_no IS NOT NULL;

