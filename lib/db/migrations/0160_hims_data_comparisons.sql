-- 0160: HIMS Data Comparisons (PART3 3G part 2)
-- hims_data_comparisons: per-field 3-way (Lawcaspro vs HIMS vs e-KYC) value comparison.
-- Firm-scoped. Idempotent. RLS protected.

BEGIN;

CREATE TABLE IF NOT EXISTS hims_data_comparisons (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  case_id INTEGER,
  status_check_id INTEGER REFERENCES hims_status_checks(id) ON DELETE SET NULL,
  field_group_name TEXT,
  field TEXT NOT NULL,
  field_label TEXT,
  lawcaspro_value TEXT,
  hims_value TEXT,
  ekyc_value TEXT,
  status TEXT NOT NULL
    CONSTRAINT chk_hims_comp_status CHECK (status IN ('match','mismatch','missing')),
  mismatch_severity TEXT DEFAULT 'warning',
  resolution_status TEXT DEFAULT 'unresolved',
  resolved_by_user_id INTEGER,
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  idempotency_key TEXT,
  compared_by_user_id INTEGER,
  compared_at TIMESTAMPTZ,
  comparison_run_id TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE hims_data_comparisons IS 'Per-case, per-field 3-way comparison: Lawcaspro vs HIMS portal vs e-KYC. Status = match | mismatch | missing. Drives reconciliation queue UI.';
COMMENT ON COLUMN hims_data_comparisons.status IS 'match = all 3 sources agree; mismatch = disagreement; missing = >=1 source has no value';
COMMENT ON COLUMN hims_data_comparisons.mismatch_severity IS 'info | warning | critical | blocker';
COMMENT ON COLUMN hims_data_comparisons.resolution_status IS 'unresolved | reviewed | accepted_mismatch | overwritten_lawcaspro | escalated | closed';
COMMENT ON COLUMN hims_data_comparisons.field_group_name IS 'e.g. borrower_info, property_info, loan_info, parties_info - grouping bucket for UI';
COMMENT ON COLUMN hims_data_comparisons.comparison_run_id IS 'Shared run identifier grouping all field comparisons produced by the same reconciliation pass.';

CREATE INDEX IF NOT EXISTS idx_hims_comp_firm
  ON hims_data_comparisons(firm_id);
CREATE INDEX IF NOT EXISTS idx_hims_comp_firm_case
  ON hims_data_comparisons(firm_id, case_id);
CREATE INDEX IF NOT EXISTS idx_hims_comp_firm_status
  ON hims_data_comparisons(firm_id, status);
CREATE INDEX IF NOT EXISTS idx_hims_comp_firm_resolution
  ON hims_data_comparisons(firm_id, resolution_status);
CREATE INDEX IF NOT EXISTS idx_hims_comp_firm_field
  ON hims_data_comparisons(firm_id, field);
CREATE INDEX IF NOT EXISTS idx_hims_comp_firm_run
  ON hims_data_comparisons(firm_id, comparison_run_id);
CREATE INDEX IF NOT EXISTS idx_hims_comp_firm_scheck
  ON hims_data_comparisons(firm_id, status_check_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hims_comp_idempotency
  ON hims_data_comparisons(firm_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- -----------------------------------------------------------------------------
-- updated_at trigger
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_hims_data_comparisons_updated_at ON hims_data_comparisons;

CREATE OR REPLACE FUNCTION set_hims_data_comparisons_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_hims_data_comparisons_updated_at
BEFORE UPDATE ON hims_data_comparisons
FOR EACH ROW EXECUTE FUNCTION set_hims_data_comparisons_updated_at();

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
ALTER TABLE hims_data_comparisons ENABLE ROW LEVEL SECURITY;
ALTER TABLE hims_data_comparisons FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hims_comp_firm_select ON hims_data_comparisons;
CREATE POLICY hims_comp_firm_select ON hims_data_comparisons
  FOR SELECT TO PUBLIC USING (firm_id = current_setting('app.current_firm_id', TRUE)::INTEGER);

DROP POLICY IF EXISTS hims_comp_firm_insert ON hims_data_comparisons;
CREATE POLICY hims_comp_firm_insert ON hims_data_comparisons
  FOR INSERT TO PUBLIC WITH CHECK (firm_id = current_setting('app.current_firm_id', TRUE)::INTEGER);

DROP POLICY IF EXISTS hims_comp_firm_update ON hims_data_comparisons;
CREATE POLICY hims_comp_firm_update ON hims_data_comparisons
  FOR UPDATE TO PUBLIC USING (firm_id = current_setting('app.current_firm_id', TRUE)::INTEGER)
  WITH CHECK (firm_id = current_setting('app.current_firm_id', TRUE)::INTEGER);

DO $$ BEGIN
  PERFORM 1
   WHERE EXISTS (
     SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'app_firms' AND table_name = 'rls_firms'
   )
     AND EXISTS (
       SELECT 1 FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app_firms' AND p.proname = 'enforce_company_id_v2'
     );
  IF FOUND THEN
    DROP POLICY IF EXISTS hims_comp_company_rls ON hims_data_comparisons;
    PERFORM app_firms.enforce_company_id_v2('hims_data_comparisons', 'firm_id');
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON hims_data_comparisons TO app_user;

COMMIT;
