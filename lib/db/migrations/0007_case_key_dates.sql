-- 0007_case_key_dates.sql
-- Structured, queryable key dates & milestone fields for cases (per-firm, per-case one-to-one).

CREATE TABLE IF NOT EXISTS case_key_dates (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  case_id integer NOT NULL UNIQUE REFERENCES cases(id) ON DELETE CASCADE,

  -- SPA related
  spa_signed_date date,
  spa_forward_to_developer_execution_on date,
  spa_date date,
  spa_stamped_date date,
  stamped_spa_send_to_developer_on date,
  stamped_spa_received_from_developer_on date,

  letter_of_offer_date date,
  letter_of_offer_stamped_date date,

  -- Loan related
  loan_docs_pending_date date,
  loan_docs_signed_date date,
  acting_letter_issued_date date,
  developer_confirmation_received_on date,
  developer_confirmation_date date,
  loan_sent_bank_execution_date date,
  loan_bank_executed_date date,
  bank_lu_received_date date,
  bank_lu_forward_to_developer_on date,
  developer_lu_received_on date,
  developer_lu_dated date,
  letter_disclaimer_received_on date,
  letter_disclaimer_dated date,
  letter_disclaimer_reference_nos text,
  redemption_sum numeric(15,2),
  loan_agreement_dated date,
  loan_agreement_submitted_stamping_date date,
  loan_agreement_stamped_date date,
  register_poa_on date,
  registered_poa_registration_number text,
  noa_served_on date,
  advice_to_bank_date date,
  bank_1st_release_on date,
  first_release_amount_rm numeric(15,2),

  -- MOT / title / registration related
  mot_received_date date,
  mot_signed_date date,
  mot_stamped_date date,
  mot_registered_date date,

  -- Completion / billing / finance related
  progressive_payment_date date,
  full_settlement_date date,
  completion_date date,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_case_key_dates_firm ON case_key_dates(firm_id);
CREATE INDEX IF NOT EXISTS idx_case_key_dates_case ON case_key_dates(case_id);

ALTER TABLE case_key_dates ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_key_dates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS case_key_dates_select ON case_key_dates;
CREATE POLICY case_key_dates_select ON case_key_dates
  FOR SELECT
  USING (firm_id = (current_setting('app.current_firm_id', true))::int OR current_setting('app.is_founder', true) = 'true');

DROP POLICY IF EXISTS case_key_dates_insert ON case_key_dates;
CREATE POLICY case_key_dates_insert ON case_key_dates
  FOR INSERT
  WITH CHECK (firm_id = (current_setting('app.current_firm_id', true))::int OR current_setting('app.is_founder', true) = 'true');

DROP POLICY IF EXISTS case_key_dates_update ON case_key_dates;
CREATE POLICY case_key_dates_update ON case_key_dates
  FOR UPDATE
  USING (firm_id = (current_setting('app.current_firm_id', true))::int OR current_setting('app.is_founder', true) = 'true')
  WITH CHECK (firm_id = (current_setting('app.current_firm_id', true))::int OR current_setting('app.is_founder', true) = 'true');

DROP POLICY IF EXISTS case_key_dates_delete ON case_key_dates;
CREATE POLICY case_key_dates_delete ON case_key_dates
  FOR DELETE
  USING (firm_id = (current_setting('app.current_firm_id', true))::int OR current_setting('app.is_founder', true) = 'true');

