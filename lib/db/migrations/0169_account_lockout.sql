-- GATE 1 / G1-2: Account lockout columns
-- Additive migration; fully reversible via DROP COLUMN.

ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until timestamp with time zone;
CREATE INDEX IF NOT EXISTS idx_users_locked_until ON users(locked_until);
