-- 0157: Bank Export Adapters (PART3 3C)
-- Platform catalog of bank statement export/import adapters.
-- Seeded with 6 MY banks: Maybank / CIMB / OCBC / Public / RHB / HLB (all status='Upcoming').
-- Reference table (NOT firm-scoped). Additive, idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS bank_export_adapters (
  id SERIAL PRIMARY KEY,
  adapter_code TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  bank_short_code TEXT,
  status TEXT NOT NULL DEFAULT 'Upcoming',
  adapter_type TEXT NOT NULL DEFAULT 'statement_csv',
  version TEXT NOT NULL DEFAULT '1.0.0',
  description TEXT,
  supported_file_types JSONB NOT NULL DEFAULT '[]'::jsonb,
  parser_config_json JSONB,
  column_mapping_json JSONB,
  date_format TEXT,
  amount_format TEXT,
  encoding TEXT DEFAULT 'utf-8',
  has_header_row BOOLEAN NOT NULL DEFAULT TRUE,
  header_row_count INTEGER NOT NULL DEFAULT 1,
  skip_footer_rows INTEGER NOT NULL DEFAULT 0,
  delimiter TEXT,
  requires_balance_column BOOLEAN NOT NULL DEFAULT FALSE,
  auto_detect_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  validation_rules_json JSONB,
  transform_pipeline_json JSONB,
  documentation_url TEXT,
  released_at TIMESTAMPTZ,
  deprecated_at TIMESTAMPTZ,
  successor_adapter_id INTEGER REFERENCES bank_export_adapters(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_visible BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE bank_export_adapters IS 'Platform catalog of bank statement export / CSV import adapters. Each adapter defines column mapping, parser config and validation rules for a specific bank''s statement format.';
COMMENT ON COLUMN bank_export_adapters.status IS 'Upcoming | Beta | Active | Deprecated | Disabled';
COMMENT ON COLUMN bank_export_adapters.adapter_type IS 'statement_csv | mt940 | ofx | qif | custom_api';

CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_export_adapters_code
  ON bank_export_adapters(adapter_code);
CREATE INDEX IF NOT EXISTS idx_bank_export_adapters_status
  ON bank_export_adapters(status);
CREATE INDEX IF NOT EXISTS idx_bank_export_adapters_visible
  ON bank_export_adapters(is_visible, sort_order);

-- -----------------------------------------------------------------------------
-- updated_at trigger
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_bank_export_adapters_updated_at ON bank_export_adapters;

CREATE OR REPLACE FUNCTION set_bank_export_adapters_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_bank_export_adapters_updated_at
BEFORE UPDATE ON bank_export_adapters
FOR EACH ROW EXECUTE FUNCTION set_bank_export_adapters_updated_at();

-- -----------------------------------------------------------------------------
-- Seed 6 initial bank adapters (all status='Upcoming'). Idempotent via adapter_code.
-- -----------------------------------------------------------------------------
INSERT INTO bank_export_adapters (
  adapter_code, bank_name, bank_short_code, status, adapter_type, version,
  description, supported_file_types, date_format, amount_format, encoding,
  has_header_row, header_row_count, delimiter, sort_order, is_visible
) VALUES
  (
    'maybank_m2u_csv', 'Maybank', 'MBB', 'Upcoming', 'statement_csv', '1.0.0',
    'Maybank2u current/savings account CSV statement export adapter',
    '["csv","txt"]'::jsonb, 'DD/MM/YYYY', 'MYR_2DP_COMMA_THOUSANDS', 'utf-8',
    TRUE, 8, ',', 10, TRUE
  ),
  (
    'cimb_clicks_csv', 'CIMB Bank', 'CIMB', 'Upcoming', 'statement_csv', '1.0.0',
    'CIMB Clicks current/savings account CSV statement export adapter',
    '["csv"]'::jsonb, 'DD/MM/YYYY', 'MYR_2DP_SIGNED', 'utf-8',
    TRUE, 6, ',', 20, TRUE
  ),
  (
    'ocbc_pcbc_csv', 'OCBC Bank', 'OCBC', 'Upcoming', 'statement_csv', '1.0.0',
    'OCBC Personal Banking / PCBC CSV statement export adapter',
    '["csv"]'::jsonb, 'YYYY-MM-DD', 'MYR_2DP_COMMA_THOUSANDS', 'utf-8',
    TRUE, 5, ',', 30, TRUE
  ),
  (
    'public_pbb_csv', 'Public Bank', 'PBB', 'Upcoming', 'statement_csv', '1.0.0',
    'Public Bank PBB online CSV statement export adapter',
    '["csv","txt"]'::jsonb, 'DD/MM/YYYY', 'MYR_2DP_DRCR_COLUMN', 'utf-8',
    TRUE, 7, ',', 40, TRUE
  ),
  (
    'rhb_now_csv', 'RHB Bank', 'RHB', 'Upcoming', 'statement_csv', '1.0.0',
    'RHB Now / RHB Reflex CSV statement export adapter',
    '["csv"]'::jsonb, 'DD/MM/YYYY', 'MYR_2DP_COMMA_THOUSANDS', 'utf-8',
    TRUE, 6, ',', 50, TRUE
  ),
  (
    'hlb_connect_csv', 'Hong Leong Bank', 'HLB', 'Upcoming', 'statement_csv', '1.0.0',
    'Hong Leong Connect CSV statement export adapter',
    '["csv"]'::jsonb, 'DD/MM/YYYY', 'MYR_2DP_SIGNED_PARENS', 'utf-8',
    TRUE, 6, ',', 60, TRUE
  )
ON CONFLICT (adapter_code) DO NOTHING;

-- Platform catalog: grants to app_user read-only (admins manage via platform_ops)
GRANT SELECT ON bank_export_adapters TO app_user;

COMMIT;
