-- ============================================================================
-- VSR PART 2 P0: Document Generation Logging Additive Migration
-- Scope: document_generation_logs only
-- Operations: 100% ADDITIVE / NON-DESTRUCTIVE / IDEMPOTENT
--   1. Drop old action_type CHECK constraint (IF EXISTS)
--   2. Add new expanded action_type CHECK (legacy + §10 10 new events)
--   3. Add missing columns IF NOT EXISTS for new logging writer (Tier 1)
--   4. Add helpful indexes IF NOT EXISTS
-- No data loss, no HRMS migrations, no destructive operations
-- ============================================================================

-- (1) Expand action_type CHECK constraint to include §10 10 new event types
-- Drop existing check if present (Postgres 9.2+ supports IF EXISTS on this)
ALTER TABLE IF EXISTS public.document_generation_logs
    DROP CONSTRAINT IF EXISTS document_generation_logs_action_type_check;

-- Re-create CHECK with expanded enum (legacy compat + §10 contract)
ALTER TABLE public.document_generation_logs
    ADD CONSTRAINT document_generation_logs_action_type_check
    CHECK (action_type = ANY (ARRAY[
        -- legacy compat values (still used by older code paths)
        'download_zip'::text,
        'system_print'::text,
        'download'::text,
        'print'::text,
        -- §10 Document generation lifecycle (STARTED → SUCCEEDED/PARTIAL/FAILED)
        'DOCUMENT_GENERATION_STARTED'::text,
        'DOCUMENT_GENERATION_SUCCEEDED'::text,
        'DOCUMENT_GENERATION_FAILED'::text,
        'DOCUMENT_GENERATION_PARTIAL'::text,
        -- §10 ZIP output lifecycle
        'DOCUMENT_ZIP_CREATED'::text,
        'DOCUMENT_ZIP_DOWNLOAD_SUCCEEDED'::text,
        'DOCUMENT_ZIP_DOWNLOAD_FAILED'::text,
        -- §10 System print (merged PDF) lifecycle
        'DOCUMENT_SYSTEM_PRINT_PREPARED'::text,
        'DOCUMENT_SYSTEM_PRINT_FAILED'::text
    ]));

-- (2) Add missing columns used by writeDocumentGenerationLog Tier 1
--     All IF NOT EXISTS — will not fail if already present from a prior state

ALTER TABLE IF EXISTS public.document_generation_logs
    ADD COLUMN IF NOT EXISTS job_id uuid;

ALTER TABLE IF EXISTS public.document_generation_logs
    ADD COLUMN IF NOT EXISTS error_code text;

ALTER TABLE IF EXISTS public.document_generation_logs
    ADD COLUMN IF NOT EXISTS error_message text;

ALTER TABLE IF EXISTS public.document_generation_logs
    ADD COLUMN IF NOT EXISTS request_id text;

-- (3) Add helpful indexes for unified logs / correlation queries (additive)
CREATE INDEX IF NOT EXISTS idx_document_generation_logs_job_id
    ON public.document_generation_logs (job_id);

CREATE INDEX IF NOT EXISTS idx_document_generation_logs_created_at
    ON public.document_generation_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_document_generation_logs_firm_id_created_at
    ON public.document_generation_logs (firm_id, created_at DESC);
