CREATE INDEX IF NOT EXISTS idx_case_workflow_steps_completed_step_key_case
  ON case_workflow_steps (step_key, case_id)
  WHERE status = 'completed';

CREATE INDEX IF NOT EXISTS idx_case_assignments_user_active_case
  ON case_assignments (user_id, case_id)
  WHERE unassigned_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cases_firm_active_id
  ON cases (firm_id, id)
  WHERE deleted_at IS NULL;

