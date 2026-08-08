-- Migration 0127: HRMS Business Event Outbox + Subscriptions + Delivery Attempts
-- Audience: Event Sourcing / Transactional Outbox for cross-module HR integration.
-- Boundary: Events are written atomically within the HR transaction.
--           Accounting, Case, Notifications, Workflow consumers poll via background job.
--           No HR module directly writes accounting/case tables.

DO $$ BEGIN END $$;

CREATE TABLE IF NOT EXISTS public.hr_business_events (
    id bigserial PRIMARY KEY,
    event_id uuid NOT NULL DEFAULT gen_random_uuid(),
    firm_id integer NOT NULL,
    event_type text NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT NOW(),
    actor_user_id integer,
    correlation_id text,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    version integer NOT NULL DEFAULT 1,
    status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','processing','delivered','failed','dead_letter')),
    processed_at timestamptz,
    failure_message jsonb,
    next_retry_at timestamptz,
    retry_count integer NOT NULL DEFAULT 0,
    source_module text NOT NULL DEFAULT 'HR' CHECK (source_module IN ('HR','ACCOUNTING','WORKFLOW','NOTIFICATIONS')),
    idempotency_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_events_idempotency_firm
    ON public.hr_business_events (firm_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_hr_events_poll
    ON public.hr_business_events (firm_id, status, next_retry_at, created_at)
    WHERE status IN ('ready','failed');

CREATE INDEX IF NOT EXISTS idx_hr_events_firm_occurred
    ON public.hr_business_events (firm_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_hr_events_aggregate
    ON public.hr_business_events (firm_id, aggregate_type, aggregate_id, occurred_at DESC);

COMMENT ON TABLE public.hr_business_events IS
'Transactional Outbox for HR-domain Business Events. Written inside same DB TX as the HR mutation; background worker polls and delivers to integrations (accounting, cases, notifications, workflow). Consumers never back-write here; they read idempotently.';

COMMENT ON COLUMN public.hr_business_events.payload IS
'Event payload JSONB — PII/SENSITIVE DATA EXPLICITLY FORBIDDEN inline. Must never contain: NRIC/full IC/passport numbers, bank account numbers, salary figures/amounts, home address, home contact. Use aggregate_id cross-reference only. App-layer writeScrubbed() service drops forbidden keys before INSERT; violation rows fail DB-side audit triggers if/when added later.';


CREATE TABLE IF NOT EXISTS public.hr_event_subscriptions (
    id bigserial PRIMARY KEY,
    firm_id integer NOT NULL,
    subscriber text NOT NULL CHECK (subscriber IN ('HR_NOTIFICATIONS','HR_ACCOUNTING_INTEGRATION','HR_CASE_INTEGRATION','HR_WORKFLOW_INTEGRATION','HR_PARTNER_ALERTS')),
    event_type text NOT NULL,
    target_handler text NOT NULL,
    active boolean NOT NULL DEFAULT TRUE,
    priority integer NOT NULL DEFAULT 50,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_hr_event_subs_firm_sub_evt UNIQUE (firm_id, subscriber, event_type)
);

CREATE INDEX IF NOT EXISTS idx_hr_event_subs_active
    ON public.hr_event_subscriptions (firm_id, active, event_type, priority);


CREATE TABLE IF NOT EXISTS public.hr_event_delivery_attempts (
    id bigserial PRIMARY KEY,
    event_id bigint NOT NULL REFERENCES public.hr_business_events(id) ON DELETE CASCADE,
    subscriber text NOT NULL,
    attempted_at timestamptz NOT NULL DEFAULT NOW(),
    status text NOT NULL CHECK (status IN ('success','failed','skipped')),
    error_message jsonb,
    response_metadata jsonb,
    duration_ms integer
);

CREATE INDEX IF NOT EXISTS idx_hr_delivery_event
    ON public.hr_event_delivery_attempts (event_id, attempted_at DESC);

CREATE INDEX IF NOT EXISTS idx_hr_delivery_subscriber
    ON public.hr_event_delivery_attempts (subscriber, attempted_at DESC);

-- RLS policies (idempotent, following migration 0002 convention)
ALTER TABLE public.hr_business_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_business_events FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'hr_business_events' AND policyname = 'hr_business_events_tenant_isolation'
    ) THEN
        CREATE POLICY hr_business_events_tenant_isolation ON public.hr_business_events
        FOR ALL
        TO public
        USING (
            (current_setting('app.current_firm_id', true) IS NOT NULL
             AND firm_id = (current_setting('app.current_firm_id', true))::integer)
            OR
            (current_setting('app.is_founder', true) = 'true')
        )
        WITH CHECK (
            (current_setting('app.current_firm_id', true) IS NOT NULL
             AND firm_id = (current_setting('app.current_firm_id', true))::integer)
            OR
            (current_setting('app.is_founder', true) = 'true')
        );
    END IF;
END $$;

ALTER TABLE public.hr_event_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_event_subscriptions FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'hr_event_subscriptions' AND policyname = 'hr_event_subscriptions_tenant_isolation'
    ) THEN
        CREATE POLICY hr_event_subscriptions_tenant_isolation ON public.hr_event_subscriptions
        FOR ALL
        TO public
        USING (
            (current_setting('app.current_firm_id', true) IS NOT NULL
             AND firm_id = (current_setting('app.current_firm_id', true))::integer)
            OR
            (current_setting('app.is_founder', true) = 'true')
        )
        WITH CHECK (
            (current_setting('app.current_firm_id', true) IS NOT NULL
             AND firm_id = (current_setting('app.current_firm_id', true))::integer)
            OR
            (current_setting('app.is_founder', true) = 'true')
        );
    END IF;
END $$;

ALTER TABLE public.hr_event_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_event_delivery_attempts FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'hr_event_delivery_attempts' AND policyname = 'hr_event_delivery_attempts_tenant_isolation'
    ) THEN
        -- Inherits tenant isolation via join to event: use EXISTS subquery for user safety.
        CREATE POLICY hr_event_delivery_attempts_tenant_isolation ON public.hr_event_delivery_attempts
        FOR SELECT
        TO public
        USING (
            EXISTS (
                SELECT 1 FROM public.hr_business_events ev
                WHERE ev.id = event_id
                  AND (
                      (current_setting('app.current_firm_id', true) IS NOT NULL
                       AND ev.firm_id = (current_setting('app.current_firm_id', true))::integer)
                      OR (current_setting('app.is_founder', true) = 'true')
                  )
            )
        );
    END IF;
