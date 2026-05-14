BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS bank_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  transaction_date date NOT NULL,
  description text NOT NULL,
  reference_no varchar NULL,
  withdrawal numeric(12,2) NULL,
  deposit numeric(12,2) NULL,
  balance numeric(12,2) NULL,
  is_exported_to_autocount boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bank_transactions_firm_date ON bank_transactions (firm_id, transaction_date);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_export ON bank_transactions (firm_id, is_exported_to_autocount);

COMMIT;

