ALTER TABLE payment_vouchers
  ADD COLUMN IF NOT EXISTS received_by integer NULL,
  ADD COLUMN IF NOT EXISTS received_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS assigned_account_user_id integer NULL,
  ADD COLUMN IF NOT EXISTS payment_due_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS sla_policy_snapshot jsonb NULL,
  ADD COLUMN IF NOT EXISTS due_soon_notified_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS overdue_notified_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS breached_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS deadline_override_reason text NULL,
  ADD COLUMN IF NOT EXISTS deadline_overridden_by integer NULL,
  ADD COLUMN IF NOT EXISTS deadline_overridden_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS paid_amount numeric(18,2) NULL,
  ADD COLUMN IF NOT EXISTS proof_document_path text NULL,
  ADD COLUMN IF NOT EXISTS next_action_type text NULL,
  ADD COLUMN IF NOT EXISTS next_action_custom text NULL,
  ADD COLUMN IF NOT EXISTS next_action_remarks text NULL,
  ADD COLUMN IF NOT EXISTS assigned_clerk_user_id integer NULL,
  ADD COLUMN IF NOT EXISTS clerk_action_exempt_reason text NULL,
  ADD COLUMN IF NOT EXISTS late_completion_reason text NULL;

CREATE INDEX IF NOT EXISTS idx_pvouchers_firm_assigned_account ON payment_vouchers (firm_id, assigned_account_user_id, status);
CREATE INDEX IF NOT EXISTS idx_pvouchers_firm_due_at ON payment_vouchers (firm_id, payment_due_at);
CREATE INDEX IF NOT EXISTS idx_pvouchers_firm_received_at ON payment_vouchers (firm_id, received_at);
CREATE INDEX IF NOT EXISTS idx_pvouchers_firm_assigned_clerk ON payment_vouchers (firm_id, assigned_clerk_user_id, status);

CREATE TABLE IF NOT EXISTS accounting_settings (
  firm_id integer PRIMARY KEY REFERENCES firms(id) ON DELETE CASCADE,
  account_manager_role_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  account_admin_role_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  timezone text NOT NULL DEFAULT 'Asia/Kuala_Lumpur',
  working_hours_start text NOT NULL DEFAULT '09:00',
  working_hours_end text NOT NULL DEFAULT '18:00',
  exclude_saturday boolean NOT NULL DEFAULT true,
  exclude_sunday boolean NOT NULL DEFAULT true,
  firm_holidays jsonb NOT NULL DEFAULT '[]'::jsonb,
  approval_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  payment_voucher_sla jsonb NOT NULL DEFAULT '{}'::jsonb,
  clerk_action_sla jsonb NOT NULL DEFAULT '{}'::jsonb,
  payment_proof_required boolean NOT NULL DEFAULT true,
  created_by integer NULL,
  updated_by integer NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_accounting_settings_timezone ON accounting_settings (timezone);

CREATE TABLE IF NOT EXISTS payment_voucher_actions (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  payment_voucher_id integer NOT NULL REFERENCES payment_vouchers(id) ON DELETE CASCADE,
  case_id integer NULL REFERENCES cases(id) ON DELETE SET NULL,
  assigned_user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action_type text NOT NULL,
  custom_action text NULL,
  status text NOT NULL DEFAULT 'assigned',
  priority text NOT NULL DEFAULT 'normal',
  assigned_at timestamptz NOT NULL DEFAULT now(),
  acknowledge_due_at timestamptz NULL,
  acknowledged_by integer NULL REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_at timestamptz NULL,
  completion_due_at timestamptz NULL,
  completed_by integer NULL REFERENCES users(id) ON DELETE SET NULL,
  completed_at timestamptz NULL,
  completion_notes text NULL,
  completion_attachment_path text NULL,
  updated_milestone text NULL,
  breached_at timestamptz NULL,
  cancelled_at timestamptz NULL,
  cancelled_by integer NULL REFERENCES users(id) ON DELETE SET NULL,
  created_by integer NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_voucher_actions_firm_voucher ON payment_voucher_actions (firm_id, payment_voucher_id, status);
CREATE INDEX IF NOT EXISTS idx_payment_voucher_actions_firm_assigned ON payment_voucher_actions (firm_id, assigned_user_id, status);
CREATE INDEX IF NOT EXISTS idx_payment_voucher_actions_firm_case ON payment_voucher_actions (firm_id, case_id);
CREATE INDEX IF NOT EXISTS idx_payment_voucher_actions_firm_completion_due ON payment_voucher_actions (firm_id, completion_due_at);
CREATE INDEX IF NOT EXISTS idx_payment_voucher_actions_firm_ack_due ON payment_voucher_actions (firm_id, acknowledge_due_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_voucher_actions_active
  ON payment_voucher_actions (firm_id, payment_voucher_id)
  WHERE status IN ('assigned', 'acknowledged');

CREATE TABLE IF NOT EXISTS user_notifications (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type text NOT NULL,
  source_id integer NOT NULL,
  case_id integer NULL REFERENCES cases(id) ON DELETE SET NULL,
  notification_type text NOT NULL,
  title text NOT NULL,
  message text NULL,
  meta jsonb NULL,
  is_read boolean NOT NULL DEFAULT false,
  read_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_notifications_firm_user_unread ON user_notifications (firm_id, user_id, is_read, created_at);
CREATE INDEX IF NOT EXISTS idx_user_notifications_firm_user_type ON user_notifications (firm_id, user_id, notification_type, is_read);
CREATE INDEX IF NOT EXISTS idx_user_notifications_firm_case ON user_notifications (firm_id, case_id);

ALTER TABLE accounting_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS accounting_settings_rw ON accounting_settings;
CREATE POLICY accounting_settings_rw ON accounting_settings FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

ALTER TABLE payment_voucher_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_voucher_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_voucher_actions_rw ON payment_voucher_actions;
CREATE POLICY payment_voucher_actions_rw ON payment_voucher_actions FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

ALTER TABLE user_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_notifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_notifications_rw ON user_notifications;
CREATE POLICY user_notifications_rw ON user_notifications FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

