-- Ensure permissions are unique per (role_id, module, action)
DELETE FROM permissions p
USING permissions p2
WHERE p.role_id = p2.role_id
  AND p.module = p2.module
  AND p.action = p2.action
  AND p.id > p2.id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_permissions_role_module_action
  ON permissions (role_id, module, action);

-- Baseline permissions for Partner roles (all firms)
INSERT INTO permissions (role_id, module, action, allowed)
SELECT r.id, v.module, v.action, TRUE
FROM roles r
JOIN (
  VALUES
    ('dashboard','read'),
    ('cases','read'),('cases','create'),('cases','update'),('cases','delete'),
    ('projects','read'),('projects','create'),('projects','update'),('projects','delete'),
    ('developers','read'),('developers','create'),('developers','update'),('developers','delete'),
    ('documents','read'),('documents','create'),('documents','update'),('documents','delete'),
    ('communications','read'),('communications','create'),('communications','update'),('communications','delete'),
    ('accounting','read'),('accounting','write'),
    ('reports','read'),('reports','export'),
    ('audit','read'),
    ('settings','read'),('settings','update'),
    ('users','read'),('users','create'),('users','update'),('users','delete'),
    ('roles','read'),('roles','create'),('roles','update'),('roles','delete')
) AS v(module, action) ON TRUE
WHERE r.name = 'Partner'
  AND NOT EXISTS (
    SELECT 1 FROM permissions p
    WHERE p.role_id = r.id AND p.module = v.module AND p.action = v.action
  );

-- Baseline permissions for Clerk roles (all firms)
INSERT INTO permissions (role_id, module, action, allowed)
SELECT r.id, v.module, v.action, TRUE
FROM roles r
JOIN (
  VALUES
    ('dashboard','read'),
    ('cases','read'),('cases','create'),('cases','update'),
    ('projects','read'),('projects','create'),('projects','update'),
    ('developers','read'),('developers','create'),('developers','update'),
    ('documents','read'),
    ('communications','read'),('communications','create'),
    ('accounting','read'),
    ('reports','read'),
    ('settings','read'),
    ('users','read')
) AS v(module, action) ON TRUE
WHERE r.name = 'Clerk'
  AND NOT EXISTS (
    SELECT 1 FROM permissions p
    WHERE p.role_id = r.id AND p.module = v.module AND p.action = v.action
  );
