ALTER TABLE firm_bank_accounts
  RENAME COLUMN autocount_gl_code TO gl_code;

ALTER TABLE bank_transactions
  RENAME COLUMN is_exported_to_autocount TO is_exported;

ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS exported_at timestamptz;

UPDATE bank_transactions
SET exported_at = updated_at
WHERE is_exported = true AND exported_at IS NULL;
