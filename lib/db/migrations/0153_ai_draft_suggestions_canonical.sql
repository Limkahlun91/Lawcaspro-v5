-- 0153: AI Draft Suggestions Table (append-only review lifecycle)
-- PART 3 §47: AI Drafting Assistant canonical schema

CREATE TABLE IF NOT EXISTS ai_draft_suggestions (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  case_id INTEGER,
  document_id INTEGER,
  template_id INTEGER,
  suggestion_scope TEXT NOT NULL DEFAULT 'document_clause',
  target_section TEXT,
  prompt_text TEXT NOT NULL,
  prompt_tokens_used INTEGER,
  completion_tokens_used INTEGER,
  total_tokens_used INTEGER,
  provider_model TEXT,
  suggestion_content JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'proposed',
  rejection_reason TEXT,
  review_comments TEXT,
  modification_snapshot JSONB,
  reviewer_user_id INTEGER,
  reviewed_at TIMESTAMPTZ,
  linked_document_version_id INTEGER,
  linked_case_document_id INTEGER,
  correlation_id TEXT,
  idempotency_key TEXT,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_draft_suggestions_firm ON ai_draft_suggestions (firm_id);
CREATE INDEX IF NOT EXISTS idx_ai_draft_suggestions_firm_case ON ai_draft_suggestions (firm_id, case_id);
CREATE INDEX IF NOT EXISTS idx_ai_draft_suggestions_firm_status ON ai_draft_suggestions (firm_id, status);
CREATE INDEX IF NOT EXISTS idx_ai_draft_suggestions_firm_document ON ai_draft_suggestions (firm_id, document_id);
CREATE INDEX IF NOT EXISTS idx_ai_draft_suggestions_firm_scope ON ai_draft_suggestions (firm_id, suggestion_scope, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_draft_suggestions_created_at ON ai_draft_suggestions (firm_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_draft_suggestions_idempotency
  ON ai_draft_suggestions (firm_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_draft_suggestions_correlation
  ON ai_draft_suggestions (firm_id, correlation_id)
  WHERE correlation_id IS NOT NULL;

ALTER TABLE ai_draft_suggestions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_draft_suggestions_firm_isolation_policy ON ai_draft_suggestions;
CREATE POLICY ai_draft_suggestions_firm_isolation_policy
  ON ai_draft_suggestions
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
    DROP POLICY IF EXISTS ai_draft_suggestions_company_rls ON ai_draft_suggestions;
    PERFORM app_firms.enforce_company_id_v2('ai_draft_suggestions', 'firm_id');
  END IF;
END $$;
