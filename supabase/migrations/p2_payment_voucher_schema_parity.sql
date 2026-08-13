-- LAWCASEPRO V5 ADDENDUM P2 PAYMENT VOUCHER RUNTIME SCHEMA PARITY
-- P2 / QUOTATION SEARCH + DISBURSEMENT PRESETS + PAYMENT VOUCHER P0
-- Safe, idempotent, additive-only. No destructive changes. No DROP/TRUNCATE.
-- Scope: payment_vouchers missing columns + indexes.
-- Root cause: preview db has 57 cols; code schema lib/db has 83 cols → SQLSTATE 42703 missing column.
-- Date: 2026-08-13

-- ============================================================
-- PART 1: payment_vouchers - Add missing columns (IF NOT EXISTS)
-- 15 columns missing vs code schema (lib/db/src/schema/accounting.ts paymentVouchersTable)
-- ============================================================

DO $$
DECLARE
    _sql text;
BEGIN

IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'payment_vouchers') THEN

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'payment_vouchers' AND column_name = 'responsible_lawyer_id') THEN
        ALTER TABLE payment_vouchers ADD COLUMN responsible_lawyer_id integer;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'payment_vouchers' AND column_name = 'approving_partner_id') THEN
        ALTER TABLE payment_vouchers ADD COLUMN approving_partner_id integer;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'payment_vouchers' AND column_name = 'quotation_id') THEN
        ALTER TABLE payment_vouchers ADD COLUMN quotation_id integer;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'payment_vouchers' AND column_name = 'quotation_claim_warning') THEN
        ALTER TABLE payment_vouchers ADD COLUMN quotation_claim_warning text;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'payment_vouchers' AND column_name = 'rejected_by') THEN
        ALTER TABLE payment_vouchers ADD COLUMN rejected_by integer;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'payment_vouchers' AND column_name = 'rejected_at') THEN
        ALTER TABLE payment_vouchers ADD COLUMN rejected_at timestamptz;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'payment_vouchers' AND column_name = 'rejection_reason') THEN
        ALTER TABLE payment_vouchers ADD COLUMN rejection_reason text;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'payment_vouchers' AND column_name = 'completed_by') THEN
        ALTER TABLE payment_vouchers ADD COLUMN completed_by integer;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'payment_vouchers' AND column_name = 'completed_at') THEN
        ALTER TABLE payment_vouchers ADD COLUMN completed_at timestamptz;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'payment_vouchers' AND column_name = 'completion_remarks') THEN
        ALTER TABLE payment_vouchers ADD COLUMN completion_remarks text;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'payment_vouchers' AND column_name = 'last_escalation_notified_at') THEN
        ALTER TABLE payment_vouchers ADD COLUMN last_escalation_notified_at timestamptz;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'payment_vouchers' AND column_name = 'escalation_repeat_count') THEN
        ALTER TABLE payment_vouchers ADD COLUMN escalation_repeat_count integer NOT NULL DEFAULT 0;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'payment_vouchers' AND column_name = 'escalation_resolved_at') THEN
        ALTER TABLE payment_vouchers ADD COLUMN escalation_resolved_at timestamptz;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'payment_vouchers' AND column_name = 'escalation_resolved_by') THEN
        ALTER TABLE payment_vouchers ADD COLUMN escalation_resolved_by integer;
    END IF;

END IF;

END $$;

-- ============================================================
-- PART 2: payment_vouchers - Add missing indexes (CREATE INDEX IF NOT EXISTS)
-- Matches lib/db/src/schema/accounting.ts paymentVouchersTable second-tuple indexes
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_pvouchers_firm_responsible_lawyer ON public.payment_vouchers (firm_id, responsible_lawyer_id);
CREATE INDEX IF NOT EXISTS idx_pvouchers_firm_approving_partner ON public.payment_vouchers (firm_id, approving_partner_id);
CREATE INDEX IF NOT EXISTS idx_pvouchers_firm_quotation_id ON public.payment_vouchers (firm_id, quotation_id);
CREATE INDEX IF NOT EXISTS idx_pvouchers_firm_last_escalation ON public.payment_vouchers (firm_id, last_escalation_notified_at, status) WHERE last_escalation_notified_at IS NOT NULL;

-- Guarantee exactly-once idempotency index (uq_payment_vouchers_client_request: firm_id, client_request_id)
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_vouchers_client_request ON public.payment_vouchers (firm_id, client_request_id) WHERE client_request_id IS NOT NULL;
