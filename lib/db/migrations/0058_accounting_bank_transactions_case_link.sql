ALTER TABLE bank_transactions
ADD COLUMN IF NOT EXISTS case_id integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'bank_transactions_case_id_fkey'
  ) THEN
    ALTER TABLE bank_transactions
    ADD CONSTRAINT bank_transactions_case_id_fkey
    FOREIGN KEY (case_id) REFERENCES cases(id)
    ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bank_transactions_firm_case
  ON bank_transactions(firm_id, case_id);

