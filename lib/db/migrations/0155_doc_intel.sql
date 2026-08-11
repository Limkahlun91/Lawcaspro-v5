-- 0155: Document Intelligence (PART3 3A)
-- doc_intel_extraction_jobs + doc_intel_extracted_candidates + doc_intel_confirmations_audit
-- Additive only, idempotent, RLS protected, firm-scoped.

BEGIN;

-- ==============================================================
-- 1. doc_intel_extraction_jobs
-- ==============================================================
CREATE TABLE IF NOT EXISTS doc_intel_extraction_jobs (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  case_id INTEGER,
  document_id INTEGER,
  supporting_document_id INTEGER,
  source_object_path TEXT,
  source_file_name TEXT,
  source_mime_type TEXT,
  job_type TEXT NOT NULL DEFAULT 'auto_extract',
  status TEXT NOT NULL DEFAULT 'queued',
  idempotency_key TEXT,
  engine_provider TEXT,
  engine_model TEXT,
  requested_by_user_id INTEGER,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_currency TEXT,
  cost_amount TEXT,
  error_code TEXT,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  raw_extraction_json JSONB,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  confirmed_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE doc_intel_extraction_jobs IS 'Doc intel extraction job records: LLM-based field extraction from case documents / supporting docs. Firm-scoped, RLS protected.';
COMMENT ON COLUMN doc_intel_extraction_jobs.idempotency_key IS 'Client-provided dedupe key; unique per firm when set.';
COMMENT ON COLUMN doc_intel_extraction_jobs.status IS 'queued | running | completed | partial_failure | failed';

CREATE INDEX IF NOT EXISTS idx_doc_intel_jobs_firm
  ON doc_intel_extraction_jobs(firm_id);
CREATE INDEX IF NOT EXISTS idx_doc_intel_jobs_firm_status
  ON doc_intel_extraction_jobs(firm_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_doc_intel_jobs_firm_case
  ON doc_intel_extraction_jobs(firm_id, case_id);
CREATE INDEX IF NOT EXISTS idx_doc_intel_jobs_firm_doc
  ON doc_intel_extraction_jobs(firm_id, document_id);
CREATE INDEX IF NOT EXISTS idx_doc_intel_jobs_firm_sdoc
  ON doc_intel_extraction_jobs(firm_id, supporting_document_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_doc_intel_jobs_idempotency
  ON doc_intel_extraction_jobs(firm_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ==============================================================
-- 2. doc_intel_extracted_candidates
-- ==============================================================
CREATE TABLE IF NOT EXISTS doc_intel_extracted_candidates (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL REFERENCES doc_intel_extraction_jobs(id) ON DELETE CASCADE,
  case_id INTEGER,
  target_table TEXT NOT NULL,
  target_field TEXT NOT NULL,
  field_path TEXT,
  extracted_value_text TEXT,
  extracted_value_json JSONB,
  confidence_score TEXT,
  confidence_level TEXT DEFAULT 'medium',
  source_page_no INTEGER,
  source_bounding_box JSONB,
  source_snippet TEXT,
  candidate_rank INTEGER NOT NULL DEFAULT 1,
  review_status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by_user_id INTEGER,
  reviewed_at TIMESTAMPTZ,
  applied_to_field BOOLEAN NOT NULL DEFAULT FALSE,
  applied_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE doc_intel_extracted_candidates IS 'Candidate extracted field values per doc-intel job. Review workflow tracks pending/rejected/confirmed/applied.';
COMMENT ON COLUMN doc_intel_extracted_candidates.review_status IS 'pending | accepted | rejected | applied | superseded';
COMMENT ON COLUMN doc_intel_extracted_candidates.confidence_level IS 'low | medium | high';

CREATE INDEX IF NOT EXISTS idx_doc_intel_candidates_firm
  ON doc_intel_extracted_candidates(firm_id);
CREATE INDEX IF NOT EXISTS idx_doc_intel_candidates_firm_job
  ON doc_intel_extracted_candidates(firm_id, job_id);
CREATE INDEX IF NOT EXISTS idx_doc_intel_candidates_firm_case
  ON doc_intel_extracted_candidates(firm_id, case_id);
CREATE INDEX IF NOT EXISTS idx_doc_intel_candidates_firm_target
  ON doc_intel_extracted_candidates(firm_id, target_table, target_field);
CREATE INDEX IF NOT EXISTS idx_doc_intel_candidates_firm_review
  ON doc_intel_extracted_candidates(firm_id, review_status);

-- ==============================================================
-- 3. doc_intel_confirmations_audit
-- ==============================================================
CREATE TABLE IF NOT EXISTS doc_intel_confirmations_audit (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL REFERENCES doc_intel_extraction_jobs(id) ON DELETE CASCADE,
  candidate_id INTEGER REFERENCES doc_intel_extracted_candidates(id) ON DELETE SET NULL,
  case_id INTEGER,
  target_table TEXT,
  target_field TEXT,
  action_type TEXT NOT NULL,
  before_value_text TEXT,
  after_value_text TEXT,
  before_value_json JSONB,
  after_value_json JSONB,
  actor_user_id INTEGER,
  actor_role TEXT,
  confidence_at_decision TEXT,
  idempotency_key TEXT,
  ip_address TEXT,
  user_agent TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE doc_intel_confirmations_audit IS 'Append-only audit log of doc-intel candidate accept/reject/apply actions plus before/after snapshots.';
COMMENT ON COLUMN doc_intel_confirmations_audit.action_type IS 'accept | reject | apply | dismiss | auto_apply | rollback';

CREATE INDEX IF NOT EXISTS idx_doc_intel_audit_firm
  ON doc_intel_confirmations_audit(firm_id);
CREATE INDEX IF NOT EXISTS idx_doc_intel_audit_firm_job
  ON doc_intel_confirmations_audit(firm_id, job_id);
CREATE INDEX IF NOT EXISTS idx_doc_intel_audit_firm_candidate
  ON doc_intel_confirmations_audit(firm_id, candidate_id);
CREATE INDEX IF NOT EXISTS idx_doc_intel_audit_firm_case
  ON doc_intel_confirmations_audit(firm_id, case_id);
CREATE INDEX IF NOT EXISTS idx_doc_intel_audit_firm_action
  ON doc_intel_confirmations_audit(firm_id, action_type, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_doc_intel_audit_idempotency
  ON doc_intel_confirmations_audit(firm_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ==============================================================
-- updated_at triggers
-- ==============================================================
DROP TRIGGER IF EXISTS trg_doc_intel_jobs_updated_at ON doc_intel_extraction_jobs;
CREATE OR REPLACE FUNCTION set_doc_intel_jobs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_doc_intel_jobs_updated_at
BEFORE UPDATE ON doc_intel_extraction_jobs
FOR EACH ROW EXECUTE FUNCTION set_doc_intel_jobs_updated_at();

DROP TRIGGER IF EXISTS trg_doc_intel_candidates_updated_at ON doc_intel_extracted_candidates;
CREATE OR REPLACE FUNCTION set_doc_intel_candidates_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_doc_intel_candidates_updated_at
BEFORE UPDATE ON doc_intel_extracted_candidates
FOR EACH ROW EXECUTE FUNCTION set_doc_intel_candidates_updated_at();

-- ==============================================================
-- RLS: doc_intel_extraction_jobs
-- ==============================================================
ALTER TABLE doc_intel_extraction_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE doc_intel_extraction_jobs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS doc_intel_jobs_firm_select ON doc_intel_extraction_jobs;
CREATE POLICY doc_intel_jobs_firm_select ON doc_intel_extraction_jobs
  FOR SELECT TO PUBLIC USING (firm_id = current_setting('app.current_firm_id', TRUE)::INTEGER);

DROP POLICY IF EXISTS doc_intel_jobs_firm_insert ON doc_intel_extraction_jobs;
CREATE POLICY doc_intel_jobs_firm_insert ON doc_intel_extraction_jobs
  FOR INSERT TO PUBLIC WITH CHECK (firm_id = current_setting('app.current_firm_id', TRUE)::INTEGER);

DROP POLICY IF EXISTS doc_intel_jobs_firm_update ON doc_intel_extraction_jobs;
CREATE POLICY doc_intel_jobs_firm_update ON doc_intel_extraction_jobs
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
    DROP POLICY IF EXISTS doc_intel_jobs_company_rls ON doc_intel_extraction_jobs;
    PERFORM app_firms.enforce_company_id_v2('doc_intel_extraction_jobs', 'firm_id');
  END IF;
END $$;

-- ==============================================================
-- RLS: doc_intel_extracted_candidates
-- ==============================================================
ALTER TABLE doc_intel_extracted_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE doc_intel_extracted_candidates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS doc_intel_candidates_firm_select ON doc_intel_extracted_candidates;
CREATE POLICY doc_intel_candidates_firm_select ON doc_intel_extracted_candidates
  FOR SELECT TO PUBLIC USING (firm_id = current_setting('app.current_firm_id', TRUE)::INTEGER);

DROP POLICY IF EXISTS doc_intel_candidates_firm_insert ON doc_intel_extracted_candidates;
CREATE POLICY doc_intel_candidates_firm_insert ON doc_intel_extracted_candidates
  FOR INSERT TO PUBLIC WITH CHECK (firm_id = current_setting('app.current_firm_id', TRUE)::INTEGER);

DROP POLICY IF EXISTS doc_intel_candidates_firm_update ON doc_intel_extracted_candidates;
CREATE POLICY doc_intel_candidates_firm_update ON doc_intel_extracted_candidates
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
    DROP POLICY IF EXISTS doc_intel_candidates_company_rls ON doc_intel_extracted_candidates;
    PERFORM app_firms.enforce_company_id_v2('doc_intel_extracted_candidates', 'firm_id');
  END IF;
END $$;

-- ==============================================================
-- RLS: doc_intel_confirmations_audit
-- ==============================================================
ALTER TABLE doc_intel_confirmations_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE doc_intel_confirmations_audit FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS doc_intel_audit_firm_select ON doc_intel_confirmations_audit;
CREATE POLICY doc_intel_audit_firm_select ON doc_intel_confirmations_audit
  FOR SELECT TO PUBLIC USING (firm_id = current_setting('app.current_firm_id', TRUE)::INTEGER);

DROP POLICY IF EXISTS doc_intel_audit_firm_insert ON doc_intel_confirmations_audit;
CREATE POLICY doc_intel_audit_firm_insert ON doc_intel_confirmations_audit
  FOR INSERT TO PUBLIC WITH CHECK (firm_id = current_setting('app.current_firm_id', TRUE)::INTEGER);

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
    DROP POLICY IF EXISTS doc_intel_audit_company_rls ON doc_intel_confirmations_audit;
    PERFORM app_firms.enforce_company_id_v2('doc_intel_confirmations_audit', 'firm_id');
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON doc_intel_extraction_jobs TO app_user;
GRANT SELECT, INSERT, UPDATE ON doc_intel_extracted_candidates TO app_user;
GRANT SELECT, INSERT ON doc_intel_confirmations_audit TO app_user;

COMMIT;
