ALTER TABLE cases
ADD COLUMN IF NOT EXISTS is_encumbered boolean NOT NULL DEFAULT false;

ALTER TABLE cases
ADD COLUMN IF NOT EXISTS tenure text NOT NULL DEFAULT 'freehold';

ALTER TABLE cases
DROP CONSTRAINT IF EXISTS cases_title_type_check;

ALTER TABLE cases
ADD CONSTRAINT cases_title_type_check
CHECK (title_type IN ('master', 'individual', 'strata'));

ALTER TABLE cases
DROP CONSTRAINT IF EXISTS cases_tenure_check;

ALTER TABLE cases
ADD CONSTRAINT cases_tenure_check
CHECK (tenure IN ('freehold', 'leasehold'));

