BEGIN;

INSERT INTO permissions (role_id, module, action, allowed)
SELECT p.role_id, 'documents', 'generate', TRUE
FROM permissions p
WHERE p.module = 'documents'
  AND p.action = 'create'
  AND p.allowed = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM permissions x
    WHERE x.role_id = p.role_id AND x.module = 'documents' AND x.action = 'generate'
  );

INSERT INTO permissions (role_id, module, action, allowed)
SELECT p.role_id, 'documents', 'export', TRUE
FROM permissions p
WHERE p.module = 'documents'
  AND p.action = 'read'
  AND p.allowed = TRUE
  AND NOT EXISTS (
    SELECT 1 FROM permissions x
    WHERE x.role_id = p.role_id AND x.module = 'documents' AND x.action = 'export'
  );

COMMIT;
