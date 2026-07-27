ALTER TABLE payment_vouchers
  ADD COLUMN IF NOT EXISTS client_request_id text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_vouchers_client_request
  ON payment_vouchers (firm_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pvouchers_firm_created_at
  ON payment_vouchers (firm_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_firm_case_account_type
  ON ledger_entries (firm_id, case_id, account_type);

