ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS apdl_price numeric(15, 2),
  ADD COLUMN IF NOT EXISTS developer_discount numeric(15, 2),
  ADD COLUMN IF NOT EXISTS bumiputra_discount numeric(15, 2);

ALTER TABLE cases
  ALTER COLUMN property_details TYPE jsonb
  USING (
    CASE
      WHEN property_details IS NULL THEN NULL
      WHEN btrim(property_details) = '' THEN NULL
      ELSE property_details::jsonb
    END
  );

ALTER TABLE cases
  ALTER COLUMN loan_details TYPE jsonb
  USING (
    CASE
      WHEN loan_details IS NULL THEN NULL
      WHEN btrim(loan_details) = '' THEN NULL
      ELSE loan_details::jsonb
    END
  );

ALTER TABLE cases
  DROP CONSTRAINT IF EXISTS chk_cases_spa_price_from_apdl;

ALTER TABLE cases
  ADD CONSTRAINT chk_cases_spa_price_from_apdl CHECK (
    apdl_price IS NULL
    OR (
      spa_price IS NOT NULL
      AND spa_price = (apdl_price - COALESCE(developer_discount, 0) - COALESCE(bumiputra_discount, 0))
    )
  );
