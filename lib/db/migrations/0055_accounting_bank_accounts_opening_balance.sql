BEGIN;

ALTER TABLE firm_bank_accounts
  ADD COLUMN IF NOT EXISTS account_name varchar NULL;

ALTER TABLE firm_bank_accounts
  ADD COLUMN IF NOT EXISTS autocount_gl_code varchar NULL;

ALTER TABLE firm_bank_accounts
  ADD COLUMN IF NOT EXISTS opening_balance numeric(12,2) NOT NULL DEFAULT 0;

ALTER TABLE firm_bank_accounts
  ADD COLUMN IF NOT EXISTS opening_balance_date date NULL;

ALTER TABLE firm_bank_accounts
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

COMMIT;

