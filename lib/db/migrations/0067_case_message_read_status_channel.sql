-- Add channel awareness to per-user read status for case messages

ALTER TABLE case_message_read_status
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'client';

ALTER TABLE case_message_read_status
  DROP CONSTRAINT IF EXISTS case_message_read_status_channel_check;

ALTER TABLE case_message_read_status
  ADD CONSTRAINT case_message_read_status_channel_check
  CHECK (channel IN ('client', 'developer'));

DROP INDEX IF EXISTS case_message_read_status_firm_case_user_key;

CREATE UNIQUE INDEX IF NOT EXISTS case_message_read_status_firm_case_user_key
  ON case_message_read_status (firm_id, case_id, user_id, channel);

