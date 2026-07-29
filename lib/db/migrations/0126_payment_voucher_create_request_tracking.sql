ALTER TABLE payment_vouchers
  ADD COLUMN IF NOT EXISTS client_request_id text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_vouchers_client_request
  ON payment_vouchers (firm_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

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
