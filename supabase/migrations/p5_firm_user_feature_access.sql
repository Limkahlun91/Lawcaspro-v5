-- ============================================================
-- Part 2 §3 — Per-user feature access overrides (DATA-ONLY ADD)
-- Additive only, no DROP/TRUNCATE, preserves legacy data.
--
-- Enables Partner to toggle exact per-user features while
-- keeping Firm Entitlement (global switch) as STEP-1 DENY.
-- ============================================================

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

-- ------------------------------------------------------------
-- Uniqueness: exact one (firm,user,feature) row.
-- ------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS
    uq_firm_user_feature_access_firm_user_feature
    ON public.firm_user_feature_access (firm_id, user_id, feature_key);

-- ------------------------------------------------------------
-- Lookup index: get all features for (firm, user) → sidebar + profile UI
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS
    idx_firm_user_feature_access_firm_user
    ON public.firm_user_feature_access (firm_id, user_id);

CREATE INDEX IF NOT EXISTS
    idx_firm_user_feature_access_feature
    ON public.firm_user_feature_access (firm_id, feature_key);

-- ------------------------------------------------------------
-- FKs (canonical confirmed-safe tables):
--   firms.id       → serial(bigint), users.id → serial(bigint)
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- Auto-stamp updated_at
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_firm_user_feature_access_touch ON public.firm_user_feature_access;

CREATE OR REPLACE FUNCTION public._fufa_touch()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_firm_user_feature_access_touch
BEFORE UPDATE ON public.firm_user_feature_access
FOR EACH ROW EXECUTE FUNCTION public._fufa_touch();
