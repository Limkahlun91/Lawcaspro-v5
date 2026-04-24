-- 0034_platform_restore_rollback_and_record_restore.sql
-- Add rollback/undo tracking + record-level restore metadata to platform_restore_actions

ALTER TABLE platform_restore_actions
  ADD COLUMN IF NOT EXISTS operation_code text NOT NULL DEFAULT 'restore_snapshot';

ALTER TABLE platform_restore_actions
  ADD COLUMN IF NOT EXISTS pre_restore_snapshot_id uuid;

ALTER TABLE platform_restore_actions
  ADD COLUMN IF NOT EXISTS rollback_source_restore_action_id uuid;

DO $do$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'platform_restore_actions_operation_code_check'
  ) THEN
    ALTER TABLE platform_restore_actions
      ADD CONSTRAINT platform_restore_actions_operation_code_check
      CHECK (operation_code IN ('restore_snapshot','rollback_restore'));
  END IF;
END $do$;

CREATE INDEX IF NOT EXISTS idx_platform_restore_actions_firm_op_created
  ON platform_restore_actions (firm_id, operation_code, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_restore_actions_pre_restore_snapshot_id
  ON platform_restore_actions (pre_restore_snapshot_id);

CREATE INDEX IF NOT EXISTS idx_platform_restore_actions_rollback_source
  ON platform_restore_actions (rollback_source_restore_action_id);

