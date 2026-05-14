-- Dynamic borrowers list for loan tab (supports 1st-party mirror and 3rd-party custom borrowers)

ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS borrowers jsonb NOT NULL DEFAULT '[]'::jsonb;

