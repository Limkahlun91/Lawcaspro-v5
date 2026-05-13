UPDATE case_workflow_steps
SET step_order = step_order + 1,
    updated_at = now()
WHERE path_type = 'loan'
  AND step_key IN (
    'loan_pending_bank_exec',
    'loan_sent_bank_exec',
    'loan_bank_executed',
    'blu_received',
    'blu_confirmed'
  );

INSERT INTO case_workflow_steps (
  case_id,
  step_key,
  step_name,
  step_order,
  status,
  path_type,
  created_at,
  updated_at
)
SELECT
  c.id,
  'advised',
  'Advised',
  8,
  'pending',
  'loan',
  now(),
  now()
FROM cases c
WHERE c.purchase_mode = 'loan'
  AND NOT EXISTS (
    SELECT 1
    FROM case_workflow_steps s
    WHERE s.case_id = c.id
      AND s.step_key = 'advised'
  );

