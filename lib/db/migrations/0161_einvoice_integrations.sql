-- 0161: e-Invoice Integrations Adapter State Boundary (PART3 3C add-on)
-- einvoice_integrations: per-firm e-invoice provider configuration.
-- Firm-scoped. ALL secrets in encrypted_* TEXT columns.
-- NO hardcoded secrets from env vars at the DB layer.
-- Additive only, RLS protected, idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS einvoice_integrations (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  provider TEXT NOT NULL DEFAULT 'lhdn_myinvois',
  status TEXT NOT NULL DEFAULT 'not_configured'
    CONSTRAINT chk_einvoice_int_status CHECK (status IN ('active','not_configured','needs_attention')),
  display_name TEXT NOT NULL DEFAULT 'MyInvois (LHDN)',
  base_url TEXT,
  api_version TEXT DEFAULT 'v2024-06-01',
  tin TEXT,
  seller_id_type TEXT,
  seller_id_value TEXT,
  firm_msic_code TEXT,
  encrypted_credentials TEXT,
  encrypted_access_token TEXT,
  encrypted_refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  enable_auto_submit BOOLEAN NOT NULL DEFAULT FALSE,
  enable_auto_cancel BOOLEAN NOT NULL DEFAULT FALSE,
  enable_auto_validation BOOLEAN NOT NULL DEFAULT TRUE,
  enable_webhooks_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  webhook_secret_hash TEXT,
  auto_submit_cutoff_minutes INTEGER NOT NULL DEFAULT 1440,
  retry_max_attempts INTEGER NOT NULL DEFAULT 5,
  retry_backoff_seconds INTEGER NOT NULL DEFAULT 60,
  last_tested_at TIMESTAMPTZ,
  last_test_result TEXT,
  last_connected_at TIMESTAMPTZ,
  last_error TEXT,
  last_error_at TIMESTAMPTZ,
  idempotency_key TEXT,
  configured_by_user_id INTEGER,
  configured_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT
);

COMMENT ON TABLE einvoice_integrations IS 'Per-firm e-invoice provider integration records. All credentials/tokens/secrets stored in encrypted_* TEXT columns (AES-GCM envelope encryption). NO plaintext secrets. NO env-var-based secrets at DB boundary.';
COMMENT ON COLUMN einvoice_integrations.provider IS 'lhdn_myinvois | future providers';
COMMENT ON COLUMN einvoice_integrations.status IS 'active = live and validated; not_configured = initial state; needs_attention = auth failed / TIN mismatch / token rotation required';
COMMENT ON COLUMN einvoice_integrations.encrypted_credentials IS 'Encrypted JSON blob of provider-specific static credentials (client_id / client_secret / private_key PEM / API key etc). Decrypt at runtime.';
COMMENT ON COLUMN einvoice_integrations.webhook_secret_hash IS 'SHA-256 (or argon2id) hash of the webhook signing secret, NOT the plaintext secret.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_einvoice_int_firm_provider
  ON einvoice_integrations(firm_id, provider);

CREATE INDEX IF NOT EXISTS idx_einvoice_int_firm
  ON einvoice_integrations(firm_id);
CREATE INDEX IF NOT EXISTS idx_einvoice_int_firm_status
  ON einvoice_integrations(firm_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS uq_einvoice_int_idempotency
  ON einvoice_integrations(firm_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- -----------------------------------------------------------------------------
-- updated_at trigger
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_einvoice_integrations_updated_at ON einvoice_integrations;

CREATE OR REPLACE FUNCTION set_einvoice_integrations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_einvoice_integrations_updated_at
BEFORE UPDATE ON einvoice_integrations
FOR EACH ROW EXECUTE FUNCTION set_einvoice_integrations_updated_at();

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
ALTER TABLE einvoice_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE einvoice_integrations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS einvoice_int_firm_select ON einvoice_integrations;
CREATE POLICY einvoice_int_firm_select ON einvoice_integrations
  FOR SELECT TO PUBLIC USING (firm_id = current_setting('app.current_firm_id', TRUE)::INTEGER);

DROP POLICY IF EXISTS einvoice_int_firm_insert ON einvoice_integrations;
CREATE POLICY einvoice_int_firm_insert ON einvoice_integrations
  FOR INSERT TO PUBLIC WITH CHECK (firm_id = current_setting('app.current_firm_id', TRUE)::INTEGER);

DROP POLICY IF EXISTS einvoice_int_firm_update ON einvoice_integrations;
CREATE POLICY einvoice_int_firm_update ON einvoice_integrations
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
    DROP POLICY IF EXISTS einvoice_int_company_rls ON einvoice_integrations;
    PERFORM app_firms.enforce_company_id_v2('einvoice_integrations', 'firm_id');
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON einvoice_integrations TO app_user;

COMMIT;
