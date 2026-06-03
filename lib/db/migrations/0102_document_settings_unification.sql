-- 0102_document_settings_unification.sql
-- Unify master document visibility toggle to firm_settings.use_master_documents.
-- Keep legacy firms.show_master_documents in sync (do not drop it here).

ALTER TABLE firms
  ADD COLUMN IF NOT EXISTS show_master_documents boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS firm_settings (
  firm_id integer PRIMARY KEY REFERENCES firms(id) ON DELETE CASCADE,
  use_master_documents boolean NOT NULL DEFAULT true,
  enable_firm_letterhead boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE firm_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE firm_settings FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS firm_settings_rw ON firm_settings;
CREATE POLICY firm_settings_rw ON firm_settings FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

INSERT INTO firm_settings (firm_id, use_master_documents)
SELECT f.id, COALESCE(f.show_master_documents, true)
FROM firms f
WHERE NOT EXISTS (SELECT 1 FROM firm_settings s WHERE s.firm_id = f.id);

UPDATE firms f
SET show_master_documents = s.use_master_documents
FROM firm_settings s
WHERE s.firm_id = f.id
  AND COALESCE(f.show_master_documents, true) IS DISTINCT FROM s.use_master_documents;

ALTER TABLE platform_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_documents FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_documents_read ON platform_documents;
CREATE POLICY platform_documents_read ON platform_documents FOR SELECT TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
    OR (
      firm_id IS NULL
      AND NULLIF(current_setting('app.current_firm_id', true), '') IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM firm_settings s
        WHERE s.firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
          AND COALESCE(s.use_master_documents, true) = true
      )
    )
  );

