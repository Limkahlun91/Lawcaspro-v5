-- PART 3: expand communication_drafts for reply/forward + idempotency
-- All columns additive; RLS/grants defensive no-op when already enabled.

ALTER TABLE communication_drafts ADD COLUMN IF NOT EXISTS mailbox_id INTEGER;
ALTER TABLE communication_drafts ADD COLUMN IF NOT EXISTS linked_case_id INTEGER;
ALTER TABLE communication_drafts ADD COLUMN IF NOT EXISTS case_ref TEXT;
ALTER TABLE communication_drafts ADD COLUMN IF NOT EXISTS reply_type TEXT;
ALTER TABLE communication_drafts ADD COLUMN IF NOT EXISTS "to" JSONB;
ALTER TABLE communication_drafts ADD COLUMN IF NOT EXISTS cc JSONB;
ALTER TABLE communication_drafts ADD COLUMN IF NOT EXISTS bcc JSONB;
ALTER TABLE communication_drafts ADD COLUMN IF NOT EXISTS in_reply_to TEXT;
ALTER TABLE communication_drafts ADD COLUMN IF NOT EXISTS "references" TEXT;
ALTER TABLE communication_drafts ADD COLUMN IF NOT EXISTS forwarded_from_message_id INTEGER;
ALTER TABLE communication_drafts ADD COLUMN IF NOT EXISTS include_original_attachments BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE communication_drafts ADD COLUMN IF NOT EXISTS forwarded_attachment_refs JSONB;
ALTER TABLE communication_drafts ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE communication_drafts ADD COLUMN IF NOT EXISTS assigned_to_user_id INTEGER;
ALTER TABLE communication_drafts ADD COLUMN IF NOT EXISTS created_by INTEGER;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexname = 'idx_communication_drafts_idem') THEN
    CREATE INDEX idx_communication_drafts_idem
      ON communication_drafts (firm_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF (SELECT relrowsecurity = FALSE FROM pg_class WHERE relname = 'communication_drafts') THEN
    ALTER TABLE communication_drafts ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy WHERE polrelid = 'communication_drafts'::regclass AND polname = 'communication_drafts_tenant_isolation'
  ) THEN
    CREATE POLICY communication_drafts_tenant_isolation ON communication_drafts
      FOR ALL
      USING (firm_id = current_setting('app.current_firm_id', true)::INTEGER)
      WITH CHECK (firm_id = current_setting('app.current_firm_id', true)::INTEGER);
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_company_id_v2') THEN
    PERFORM app_firms.enforce_company_id_v2('communication_drafts'::regclass);
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;
