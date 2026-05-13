ALTER TABLE case_key_dates
ADD COLUMN IF NOT EXISTS caveat_lodged_date date;

ALTER TABLE case_key_dates
ADD COLUMN IF NOT EXISTS first_advice_date date;

ALTER TABLE case_key_dates
ADD COLUMN IF NOT EXISTS dev_informed_redemption_date date;

ALTER TABLE case_key_dates
ADD COLUMN IF NOT EXISTS request_discharge_date date;

ALTER TABLE case_key_dates
ADD COLUMN IF NOT EXISTS charge_date date;

ALTER TABLE case_key_dates
ADD COLUMN IF NOT EXISTS presentation_date date;

ALTER TABLE case_key_dates
ADD COLUMN IF NOT EXISTS second_advice_date date;
