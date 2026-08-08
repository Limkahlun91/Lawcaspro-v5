-- Migration 0145: e-Invoice scaffold
-- Additive only: einvoice columns on invoices + einvoice_submissions table

-- invoices: einvoice status + metadata columns
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS einvoice_status TEXT NOT NULL DEFAULT 'DRAFT';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS einvoice_external_submission_id TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS einvoice_submitted_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS einvoice_last_checked_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS einvoice_error_code TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS einvoice_error_message TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS einvoice_retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS einvoice_classification TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS einvoice_source_invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL;

-- Drop + re-add constraints idempotently
DO $$ BEGIN
  ALTER TABLE invoices DROP CONSTRAINT IF EXISTS chk_invoices_einvoice_status;
EXCEPTION WHEN OTHERS THEN NULL; END $$;
ALTER TABLE invoices ADD CONSTRAINT chk_invoices_einvoice_status
  CHECK (einvoice_status IN ('DRAFT','READY','SUBMITTING','SUBMITTED','VALID','INVALID','CANCELLED','ERROR','RETRY_PENDING'));

DO $$ BEGIN
  ALTER TABLE invoices DROP CONSTRAINT IF EXISTS chk_invoices_einvoice_classification;
EXCEPTION WHEN OTHERS THEN NULL; END $$;
ALTER TABLE invoices ADD CONSTRAINT chk_invoices_einvoice_classification
  CHECK (einvoice_classification IS NULL OR einvoice_classification IN ('OFFICE_INCOME','TAXABLE_TRAVEL_MISC','CLIENT_STAKEHOLDER_MONEY','REIMBURSEMENT','DISBURSEMENT','OVERCOLLECT_TRANSFER'));

CREATE INDEX IF NOT EXISTS idx_invoices_einvoice_status ON invoices(firm_id, einvoice_status);
CREATE INDEX IF NOT EXISTS idx_invoices_einvoice_source ON invoices(einvoice_source_invoice_id);

-- einvoice_submissions table
CREATE TABLE IF NOT EXISTS einvoice_submissions (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  invoice_id INTEGER NOT NULL,
  submission_idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'SUBMITTING',
  external_submission_id TEXT,
  payload_json JSONB,
  response_json JSONB,
  submitted_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  error_code TEXT,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_einvoice_submissions_idempotency_key
  ON einvoice_submissions(submission_idempotency_key);
CREATE INDEX IF NOT EXISTS idx_einvoice_submissions_firm_invoice
  ON einvoice_submissions(firm_id, invoice_id);
CREATE INDEX IF NOT EXISTS idx_einvoice_submissions_status
  ON einvoice_submissions(firm_id, status);
CREATE INDEX IF NOT EXISTS idx_einvoice_submissions_external
  ON einvoice_submissions(external_submission_id);

DO $$ BEGIN
  ALTER TABLE einvoice_submissions DROP CONSTRAINT IF EXISTS chk_einvoice_submissions_status;
EXCEPTION WHEN OTHERS THEN NULL; END $$;
ALTER TABLE einvoice_submissions ADD CONSTRAINT chk_einvoice_submissions_status
  CHECK (status IN ('DRAFT','READY','SUBMITTING','SUBMITTED','VALID','INVALID','CANCELLED','ERROR','RETRY_PENDING'));

-- RLS
ALTER TABLE einvoice_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE einvoice_submissions FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  DROP POLICY IF EXISTS einvoice_submissions_firm_id ON einvoice_submissions;
EXCEPTION WHEN OTHERS THEN NULL; END $$;
CREATE POLICY einvoice_submissions_firm_id ON einvoice_submissions
  USING (firm_id = (current_setting('app.current_firm_id', true))::INTEGER);
