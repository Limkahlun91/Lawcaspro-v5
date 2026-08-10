-- ============================================================
-- Migration 0147: Unified Supporting Documents Table
-- Scope: Case-supporting + Project-supporting documents
-- Tenant isolation: firm_id + RLS policies
-- Backward compatible: additive only, no data drops
-- ============================================================

-- 1. Create the table ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS supporting_documents (
    id                      SERIAL PRIMARY KEY,
    firm_id                 INTEGER NOT NULL,

    scope                   TEXT NOT NULL CHECK (scope IN ('case', 'project')),

    case_id                 INTEGER,
    developer_id            INTEGER,
    project_id              INTEGER,
    phase                   TEXT,

    document_type           TEXT NOT NULL DEFAULT 'other',
    document_name           TEXT NOT NULL,
    original_filename       TEXT,

    object_path             TEXT NOT NULL,
    file_name               TEXT NOT NULL,
    mime_type               TEXT,
    file_size               INTEGER,

    version_label           TEXT,
    version_no              INTEGER NOT NULL DEFAULT 1,

    status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'archived')),

    uploaded_by             INTEGER,
    uploaded_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    remarks                 TEXT,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    deleted_at              TIMESTAMPTZ,
    deleted_by              INTEGER,

    -- Scope integrity checks
    CONSTRAINT supporting_docs_scope_case_check CHECK (
        CASE
            WHEN scope = 'case' THEN case_id IS NOT NULL
            ELSE case_id IS NULL
        END
    ),
    CONSTRAINT supporting_docs_scope_project_check CHECK (
        CASE
            WHEN scope = 'project' THEN (project_id IS NOT NULL OR developer_id IS NOT NULL)
            ELSE TRUE
        END
    )
);

-- 2. Indexes for common access patterns ---------------------------------------
CREATE INDEX IF NOT EXISTS idx_supporting_docs_firm
    ON supporting_documents (firm_id);

CREATE INDEX IF NOT EXISTS idx_supporting_docs_firm_scope
    ON supporting_documents (firm_id, scope);

CREATE INDEX IF NOT EXISTS idx_supporting_docs_firm_case
    ON supporting_documents (firm_id, case_id)
    WHERE case_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_supporting_docs_firm_project
    ON supporting_documents (firm_id, project_id)
    WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_supporting_docs_firm_developer
    ON supporting_documents (firm_id, developer_id)
    WHERE developer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_supporting_docs_firm_status
    ON supporting_documents (firm_id, status);

CREATE INDEX IF NOT EXISTS idx_supporting_docs_firm_project_phase
    ON supporting_documents (firm_id, project_id, phase)
    WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_supporting_docs_uploaded_at
    ON supporting_documents (firm_id, uploaded_at DESC);

CREATE INDEX IF NOT EXISTS idx_supporting_docs_scope_status_active
    ON supporting_documents (firm_id, scope, status)
    WHERE status = 'active' AND deleted_at IS NULL;

-- 3. Foreign Keys --------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_supporting_docs_firm'
    ) THEN
        ALTER TABLE supporting_documents
            ADD CONSTRAINT fk_supporting_docs_firm
            FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_supporting_docs_case'
    ) THEN
        ALTER TABLE supporting_documents
            ADD CONSTRAINT fk_supporting_docs_case
            FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE SET NULL;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_supporting_docs_project'
    ) THEN
        ALTER TABLE supporting_documents
            ADD CONSTRAINT fk_supporting_docs_project
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_supporting_docs_developer'
    ) THEN
        ALTER TABLE supporting_documents
            ADD CONSTRAINT fk_supporting_docs_developer
            FOREIGN KEY (developer_id) REFERENCES developers(id) ON DELETE SET NULL;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_supporting_docs_uploaded_by'
    ) THEN
        ALTER TABLE supporting_documents
            ADD CONSTRAINT fk_supporting_docs_uploaded_by
            FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL;
    END IF;
END $$;

-- 4. Row-Level Security (RLS) ------------------------------------------------
ALTER TABLE supporting_documents ENABLE ROW LEVEL SECURITY;

ALTER TABLE supporting_documents FORCE ROW LEVEL SECURITY;

-- Drop existing policies idempotently
DROP POLICY IF EXISTS supporting_docs_firm_isolation_select ON supporting_documents;
DROP POLICY IF EXISTS supporting_docs_firm_isolation_insert ON supporting_documents;
DROP POLICY IF EXISTS supporting_docs_firm_isolation_update ON supporting_documents;
DROP POLICY IF EXISTS supporting_docs_firm_isolation_delete ON supporting_documents;

-- 4a. SELECT: Users can only see documents belonging to their own firm, non-deleted
CREATE POLICY supporting_docs_firm_isolation_select ON supporting_documents
    FOR SELECT
    TO PUBLIC
    USING (
        firm_id = current_setting('app.current_firm_id', true)::INTEGER
        AND deleted_at IS NULL
    );

-- 4b. INSERT: Users can only insert documents for their own firm
CREATE POLICY supporting_docs_firm_isolation_insert ON supporting_documents
    FOR INSERT
    TO PUBLIC
    WITH CHECK (
        firm_id = current_setting('app.current_firm_id', true)::INTEGER
    );

-- 4c. UPDATE: Users can only update documents for their own firm
CREATE POLICY supporting_docs_firm_isolation_update ON supporting_documents
    FOR UPDATE
    TO PUBLIC
    USING (
        firm_id = current_setting('app.current_firm_id', true)::INTEGER
        AND deleted_at IS NULL
    )
    WITH CHECK (
        firm_id = current_setting('app.current_firm_id', true)::INTEGER
    );

-- 4d. DELETE: Soft-delete pattern (set deleted_at); hard delete allowed for own firm only
CREATE POLICY supporting_docs_firm_isolation_delete ON supporting_documents
    FOR DELETE
    TO PUBLIC
    USING (
        firm_id = current_setting('app.current_firm_id', true)::INTEGER
    );

-- 5. Grant to app user ---------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON supporting_documents TO authenticator;
    END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON supporting_documents TO app_user;
    END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
    GRANT USAGE, SELECT ON SEQUENCE supporting_documents_id_seq TO authenticator, app_user;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- 6. Trigger for updated_at ---------------------------------------------------
DROP TRIGGER IF EXISTS supporting_documents_updated_at ON supporting_documents;

CREATE OR REPLACE FUNCTION set_supporting_docs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER supporting_documents_updated_at
    BEFORE UPDATE ON supporting_documents
    FOR EACH ROW
    EXECUTE FUNCTION set_supporting_docs_updated_at();

-- 7. Comment for documentation ------------------------------------------------
COMMENT ON TABLE supporting_documents IS 'Unified uploaded supporting documents. Scope ''case'' = case-specific; scope ''project'' = reusable developer/project/phase master documents.';
COMMENT ON COLUMN supporting_documents.scope IS 'case or project — determines whether case_id vs (developer_id, project_id, phase) carries the ownership link';
COMMENT ON COLUMN supporting_documents.status IS 'active | superseded | archived — soft status; deleted_at is the hard soft-delete marker';
