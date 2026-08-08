-- LAWCASEPRO V5 ADDENDUM P0 RUNTIME SCHEMA PARITY
-- VISIBLE STABILISATION RELEASE - RUNTIME ADDENDUM
-- Safe, idempotent, additive-only. No destructive changes.
-- Scope: Only runtime parity for endpoints that 500/504.
-- Objects: user_notifications cols, case_bottleneck tables, file_custody tables, invoices einvoice cols.
-- Date: 2026-08-09

-- ============================================================
-- PART A: MISSING TABLES CREATE TABLE IF NOT EXISTS
-- Remote confirmed: case_bottleneck_snapshots / case_monitor_logs / file_custody_items / file_custody_movements DO NOT EXIST.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.case_bottleneck_snapshots (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    firm_id integer NOT NULL,
    case_id integer,
    payment_voucher_id integer,
    monitor_kind text NOT NULL,
    severity text NOT NULL DEFAULT 'attention',
    days_stuck integer NOT NULL DEFAULT 0,
    responsible_lawyer_user_id integer,
    responsible_manager_user_id integer,
    title text NOT NULL,
    detail text,
    metadata jsonb DEFAULT '{}'::jsonb,
    escalated_to_partner boolean NOT NULL DEFAULT false,
    escalated_at timestamptz,
    resolved_at timestamptz,
    resolved_by integer,
    resolved_note text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.case_monitor_logs (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    firm_id integer NOT NULL,
    snapshot_id integer,
    case_id integer,
    actor_user_id integer,
    action text NOT NULL,
    notes text,
    metadata jsonb DEFAULT '{}'::jsonb,
    ip_address text,
    user_agent text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.file_custody_items (
    id serial PRIMARY KEY,
    firm_id integer NOT NULL,
    case_id integer,
    project_id integer,
    matter_label text NOT NULL DEFAULT 'General',
    file_reference_no text NOT NULL,
    file_title text NOT NULL,
    file_description text,
    physical_or_digital text NOT NULL DEFAULT 'digital',
    category text NOT NULL DEFAULT 'court_document',
    storage_location text,
    tags text,
    current_holder_user_id integer,
    current_holder_name text,
    current_holder_contact text,
    current_holder_firm_external text,
    acknowledged_at timestamptz,
    acknowledge_due_at timestamptz,
    expected_return_at timestamptz,
    last_movement_id integer,
    lifecycle_status text NOT NULL DEFAULT 'in_office',
    status_set_at timestamptz,
    is_archived boolean NOT NULL DEFAULT false,
    archived_at timestamptz,
    archived_by_user_id integer,
    version integer NOT NULL DEFAULT 0,
    meta jsonb,
    created_by_user_id integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.file_custody_movements (
    id serial PRIMARY KEY,
    firm_id integer NOT NULL,
    custody_item_id integer NOT NULL,
    movement_kind text NOT NULL,
    from_holder_user_id integer,
    from_holder_name text,
    from_holder_contact text,
    from_holder_firm_external text,
    to_holder_user_id integer,
    to_holder_name text,
    to_holder_contact text,
    to_holder_firm_external text,
    expected_return_at timestamptz,
    acknowledge_due_at timestamptz,
    acknowledged_at timestamptz,
    acknowledged_by_user_id integer,
    acknowledged_note text,
    returned_at timestamptz,
    returned_by_user_id integer,
    returned_condition text,
    returned_note text,
    escalated_at timestamptz,
    escalated_to_partner boolean NOT NULL DEFAULT false,
    severity text NOT NULL DEFAULT 'normal',
    movement_note text,
    meta jsonb,
    ip_address text,
    user_agent text,
    created_by_user_id integer,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- PART B: ALTER-only DO block (for tables that already exist)
-- ============================================================

DO $$
DECLARE
    _sql text;
BEGIN

-- ============================================================
-- PART 1: user_notifications - Add missing columns (IF NOT EXISTS)
-- Remote confirmed: 13 columns only; ~30 missing.
-- ============================================================

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'status') THEN
    ALTER TABLE user_notifications ADD COLUMN status text NOT NULL DEFAULT 'unread';
END IF;

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'severity') THEN
    ALTER TABLE user_notifications ADD COLUMN severity text NOT NULL DEFAULT 'normal';
END IF;

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'target_scope') THEN
    ALTER TABLE user_notifications ADD COLUMN target_scope text;
END IF;

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'target_role_id') THEN
    ALTER TABLE user_notifications ADD COLUMN target_role_id integer;
END IF;

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'dismissible') THEN
    ALTER TABLE user_notifications ADD COLUMN dismissible boolean NOT NULL DEFAULT true;
END IF;

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'acknowledged_at') THEN
    ALTER TABLE user_notifications ADD COLUMN acknowledged_at timestamptz;
END IF;

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'acknowledged_by') THEN
    ALTER TABLE user_notifications ADD COLUMN acknowledged_by integer;
END IF;

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'escalated_at') THEN
    ALTER TABLE user_notifications ADD COLUMN escalated_at timestamptz;
END IF;

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'resolved_at') THEN
    ALTER TABLE user_notifications ADD COLUMN resolved_at timestamptz;
