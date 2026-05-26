ALTER TABLE IF EXISTS case_key_dates
  ADD COLUMN IF NOT EXISTS completion_sla_activated_at timestamptz,
  ADD COLUMN IF NOT EXISTS completion_sla_notified_48h_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_case_key_dates_completion_sla_active
  ON case_key_dates (firm_id, completion_sla_activated_at)
  WHERE completion_sla_activated_at IS NOT NULL;

ALTER TABLE IF EXISTS document_generation_runs
  ADD COLUMN IF NOT EXISTS request_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS started_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_document_generation_runs_pending
  ON document_generation_runs (firm_id, status, triggered_at)
  WHERE status IN ('pending', 'running');

