-- 0140_notification_resolution_mode_and_dedupe.sql
-- Corrective additive migration (Tier 2 PART 1)
-- Purpose:
--   * resolution_mode (MANUAL_ALLOWED / AUTO_ONLY) for locked operational escalations
--     such as PV_OVERDUE_PARTNER_ESCALATION
--   * rule_code / correlation_id / entity_type / entity_id global event identity
--     to permit per-recipient rows without duplicate badges (Partner-recipient isolation)
--   * last_notified_at / next_notify_at / delivery_count for 2-hour reminder dedupe
--   * event_* timestamps shared across recipients (event_escalated_at / event_resolved_at / event_auto_resolved_at)
--
-- All IF NOT EXISTS; additive only; Destructive=0;
-- MUST be applied AFTER 0138_unified_notification_lifecycle.sql
--
-- Intended final number: 0147 (post-bundle) OR applied after 0136→0143, 0137→0144, 0138→0145, 0139→0146

DO $$ BEGIN END $$;

ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS resolution_mode text NOT NULL DEFAULT 'MANUAL_ALLOWED';
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS rule_code text;
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS correlation_id text;
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS entity_type text;
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS entity_id integer;
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS last_notified_at timestamptz;
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS next_notify_at timestamptz;
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS delivery_count integer NOT NULL DEFAULT 1;
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS event_resolved_at timestamptz;
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS event_auto_resolved_at timestamptz;
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS event_escalated_at timestamptz;
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT NOW();

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_user_notifications_resolution_mode_enum') THEN
    ALTER TABLE user_notifications
      ADD CONSTRAINT chk_user_notifications_resolution_mode_enum
      CHECK (resolution_mode IN ('MANUAL_ALLOWED','AUTO_ONLY'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_user_notifications_active_identity_no_uniq') THEN
    NULL; -- skip: UNIQUE constraints added via partial index below to allow multi-row history.
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_user_notifications_firm_correlation
  ON user_notifications (firm_id, correlation_id)
  WHERE correlation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_user_notifications_firm_rule_code
  ON user_notifications (firm_id, rule_code, user_id, created_at DESC)
  WHERE rule_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_user_notifications_firm_next_notify
  ON user_notifications (firm_id, next_notify_at, status)
  WHERE next_notify_at IS NOT NULL
    AND status IN ('unread','read','acknowledged','escalated');

-- Unique active identity per (firm_id, entity_type, entity_id, rule_code, user_id, active-statuses)
-- Partial UNIQUE: at most ONE active row per recipient per rule
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_notifications_active_identity
  ON user_notifications (firm_id, coalesce(entity_type,''), coalesce(entity_id,0), coalesce(rule_code,''), user_id)
  WHERE status IN ('unread','read','acknowledged','escalated');
