-- Developer Portal: developer-scoped firm users + role baseline

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS developer_id integer;

DO $$ BEGIN
  ALTER TABLE users
    ADD CONSTRAINT users_developer_id_fkey
    FOREIGN KEY (developer_id) REFERENCES developers(id)
    ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_firm_developer
  ON users (firm_id, developer_id);

-- Ensure standard role exists for each firm
INSERT INTO roles (firm_id, name, is_system_role)
SELECT f.id, 'Developer_User', TRUE
FROM firms f
WHERE NOT EXISTS (
  SELECT 1 FROM roles r
  WHERE r.firm_id = f.id AND r.name = 'Developer_User'
);

-- Baseline permissions for Developer_User
INSERT INTO permissions (role_id, module, action, allowed)
SELECT r.id, v.module, v.action, TRUE
FROM roles r
CROSS JOIN (
  VALUES
    ('developer_portal','read'),
    ('developer_portal','export'),
    ('developer_portal','message')
) AS v(module, action)
WHERE r.name = 'Developer_User'
  AND NOT EXISTS (
    SELECT 1 FROM permissions p
    WHERE p.role_id = r.id AND p.module = v.module AND p.action = v.action
  );

