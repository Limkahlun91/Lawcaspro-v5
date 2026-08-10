-- LAWCASEPRO V5 PLATFORM ADMIN <-> FIRM CONTROL
-- PART 1: Entitlements, Billing Ledger, Usage Counters, Subscription History
-- Additive migration - idempotent where possible
-- ======================================================================

BEGIN;

-- ----------------------------------------------------------------------
-- 1. EXTEND EXISTING subscription_status ENUM-LIKE CHECK
--    Current: only 'active' default; no CHECK constraint enforced in firms table
--    We add a CHECK to cover the full policy model (trial/active/past_due/suspended/cancelled/expired)
-- ----------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'firms_subscription_status_check'
      AND conrelid = 'firms'::regclass
  ) THEN
    ALTER TABLE firms
      ADD CONSTRAINT firms_subscription_status_check
      CHECK (subscription_status IN ('trial','active','past_due','suspended','cancelled','expired'));
  END IF;
END $$;

-- Ensure column exists with the full set of supported defaults
ALTER TABLE firms ALTER COLUMN subscription_status SET DEFAULT 'active';

-- Also extend firm_invoices.status - current check is only (unpaid,paid,overdue)
-- We add: voided, credited, pending
DO $$
BEGIN
  -- We need to drop and re-add if exists because values are not appendable to CHECK
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'firm_invoices_status_check'
      AND conrelid = 'firm_invoices'::regclass
  ) THEN
    ALTER TABLE firm_invoices DROP CONSTRAINT firm_invoices_status_check;
  END IF;
END $$;

ALTER TABLE firm_invoices
  ADD CONSTRAINT firm_invoices_status_check
  CHECK (status IN ('unpaid','paid','overdue','voided','credited','pending'));

