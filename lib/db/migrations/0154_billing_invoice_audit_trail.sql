-- 0154: Invoice Audit Trail (append-only billing mutation record)
-- PART 3 §48: Billing workflow hardening + double-confirm audit

CREATE TABLE IF NOT EXISTS invoice_audit_trail (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  invoice_id INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  before_snapshot JSONB,
  after_snapshot JSONB,
  delta JSONB,
  amount_change NUMERIC(18, 2),
  status_before TEXT,
  status_after TEXT,
  actor_user_id INTEGER,
  actor_role TEXT,
  reauth_verified BOOLEAN NOT NULL DEFAULT FALSE,
  confirmation_token TEXT,
  client_request_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  error_code TEXT,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  receipt_id INTEGER,
  payment_method TEXT,
  bank_reference TEXT,
  paid_amount NUMERIC(18, 2),
  paid_date TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoice_audit_firm ON invoice_audit_trail (firm_id);
CREATE INDEX IF NOT EXISTS idx_invoice_audit_firm_invoice ON invoice_audit_trail (firm_id, invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_audit_firm_action ON invoice_audit_trail (firm_id, action_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoice_audit_firm_actor ON invoice_audit_trail (firm_id, actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoice_audit_created_at ON invoice_audit_trail (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoice_audit_client_request
  ON invoice_audit_trail (client_request_id)
  WHERE client_request_id IS NOT NULL;

ALTER TABLE invoice_audit_trail ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invoice_audit_trail_firm_isolation_policy ON invoice_audit_trail;
CREATE POLICY invoice_audit_trail_firm_isolation_policy
  ON invoice_audit_trail
  USING (firm_id = (current_setting('app.current_firm_id', true))::INTEGER);

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
    DROP POLICY IF EXISTS invoice_audit_trail_company_rls ON invoice_audit_trail;
    PERFORM app_firms.enforce_company_id_v2('invoice_audit_trail', 'firm_id');
  END IF;
END $$;
