-- Migration 0132: HRMS User↔Employee Bridge + Per-Firm HR Feature Flags (Phase 1 M5)
-- Per Part 1 §2: User ≠ Employee. A user may be employee of multiple firms.
-- A single firm maps at most one user_id to exactly one employee_id.

CREATE TABLE IF NOT EXISTS hr_user_employee_memberships (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_id integer NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  membership_type text NOT NULL DEFAULT 'employee',
  linked_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  unlinked_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  unlinked_at timestamptz,
  link_note text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_membership_firm_user
  ON hr_user_employee_memberships (firm_id, user_id)
  WHERE is_active = true;
CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_membership_firm_employee
  ON hr_user_employee_memberships (firm_id, employee_id)
  WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_hr_membership_user
  ON hr_user_employee_memberships (user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_hr_membership_status
  ON hr_user_employee_memberships (firm_id, is_active);

ALTER TABLE hr_user_employee_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_user_employee_memberships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hr_user_employee_memberships_rw ON hr_user_employee_memberships;
CREATE POLICY hr_user_employee_memberships_rw ON hr_user_employee_memberships FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

CREATE TABLE IF NOT EXISTS hr_firm_feature_flags (
  firm_id integer PRIMARY KEY REFERENCES firms(id) ON DELETE CASCADE,
  hr_enabled boolean NOT NULL DEFAULT false,
  hr_attendance_enabled boolean NOT NULL DEFAULT false,
  hr_payroll_enabled boolean NOT NULL DEFAULT false,
  hr_recruitment_enabled boolean NOT NULL DEFAULT false,
  hr_performance_enabled boolean NOT NULL DEFAULT false,
  hr_case_workload_enabled boolean NOT NULL DEFAULT false,
  hr_claims_enabled boolean NOT NULL DEFAULT true,
  hr_leave_enabled boolean NOT NULL DEFAULT true,
  hr_documents_enabled boolean NOT NULL DEFAULT true,
  hr_self_service_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1
);

ALTER TABLE hr_firm_feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_firm_feature_flags FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hr_firm_feature_flags_rw ON hr_firm_feature_flags;
CREATE POLICY hr_firm_feature_flags_rw ON hr_firm_feature_flags FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

INSERT INTO hr_firm_feature_flags (firm_id, created_at, updated_at)
SELECT id, now(), now()
FROM firms
ON CONFLICT (firm_id) DO NOTHING;

DO $$
BEGIN
  ALTER TABLE public.hr_firm_feature_flags
    ALTER COLUMN hr_attendance_enabled SET DEFAULT false;
  ALTER TABLE public.hr_firm_feature_flags
    ALTER COLUMN hr_claims_enabled SET DEFAULT false;
  ALTER TABLE public.hr_firm_feature_flags
    ALTER COLUMN hr_leave_enabled SET DEFAULT false;
  ALTER TABLE public.hr_firm_feature_flags
    ALTER COLUMN hr_documents_enabled SET DEFAULT false;
  ALTER TABLE public.hr_firm_feature_flags
    ALTER COLUMN hr_self_service_enabled SET DEFAULT false;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS hr_employee_position_authorizations (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  employee_id integer NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  authorization_scope text NOT NULL,
  authorization_level text NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  granted_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_hr_pos_auth_emp
  ON hr_employee_position_authorizations (firm_id, employee_id, effective_from DESC, effective_to);

ALTER TABLE hr_employee_position_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_employee_position_authorizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hr_employee_position_authorizations_rw ON hr_employee_position_authorizations;
CREATE POLICY hr_employee_position_authorizations_rw ON hr_employee_position_authorizations FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );
