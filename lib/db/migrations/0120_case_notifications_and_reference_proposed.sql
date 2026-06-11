BEGIN;

ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS proposed_reference_no text;

ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS reference_no_changed_by integer;
ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS reference_no_changed_at timestamptz;
ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS reference_no_change_reason text;

DO $do$ BEGIN
  IF to_regclass('public.users') IS NOT NULL THEN
    BEGIN
      ALTER TABLE cases
        ADD CONSTRAINT fk_cases_reference_no_changed_by
        FOREIGN KEY (reference_no_changed_by) REFERENCES users(id) ON DELETE SET NULL;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $do$;

CREATE TABLE IF NOT EXISTS case_notifications (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  case_id integer NOT NULL,
  recipient_user_id integer NOT NULL,
  actor_user_id integer NULL,
  type text NOT NULL,
  title text NOT NULL,
  message text NULL,
  meta jsonb NULL,
  is_read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz NULL,
  CONSTRAINT fk_case_notifications_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE,
  CONSTRAINT fk_case_notifications_case FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE,
  CONSTRAINT fk_case_notifications_recipient_user FOREIGN KEY (recipient_user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_case_notifications_actor_user FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_case_notifications_firm_recipient_created_at
  ON case_notifications (firm_id, recipient_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_case_notifications_firm_recipient_unread
  ON case_notifications (firm_id, recipient_user_id, is_read, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_case_notifications_firm_recipient_type_unread
  ON case_notifications (firm_id, recipient_user_id, type, is_read);

CREATE INDEX IF NOT EXISTS idx_case_notifications_firm_case
  ON case_notifications (firm_id, case_id);

ALTER TABLE case_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_notifications FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON case_notifications;
CREATE POLICY tenant_isolation ON case_notifications FOR ALL TO PUBLIC
  USING (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  )
  WITH CHECK (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::int
    OR current_setting('app.is_founder', true) = 'true'
  );

DO $do$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $do$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE public.case_notifications TO app_user;

SELECT pg_notify('pgrst', 'reload schema');

COMMIT;
