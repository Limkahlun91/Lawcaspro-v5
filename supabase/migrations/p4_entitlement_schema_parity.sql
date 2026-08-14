-- =============================================================================
-- PART 4 — Entitlement & Billing Schema Parity (ADDITIVE ONLY, idempotent)
-- =============================================================================
-- Goal: ensure the following drizzle-declared tables & indexes exist in Supabase
-- so entitlement resolve pipeline and billing ledgers never throw relation DNE.
-- Rules:
--   * All CREATE TABLE / INDEX use IF NOT EXISTS (strictly additive).
--   * No column drops, no data movement, no ALTER COLUMN type rewrites.
--   * Foreign key references point at sibling FK target tables that are also
--     idempotently created in this file (firms / subscription_plans / firm_invoices).
-- Covers:
--   1) platform_features            (feature catalog registry)
--   2) plan_entitlements            (plan -> feature base entitlements layer 4)
--   3) firm_entitlement_overrides   (per-firm permanent / temp overrides, layer 7)
--   4) hr_firm_feature_flags        (legacy HR boolean flag table for requireHRModuleEnabled)
--   5) subscription_plans           (FK target for plan_id cols)
--   6) firm_invoices                (FK target for billing_ledger.invoice_id)
--   7) subscription_history         (append-only plan / status audit log)
--   8) billing_ledger               (append-only firm financial ledger)
--   9) usage_counters               (periodic metric meter per firm)
-- =============================================================================