END $$;

-- Grants: app_user role (migration 0002) must be able to read/write these tables
GRANT SELECT, INSERT, UPDATE ON public.hr_business_events, public.hr_event_subscriptions, public.hr_event_delivery_attempts TO app_user;
GRANT USAGE, SELECT ON SEQUENCE public.hr_business_events_id_seq, public.hr_event_subscriptions_id_seq, public.hr_event_delivery_attempts_id_seq TO app_user;

-- Default per-firm subscriptions (every firm gets these event→handler mappings on first HR enablement).
-- Inserted idempotently.
-- PRIORITY CONVENTION (per firm per event type, lower integer = delivered first per B0127-03):
--   10 = HR_NOTIFICATIONS (fast, in-app/email alert — user sees it first)
--   15 = HR_NOTIFICATIONS (secondary notices: notice_started, approval_overdue)
--   20 = HR_CASE_INTEGRATION (case assignment / unassignment — case module fast path)
--   25 = HR_PARTNER_ALERTS (overdue escalation to partner)
--   30 = HR_WORKFLOW_INTEGRATION (workflow task creation — slower, creates human tasks)
--   40 = HR_ACCOUNTING_INTEGRATION (claim approved for payroll — mid-speed)
--   50 = HR_ACCOUNTING_INTEGRATION (claim final approved / approved for accounting — PV creation cost)
--   60 = HR_ACCOUNTING_INTEGRATION (payroll approved / payment completed — heavy batch cost)
INSERT INTO public.hr_event_subscriptions
    (firm_id, subscriber, event_type, target_handler, active, priority)
SELECT
    f.id,
    s.subscriber,
    s.event_type,
    s.target_handler,
    TRUE,
    s.priority
FROM public.firms f
CROSS JOIN (
    VALUES
        ('HR_NOTIFICATIONS',    'EMPLOYEE_CREATED',          'hr-notifications:employee-created',        10),
        ('HR_NOTIFICATIONS',    'LEAVE_SUBMITTED',           'hr-notifications:leave-submitted',         10),
        ('HR_NOTIFICATIONS',    'CLAIM_SUBMITTED',           'hr-notifications:claim-submitted',         10),
        ('HR_NOTIFICATIONS',    'PAYROLL_SUBMITTED',         'hr-notifications:payroll-submitted',       10),
        ('HR_NOTIFICATIONS',    'EMPLOYEE_NOTICE_STARTED',   'hr-notifications:notice-started',          15),
        ('HR_NOTIFICATIONS',    'HR_APPROVAL_OVERDUE',       'hr-notifications:approval-overdue',        15),
        ('HR_ACCOUNTING_INTEGRATION', 'CLAIM_FINAL_APPROVED',          'hr-accounting:claim-final-approved',           50),
        ('HR_ACCOUNTING_INTEGRATION', 'CLAIM_APPROVED_FOR_PAYROLL',    'hr-accounting:claim-approved-for-payroll',     40),
        ('HR_ACCOUNTING_INTEGRATION', 'CLAIM_APPROVED_FOR_ACCOUNTING', 'hr-accounting:claim-approved-for-accounting',  50),
        ('HR_ACCOUNTING_INTEGRATION', 'PAYROLL_APPROVED',              'hr-accounting:payroll-approved',               60),
        ('HR_ACCOUNTING_INTEGRATION', 'PAYROLL_PAYMENT_COMPLETED',     'hr-accounting:payroll-payment-completed',      60),
        ('HR_WORKFLOW_INTEGRATION',   'EMPLOYEE_TERMINATED',           'hr-workflow:employee-terminated',              30),
        ('HR_WORKFLOW_INTEGRATION',   'EMPLOYEE_OFFBOARDING_STARTED',  'hr-workflow:offboarding-started',              30),
        ('HR_CASE_INTEGRATION',       'EMPLOYEE_TERMINATED',           'hr-cases:case-unassignment-handoff',           20),
        ('HR_CASE_INTEGRATION',       'EMPLOYEE_REPORTING_MANAGER_CHANGED', 'hr-cases:update-case-assignments',        20),
        ('HR_PARTNER_ALERTS',         'HR_APPROVAL_OVERDUE',           'hr-partner-alerts:approval-overdue',           25)
) AS s(subscriber, event_type, target_handler, priority)
WHERE NOT EXISTS (
    SELECT 1
    FROM public.hr_event_subscriptions existing
    WHERE existing.firm_id = f.id
      AND existing.subscriber = s.subscriber
      AND existing.event_type = s.event_type
);
