ALTER TABLE platform_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_documents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_documents_read ON platform_documents;

CREATE POLICY platform_documents_read ON platform_documents FOR SELECT TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
    OR (firm_id IS NULL AND NULLIF(current_setting('app.current_firm_id', true), '') IS NOT NULL)
  );
