-- LAWCASEPRO V5 PLATFORM FEATURES + PLAN ENTITLEMENTS SEED
-- Idempotent INSERT ... ON CONFLICT DO NOTHING
-- Run AFTER migration 0148 has been applied

BEGIN;

-- ============================================================================
-- A. PLATFORM FEATURES (catalog) — one-time seed
-- ============================================================================

-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
-- Module: dashboard / core
-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
INSERT INTO platform_features (feature_key, name, module, value_type, default_value, configurable, founder_only, status)
VALUES
  ('module.dashboard',          'Dashboard Access',         'dashboard', 'boolean', 'true',  true, false, 'active'),
  ('module.workbench',          'My Workbench',            'dashboard', 'boolean', 'true',  true, false, 'active')
ON CONFLICT (feature_key) DO NOTHING;

-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
-- Module: cases / conveyancing core
-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
INSERT INTO platform_features (feature_key, name, module, value_type, default_value, configurable, founder_only, status)
VALUES
  ('module.cases',              'Cases Module',             'cases',     'boolean', 'true',  true, false, 'active'),
  ('limit.cases.max',           'Max Active Cases',         'cases',     'integer', 'null',  true, false, 'active'),
  ('limit.cases.monthly_new',   'New Cases / Month',        'cases',     'integer', 'null',  true, false, 'active'),
  ('feature.cases.intake',      'Case Intake Form',         'cases',     'boolean', 'false', true, false, 'active'),
  ('feature.cases.conflict_check','Conflict Check',        'cases',     'boolean', 'false', true, false, 'active'),
  ('feature.cases.monitor',     'Case Monitor SLA',         'cases',     'boolean', 'false', true, false, 'active')
ON CONFLICT (feature_key) DO NOTHING;

-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
-- Module: projects / developers / clients
-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
INSERT INTO platform_features (feature_key, name, module, value_type, default_value, configurable, founder_only, status)
VALUES
  ('module.projects',           'Projects Module',          'projects',  'boolean', 'true',  true, false, 'active'),
  ('module.developers',         'Developers CRM',           'projects',  'boolean', 'true',  true, false, 'active'),
  ('module.clients',            'Clients CRM',              'projects',  'boolean', 'true',  true, false, 'active')
ON CONFLICT (feature_key) DO NOTHING;

-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
-- Module: documents / templates / automation
-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
INSERT INTO platform_features (feature_key, name, module, parent_feature_key, value_type, default_value, configurable, founder_only, status)
VALUES
  ('module.documents',          'Documents Module',         'documents', NULL,               'boolean', 'true',  true, false, 'active'),
  ('feature.documents.templates','Document Templates',     'documents', 'module.documents', 'boolean', 'true',  true, false, 'active'),
  ('feature.documents.automation','Document Automation',   'documents', 'module.documents', 'boolean', 'true',  true, false, 'active'),
  ('limit.documents.generation_monthly','Generated Docs / Month','documents','module.documents','integer', 'null', true, false, 'active')
ON CONFLICT (feature_key) DO NOTHING;

-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
-- Module: accounting / finance hub
-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
INSERT INTO platform_features (feature_key, name, module, value_type, default_value, configurable, founder_only, status)
VALUES
  ('module.accounting',         'Accounting Module',        'accounting','boolean', 'true',   true, false, 'active'),
  ('feature.accounting.invoices','Invoice Generation',     'accounting','boolean', 'true',   true, false, 'active'),
  ('feature.accounting.payment_vouchers','Payment Vouchers','accounting','boolean','true',   true, false, 'active'),
  ('feature.accounting.receipts','Receipts',               'accounting','boolean', 'true',   true, false, 'active'),
  ('feature.accounting.reconciliation','Bank Reconciliation','accounting','boolean','false',  true, false, 'active'),
  ('feature.accounting.reports','Financial Reports',       'accounting','boolean', 'true',   true, false, 'active'),
  ('feature.accounting.einvoices','E-Invoice (LHDN)',      'accounting','boolean', 'false',  true, false, 'active')
