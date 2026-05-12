ALTER TABLE cases
ADD COLUMN IF NOT EXISTS loan_party_type text NOT NULL DEFAULT '1st_party';

ALTER TABLE cases
DROP CONSTRAINT IF EXISTS cases_loan_party_type_check;

ALTER TABLE cases
ADD CONSTRAINT cases_loan_party_type_check
CHECK (loan_party_type IN ('1st_party', '3rd_party'));

