DO $do$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $do$;

GRANT USAGE ON SCHEMA public TO app_user;

-- ============================================================
-- TABLE 1: legacy_case_import_batches
-- ============================================================

CREATE TABLE IF NOT EXISTS legacy_case_import_batches (
  id bigserial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  created_by integer NOT NULL,
  source_file_name text NOT NULL,
  source_file_hash text NOT NULL,
  source_sheet_name text,
  source_format text,
  mapping_template_id integer,
  header_fingerprint text,
  status text NOT NULL,
  options_json jsonb,
  total_rows integer NOT NULL DEFAULT 0,
  ready_rows integer NOT NULL DEFAULT 0,
  warning_rows integer NOT NULL DEFAULT 0,
  review_rows integer NOT NULL DEFAULT 0,
  duplicate_rows integer NOT NULL DEFAULT 0,
  imported_rows integer NOT NULL DEFAULT 0,
  failed_rows integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_legacy_case_import_batches_firm_status
  ON legacy_case_import_batches (firm_id, status);

CREATE INDEX IF NOT EXISTS idx_legacy_case_import_batches_created_by
  ON legacy_case_import_batches (created_by);

CREATE INDEX IF NOT EXISTS idx_legacy_case_import_batches_file_hash_firm
  ON legacy_case_import_batches (source_file_hash, firm_id);

ALTER TABLE legacy_case_import_batches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant ON legacy_case_import_batches;
CREATE POLICY tenant ON legacy_case_import_batches FOR ALL TO PUBLIC
  USING (firm_id = current_setting('app.current_firm_id', true)::integer)
  WITH CHECK (firm_id = current_setting('app.current_firm_id', true)::integer);

-- ============================================================
-- TABLE 2: legacy_case_import_rows
-- ============================================================

CREATE TABLE IF NOT EXISTS legacy_case_import_rows (
  id bigserial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  batch_id integer NOT NULL,
  source_row_no integer NOT NULL,
  source_row_hash text,
  source_reference text,
  raw_row_json jsonb,
  mapped_payload_json jsonb,
  validation_json jsonb,
  row_status text NOT NULL,
  idempotency_key text NOT NULL,
  duplicate_type text,
  duplicate_case_id integer,
  duplicate_score numeric,
  created_case_id integer,
  error_code text,
  error_message text,
  imported_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS legacy_case_import_rows_firm_batch_source_row_key
  ON legacy_case_import_rows (firm_id, batch_id, source_row_no);

CREATE UNIQUE INDEX IF NOT EXISTS legacy_case_import_rows_firm_idempotency_key_key
  ON legacy_case_import_rows (firm_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_legacy_case_import_rows_batch
  ON legacy_case_import_rows (batch_id);

CREATE INDEX IF NOT EXISTS idx_legacy_case_import_rows_status_firm
  ON legacy_case_import_rows (row_status, firm_id);

ALTER TABLE legacy_case_import_rows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant ON legacy_case_import_rows;
CREATE POLICY tenant ON legacy_case_import_rows FOR ALL TO PUBLIC
  USING (firm_id = current_setting('app.current_firm_id', true)::integer)
  WITH CHECK (firm_id = current_setting('app.current_firm_id', true)::integer);

-- ============================================================
-- TABLE 3: legacy_case_import_mapping_templates
-- ============================================================

CREATE TABLE IF NOT EXISTS legacy_case_import_mapping_templates (
  id bigserial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  name text NOT NULL,
  header_fingerprint text,
  source_sheet_name text,
  mapping_json jsonb NOT NULL,
  fixed_values_json jsonb,
  is_default boolean NOT NULL DEFAULT false,
  created_by integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS legacy_case_import_mapping_templates_firm_name_key
  ON legacy_case_import_mapping_templates (firm_id, name);

CREATE INDEX IF NOT EXISTS idx_legacy_case_import_mapping_tpl_firm_hfp
  ON legacy_case_import_mapping_templates (firm_id, header_fingerprint);

ALTER TABLE legacy_case_import_mapping_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant ON legacy_case_import_mapping_templates;
CREATE POLICY tenant ON legacy_case_import_mapping_templates FOR ALL TO PUBLIC
  USING (firm_id = current_setting('app.current_firm_id', true)::integer)
  WITH CHECK (firm_id = current_setting('app.current_firm_id', true)::integer);

-- ============================================================
-- GRANTS
-- ============================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_case_import_batches TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_case_import_rows TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON legacy_case_import_mapping_templates TO app_user;

DO $do$ BEGIN
  IF to_regclass('public.legacy_case_import_batches_id_seq') IS NOT NULL THEN
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.legacy_case_import_batches_id_seq TO app_user';
  END IF;
  IF to_regclass('public.legacy_case_import_rows_id_seq') IS NOT NULL THEN
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.legacy_case_import_rows_id_seq TO app_user';
  END IF;
  IF to_regclass('public.legacy_case_import_mapping_templates_id_seq') IS NOT NULL THEN
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.legacy_case_import_mapping_templates_id_seq TO app_user';
  END IF;
END $do$;
