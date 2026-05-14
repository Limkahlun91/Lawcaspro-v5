ALTER TABLE firms
ADD COLUMN IF NOT EXISTS registration_no text,
ADD COLUMN IF NOT EXISTS sst_no text,
ADD COLUMN IF NOT EXISTS phone text,
ADD COLUMN IF NOT EXISTS email text;

UPDATE firms
SET sst_no = COALESCE(sst_no, st_number)
WHERE (sst_no IS NULL OR sst_no = '')
  AND st_number IS NOT NULL
  AND st_number <> '';

