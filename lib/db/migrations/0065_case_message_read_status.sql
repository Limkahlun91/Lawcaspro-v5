-- Case message read status (per staff user per case)
-- Used to compute unread client portal messages on Case → Client Interaction tab.

CREATE TABLE IF NOT EXISTS case_message_read_status (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  case_id integer NOT NULL,
  user_id integer NOT NULL,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_case_message_read_status_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE,
  CONSTRAINT fk_case_message_read_status_case FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE,
  CONSTRAINT fk_case_message_read_status_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS case_message_read_status_firm_case_user_key
  ON case_message_read_status (firm_id, case_id, user_id);

CREATE INDEX IF NOT EXISTS idx_case_message_read_status_firm_user
  ON case_message_read_status (firm_id, user_id);

CREATE INDEX IF NOT EXISTS idx_case_message_read_status_firm_case
  ON case_message_read_status (firm_id, case_id);

