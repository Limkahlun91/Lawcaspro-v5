CREATE INDEX IF NOT EXISTS idx_cases_firm_approval_deleted
  ON cases (firm_id, approval_status, deleted_at);

