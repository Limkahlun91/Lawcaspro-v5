-- 0159: HIMS Status Checks (PART3 3G part 1)
-- hims_status_checks: per-case HIMS portal status polling snapshots.
-- Firm-scoped. Idempotency key format: HIMS_STATUS:{caseId}:{status}
-- RLS protected. Additive only.

BEGIN;

CREATE TABLE IF NOT EXISTS hims_status_checks (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  case_id INTEGER,
  developer_id INTEGER,
  project_id INTEGER,
  phase TEXT,
  unit_lot TEXT,
  last_checked_at TIMESTAMPTZ,
  last_successful_at TIMESTAMPTZ,
  last_status TEXT,
  last_status_code TEXT,
  last_status_description TEXT,
  source_snapshot_hash TEXT,
  source_snapshot_json JSONB,
  check_initiator TEXT DEFAULT 'scheduled',
  connection_id INTEGER,
  idempotency_key TEXT,
  check_duration_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 1,
  last_error_code TEXT,
  last_error_message TEXT,
  next_scheduled_check_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE hims_status_checks IS 'Per-case HIMS portal status polling records. idempotency_key convention: HIMS_STATUS:{caseId}:{status} (dedupes identical status pushes from HIMS webhooks / scheduled polls).';
COMMENT ON COLUMN hims_status_checks.last_status IS 'HIMS source status name e.g. ''Booking Approved'', ''SPA Signing'', ''Loan Disbursed'' etc.';
COMMENT ON COLUMN hims_status_checks.source_snapshot_hash IS 'SHA-256 of source_snapshot_json; used to skip no-op updates when HIMS returns identical payload.';
COMMENT ON COLUMN hims_status_checks.check_initiator IS 'scheduled | manual | webhook | adhoc_reconciliation';

CREATE INDEX IF NOT EXISTS idx_hims_checks_firm
  ON hims_status_checks(firm_id);
CREATE INDEX IF NOT EXISTS idx_hims_checks_firm_case
  ON hims_status_checks(firm_id, case_id, last_checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_hims_checks_firm_dev
  ON hims_status_checks(firm_id, developer_id);
CREATE INDEX IF NOT EXISTS idx_hims_checks_firm_project
  ON hims_status_checks(firm_id, project_id, phase, unit_lot);
CREATE INDEX IF NOT EXISTS idx_hims_checks_firm_status
  ON hims_status_checks(firm_id, last_status);
CREATE INDEX IF NOT EXISTS idx_hims_checks_next_scheduled
  ON hims_status_checks(firm_id, next_scheduled_check_at)
  WHERE next_scheduled_check_at IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_hims_checks_idempotency
  ON hims_status_checks(firm_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- -----------------------------------------------------------------------------
-- updated_at trigger
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_hims_status_checks_updated_at ON hims_status_checks;

CREATE OR REPLACE FUNCTION set_hims_status_checks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_hims_status_checks_updated_at
BEFORE UPDATE ON hims_status_checks
FOR EACH ROW EXECUTE FUNCTION set_hims_status_checks_updated_at();

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
ALTER TABLE hims_status_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE hims_status_checks FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hims_status_checks_firm_select ON hims_status_checks;
CREATE POLICY hims_status_checks_firm_select ON hims_status_checks
  FOR SELECT TO PUBLIC USING (firm_id = current_setting('app.current_firm_id', TRUE)::INTEGER);

DROP POLICY IF EXISTS hims_status_checks_firm_insert ON hims_status_checks;
CREATE POLICY hims_status_checks_firm_insert ON hims_status_checks
  FOR INSERT TO PUBLIC WITH CHECK (firm_id = current_setting('app.current_firm_id', TRUE)::INTEGER);

DROP POLICY IF EXISTS hims_status_checks_firm_update ON hims_status_checks;
CREATE POLICY hims_status_checks_firm_update ON hims_status_checks
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
    DROP POLICY IF EXISTS hims_status_checks_company_rls ON hims_status_checks;
    PERFORM app_firms.enforce_company_id_v2('hims_status_checks', 'firm_id');
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON hims_status_checks TO app_user;

COMMIT;
