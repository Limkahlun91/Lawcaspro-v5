CREATE TABLE IF NOT EXISTS einvoice_submission_audit (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  invoice_id INTEGER NOT NULL,
  integration_id INTEGER,
  action_type TEXT NOT NULL DEFAULT 'SUBMIT',
  submission_status TEXT NOT NULL DEFAULT 'BOUNDARY_CHECK',
  boundary_passed BOOLEAN NOT NULL DEFAULT FALSE,
  boundary_error_code TEXT,
  boundary_error_message TEXT,
  provider TEXT,
  einvoice_integration_status TEXT,
  idempotency_key TEXT,
  submission_request_json JSONB,
  submission_response_json JSONB,
  external_submission_uid TEXT,
  external_einvoice_uuid TEXT,
  external_status_url TEXT,
  external_qr_code_data TEXT,
  request_sent_at TIMESTAMPTZ,
  response_received_at TIMESTAMPTZ,
  retry_attempt INTEGER NOT NULL DEFAULT 0,
  scheduled_retry_at TIMESTAMPTZ,
  actor_user_id INTEGER,
  actor_role TEXT,
  client_request_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  invoice_no_snapshot TEXT,
  grand_total_snapshot NUMERIC(20, 2),
  invoice_status_snapshot TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS
  uq_einvoice_sub_audit_idem
  ON einvoice_submission_audit(firm_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS
  idx_einvoice_sub_audit_firm
  ON einvoice_submission_audit(firm_id);

CREATE INDEX IF NOT EXISTS
  idx_einvoice_sub_audit_firm_invoice
  ON einvoice_submission_audit(firm_id, invoice_id);

CREATE INDEX IF NOT EXISTS
  idx_einvoice_sub_audit_firm_status
  ON einvoice_submission_audit(firm_id, submission_status, created_at);

ALTER TABLE einvoice_submission_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS einvoice_submission_audit_tenant_isolation ON einvoice_submission_audit;

CREATE POLICY einvoice_submission_audit_tenant_isolation
ON einvoice_submission_audit
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
    PERFORM app_firms.enforce_company_id_v2('einvoice_submission_audit'::regclass);
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;