-- ----------------------------------------------------------------------
-- 2. platform_features — catalog of all feature/entitlement keys
-- ----------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS platform_features (
  id               serial PRIMARY KEY,
  feature_key      text NOT NULL,
  name             text NOT NULL,
  module           text NOT NULL DEFAULT 'general',
  parent_feature_key text,
  value_type       text NOT NULL DEFAULT 'boolean'
                   CHECK (value_type IN ('boolean','integer','decimal','string','config','unlimited')),
  default_value    jsonb NOT NULL DEFAULT 'false'::jsonb,
  configurable     boolean NOT NULL DEFAULT true,
  founder_only     boolean NOT NULL DEFAULT false,
  dependency_json  jsonb NOT NULL DEFAULT '[]'::jsonb,
  route_hint       text,
  status           text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','inactive','deprecated','emergency_disabled')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_features_feature_key
  ON platform_features (feature_key);

CREATE INDEX IF NOT EXISTS idx_platform_features_module
  ON platform_features (module);

CREATE INDEX IF NOT EXISTS idx_platform_features_status
  ON platform_features (status);

CREATE INDEX IF NOT EXISTS idx_platform_features_parent
  ON platform_features (parent_feature_key);

-- ----------------------------------------------------------------------
-- 3. plan_entitlements — base plan-level feature values
--    BASE PLAN ENTITLEMENT (layer 4 of resolver)
-- ----------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS plan_entitlements (
  id            serial PRIMARY KEY,
  plan_id       integer NOT NULL REFERENCES subscription_plans(id) ON DELETE CASCADE,
  feature_key   text NOT NULL,
  value_json    jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_entitlements_plan_feature
  ON plan_entitlements (plan_id, feature_key);

CREATE INDEX IF NOT EXISTS idx_plan_entitlements_plan
  ON plan_entitlements (plan_id);

CREATE INDEX IF NOT EXISTS idx_plan_entitlements_feature
  ON plan_entitlements (feature_key);

-- ----------------------------------------------------------------------
-- 4. firm_entitlement_overrides — per-firm permanent/temporary overrides
--    Layers 5 (permanent) + 6 (active temporary = higher) of resolver
--    — DETERMINISTIC DESIGN.
--
-- REDESIGN REASON (0148 before production):
--   The previous partial unique index WHERE (expires_at IS NULL OR expires_at > now())
--   embedded CURRENT TIME inside uniqueness membership, making it non-deterministic
--   and unsafe. It also collapsed two semantically distinct override kinds
--   (permanent vs scheduled-temporary) into one ambiguous column combination.
--
-- NEW DETERMINISTIC MODEL + CORRECT PRECEDENCE:
--   override_kind = 'permanent'
--     → At most ONE row per (firm_id, feature_key).
--       enforced by: uq_firm_entitlement_permanent (partial unique index)
--     → effective_from/expires_at must be NULL (permanent has no range).
--     → Resolver layer 5. Falls through to temporary only when NO permanent
--       exists (permanent is the base configuration).
--   override_kind = 'temporary'
--     → Explicit effective_from / expires_at range.
--     → NO OVERLAPPING ranges per (firm_id, feature_key).
--       enforced by: ex_firm_entitlement_temp_no_overlap (GiST exclusion).
--     → Resolver layer 6 (active only when now() falls within [effective_from, expires_at)
--       — this is a *runtime filter* during resolution, NOT part of uniqueness).
--       ACTIVE TEMPORARY always SUPERSEDES permanent override during its window.
--   Historical expired rows are preserved forever (APPEND-only audit trail).
-- ----------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS firm_entitlement_overrides (
  id              serial PRIMARY KEY,
  firm_id         integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  feature_key     text NOT NULL,
  override_kind   text NOT NULL DEFAULT 'temporary'
                  CHECK (override_kind IN ('permanent','temporary')),
  override_mode   text NOT NULL DEFAULT 'custom'
                  CHECK (override_mode IN ('plan_default','enabled','disabled','custom')),
  value_json      jsonb,
  effective_from  timestamptz,
  expires_at      timestamptz,
  billing_type    text NOT NULL DEFAULT 'included'
                  CHECK (billing_type IN ('included','paid_addon','complimentary','trial')),
  price_override  numeric(12,2),
  reason          text,
  created_by      integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Validation: permanent overrides have no effective/expiry ranges.
-- (PostgreSQL has no IMPLIES operator; explicit boolean rewrite:
--  P IMPLIES Q ≡ ¬P ∨ Q).
DO $$ BEGIN
  ALTER TABLE firm_entitlement_overrides
    ADD CONSTRAINT firm_entitlement_overrides_permanent_no_range
    CHECK (
      override_kind <> 'permanent'
      OR (effective_from IS NULL AND expires_at IS NULL)
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;          -- idempotent: already exists
END $$;

-- Validation: temporary overrides must have at least an effective_from.
-- (expires_at may be null for "until further notice", but if present
--  it must be strictly after effective_from.)
DO $$ BEGIN
  ALTER TABLE firm_entitlement_overrides
    ADD CONSTRAINT firm_entitlement_overrides_temporary_effective
    CHECK (
      override_kind <> 'temporary'
      OR effective_from IS NOT NULL
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;          -- idempotent: already exists
END $$;

-- Validation: when a temporary override provides expires_at, it must be
-- strictly after effective_from (prevents zero-duration/inverted ranges
-- from being stored even when btree_gist EXCLUSION fallback-only active).
DO $$ BEGIN
  ALTER TABLE firm_entitlement_overrides
    ADD CONSTRAINT firm_entitlement_overrides_temporary_range_order
    CHECK (
      override_kind <> 'temporary'
      OR expires_at IS NULL
      OR expires_at > effective_from
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;          -- idempotent: already exists
END $$;

-- UNIQUENESS 1 — Permanent: max 1 row per (firm, feature).
-- 100% deterministic — no time-dependent membership.
CREATE UNIQUE INDEX IF NOT EXISTS uq_firm_entitlement_permanent
  ON firm_entitlement_overrides (firm_id, feature_key)
  WHERE (override_kind = 'permanent');

-- UNIQUENESS 2 — Temporary: NO OVERLAPPING date ranges per (firm, feature).
-- Authoritative concurrency-safety guarantee (G8): btree_gist extension +
-- GiST EXCLUSION constraint.  This is the STRONG guarantee.  The trigger
-- below remains only as defense-in-depth and MUST NOT be the sole guarantee.
--
-- If btree_gist is unavailable this migration FAILS LOUDLY — a weak fallback
-- (e.g. trigger-only) is explicitly unacceptable because it cannot prevent
-- overlapping rows written inside simultaneous transactions.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE firm_entitlement_overrides
  ADD CONSTRAINT ex_firm_entitlement_temp_no_overlap
  EXCLUDE USING gist (
    firm_id         WITH =,
    feature_key     WITH =,
    tstzrange(
      COALESCE(effective_from, '-infinity'::timestamptz),
      COALESCE(expires_at,     'infinity'::timestamptz),
      '[)'
    ) WITH &&
  )
  WHERE (override_kind = 'temporary');

-- FALLBACK guard for temporary range overlap if GiST exclusion could not be added.
-- This is ALWAYS present as a belt-and-suspenders check even when GiST is used.
CREATE OR REPLACE FUNCTION firm_entitlement_temp_overlap_guard()
RETURNS trigger AS $ovl$
DECLARE
  _conflict integer;
BEGIN
  IF NEW.override_kind IS DISTINCT FROM 'temporary' THEN RETURN NEW; END IF;

  SELECT 1
  INTO STRICT _conflict
  FROM firm_entitlement_overrides o
  WHERE o.id              <> COALESCE(NEW.id, -1)
    AND o.firm_id         = NEW.firm_id
    AND o.feature_key     = NEW.feature_key
    AND o.override_kind   = 'temporary'
    AND tstzrange(
          COALESCE(o.effective_from, '-infinity'::timestamptz),
          COALESCE(o.expires_at,     'infinity'::timestamptz),
          '[)'
        ) &&
        tstzrange(
          COALESCE(NEW.effective_from, '-infinity'::timestamptz),
          COALESCE(NEW.expires_at,     'infinity'::timestamptz),
          '[)'
        )
  LIMIT 1;

  RAISE EXCEPTION 'firm_entitlement_overrides: overlapping temporary override range for firm=%, feature=%', NEW.firm_id, NEW.feature_key
    USING HINT = 'Choose a non-overlapping effective_from/expires_at window, or end the existing temporary override first.';
EXCEPTION WHEN NO_DATA_FOUND THEN
  RETURN NEW;
END;
$ovl$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS firm_entitlement_temp_overlap_guard_trg
  ON firm_entitlement_overrides;
CREATE TRIGGER firm_entitlement_temp_overlap_guard_trg
  BEFORE INSERT OR UPDATE OF override_kind, firm_id, feature_key, effective_from, expires_at
  ON firm_entitlement_overrides
  FOR EACH ROW EXECUTE FUNCTION firm_entitlement_temp_overlap_guard();

CREATE INDEX IF NOT EXISTS idx_firm_entitlement_firm
  ON firm_entitlement_overrides (firm_id);

CREATE INDEX IF NOT EXISTS idx_firm_entitlement_feature
  ON firm_entitlement_overrides (feature_key);

CREATE INDEX IF NOT EXISTS idx_firm_entitlement_effective
  ON firm_entitlement_overrides (firm_id, feature_key, effective_from, expires_at);

CREATE INDEX IF NOT EXISTS idx_firm_entitlement_billing_type
  ON firm_entitlement_overrides (firm_id, billing_type);

CREATE INDEX IF NOT EXISTS idx_firm_entitlement_kind
  ON firm_entitlement_overrides (firm_id, override_kind);

-- RLS
--
-- G10 WRITE-AUTHORITY MATRIX (P0 SECURITY — operation-specific policies):
--   platform_features:  Firm app_user = SELECT only.  Founder/platform system = write.
--   plan_entitlements:  Firm app_user = SELECT only.  Founder/platform system = write.
--   firm_entitlement_overrides: Firm = read own effective config; Founder = create/
--                       update/end overrides.  Firm user MUST NOT self-alter.
--   subscription_history: Firm = SELECT own history; Platform/system = INSERT only.
--                       UPDATE/DELETE forbidden (immutable history).
--   billing_ledger:   Firm = SELECT own ledger; Platform billing/system service =
--                     INSERT only.  UPDATE/DELETE blocked by append-only trigger.
--   usage_counters:   Firm = SELECT own usage; Metering/service path = write.
--
-- Each table receives SEPARATE per-operation policies instead of a blanket
-- FOR ALL TO PUBLIC.  This prevents a RLS-wide blanket from being used to
-- e.g. INSERT platform billing rows as a generic firm app_user.
--
-- Shared firm-match predicate:
--   (firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer)
-- Founder bypass (platform owner / privileged service connection):
--   current_setting('app.is_founder',true) = 'true'
-- ---------------------------------------------------------------------------

ALTER TABLE firm_entitlement_overrides ENABLE ROW LEVEL SECURITY;

ALTER TABLE firm_entitlement_overrides FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON firm_entitlement_overrides;
DROP POLICY IF EXISTS firm_entitlement_overrides_select ON firm_entitlement_overrides;
DROP POLICY IF EXISTS firm_entitlement_overrides_insert ON firm_entitlement_overrides;
DROP POLICY IF EXISTS firm_entitlement_overrides_update ON firm_entitlement_overrides;
DROP POLICY IF EXISTS firm_entitlement_overrides_delete ON firm_entitlement_overrides;

-- SELECT: Firm may read own effective config; Founder may read cross-firm.
CREATE POLICY firm_entitlement_overrides_select ON firm_entitlement_overrides
  FOR SELECT TO PUBLIC
  USING (
    (firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer)
    OR current_setting('app.is_founder',true) = 'true'
  );

-- INSERT / UPDATE: Founder / privileged platform service ONLY.
-- A normal firm app_user MUST NOT be able to self-alter its own plan/feature
-- availability unless an explicit self-service path is designed later.
CREATE POLICY firm_entitlement_overrides_insert ON firm_entitlement_overrides
  FOR INSERT TO PUBLIC
  WITH CHECK (
    current_setting('app.is_founder',true) = 'true'
  );

CREATE POLICY firm_entitlement_overrides_update ON firm_entitlement_overrides
  FOR UPDATE TO PUBLIC
  USING (
    current_setting('app.is_founder',true) = 'true'
  )
  WITH CHECK (
    current_setting('app.is_founder',true) = 'true'
  );

-- DELETE: Founder / platform service ONLY (rare, for emergency cleanup).
CREATE POLICY firm_entitlement_overrides_delete ON firm_entitlement_overrides
  FOR DELETE TO PUBLIC
  USING (
    current_setting('app.is_founder',true) = 'true'
  );

-- ---------------------------------------------------------------------------
-- 5. subscription_history — immutable log of subscription changes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS subscription_history (
  id              serial PRIMARY KEY,
  firm_id         integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  old_plan_id     integer REFERENCES subscription_plans(id),
  new_plan_id     integer REFERENCES subscription_plans(id),
  old_status      text,
  new_status      text NOT NULL,
  price_snapshot  numeric(12,2),
  changed_by      integer,
  reason          text,
  before_json     jsonb,
  after_json      jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscription_history_firm
  ON subscription_history (firm_id);

CREATE INDEX IF NOT EXISTS idx_subscription_history_created
  ON subscription_history (firm_id, created_at DESC);

ALTER TABLE subscription_history ENABLE ROW LEVEL SECURITY;

ALTER TABLE subscription_history FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON subscription_history;
DROP POLICY IF EXISTS subscription_history_select ON subscription_history;
DROP POLICY IF EXISTS subscription_history_insert ON subscription_history;
DROP POLICY IF EXISTS subscription_history_update ON subscription_history;
DROP POLICY IF EXISTS subscription_history_delete ON subscription_history;

-- SELECT: Firm may read own history (if UI displays it); Founder cross-firm.
CREATE POLICY subscription_history_select ON subscription_history
  FOR SELECT TO PUBLIC
  USING (
    (firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer)
    OR current_setting('app.is_founder',true) = 'true'
  );

-- INSERT: Platform/system service ONLY.  Immutable log.
CREATE POLICY subscription_history_insert ON subscription_history
  FOR INSERT TO PUBLIC
  WITH CHECK (
    current_setting('app.is_founder',true) = 'true'
  );

-- UPDATE / DELETE: EXPLICITLY FORBIDDEN for everybody.
-- (Postgres requires a policy to exist in order for RLS to deny; we use a
--  contradictory WHERE to guarantee zero rows pass.)
CREATE POLICY subscription_history_update ON subscription_history
  FOR UPDATE TO PUBLIC
  USING (false)
  WITH CHECK (false);

CREATE POLICY subscription_history_delete ON subscription_history
  FOR DELETE TO PUBLIC
  USING (false);

-- ---------------------------------------------------------------------------
-- 6. billing_ledger — APPEND-ONLY platform billing ledger per firm
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS billing_ledger (
  id                     bigserial PRIMARY KEY,
  firm_id                integer NOT NULL REFERENCES firms(id) ON DELETE RESTRICT,
  subscription_id        integer, -- reserved for future Stripe-like subscription_id
  invoice_id             integer REFERENCES firm_invoices(id) ON DELETE SET NULL,
  idempotency_key        text,           -- Phase 4 concurrency: prevents duplicate charges/payment callbacks
  entry_type             text NOT NULL
                         CHECK (entry_type IN (
                           'subscription_charge','usage_charge','addon_charge',
                           'adjustment','reversal','credit_note','debit_note',
                           'payment','refund','write_off','rounding','complimentary'
                         )),
  description            text NOT NULL,
  billing_period_start   date,
  billing_period_end     date,
  debit                  numeric(18,2) NOT NULL DEFAULT 0,
  credit                 numeric(18,2) NOT NULL DEFAULT 0,
  currency               text NOT NULL DEFAULT 'MYR',
  reference_no           text,
  correlation_id         text,
  source_type            text,
  source_id              integer,
  due_date               date,
  paid_date              date,
  status                 text NOT NULL DEFAULT 'posted'
                         CHECK (status IN ('pending','posted','voided')),
  payment_reference      text,
  payment_method         text,
  running_balance        numeric(18,2) NOT NULL DEFAULT 0,
  created_by             integer,
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- Idempotency: one ledger entry per (firm, idempotency_key) when provided.
-- Prevents duplicate recurring charges / payment callbacks / double-submitted webhooks.
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_ledger_idempotency
  ON billing_ledger (firm_id, idempotency_key)
  WHERE (idempotency_key IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_billing_ledger_firm
  ON billing_ledger (firm_id);

CREATE INDEX IF NOT EXISTS idx_billing_ledger_firm_created
  ON billing_ledger (firm_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_ledger_invoice
  ON billing_ledger (invoice_id);

CREATE INDEX IF NOT EXISTS idx_billing_ledger_period
  ON billing_ledger (firm_id, billing_period_start, billing_period_end);

CREATE INDEX IF NOT EXISTS idx_billing_ledger_entry_type
  ON billing_ledger (firm_id, entry_type);

CREATE INDEX IF NOT EXISTS idx_billing_ledger_status
  ON billing_ledger (status);

ALTER TABLE billing_ledger ENABLE ROW LEVEL SECURITY;

ALTER TABLE billing_ledger FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON billing_ledger;
DROP POLICY IF EXISTS billing_ledger_select ON billing_ledger;
DROP POLICY IF EXISTS billing_ledger_insert ON billing_ledger;
DROP POLICY IF EXISTS billing_ledger_update ON billing_ledger;
DROP POLICY IF EXISTS billing_ledger_delete ON billing_ledger;

-- SELECT: Firm read own ledger; Founder cross-firm.
CREATE POLICY billing_ledger_select ON billing_ledger
  FOR SELECT TO PUBLIC
  USING (
    (firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer)
    OR current_setting('app.is_founder',true) = 'true'
  );

-- INSERT: Platform billing/system service ONLY.
-- Generic firm app_user MUST NOT arbitrarily INSERT platform billing entries;
-- ledger entries flow through the metering / monthly-charge / reversal
-- service endpoints running as founder/privileged service context.
CREATE POLICY billing_ledger_insert ON billing_ledger
  FOR INSERT TO PUBLIC
  WITH CHECK (
    current_setting('app.is_founder',true) = 'true'
  );

-- UPDATE / DELETE: EXPLICITLY FORBIDDEN for everyone.
-- (Append-only is also enforced by the billing_ledger_append_only trigger below;
--  RLS denial here provides a second layer that also denies the owner.)
CREATE POLICY billing_ledger_update ON billing_ledger
  FOR UPDATE TO PUBLIC
  USING (false)
  WITH CHECK (false);

CREATE POLICY billing_ledger_delete ON billing_ledger
  FOR DELETE TO PUBLIC
  USING (false);

-- Guardrail: prevent UPDATE/DELETE on billing_ledger for non-superusers
-- (We do not REVOKE from owner here; app-level code must treat append-only.)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'billing_ledger_append_only') THEN
    EXECUTE $trig$
      CREATE OR REPLACE FUNCTION billing_ledger_no_update()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'billing_ledger is APPEND-ONLY: UPDATE/DELETE not allowed';
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER billing_ledger_append_only
      BEFORE UPDATE OR DELETE ON billing_ledger
      FOR EACH STATEMENT EXECUTE FUNCTION billing_ledger_no_update();
    $trig$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 7. usage_counters — unified usage source-of-truth per firm + feature
--    Both Platform Admin and Firm read from this table.
--    period_key format: YYYY-MM (monthly) or special 'all_time'
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS usage_counters (
  id           bigserial PRIMARY KEY,
  firm_id      integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  metric_key   text NOT NULL,
  period_key   text NOT NULL,
  counter      numeric(18,2) NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_usage_counters_firm_metric_period
  ON usage_counters (firm_id, metric_key, period_key);

CREATE INDEX IF NOT EXISTS idx_usage_counters_firm
  ON usage_counters (firm_id);

CREATE INDEX IF NOT EXISTS idx_usage_counters_period
  ON usage_counters (firm_id, period_key);

ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;

ALTER TABLE usage_counters FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON usage_counters;
DROP POLICY IF EXISTS usage_counters_select ON usage_counters;
DROP POLICY IF EXISTS usage_counters_write ON usage_counters;
DROP POLICY IF EXISTS usage_counters_delete ON usage_counters;

-- SELECT: Firm read own usage; Founder cross-firm.
CREATE POLICY usage_counters_select ON usage_counters
  FOR SELECT TO PUBLIC
  USING (
    (firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer)
    OR current_setting('app.is_founder',true) = 'true'
  );

-- INSERT / UPDATE: Actual metering/service path ONLY (founder context).
-- No generic uncontrolled DELETE ever.
CREATE POLICY usage_counters_write ON usage_counters
  FOR INSERT TO PUBLIC
  WITH CHECK (
    current_setting('app.is_founder',true) = 'true'
  );

-- UPDATE: Metering service upsert path only.
CREATE POLICY usage_counters_update ON usage_counters
  FOR UPDATE TO PUBLIC
  USING (
    current_setting('app.is_founder',true) = 'true'
  )
  WITH CHECK (
    current_setting('app.is_founder',true) = 'true'
  );

-- DELETE: Explicitly forbidden.  Meter increments are upserts; a counter is
-- never deleted unless a founder emergency script runs outside RLS (superuser).
CREATE POLICY usage_counters_delete ON usage_counters
  FOR DELETE TO PUBLIC
  USING (false);

-- RLS for plan_entitlements — SELECT-only catalog policy retained (firm &
-- founder both read); writes founder-only via separate INSERT/UPDATE/DELETE.
ALTER TABLE plan_entitlements ENABLE ROW LEVEL SECURITY;

ALTER TABLE plan_entitlements FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON plan_entitlements;
DROP POLICY IF EXISTS plan_entitlements_select ON plan_entitlements;
DROP POLICY IF EXISTS plan_entitlements_write ON plan_entitlements;

CREATE POLICY plan_entitlements_select ON plan_entitlements
  FOR SELECT TO PUBLIC
  USING (true);

CREATE POLICY plan_entitlements_insert ON plan_entitlements
  FOR INSERT TO PUBLIC
  WITH CHECK (
    current_setting('app.is_founder',true) = 'true'
  );

CREATE POLICY plan_entitlements_update ON plan_entitlements
  FOR UPDATE TO PUBLIC
  USING (
    current_setting('app.is_founder',true) = 'true'
  )
  WITH CHECK (
    current_setting('app.is_founder',true) = 'true'
  );

CREATE POLICY plan_entitlements_delete ON plan_entitlements
  FOR DELETE TO PUBLIC
  USING (
    current_setting('app.is_founder',true) = 'true'
  );

-- RLS for platform_features — SELECT-only catalog retained; writes founder-only
ALTER TABLE platform_features ENABLE ROW LEVEL SECURITY;

ALTER TABLE platform_features FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON platform_features;
DROP POLICY IF EXISTS platform_features_select ON platform_features;

CREATE POLICY platform_features_select ON platform_features
  FOR SELECT TO PUBLIC
  USING (true);

CREATE POLICY platform_features_insert ON platform_features
  FOR INSERT TO PUBLIC
  WITH CHECK (
    current_setting('app.is_founder',true) = 'true'
  );

CREATE POLICY platform_features_update ON platform_features
  FOR UPDATE TO PUBLIC
  USING (
    current_setting('app.is_founder',true) = 'true'
  )
  WITH CHECK (
    current_setting('app.is_founder',true) = 'true'
  );

CREATE POLICY platform_features_delete ON platform_features
  FOR DELETE TO PUBLIC
  USING (
    current_setting('app.is_founder',true) = 'true'
  );

-- ---------------------------------------------------------------------------
-- 8. Runtime privileges for app_user
--
-- MODEL A — DETERMINISTIC EXPLICIT PER-TABLE GRANTS (G11):
--   We rely on EXACT per-table GRANTs in this migration rather than on the
--   0002 ALTER DEFAULT PRIVILEGES alone.  Default ACLs are role/creator
--   scoped; unless the exact role that ran ALTER DEFAULT also creates these
--   tables the ACL is NOT inherited — so Model A is the only deterministic
--   contract.
--
--   We NEVER use `GRANT ... ON ALL TABLES IN SCHEMA public`.
--
-- WRITE-AUTHORITY (from G10 matrix):
--   platform_features        → app_user: SELECT (reads feature catalog only)
--   plan_entitlements        → app_user: SELECT (reads plan catalog only)
--   firm_entitlement_overrides → app_user: SELECT (own firm only; no writes)
--   subscription_history     → app_user: SELECT (own firm; immutable)
--   billing_ledger           → app_user: SELECT (own firm; inserts via
--                                           service founder context only)
--   usage_counters           → app_user: SELECT (own firm; metering path
--                                           writes via service founder ctx)
--
--   Sequences used by these tables are needed by the founder-service write
--   path; we grant USAGE, SELECT to both authenticator and app_user so the
--   server connection pool can obtain nextval() when running in the
--   privileged service context.  The authenticator role is the Supabase
--   standard proxy role; keeping grants in sync avoids runtime permission
--   denied errors on insert paths.
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO app_user;

-- platform_features (catalog SELECT for firm UI)
GRANT SELECT ON TABLE public.platform_features TO app_user;
-- plan_entitlements (catalog SELECT for firm UI)
GRANT SELECT ON TABLE public.plan_entitlements TO app_user;
-- firm_entitlement_overrides (firm reads own effective overrides only)
GRANT SELECT ON TABLE public.firm_entitlement_overrides TO app_user;
-- subscription_history (firm reads own history only; immutable log)
GRANT SELECT ON TABLE public.subscription_history TO app_user;
-- billing_ledger (firm reads own ledger only)
GRANT SELECT ON TABLE public.billing_ledger TO app_user;
-- usage_counters (firm reads own usage only)
GRANT SELECT ON TABLE public.usage_counters TO app_user;

-- Sequences (read usage for service write path; shared grants)
GRANT USAGE, SELECT ON SEQUENCE
  public.platform_features_id_seq,
  public.plan_entitlements_id_seq,
  public.firm_entitlement_overrides_id_seq,
  public.subscription_history_id_seq,
  public.billing_ledger_id_seq,
  public.usage_counters_id_seq
  TO authenticator, app_user;

COMMIT;
