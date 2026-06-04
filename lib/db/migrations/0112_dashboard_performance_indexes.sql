CREATE INDEX IF NOT EXISTS idx_cases_firm_approval_deleted_updated_at
  ON cases (firm_id, approval_status, deleted_at, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_case_key_dates_firm_completion_date
  ON case_key_dates (firm_id, completion_date)
  WHERE completion_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_case_key_dates_firm_completion_sla_activated
  ON case_key_dates (firm_id, completion_sla_activated_at)
  WHERE completion_sla_activated_at IS NOT NULL AND advice_to_bank_date IS NULL;

CREATE INDEX IF NOT EXISTS idx_case_communications_firm_created_at
  ON case_communications (firm_id, created_at);
