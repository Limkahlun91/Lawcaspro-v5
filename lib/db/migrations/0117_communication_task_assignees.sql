BEGIN;

CREATE TABLE IF NOT EXISTS communication_task_assignees (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  message_id integer NOT NULL,
  task_id integer NULL,
  user_id integer NOT NULL,
  assignment_role text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'assigned',
  assigned_by integer NULL,
  assigned_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_communication_task_assignees UNIQUE (message_id, task_id, user_id, assignment_role)
);

CREATE INDEX IF NOT EXISTS idx_communication_task_assignees_firm
  ON communication_task_assignees (firm_id);
CREATE INDEX IF NOT EXISTS idx_communication_task_assignees_message
  ON communication_task_assignees (firm_id, message_id);
CREATE INDEX IF NOT EXISTS idx_communication_task_assignees_task
  ON communication_task_assignees (firm_id, task_id);
CREATE INDEX IF NOT EXISTS idx_communication_task_assignees_user_role
  ON communication_task_assignees (firm_id, user_id, assignment_role);
CREATE INDEX IF NOT EXISTS idx_communication_task_assignees_user_status
  ON communication_task_assignees (firm_id, user_id, status);

ALTER TABLE communication_task_assignees ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_task_assignees FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON communication_task_assignees;
CREATE POLICY tenant_isolation ON communication_task_assignees FOR ALL TO PUBLIC
  USING (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  )
  WITH CHECK (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  );

COMMIT;

