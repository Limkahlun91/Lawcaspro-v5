-- Quotations: per-client name + TIN pairs

ALTER TABLE quotations
  ADD COLUMN IF NOT EXISTS client_details jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE quotations
SET client_details = jsonb_build_array(
  jsonb_build_object(
    'name', client_name,
    'tin', client_tin
  )
)
WHERE (client_details IS NULL OR client_details = '[]'::jsonb)
  AND client_name IS NOT NULL;

