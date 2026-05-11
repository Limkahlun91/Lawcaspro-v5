-- Add fine-grained permission for case assignment.
-- High-privilege roles (Partner / Manager / Lawyer) can assign cases to any staff.

INSERT INTO permissions (role_id, module, action, allowed)
SELECT r.id, 'cases', 'assign_any', TRUE
FROM roles r
WHERE r.name IN ('Partner', 'Manager', 'Senior Lawyer', 'Lawyer')
  AND NOT EXISTS (
    SELECT 1
    FROM permissions p
    WHERE p.role_id = r.id
      AND p.module = 'cases'
      AND p.action = 'assign_any'
  );

