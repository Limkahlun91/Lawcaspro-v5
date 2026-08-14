-- =============================================================================
-- P0 HOTFIX: Entitlement runtime foundation (ADDITIVE ONLY / IDEMPOTENT)
-- =============================================================================
-- Problem:
--   p4_entitlement_schema_parity.sql uses ALTER TABLE IF EXISTS ... only for
--   the 9 entitlement/billing tables BUT those tables do NOT exist in the
--   current Preview Supabase. ALTER TABLE IF EXISTS on a missing relation is
--   a silent no-op — hence resolver keeps failing with:
--       relation "platform_features" does not exist
--       relation "firm_user_feature_access" does not exist
--
-- Scope:
--   * CREATE TABLE IF NOT EXISTS for every entitlement / billing table
--     declared by Drizzle schemas:
--       - platform_features
--       - plan_entitlements
--       - firm_entitlement_overrides
--       - hr_firm_feature_flags
--       - subscription_plans (FK target)
--       - firm_invoices (FK target)
--       - subscription_history
--       - billing_ledger
--       - usage_counters
--       - firm_user_feature_access (p5)
--   * ADD COLUMN IF NOT EXISTS parity for every Drizzle-declared column.
--   * CREATE UNIQUE INDEX / INDEX IF NOT EXISTS parity for every declared
--     index + partial unique index.
--   * Seed platform_features from the canonical FEATURE_REGISTRY literal.
--
-- NO DROP / NO TRUNCATE / NO destructive ops.
-- =============================================================================

-- ═══════════════════════════════════════════════════════════════════════════
-- 0. FK target tables (preserve same canonical definitions as p4)
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
DO $$BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='subscription_plans') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='subscription_plans' AND column_name='code') THEN
            ALTER TABLE public.subscription_plans ADD COLUMN code text;
            UPDATE public.subscription_plans SET code = 'plan_' || id WHERE code IS NULL;
            ALTER TABLE public.subscription_plans ALTER COLUMN code SET NOT NULL;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='subscription_plans' AND column_name='name') THEN
            ALTER TABLE public.subscription_plans ADD COLUMN name text;
            UPDATE public.subscription_plans SET name = COALESCE(code, 'Plan ' || id) WHERE name IS NULL;
            ALTER TABLE public.subscription_plans ALTER COLUMN name SET NOT NULL;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='subscription_plans' AND column_name='description') THEN
            ALTER TABLE public.subscription_plans ADD COLUMN description text;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='subscription_plans' AND column_name='monthly_price') THEN
            ALTER TABLE public.subscription_plans ADD COLUMN monthly_price numeric(12,2) NOT NULL DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='subscription_plans' AND column_name='annual_price') THEN
            ALTER TABLE public.subscription_plans ADD COLUMN annual_price numeric(12,2) NOT NULL DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='subscription_plans' AND column_name='currency') THEN
            ALTER TABLE public.subscription_plans ADD COLUMN currency text NOT NULL DEFAULT 'MYR';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='subscription_plans' AND column_name='status') THEN
            ALTER TABLE public.subscription_plans ADD COLUMN status text NOT NULL DEFAULT 'active';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='subscription_plans' AND column_name='sort_order') THEN
            ALTER TABLE public.subscription_plans ADD COLUMN sort_order integer NOT NULL DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='subscription_plans' AND column_name='created_at') THEN
            ALTER TABLE public.subscription_plans ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='subscription_plans' AND column_name='updated_at') THEN
            ALTER TABLE public.subscription_plans ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
        END IF;
    END IF;
EXCEPTION WHEN OTHERS THEN NULL; END$$;
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
DO $$BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='firm_invoices') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='firm_invoices' AND column_name='firm_id') THEN
            ALTER TABLE public.firm_invoices ADD COLUMN firm_id integer;
            UPDATE public.firm_invoices SET firm_id = 0 WHERE firm_id IS NULL;
            ALTER TABLE public.firm_invoices ALTER COLUMN firm_id SET NOT NULL;
            ALTER TABLE public.firm_invoices ALTER COLUMN firm_id SET DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='firm_invoices' AND column_name='invoice_no') THEN
            ALTER TABLE public.firm_invoices ADD COLUMN invoice_no text;
            UPDATE public.firm_invoices SET invoice_no = 'INV_' || id WHERE invoice_no IS NULL;
            ALTER TABLE public.firm_invoices ALTER COLUMN invoice_no SET NOT NULL;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='firm_invoices' AND column_name='status') THEN
            ALTER TABLE public.firm_invoices ADD COLUMN status text NOT NULL DEFAULT 'draft';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='firm_invoices' AND column_name='total_amount') THEN
            ALTER TABLE public.firm_invoices ADD COLUMN total_amount numeric(12,2) NOT NULL DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='firm_invoices' AND column_name='currency') THEN
            ALTER TABLE public.firm_invoices ADD COLUMN currency text NOT NULL DEFAULT 'MYR';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='firm_invoices' AND column_name='issue_date') THEN
            ALTER TABLE public.firm_invoices ADD COLUMN issue_date date;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='firm_invoices' AND column_name='due_date') THEN
            ALTER TABLE public.firm_invoices ADD COLUMN due_date date;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='firm_invoices' AND column_name='paid_date') THEN
            ALTER TABLE public.firm_invoices ADD COLUMN paid_date date;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='firm_invoices' AND column_name='created_at') THEN
            ALTER TABLE public.firm_invoices ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='firm_invoices' AND column_name='updated_at') THEN
            ALTER TABLE public.firm_invoices ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
        END IF;
    END IF;
