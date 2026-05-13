-- Multi-tier approval + physical handoff for payment vouchers

DO $$ BEGIN
  CREATE TYPE payment_voucher_status AS ENUM (
    'pending_lawyer',
    'pending_partner',
    'pending_account',
    'paid_pending_collection',
    'completed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE payment_voucher_fund_status AS ENUM (
    'client_paid',
    'request_advance'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE payment_vouchers
  ADD COLUMN IF NOT EXISTS fund_status payment_voucher_fund_status NOT NULL DEFAULT 'client_paid',
  ADD COLUMN IF NOT EXISTS bank_cheque_ref_no text;

ALTER TABLE payment_vouchers
  ALTER COLUMN status DROP DEFAULT;

ALTER TABLE payment_vouchers
  ALTER COLUMN status TYPE payment_voucher_status
  USING (
    CASE status
      WHEN 'draft' THEN 'pending_lawyer'
      WHEN 'prepared' THEN 'pending_lawyer'
      WHEN 'lawyer_approved' THEN 'pending_partner'
      WHEN 'partner_approved' THEN 'pending_account'
      WHEN 'submitted' THEN 'pending_account'
      WHEN 'returned' THEN 'pending_account'
      WHEN 'paid' THEN 'paid_pending_collection'
      WHEN 'locked' THEN 'completed'
      ELSE 'pending_lawyer'
    END
  )::payment_voucher_status;

ALTER TABLE payment_vouchers
  ALTER COLUMN status SET DEFAULT 'pending_lawyer';

