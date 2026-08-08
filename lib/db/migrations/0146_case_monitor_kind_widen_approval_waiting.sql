-- Migration 0146: Widen case_bottleneck monitor_kind to add approval_waiting
-- Additive / idempotent safe. Widens 5-kind CHECK to 6-kind CHECK, no data loss, no rename.
-- PART 3 §44 Partner Monitor: Approval waiting bottleneck detection.
-- Destructive actions = 0 (DROP old constraint, ADD new constraint; table data retained)

DO $$ BEGIN
  -- Safe widen of monitor_kind CHECK. Add new value 'approval_waiting' (PART 3 §44).
  ALTER TABLE IF EXISTS public.case_bottleneck_snapshots
    DROP CONSTRAINT IF EXISTS case_bottleneck_monitor_kind;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE IF EXISTS public.case_bottleneck_snapshots
    ADD CONSTRAINT case_bottleneck_monitor_kind
    CHECK (monitor_kind IN (
      'case_no_movement','case_waiting','case_on_hold',
      'pv_delay','urgent','approval_waiting'
    ));
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- Responsible manager user_id index (PART 3 §44 grouping by manager)
CREATE INDEX IF NOT EXISTS case_bottleneck_manager_idx
  ON public.case_bottleneck_snapshots (responsible_manager_user_id, resolved_at);

COMMENT ON CONSTRAINT case_bottleneck_monitor_kind ON public.case_bottleneck_snapshots
  IS 'PART 3 §44. 6 monitor kinds: no_movement (3-day rule), waiting, on_hold, pv_delay, urgent, approval_waiting (>24h pending).';
COMMENT ON COLUMN public.case_bottleneck_snapshots.responsible_manager_user_id
  IS 'Responsible Manager user id for bottleneck grouping. Populated via role-name manager in case_assignments, or approving-partner fallback. NULLABLE. Indexed with resolved_at for open-by-manager dashboard grouping.';
