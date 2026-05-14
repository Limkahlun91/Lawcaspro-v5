ALTER TABLE invoice_items
ADD COLUMN IF NOT EXISTS item_category text NOT NULL DEFAULT 'fee';

ALTER TABLE quotation_items
ADD COLUMN IF NOT EXISTS item_category text NOT NULL DEFAULT 'fee';

UPDATE invoice_items
SET item_category = 'disbursement'
WHERE item_type IN ('disbursement', 'trust_amount', 'pass_through');

UPDATE quotation_items
SET item_category = 'disbursement'
WHERE section IN ('disbursement', 'reimbursement', 'attachment')
   OR item_type IN ('disbursement', 'trust_amount', 'pass_through');

