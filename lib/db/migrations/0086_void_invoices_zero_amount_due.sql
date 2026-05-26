UPDATE invoices
SET amount_due = 0
WHERE status = 'void'
  AND deleted_at IS NULL
  AND amount_due <> 0;

