-- Migration 0133: HR Approval Subsystem + HR Settings (Phase 1 M6)
-- HR Approval Engine (NOT sharing approval_process name/prefix with Accounting).
-- HR processes use HR_* prefix only. Accounting continues with ACCOUNTING_* names.
-- Supports: single / sequential / any_one / all_required approver modes,
-- delegation, reassignment, withdrawal, rejection, resubmission, overdue,
-- reminder, escalation.

CREATE TABLE IF NOT EXISTS hr_approval_process_definitions (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  process_code text NOT NULL,
  process_name text NOT NULL,
  process_module text NOT NULL,
  process_version integer NOT NULL DEFAULT 1,
  approval_mode text NOT NULL DEFAULT 'sequential',
  steps_config jsonb NOT NULL DEFAULT '[]'::jsonb,
  default_final_approver_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  allow_delegation boolean NOT NULL DEFAULT true,
  allow_reassignment boolean NOT NULL DEFAULT true,
  allow_withdrawal boolean NOT NULL DEFAULT true,
  allow_resubmission boolean NOT NULL DEFAULT true,
  max_resubmissions integer NOT NULL DEFAULT 5,
  overdue_after_hours integer,
  escalation_after_hours integer,
  reminder_frequency_hours integer,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_approval_proc_firm_code_version
  ON hr_approval_process_definitions (firm_id, process_code, process_version);
CREATE INDEX IF NOT EXISTS idx_hr_approval_proc_active
  ON hr_approval_process_definitions (firm_id, process_module, is_active);

ALTER TABLE hr_approval_process_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_approval_process_definitions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hr_approval_process_definitions_rw ON hr_approval_process_definitions;
CREATE POLICY hr_approval_process_definitions_rw ON hr_approval_process_definitions FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

CREATE TABLE IF NOT EXISTS hr_approval_requests (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  request_no text NOT NULL,
  process_definition_id integer NOT NULL REFERENCES hr_approval_process_definitions(id) ON DELETE RESTRICT,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  title text NOT NULL,
  description text,
  submission_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  overall_status text NOT NULL DEFAULT 'draft',
  submitted_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  submitted_at timestamptz,
  current_step_number integer NOT NULL DEFAULT 1,
  total_steps integer NOT NULL DEFAULT 1,
  withdrawn_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  withdrawn_at timestamptz,
  final_decision text,
  final_decided_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  final_decided_at timestamptz,
  client_request_id text,
  due_at timestamptz,
  escalation_level integer NOT NULL DEFAULT 0,
  last_reminder_sent_at timestamptz,
  last_escalated_at timestamptz,
  resubmission_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_approval_requests_firm_no
  ON hr_approval_requests (firm_id, request_no);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_approval_requests_aggregate
  ON hr_approval_requests (firm_id, aggregate_type, aggregate_id)
  WHERE overall_status IN ('draft', 'submitted', 'in_progress', 'escalated', 'overdue');
CREATE INDEX IF NOT EXISTS idx_hr_approval_requests_status
  ON hr_approval_requests (firm_id, overall_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hr_approval_requests_submitter
  ON hr_approval_requests (firm_id, submitted_by_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hr_approval_requests_process
  ON hr_approval_requests (firm_id, process_definition_id);
CREATE INDEX IF NOT EXISTS idx_hr_approval_requests_overdue
  ON hr_approval_requests (firm_id, due_at)
  WHERE overall_status IN ('submitted', 'in_progress', 'escalated', 'overdue');

ALTER TABLE hr_approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_approval_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hr_approval_requests_rw ON hr_approval_requests;
CREATE POLICY hr_approval_requests_rw ON hr_approval_requests FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

CREATE TABLE IF NOT EXISTS hr_approval_request_steps (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  approval_request_id integer NOT NULL REFERENCES hr_approval_requests(id) ON DELETE CASCADE,
  step_number integer NOT NULL,
  step_label text,
  step_mode text NOT NULL DEFAULT 'any_one',
  required_approver_count integer NOT NULL DEFAULT 1,
  approver_role_requirements jsonb DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  assigned_approver_user_ids integer[] NOT NULL DEFAULT '{}',
  responded_approver_user_ids integer[] NOT NULL DEFAULT '{}',
  delegated_approver_user_ids integer[] NOT NULL DEFAULT '{}',
  delegated_from_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  delegation_used_id integer,
  reassigned_from_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  reassigned_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  reassigned_at timestamptz,
  responded_at timestamptz,
  decision text,
  decision_note text,
  decision_actor_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_approval_steps_req_step
  ON hr_approval_request_steps (firm_id, approval_request_id, step_number);
CREATE INDEX IF NOT EXISTS idx_hr_approval_steps_status
  ON hr_approval_request_steps (firm_id, status);

ALTER TABLE hr_approval_request_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_approval_request_steps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hr_approval_request_steps_rw ON hr_approval_request_steps;
CREATE POLICY hr_approval_request_steps_rw ON hr_approval_request_steps FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

CREATE TABLE IF NOT EXISTS hr_approval_delegations (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  delegator_user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delegate_user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_module text,
  scope_process_code text,
  scope_scope text NOT NULL DEFAULT 'all_hr_approvals',
  valid_from date NOT NULL,
  valid_to date,
  reason text,
  delegation_status text NOT NULL DEFAULT 'active',
  activated_at timestamptz,
  expired_at timestamptz,
  revoked_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_hr_approval_delegator
  ON hr_approval_delegations (firm_id, delegator_user_id, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS idx_hr_approval_delegate
  ON hr_approval_delegations (firm_id, delegate_user_id, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS idx_hr_approval_delegation_status
  ON hr_approval_delegations (firm_id, delegation_status);

ALTER TABLE hr_approval_delegations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_approval_delegations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hr_approval_delegations_rw ON hr_approval_delegations;
CREATE POLICY hr_approval_delegations_rw ON hr_approval_delegations FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

CREATE TABLE IF NOT EXISTS hr_approval_action_logs (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  approval_request_id integer REFERENCES hr_approval_requests(id) ON DELETE SET NULL,
  approval_step_id integer REFERENCES hr_approval_request_steps(id) ON DELETE SET NULL,
  actor_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  acting_for_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  delegation_used_id integer REFERENCES hr_approval_delegations(id) ON DELETE SET NULL,
  action_type text NOT NULL,
  action_note text,
  action_payload jsonb DEFAULT '{}'::jsonb,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_approval_action_req
  ON hr_approval_action_logs (firm_id, approval_request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hr_approval_action_actor
  ON hr_approval_action_logs (firm_id, actor_user_id, created_at DESC);

ALTER TABLE hr_approval_action_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_approval_action_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hr_approval_action_logs_rw ON hr_approval_action_logs;
CREATE POLICY hr_approval_action_logs_rw ON hr_approval_action_logs FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );
