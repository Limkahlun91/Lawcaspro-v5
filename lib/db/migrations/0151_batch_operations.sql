-- -----------------------------------------------------------------------------
-- 0151_batch_operations.sql
-- Unified batch operation audit table for cases.batch_update / cases.batch_print
-- and any future batch actions. Firm-scoped, RLS-protected, per-item error log
-- stored in item_errors JSONB; no personal data beyond already in audit_logs.
--
-- Backward compatible: additive only; no drops; existing data untouched.
-- -----------------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS batch_operations (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_type TEXT NOT NULL DEFAULT 'firm_user',
  operation_type TEXT NOT NULL, -- 'cases.batch_update' | 'cases.batch_print'
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status = ANY (ARRAY['queued','running','completed','partial_failure','failed'])),
  requested_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB NOT NULL DEFAULT '{}'::jsonb,
  item_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  ip_address TEXT,
  user_agent TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE batch_operations IS 'Batch operation execution records (update / print). Per-item errors stored in item_errors JSONB. Firm-scoped, RLS protected.';
COMMENT ON COLUMN batch_operations.operation_type IS 'cases.batch_update | cases.batch_print | future operation codes';
COMMENT ON COLUMN batch_operations.counts IS '{requested, succeeded, skipped, failed}';
COMMENT ON COLUMN batch_operations.payload IS 'User-selected batched fields / modes / document filters / output mode';
COMMENT ON COLUMN batch_operations.output IS 'Prepared download objectPath, jobId, combined output metadata';
COMMENT ON COLUMN batch_operations.item_errors IS 'Array of per-caseId failures: [{caseId, kind, reason, code}]';

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_batch_operations_firm
  ON batch_operations(firm_id);
CREATE INDEX IF NOT EXISTS idx_batch_operations_firm_type_created
  ON batch_operations(firm_id, operation_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_batch_operations_user_created
  ON batch_operations(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_batch_operations_status
  ON batch_operations(status);

-- -----------------------------------------------------------------------------
-- updated_at trigger
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_batch_operations_updated_at ON batch_operations;

CREATE OR REPLACE FUNCTION set_batch_operations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_batch_operations_updated_at
BEFORE UPDATE ON batch_operations
FOR EACH ROW EXECUTE FUNCTION set_batch_operations_updated_at();

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
ALTER TABLE batch_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_operations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS batch_operations_firm_select ON batch_operations;
CREATE POLICY batch_operations_firm_select ON batch_operations
  FOR SELECT TO PUBLIC USING (firm_id = current_setting('app.current_firm_id', TRUE)::INTEGER);

DROP POLICY IF EXISTS batch_operations_firm_insert ON batch_operations;
CREATE POLICY batch_operations_firm_insert ON batch_operations
  FOR INSERT TO PUBLIC WITH CHECK (firm_id = current_setting('app.current_firm_id', TRUE)::INTEGER);

DROP POLICY IF EXISTS batch_operations_firm_update ON batch_operations;
CREATE POLICY batch_operations_firm_update ON batch_operations
  FOR UPDATE TO PUBLIC USING (firm_id = current_setting('app.current_firm_id', TRUE)::INTEGER)
  WITH CHECK (firm_id = current_setting('app.current_firm_id', TRUE)::INTEGER);

GRANT SELECT, INSERT, UPDATE ON batch_operations TO app_user;

COMMIT;
