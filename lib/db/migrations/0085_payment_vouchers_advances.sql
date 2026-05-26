ALTER TABLE payment_vouchers
  ADD COLUMN IF NOT EXISTS is_advance boolean NOT NULL DEFAULT false;

ALTER TABLE payment_vouchers
  ADD COLUMN IF NOT EXISTS approved_by integer;

