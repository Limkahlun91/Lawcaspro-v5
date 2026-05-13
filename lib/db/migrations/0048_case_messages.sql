-- Case messages (client portal + staff replies)
-- Sender type: 'client' | 'staff'

CREATE TABLE IF NOT EXISTS case_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id integer NOT NULL,
  case_id integer NOT NULL,
  sender_type text NOT NULL CHECK (sender_type IN ('client', 'staff')),
  sender_id integer,
  message_text text NOT NULL,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_case_messages_case FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE,
  CONSTRAINT fk_case_messages_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE,
  CONSTRAINT fk_case_messages_sender FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_case_messages_firm_case_created_at
  ON case_messages (firm_id, case_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_case_messages_case_created_at
  ON case_messages (case_id, created_at DESC);

