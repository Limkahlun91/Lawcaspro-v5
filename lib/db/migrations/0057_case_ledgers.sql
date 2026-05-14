BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS case_ledgers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  case_id integer NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  transaction_date date NOT NULL,
  entry_category varchar NOT NULL,
  entry_type varchar NOT NULL,
  description text NOT NULL,
  amount numeric(12,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_case_ledgers_firm_case ON case_ledgers (firm_id, case_id, transaction_date);

COMMIT;

