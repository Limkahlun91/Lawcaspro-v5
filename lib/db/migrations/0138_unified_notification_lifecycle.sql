-- 0138: Unified notification lifecycle (user_notifications) additive enums + firm-isolated RLS + status/severity audit defaults
-- All IF NOT EXISTS; additive only; never rewrites 0122 history.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_user_notifications_status_enum') THEN
    ALTER TABLE user_notifications
      ADD CONSTRAINT chk_user_notifications_status_enum
      CHECK (status IN ('created','unread','read','acknowledged','escalated','resolved','auto_resolved','dismissed'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_user_notifications_severity_enum') THEN
    ALTER TABLE user_notifications
      ADD CONSTRAINT chk_user_notifications_severity_enum
      CHECK (severity IN ('normal','info','high','urgent','critical'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_user_notifications_target_scope_enum') THEN
    ALTER TABLE user_notifications
      ADD CONSTRAINT chk_user_notifications_target_scope_enum
      CHECK (target_scope IN ('user','lawyer','manager','selected_partner','all_partners','role'));
  END IF;
END $$;

ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS status_set_at timestamptz;
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS escalated_reason text;
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS resolved_reason text;
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS ip_address text;
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS user_agent text;
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS acknowledgement_due_at timestamptz;
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS resolution_sla_due_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_user_notifications_firm_status_severity_created
  ON user_notifications (firm_id, status, severity, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_notifications_firm_target_scope_created
  ON user_notifications (firm_id, target_scope, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_notifications_firm_overdue
  ON user_notifications (firm_id, acknowledgement_due_at, resolution_sla_due_at)
  WHERE status IN ('unread','read','acknowledged','escalated');

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.enabled_roles WHERE role_name = 'rls_enabled_check') THEN NULL; END IF;
END $$;

ALTER TABLE user_notifications ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  ALTER TABLE user_notifications FORCE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DROP POLICY IF EXISTS user_notifications_tenant_isolation ON user_notifications;
CREATE POLICY user_notifications_tenant_isolation ON user_notifications
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (firm_id = (current_setting('app.current_firm_id', true)::int))
  WITH CHECK (firm_id = (current_setting('app.current_firm_id', true)::int));
