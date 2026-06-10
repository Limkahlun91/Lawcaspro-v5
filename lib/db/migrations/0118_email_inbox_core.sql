BEGIN;

CREATE TABLE IF NOT EXISTS communication_email_accounts (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  provider text NOT NULL,
  email_address text NOT NULL,
  display_name text NULL,
  status text NOT NULL DEFAULT 'setup_required',
  mailbox_type text NULL,
  encrypted_access_token text NULL,
  encrypted_refresh_token text NULL,
  token_expires_at timestamptz NULL,
  imap_host text NULL,
  imap_port integer NULL,
  imap_username text NULL,
  encrypted_imap_password text NULL,
  use_tls boolean NOT NULL DEFAULT true,
  last_sync_at timestamptz NULL,
  last_error text NULL,
  created_by integer NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_communication_email_accounts_firm
  ON communication_email_accounts (firm_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_communication_email_accounts_provider_email
  ON communication_email_accounts (firm_id, provider, email_address);

CREATE TABLE IF NOT EXISTS communication_email_folders (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  account_id integer NOT NULL,
  provider_folder_id text NOT NULL,
  parent_provider_folder_id text NULL,
  display_name text NOT NULL,
  folder_type text NOT NULL DEFAULT 'custom',
  sync_enabled boolean NOT NULL DEFAULT false,
  last_sync_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_communication_email_folders_firm_account
  ON communication_email_folders (firm_id, account_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_communication_email_folders_provider_folder
  ON communication_email_folders (account_id, provider_folder_id);

CREATE TABLE IF NOT EXISTS communication_email_sync_logs (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  account_id integer NOT NULL,
  folder_id integer NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NULL,
  status text NOT NULL DEFAULT 'running',
  imported_count integer NOT NULL DEFAULT 0,
  skipped_duplicate_count integer NOT NULL DEFAULT 0,
  error_message text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_communication_email_sync_logs_firm_account_started
  ON communication_email_sync_logs (firm_id, account_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_communication_email_sync_logs_firm_folder_started
  ON communication_email_sync_logs (firm_id, folder_id, started_at DESC);

CREATE TABLE IF NOT EXISTS communication_email_remarks (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  message_id integer NOT NULL,
  user_id integer NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS idx_communication_email_remarks_firm_message_created
  ON communication_email_remarks (firm_id, message_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_communication_email_remarks_firm_user_created
  ON communication_email_remarks (firm_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS communication_message_reads (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  message_id integer NOT NULL,
  user_id integer NOT NULL,
  first_opened_at timestamptz NULL,
  last_opened_at timestamptz NULL,
  opened_count integer NOT NULL DEFAULT 0,
  is_read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS communication_message_reads
  ADD COLUMN IF NOT EXISTS is_read boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS uq_communication_message_reads_message_user
  ON communication_message_reads (message_id, user_id);
CREATE INDEX IF NOT EXISTS idx_communication_message_reads_firm_message
  ON communication_message_reads (firm_id, message_id);
CREATE INDEX IF NOT EXISTS idx_communication_message_reads_firm_user
  ON communication_message_reads (firm_id, user_id);

DO $$
DECLARE
  tenant_expr text := '(firm_id = NULLIF(current_setting(''app.current_firm_id'', true), '''')::integer OR current_setting(''app.is_founder'', true) = ''true'')';
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'communication_mailboxes',
    'communication_messages',
    'communication_case_tasks',
    'communication_drafts',
    'communication_draft_tasks',
    'communication_attachments',
    'communication_audit_logs',
    'communication_task_assignees',
    'communication_email_accounts',
    'communication_email_folders',
    'communication_email_sync_logs',
    'communication_email_remarks',
    'communication_message_reads'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = tbl AND policyname = 'tenant_isolation') THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I FOR ALL TO PUBLIC USING (%s) WITH CHECK (%s)',
        tbl,
        tenant_expr,
        tenant_expr
      );
    END IF;
  END LOOP;
END $$;

COMMIT;
