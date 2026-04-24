-- 0035_platform_incident_center.sql
-- Founder Incident Center: incidents + notes

CREATE TABLE IF NOT EXISTS platform_incidents (
  id uuid PRIMARY KEY,
  incident_code text NOT NULL,
  title text NOT NULL,
  incident_type text NOT NULL,
  severity text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  source_event_id text,
  source_operation_id uuid,
  firm_id int NOT NULL,
  module_code text,
  entity_type text,
  entity_id text,
  snapshot_id uuid,
  related_request_id uuid,
  summary text,
  technical_summary text,
  user_impact_summary text,
  suggested_action_code text,
  suggested_snapshot_id uuid,
  detected_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by int,
  resolved_at timestamptz,
  resolved_by int,
  resolution_note text,
  aggregation_key text NOT NULL,
  last_event_at timestamptz,
  event_count int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_incident_notes (
  id uuid PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES platform_incidents(id) ON DELETE CASCADE,
  author_user_id int NOT NULL,
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_incidents_severity_check') THEN
    ALTER TABLE platform_incidents
      ADD CONSTRAINT platform_incidents_severity_check
      CHECK (severity IN ('low','medium','high','critical'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_incidents_status_check') THEN
    ALTER TABLE platform_incidents
      ADD CONSTRAINT platform_incidents_status_check
      CHECK (status IN ('open','investigating','awaiting-approval','awaiting-execution','mitigated','resolved','dismissed'));
  END IF;
END $do$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_incidents_code
  ON platform_incidents (incident_code);

CREATE INDEX IF NOT EXISTS idx_platform_incidents_firm_status
  ON platform_incidents (firm_id, status, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_incidents_status_severity
  ON platform_incidents (status, severity, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_incidents_module
  ON platform_incidents (module_code, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_incidents_aggregation
  ON platform_incidents (aggregation_key);

CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_incidents_open_aggregation
  ON platform_incidents (aggregation_key)
  WHERE status IN ('open','investigating','awaiting-approval','awaiting-execution');

CREATE INDEX IF NOT EXISTS idx_platform_incident_notes_incident
  ON platform_incident_notes (incident_id, created_at DESC);
