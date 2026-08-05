DO $do$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $do$;

GRANT USAGE ON SCHEMA public TO app_user;

ALTER TABLE payment_vouchers
  ADD COLUMN IF NOT EXISTS client_request_id text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_vouchers_client_request
  ON payment_vouchers (firm_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pvouchers_firm_created_at
  ON payment_vouchers (firm_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_firm_case_account_type
  ON ledger_entries (firm_id, case_id, account_type);

CREATE TABLE IF NOT EXISTS payment_voucher_create_requests (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  created_by_user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  client_request_id text NOT NULL,
  request_payload_hash text,
  status text NOT NULL DEFAULT 'processing',
  payment_voucher_id integer REFERENCES payment_vouchers(id) ON DELETE SET NULL,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_voucher_create_requests_firm_user_key
  ON payment_voucher_create_requests (firm_id, created_by_user_id, client_request_id);

CREATE INDEX IF NOT EXISTS idx_payment_voucher_create_requests_firm_status
  ON payment_voucher_create_requests (firm_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_voucher_create_requests_firm_voucher
  ON payment_voucher_create_requests (firm_id, payment_voucher_id);

ALTER TABLE payment_voucher_create_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_voucher_create_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_voucher_create_requests_rw ON payment_voucher_create_requests;
CREATE POLICY payment_voucher_create_requests_rw ON payment_voucher_create_requests FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

CREATE TABLE IF NOT EXISTS payment_voucher_actions (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  payment_voucher_id integer NOT NULL REFERENCES payment_vouchers(id) ON DELETE CASCADE,
  case_id integer NULL REFERENCES cases(id) ON DELETE SET NULL,
  assigned_user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action_type text NOT NULL,
  custom_action text NULL,
  status text NOT NULL DEFAULT 'assigned',
  priority text NOT NULL DEFAULT 'normal',
  assigned_at timestamptz NOT NULL DEFAULT now(),
  acknowledge_due_at timestamptz NULL,
  acknowledged_by integer NULL REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_at timestamptz NULL,
  completion_due_at timestamptz NULL,
  completed_by integer NULL REFERENCES users(id) ON DELETE SET NULL,
  completed_at timestamptz NULL,
  completion_notes text NULL,
  completion_attachment_path text NULL,
  updated_milestone text NULL,
  breached_at timestamptz NULL,
  cancelled_at timestamptz NULL,
  cancelled_by integer NULL REFERENCES users(id) ON DELETE SET NULL,
  created_by integer NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_voucher_actions_firm_voucher ON payment_voucher_actions (firm_id, payment_voucher_id, status);
CREATE INDEX IF NOT EXISTS idx_payment_voucher_actions_firm_assigned ON payment_voucher_actions (firm_id, assigned_user_id, status);
CREATE INDEX IF NOT EXISTS idx_payment_voucher_actions_firm_case ON payment_voucher_actions (firm_id, case_id);
CREATE INDEX IF NOT EXISTS idx_payment_voucher_actions_firm_completion_due ON payment_voucher_actions (firm_id, completion_due_at);
CREATE INDEX IF NOT EXISTS idx_payment_voucher_actions_firm_ack_due ON payment_voucher_actions (firm_id, acknowledge_due_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_voucher_actions_active
  ON payment_voucher_actions (firm_id, payment_voucher_id)
  WHERE status IN ('assigned', 'acknowledged');

ALTER TABLE payment_voucher_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_voucher_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_voucher_actions_rw ON payment_voucher_actions;
CREATE POLICY payment_voucher_actions_rw ON payment_voucher_actions FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON payment_voucher_create_requests TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON payment_voucher_actions TO app_user;

DO $do$ BEGIN
  IF to_regclass('public.payment_voucher_create_requests_id_seq') IS NOT NULL THEN
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.payment_voucher_create_requests_id_seq TO app_user';
  END IF;
  IF to_regclass('public.payment_voucher_actions_id_seq') IS NOT NULL THEN
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.payment_voucher_actions_id_seq TO app_user';
  END IF;
END $do$;
