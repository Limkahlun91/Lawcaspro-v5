-- GATE 1 / G1-9: Session identity snapshot columns
-- Additive migration; fully reversible via DROP COLUMN.
-- Pre-existing sessions will retain NULL values; they remain valid
-- until natural expiry (guard clause only applies cross-check when
-- ALL snapshot columns are NOT NULL).

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS firm_id integer;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS role_id integer;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_type text;

CREATE INDEX IF NOT EXISTS idx_sessions_firm_id ON sessions(firm_id);
CREATE INDEX IF NOT EXISTS idx_sessions_role_id ON sessions(role_id);
