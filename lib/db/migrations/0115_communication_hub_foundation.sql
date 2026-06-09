BEGIN;

CREATE TABLE IF NOT EXISTS communication_mailboxes (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  channel text NOT NULL,
  provider text NOT NULL,
  display_name text NULL,
  address text NULL,
  phone_number text NULL,
  mailbox_type text NOT NULL DEFAULT 'shared',
  is_active boolean NOT NULL DEFAULT true,
  sync_enabled boolean NOT NULL DEFAULT false,
  last_synced_at timestamptz NULL,
  created_by integer NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_communication_mailboxes_firm
  ON communication_mailboxes (firm_id);
CREATE INDEX IF NOT EXISTS idx_communication_mailboxes_firm_channel
  ON communication_mailboxes (firm_id, channel, is_active);

CREATE TABLE IF NOT EXISTS communication_messages (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  mailbox_id integer NULL,
  channel text NOT NULL,
  provider text NOT NULL,
  provider_message_id text NULL,
  provider_thread_id text NULL,
  provider_conversation_id text NULL,
  provider_folder text NULL,
  provider_is_read boolean NOT NULL DEFAULT false,
  direction text NOT NULL,
  from_address text NULL,
  from_name text NULL,
  to_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
  cc_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
  bcc_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject text NULL,
  body_text text NULL,
  body_html text NULL,
  received_at timestamptz NULL,
  sent_at timestamptz NULL,
  internal_status text NOT NULL DEFAULT 'new',
  is_batch boolean NOT NULL DEFAULT false,
  batch_owner_user_id integer NULL,
  linked_case_id integer NULL,
  assigned_to_user_id integer NULL,
  sla_due_at timestamptz NULL,
  last_activity_at timestamptz NULL,
  created_by integer NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_communication_messages_firm
  ON communication_messages (firm_id);
CREATE INDEX IF NOT EXISTS idx_communication_messages_firm_status
  ON communication_messages (firm_id, internal_status, created_at);
CREATE INDEX IF NOT EXISTS idx_communication_messages_firm_assigned
  ON communication_messages (firm_id, assigned_to_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_communication_messages_firm_case
  ON communication_messages (firm_id, linked_case_id, created_at);
CREATE INDEX IF NOT EXISTS idx_communication_messages_firm_mailbox
  ON communication_messages (firm_id, mailbox_id, created_at);
CREATE INDEX IF NOT EXISTS idx_communication_messages_firm_provider_thread
  ON communication_messages (firm_id, provider_thread_id);

CREATE TABLE IF NOT EXISTS communication_case_tasks (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  parent_message_id integer NOT NULL,
  channel text NOT NULL,
  linked_case_id integer NULL,
  case_ref text NULL,
  party_name text NULL,
  bank_ref text NULL,
  developer_ref text NULL,
  property_ref text NULL,
  responsible_lawyer_id integer NULL,
  responsible_clerk_id integer NULL,
  assigned_to_user_id integer NULL,
  assigned_by_user_id integer NULL,
  assigned_at timestamptz NULL,
  task_status text NOT NULL DEFAULT 'pending_owner_review',
  required_action text NULL,
  reply_note text NULL,
  internal_note text NULL,
  due_at timestamptz NULL,
  seen_by_owner_at timestamptz NULL,
  acknowledged_at timestamptz NULL,
  ready_at timestamptz NULL,
  replied_at timestamptz NULL,
  closed_at timestamptz NULL,
  created_by integer NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_communication_case_tasks_firm
  ON communication_case_tasks (firm_id);
CREATE INDEX IF NOT EXISTS idx_communication_case_tasks_parent
  ON communication_case_tasks (firm_id, parent_message_id, created_at);
CREATE INDEX IF NOT EXISTS idx_communication_case_tasks_status
  ON communication_case_tasks (firm_id, task_status, created_at);
CREATE INDEX IF NOT EXISTS idx_communication_case_tasks_assigned
  ON communication_case_tasks (firm_id, assigned_to_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_communication_case_tasks_case
  ON communication_case_tasks (firm_id, linked_case_id, created_at);
CREATE INDEX IF NOT EXISTS idx_communication_case_tasks_due
  ON communication_case_tasks (firm_id, due_at);

CREATE TABLE IF NOT EXISTS communication_drafts (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  parent_message_id integer NOT NULL,
  channel text NOT NULL,
  draft_type text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  to_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
  cc_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
  bcc_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject text NULL,
  body_text text NULL,
  body_html text NULL,
  prepared_by_user_id integer NULL,
  approved_by_user_id integer NULL,
  sent_by_user_id integer NULL,
  prepared_at timestamptz NULL,
  approved_at timestamptz NULL,
  sent_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_communication_drafts_firm
  ON communication_drafts (firm_id);
CREATE INDEX IF NOT EXISTS idx_communication_drafts_firm_status
  ON communication_drafts (firm_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_communication_drafts_parent
  ON communication_drafts (firm_id, parent_message_id);

CREATE TABLE IF NOT EXISTS communication_draft_tasks (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  draft_id integer NOT NULL,
  case_task_id integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_communication_draft_tasks_draft_task UNIQUE (draft_id, case_task_id)
);

CREATE INDEX IF NOT EXISTS idx_communication_draft_tasks_firm
  ON communication_draft_tasks (firm_id);
CREATE INDEX IF NOT EXISTS idx_communication_draft_tasks_draft
  ON communication_draft_tasks (draft_id);
CREATE INDEX IF NOT EXISTS idx_communication_draft_tasks_task
  ON communication_draft_tasks (case_task_id);

CREATE TABLE IF NOT EXISTS communication_attachments (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  message_id integer NOT NULL,
  channel text NOT NULL,
  filename text NOT NULL,
  mime_type text NULL,
  size_bytes integer NULL,
  storage_path text NULL,
  provider_attachment_id text NULL,
  linked_case_id integer NULL,
  saved_to_case_document_id integer NULL,
  created_by integer NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_communication_attachments_firm
  ON communication_attachments (firm_id);
CREATE INDEX IF NOT EXISTS idx_communication_attachments_message
  ON communication_attachments (message_id);
CREATE INDEX IF NOT EXISTS idx_communication_attachments_case
  ON communication_attachments (linked_case_id);

CREATE TABLE IF NOT EXISTS communication_audit_logs (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  message_id integer NULL,
  case_task_id integer NULL,
  draft_id integer NULL,
  actor_user_id integer NULL,
  action text NOT NULL,
  old_value jsonb NULL,
  new_value jsonb NULL,
  ip_address text NULL,
  user_agent text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_communication_audit_logs_firm
  ON communication_audit_logs (firm_id, created_at);
CREATE INDEX IF NOT EXISTS idx_communication_audit_logs_message
  ON communication_audit_logs (firm_id, message_id, created_at);
CREATE INDEX IF NOT EXISTS idx_communication_audit_logs_task
  ON communication_audit_logs (firm_id, case_task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_communication_audit_logs_draft
  ON communication_audit_logs (firm_id, draft_id, created_at);

ALTER TABLE communication_mailboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_mailboxes FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON communication_mailboxes;
CREATE POLICY tenant_isolation ON communication_mailboxes FOR ALL TO PUBLIC
  USING (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  )
  WITH CHECK (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  );

ALTER TABLE communication_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_messages FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON communication_messages;
CREATE POLICY tenant_isolation ON communication_messages FOR ALL TO PUBLIC
  USING (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  )
  WITH CHECK (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  );

ALTER TABLE communication_case_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_case_tasks FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON communication_case_tasks;
CREATE POLICY tenant_isolation ON communication_case_tasks FOR ALL TO PUBLIC
  USING (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  )
  WITH CHECK (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  );

ALTER TABLE communication_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_drafts FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON communication_drafts;
CREATE POLICY tenant_isolation ON communication_drafts FOR ALL TO PUBLIC
  USING (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  )
  WITH CHECK (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  );

ALTER TABLE communication_draft_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_draft_tasks FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON communication_draft_tasks;
CREATE POLICY tenant_isolation ON communication_draft_tasks FOR ALL TO PUBLIC
  USING (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  )
  WITH CHECK (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  );

ALTER TABLE communication_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_attachments FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON communication_attachments;
CREATE POLICY tenant_isolation ON communication_attachments FOR ALL TO PUBLIC
  USING (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  )
  WITH CHECK (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  );

ALTER TABLE communication_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_audit_logs FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON communication_audit_logs;
CREATE POLICY tenant_isolation ON communication_audit_logs FOR ALL TO PUBLIC
  USING (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  )
  WITH CHECK (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  );

COMMIT;