ON CONFLICT (feature_key) DO NOTHING;

-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
-- Module: communications
-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
INSERT INTO platform_features (feature_key, name, module, value_type, default_value, configurable, founder_only, status)
VALUES
  ('module.communications',     'Communications Hub',       'comms',     'boolean', 'false', true, false, 'active'),
  ('feature.comms.email',       'Email Control',            'comms',     'boolean', 'false', true, false, 'active'),
  ('feature.comms.whatsapp',    'WhatsApp Inbox',           'comms',     'boolean', 'false', true, false, 'active')
ON CONFLICT (feature_key) DO NOTHING;

-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
-- Module: HR (paid addon)
-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
INSERT INTO platform_features (feature_key, name, module, value_type, default_value, configurable, founder_only, status)
VALUES
  ('module.hr',                 'HR Module',                'hr',        'boolean', 'false', true, false, 'active'),
  ('feature.hr.attendance',     'HR Attendance',            'hr',        'boolean', 'false', true, false, 'active'),
  ('feature.hr.leave',          'HR Leave',                 'hr',        'boolean', 'false', true, false, 'active'),
  ('feature.hr.payroll',        'HR Payroll',               'hr',        'boolean', 'false', true, false, 'active'),
  ('feature.hr.claims',         'HR Claims',                'hr',        'boolean', 'false', true, false, 'active'),
  ('feature.hr.recruitment',    'HR Recruitment',           'hr',        'boolean', 'false', true, false, 'active'),
  ('feature.hr.performance',    'HR Performance',           'hr',        'boolean', 'false', true, false, 'active'),
  ('feature.hr.training',       'HR Training',              'hr',        'boolean', 'false', true, false, 'active'),
  ('feature.hr.assets',         'HR Assets',                'hr',        'boolean', 'false', true, false, 'active'),
  ('feature.hr.offboarding',    'HR Offboarding',           'hr',        'boolean', 'false', true, false, 'active')
ON CONFLICT (feature_key) DO NOTHING;

-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
-- Module: users / teams / roles / rbac
-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
INSERT INTO platform_features (feature_key, name, module, value_type, default_value, configurable, founder_only, status)
VALUES
  ('module.users',              'Users & Teams',            'rbac',      'boolean', 'true',  true, false, 'active'),
  ('limit.users.max',           'Max Users',                'rbac',      'integer', '5',     true, false, 'active'),
  ('module.roles',              'Roles & Permissions',      'rbac',      'boolean', 'true',  true, false, 'active')
ON CONFLICT (feature_key) DO NOTHING;

-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
-- Module: storage / file custody
-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
INSERT INTO platform_features (feature_key, name, module, value_type, default_value, configurable, founder_only, status)
VALUES
  ('limit.storage.gb',          'Storage (GB)',             'storage',   'decimal', '10',    true, false, 'active'),
  ('module.file_custody',       'File Custody Registry',    'storage',   'boolean', 'false', true, false, 'active')
ON CONFLICT (feature_key) DO NOTHING;

-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
-- Module: AI / OCR (paid addons)
-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
INSERT INTO platform_features (feature_key, name, module, value_type, default_value, configurable, founder_only, status)
VALUES
  ('module.ai',                 'AI Assistants',            'ai',        'boolean', 'false', true, false, 'active'),
  ('limit.ai.ocr_pages_monthly','OCR Pages / Month',        'ai',        'integer', '0',     true, false, 'active'),
  ('limit.ai.draft_tokens_monthly','AI Draft Tokens / Mo', 'ai',        'integer', '0',     true, false, 'active')
ON CONFLICT (feature_key) DO NOTHING;

-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
-- Module: reports / audit / settings
-- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --
INSERT INTO platform_features (feature_key, name, module, value_type, default_value, configurable, founder_only, status)
VALUES
  ('module.reports',            'Reports',                  'reports',   'boolean', 'true',  true, false, 'active'),
  ('module.audit_logs',         'Audit Logs',               'governance','boolean', 'true',  true, false, 'active'),
  ('module.settings',           'Firm Settings',            'governance','boolean', 'true',  true, false, 'active')
