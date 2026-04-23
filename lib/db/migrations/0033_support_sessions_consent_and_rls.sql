-- 0033_support_sessions_consent_and_rls.sql
-- Add firm-consent workflow + RLS for support sessions (explicit, time-bound access)

ALTER TABLE support_sessions
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'requested';

ALTER TABLE support_sessions
  ADD COLUMN IF NOT EXISTS approved_by_user_id integer REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE support_sessions
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

ALTER TABLE support_sessions
  ADD COLUMN IF NOT EXISTS rejected_by_user_id integer REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE support_sessions
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz;

ALTER TABLE support_sessions
  ADD COLUMN IF NOT EXISTS decision_note text;

ALTER TABLE support_sessions
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

DO $do$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'support_sessions_status_check'
  ) THEN
    ALTER TABLE support_sessions
      ADD CONSTRAINT support_sessions_status_check
      CHECK (status IN ('requested','approved','rejected','ended'));
  END IF;
END $do$;

CREATE INDEX IF NOT EXISTS idx_support_sessions_firm_status_started
  ON support_sessions (target_firm_id, status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_sessions_expires_at
  ON support_sessions (expires_at);

ALTER TABLE support_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_sessions FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS support_sessions_access ON support_sessions;
CREATE POLICY support_sessions_access ON support_sessions FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR target_firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR target_firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer
  );

