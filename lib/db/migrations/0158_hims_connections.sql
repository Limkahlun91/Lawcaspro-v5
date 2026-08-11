-- 0158: HIMS Connections (PART3 3D)
-- hims_connections: per-firm HIMS developer / lawyer portal connectivity records.
-- Firm-scoped. Credentials encrypted (encrypted_* TEXT columns). RLS protected.

BEGIN;

CREATE TABLE IF NOT EXISTS hims_connections (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  developer_id INTEGER,
  project_id INTEGER,
  display_name TEXT NOT NULL,
  credential_type TEXT NOT NULL
    CONSTRAINT chk_hims_conn_ctype CHECK (credential_type IN ('developer','lawyer')),
  status TEXT NOT NULL DEFAULT 'needs_attention'
    CONSTRAINT chk_hims_conn_status CHECK (status IN ('active','disabled','needs_attention')),
  hims_base_url TEXT,
  hims_tenant_code TEXT,
  hims_api_client_id TEXT,
  encrypted_hims_api_client_secret TEXT,
  encrypted_hims_username TEXT,
  encrypted_hims_password TEXT,
  encrypted_config_jsonb TEXT,
  token_expires_at TIMESTAMPTZ,
  last_tested_at TIMESTAMPTZ,
  last_test_result TEXT,
  last_connected_at TIMESTAMPTZ,
  last_error TEXT,
  last_error_at TIMESTAMPTZ,
  idempotency_key TEXT,
  created_by_user_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disabled_at TIMESTAMPTZ,
  disabled_by_user_id INTEGER,
  notes TEXT
);

COMMENT ON TABLE hims_connections IS 'HIMS (developer portal / lawyer portal) integration connections per firm. All credentials stored in encrypted_* TEXT columns (AES-GCM envelope). NO plaintext secrets.';
COMMENT ON COLUMN hims_connections.credential_type IS 'developer = developer portal HIMS; lawyer = lawyer council / e-lawyering HIMS';
COMMENT ON COLUMN hims_connections.status IS 'active = live; disabled = turned off by firm; needs_attention = auth error / rotation required';
COMMENT ON COLUMN hims_connections.encrypted_config_jsonb IS 'Encrypted JSON blob of advanced config: rate limits, pagination settings, custom endpoints, webhook secrets. Decrypt -> JSONB at runtime.';

CREATE INDEX IF NOT EXISTS idx_hims_connections_firm
  ON hims_connections(firm_id);
CREATE INDEX IF NOT EXISTS idx_hims_connections_firm_status
  ON hims_connections(firm_id, status);
CREATE INDEX IF NOT EXISTS idx_hims_connections_firm_developer
  ON hims_connections(firm_id, developer_id);
CREATE INDEX IF NOT EXISTS idx_hims_connections_firm_project
  ON hims_connections(firm_id, project_id);
CREATE INDEX IF NOT EXISTS idx_hims_connections_firm_ctype
  ON hims_connections(firm_id, credential_type);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hims_connections_idempotency
  ON hims_connections(firm_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- -----------------------------------------------------------------------------
-- updated_at trigger
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_hims_connections_updated_at ON hims_connections;

CREATE OR REPLACE FUNCTION set_hims_connections_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_hims_connections_updated_at
BEFORE UPDATE ON hims_connections
FOR EACH ROW EXECUTE FUNCTION set_hims_connections_updated_at();

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
ALTER TABLE hims_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE hims_connections FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hims_connections_firm_select ON hims_connections;
CREATE POLICY hims_connections_firm_select ON hims_connections
  FOR SELECT TO PUBLIC USING (firm_id = current_setting('app.current_firm_id', TRUE)::INTEGER);

DROP POLICY IF EXISTS hims_connections_firm_insert ON hims_connections;
CREATE POLICY hims_connections_firm_insert ON hims_connections
  FOR INSERT TO PUBLIC WITH CHECK (firm_id = current_setting('app.current_firm_id', TRUE)::INTEGER);

DROP POLICY IF EXISTS hims_connections_firm_update ON hims_connections;
CREATE POLICY hims_connections_firm_update ON hims_connections
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
    DROP POLICY IF EXISTS hims_connections_company_rls ON hims_connections;
    PERFORM app_firms.enforce_company_id_v2('hims_connections', 'firm_id');
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON hims_connections TO app_user;

COMMIT;