END IF;

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'resolved_by') THEN
    ALTER TABLE user_notifications ADD COLUMN resolved_by integer;
END IF;

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'auto_resolved_at') THEN
    ALTER TABLE user_notifications ADD COLUMN auto_resolved_at timestamptz;
END IF;

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'status_set_at') THEN
    ALTER TABLE user_notifications ADD COLUMN status_set_at timestamptz;
END IF;

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'escalated_reason') THEN
    ALTER TABLE user_notifications ADD COLUMN escalated_reason text;
END IF;

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'resolved_reason') THEN
    ALTER TABLE user_notifications ADD COLUMN resolved_reason text;
END IF;

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'ip_address') THEN
    ALTER TABLE user_notifications ADD COLUMN ip_address text;
END IF;

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'user_agent') THEN
    ALTER TABLE user_notifications ADD COLUMN user_agent text;
END IF;

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'acknowledgement_due_at') THEN
    ALTER TABLE user_notifications ADD COLUMN acknowledgement_due_at timestamptz;
END IF;

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'resolution_sla_due_at') THEN
    ALTER TABLE user_notifications ADD COLUMN resolution_sla_due_at timestamptz;
END IF;

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'resolution_mode') THEN
    ALTER TABLE user_notifications ADD COLUMN resolution_mode text;
END IF;

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'rule_code') THEN
    ALTER TABLE user_notifications ADD COLUMN rule_code text;
END IF;

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'correlation_id') THEN
    ALTER TABLE user_notifications ADD COLUMN correlation_id text;
END IF;

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'entity_type') THEN
    ALTER TABLE user_notifications ADD COLUMN entity_type text;
END IF;

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'entity_id') THEN
    ALTER TABLE user_notifications ADD COLUMN entity_id text;
END IF;

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'last_notified_at') THEN
    ALTER TABLE user_notifications ADD COLUMN last_notified_at timestamptz;
END IF;

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'next_notify_at') THEN
    ALTER TABLE user_notifications ADD COLUMN next_notify_at timestamptz;
END IF;

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'delivery_count') THEN
    ALTER TABLE user_notifications ADD COLUMN delivery_count integer NOT NULL DEFAULT 0;
END IF;

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'event_created_at') THEN
    ALTER TABLE user_notifications ADD COLUMN event_created_at timestamptz;
END IF;

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'event_acknowledged_at') THEN
    ALTER TABLE user_notifications ADD COLUMN event_acknowledged_at timestamptz;
END IF;

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'event_resolved_at') THEN
    ALTER TABLE user_notifications ADD COLUMN event_resolved_at timestamptz;
END IF;

IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'updated_at') THEN
    ALTER TABLE user_notifications ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
END IF;

-- Backfill legacy rows: status_set_at for rows without one (safe non-destructive)
IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'status_set_at')
   AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_notifications' AND column_name = 'created_at') THEN
    UPDATE public.user_notifications SET status_set_at = COALESCE(status_set_at, created_at) WHERE status_set_at IS NULL;
END IF;

-- ============================================================
-- PART 2 (skip ALTERs): case_bottleneck_snapshots / case_monitor_logs
-- Tables created in PART A above.
-- ============================================================

-- ============================================================
-- PART 3 (skip ALTERs): file_custody_items / file_custody_movements
-- Tables created in PART A above.
-- (If they existed before versioning columns, ensure they exist:)
-- ============================================================

IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'file_custody_items') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'file_custody_items' AND column_name = 'status_set_at') THEN
        ALTER TABLE file_custody_items ADD COLUMN status_set_at timestamptz;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'file_custody_items' AND column_name = 'version') THEN
        ALTER TABLE file_custody_items ADD COLUMN version integer NOT NULL DEFAULT 0;
    END IF;
END IF;

-- ============================================================
-- PART 4: invoices - Add einvoice columns IF NOT EXISTS
-- Remote confirmed: 19 cols only; 9 einvoice_* cols MISSING.
-- ============================================================

IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'invoices') THEN

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'einvoice_status') THEN
        ALTER TABLE invoices ADD COLUMN einvoice_status text NOT NULL DEFAULT 'DRAFT';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'einvoice_external_submission_id') THEN
        ALTER TABLE invoices ADD COLUMN einvoice_external_submission_id text;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'einvoice_submitted_at') THEN
        ALTER TABLE invoices ADD COLUMN einvoice_submitted_at timestamptz;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'einvoice_last_checked_at') THEN
        ALTER TABLE invoices ADD COLUMN einvoice_last_checked_at timestamptz;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'einvoice_error_code') THEN
        ALTER TABLE invoices ADD COLUMN einvoice_error_code text;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'einvoice_error_message') THEN
        ALTER TABLE invoices ADD COLUMN einvoice_error_message text;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'einvoice_retry_count') THEN
        ALTER TABLE invoices ADD COLUMN einvoice_retry_count integer NOT NULL DEFAULT 0;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'einvoice_classification') THEN
        ALTER TABLE invoices ADD COLUMN einvoice_classification text;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'einvoice_source_invoice_id') THEN
        ALTER TABLE invoices ADD COLUMN einvoice_source_invoice_id integer;
    END IF;

