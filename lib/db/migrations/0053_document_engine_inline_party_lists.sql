BEGIN;

INSERT INTO document_variable_definitions
  (key, label, description, category, value_type, source_path, formatter, example_value, is_system, is_active, sort_order, updated_at)
VALUES
  (
    'purchasers_inline',
    'Purchasers (Inline)',
    'Formatted purchaser list: A (NRIC NO.: X) & B (NRIC NO.: Y)',
    'purchaser',
    'string',
    'purchasers_inline',
    NULL,
    'Ali (NRIC NO.: 900101-14-5678) & Abu (NRIC NO.: 880202-10-1234)',
    TRUE,
    TRUE,
    245,
    now()
  ),
  (
    'borrowers_inline',
    'Borrowers (Inline)',
    'Formatted borrower list: A (NRIC NO.: X) & B (NRIC NO.: Y)',
    'loan',
    'string',
    'borrowers_inline',
    NULL,
    'Ali (NRIC NO.: 900101-14-5678)',
    TRUE,
    TRUE,
    335,
    now()
  ),
  (
    'vendors_inline',
    'Vendors (Inline)',
    'Formatted vendor list: A (NRIC NO.: X) & B (NRIC NO.: Y)',
    'custom',
    'string',
    'vendors_inline',
    NULL,
    'Vendor A (NRIC NO.: 900101-14-5678)',
    TRUE,
    TRUE,
    945,
    now()
  )
ON CONFLICT (key) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  value_type = EXCLUDED.value_type,
  source_path = EXCLUDED.source_path,
  formatter = EXCLUDED.formatter,
  example_value = EXCLUDED.example_value,
  is_system = TRUE,
  is_active = TRUE,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

COMMIT;

