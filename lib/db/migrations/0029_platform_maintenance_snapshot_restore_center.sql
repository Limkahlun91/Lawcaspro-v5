CREATE TABLE IF NOT EXISTS platform_snapshot_retention_policies (
  code text PRIMARY KEY,
  label text NOT NULL,
  retention_days integer NOT NULL,
  is_protected boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform_snapshot_retention_policies (code, label, retention_days, is_protected)
VALUES
  ('pre_action', 'Pre-action snapshots', 30, false),
  ('pre_restore', 'Pre-restore snapshots', 30, false),
  ('manual', 'Manual snapshots', 90, false),
  ('scheduled_daily', 'Scheduled daily snapshots', 14, false),
  ('scheduled_weekly', 'Scheduled weekly snapshots', 56, false),
  ('scheduled_monthly', 'Scheduled monthly snapshots', 180, false),
  ('incident_recovery', 'Incident recovery snapshots', 180, true),
  ('system_baseline', 'System baseline snapshots', 180, true)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS platform_snapshots (
  id uuid PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id),
  snapshot_type text NOT NULL,
  scope_type text NOT NULL,
  module_code text,
  target_entity_type text,
  target_entity_id text,
  target_label text,
  trigger_type text NOT NULL,
  trigger_action_code text,
  created_by_user_id integer REFERENCES users(id),
  created_by_email text,
  reason text,
  note text,
  status text NOT NULL DEFAULT 'completed',
  integrity_status text NOT NULL DEFAULT 'unverified',
  schema_version text,
  app_version text,
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  expires_at timestamptz,
  retention_policy_code text REFERENCES platform_snapshot_retention_policies(code),
  size_bytes integer,
  storage_driver text NOT NULL DEFAULT 'db',
  storage_path text,
  payload_storage_key text,
  payload_json jsonb,
  item_counts_json jsonb,
  metadata_json jsonb,
  checksum text,
  restorable boolean NOT NULL DEFAULT true,
  restore_notes text,
  last_accessed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_snapshots_status_check CHECK (status IN ('pending','running','completed','failed','partial','expired','deleted')),
  CONSTRAINT platform_snapshots_integrity_check CHECK (integrity_status IN ('valid','invalid','unverified','corrupted')),
  CONSTRAINT platform_snapshots_storage_check CHECK (storage_driver IN ('db','supabase'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_snapshots_payload_storage_key ON platform_snapshots(payload_storage_key) WHERE payload_storage_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_platform_snapshots_firm_created_at ON platform_snapshots(firm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_snapshots_type_created_at ON platform_snapshots(snapshot_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_snapshots_module_created_at ON platform_snapshots(module_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_snapshots_target ON platform_snapshots(target_entity_type, target_entity_id);
CREATE INDEX IF NOT EXISTS idx_platform_snapshots_trigger_created_at ON platform_snapshots(trigger_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_snapshots_status_created_at ON platform_snapshots(status, created_at DESC);

ALTER TABLE platform_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_snapshots_access ON platform_snapshots;
CREATE POLICY platform_snapshots_access ON platform_snapshots FOR ALL TO PUBLIC
  USING (current_setting('app.is_founder', true) = 'true')
  WITH CHECK (current_setting('app.is_founder', true) = 'true');

CREATE TABLE IF NOT EXISTS platform_snapshot_items (
  id serial PRIMARY KEY,
  snapshot_id uuid NOT NULL REFERENCES platform_snapshots(id),
  firm_id integer NOT NULL REFERENCES firms(id),
  item_type text NOT NULL,
  item_id text,
  item_label text,
  module_code text,
  state_hash text,
  payload_fragment jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_snapshot_items_snapshot ON platform_snapshot_items(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_platform_snapshot_items_firm_type ON platform_snapshot_items(firm_id, item_type);
CREATE INDEX IF NOT EXISTS idx_platform_snapshot_items_item ON platform_snapshot_items(item_type, item_id);

ALTER TABLE platform_snapshot_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_snapshot_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_snapshot_items_access ON platform_snapshot_items;
CREATE POLICY platform_snapshot_items_access ON platform_snapshot_items FOR ALL TO PUBLIC
  USING (current_setting('app.is_founder', true) = 'true')
  WITH CHECK (current_setting('app.is_founder', true) = 'true');

CREATE TABLE IF NOT EXISTS platform_maintenance_actions (
  id uuid PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id),
  action_code text NOT NULL,
  scope_type text NOT NULL,
  module_code text,
  target_entity_type text,
  target_entity_id text,
  target_label text,
  risk_level text NOT NULL,
  status text NOT NULL,
  requires_snapshot boolean NOT NULL DEFAULT false,
  pre_action_snapshot_id uuid REFERENCES platform_snapshots(id),
  reason text NOT NULL,
  typed_confirmation text,
  preview_payload jsonb,
  execution_payload jsonb,
  result_payload jsonb,
  error_code text,
  error_message text,
  requested_by_user_id integer NOT NULL REFERENCES users(id),
  requested_by_email text,
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_maint_risk_check CHECK (risk_level IN ('low','medium','high','critical')),
  CONSTRAINT platform_maint_status_check CHECK (status IN ('previewed','snapshotting','queued','running','completed','failed','cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_platform_maint_actions_firm_created_at ON platform_maintenance_actions(firm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_maint_actions_code_created_at ON platform_maintenance_actions(action_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_maint_actions_status_created_at ON platform_maintenance_actions(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_maint_actions_target ON platform_maintenance_actions(target_entity_type, target_entity_id);
CREATE INDEX IF NOT EXISTS idx_platform_maint_actions_snapshot ON platform_maintenance_actions(pre_action_snapshot_id);

ALTER TABLE platform_maintenance_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_maintenance_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_maintenance_actions_access ON platform_maintenance_actions;
CREATE POLICY platform_maintenance_actions_access ON platform_maintenance_actions FOR ALL TO PUBLIC
  USING (current_setting('app.is_founder', true) = 'true')
  WITH CHECK (current_setting('app.is_founder', true) = 'true');

CREATE TABLE IF NOT EXISTS platform_maintenance_action_steps (
  id serial PRIMARY KEY,
  action_id uuid NOT NULL REFERENCES platform_maintenance_actions(id),
  step_code text NOT NULL,
  step_order integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'queued',
  started_at timestamptz,
  completed_at timestamptz,
  result_payload jsonb,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_maint_action_steps_action ON platform_maintenance_action_steps(action_id);
CREATE INDEX IF NOT EXISTS idx_platform_maint_action_steps_status ON platform_maintenance_action_steps(status);

ALTER TABLE platform_maintenance_action_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_maintenance_action_steps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_maintenance_action_steps_access ON platform_maintenance_action_steps;
CREATE POLICY platform_maintenance_action_steps_access ON platform_maintenance_action_steps FOR ALL TO PUBLIC
  USING (current_setting('app.is_founder', true) = 'true')
  WITH CHECK (current_setting('app.is_founder', true) = 'true');

CREATE TABLE IF NOT EXISTS platform_restore_actions (
  id uuid PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id),
  snapshot_id uuid NOT NULL REFERENCES platform_snapshots(id),
  restore_scope_type text NOT NULL,
  module_code text,
  target_entity_type text,
  target_entity_id text,
  target_label text,
  risk_level text NOT NULL,
  status text NOT NULL,
  reason text NOT NULL,
  typed_confirmation text,
  preview_payload jsonb,
  execution_payload jsonb,
  result_payload jsonb,
  error_code text,
  error_message text,
  requested_by_user_id integer NOT NULL REFERENCES users(id),
  requested_by_email text,
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_restore_risk_check CHECK (risk_level IN ('low','medium','high','critical')),
  CONSTRAINT platform_restore_status_check CHECK (status IN ('previewed','queued','running','completed','failed','cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_platform_restore_actions_firm_created_at ON platform_restore_actions(firm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_restore_actions_snapshot ON platform_restore_actions(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_platform_restore_actions_status_created_at ON platform_restore_actions(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_restore_actions_target ON platform_restore_actions(target_entity_type, target_entity_id);

ALTER TABLE platform_restore_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_restore_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_restore_actions_access ON platform_restore_actions;
CREATE POLICY platform_restore_actions_access ON platform_restore_actions FOR ALL TO PUBLIC
  USING (current_setting('app.is_founder', true) = 'true')
  WITH CHECK (current_setting('app.is_founder', true) = 'true');

CREATE TABLE IF NOT EXISTS platform_restore_action_steps (
  id serial PRIMARY KEY,
  restore_action_id uuid NOT NULL REFERENCES platform_restore_actions(id),
  step_code text NOT NULL,
  step_order integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'queued',
  started_at timestamptz,
  completed_at timestamptz,
  result_payload jsonb,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_restore_action_steps_action ON platform_restore_action_steps(restore_action_id);
CREATE INDEX IF NOT EXISTS idx_platform_restore_action_steps_status ON platform_restore_action_steps(status);

ALTER TABLE platform_restore_action_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_restore_action_steps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_restore_action_steps_access ON platform_restore_action_steps;
CREATE POLICY platform_restore_action_steps_access ON platform_restore_action_steps FOR ALL TO PUBLIC
  USING (current_setting('app.is_founder', true) = 'true')
  WITH CHECK (current_setting('app.is_founder', true) = 'true');

CREATE INDEX IF NOT EXISTS idx_audit_created_at_id_desc ON audit_logs(created_at DESC, id DESC);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_by integer REFERENCES users(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_reason text;
CREATE INDEX IF NOT EXISTS idx_projects_firm_archived_at ON projects(firm_id, archived_at DESC);

