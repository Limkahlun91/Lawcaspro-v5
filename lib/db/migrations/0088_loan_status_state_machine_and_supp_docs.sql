CREATE TABLE IF NOT EXISTS case_loan_supp_documents (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  case_id integer NOT NULL,
  document_name text NOT NULL,
  document_date date,
  object_path text,
  file_name text,
  mime_type text,
  file_size integer,
  uploaded_by integer,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_case_loan_supp_documents_firm_case ON case_loan_supp_documents (firm_id, case_id);
CREATE INDEX IF NOT EXISTS idx_case_loan_supp_documents_sort ON case_loan_supp_documents (firm_id, case_id, sort_order);

ALTER TABLE case_key_dates
  ADD COLUMN IF NOT EXISTS master_lu_exempted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS encumbrance_free_exempted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS received_executed_document_on_1 date,
  ADD COLUMN IF NOT EXISTS received_unexecuted_document_on date,
  ADD COLUMN IF NOT EXISTS resent_bank_execution_dated date,
  ADD COLUMN IF NOT EXISTS received_executed_document_on_2 date;

