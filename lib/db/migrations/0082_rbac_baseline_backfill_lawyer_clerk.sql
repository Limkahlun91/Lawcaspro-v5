-- Backfill baseline read permissions for standard staff roles.
-- This is additive and does not overwrite existing allowed/denied rows.

INSERT INTO permissions (role_id, module, action, allowed)
SELECT r.id, v.module, v.action, TRUE
FROM roles r
JOIN (
  VALUES
    ('dashboard','read'),
    ('cases','read'),
    ('projects','read'),
    ('users','read')
) AS v(module, action) ON TRUE
WHERE r.name IN ('Lawyer','Senior Lawyer','Clerk','Senior Clerk','Admin','Manager','Viewer')
  AND NOT EXISTS (
    SELECT 1 FROM permissions p
    WHERE p.role_id = r.id AND p.module = v.module AND p.action = v.action
  );

