-- PART 2B §9: HIMS DB parity. ADDITIVE only. No DROP / TRUNCATE.
-- Matches @workspace/db drizzle schema definitions in lib/db/src/schema/hims-*.ts + integration-audits.ts

-- ---------------------------------------------------------------------------
-- hims_connections
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.hims_connections (
  id                          SERIAL PRIMARY KEY,
  firm_id                     INTEGER NOT NULL,
  developer_id                INTEGER,
  project_id                  INTEGER,
  display_name                TEXT NOT NULL,
  credential_type             TEXT NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'needs_attention',
  hims_base_url               TEXT,
  hims_tenant_code            TEXT,
  hims_api_client_id          TEXT,
  encrypted_hims_api_client_secret   TEXT,
  encrypted_hims_username          TEXT,
  encrypted_hims_password         TEXT,
  encrypted_config_jsonb        TEXT,
  token_expires_at            TIMESTAMPTZ,
  last_tested_at              TIMESTAMPTZ,
  last_test_result            TEXT,
  last_connected_at           TIMESTAMPTZ,
  last_error                  TEXT,
  last_error_at               TIMESTAMPTZ,
  idempotency_key             TEXT,
  created_by_user_id          INTEGER,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disabled_at                 TIMESTAMPTZ,
  disabled_by_user_id         INTEGER,
  notes                       TEXT
);

CREATE INDEX IF NOT EXISTS idx_hims_connections_firm
  ON public.hims_connections (firm_id);
CREATE INDEX IF NOT EXISTS idx_hims_connections_firm_status
  ON public.hims_connections (firm_id, status);
CREATE INDEX IF NOT EXISTS idx_hims_connections_firm_developer
  ON public.hims_connections (firm_id, developer_id);
CREATE INDEX IF NOT EXISTS idx_hims_connections_firm_project
  ON public.hims_connections (firm_id, project_id);
CREATE INDEX IF NOT EXISTS idx_hims_connections_firm_ctype
  ON public.hims_connections (firm_id, credential_type);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hims_connections_idempotency
  ON public.hims_connections (firm_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- hims_status_checks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.hims_status_checks (
  id                      SERIAL PRIMARY KEY,
  firm_id                 INTEGER NOT NULL,
  case_id                 INTEGER,
  developer_id            INTEGER,
  project_id              INTEGER,
  phase                   TEXT,
  unit_lot                TEXT,
  last_checked_at         TIMESTAMPTZ,
  last_successful_at      TIMESTAMPTZ,
  last_status             TEXT,
  last_status_code        TEXT,
  last_status_description TEXT,
  source_snapshot_hash    TEXT,
  source_snapshot_json    JSONB,
  check_initiator         TEXT DEFAULT 'scheduled',
  connection_id           INTEGER,
  idempotency_key         TEXT,
  check_duration_ms       INTEGER,
  attempts                INTEGER NOT NULL DEFAULT 1,
  last_error_code         TEXT,
  last_error_message      TEXT,
  next_scheduled_check_at TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hims_checks_firm
  ON public.hims_status_checks (firm_id);
CREATE INDEX IF NOT EXISTS idx_hims_checks_firm_case
  ON public.hims_status_checks (firm_id, case_id, last_checked_at);
CREATE INDEX IF NOT EXISTS idx_hims_checks_firm_dev
  ON public.hims_status_checks (firm_id, developer_id);
CREATE INDEX IF NOT EXISTS idx_hims_checks_firm_project
  ON public.hims_status_checks (firm_id, project_id, phase, unit_lot);
CREATE INDEX IF NOT EXISTS idx_hims_checks_firm_status
  ON public.hims_status_checks (firm_id, last_status);
CREATE INDEX IF NOT EXISTS idx_hims_checks_next_scheduled
  ON public.hims_status_checks (firm_id, next_scheduled_check_at)
  WHERE next_scheduled_check_at IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_hims_checks_idempotency
  ON public.hims_status_checks (firm_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- hims_data_comparisons
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.hims_data_comparisons (
  id                    SERIAL PRIMARY KEY,
  firm_id               INTEGER NOT NULL,
  case_id               INTEGER,
  status_check_id       INTEGER,
  field_group_name      TEXT,
  field                 TEXT NOT NULL,
  field_label           TEXT,
  lawcaspro_value       TEXT,
  hims_value            TEXT,
  ekyc_value            TEXT,
  status                TEXT NOT NULL,
  mismatch_severity     TEXT DEFAULT 'warning',
  resolution_status     TEXT DEFAULT 'unresolved',
  resolved_by_user_id   INTEGER,
  resolved_at           TIMESTAMPTZ,
  resolution_note       TEXT,
  idempotency_key       TEXT,
  compared_by_user_id   INTEGER,
  compared_at           TIMESTAMPTZ,
  comparison_run_id     TEXT,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hims_comp_firm
  ON public.hims_data_comparisons (firm_id);
CREATE INDEX IF NOT EXISTS idx_hims_comp_firm_case
  ON public.hims_data_comparisons (firm_id, case_id);
CREATE INDEX IF NOT EXISTS idx_hims_comp_firm_status
  ON public.hims_data_comparisons (firm_id, status);
CREATE INDEX IF NOT EXISTS idx_hims_comp_firm_resolution
  ON public.hims_data_comparisons (firm_id, resolution_status);
CREATE INDEX IF NOT EXISTS idx_hims_comp_firm_field
  ON public.hims_data_comparisons (firm_id, field);
CREATE INDEX IF NOT EXISTS idx_hims_comp_firm_run
  ON public.hims_data_comparisons (firm_id, comparison_run_id);
CREATE INDEX IF NOT EXISTS idx_hims_comp_firm_scheck
  ON public.hims_data_comparisons (firm_id, status_check_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hims_comp_idempotency
  ON public.hims_data_comparisons (firm_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- hims_notification_audit (pgTable name = hims_notification_audit)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.hims_notification_audit (
  id                        SERIAL PRIMARY KEY,
  firm_id                   INTEGER NOT NULL,
  case_id                   INTEGER,
  idempotency_key           TEXT NOT NULL,
  notification_type         TEXT NOT NULL,
  target_user_id            INTEGER,
  target_scope              TEXT NOT NULL DEFAULT 'firm',
  payload_json              JSONB,
  severity                  TEXT DEFAULT 'info',
  correlation_id            TEXT,
  source_system             TEXT NOT NULL DEFAULT 'HIMS',
  source_event_name         TEXT,
  source_event_ref          TEXT,
  notification_created      BOOLEAN NOT NULL DEFAULT FALSE,
  notification_id           INTEGER,
  deduplicated              BOOLEAN NOT NULL DEFAULT FALSE,
  deduplicated_against_id   INTEGER,
  delivery_count            INTEGER NOT NULL DEFAULT 0,
  last_delivery_attempt_at  TIMESTAMPTZ,
  last_delivery_error       TEXT,
  actor_user_id             INTEGER,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hims_notif_audit_firm
  ON public.hims_notification_audit (firm_id);
CREATE INDEX IF NOT EXISTS idx_hims_notif_audit_firm_case
  ON public.hims_notification_audit (firm_id, case_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hims_notif_audit_idem
  ON public.hims_notification_audit (firm_id, idempotency_key);
