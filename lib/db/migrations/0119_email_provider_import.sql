ALTER TABLE communication_messages
  ADD COLUMN IF NOT EXISTS email_account_id integer,
  ADD COLUMN IF NOT EXISTS email_folder_id integer,
  ADD COLUMN IF NOT EXISTS internet_message_id text,
  ADD COLUMN IF NOT EXISTS provider_uid text,
  ADD COLUMN IF NOT EXISTS body_preview text,
  ADD COLUMN IF NOT EXISTS attachment_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;

UPDATE communication_messages
SET body_preview = LEFT(COALESCE(body_text, ''), 500)
WHERE body_preview IS NULL
  AND body_text IS NOT NULL;

UPDATE communication_messages m
SET attachment_count = attachment_summary.cnt
FROM (
  SELECT message_id, COUNT(*)::integer AS cnt
  FROM communication_attachments
  GROUP BY message_id
) AS attachment_summary
WHERE m.id = attachment_summary.message_id
  AND m.attachment_count = 0;

CREATE INDEX IF NOT EXISTS idx_communication_messages_firm_email_account
  ON communication_messages (firm_id, email_account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_communication_messages_firm_email_folder
  ON communication_messages (firm_id, email_folder_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_communication_messages_account_provider_message
  ON communication_messages (firm_id, email_account_id, provider_message_id)
  WHERE email_account_id IS NOT NULL AND provider_message_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_communication_messages_account_folder_provider_uid
  ON communication_messages (firm_id, email_account_id, email_folder_id, provider_uid)
  WHERE email_account_id IS NOT NULL AND email_folder_id IS NOT NULL AND provider_uid IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_communication_messages_account_internet_message
  ON communication_messages (firm_id, email_account_id, internet_message_id)
  WHERE email_account_id IS NOT NULL AND internet_message_id IS NOT NULL;
