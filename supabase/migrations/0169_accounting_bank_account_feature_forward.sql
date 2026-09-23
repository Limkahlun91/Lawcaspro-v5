-- Migration 0169 — accounting.bank_account forward registration (Supabase parity)
-- Scope: platform feature catalog only.
--
-- Canonical idempotent pattern: INSERT ... ON CONFLICT (feature_key) DO NOTHING.
-- Historical reseed migrations (0150_full_feature_registry_reseed /
-- p6_entitlement_runtime_foundation) remain immutable; existing databases that
-- already ran them will receive the new feature row ONLY via this forward file.

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
