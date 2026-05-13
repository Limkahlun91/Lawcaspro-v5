CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE cases
ADD COLUMN IF NOT EXISTS tracking_token uuid;

UPDATE cases
SET tracking_token = gen_random_uuid()
WHERE tracking_token IS NULL;

ALTER TABLE cases
ALTER COLUMN tracking_token SET NOT NULL;

ALTER TABLE cases
ALTER COLUMN tracking_token SET DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS cases_tracking_token_key
ON cases(tracking_token);

