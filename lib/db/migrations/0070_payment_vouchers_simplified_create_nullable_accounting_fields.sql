-- Payment vouchers: allow front-line simplified creation

ALTER TABLE payment_vouchers
  ALTER COLUMN payment_method DROP NOT NULL,
  ALTER COLUMN fund_status DROP NOT NULL,
  ALTER COLUMN account_type DROP NOT NULL;

ALTER TABLE payment_vouchers
  ADD COLUMN IF NOT EXISTS beneficiary_bank text,
  ADD COLUMN IF NOT EXISTS beneficiary_account_no text;

UPDATE payment_vouchers
SET beneficiary_bank = payee_bank
WHERE beneficiary_bank IS NULL AND payee_bank IS NOT NULL;

UPDATE payment_vouchers
SET beneficiary_account_no = payee_account_no
WHERE beneficiary_account_no IS NULL AND payee_account_no IS NOT NULL;

