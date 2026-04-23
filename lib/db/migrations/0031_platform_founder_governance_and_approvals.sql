-- Founder governance: roles/permissions + approval workflow + step-up challenges

CREATE TABLE IF NOT EXISTS platform_founder_roles (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  level text NOT NULL CHECK (level IN ('viewer', 'operator', 'admin', 'super_admin')),
  is_system boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_founder_roles_level ON platform_founder_roles(level);

CREATE TABLE IF NOT EXISTS platform_founder_role_permissions (
  id bigserial PRIMARY KEY,
  role_id uuid NOT NULL REFERENCES platform_founder_roles(id) ON DELETE CASCADE,
  permission_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(role_id, permission_code)
);

CREATE INDEX IF NOT EXISTS idx_platform_founder_role_permissions_role ON platform_founder_role_permissions(role_id);
CREATE INDEX IF NOT EXISTS idx_platform_founder_role_permissions_perm ON platform_founder_role_permissions(permission_code);

CREATE TABLE IF NOT EXISTS platform_founder_user_roles (
  id bigserial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES platform_founder_roles(id) ON DELETE CASCADE,
  assigned_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_founder_user_roles_user ON platform_founder_user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_platform_founder_user_roles_role ON platform_founder_user_roles(role_id);

CREATE TABLE IF NOT EXISTS platform_approval_requests (
  id uuid PRIMARY KEY,
  request_code text NOT NULL UNIQUE,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  action_code text NOT NULL,
  risk_level text NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  scope_type text NOT NULL CHECK (scope_type IN ('record', 'module', 'settings', 'firm')),
  module_code text NULL,
  target_entity_type text NULL,
  target_entity_id text NULL,
  target_label text NULL,
  snapshot_id uuid NULL REFERENCES platform_snapshots(id) ON DELETE SET NULL,
  operation_type text NOT NULL CHECK (operation_type IN ('maintenance_action', 'restore_action')),
  operation_id uuid NOT NULL,
  requested_by_user_id integer NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  requested_by_email text NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL,
  detailed_note text NULL,
  status text NOT NULL CHECK (status IN ('requested', 'approved', 'rejected', 'expired', 'cancelled', 'executed')) DEFAULT 'requested',
  approval_policy_code text NOT NULL,
  required_approvals integer NOT NULL DEFAULT 1,
  current_approvals integer NOT NULL DEFAULT 0,
  self_approval_allowed boolean NOT NULL DEFAULT false,
  expires_at timestamptz NULL,
  approved_at timestamptz NULL,
  rejected_at timestamptz NULL,
  cancelled_at timestamptz NULL,
  executed_at timestamptz NULL,
  emergency_flag boolean NOT NULL DEFAULT false,
  impersonation_flag boolean NOT NULL DEFAULT false,
  policy_result_json jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_approval_requests_firm_created_at ON platform_approval_requests(firm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_approval_requests_status_created_at ON platform_approval_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_approval_requests_operation ON platform_approval_requests(operation_type, operation_id);
CREATE INDEX IF NOT EXISTS idx_platform_approval_requests_action_created_at ON platform_approval_requests(action_code, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_approval_events (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES platform_approval_requests(id) ON DELETE CASCADE,
  actor_user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('approve', 'reject', 'override')),
  note text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_approval_events_request ON platform_approval_events(request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_approval_events_actor ON platform_approval_events(actor_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_step_up_challenges (
  id uuid PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  action_code text NOT NULL,
  risk_level text NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  scope_type text NOT NULL CHECK (scope_type IN ('record', 'module', 'settings', 'firm')),
  module_code text NULL,
  target_entity_type text NULL,
  target_entity_id text NULL,
  issued_to_user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_to_email text NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  not_before_at timestamptz NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NULL,
  consumed_by_user_id integer NULL REFERENCES users(id) ON DELETE SET NULL,
  required_phrase text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_step_up_challenges_firm_issued_at ON platform_step_up_challenges(firm_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_step_up_challenges_user_issued_at ON platform_step_up_challenges(issued_to_user_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_step_up_challenges_expires_at ON platform_step_up_challenges(expires_at);

ALTER TABLE platform_maintenance_actions
  ADD COLUMN IF NOT EXISTS approval_request_id uuid NULL REFERENCES platform_approval_requests(id) ON DELETE SET NULL;
ALTER TABLE platform_maintenance_actions
  ADD COLUMN IF NOT EXISTS step_up_confirmation text NULL;
CREATE INDEX IF NOT EXISTS idx_platform_maint_actions_approval_request ON platform_maintenance_actions(approval_request_id);

ALTER TABLE platform_restore_actions
  ADD COLUMN IF NOT EXISTS approval_request_id uuid NULL REFERENCES platform_approval_requests(id) ON DELETE SET NULL;
ALTER TABLE platform_restore_actions
  ADD COLUMN IF NOT EXISTS step_up_confirmation text NULL;
CREATE INDEX IF NOT EXISTS idx_platform_restore_actions_approval_request ON platform_restore_actions(approval_request_id);

ALTER TABLE platform_founder_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_founder_roles FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_founder_role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_founder_role_permissions FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_founder_user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_founder_user_roles FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_approval_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_approval_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_approval_events FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_step_up_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_step_up_challenges FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS founder_only ON platform_founder_roles;
CREATE POLICY founder_only ON platform_founder_roles FOR ALL TO PUBLIC
  USING (current_setting('app.is_founder', true) = 'true')
  WITH CHECK (current_setting('app.is_founder', true) = 'true');

DROP POLICY IF EXISTS founder_only ON platform_founder_role_permissions;
CREATE POLICY founder_only ON platform_founder_role_permissions FOR ALL TO PUBLIC
  USING (current_setting('app.is_founder', true) = 'true')
  WITH CHECK (current_setting('app.is_founder', true) = 'true');

DROP POLICY IF EXISTS founder_only ON platform_founder_user_roles;
CREATE POLICY founder_only ON platform_founder_user_roles FOR ALL TO PUBLIC
  USING (current_setting('app.is_founder', true) = 'true')
  WITH CHECK (current_setting('app.is_founder', true) = 'true');

DROP POLICY IF EXISTS founder_only ON platform_approval_requests;
CREATE POLICY founder_only ON platform_approval_requests FOR ALL TO PUBLIC
  USING (current_setting('app.is_founder', true) = 'true')
  WITH CHECK (current_setting('app.is_founder', true) = 'true');

DROP POLICY IF EXISTS founder_only ON platform_approval_events;
CREATE POLICY founder_only ON platform_approval_events FOR ALL TO PUBLIC
  USING (current_setting('app.is_founder', true) = 'true')
  WITH CHECK (current_setting('app.is_founder', true) = 'true');

DROP POLICY IF EXISTS founder_only ON platform_step_up_challenges;
CREATE POLICY founder_only ON platform_step_up_challenges FOR ALL TO PUBLIC
  USING (current_setting('app.is_founder', true) = 'true')
  WITH CHECK (current_setting('app.is_founder', true) = 'true');

-- Seed system founder roles + permissions
INSERT INTO platform_founder_roles (id, code, name, level, is_system)
VALUES
  ('1d3d1db7-5b58-4d83-a3f7-2c9e2f5a6c01', 'founder_viewer', 'Founder Viewer', 'viewer', true),
  ('1d3d1db7-5b58-4d83-a3f7-2c9e2f5a6c02', 'founder_operator', 'Founder Operator', 'operator', true),
  ('1d3d1db7-5b58-4d83-a3f7-2c9e2f5a6c03', 'founder_admin', 'Founder Admin', 'admin', true),
  ('1d3d1db7-5b58-4d83-a3f7-2c9e2f5a6c04', 'founder_super_admin', 'Founder Super Admin', 'super_admin', true)
ON CONFLICT (code) DO NOTHING;

-- Viewer permissions
INSERT INTO platform_founder_role_permissions (role_id, permission_code)
SELECT r.id, p.permission_code
FROM platform_founder_roles r
JOIN (VALUES
  ('founder.snapshot.read'),
  ('founder.snapshot.restore.preview'),
  ('founder.maintenance.read'),
  ('founder.recovery.preview'),
  ('founder.audit.read'),
  ('founder.policy.read')
) p(permission_code) ON true
WHERE r.code = 'founder_viewer'
ON CONFLICT (role_id, permission_code) DO NOTHING;

-- Operator permissions
INSERT INTO platform_founder_role_permissions (role_id, permission_code)
SELECT r.id, p.permission_code
FROM platform_founder_roles r
JOIN (VALUES
  ('founder.snapshot.read'),
  ('founder.snapshot.create'),
  ('founder.snapshot.restore.preview'),
  ('founder.snapshot.restore.execute'),
  ('founder.maintenance.read'),
  ('founder.maintenance.rebuild'),
  ('founder.maintenance.reset.record'),
  ('founder.approval.request'),
  ('founder.audit.read'),
  ('founder.policy.read')
) p(permission_code) ON true
WHERE r.code = 'founder_operator'
ON CONFLICT (role_id, permission_code) DO NOTHING;

-- Admin permissions
INSERT INTO platform_founder_role_permissions (role_id, permission_code)
SELECT r.id, p.permission_code
FROM platform_founder_roles r
JOIN (VALUES
  ('founder.snapshot.read'),
  ('founder.snapshot.create'),
  ('founder.snapshot.restore.preview'),
  ('founder.snapshot.restore.execute'),
  ('founder.maintenance.read'),
  ('founder.maintenance.rebuild'),
  ('founder.maintenance.reset.record'),
  ('founder.maintenance.reset.module'),
  ('founder.maintenance.reset.firm'),
  ('founder.approval.request'),
  ('founder.approval.review'),
  ('founder.approval.approve'),
  ('founder.approval.reject'),
  ('founder.audit.read'),
  ('founder.audit.export'),
  ('founder.policy.read')
) p(permission_code) ON true
WHERE r.code = 'founder_admin'
ON CONFLICT (role_id, permission_code) DO NOTHING;

-- Super Admin permissions
INSERT INTO platform_founder_role_permissions (role_id, permission_code)
SELECT r.id, p.permission_code
FROM platform_founder_roles r
JOIN (VALUES
  ('founder.snapshot.read'),
  ('founder.snapshot.create'),
  ('founder.snapshot.restore.preview'),
  ('founder.snapshot.restore.execute'),
  ('founder.snapshot.restore.critical'),
  ('founder.snapshot.delete'),
  ('founder.snapshot.pin'),
  ('founder.maintenance.read'),
  ('founder.maintenance.rebuild'),
  ('founder.maintenance.reset.record'),
  ('founder.maintenance.reset.module'),
  ('founder.maintenance.reset.firm'),
  ('founder.maintenance.reset.platform'),
  ('founder.maintenance.clear.generated'),
  ('founder.maintenance.bulk.execute'),
  ('founder.recovery.preview'),
  ('founder.recovery.execute'),
  ('founder.recovery.rollback'),
  ('founder.recovery.critical'),
  ('founder.approval.request'),
  ('founder.approval.review'),
  ('founder.approval.approve'),
  ('founder.approval.reject'),
  ('founder.approval.override'),
  ('founder.approval.emergency'),
  ('founder.policy.read'),
  ('founder.policy.manage'),
  ('founder.retention.manage'),
  ('founder.audit.read'),
  ('founder.audit.export')
) p(permission_code) ON true
WHERE r.code = 'founder_super_admin'
ON CONFLICT (role_id, permission_code) DO NOTHING;

-- Bootstrap: map the primary founder account to Founder Super Admin (existing codebase has a single founder email gate)
INSERT INTO platform_founder_user_roles (user_id, role_id, assigned_by_user_id)
SELECT u.id, r.id, u.id
FROM users u
JOIN platform_founder_roles r ON r.code = 'founder_super_admin'
WHERE u.user_type = 'founder'
  AND lower(trim(u.email)) = 'lun.6923@hotmail.com'
ON CONFLICT (user_id, role_id) DO NOTHING;