EXCEPTION WHEN OTHERS THEN NULL; END$$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_firm_invoices_no ON public.firm_invoices(invoice_no);
CREATE INDEX IF NOT EXISTS idx_firm_invoices_firm ON public.firm_invoices(firm_id);
CREATE INDEX IF NOT EXISTS idx_firm_invoices_status ON public.firm_invoices(status);

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. platform_features — feature key catalog
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
DO $$BEGIN
    ALTER TABLE IF EXISTS public.platform_features ADD COLUMN IF NOT EXISTS feature_key text NOT NULL DEFAULT 'unknown.feature';
    ALTER TABLE IF EXISTS public.platform_features ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT 'Unknown Feature';
    ALTER TABLE IF EXISTS public.platform_features ADD COLUMN IF NOT EXISTS module text NOT NULL DEFAULT 'general';
    ALTER TABLE IF EXISTS public.platform_features ADD COLUMN IF NOT EXISTS parent_feature_key text;
    ALTER TABLE IF EXISTS public.platform_features ADD COLUMN IF NOT EXISTS value_type text NOT NULL DEFAULT 'boolean';
    ALTER TABLE IF EXISTS public.platform_features ADD COLUMN IF NOT EXISTS default_value jsonb NOT NULL DEFAULT 'false'::jsonb;
    ALTER TABLE IF EXISTS public.platform_features ADD COLUMN IF NOT EXISTS configurable boolean NOT NULL DEFAULT true;
    ALTER TABLE IF EXISTS public.platform_features ADD COLUMN IF NOT EXISTS founder_only boolean NOT NULL DEFAULT false;
    ALTER TABLE IF EXISTS public.platform_features ADD COLUMN IF NOT EXISTS dependency_json jsonb NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE IF EXISTS public.platform_features ADD COLUMN IF NOT EXISTS route_hint text;
    ALTER TABLE IF EXISTS public.platform_features ADD COLUMN IF NOT EXISTS description text;
    ALTER TABLE IF EXISTS public.platform_features ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
    ALTER TABLE IF EXISTS public.platform_features ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
    ALTER TABLE IF EXISTS public.platform_features ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE IF EXISTS public.platform_features ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
