-- Migration 0169 — accounting.bank_account forward registration
-- Scope: platform feature catalog only.
-- Backfills the platform_features row for accounting.bank_account so that
-- every existing DB (which already applied the historical p6 and 0150 reseeds
-- before accounting.bank_account was added to the canonical feature registry)
-- receives the row idempotently on a forward apply.
--
-- Historical reseed migrations (0150 / p6_entitlement_runtime_foundation)
-- remain immutable and are NOT edited.

INSERT INTO public.platform_features
  (feature_key, name, module, parent_feature_key, value_type, default_value, configurable, founder_only, dependency_json, route_hint, description, sort_order, status, created_at, updated_at)
VALUES
  (
    'accounting.bank_account',
    'Bank Accounts',
    'accounting',
    'module.accounting',
    'boolean',
    'true'::jsonb,
    true,
    false,
    '[]'::jsonb,
    NULL,
    NULL,
    0,
    'active',
    NOW(),
    NOW()
  )
ON CONFLICT (feature_key) DO NOTHING;