-- ═══════════════════════════════════════════════════════════════════════════
-- 0. Parent FK targets
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.firms (
    id serial PRIMARY KEY,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.subscription_plans (
    id serial PRIMARY KEY,
    code text NOT NULL,
    name text NOT NULL,
    description text,
    monthly_price numeric(12,2) NOT NULL DEFAULT 0,
    annual_price numeric(12,2) NOT NULL DEFAULT 0,
    currency text NOT NULL DEFAULT 'MYR',
    status text NOT NULL DEFAULT 'active',
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_subscription_plans_code ON public.subscription_plans(code);
CREATE INDEX IF NOT EXISTS idx_subscription_plans_status ON public.subscription_plans(status);

CREATE TABLE IF NOT EXISTS public.firm_invoices (
    id serial PRIMARY KEY,
    firm_id integer NOT NULL REFERENCES public.firms(id) ON DELETE CASCADE,
    invoice_no text NOT NULL,
    status text NOT NULL DEFAULT 'draft',
    total_amount numeric(12,2) NOT NULL DEFAULT 0,
    currency text NOT NULL DEFAULT 'MYR',
    issue_date date,
    due_date date,
    paid_date date,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_firm_invoices_no ON public.firm_invoices(invoice_no);
CREATE INDEX IF NOT EXISTS idx_firm_invoices_firm ON public.firm_invoices(firm_id);
CREATE INDEX IF NOT EXISTS idx_firm_invoices_status ON public.firm_invoices(status);

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. platform_features — feature key registry
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.platform_features (
    id serial PRIMARY KEY,
    feature_key text NOT NULL,
    name text NOT NULL,
    module text NOT NULL DEFAULT 'general',
    parent_feature_key text,
    value_type text NOT NULL DEFAULT 'boolean',
    default_value jsonb NOT NULL DEFAULT 'false'::jsonb,
    configurable boolean NOT NULL DEFAULT true,
    founder_only boolean NOT NULL DEFAULT false,
    dependency_json jsonb NOT NULL DEFAULT '[]'::jsonb,
    route_hint text,
    description text,
    sort_order integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_features_feature_key ON public.platform_features(feature_key);
CREATE INDEX IF NOT EXISTS idx_platform_features_module ON public.platform_features(module);
CREATE INDEX IF NOT EXISTS idx_platform_features_status ON public.platform_features(status);
CREATE INDEX IF NOT EXISTS idx_platform_features_parent ON public.platform_features(parent_feature_key);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. plan_entitlements — base plan entitlements
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.plan_entitlements (
    id serial PRIMARY KEY,
    plan_id integer NOT NULL REFERENCES public.subscription_plans(id) ON DELETE CASCADE,
    feature_key text NOT NULL,
    value_json jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_entitlements_plan_feature ON public.plan_entitlements(plan_id, feature_key);
CREATE INDEX IF NOT EXISTS idx_plan_entitlements_plan ON public.plan_entitlements(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_entitlements_feature ON public.plan_entitlements(feature_key);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. firm_entitlement_overrides — per-firm override rows
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
CREATE INDEX IF NOT EXISTS idx_firm_entitlement_firm           ON public.firm_entitlement_overrides(firm_id);
CREATE INDEX IF NOT EXISTS idx_firm_entitlement_feature        ON public.firm_entitlement_overrides(feature_key);
CREATE INDEX IF NOT EXISTS idx_firm_entitlement_effective      ON public.firm_entitlement_overrides(firm_id, feature_key, effective_from, expires_at);
CREATE INDEX IF NOT EXISTS idx_firm_entitlement_billing_type   ON public.firm_entitlement_overrides(firm_id, billing_type);
CREATE INDEX IF NOT EXISTS idx_firm_entitlement_kind           ON public.firm_entitlement_overrides(firm_id, override_kind);
CREATE UNIQUE INDEX IF NOT EXISTS uq_firm_entitlement_permanent
    ON public.firm_entitlement_overrides(firm_id, feature_key)
    WHERE (override_kind = 'permanent');

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. hr_firm_feature_flags — legacy HR boolean row per firm
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

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. subscription_history — append-only plan / status log
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.subscription_history (
    id serial PRIMARY KEY,
    firm_id integer NOT NULL REFERENCES public.firms(id) ON DELETE CASCADE,
    old_plan_id integer REFERENCES public.subscription_plans(id),
    new_plan_id integer REFERENCES public.subscription_plans(id),
    old_status text,
    new_status text NOT NULL,
    price_snapshot numeric(12,2),
    changed_by integer,
    reason text,
    before_json jsonb,
    after_json jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscription_history_firm ON public.subscription_history(firm_id);
CREATE INDEX IF NOT EXISTS idx_subscription_history_created ON public.subscription_history(firm_id, created_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. billing_ledger — append-only firm financial ledger
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.billing_ledger (
    id bigserial PRIMARY KEY,
    firm_id integer NOT NULL REFERENCES public.firms(id) ON DELETE RESTRICT,
    subscription_id integer,
    invoice_id integer REFERENCES public.firm_invoices(id) ON DELETE SET NULL,
    idempotency_key text,
    entry_type text NOT NULL,
    description text NOT NULL,
    billing_period_start date,
    billing_period_end date,
    debit numeric(18,2) NOT NULL DEFAULT 0,
    credit numeric(18,2) NOT NULL DEFAULT 0,
    currency text NOT NULL DEFAULT 'MYR',
    reference_no text,
    correlation_id text,
    source_type text,
    source_id integer,
    due_date date,
    paid_date date,
    status text NOT NULL DEFAULT 'posted',
    payment_reference text,
    payment_method text,
    running_balance numeric(18,2) NOT NULL DEFAULT 0,
    created_by integer,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_billing_ledger_firm            ON public.billing_ledger(firm_id);
CREATE INDEX IF NOT EXISTS idx_billing_ledger_firm_created    ON public.billing_ledger(firm_id, created_at);
CREATE INDEX IF NOT EXISTS idx_billing_ledger_invoice         ON public.billing_ledger(invoice_id);
CREATE INDEX IF NOT EXISTS idx_billing_ledger_period          ON public.billing_ledger(firm_id, billing_period_start, billing_period_end);
CREATE INDEX IF NOT EXISTS idx_billing_ledger_entry_type      ON public.billing_ledger(firm_id, entry_type);
CREATE INDEX IF NOT EXISTS idx_billing_ledger_status          ON public.billing_ledger(status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_ledger_idempotency
    ON public.billing_ledger(firm_id, idempotency_key)
    WHERE (idempotency_key IS NOT NULL);

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. usage_counters — period metric meter (firm × metric × period)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.usage_counters (
    id bigserial PRIMARY KEY,
    firm_id integer NOT NULL REFERENCES public.firms(id) ON DELETE CASCADE,
    metric_key text NOT NULL,
    period_key text NOT NULL,
    counter numeric(18,2) NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_usage_counters_firm_metric_period
    ON public.usage_counters(firm_id, metric_key, period_key);
CREATE INDEX IF NOT EXISTS idx_usage_counters_firm   ON public.usage_counters(firm_id);
CREATE INDEX IF NOT EXISTS idx_usage_counters_period ON public.usage_counters(firm_id, period_key);
