-- Split external case messages into channels: client vs developer

ALTER TABLE case_messages
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'client';

ALTER TABLE case_messages
  DROP CONSTRAINT IF EXISTS case_messages_channel_check;

ALTER TABLE case_messages
  ADD CONSTRAINT case_messages_channel_check
  CHECK (channel IN ('client', 'developer'));

CREATE INDEX IF NOT EXISTS idx_case_messages_firm_case_channel_created_at
  ON case_messages (firm_id, case_id, channel, created_at DESC);

