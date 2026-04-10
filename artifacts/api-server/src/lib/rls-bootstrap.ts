import { pool } from "@workspace/db";

export async function ensurePlatformDocumentsGlobalVisibilityRls(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE platform_documents ENABLE ROW LEVEL SECURITY;
      ALTER TABLE platform_documents FORCE ROW LEVEL SECURITY;

      DROP POLICY IF EXISTS tenant_isolation ON platform_documents;
      DROP POLICY IF EXISTS platform_documents_read ON platform_documents;
      DROP POLICY IF EXISTS platform_documents_insert ON platform_documents;
      DROP POLICY IF EXISTS platform_documents_update ON platform_documents;
      DROP POLICY IF EXISTS platform_documents_delete ON platform_documents;

      CREATE POLICY platform_documents_read ON platform_documents FOR SELECT TO PUBLIC
        USING (
          current_setting('app.is_founder', true) = 'true'
          OR firm_id IS NULL
          OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
        );

      CREATE POLICY platform_documents_insert ON platform_documents FOR INSERT TO PUBLIC
        WITH CHECK (
          current_setting('app.is_founder', true) = 'true'
          OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
        );

      CREATE POLICY platform_documents_update ON platform_documents FOR UPDATE TO PUBLIC
        USING (
          current_setting('app.is_founder', true) = 'true'
          OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
        )
        WITH CHECK (
          current_setting('app.is_founder', true) = 'true'
          OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
        );

      CREATE POLICY platform_documents_delete ON platform_documents FOR DELETE TO PUBLIC
        USING (
          current_setting('app.is_founder', true) = 'true'
          OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
        );
    `);
  } finally {
    client.release();
  }
}

