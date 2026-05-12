ALTER TABLE projects
ADD COLUMN IF NOT EXISTS is_encumbered boolean NOT NULL DEFAULT false;

ALTER TABLE projects
ADD COLUMN IF NOT EXISTS tenure text NOT NULL DEFAULT 'freehold';

ALTER TABLE projects
ADD COLUMN IF NOT EXISTS master_chargee_bank text;

ALTER TABLE projects
DROP CONSTRAINT IF EXISTS projects_title_type_check;

ALTER TABLE projects
ADD CONSTRAINT projects_title_type_check
CHECK (title_type IN ('master', 'individual', 'strata'));

ALTER TABLE projects
DROP CONSTRAINT IF EXISTS projects_tenure_check;

ALTER TABLE projects
ADD CONSTRAINT projects_tenure_check
CHECK (tenure IN ('freehold', 'leasehold'));

