-- 0038_platform_ops_center_permissions_patch.sql
-- Idempotent patch: ensure Ops Center permission mappings exist for founder roles.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'platform_founder_roles'
  )
  AND EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'platform_founder_role_permissions'
  ) THEN
    WITH roles AS (
      SELECT id, code
      FROM platform_founder_roles
      WHERE code IN ('founder_viewer','founder_operator','founder_admin','founder_super_admin')
    ),
    perms AS (
      SELECT * FROM (VALUES
        ('founder.ops.read','founder_viewer'),
        ('founder.ops.read','founder_operator'),
        ('founder.ops.read','founder_admin'),
        ('founder.ops.read','founder_super_admin'),
        ('founder.ops.incident.note','founder_operator'),
        ('founder.ops.incident.note','founder_admin'),
        ('founder.ops.incident.note','founder_super_admin'),
        ('founder.ops.incident.ack','founder_operator'),
        ('founder.ops.incident.ack','founder_admin'),
        ('founder.ops.incident.ack','founder_super_admin'),
        ('founder.ops.incident.resolve','founder_admin'),
        ('founder.ops.incident.resolve','founder_super_admin'),
        ('founder.ops.incident.dismiss','founder_admin'),
        ('founder.ops.incident.dismiss','founder_super_admin'),
        ('founder.ops.recommendation.execute','founder_operator'),
        ('founder.ops.recommendation.execute','founder_admin'),
        ('founder.ops.recommendation.execute','founder_super_admin'),
        ('founder.ops.recommendation.recompute','founder_admin'),
        ('founder.ops.recommendation.recompute','founder_super_admin')
      ) AS t(permission_code, role_code)
    )
    INSERT INTO platform_founder_role_permissions (role_id, permission_code)
    SELECT r.id, p.permission_code
    FROM perms p
    JOIN roles r ON r.code = p.role_code
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

