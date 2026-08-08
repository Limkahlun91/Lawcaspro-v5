-- Migration 0137: Case Bottleneck Monitor + PV Delay Monitor tables
-- Additive only. No destructive changes. Respects firm isolation with RLS.
-- Lawcaspro v5.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'case_bottleneck_snapshots') THEN

    CREATE TABLE public.case_bottleneck_snapshots (
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
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT case_bottleneck_monitor_kind CHECK (monitor_kind IN ('case_no_movement','case_waiting','case_on_hold','pv_delay','urgent')),
      CONSTRAINT case_bottleneck_severity CHECK (severity IN ('attention','urgent','critical'))
    );

    CREATE INDEX case_bottleneck_firm_open_idx ON public.case_bottleneck_snapshots (firm_id, resolved_at, severity);
    CREATE INDEX case_bottleneck_case_idx ON public.case_bottleneck_snapshots (case_id, resolved_at);
    CREATE INDEX case_bottleneck_lawyer_idx ON public.case_bottleneck_snapshots (responsible_lawyer_user_id, resolved_at);

    ALTER TABLE public.case_bottleneck_snapshots ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.case_bottleneck_snapshots FORCE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS case_bottleneck_snapshots_isolation ON public.case_bottleneck_snapshots;
    CREATE POLICY case_bottleneck_snapshots_isolation
      ON public.case_bottleneck_snapshots
      AS PERMISSIVE
      FOR ALL
      TO app_rls_user, authenticated
      USING (firm_id = (current_setting('app.current_firm_id', true))::int)
      WITH CHECK (firm_id = (current_setting('app.current_firm_id', true))::int);

  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'case_monitor_logs') THEN

    CREATE TABLE public.case_monitor_logs (
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
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT case_monitor_action CHECK (action IN ('detect','escalate','dismiss','resolve','reopen','note'))
    );

    CREATE INDEX case_monitor_logs_firm_idx ON public.case_monitor_logs (firm_id, created_at);
    CREATE INDEX case_monitor_logs_snapshot_idx ON public.case_monitor_logs (snapshot_id, created_at);

    ALTER TABLE public.case_monitor_logs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.case_monitor_logs FORCE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS case_monitor_logs_isolation ON public.case_monitor_logs;
    CREATE POLICY case_monitor_logs_isolation
      ON public.case_monitor_logs
      AS PERMISSIVE
      FOR ALL
      TO app_rls_user, authenticated
      USING (firm_id = (current_setting('app.current_firm_id', true))::int)
      WITH CHECK (firm_id = (current_setting('app.current_firm_id', true))::int);

  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'case_bottleneck_snapshots_audit') THEN
    CREATE TRIGGER case_bottleneck_snapshots_set_updated_at
      BEFORE UPDATE ON public.case_bottleneck_snapshots
      FOR EACH ROW EXECUTE FUNCTION public.trigger_set_timestamp();
  END IF;
END
$$;
