-- ============================================================
-- 0143_firm_scoped_number_sequences.sql
--
-- Scope:    Firm-scoped next-value sequences for invoice_no, receipt_no, payment voucher_no
-- Status:   ADDITIVE ONLY (no destructive DDL)
-- Depends:  0122_accounting_settings_and_payment_voucher_sla.sql
--           (creates firms, invoices, receipts, payment_vouchers tables)
--
-- RQ-1:  Eliminate COUNT(*)-based invoice/receipt/voucher number generators
--        (race-prone under concurrent creation → duplicates despite UNIQUE index)
-- RQ-2:  Persist next_value per (firm_id, seq_name) in a RLS-protected table
-- RQ-3:  Initial backfill from existing rows (parse INV-YYYY-NNNN / REC-YYYY-NNNN / PV-*),
--        with safe fallback next_value = COUNT(*) + 1 when parse fails
-- RQ-4:  Idempotent: CREATE TABLE IF NOT EXISTS + INSERT ON CONFLICT DO NOTHING
-- ============================================================

SET search_path TO public;

-- RQ-1 / RQ-4: Create firm_number_sequences table (idempotent)
CREATE TABLE IF NOT EXISTS firm_number_sequences (
  firm_id     integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  seq_name    text    NOT NULL CHECK (seq_name IN ('invoice_no', 'receipt_no', 'voucher_no')),
  next_value  integer NOT NULL DEFAULT 1 CHECK (next_value >= 1),
  updated_at  timestamptz NOT NULL DEFAULT NOW(),
  last_prefix text,
  PRIMARY KEY (firm_id, seq_name)
);

-- RLS enabled + forced for tenant isolation
ALTER TABLE firm_number_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE firm_number_sequences FORCE ROW LEVEL SECURITY;

-- RLS policy: RW per firm_id only (founder override preserved)
DROP POLICY IF EXISTS firm_number_sequences_rw ON firm_number_sequences;
CREATE POLICY firm_number_sequences_rw ON firm_number_sequences FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

-- Index on (firm_id, seq_name) is already provided by the composite PK.
-- Additional index for fast updated_at lookups:
CREATE INDEX IF NOT EXISTS idx_firm_number_sequences_updated_at
  ON firm_number_sequences (updated_at);

-- ============================================================
-- RQ-3: BACKFILL (idempotent: INSERT ON CONFLICT DO NOTHING)
-- Strategy per seq_name:
--   A) Try to parse known patterns:
--        invoice_no ~ 'INV-<YYYY>-<NNNN>'          -> MAX(NNNN)   -> next_value = MAX(NNNN)+1
--        receipt_no ~ 'REC-<YYYY>-<NNNN>'          -> MAX(NNNN)   -> next_value = MAX(NNNN)+1
--        voucher_no ~ 'PV-*<digits>' (last numeric run)         -> next_value = MAX(digits)+1
--   B) Fallback if parse fails (NULL rows or no numeric part found):
--        next_value = COUNT(*) + 1
-- ============================================================

-- ---------- invoice_no ----------
INSERT INTO firm_number_sequences (firm_id, seq_name, next_value, updated_at, last_prefix)
SELECT
  f.id                                                     AS firm_id,
  'invoice_no'                                             AS seq_name,
  COALESCE(parsed.max_seq, cnt.n + 1, 1)                   AS next_value,
  NOW()                                                    AS updated_at,
  parsed.last_prefix
FROM firms f
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS n FROM invoices i WHERE i.firm_id = f.id
) cnt ON true
LEFT JOIN LATERAL (
  SELECT
    MAX((regexp_match(i.invoice_no, 'INV-\d{4}-(\d+)'))[1]::integer)      AS max_seq,
    MAX(LEFT(i.invoice_no, 8)) FILTER (WHERE i.invoice_no ~ '^INV-\d{4}-') AS last_prefix
  FROM invoices i
  WHERE i.firm_id = f.id AND i.invoice_no IS NOT NULL
) parsed ON true
ON CONFLICT (firm_id, seq_name) DO NOTHING;

-- ---------- receipt_no ----------
INSERT INTO firm_number_sequences (firm_id, seq_name, next_value, updated_at, last_prefix)
SELECT
  f.id                                                     AS firm_id,
  'receipt_no'                                             AS seq_name,
  COALESCE(parsed.max_seq, cnt.n + 1, 1)                   AS next_value,
  NOW()                                                    AS updated_at,
  parsed.last_prefix
FROM firms f
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS n FROM receipts r WHERE r.firm_id = f.id
) cnt ON true
LEFT JOIN LATERAL (
  SELECT
    MAX((regexp_match(r.receipt_no, 'REC-\d{4}-(\d+)'))[1]::integer)      AS max_seq,
    MAX(LEFT(r.receipt_no, 8)) FILTER (WHERE r.receipt_no ~ '^REC-\d{4}-') AS last_prefix
  FROM receipts r
  WHERE r.firm_id = f.id AND r.receipt_no IS NOT NULL
) parsed ON true
ON CONFLICT (firm_id, seq_name) DO NOTHING;

-- ---------- voucher_no (PV pattern: last contiguous numeric run) ----------
INSERT INTO firm_number_sequences (firm_id, seq_name, next_value, updated_at, last_prefix)
SELECT
  f.id                                                     AS firm_id,
  'voucher_no'                                             AS seq_name,
  COALESCE(parsed.max_seq, cnt.n + 1, 1)                   AS next_value,
  NOW()                                                    AS updated_at,
  parsed.last_prefix
FROM firms f
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS n FROM payment_vouchers v WHERE v.firm_id = f.id
) cnt ON true
LEFT JOIN LATERAL (
  SELECT
    MAX((regexp_match(v.voucher_no, '(\d+)(?!.*\d)'))[1]::integer) AS max_seq,
    MAX(CASE WHEN v.voucher_no ~ '^PV-' THEN LEFT(v.voucher_no, 3) ELSE NULL END) AS last_prefix
  FROM payment_vouchers v
  WHERE v.firm_id = f.id AND v.voucher_no IS NOT NULL
) parsed ON true
ON CONFLICT (firm_id, seq_name) DO NOTHING;

-- Update timestamp on rows that already existed but have stale next_value?
-- Intentionally NO: preflight audit should confirm rows via SELECT first;
-- re-seeding for existing rows would overwrite legitimate updates since the
-- last backfill. Caller can issue explicit UPDATEs via service layer if needed.