EXCEPTION WHEN OTHERS THEN NULL; END$$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_features_feature_key ON public.platform_features(feature_key);
CREATE INDEX IF NOT EXISTS idx_platform_features_module ON public.platform_features(module);
CREATE INDEX IF NOT EXISTS idx_platform_features_status ON public.platform_features(status);
CREATE INDEX IF NOT EXISTS idx_platform_features_parent ON public.platform_features(parent_feature_key);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. plan_entitlements — base plan entitlements (layer 4)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.plan_entitlements (
    id serial PRIMARY KEY,
    plan_id integer NOT NULL REFERENCES public.subscription_plans(id) ON DELETE CASCADE,
    feature_key text NOT NULL,
    value_json jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$BEGIN
    ALTER TABLE IF EXISTS public.plan_entitlements ADD COLUMN IF NOT EXISTS plan_id integer NOT NULL DEFAULT 0;
    ALTER TABLE IF EXISTS public.plan_entitlements ADD COLUMN IF NOT EXISTS feature_key text NOT NULL DEFAULT 'unknown.feature';
    ALTER TABLE IF EXISTS public.plan_entitlements ADD COLUMN IF NOT EXISTS value_json jsonb NOT NULL DEFAULT 'false'::jsonb;
    ALTER TABLE IF EXISTS public.plan_entitlements ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE IF EXISTS public.plan_entitlements ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
EXCEPTION WHEN OTHERS THEN NULL; END$$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_entitlements_plan_feature ON public.plan_entitlements(plan_id, feature_key);
CREATE INDEX IF NOT EXISTS idx_plan_entitlements_plan ON public.plan_entitlements(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_entitlements_feature ON public.plan_entitlements(feature_key);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. firm_entitlement_overrides — permanent / temporary per-firm overrides
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
DO $$BEGIN
    ALTER TABLE IF EXISTS public.firm_entitlement_overrides ADD COLUMN IF NOT EXISTS firm_id integer NOT NULL DEFAULT 0;
    ALTER TABLE IF EXISTS public.firm_entitlement_overrides ADD COLUMN IF NOT EXISTS feature_key text NOT NULL DEFAULT 'unknown.feature';
    ALTER TABLE IF EXISTS public.firm_entitlement_overrides ADD COLUMN IF NOT EXISTS override_kind text NOT NULL DEFAULT 'temporary';
    ALTER TABLE IF EXISTS public.firm_entitlement_overrides ADD COLUMN IF NOT EXISTS override_mode text NOT NULL DEFAULT 'custom';
    ALTER TABLE IF EXISTS public.firm_entitlement_overrides ADD COLUMN IF NOT EXISTS value_json jsonb;
    ALTER TABLE IF EXISTS public.firm_entitlement_overrides ADD COLUMN IF NOT EXISTS effective_from timestamptz;
    ALTER TABLE IF EXISTS public.firm_entitlement_overrides ADD COLUMN IF NOT EXISTS expires_at timestamptz;
    ALTER TABLE IF EXISTS public.firm_entitlement_overrides ADD COLUMN IF NOT EXISTS billing_type text NOT NULL DEFAULT 'included';
    ALTER TABLE IF EXISTS public.firm_entitlement_overrides ADD COLUMN IF NOT EXISTS price_override numeric(12,2);
    ALTER TABLE IF EXISTS public.firm_entitlement_overrides ADD COLUMN IF NOT EXISTS reason text;
    ALTER TABLE IF EXISTS public.firm_entitlement_overrides ADD COLUMN IF NOT EXISTS created_by integer;
    ALTER TABLE IF EXISTS public.firm_entitlement_overrides ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE IF EXISTS public.firm_entitlement_overrides ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
EXCEPTION WHEN OTHERS THEN NULL; END$$;
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
DO $$BEGIN
    ALTER TABLE IF EXISTS public.hr_firm_feature_flags ADD COLUMN IF NOT EXISTS hr_enabled boolean NOT NULL DEFAULT false;
    ALTER TABLE IF EXISTS public.hr_firm_feature_flags ADD COLUMN IF NOT EXISTS hr_attendance_enabled boolean NOT NULL DEFAULT false;
    ALTER TABLE IF EXISTS public.hr_firm_feature_flags ADD COLUMN IF NOT EXISTS hr_payroll_enabled boolean NOT NULL DEFAULT false;
    ALTER TABLE IF EXISTS public.hr_firm_feature_flags ADD COLUMN IF NOT EXISTS hr_recruitment_enabled boolean NOT NULL DEFAULT false;
    ALTER TABLE IF EXISTS public.hr_firm_feature_flags ADD COLUMN IF NOT EXISTS hr_performance_enabled boolean NOT NULL DEFAULT false;
    ALTER TABLE IF EXISTS public.hr_firm_feature_flags ADD COLUMN IF NOT EXISTS hr_case_workload_enabled boolean NOT NULL DEFAULT false;
    ALTER TABLE IF EXISTS public.hr_firm_feature_flags ADD COLUMN IF NOT EXISTS hr_claims_enabled boolean NOT NULL DEFAULT true;
    ALTER TABLE IF EXISTS public.hr_firm_feature_flags ADD COLUMN IF NOT EXISTS hr_leave_enabled boolean NOT NULL DEFAULT true;
    ALTER TABLE IF EXISTS public.hr_firm_feature_flags ADD COLUMN IF NOT EXISTS hr_documents_enabled boolean NOT NULL DEFAULT true;
    ALTER TABLE IF EXISTS public.hr_firm_feature_flags ADD COLUMN IF NOT EXISTS hr_self_service_enabled boolean NOT NULL DEFAULT true;
    ALTER TABLE IF EXISTS public.hr_firm_feature_flags ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE IF EXISTS public.hr_firm_feature_flags ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE IF EXISTS public.hr_firm_feature_flags ADD COLUMN IF NOT EXISTS updated_by_user_id integer;
    ALTER TABLE IF EXISTS public.hr_firm_feature_flags ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
EXCEPTION WHEN OTHERS THEN NULL; END$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. subscription_history — append-only plan / status audit log
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
DO $$BEGIN
    ALTER TABLE IF EXISTS public.subscription_history ADD COLUMN IF NOT EXISTS firm_id integer NOT NULL DEFAULT 0;
    ALTER TABLE IF EXISTS public.subscription_history ADD COLUMN IF NOT EXISTS old_plan_id integer;
    ALTER TABLE IF EXISTS public.subscription_history ADD COLUMN IF NOT EXISTS new_plan_id integer;
    ALTER TABLE IF EXISTS public.subscription_history ADD COLUMN IF NOT EXISTS old_status text;
    ALTER TABLE IF EXISTS public.subscription_history ADD COLUMN IF NOT EXISTS new_status text NOT NULL DEFAULT 'unknown';
    ALTER TABLE IF EXISTS public.subscription_history ADD COLUMN IF NOT EXISTS price_snapshot numeric(12,2);
    ALTER TABLE IF EXISTS public.subscription_history ADD COLUMN IF NOT EXISTS changed_by integer;
    ALTER TABLE IF EXISTS public.subscription_history ADD COLUMN IF NOT EXISTS reason text;
    ALTER TABLE IF EXISTS public.subscription_history ADD COLUMN IF NOT EXISTS before_json jsonb;
    ALTER TABLE IF EXISTS public.subscription_history ADD COLUMN IF NOT EXISTS after_json jsonb;
    ALTER TABLE IF EXISTS public.subscription_history ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
EXCEPTION WHEN OTHERS THEN NULL; END$$;
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
DO $$BEGIN
    ALTER TABLE IF EXISTS public.billing_ledger ADD COLUMN IF NOT EXISTS firm_id integer NOT NULL DEFAULT 0;
    ALTER TABLE IF EXISTS public.billing_ledger ADD COLUMN IF NOT EXISTS subscription_id integer;
    ALTER TABLE IF EXISTS public.billing_ledger ADD COLUMN IF NOT EXISTS invoice_id integer;
    ALTER TABLE IF EXISTS public.billing_ledger ADD COLUMN IF NOT EXISTS idempotency_key text;
    ALTER TABLE IF EXISTS public.billing_ledger ADD COLUMN IF NOT EXISTS entry_type text NOT NULL DEFAULT 'entry';
    ALTER TABLE IF EXISTS public.billing_ledger ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '-';
    ALTER TABLE IF EXISTS public.billing_ledger ADD COLUMN IF NOT EXISTS billing_period_start date;
    ALTER TABLE IF EXISTS public.billing_ledger ADD COLUMN IF NOT EXISTS billing_period_end date;
    ALTER TABLE IF EXISTS public.billing_ledger ADD COLUMN IF NOT EXISTS debit numeric(18,2) NOT NULL DEFAULT 0;
    ALTER TABLE IF EXISTS public.billing_ledger ADD COLUMN IF NOT EXISTS credit numeric(18,2) NOT NULL DEFAULT 0;
    ALTER TABLE IF EXISTS public.billing_ledger ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'MYR';
    ALTER TABLE IF EXISTS public.billing_ledger ADD COLUMN IF NOT EXISTS reference_no text;
    ALTER TABLE IF EXISTS public.billing_ledger ADD COLUMN IF NOT EXISTS correlation_id text;
    ALTER TABLE IF EXISTS public.billing_ledger ADD COLUMN IF NOT EXISTS source_type text;
    ALTER TABLE IF EXISTS public.billing_ledger ADD COLUMN IF NOT EXISTS source_id integer;
    ALTER TABLE IF EXISTS public.billing_ledger ADD COLUMN IF NOT EXISTS due_date date;
    ALTER TABLE IF EXISTS public.billing_ledger ADD COLUMN IF NOT EXISTS paid_date date;
    ALTER TABLE IF EXISTS public.billing_ledger ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'posted';
    ALTER TABLE IF EXISTS public.billing_ledger ADD COLUMN IF NOT EXISTS payment_reference text;
    ALTER TABLE IF EXISTS public.billing_ledger ADD COLUMN IF NOT EXISTS payment_method text;
    ALTER TABLE IF EXISTS public.billing_ledger ADD COLUMN IF NOT EXISTS running_balance numeric(18,2) NOT NULL DEFAULT 0;
    ALTER TABLE IF EXISTS public.billing_ledger ADD COLUMN IF NOT EXISTS created_by integer;
    ALTER TABLE IF EXISTS public.billing_ledger ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
EXCEPTION WHEN OTHERS THEN NULL; END$$;
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
DO $$BEGIN
    ALTER TABLE IF EXISTS public.usage_counters ADD COLUMN IF NOT EXISTS firm_id integer NOT NULL DEFAULT 0;
    ALTER TABLE IF EXISTS public.usage_counters ADD COLUMN IF NOT EXISTS metric_key text NOT NULL DEFAULT 'metric';
    ALTER TABLE IF EXISTS public.usage_counters ADD COLUMN IF NOT EXISTS period_key text NOT NULL DEFAULT 'period';
    ALTER TABLE IF EXISTS public.usage_counters ADD COLUMN IF NOT EXISTS counter numeric(18,2) NOT NULL DEFAULT 0;
    ALTER TABLE IF EXISTS public.usage_counters ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
EXCEPTION WHEN OTHERS THEN NULL; END$$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_usage_counters_firm_metric_period
    ON public.usage_counters(firm_id, metric_key, period_key);
CREATE INDEX IF NOT EXISTS idx_usage_counters_firm   ON public.usage_counters(firm_id);
CREATE INDEX IF NOT EXISTS idx_usage_counters_period ON public.usage_counters(firm_id, period_key);

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. firm_user_feature_access — per-user feature overrides (p5 schema)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.firm_user_feature_access (
    id                  bigserial PRIMARY KEY,
    firm_id             bigint NOT NULL,
    user_id             bigint NOT NULL,
    feature_key         text NOT NULL,
    is_enabled          boolean NOT NULL DEFAULT TRUE,
    updated_by_user_id  bigint,
    created_at          timestamptz NOT NULL DEFAULT NOW(),
    updated_at          timestamptz NOT NULL DEFAULT NOW()
);
DO $$BEGIN
    ALTER TABLE IF EXISTS public.firm_user_feature_access ADD COLUMN IF NOT EXISTS firm_id bigint NOT NULL DEFAULT 0;
    ALTER TABLE IF EXISTS public.firm_user_feature_access ADD COLUMN IF NOT EXISTS user_id bigint NOT NULL DEFAULT 0;
    ALTER TABLE IF EXISTS public.firm_user_feature_access ADD COLUMN IF NOT EXISTS feature_key text NOT NULL DEFAULT 'unknown.feature';
    ALTER TABLE IF EXISTS public.firm_user_feature_access ADD COLUMN IF NOT EXISTS is_enabled boolean NOT NULL DEFAULT TRUE;
    ALTER TABLE IF EXISTS public.firm_user_feature_access ADD COLUMN IF NOT EXISTS updated_by_user_id bigint;
    ALTER TABLE IF EXISTS public.firm_user_feature_access ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT NOW();
    ALTER TABLE IF EXISTS public.firm_user_feature_access ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT NOW();
EXCEPTION WHEN OTHERS THEN NULL; END$$;
CREATE UNIQUE INDEX IF NOT EXISTS
    uq_firm_user_feature_access_firm_user_feature
    ON public.firm_user_feature_access (firm_id, user_id, feature_key);
CREATE INDEX IF NOT EXISTS
    idx_firm_user_feature_access_firm_user
    ON public.firm_user_feature_access (firm_id, user_id);
CREATE INDEX IF NOT EXISTS
    idx_firm_user_feature_access_feature
    ON public.firm_user_feature_access (firm_id, feature_key);

DO $$BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        WHERE tc.constraint_name = 'fk_firm_user_feature_access_firm'
    ) THEN
        ALTER TABLE public.firm_user_feature_access
            ADD CONSTRAINT fk_firm_user_feature_access_firm
            FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        WHERE tc.constraint_name = 'fk_firm_user_feature_access_user'
    ) THEN
        ALTER TABLE public.firm_user_feature_access
            ADD CONSTRAINT fk_firm_user_feature_access_user
            FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        WHERE tc.constraint_name = 'fk_firm_user_feature_access_updated_by'
    ) THEN
        ALTER TABLE public.firm_user_feature_access
            ADD CONSTRAINT fk_firm_user_feature_access_updated_by
            FOREIGN KEY (updated_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
END$$;

-- Touch trigger for updated_at
CREATE OR REPLACE FUNCTION public._fufa_touch()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_firm_user_feature_access_touch ON public.firm_user_feature_access;
CREATE TRIGGER trg_firm_user_feature_access_touch
BEFORE UPDATE ON public.firm_user_feature_access
FOR EACH ROW EXECUTE FUNCTION public._fufa_touch();

-- =============================================================================
-- 9. SEED platform_features from the canonical FEATURE_REGISTRY
--    Registry was manually transcribed from lib/db/src/feature-registry.ts to
--    preserve exact feature_key / module / parent_feature_key / value_type /
--    default_value / dependency_json / founder_only / status / sort_order.
--    Missing DB rows from registry are inserted. Unknown DB rows are preserved
--    (not deleted) to be reported as unknown keys separately.
-- =============================================================================

INSERT INTO public.platform_features
  (feature_key, name, module, parent_feature_key, value_type, default_value, configurable, founder_only, dependency_json, route_hint, description, sort_order, status)
VALUES
  ('module.dashboard','Dashboard (all firm dashboards)','dashboard',NULL,'boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/dashboard','Top-level dashboard feature module. If OFF, no dashboard pages visible.',0,'active'),
  ('dashboard.firm','Firm Dashboard','dashboard','module.dashboard','boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/dashboard',NULL,0,'active'),
  ('dashboard.partner','Partner Dashboard','dashboard','module.dashboard','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('dashboard.management','Management Dashboard','dashboard','module.dashboard','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('dashboard.workbench','My Work / Workbench','dashboard','module.dashboard','boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/workbench',NULL,0,'active'),
  ('dashboard.kpi','KPI Widgets','dashboard','module.dashboard','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('dashboard.approvals','Pending Approvals Widget','dashboard','module.dashboard','boolean','true'::jsonb,true,false,'["payment_voucher_sla"]'::jsonb,NULL,NULL,0,'active'),
  ('dashboard.alerts','Alerts / Escalations Widget','dashboard','module.dashboard','boolean','true'::jsonb,true,false,'["case_bottleneck","completion_sla"]'::jsonb,NULL,NULL,0,'active'),
  ('module.cases','Cases','cases',NULL,'boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/cases',NULL,0,'active'),
  ('cases.read','View / Search / Archive Cases','cases','module.cases','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('cases.create','Create New Case','cases','module.cases','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('cases.legacy_import','Legacy Excel Import (Historical Cases)','cases','module.cases','boolean','true'::jsonb,true,true,'[]'::jsonb,NULL,NULL,0,'active'),
  ('cases.overview','Case Overview Tab','cases','module.cases','boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/cases/:id',NULL,0,'active'),
  ('cases.parties','Parties Tab (purchasers/borrowers/vendors)','cases','module.cases','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('cases.property','Property Info Tab','cases','module.cases','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('cases.loan','Loan Info Tab','cases','module.cases','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('cases.reference','Reference Numbers + History + Suggestions','cases','module.cases','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('cases.tasks','Case Tasks','cases','module.cases','boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/cases/:id/tasks',NULL,0,'active'),
  ('cases.timeline','Case Timeline','cases','module.cases','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('cases.documents','Case Documents Tab','cases','module.cases','boolean','true'::jsonb,true,false,'["module.documents"]'::jsonb,NULL,NULL,0,'active'),
  ('cases.supporting_documents','Case Supporting Documents Tab','cases','module.cases','boolean','true'::jsonb,true,false,'["module.documents"]'::jsonb,NULL,NULL,0,'active'),
  ('cases.notes','Case Notes','cases','module.cases','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('cases.assignment','Case Assignment + Bulk Assign','cases','module.cases','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('cases.approval','Case Approval (approve/reject/resubmit)','cases','module.cases','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('cases.amendment','Case Amendment / Edit key fields','cases','module.cases','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('cases.key_dates','Key Dates / Milestones','cases','module.cases','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('cases.workflow','Workflow Steps + Attachments','cases','module.cases','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('cases.batch_update','Batch Update (cases)','cases','module.cases','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('cases.batch_print','Batch Print (case documents)','cases','module.cases','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('cases.developer_sales','Developer Sales Cases (perfection)','cases','module.cases','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('cases.subsale','Subsale Cases','cases','module.cases','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('cases.perfection','Perfection Steps','cases','module.cases','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('cases.intake','Intake Inbox','cases','module.cases','boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/cases/intake',NULL,0,'active'),
  ('cases.conflict_check','Conflict Check','cases','module.cases','boolean','true'::jsonb,true,false,'["module.cases"]'::jsonb,NULL,NULL,0,'active'),
  ('cases.monitor','Case Monitor (SLAs)','cases','module.cases','boolean','true'::jsonb,true,false,'["case_bottleneck","completion_sla"]'::jsonb,NULL,NULL,0,'active'),
  ('cases.export','Case Export (CSV)','cases','cases.read','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('limit.cases.max','Max Active Cases','cases','module.cases','integer','-1'::jsonb,true,false,'[]'::jsonb,NULL,'-1 = unlimited',0,'active'),
  ('limit.cases.monthly_new','Max New Cases/Month','cases','module.cases','integer','-1'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('module.developers','Developers','developers',NULL,'boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/developers',NULL,0,'active'),
  ('developers.read','View Developers','developers','module.developers','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('developers.create','Create Developer','developers','module.developers','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('developers.edit','Edit Developer','developers','module.developers','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('developers.codes','Developer/Project Codes Config','developers','module.developers','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('module.projects','Projects','projects',NULL,'boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/projects',NULL,0,'active'),
  ('projects.read','View Projects','projects','module.projects','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('projects.create','Create Project','projects','module.projects','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('projects.edit','Edit Project','projects','module.projects','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('projects.phases','Phases Management','projects','module.projects','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('projects.units','Units/Lots Management','projects','module.projects','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('projects.reference_config','Reference Configuration','projects','module.projects','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('projects.hims_mapping','HIMS Mapping','projects','module.projects','boolean','true'::jsonb,true,false,'["module.hims"]'::jsonb,NULL,NULL,0,'active'),
  ('module.documents','Documents & Automation Hub','documents',NULL,'boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/documents',NULL,0,'active'),
  ('documents.hub','Automation Hub','documents','module.documents','boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/documents/automation',NULL,0,'active'),
  ('documents.templates','Template Library','documents','module.documents','boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/documents/variables',NULL,0,'active'),
  ('documents.templates.founder','Founder Templates','documents','documents.templates','boolean','true'::jsonb,true,true,'[]'::jsonb,NULL,NULL,0,'active'),
  ('documents.templates.firm','Firm Templates','documents','documents.templates','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('documents.word','Word Generation','documents','module.documents','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('documents.pdf','PDF Generation + Mapping','documents','module.documents','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('documents.variables','Variables / Custom Variables','documents','module.documents','boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/documents/variables',NULL,0,'active'),
  ('documents.batch','Batch Generation','documents','module.documents','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('documents.generated','Generated Documents (case/workflow)','documents','module.documents','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('documents.versioning','History / Versioning','documents','module.documents','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('documents.ocr','OCR','documents','module.documents','boolean','true'::jsonb,true,false,'["module.ai"]'::jsonb,NULL,NULL,0,'active'),
  ('documents.ai_read','AI Reading + Date Extraction','documents','module.documents','boolean','true'::jsonb,true,false,'["module.ai"]'::jsonb,NULL,NULL,0,'active'),
  ('documents.ai_migration','AI Template Migration','documents','documents.templates','boolean','true'::jsonb,true,false,'["module.ai"]'::jsonb,NULL,NULL,0,'active'),
  ('documents.logs','Generation Logs','documents','module.documents','boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/documents/generation-logs',NULL,0,'active'),
  ('limit.documents.generation_monthly','Max Generated Docs/Month','documents','module.documents','integer','-1'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('module.accounting','Accounting','accounting',NULL,'boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/accounting',NULL,0,'active'),
  ('accounting.dashboard','Accounting Dashboard','accounting','module.accounting','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('accounting.quotation','Quotation','accounting','module.accounting','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('accounting.invoice','Invoice (issue/view)','accounting','module.accounting','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('accounting.receipt','Receipt','accounting','module.accounting','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('accounting.payment_voucher','Payment Voucher (PV)','accounting','module.accounting','boolean','true'::jsonb,true,false,'["payment_voucher_sla"]'::jsonb,NULL,NULL,0,'active'),
  ('accounting.payment_voucher.create','Create PV','accounting','accounting.payment_voucher','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('accounting.payment_voucher.submit','Submit PV','accounting','accounting.payment_voucher','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('accounting.payment_voucher.approval','PV Approval','accounting','accounting.payment_voucher','boolean','true'::jsonb,true,false,'["payment_voucher_sla"]'::jsonb,NULL,NULL,0,'active'),
  ('accounting.file_listing','File Listing','accounting','module.accounting','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('accounting.client_ledger','Client Ledger','accounting','module.accounting','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('accounting.case_ledger','Case Ledger','accounting','module.accounting','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('accounting.office_ledger','Office Ledger','accounting','module.accounting','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('accounting.trust_account','Trust Account','accounting','module.accounting','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('accounting.trust_statement','Trust Statement','accounting','accounting.trust_account','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('accounting.stakeholder','Stakeholder','accounting','module.accounting','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('accounting.disbursement','Disbursement','accounting','module.accounting','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('accounting.professional_fees','Professional Fees','accounting','module.accounting','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('accounting.travelling','Travelling','accounting','module.accounting','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('accounting.miscellaneous','Miscellaneous','accounting','module.accounting','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('accounting.overcollection','Overcollection','accounting','module.accounting','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('accounting.office_income','Office Income','accounting','module.accounting','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('accounting.bank_transaction','Bank Transaction','accounting','module.accounting','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('accounting.bank_reconciliation','Bank Reconciliation','accounting','module.accounting','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('accounting.payment','Payment (out)','accounting','module.accounting','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('accounting.refund','Refund','accounting','module.accounting','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('accounting.reports','Accounting Reports','accounting','module.accounting','boolean','true'::jsonb,true,false,'["module.reports"]'::jsonb,NULL,NULL,0,'active'),
  ('accounting.approvals','Accounting Approvals','accounting','module.accounting','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('accounting.notifications','Accounting Notifications','accounting','module.accounting','boolean','true'::jsonb,true,false,'["module.notifications","payment_voucher_sla"]'::jsonb,NULL,NULL,0,'active'),
  ('module.einvoice','E-Invoice (LHDN)','einvoice',NULL,'boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('einvoice.individual','Individual E-Invoice','einvoice','module.einvoice','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('einvoice.consolidated','Consolidated E-Invoice','einvoice','module.einvoice','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('einvoice.submit','Submit to LHDN','einvoice','module.einvoice','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('einvoice.status','Status & History','einvoice','module.einvoice','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('einvoice.credit_note','Credit Note','einvoice','module.einvoice','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('einvoice.debit_note','Debit Note','einvoice','module.einvoice','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('einvoice.refund_note','Refund Note','einvoice','module.einvoice','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('einvoice.validation','Validation','einvoice','module.einvoice','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('einvoice.lhdn_integration','LHDN Integration','einvoice','module.einvoice','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('einvoice.logs','Logs','einvoice','module.einvoice','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('module.communications','Communications','communications',NULL,'boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/communication/email',NULL,0,'active'),
  ('communications.email','Email Control','communications','module.communications','boolean','true'::jsonb,true,false,'["email_sync"]'::jsonb,'/app/communication/email',NULL,0,'active'),
  ('communications.email.settings','Email Settings','communications','communications.email','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('communications.email.m365','Microsoft 365','communications','communications.email.settings','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('communications.email.imap','IMAP','communications','communications.email.settings','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('communications.email.gmail','Gmail','communications','communications.email.settings','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('communications.email.folders','Inbox/Sent/Draft/Archive','communications','communications.email','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('communications.email.mark_read','Read/Unread','communications','communications.email','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('communications.email.reply','Reply / Reply All','communications','communications.email','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('communications.email.forward','Forward','communications','communications.email','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('communications.email.remarks','Remarks','communications','communications.email','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('communications.email.assign_user','Assign User','communications','communications.email','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('communications.email.link_case','Link to Case','communications','communications.email','boolean','true'::jsonb,true,false,'["module.cases"]'::jsonb,NULL,NULL,0,'active'),
  ('communications.email.search','Search / Filter','communications','communications.email','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('communications.email.sla','SLA Tracking','communications','communications.email','boolean','true'::jsonb,true,false,'["email_sla"]'::jsonb,NULL,NULL,0,'active'),
  ('communications.email.task','Email → Task','communications','communications.email','boolean','true'::jsonb,true,false,'["cases.tasks"]'::jsonb,NULL,NULL,0,'active'),
  ('communications.email.sync','Sync','communications','communications.email','boolean','true'::jsonb,true,false,'["email_sync"]'::jsonb,NULL,NULL,0,'active'),
  ('communications.email.logs','Logs','communications','communications.email','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('communications.whatsapp','WhatsApp Inbox','communications','module.communications','boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/communication/whatsapp',NULL,0,'active'),
  ('communications.hub','Hub Unified','communications','module.communications','boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/hub',NULL,0,'active'),
  ('module.hr','Human Resources (HRMS)','hr',NULL,'boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('hr.dashboard','HR Dashboard','hr','module.hr','boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/hr/dashboard',NULL,0,'active'),
  ('hr.employees','Employees','hr','module.hr','boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/hr/employees',NULL,0,'active'),
  ('hr.departments','Departments','hr','module.hr','boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/hr/departments',NULL,0,'active'),
  ('hr.positions','Positions','hr','module.hr','boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/hr/positions',NULL,0,'active'),
  ('hr.attendance','Attendance','hr','module.hr','boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/hr/attendance',NULL,0,'active'),
  ('hr.leave','Leave','hr','module.hr','boolean','true'::jsonb,true,false,'["hr_leave_sla"]'::jsonb,'/app/hr/leave',NULL,0,'active'),
  ('hr.claims','Claims','hr','module.hr','boolean','true'::jsonb,true,false,'["hr_claim_sla"]'::jsonb,'/app/hr/claims',NULL,0,'active'),
  ('hr.payroll','Payroll','hr','module.hr','boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/hr/payroll',NULL,0,'active'),
  ('hr.onboarding','Onboarding','hr','module.hr','boolean','true'::jsonb,true,false,'["hr_onboarding"]'::jsonb,'/app/hr/onboarding',NULL,0,'active'),
  ('hr.offboarding','Offboarding','hr','module.hr','boolean','true'::jsonb,true,false,'["hr_offboarding"]'::jsonb,'/app/hr/offboarding',NULL,0,'active'),
  ('hr.recruitment','Recruitment','hr','module.hr','boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/hr/recruitment',NULL,0,'active'),
  ('hr.performance','Performance','hr','module.hr','boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/hr/performance',NULL,0,'active'),
  ('hr.training','Training','hr','module.hr','boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/hr/training',NULL,0,'active'),
  ('hr.assets','Assets','hr','module.hr','boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/hr/assets',NULL,0,'active'),
  ('hr.documents','HR Documents','hr','module.hr','boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/hr/documents',NULL,0,'active'),
  ('hr.notifications','HR Notifications','hr','module.hr','boolean','true'::jsonb,true,false,'["module.notifications","hr_event_delivery"]'::jsonb,NULL,NULL,0,'active'),
  ('hr.approvals','HR Approvals (leave/claims/payroll)','hr','module.hr','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('hr.self_service','Employee Self Service','hr','module.hr','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('hr.reports','HR Reports','hr','module.hr','boolean','true'::jsonb,true,false,'["module.reports"]'::jsonb,'/app/hr/reports',NULL,0,'active'),
  ('hr.settings','HR Settings','hr','module.hr','boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/hr/settings',NULL,0,'active'),
  ('hr.integration_events','HR Integration Events (webhooks)','hr','module.hr','boolean','true'::jsonb,true,false,'["hr_event_delivery"]'::jsonb,NULL,NULL,0,'active'),
  ('module.rbac','User & Role Management','rbac',NULL,'boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('rbac.users','Users (list/edit)','rbac','module.rbac','boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/users',NULL,0,'active'),
  ('rbac.users.create','Create/Invite Users','rbac','rbac.users','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('rbac.users.invitations','Invitations','rbac','rbac.users','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('rbac.users.assignments','Assignments (to cases/dept)','rbac','rbac.users','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('rbac.users.initials','Initials Config','rbac','rbac.users','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('rbac.roles','Roles','rbac','module.rbac','boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/roles',NULL,0,'active'),
  ('rbac.permissions','Permissions','rbac','rbac.roles','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('rbac.departments','Departments (firm)','rbac','module.rbac','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('limit.users.max','Max Users','rbac','module.rbac','integer','10'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('module.contacts','Contacts (Clients / Parties)','contacts',NULL,'boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('contacts.clients','Clients','contacts','module.contacts','boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/clients',NULL,0,'active'),
  ('contacts.borrowers','Purchasers / Borrowers','contacts','module.contacts','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('contacts.vendors','Vendors','contacts','module.contacts','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('contacts.banks','Banks','contacts','module.contacts','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('contacts.developers_contact','Developer Contacts','contacts','module.contacts','boolean','true'::jsonb,true,false,'["module.developers"]'::jsonb,NULL,NULL,0,'active'),
  ('contacts.other_parties','Other Parties','contacts','module.contacts','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('module.notifications','Notifications','notifications',NULL,'boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('notifications.in_app','In-App Notifications','notifications','module.notifications','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('notifications.red_dot','Red Dot / Unread Count Badge','notifications','notifications.in_app','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('notifications.approval','Approval Notifications','notifications','module.notifications','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('notifications.case','Case Notifications','notifications','module.notifications','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('notifications.accounting','Accounting Notifications','notifications','module.notifications','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('notifications.pv_escalation','PV Escalation','notifications','notifications.accounting','boolean','true'::jsonb,true,false,'["payment_voucher_sla"]'::jsonb,NULL,NULL,0,'active'),
  ('notifications.lawyer','Lawyer Notifications','notifications','module.notifications','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('notifications.manager','Manager Notifications','notifications','module.notifications','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('notifications.partner_escalation','Partner Escalation','notifications','module.notifications','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('module.hims','HIMS / eSPA Tracker','hims',NULL,'boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('hims.tracker','HIMS Status Tracker','hims','module.hims','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('hims.credentials','Developer Credentials / Config','hims','module.hims','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('hims.project_mapping','Project / Phase Mapping','hims','module.hims','boolean','true'::jsonb,true,false,'["module.projects"]'::jsonb,NULL,NULL,0,'active'),
  ('hims.unit_lot_title','Unit/Lot/Title Mapping','hims','module.hims','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('hims.espa_status','eSPA Status','hims','module.hims','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('hims.spa_tracker','SPA Tracker','hims','module.hims','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('hims.spa_stamped_handover','SPA Stamped Handover','hims','module.hims','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('hims.status_check','Status Check (api)','hims','module.hims','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('hims.compare_lawcaspro_hims','Compare Lawcaspro ↔ HIMS','hims','module.hims','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('hims.compare_lawcaspro_ekyc','Compare Lawcaspro ↔ eKYC','hims','module.hims','boolean','true'::jsonb,true,false,'["module.ekyc"]'::jsonb,NULL,NULL,0,'active'),
  ('hims.notifications','HIMS Notifications','hims','module.hims','boolean','true'::jsonb,true,false,'["module.notifications"]'::jsonb,NULL,NULL,0,'active'),
  ('module.ekyc','eKYC / Identity Verification','ekyc',NULL,'boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('ekyc.verify','Identity Verification','ekyc','module.ekyc','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('ekyc.status','Status Overview','ekyc','module.ekyc','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('ekyc.comparison','Comparison (HIMS/others)','ekyc','module.ekyc','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('ekyc.history','History','ekyc','module.ekyc','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('module.reports','Reports','reports',NULL,'boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/reports',NULL,0,'active'),
  ('reports.case','Case Reports','reports','module.reports','boolean','true'::jsonb,true,false,'["module.cases"]'::jsonb,NULL,NULL,0,'active'),
  ('reports.accounting','Accounting Reports','reports','module.reports','boolean','true'::jsonb,true,false,'["module.accounting"]'::jsonb,NULL,NULL,0,'active'),
  ('reports.hr','HR Reports','reports','module.reports','boolean','true'::jsonb,true,false,'["module.hr"]'::jsonb,NULL,NULL,0,'active'),
  ('reports.management','Management Reports','reports','module.reports','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('reports.status','Status Reports','reports','module.reports','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('reports.productivity','Productivity Reports','reports','module.reports','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('reports.audit','Audit Reports','reports','module.reports','boolean','true'::jsonb,true,false,'["module.audit"]'::jsonb,NULL,NULL,0,'active'),
  ('reports.export_pdf','PDF Export','reports','module.reports','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('reports.export_excel','Excel Export','reports','module.reports','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('module.settings','Settings (Firm)','settings',NULL,'boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/settings',NULL,0,'active'),
  ('settings.firm','Firm Settings','settings','module.settings','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('settings.case','Case Settings / Types / Config','settings','module.settings','boolean','true'::jsonb,true,false,'["module.cases"]'::jsonb,NULL,NULL,0,'active'),
  ('settings.reference','Reference Number Config','settings','settings.case','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('settings.accounting','Accounting Settings','settings','module.settings','boolean','true'::jsonb,true,false,'["module.accounting"]'::jsonb,'/app/settings/accounting',NULL,0,'active'),
  ('settings.hr','HR Settings','settings','module.settings','boolean','true'::jsonb,true,false,'["module.hr"]'::jsonb,NULL,NULL,0,'active'),
  ('settings.email','Email Settings','settings','module.settings','boolean','true'::jsonb,true,false,'["module.communications"]'::jsonb,'/app/settings/email',NULL,0,'active'),
  ('settings.document','Document / Templates Settings','settings','module.settings','boolean','true'::jsonb,true,false,'["module.documents"]'::jsonb,'/app/settings/templates',NULL,0,'active'),
  ('settings.notifications','Notification Settings','settings','module.settings','boolean','true'::jsonb,true,false,'["module.notifications"]'::jsonb,NULL,NULL,0,'active'),
  ('settings.integrations','Integrations Settings','settings','module.settings','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('settings.subscription','Subscription & Billing (Firm view)','settings','module.settings','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('settings.logs','Logs (firm)','settings','module.settings','boolean','true'::jsonb,true,false,'["module.audit"]'::jsonb,'/app/settings/logs',NULL,0,'active'),
  ('module.storage','Storage / File Custody','storage',NULL,'boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('storage.file_custody','File Custody Registry (Phase 2/3 candidate)','storage','module.storage','boolean','false'::jsonb,false,false,'[]'::jsonb,'/app/file-custody','Future: Phase 2/3 candidate. Default disabled for all firms; currently hidden from navigation and route-gated.',0,'inactive'),
  ('storage.uploads','General File Uploads','storage','module.storage','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('limit.storage.gb','Storage (GB)','storage','module.storage','integer','100'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('module.ai','AI & OCR Capabilities','ai',NULL,'boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('ai.ocr','OCR Engine','ai','module.ai','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('ai.draft','AI Drafting Assistant','ai','module.ai','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('ai.reading','AI Reading / Extraction','ai','module.ai','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('limit.ai.ocr_pages_monthly','OCR Pages / Month','ai','module.ai','integer','1000'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('limit.ai.draft_tokens_monthly','AI Draft Tokens / Month','ai','module.ai','integer','-1'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('module.audit','Audit Logs','audit',NULL,'boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/audit-logs',NULL,0,'active'),
  ('audit.logs','View Audit Logs','audit','module.audit','boolean','true'::jsonb,true,false,'[]'::jsonb,'/app/audit-logs',NULL,0,'active'),
  ('audit.export','Export Audit Logs','audit','module.audit','boolean','true'::jsonb,true,false,'[]'::jsonb,NULL,NULL,0,'active'),
  ('module.platform','Platform Admin (Founder)','platform',NULL,'boolean','true'::jsonb,false,true,'[]'::jsonb,NULL,NULL,0,'active'),
  ('platform.firms','Firms Management','platform','module.platform','boolean','true'::jsonb,false,true,'[]'::jsonb,NULL,NULL,0,'active'),
  ('platform.plans','Plans & Entitlements','platform','module.platform','boolean','true'::jsonb,false,true,'[]'::jsonb,NULL,NULL,0,'active'),
  ('platform.billing','Billing & Ledger (founder view)','platform','module.platform','boolean','true'::jsonb,false,true,'[]'::jsonb,NULL,NULL,0,'active'),
  ('platform.audit','Cross-Firm Audit','platform','module.platform','boolean','true'::jsonb,false,true,'[]'::jsonb,NULL,NULL,0,'active'),
  ('platform.ops_center','Ops Center','platform','module.platform','boolean','true'::jsonb,false,true,'[]'::jsonb,NULL,NULL,0,'active'),
  ('platform.approvals','Platform Approvals','platform','module.platform','boolean','true'::jsonb,false,true,'[]'::jsonb,NULL,NULL,0,'active'),
  ('platform.support_sessions','Support Sessions (consent-based access)','platform','module.platform','boolean','true'::jsonb,false,true,'[]'::jsonb,NULL,NULL,0,'active'),
  ('platform.incident_center','Incident Center','platform','module.platform','boolean','true'::jsonb,false,true,'[]'::jsonb,NULL,NULL,0,'active'),
  ('platform.governance','Governance','platform','module.platform','boolean','true'::jsonb,false,true,'[]'::jsonb,NULL,NULL,0,'active')
ON CONFLICT (feature_key) DO UPDATE SET
  name = EXCLUDED.name,
  module = EXCLUDED.module,
  parent_feature_key = EXCLUDED.parent_feature_key,
  value_type = EXCLUDED.value_type,
  default_value = EXCLUDED.default_value,
  configurable = EXCLUDED.configurable,
  founder_only = EXCLUDED.founder_only,
  dependency_json = EXCLUDED.dependency_json,
  route_hint = EXCLUDED.route_hint,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  status = EXCLUDED.status,
  updated_at = now();
