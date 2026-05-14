ALTER TABLE quotations
  DROP COLUMN IF EXISTS st_no,
  ADD COLUMN IF NOT EXISTS client_address text,
  ADD COLUMN IF NOT EXISTS client_tin text,
  ADD COLUMN IF NOT EXISTS tax_rate numeric(5,2) NOT NULL DEFAULT '8';

