-- LAWCASEPRO V5 — 0141 FILE CUSTODY CORRECTIVES
-- TIER 2, PART 1 OF 3
-- Purpose: add optimistic-lock version column, expanded movement/status enum,
-- append-only immutability guard (trigger + rule), and indexes.
-- ADDITIVE only. NO destructive alters.
-- Migration level: LOCAL ONLY — Remote Supabase NOT applied until ordering audit clears.

BEGIN;

-- 1. Optimistic-lock version column on file_custody_items
ALTER TABLE file_custody_items ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;

-- 1b. JSONB meta column on file_custody_movements for cross-linking movement rows
ALTER TABLE file_custody_movements ADD COLUMN IF NOT EXISTS meta JSONB NULL;

-- 1c. updated_at column on file_custody_items (auto-now via Drizzle $onUpdate)
ALTER TABLE file_custody_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- 2. Expand movement_kind check on file_custody_movements
--    Strategy: DO NOT drop existing check (risky). Instead, add a lightweight table-level
--    trigger that enforces the expanded allowed set if present. Postgres CHECK constraints
--    cannot be modified "in place" to relax/expand safely without revalidating against
--    all existing rows. Trigger runs AFTER insert/update and aborts if value outside
--    allowed set. Applies also for clients that bypass Drizzle (manual SQL).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE NOT tgisinternal AND tgrelid = 'public.file_custody_movements'::regclass
      AND tgname = 'trg_file_custody_movements_enforce_kind_allowlist'
  ) THEN
    CREATE FUNCTION trg_file_custody_movements_enforce_kind_allowlist_fn()
      RETURNS trigger
      LANGUAGE plpgsql AS $fn$
    DECLARE
      allowed CONSTANT text[] := ARRAY[
        'release','transfer','acknowledge','return_request','return','receive_return',
        'overdue_auto_flag','archived','reinstated','lost_flag','found'
      ];
    BEGIN
      IF NEW.movement_kind IS NOT NULL AND NEW.movement_kind <> ALL(allowed) THEN
        RAISE EXCEPTION 'invalid movement_kind: %', NEW.movement_kind
          USING HINT = 'Allowed movement_kind values: ' || array_to_string(allowed, ', '),
                ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $fn$;

    CREATE TRIGGER trg_file_custody_movements_enforce_kind_allowlist
    BEFORE INSERT OR UPDATE ON public.file_custody_movements
    FOR EACH ROW
    EXECUTE FUNCTION trg_file_custody_movements_enforce_kind_allowlist_fn();
  END IF;
END $$;

-- 3. Expand lifecycle_status allowlist on file_custody_items (same strategy — allowlist trigger)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE NOT tgisinternal AND tgrelid = 'public.file_custody_items'::regclass
      AND tgname = 'trg_file_custody_items_enforce_status_allowlist'
  ) THEN
    CREATE FUNCTION trg_file_custody_items_enforce_status_allowlist_fn()
      RETURNS trigger
      LANGUAGE plpgsql AS $fn$
    DECLARE
      allowed CONSTANT text[] := ARRAY[
        'in_office','out_on_loan','out_with_counsel','out_with_client','out_external',
        'return_pending','returned','archived','lost'
      ];
    BEGIN
      IF NEW.lifecycle_status IS NOT NULL AND NEW.lifecycle_status <> ALL(allowed) THEN
        RAISE EXCEPTION 'invalid lifecycle_status: %', NEW.lifecycle_status
          USING HINT = 'Allowed lifecycle_status values: ' || array_to_string(allowed, ', '),
                ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $fn$;

    CREATE TRIGGER trg_file_custody_items_enforce_status_allowlist
    BEFORE INSERT OR UPDATE ON public.file_custody_items
    FOR EACH ROW
    EXECUTE FUNCTION trg_file_custody_items_enforce_status_allowlist_fn();
  END IF;
END $$;

-- 4. APPEND-ONLY immutability guard for file_custody_movements
--    Forbid UPDATE / DELETE on any existing movement row. Only INSERT permitted.
--    Support override session variable for platform-level data repair only:
--      SET app.file_custody_movements_allow_mutation = 'on'
--    (intentionally NOT exposed via any API route or RLS role).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE NOT tgisinternal AND tgrelid = 'public.file_custody_movements'::regclass
      AND tgname = 'trg_file_custody_movements_append_only'
  ) THEN
    CREATE FUNCTION trg_file_custody_movements_append_only_fn()
      RETURNS trigger
      LANGUAGE plpgsql AS $fn$
    BEGIN
      IF current_setting('app.file_custody_movements_allow_mutation', true) = 'on' THEN
        RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
      END IF;

      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'file_custody_movements is append-only; DELETE forbidden'
          USING HINT = 'Insert a compensating movement row instead. For emergency repair, set app.file_custody_movements_allow_mutation = on within same transaction.',
                ERRCODE = 'object_not_in_prerequisite_state';
      END IF;

      IF TG_OP = 'UPDATE' THEN
        -- Allow column-level whitelist: system may refresh updated_at if added later,
        -- but forbid mutation of business fields. This is intentionally strict — reject
        -- any UPDATE to keep reasoning simple.
        RAISE EXCEPTION 'file_custody_movements is append-only; UPDATE forbidden'
          USING HINT = 'Insert a new movement row referencing the original movement_id via meta.relatedMovementId instead. For emergency repair, set app.file_custody_movements_allow_mutation = on within same transaction.',
                ERRCODE = 'object_not_in_prerequisite_state';
      END IF;

      RETURN NEW;
    END;
    $fn$;

    CREATE TRIGGER trg_file_custody_movements_append_only
    BEFORE UPDATE OR DELETE ON public.file_custody_movements
    FOR EACH ROW
    EXECUTE FUNCTION trg_file_custody_movements_append_only_fn();
  END IF;
END $$;

-- 5. Indexes: version on items (optimistic lock fast-path WHERE clauses)
CREATE INDEX IF NOT EXISTS idx_file_custody_items_version
  ON public.file_custody_items (firm_id, id, version);

CREATE INDEX IF NOT EXISTS idx_file_custody_movements_meta_related_movement
  ON public.file_custody_movements (firm_id, custody_item_id, movement_kind)
  WHERE meta IS NOT NULL;

COMMIT;
