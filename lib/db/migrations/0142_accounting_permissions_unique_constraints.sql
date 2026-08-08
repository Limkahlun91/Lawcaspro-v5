-- ============================================================
-- 0140_t13_p1_unique_constraints_accounting_permissions.sql
--
-- Scope:    T13 Accounting P1 fixes
-- Status:   ADDITIVE ONLY (no destructive DDL)
-- Depends:  0122_accounting_settings_and_payment_voucher_sla.sql
--           (creates invoices, receipts, permissions tables)
--
-- RQ-1:  Prevent duplicate invoice_no / receipt_no per firm (race on COUNT(*) based generators)
-- I-1:   Prevent duplicate (role_id, module, action) rows in permissions table (causes privilege intersection bugs)
-- ============================================================

SET search_path TO public;

-- RQ-1a: invoices per-firm invoice numbers must be unique
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_firm_invoice_no
  ON invoices (firm_id, invoice_no);

-- RQ-1b: receipts per-firm receipt numbers must be unique
CREATE UNIQUE INDEX IF NOT EXISTS uq_receipts_firm_receipt_no
  ON receipts (firm_id, receipt_no);

-- I-1: one permission grant per (role, module, action)
CREATE UNIQUE INDEX IF NOT EXISTS uq_permissions_role_module_action
  ON permissions (role_id, module, action);
