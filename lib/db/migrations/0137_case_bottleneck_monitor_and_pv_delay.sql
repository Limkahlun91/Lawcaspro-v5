-- Migration 0137 (REVISED — Statement-by-Statement Idempotent):
-- Case Bottleneck Monitor + PV Delay Monitor tables.
-- OOB Addendum previously created case_bottleneck_snapshots and case_monitor_logs
-- tables WITHOUT all required security / constraints / indexes / policies / triggers.
-- Therefore every object class below is applied INDEPENDENTLY, never wrapped
-- inside a single "IF table does not exist" block that would silently skip
-- required security objects when the table already pre-exists.
--
-- Additive only. No destructive changes. Respects firm isolation with RLS.
-- Lawcaspro v5.

-- =========================================================================
-- 1) TABLE CREATION (safe IF NOT EXISTS guard only for the table itself)
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.case_bottleneck_snapshots (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES public.firms(id) ON DELETE CASCADE,
  case_id integer REFERENCES public.cases(id) ON DELETE SET NULL,
  payment_voucher_id integer REFERENCES public.payment_vouchers(id) ON DELETE SET NULL,
  monitor_kind text NOT NULL,
  severity text NOT NULL DEFAULT 'attention',
  days_stuck integer NOT NULL DEFAULT 0,
  responsible_lawyer_user_id integer REFERENCES public.users(id) ON DELETE SET NULL,
  responsible_manager_user_id integer REFERENCES public.users(id) ON DELETE SET NULL,
  title text NOT NULL,
  detail text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  escalated_to_partner boolean NOT NULL DEFAULT FALSE,
  escalated_at timestamptz,
  resolved_at timestamptz,
  resolved_by integer REFERENCES public.users(id) ON DELETE SET NULL,
  resolved_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.case_monitor_logs (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES public.firms(id) ON DELETE CASCADE,
  snapshot_id integer REFERENCES public.case_bottleneck_snapshots(id) ON DELETE CASCADE,
  case_id integer REFERENCES public.cases(id) ON DELETE SET NULL,
  actor_user_id integer REFERENCES public.users(id) ON DELETE SET NULL,
  action text NOT NULL,
  notes text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- =========================================================================
-- 2) ADD COLUMN IF NOT EXISTS — safety net for any column missed by OOB
-- =========================================================================

ALTER TABLE public.case_bottleneck_snapshots ADD COLUMN IF NOT EXISTS firm_id integer NOT NULL DEFAULT 0;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'case_bottleneck_snapshots_firm_id_fkey') THEN NULL; ELSE ALTER TABLE public.case_bottleneck_snapshots ADD CONSTRAINT case_bottleneck_snapshots_firm_id_fkey FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE CASCADE; END IF; END $$;
ALTER TABLE public.case_bottleneck_snapshots ALTER COLUMN firm_id DROP DEFAULT;
ALTER TABLE public.case_bottleneck_snapshots ADD COLUMN IF NOT EXISTS case_id integer REFERENCES public.cases(id) ON DELETE SET NULL;
ALTER TABLE public.case_bottleneck_snapshots ADD COLUMN IF NOT EXISTS payment_voucher_id integer REFERENCES public.payment_vouchers(id) ON DELETE SET NULL;
ALTER TABLE public.case_bottleneck_snapshots ADD COLUMN IF NOT EXISTS monitor_kind text NOT NULL DEFAULT 'case_waiting';
ALTER TABLE public.case_bottleneck_snapshots ALTER COLUMN monitor_kind DROP DEFAULT;
ALTER TABLE public.case_bottleneck_snapshots ADD COLUMN IF NOT EXISTS severity text NOT NULL DEFAULT 'attention';
ALTER TABLE public.case_bottleneck_snapshots ADD COLUMN IF NOT EXISTS days_stuck integer NOT NULL DEFAULT 0;
ALTER TABLE public.case_bottleneck_snapshots ADD COLUMN IF NOT EXISTS responsible_lawyer_user_id integer REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.case_bottleneck_snapshots ADD COLUMN IF NOT EXISTS responsible_manager_user_id integer REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.case_bottleneck_snapshots ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '(untitled)';
ALTER TABLE public.case_bottleneck_snapshots ALTER COLUMN title DROP DEFAULT;
ALTER TABLE public.case_bottleneck_snapshots ADD COLUMN IF NOT EXISTS detail text;
ALTER TABLE public.case_bottleneck_snapshots ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.case_bottleneck_snapshots ADD COLUMN IF NOT EXISTS escalated_to_partner boolean NOT NULL DEFAULT FALSE;
ALTER TABLE public.case_bottleneck_snapshots ADD COLUMN IF NOT EXISTS escalated_at timestamptz;
ALTER TABLE public.case_bottleneck_snapshots ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
ALTER TABLE public.case_bottleneck_snapshots ADD COLUMN IF NOT EXISTS resolved_by integer REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.case_bottleneck_snapshots ADD COLUMN IF NOT EXISTS resolved_note text;
ALTER TABLE public.case_bottleneck_snapshots ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.case_bottleneck_snapshots ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.case_monitor_logs ADD COLUMN IF NOT EXISTS firm_id integer NOT NULL DEFAULT 0;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'case_monitor_logs_firm_id_fkey') THEN NULL; ELSE ALTER TABLE public.case_monitor_logs ADD CONSTRAINT case_monitor_logs_firm_id_fkey FOREIGN KEY (firm_id) REFERENCES public.firms(id) ON DELETE CASCADE; END IF; END $$;
ALTER TABLE public.case_monitor_logs ALTER COLUMN firm_id DROP DEFAULT;
ALTER TABLE public.case_monitor_logs ADD COLUMN IF NOT EXISTS snapshot_id integer REFERENCES public.case_bottleneck_snapshots(id) ON DELETE CASCADE;
ALTER TABLE public.case_monitor_logs ADD COLUMN IF NOT EXISTS case_id integer REFERENCES public.cases(id) ON DELETE SET NULL;
ALTER TABLE public.case_monitor_logs ADD COLUMN IF NOT EXISTS actor_user_id integer REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.case_monitor_logs ADD COLUMN IF NOT EXISTS action text NOT NULL DEFAULT 'detect';
ALTER TABLE public.case_monitor_logs ALTER COLUMN action DROP DEFAULT;
ALTER TABLE public.case_monitor_logs ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE public.case_monitor_logs ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.case_monitor_logs ADD COLUMN IF NOT EXISTS ip_address text;
ALTER TABLE public.case_monitor_logs ADD COLUMN IF NOT EXISTS user_agent text;
ALTER TABLE public.case_monitor_logs ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- =========================================================================
-- 3) NAMED CHECK CONSTRAINTS — DROP IF EXISTS then CREATE independently
-- =========================================================================

