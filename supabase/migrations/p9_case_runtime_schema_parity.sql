-- =========================================================================
-- p9_case_runtime_schema_parity.sql
-- Additive migration to align live Supabase schema with Drizzle declarations.
-- No DROP / TRUNCATE / data deletion.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. case_messages  — add missing channel column + indexes
-- -------------------------------------------------------------------------
ALTER TABLE public.case_messages
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'client';

CREATE INDEX IF NOT EXISTS idx_case_messages_firm_case_created_at
  ON public.case_messages (firm_id, case_id, created_at);

CREATE INDEX IF NOT EXISTS idx_case_messages_case_created_at
  ON public.case_messages (case_id, created_at);

-- -------------------------------------------------------------------------
-- 2. case_message_read_status — add missing channel column + unique/indexes
-- -------------------------------------------------------------------------
ALTER TABLE public.case_message_read_status
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'client';

CREATE UNIQUE INDEX IF NOT EXISTS case_message_read_status_firm_case_user_channel_key
  ON public.case_message_read_status (firm_id, case_id, user_id, channel);

CREATE INDEX IF NOT EXISTS idx_case_message_read_status_firm_user
  ON public.case_message_read_status (firm_id, user_id);

CREATE INDEX IF NOT EXISTS idx_case_message_read_status_firm_case
  ON public.case_message_read_status (firm_id, case_id);

-- -------------------------------------------------------------------------
-- 3. case_workflow_documents — add missing deleted_at column + indexes
-- -------------------------------------------------------------------------
ALTER TABLE public.case_workflow_documents
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_case_workflow_documents_firm_case
  ON public.case_workflow_documents (firm_id, case_id);

CREATE INDEX IF NOT EXISTS idx_case_workflow_documents_case
  ON public.case_workflow_documents (case_id);

CREATE INDEX IF NOT EXISTS idx_case_workflow_documents_firm_key
  ON public.case_workflow_documents (firm_id, milestone_key);

-- -------------------------------------------------------------------------
-- 4. case_loan_stamping_items — add missing deleted_at column + indexes
-- -------------------------------------------------------------------------
ALTER TABLE public.case_loan_stamping_items
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_case_loan_stamping_items_firm_case
  ON public.case_loan_stamping_items (firm_id, case_id);

CREATE INDEX IF NOT EXISTS idx_case_loan_stamping_items_case
  ON public.case_loan_stamping_items (case_id);

CREATE INDEX IF NOT EXISTS idx_case_loan_stamping_items_firm_key
  ON public.case_loan_stamping_items (firm_id, item_key);

CREATE INDEX IF NOT EXISTS idx_case_loan_stamping_items_sort
  ON public.case_loan_stamping_items (firm_id, case_id, sort_order);

-- -------------------------------------------------------------------------
-- 5. case_loan_supp_documents — add missing deleted_at column + indexes
-- -------------------------------------------------------------------------
ALTER TABLE public.case_loan_supp_documents
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_case_loan_supp_documents_firm_case
  ON public.case_loan_supp_documents (firm_id, case_id);

CREATE INDEX IF NOT EXISTS idx_case_loan_supp_documents_sort
  ON public.case_loan_supp_documents (firm_id, case_id, sort_order);

-- -------------------------------------------------------------------------
-- 6. case_key_dates — new columns (Additive) — parity with drizzle schema
-- -------------------------------------------------------------------------
ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS completion_sla_activated_at   TIMESTAMPTZ;
ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS completion_sla_notified_48h_at TIMESTAMPTZ;

ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS discharge_date                   DATE;
ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS discharge_title_received_on     DATE;
ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS request_letter_no_objection     DATE;
ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS received_letter_no_objection_on DATE;
ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS blanket_consent_transfer_req     DATE;
ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS blanket_consent_transfer_approval DATE;
ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS consent_to_charge_req            DATE;
ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS consent_to_charge_approval      DATE;
ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS consent_to_transfer_date        DATE;
ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS consent_to_charge_date          DATE;
ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS caveat_lodged_date              DATE;
ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS first_advice_date               DATE;
ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS dev_informed_redemption_date    DATE;
ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS request_discharge_date           DATE;
ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS charge_date                      DATE;
ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS charge_submit_stamping          DATE;
ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS charge_stamped                   DATE;
ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS presentation_date                DATE;
ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS second_advice_date               DATE;

ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS mot_received_date                DATE;
ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS mot_signed_date                  DATE;
ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS mot_submit_stamping              DATE;
ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS mot_stamped_date                 DATE;
ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS mot_registered_date              DATE;

ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS progressive_payment_date         DATE;
ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS full_settlement_date             DATE;
ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS completion_date                  DATE;

ALTER TABLE public.case_key_dates
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_case_key_dates_firm
  ON public.case_key_dates (firm_id);
CREATE INDEX IF NOT EXISTS idx_case_key_dates_case
  ON public.case_key_dates (case_id);

-- -------------------------------------------------------------------------
-- 7. case_ledgers — CREATE TABLE IF NOT EXISTS
--    (UUID id, firm_id, case_id, full accounting structure)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.case_ledgers (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id            INTEGER NOT NULL,
  case_id            INTEGER NOT NULL,
  transaction_date   DATE NOT NULL,
  entry_category     TEXT NOT NULL,
  entry_type         TEXT NOT NULL,
  description        TEXT NOT NULL,
  amount             NUMERIC(12, 2) NOT NULL,
  debit_cents        INTEGER NOT NULL DEFAULT 0,
  credit_cents       INTEGER NOT NULL DEFAULT 0,
  source_type        TEXT,
  source_id          INTEGER,
  source_reference   TEXT,
  event_key          TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_case_ledgers_firm_case
  ON public.case_ledgers (firm_id, case_id, transaction_date);
CREATE INDEX IF NOT EXISTS idx_case_ledgers_source
  ON public.case_ledgers (firm_id, case_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_case_ledgers_firm_event
  ON public.case_ledgers (firm_id, event_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_case_ledgers_firm_event_key
  ON public.case_ledgers (firm_id, event_key);