ON CONFLICT (feature_key) DO NOTHING;

-- ============================================================================
-- B. PLAN ENTITLEMENTS SEED — Starter (free) / Pro baseline
--    Plans are created in migration 0079 (subscription_plans table + starter row, plus any existing firms.subscription_plan names).
--    We upsert plan entitlements keyed by plan_name -> (plan_id, feature_key).
-- ============================================================================

-- Helper: populate plan_entitlements for every feature that currently has a matching plan,
-- using a conservative default: Starter = core only, Pro = most modules.
DO $$
DECLARE
  r record;
  starter_id integer;
  pro_id integer;
BEGIN
  SELECT id INTO starter_id FROM subscription_plans WHERE lower(name) = 'starter' LIMIT 1;
  SELECT id INTO pro_id     FROM subscription_plans WHERE lower(name) IN ('pro','professional') LIMIT 1;

  -- =========================================================================
  -- Starter plan entitlements (if starter plan exists)
  -- =========================================================================
  IF starter_id IS NOT NULL THEN
    -- booleans
    FOR r IN SELECT * FROM (VALUES
      ('module.dashboard',          'true'),
      ('module.workbench',          'true'),
      ('module.cases',              'true'),
      ('module.projects',           'true'),
      ('module.developers',         'true'),
      ('module.clients',            'true'),
      ('module.documents',          'true'),
      ('feature.documents.templates','true'),
      ('feature.documents.automation','true'),
      ('module.accounting',         'true'),
      ('feature.accounting.invoices','true'),
      ('feature.accounting.payment_vouchers','true'),
      ('feature.accounting.receipts','true'),
      ('feature.accounting.reports','true'),
      ('module.users',              'true'),
      ('module.roles',              'true'),
      ('module.reports',            'true'),
      ('module.audit_logs',         'true'),
      ('module.settings',           'true'),
      -- explicitly disabled in starter
      ('feature.cases.intake',      'false'),
      ('feature.cases.conflict_check','false'),
      ('feature.cases.monitor',     'false'),
      ('feature.accounting.reconciliation','false'),
      ('feature.accounting.einvoices','false'),
      ('module.communications',     'false'),
      ('feature.comms.email',       'false'),
      ('feature.comms.whatsapp',    'false'),
      ('module.hr',                 'false'),
      ('feature.hr.attendance',     'false'),
      ('feature.hr.leave',          'false'),
      ('feature.hr.payroll',        'false'),
      ('feature.hr.claims',         'false'),
      ('feature.hr.recruitment',    'false'),
      ('feature.hr.performance',    'false'),
      ('feature.hr.training',       'false'),
      ('feature.hr.assets',         'false'),
      ('feature.hr.offboarding',    'false'),
      ('module.file_custody',       'false'),
      ('module.ai',                 'false')
    ) AS t(fk, val) LOOP
      INSERT INTO plan_entitlements (plan_id, feature_key, value_json, created_at, updated_at)
      VALUES (starter_id, r.fk, to_jsonb(r.val::boolean), now(), now())
      ON CONFLICT (plan_id, feature_key) DO NOTHING;
    END LOOP;

    -- integer/decimal limits for starter
    FOR r IN SELECT * FROM (VALUES
      ('limit.users.max',                   '5'::text),
      ('limit.storage.gb',                  '5'::text),
      ('limit.ai.ocr_pages_monthly',        '0'::text),
      ('limit.ai.draft_tokens_monthly',     '0'::text)
    ) AS t(fk, val) LOOP
      INSERT INTO plan_entitlements (plan_id, feature_key, value_json, created_at, updated_at)
      VALUES (starter_id, r.fk, to_jsonb(r.val::int), now(), now())
      ON CONFLICT (plan_id, feature_key) DO NOTHING;
    END LOOP;

    -- unlimited / null (meaning no limit) for starter — null => not enforced
    FOR r IN SELECT * FROM (VALUES
      ('limit.cases.max'::text),
      ('limit.cases.monthly_new'),
      ('limit.documents.generation_monthly')
    ) AS t(fk) LOOP
      INSERT INTO plan_entitlements (plan_id, feature_key, value_json, created_at, updated_at)
      VALUES (starter_id, r.fk, 'null'::jsonb, now(), now())
      ON CONFLICT (plan_id, feature_key) DO NOTHING;
    END LOOP;
  END IF;

  -- =========================================================================
  -- Pro plan entitlements (if pro plan exists)
  -- =========================================================================
  IF pro_id IS NOT NULL THEN
    FOR r IN SELECT * FROM (VALUES
      ('module.dashboard',          'true'),
      ('module.workbench',          'true'),
      ('module.cases',              'true'),
      ('feature.cases.intake',      'true'),
      ('feature.cases.conflict_check','true'),
      ('feature.cases.monitor',     'true'),
      ('module.projects',           'true'),
      ('module.developers',         'true'),
      ('module.clients',            'true'),
      ('module.documents',          'true'),
      ('feature.documents.templates','true'),
      ('feature.documents.automation','true'),
      ('module.accounting',         'true'),
      ('feature.accounting.invoices','true'),
      ('feature.accounting.payment_vouchers','true'),
      ('feature.accounting.receipts','true'),
      ('feature.accounting.reconciliation','true'),
      ('feature.accounting.reports','true'),
      ('feature.accounting.einvoices','false'),
      ('module.users',              'true'),
      ('module.roles',              'true'),
      ('module.reports',            'true'),
      ('module.audit_logs',         'true'),
      ('module.settings',           'true'),
      ('module.file_custody',       'true'),
      ('module.communications',     'false'),
      ('feature.comms.email',       'false'),
      ('feature.comms.whatsapp',    'false'),
      ('module.hr',                 'false'),
      ('feature.hr.attendance',     'false'),
      ('feature.hr.leave',          'false'),
      ('feature.hr.payroll',        'false'),
      ('feature.hr.claims',         'false'),
      ('feature.hr.recruitment',    'false'),
      ('feature.hr.performance',    'false'),
      ('feature.hr.training',       'false'),
      ('feature.hr.assets',         'false'),
      ('feature.hr.offboarding',    'false'),
      ('module.ai',                 'false')
    ) AS t(fk, val) LOOP
      INSERT INTO plan_entitlements (plan_id, feature_key, value_json, created_at, updated_at)
      VALUES (pro_id, r.fk, to_jsonb(r.val::boolean), now(), now())
      ON CONFLICT (plan_id, feature_key) DO NOTHING;
    END LOOP;

    -- limits for pro
    FOR r IN SELECT * FROM (VALUES
      ('limit.users.max',                   '30'::text),
      ('limit.storage.gb',                  '100'::text),
      ('limit.ai.ocr_pages_monthly',        '0'::text),
      ('limit.ai.draft_tokens_monthly',     '0'::text)
    ) AS t(fk, val) LOOP
      INSERT INTO plan_entitlements (plan_id, feature_key, value_json, created_at, updated_at)
      VALUES (pro_id, r.fk, to_jsonb(r.val::int), now(), now())
      ON CONFLICT (plan_id, feature_key) DO NOTHING;
    END LOOP;

    FOR r IN SELECT * FROM (VALUES
      ('limit.cases.max'::text),
      ('limit.cases.monthly_new'),
      ('limit.documents.generation_monthly')
    ) AS t(fk) LOOP
      INSERT INTO plan_entitlements (plan_id, feature_key, value_json, created_at, updated_at)
      VALUES (pro_id, r.fk, 'null'::jsonb, now(), now())
      ON CONFLICT (plan_id, feature_key) DO NOTHING;
    END LOOP;
  END IF;
END $$;

COMMIT;
