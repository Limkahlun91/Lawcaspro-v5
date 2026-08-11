-- 0152: Supporting Documents + Case Ledger idempotency columns
-- SAFE, idempotent, additive only (no column drops, no table drops)

-- ==============================================================
-- 1. case_supporting_documents — PART 1F
-- ==============================================================
CREATE TABLE IF NOT EXISTS case_supporting_documents (
  id BIGSERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  case_id INTEGER,
  project_id INTEGER,
  phase_id INTEGER,

  scope TEXT NOT NULL
    CONSTRAINT case_supporting_documents_scope_ck
      CHECK (scope IN ('case', 'project_master')),

  category TEXT NOT NULL
    CONSTRAINT case_supporting_documents_category_ck
      CHECK (category IN (
        'stamped_spa','stamped_lo','letter_of_offer',
        'project_master','bank','identity','other'
      )),

  file_id TEXT,
  storage_object_path TEXT,
  storage_bucket TEXT,
  display_name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1',

  uploaded_by INTEGER,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,

  source_reference TEXT,
  file_size_bytes BIGINT,
  mime_type TEXT,
  sha256 TEXT,

  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT case_supporting_documents_case_fk
    FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE,
  CONSTRAINT case_supporting_documents_firm_ck
    CHECK (firm_id > 0)
);

CREATE INDEX IF NOT EXISTS idx_case_supporting_docs_firm_case
  ON case_supporting_documents (firm_id, case_id)
  WHERE scope = 'case';

CREATE INDEX IF NOT EXISTS idx_case_supporting_docs_firm_project
  ON case_supporting_documents (firm_id, project_id, phase_id)
  WHERE scope = 'project_master';

CREATE INDEX IF NOT EXISTS idx_case_supporting_docs_category
  ON case_supporting_documents (firm_id, category);

CREATE INDEX IF NOT EXISTS idx_case_supporting_docs_active
  ON case_supporting_documents (firm_id, is_active);

ALTER TABLE case_supporting_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_supporting_documents FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON case_supporting_documents;
CREATE POLICY tenant_isolation ON case_supporting_documents FOR ALL TO PUBLIC
  USING (firm_id = (current_setting('app.current_firm_id', true)::int))
  WITH CHECK (firm_id = (current_setting('app.current_firm_id', true)::int));

DO $$ BEGIN IF to_regrole('app_user') IS NOT NULL THEN
  GRANT SELECT, INSERT, UPDATE ON TABLE case_supporting_documents TO app_user;
  GRANT USAGE, SELECT ON SEQUENCE case_supporting_documents_id_seq TO app_user;
END IF; END $$;

-- ==============================================================
-- 2. case_ledgers: debit_cents / credit_cents / event_key (PART 1I)
-- ==============================================================

-- Add debit_cents / credit_cents columns (numeric legacy kept, not dropped)
ALTER TABLE case_ledgers
  ADD COLUMN IF NOT EXISTS debit_cents BIGINT NOT NULL DEFAULT 0;

ALTER TABLE case_ledgers
  ADD COLUMN IF NOT EXISTS credit_cents BIGINT NOT NULL DEFAULT 0;

ALTER TABLE case_ledgers
  ADD COLUMN IF NOT EXISTS source_reference TEXT;

ALTER TABLE case_ledgers
  ADD COLUMN IF NOT EXISTS event_key TEXT;

-- Idempotency: firm_id + event_key UNIQUE (NULL event_key allowed via WHERE)
CREATE UNIQUE INDEX IF NOT EXISTS uq_case_ledgers_firm_event_key
  ON case_ledgers (firm_id, event_key)
  WHERE event_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_case_ledgers_firm_event
  ON case_ledgers (firm_id, event_key);
