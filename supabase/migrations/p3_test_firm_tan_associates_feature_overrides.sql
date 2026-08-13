-- =============================================================================
-- PART 3 — Schema parity (additive only) + Founder Test Firm Permanent Feature Overrides
-- Target Firm: Messrs. Tan & Associates
-- =============================================================================
-- * Schema parity preamble: CREATE TABLE IF NOT EXISTS for entitlement tables
--   and HR legacy boolean flag tables required by the middleware & resolvers.
--   Idempotent, safe, additive. No destructive ops.
-- * Override section (below): enables 3 features for the named test firm ONLY:
--     1) module.hr            (HR module root)
--     2) communications.email (Email inbox/reply/forward)
--     3) cases.legacy_import  (Legacy Excel case import wizard)
--
-- Source classification (per PART 3 / Final Report item 4):
--   override_kind = 'permanent'
--   override_mode = 'enabled'   ->    "Founder Override (Permanent)"
-- =============================================================================

-- ═══════════════════════════════════════════════════════════════════════════
-- Preamble A: firms table (parent FK target; safe idempotent)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.firms (
    id serial PRIMARY KEY,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════════════════
-- Preamble B: firm_entitlement_overrides (entitlements resolver layer 7)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.firm_entitlement_overrides (
    id serial PRIMARY KEY,
    firm_id integer NOT NULL REFERENCES public.firms(id) ON DELETE CASCADE,
    feature_key text NOT NULL,
    override_kind text NOT NULL DEFAULT 'temporary',
    override_mode text NOT NULL DEFAULT 'custom',
    value_json jsonb,
    effective_from timestamptz,
    expires_at timestamptz,
    billing_type text NOT NULL DEFAULT 'included',
    price_override numeric(12,2),
    reason text,
    created_by integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Idempotent indexes / partial unique (CONCURRENTLY not allowed in tx; CREATE INDEX IF NOT EXISTS is fine)
CREATE INDEX IF NOT EXISTS idx_firm_entitlement_firm           ON public.firm_entitlement_overrides(firm_id);
CREATE INDEX IF NOT EXISTS idx_firm_entitlement_feature        ON public.firm_entitlement_overrides(feature_key);
CREATE INDEX IF NOT EXISTS idx_firm_entitlement_effective      ON public.firm_entitlement_overrides(firm_id, feature_key, effective_from, expires_at);
CREATE INDEX IF NOT EXISTS idx_firm_entitlement_billing_type   ON public.firm_entitlement_overrides(firm_id, billing_type);
CREATE INDEX IF NOT EXISTS idx_firm_entitlement_kind           ON public.firm_entitlement_overrides(firm_id, override_kind);
CREATE UNIQUE INDEX IF NOT EXISTS uq_firm_entitlement_permanent
    ON public.firm_entitlement_overrides(firm_id, feature_key)
    WHERE (override_kind = 'permanent');

-- ═══════════════════════════════════════════════════════════════════════════
-- Preamble C: hr_firm_feature_flags (legacy boolean table used by requireHRModuleEnabled)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.hr_firm_feature_flags (
    firm_id integer PRIMARY KEY,
    hr_enabled boolean NOT NULL DEFAULT false,
    hr_attendance_enabled boolean NOT NULL DEFAULT false,
    hr_payroll_enabled boolean NOT NULL DEFAULT false,
    hr_recruitment_enabled boolean NOT NULL DEFAULT false,
    hr_performance_enabled boolean NOT NULL DEFAULT false,
    hr_case_workload_enabled boolean NOT NULL DEFAULT false,
    hr_claims_enabled boolean NOT NULL DEFAULT true,
    hr_leave_enabled boolean NOT NULL DEFAULT true,
    hr_documents_enabled boolean NOT NULL DEFAULT true,
    hr_self_service_enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by_user_id integer,
    version integer NOT NULL DEFAULT 1
);

-- =============================================================================
-- Override rows: resolve firm by name then INSERT ON CONFLICT DO NOTHING / UPDATE
-- =============================================================================

DO $$
DECLARE
    v_firm_id   integer;
BEGIN
    -- 1. Resolve target firm id by name (no hardcoded firm id) -----------
    SELECT id
      INTO v_firm_id
      FROM public.firms
     WHERE name = 'Messrs. Tan & Associates'
     LIMIT 1;

    IF v_firm_id IS NULL THEN
        -- Firm not present in this environment yet (preview/seeding race).
        -- Graceful no-op; migration does not fail the gate.
        RAISE NOTICE 'P3 override: target firm "Messrs. Tan & Associates" not found. Skipping.';
        RETURN;
    END IF;

    -- =====================================================================
    -- 2. Permanent Founder Override rows (entitlements layer 7 "Firm override perma")
    -- =====================================================================
    INSERT INTO public.firm_entitlement_overrides
        (firm_id, feature_key, override_kind, override_mode, value_json,
         effective_from, expires_at, billing_type, price_override,
         reason, created_by, created_at, updated_at)
    VALUES
        (v_firm_id, 'module.hr',             'permanent', 'enabled', NULL,
         NOW(), NULL, 'included', NULL,
         'Founder test firm enablement — PART 3 / HR module permanent override', NULL, NOW(), NOW()),
        (v_firm_id, 'communications.email',  'permanent', 'enabled', NULL,
         NOW(), NULL, 'included', NULL,
         'Founder test firm enablement — PART 3 / Email inbox permanent override', NULL, NOW(), NOW()),
        (v_firm_id, 'cases.legacy_import',   'permanent', 'enabled', NULL,
         NOW(), NULL, 'included', NULL,
         'Founder test firm enablement — PART 3 / Legacy case import permanent override', NULL, NOW(), NOW())
    ON CONFLICT (firm_id, feature_key) WHERE (override_kind = 'permanent') DO NOTHING;

    -- =====================================================================
    -- 3. HR legacy boolean flag (requireHRModuleEnabled reads hr_enabled)
    -- =====================================================================
    INSERT INTO public.hr_firm_feature_flags
        (firm_id, hr_enabled, hr_attendance_enabled, hr_payroll_enabled,
         hr_recruitment_enabled, hr_performance_enabled, hr_case_workload_enabled,
         hr_claims_enabled, hr_leave_enabled, hr_documents_enabled,
         hr_self_service_enabled, created_at, updated_at, updated_by_user_id, version)
    VALUES
        (v_firm_id, TRUE,  TRUE,  TRUE,
         TRUE,  TRUE,  FALSE,
         TRUE,  TRUE,  TRUE,
         TRUE,  NOW(), NOW(), NULL, 1)
    ON CONFLICT (firm_id) DO UPDATE SET
        hr_enabled = TRUE,
        hr_attendance_enabled = TRUE,
        hr_payroll_enabled    = TRUE,
        hr_recruitment_enabled = TRUE,
        hr_performance_enabled = TRUE,
        hr_claims_enabled      = TRUE,
        hr_leave_enabled       = TRUE,
        hr_documents_enabled   = TRUE,
        hr_self_service_enabled = TRUE,
        updated_at             = NOW(),
        version                = public.hr_firm_feature_flags.version + 1;

    RAISE NOTICE 'P3 override: firm % (%) — HR/Email/LegacyImport overrides applied.', v_firm_id, 'Messrs. Tan & Associates';
END $$;

