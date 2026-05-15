-- Payment vouchers: transfer types + approval status

DO $$ BEGIN
  CREATE TYPE payment_voucher_type AS ENUM (
    'external_payment',
    'file_transfer',
    'account_transfer'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE payment_voucher_approval_status AS ENUM (
    'approved',
    'pending_approval',
    'rejected'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE payment_vouchers
  ADD COLUMN IF NOT EXISTS voucher_type payment_voucher_type NOT NULL DEFAULT 'external_payment',
  ADD COLUMN IF NOT EXISTS target_case_id integer,
  ADD COLUMN IF NOT EXISTS target_account_id integer,
  ADD COLUMN IF NOT EXISTS approval_status payment_voucher_approval_status NOT NULL DEFAULT 'approved';

CREATE INDEX IF NOT EXISTS idx_pvouchers_firm_approval_status ON payment_vouchers(firm_id, approval_status);
CREATE INDEX IF NOT EXISTS idx_pvouchers_firm_target_case ON payment_vouchers(firm_id, target_case_id);
CREATE INDEX IF NOT EXISTS idx_pvouchers_firm_target_account ON payment_vouchers(firm_id, target_account_id);

