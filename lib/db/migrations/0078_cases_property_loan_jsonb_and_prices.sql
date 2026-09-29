ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS apdl_price numeric(15, 2),
  ADD COLUMN IF NOT EXISTS developer_discount numeric(15, 2),
  ADD COLUMN IF NOT EXISTS bumiputra_discount numeric(15, 2);

CREATE OR REPLACE FUNCTION safe_jsonb(input_text text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
BEGIN
  BEGIN
    RETURN input_text::jsonb;
  EXCEPTION WHEN others THEN
    RETURN jsonb_build_object('raw', input_text);
  END;
END
$fn$;

DO $do$
DECLARE
  property_type text;
  loan_type text;
BEGIN
  SELECT data_type
  INTO property_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'cases'
    AND column_name = 'property_details';

  IF property_type IS NOT NULL AND property_type <> 'jsonb' THEN
    EXECUTE $sql$
      ALTER TABLE cases
        ALTER COLUMN property_details TYPE jsonb
        USING (
          CASE
            WHEN property_details IS NULL THEN NULL
            WHEN btrim(property_details::text) = '' THEN NULL
            ELSE safe_jsonb(property_details::text)
          END
        )
    $sql$;
  END IF;

  SELECT data_type
  INTO loan_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'cases'
    AND column_name = 'loan_details';

  IF loan_type IS NOT NULL AND loan_type <> 'jsonb' THEN
    EXECUTE $sql$
      ALTER TABLE cases
        ALTER COLUMN loan_details TYPE jsonb
        USING (
          CASE
            WHEN loan_details IS NULL THEN NULL
            WHEN btrim(loan_details::text) = '' THEN NULL
            ELSE safe_jsonb(loan_details::text)
          END
        )
    $sql$;
  END IF;
END
$do$;

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
