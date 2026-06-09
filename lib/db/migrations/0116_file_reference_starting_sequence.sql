BEGIN;

ALTER TABLE firm_file_ref_settings
  ADD COLUMN IF NOT EXISTS starting_sequence integer;

UPDATE firm_file_ref_settings
SET starting_sequence = CASE
  WHEN current_sequence > 0 THEN current_sequence
  ELSE 1000
END
WHERE starting_sequence IS NULL;

ALTER TABLE firm_file_ref_settings
  ALTER COLUMN starting_sequence SET DEFAULT 1000;

ALTER TABLE firm_file_ref_settings
  ALTER COLUMN starting_sequence SET NOT NULL;

COMMIT;
