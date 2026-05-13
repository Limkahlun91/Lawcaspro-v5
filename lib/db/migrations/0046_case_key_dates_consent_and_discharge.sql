ALTER TABLE case_key_dates
ADD COLUMN IF NOT EXISTS discharge_date date;

ALTER TABLE case_key_dates
ADD COLUMN IF NOT EXISTS consent_to_transfer_date date;

ALTER TABLE case_key_dates
ADD COLUMN IF NOT EXISTS consent_to_charge_date date;

