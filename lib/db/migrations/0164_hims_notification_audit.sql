CREATE TABLE IF NOT EXISTS hims_notification_audit (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  case_id INTEGER,
  idempotency_key TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  target_user_id INTEGER,
  target_scope TEXT NOT NULL DEFAULT 'firm',
  payload_json JSONB,
  severity TEXT DEFAULT 'info',
  correlation_id TEXT,
  source_system TEXT NOT NULL DEFAULT 'HIMS',
  source_event_name TEXT,
  source_event_ref TEXT,
  notification_created BOOLEAN NOT NULL DEFAULT FALSE,
  notification_id INTEGER,
  deduplicated BOOLEAN NOT NULL DEFAULT FALSE,
  deduplicated_against_id INTEGER,
  delivery_count INTEGER NOT NULL DEFAULT 0,
  last_delivery_attempt_at TIMESTAMPTZ,
  last_delivery_error TEXT,
  actor_user_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS
  uq_hims_notif_audit_idem
  ON hims_notification_audit(firm_id, idempotency_key);

CREATE INDEX IF NOT EXISTS
  idx_hims_notif_audit_firm
  ON hims_notification_audit(firm_id);

CREATE INDEX IF NOT EXISTS
  idx_hims_notif_audit_firm_case
  ON hims_notification_audit(firm_id, case_id);

ALTER TABLE hims_notification_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hims_notification_audit_tenant_isolation ON hims_notification_audit;

CREATE POLICY hims_notification_audit_tenant_isolation
ON hims_notification_audit
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
    PERFORM app_firms.enforce_company_id_v2('hims_notification_audit'::regclass);
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;
