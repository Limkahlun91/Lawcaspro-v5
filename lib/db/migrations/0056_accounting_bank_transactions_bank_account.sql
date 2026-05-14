BEGIN;

ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS bank_account_id integer NULL;

ALTER TABLE bank_transactions
  ADD CONSTRAINT fk_bank_transactions_bank_account
  FOREIGN KEY (bank_account_id) REFERENCES firm_bank_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bank_transactions_firm_account ON bank_transactions (firm_id, bank_account_id);

COMMIT;