END IF;

END $$;

-- ============================================================
-- PART 5: Indexes (CREATE INDEX IF NOT EXISTS - plain SQL, idempotent)
-- ============================================================

-- --- user_notifications ---
CREATE INDEX IF NOT EXISTS idx_user_notifs_firm_user_status ON public.user_notifications (firm_id, user_id, status);
CREATE INDEX IF NOT EXISTS idx_user_notifs_target_scope ON public.user_notifications (firm_id, target_scope);
CREATE INDEX IF NOT EXISTS idx_user_notifs_severity ON public.user_notifications (firm_id, severity);
CREATE INDEX IF NOT EXISTS idx_user_notifs_firm_status_severity_created ON public.user_notifications (firm_id, status, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_notifs_firm_target_scope_created ON public.user_notifications (firm_id, target_scope, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_notifs_firm_overdue ON public.user_notifications (firm_id, acknowledgement_due_at) WHERE acknowledgement_due_at IS NOT NULL AND acknowledged_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_user_notifs_firm_correlation ON public.user_notifications (firm_id, correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_notifs_firm_rule_code ON public.user_notifications (firm_id, rule_code) WHERE rule_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_notifs_firm_next_notify ON public.user_notifications (firm_id, next_notify_at) WHERE next_notify_at IS NOT NULL;

-- --- case_bottleneck_snapshots ---
CREATE INDEX IF NOT EXISTS case_bottleneck_firm_open_idx ON public.case_bottleneck_snapshots (firm_id, resolved_at, severity);
CREATE INDEX IF NOT EXISTS case_bottleneck_case_idx ON public.case_bottleneck_snapshots (case_id, resolved_at);
CREATE INDEX IF NOT EXISTS case_bottleneck_lawyer_idx ON public.case_bottleneck_snapshots (responsible_lawyer_user_id, resolved_at);

-- --- case_monitor_logs ---
CREATE INDEX IF NOT EXISTS case_monitor_logs_firm_idx ON public.case_monitor_logs (firm_id, created_at);
CREATE INDEX IF NOT EXISTS case_monitor_logs_snapshot_idx ON public.case_monitor_logs (snapshot_id, created_at);

-- --- file_custody_items ---
CREATE UNIQUE INDEX IF NOT EXISTS uq_file_custody_items_firm_file_ref ON public.file_custody_items (firm_id, file_reference_no);
CREATE INDEX IF NOT EXISTS idx_file_custody_items_firm_status ON public.file_custody_items (firm_id, lifecycle_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_custody_items_firm_case ON public.file_custody_items (firm_id, case_id);
CREATE INDEX IF NOT EXISTS idx_file_custody_items_firm_holder ON public.file_custody_items (firm_id, current_holder_user_id);
CREATE INDEX IF NOT EXISTS idx_file_custody_items_firm_due_return ON public.file_custody_items (firm_id, expected_return_at) WHERE lifecycle_status IN ('out_on_loan','out_with_counsel','out_with_client','out_external');
CREATE INDEX IF NOT EXISTS idx_file_custody_items_firm_ack_due ON public.file_custody_items (firm_id, acknowledge_due_at) WHERE acknowledged_at IS NULL AND lifecycle_status != 'in_office';
CREATE INDEX IF NOT EXISTS idx_file_custody_items_firm_status_set ON public.file_custody_items (firm_id, status_set_at) WHERE status_set_at IS NOT NULL;

-- --- file_custody_movements ---
CREATE INDEX IF NOT EXISTS idx_file_custody_mv_firm_item_created ON public.file_custody_movements (firm_id, custody_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_custody_mv_firm_created ON public.file_custody_movements (firm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_custody_mv_firm_ack_pending ON public.file_custody_movements (firm_id, to_holder_user_id, acknowledge_due_at) WHERE acknowledged_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_file_custody_mv_firm_return_pending ON public.file_custody_movements (firm_id, expected_return_at) WHERE returned_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_file_custody_mv_firm_escalated ON public.file_custody_movements (firm_id, escalated_at) WHERE escalated_at IS NOT NULL;

-- --- invoices einvoice ---
CREATE INDEX IF NOT EXISTS idx_invoices_einvoice_status ON public.invoices (firm_id, einvoice_status);
CREATE INDEX IF NOT EXISTS idx_invoices_einvoice_source ON public.invoices (einvoice_source_invoice_id);

-- ============================================================
-- PART 6: RLS enables. Tables created via CREATE TABLE don't auto-enable.
-- ============================================================

DO $$ BEGIN
    ALTER TABLE public.case_bottleneck_snapshots ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE public.case_monitor_logs ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE public.file_custody_items ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE public.file_custody_movements ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ============================================================
-- PART 7: Triggers - moddatetime for user_notifications.updated_at
-- Skip gracefully if moddatetime extension unavailable.
-- ============================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_user_notifications_updated_at')
       AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'moddatetime') THEN
        CREATE TRIGGER trg_user_notifications_updated_at
        BEFORE UPDATE ON public.user_notifications
        FOR EACH ROW EXECUTE FUNCTION moddatetime('updated_at');
    END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
