ALTER TABLE case_key_dates
  ADD COLUMN IF NOT EXISTS spa_received_dev_return_spa_on date,
  ADD COLUMN IF NOT EXISTS stamped_spa_sent_to_purchaser_on date,
  ADD COLUMN IF NOT EXISTS li_date date,
  ADD COLUMN IF NOT EXISTS li_received_on date,
  ADD COLUMN IF NOT EXISTS supp_lo_date date,
  ADD COLUMN IF NOT EXISTS differential_sum_rm numeric(15, 2),
  ADD COLUMN IF NOT EXISTS differential_sum_settled_on date,
  ADD COLUMN IF NOT EXISTS bank_lu_dated date,
  ADD COLUMN IF NOT EXISTS balance_sum_less_last_5_rm numeric(15, 2),
  ADD COLUMN IF NOT EXISTS bankruptcy_search_dated date,
  ADD COLUMN IF NOT EXISTS statutory_declaration_dated date,
  ADD COLUMN IF NOT EXISTS statutory_declaration_stamped_on date,
  ADD COLUMN IF NOT EXISTS fa_date date,
  ADD COLUMN IF NOT EXISTS fa_adjudication_number text,
  ADD COLUMN IF NOT EXISTS fa_stamp_on date,
  ADD COLUMN IF NOT EXISTS doa_date date,
  ADD COLUMN IF NOT EXISTS doa_stamp_on date,
  ADD COLUMN IF NOT EXISTS poa_date date,
  ADD COLUMN IF NOT EXISTS poa_stamp_on date,
  ADD COLUMN IF NOT EXISTS noa_dated date,
  ADD COLUMN IF NOT EXISTS register_pa_on date,
  ADD COLUMN IF NOT EXISTS pa_no text,
  ADD COLUMN IF NOT EXISTS request_letter_no_objection date,
  ADD COLUMN IF NOT EXISTS received_letter_no_objection_on date,
  ADD COLUMN IF NOT EXISTS blanket_consent_transfer_req date,
  ADD COLUMN IF NOT EXISTS blanket_consent_transfer_approval date,
  ADD COLUMN IF NOT EXISTS consent_to_charge_req date,
  ADD COLUMN IF NOT EXISTS consent_to_charge_approval date,
  ADD COLUMN IF NOT EXISTS discharge_title_received_on date,
  ADD COLUMN IF NOT EXISTS mot_submit_stamping date,
  ADD COLUMN IF NOT EXISTS charge_submit_stamping date,
  ADD COLUMN IF NOT EXISTS charge_stamped date;

UPDATE case_key_dates
SET
  consent_to_charge_approval = COALESCE(consent_to_charge_approval, consent_to_charge_date),
  blanket_consent_transfer_approval = COALESCE(blanket_consent_transfer_approval, consent_to_transfer_date)
WHERE (consent_to_charge_approval IS NULL OR blanket_consent_transfer_approval IS NULL)
  AND (consent_to_charge_date IS NOT NULL OR consent_to_transfer_date IS NOT NULL);