-- case_bottleneck_snapshots: monitor_kind
DO $$ BEGIN
  ALTER TABLE public.case_bottleneck_snapshots DROP CONSTRAINT IF EXISTS case_bottleneck_monitor_kind;
EXCEPTION WHEN OTHERS THEN NULL; END $$;
ALTER TABLE public.case_bottleneck_snapshots
  ADD CONSTRAINT case_bottleneck_monitor_kind
  CHECK (monitor_kind IN ('case_no_movement','case_waiting','case_on_hold','pv_delay','urgent','approval_waiting'));

-- case_bottleneck_snapshots: severity
DO $$ BEGIN
  ALTER TABLE public.case_bottleneck_snapshots DROP CONSTRAINT IF EXISTS case_bottleneck_severity;
EXCEPTION WHEN OTHERS THEN NULL; END $$;
ALTER TABLE public.case_bottleneck_snapshots
  ADD CONSTRAINT case_bottleneck_severity
  CHECK (severity IN ('attention','urgent','critical'));

-- case_monitor_logs: action
DO $$ BEGIN
  ALTER TABLE public.case_monitor_logs DROP CONSTRAINT IF EXISTS case_monitor_action;
EXCEPTION WHEN OTHERS THEN NULL; END $$;
ALTER TABLE public.case_monitor_logs
  ADD CONSTRAINT case_monitor_action
  CHECK (action IN ('detect','escalate','dismiss','resolve','reopen','note'));

-- =========================================================================
-- 4) INDEXES — CREATE INDEX IF NOT EXISTS, every index independently
-- =========================================================================

CREATE INDEX IF NOT EXISTS case_bottleneck_firm_open_idx
  ON public.case_bottleneck_snapshots (firm_id, resolved_at, severity);

CREATE INDEX IF NOT EXISTS case_bottleneck_case_idx
  ON public.case_bottleneck_snapshots (case_id, resolved_at);

CREATE INDEX IF NOT EXISTS case_bottleneck_lawyer_idx
  ON public.case_bottleneck_snapshots (responsible_lawyer_user_id, resolved_at);

CREATE INDEX IF NOT EXISTS case_monitor_logs_firm_idx
  ON public.case_monitor_logs (firm_id, created_at);

CREATE INDEX IF NOT EXISTS case_monitor_logs_snapshot_idx
  ON public.case_monitor_logs (snapshot_id, created_at);

-- =========================================================================
-- 5) RLS ENABLE — unconditional. Safe when already enabled.
-- =========================================================================

ALTER TABLE public.case_bottleneck_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_monitor_logs     ENABLE ROW LEVEL SECURITY;

-- =========================================================================
-- 6) FORCE RLS — unconditional. Swallow harmless duplicate error.
-- =========================================================================

DO $$ BEGIN
  ALTER TABLE public.case_bottleneck_snapshots FORCE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.case_monitor_logs     FORCE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- =========================================================================
-- 7) RLS POLICIES — DROP IF EXISTS, then CREATE. Unconditional.
-- =========================================================================

DROP POLICY IF EXISTS case_bottleneck_snapshots_isolation ON public.case_bottleneck_snapshots;
CREATE POLICY case_bottleneck_snapshots_isolation
  ON public.case_bottleneck_snapshots
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (firm_id = (current_setting('app.current_firm_id', true))::int)
  WITH CHECK (firm_id = (current_setting('app.current_firm_id', true))::int);

DROP POLICY IF EXISTS case_monitor_logs_isolation ON public.case_monitor_logs;
CREATE POLICY case_monitor_logs_isolation
  ON public.case_monitor_logs
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (firm_id = (current_setting('app.current_firm_id', true))::int)
  WITH CHECK (firm_id = (current_setting('app.current_firm_id', true))::int);

-- =========================================================================
-- 8) UPDATED_AT TRIGGER on snapshots — SELF-CONTAINED.
--    Previous revision used public.trigger_set_timestamp() which was
--    a global undeclared helper not guaranteed to exist on the connected
--    instance (had caused code 42883 elsewhere). We now CREATE OR REPLACE
--    our own inline PL/pgSQL function that does not depend on any
--    pre-existing helper.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.case_bottleneck_snapshots_set_updated_at_fn()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS case_bottleneck_snapshots_set_updated_at
  ON public.case_bottleneck_snapshots;

CREATE TRIGGER case_bottleneck_snapshots_set_updated_at
  BEFORE UPDATE ON public.case_bottleneck_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.case_bottleneck_snapshots_set_updated_at_fn();
