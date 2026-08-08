-- 0136_pv_workflow_escalation_status_history.sql
-- Additive-only migration. No DROP, no UPDATE on production data.
-- Adds:
--   1) responsible_lawyer_id + approving_partner_id columns on payment_vouchers (F1)
--   2) quotation_id + quotation_claim_warning on payment_vouchers (F1)
--   3) escalated/2h-repeat escalation tracking columns on payment_vouchers (F2)
--   4) status/target/dismiss/auto-resolve columns on user_notifications (F2 + F6 partial)
--   5) last_escalated_on index

DO $$ BEGIN END $$;

-- 1) Responsible Lawyer + Approving Partner + Quotation Claim (F1)
ALTER TABLE payment_vouchers ADD COLUMN IF NOT EXISTS responsible_lawyer_id INTEGER;
ALTER TABLE payment_vouchers ADD COLUMN IF NOT EXISTS approving_partner_id INTEGER;
ALTER TABLE payment_vouchers ADD COLUMN IF NOT EXISTS quotation_id INTEGER;
ALTER TABLE payment_vouchers ADD COLUMN IF NOT EXISTS quotation_claim_warning TEXT;
ALTER TABLE payment_vouchers ADD COLUMN IF NOT EXISTS rejected_by INTEGER;
ALTER TABLE payment_vouchers ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;
ALTER TABLE payment_vouchers ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE payment_vouchers ADD COLUMN IF NOT EXISTS completed_by INTEGER;
ALTER TABLE payment_vouchers ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE payment_vouchers ADD COLUMN IF NOT EXISTS completion_remarks TEXT;

-- 2) Escalation tracking (F2 – All Partners + 2h repeat)
ALTER TABLE payment_vouchers ADD COLUMN IF NOT EXISTS last_escalation_notified_at TIMESTAMPTZ;
ALTER TABLE payment_vouchers ADD COLUMN IF NOT EXISTS escalation_repeat_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payment_vouchers ADD COLUMN IF NOT EXISTS escalation_resolved_at TIMESTAMPTZ;
ALTER TABLE payment_vouchers ADD COLUMN IF NOT EXISTS escalation_resolved_by INTEGER;

-- 3) Unified notification lifecycle + target scope (F2 + F6 partial – NOT deletion of existing cols)
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'unread';
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS acknowledged_by INTEGER;
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS resolved_by INTEGER;
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS auto_resolved_at TIMESTAMPTZ;
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS target_scope TEXT;
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS target_role_id INTEGER;
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS dismissible BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE user_notifications ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'normal';

-- FK indexes (not enforcing FK constraints to preserve safe additive apply)
CREATE INDEX IF NOT EXISTS idx_pvouchers_firm_responsible_lawyer ON payment_vouchers(firm_id, responsible_lawyer_id) WHERE responsible_lawyer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pvouchers_firm_approving_partner ON payment_vouchers(firm_id, approving_partner_id) WHERE approving_partner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pvouchers_firm_quotation_id ON payment_vouchers(firm_id, quotation_id) WHERE quotation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pvouchers_firm_last_escalation ON payment_vouchers(firm_id, last_escalation_notified_at, status) WHERE status IN ('pending_account','paid_pending_collection');

CREATE INDEX IF NOT EXISTS idx_user_notifications_firm_user_status ON user_notifications(firm_id, user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_notifications_target_scope ON user_notifications(firm_id, target_scope, created_at DESC) WHERE target_scope IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_notifications_severity ON user_notifications(firm_id, user_id, severity, status) WHERE status NOT IN ('resolved','auto_resolved');
