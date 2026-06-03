-- 0101_case_creation_approval_schema.sql
-- Make core "cases" fields nullable to support pending approval flow.
-- Add explicit approval status tracking fields and checks.

ALTER TABLE cases
  ALTER COLUMN reference_no DROP NOT NULL;

ALTER TABLE cases
  ALTER COLUMN project_id DROP NOT NULL;

ALTER TABLE cases
  ALTER COLUMN developer_id DROP NOT NULL;

ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'pending_approval',
  ADD COLUMN IF NOT EXISTS approved_by integer,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approval_note text,
  ADD COLUMN IF NOT EXISTS acting_for text,
  ADD COLUMN IF NOT EXISTS perfection_type text;

DO $do$
DECLARE
  has_created_at boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'cases'
      AND column_name = 'created_at'
  )
  INTO has_created_at;

  IF has_created_at THEN
    EXECUTE $sql$
      UPDATE cases
      SET
        approval_status = 'approved',
        approved_at = COALESCE(approved_at, created_at, now())
      WHERE reference_no IS NOT NULL
        AND (approval_status IS NULL OR approval_status = 'pending_approval')
    $sql$;
  ELSE
    EXECUTE $sql$
      UPDATE cases
      SET
        approval_status = 'approved',
        approved_at = COALESCE(approved_at, now())
      WHERE reference_no IS NOT NULL
        AND (approval_status IS NULL OR approval_status = 'pending_approval')
    $sql$;
  END IF;
END
$do$;

ALTER TABLE cases
  DROP CONSTRAINT IF EXISTS cases_approval_status_check;

ALTER TABLE cases
  ADD CONSTRAINT cases_approval_status_check
  CHECK (approval_status IN ('pending_approval','approved','rejected','needs_correction'));

ALTER TABLE cases
  DROP CONSTRAINT IF EXISTS cases_acting_for_check;

ALTER TABLE cases
  ADD CONSTRAINT cases_acting_for_check
  CHECK (acting_for IS NULL OR acting_for IN ('vendor','purchaser','both'));

ALTER TABLE cases
  DROP CONSTRAINT IF EXISTS cases_perfection_type_check;

ALTER TABLE cases
  ADD CONSTRAINT cases_perfection_type_check
  CHECK (perfection_type IS NULL OR perfection_type IN ('transfer_and_charge','transfer','charge'));
