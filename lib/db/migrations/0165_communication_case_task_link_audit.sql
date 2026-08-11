CREATE TABLE IF NOT EXISTS communication_case_task_link_audit (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  case_task_id INTEGER,
  case_id INTEGER NOT NULL,
  action_type TEXT NOT NULL DEFAULT 'LINK_TASK',
  before_assigned_to_user_id INTEGER,
  after_assigned_to_user_id INTEGER,
  before_task_status TEXT,
  after_task_status TEXT,
  before_required_action TEXT,
  after_required_action TEXT,
  before_due_at TIMESTAMPTZ,
  after_due_at TIMESTAMPTZ,
  read_toggled_on_message BOOLEAN NOT NULL DEFAULT FALSE,
  idempotency_key TEXT,
  actor_user_id INTEGER,
  actor_role TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS
  uq_comm_task_link_audit_idem
  ON communication_case_task_link_audit(firm_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS
  idx_comm_task_link_audit_firm
  ON communication_case_task_link_audit(firm_id);

CREATE INDEX IF NOT EXISTS
  idx_comm_task_link_audit_msg
  ON communication_case_task_link_audit(firm_id, message_id);

CREATE INDEX IF NOT EXISTS
  idx_comm_task_link_audit_case
  ON communication_case_task_link_audit(firm_id, case_id);

ALTER TABLE communication_case_task_link_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS communication_case_task_link_audit_tenant_isolation ON communication_case_task_link_audit;

CREATE POLICY communication_case_task_link_audit_tenant_isolation
ON communication_case_task_link_audit
FOR ALL
USING (
  firm_id =
  NULLIF(
    current_setting(
      'app.current_firm_id',
      true
    ),
    ''
  )::INTEGER
)
WITH CHECK (
  firm_id =
  NULLIF(
    current_setting(
      'app.current_firm_id',
      true
    ),
    ''
  )::INTEGER
);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_company_id_v2') THEN
    PERFORM app_firms.enforce_company_id_v2('communication_case_task_link_audit'::regclass);
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;
