CREATE TABLE IF NOT EXISTS case_reference_history (
  id BIGSERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  previous_reference_no TEXT,
  new_reference_no TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK (change_type IN (
    'PROPOSED_TO_FINAL',
    'MANUAL_CHANGE',
    'REAPPROVAL_CHANGE',
    'SYSTEM_ASSIGNMENT',
    'BACKFILLED_FROM_CASE_SNAPSHOT'
  )),
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT,
  source TEXT NOT NULL CHECK (source IN (
    'APPROVAL',
    'CASE_EDIT',
    'SYSTEM',
    'BACKFILL'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  idempotency_key TEXT UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_case_reference_history_case_created
  ON case_reference_history (case_id, created_at);

CREATE INDEX IF NOT EXISTS idx_case_reference_history_firm
  ON case_reference_history (firm_id);

CREATE INDEX IF NOT EXISTS idx_case_reference_history_actor
  ON case_reference_history (actor_user_id);

ALTER TABLE case_reference_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_reference_history FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS case_reference_history_firm_rw ON case_reference_history;
CREATE POLICY case_reference_history_firm_rw
  ON case_reference_history
  FOR ALL
  TO PUBLIC
  USING (firm_id = current_setting('app.current_firm_id', true)::INTEGER)
  WITH CHECK (firm_id = current_setting('app.current_firm_id', true)::INTEGER);

CREATE OR REPLACE FUNCTION case_reference_history_immutable_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('app.case_reference_history_allow_mutation', true) = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'case_reference_history is append-only: UPDATE/DELETE not allowed';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_case_reference_history_immutable ON case_reference_history;

CREATE TRIGGER trg_case_reference_history_immutable
BEFORE UPDATE OR DELETE ON case_reference_history
FOR EACH ROW
EXECUTE FUNCTION case_reference_history_immutable_guard();
