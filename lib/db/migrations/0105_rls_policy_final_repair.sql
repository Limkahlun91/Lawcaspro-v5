-- 0105_rls_policy_final_repair.sql
-- Final RLS cleanup after 0100–0104 verification.
-- Remove legacy permissive templates_read policy that bypasses firm_settings.use_master_documents.

ALTER TABLE templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE templates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS templates_read ON templates;

DROP POLICY IF EXISTS templates_select ON templates;
CREATE POLICY templates_select ON templates
FOR SELECT TO PUBLIC
USING (
  current_setting('app.is_founder', true) = 'true'
  OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
  OR (
    firm_id IS NULL
    AND NULLIF(current_setting('app.current_firm_id', true), '') IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM firm_settings s
      WHERE s.firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
        AND COALESCE(s.use_master_documents, true) = true
    )
  )
);

-- Keep write policies strict. Recreate them to ensure no legacy policy remains too permissive.
DROP POLICY IF EXISTS templates_insert ON templates;
CREATE POLICY templates_insert ON templates
FOR INSERT TO PUBLIC
WITH CHECK (
  current_setting('app.is_founder', true) = 'true'
  OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
);

DROP POLICY IF EXISTS templates_update ON templates;
CREATE POLICY templates_update ON templates
FOR UPDATE TO PUBLIC
USING (
  current_setting('app.is_founder', true) = 'true'
  OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
)
WITH CHECK (
  current_setting('app.is_founder', true) = 'true'
  OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
);

DROP POLICY IF EXISTS templates_delete ON templates;
CREATE POLICY templates_delete ON templates
FOR DELETE TO PUBLIC
USING (
  current_setting('app.is_founder', true) = 'true'
  OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
);

