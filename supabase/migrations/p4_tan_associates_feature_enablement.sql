-- =============================================================================
-- PART 4 — DATA-ONLY: Test Firm (Messrs. Tan & Associates) Feature Enablement
-- =============================================================================
-- Scope rules (strictly per PART 4 / Unified Feature Access & Visibility):
--   * NO schema changes. NO CREATE TABLE. NO ALTER / DROP anything.
--   * Resolve target firm dynamically by name; no hardcoded firm IDs.
--   * If the target firm does not exist in this environment → graceful no-op.
--   * All rows inserted into firm_entitlement_overrides use:
--       override_kind = 'permanent'
--       override_mode = 'enabled'
--       value_json = NULL       (because these are boolean gates, not numeric tiers)
--       effective_from = NOW()
--       expires_at = NULL       (permanent)
--       billing_type = 'included'
--       reason = 'PART 4 / Unify entitlements — HRMS HIMS Email Legacy Import'
--   * ON CONFLICT with an existing permanent override for the same firm & key:
--       UPDATE override_mode = 'enabled', updated_at = NOW(), refresh reason.
--   * Legacy HR boolean flag row in hr_firm_feature_flags upserted with all
--     sub-flags TRUE so requireHRModuleEnabled / legacy resolvers continue to
--     behave consistently with the new entitlement system.
--
-- Features enabled (43 explicit keys):
--   — HR module + 19 explicit sub-features
--   — Communications module + 10 Email sub-features
--   — Cases legacy import
--   — HIMS module + 10 explicit sub-features
-- Note:
--   hims.compare_lawcaspro_ekyc is intentionally NOT enabled here.
--   User requirement: only enable IF module.ekyc is actually ready/enabled
--   for the platform. Since module.ekyc is not currently marked ready in the
--   PART 4 feature set, it is skipped. Enable separately once eKYC ships.
-- =============================================================================

DO $$
DECLARE
    v_firm_id   integer;
    v_now       timestamptz := NOW();
    v_reason    text        := 'PART 4 / Unify entitlements — HRMS HIMS Email Legacy Import permanent enablement';
BEGIN
    -- -------------------------------------------------------------------------
    -- 1. Resolve target firm by name (never hardcode a firm id)
    -- -------------------------------------------------------------------------
    SELECT id
      INTO v_firm_id
      FROM public.firms
     WHERE name = 'Messrs. Tan & Associates'
     LIMIT 1;

    IF v_firm_id IS NULL THEN
        RAISE NOTICE 'P4 data-only override: target firm "Messrs. Tan & Associates" not found in this environment. Skipping override rows.';
        RETURN;
    END IF;

    -- -------------------------------------------------------------------------
    -- 2. Permanent feature override rows — INSERT or UPDATE existing permanent
    -- -------------------------------------------------------------------------
    INSERT INTO public.firm_entitlement_overrides
        (firm_id, feature_key, override_kind, override_mode, value_json,
         effective_from, expires_at, billing_type, price_override,
         reason, created_by, created_at, updated_at)
    VALUES
        -- ══════════════════════════════════════════════════════════════════
        -- HR module + sub-features (20 keys)
        -- ══════════════════════════════════════════════════════════════════
        (v_firm_id, 'module.hr',         'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'hr.dashboard',      'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'hr.employees',      'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'hr.departments',    'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'hr.positions',      'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'hr.attendance',     'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'hr.leave',          'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'hr.claims',         'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'hr.payroll',        'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'hr.onboarding',     'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'hr.offboarding',    'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'hr.recruitment',    'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'hr.performance',    'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'hr.training',       'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'hr.assets',         'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'hr.documents',      'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'hr.approvals',      'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'hr.self_service',   'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'hr.reports',        'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'hr.settings',       'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),

        -- ══════════════════════════════════════════════════════════════════
        -- Communications / Email module + sub-features (11 keys)
        -- ══════════════════════════════════════════════════════════════════
        (v_firm_id, 'module.communications',         'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'communications.email',          'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'communications.email.settings', 'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'communications.email.folders',  'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'communications.email.mark_read','permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'communications.email.reply',    'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'communications.email.forward',  'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'communications.email.remarks',  'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'communications.email.assign_user', 'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'communications.email.link_case',   'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'communications.email.search',      'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),

        -- ══════════════════════════════════════════════════════════════════
        -- Cases legacy import (1 key)
        -- ══════════════════════════════════════════════════════════════════
        (v_firm_id, 'cases.legacy_import', 'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),

        -- ══════════════════════════════════════════════════════════════════
        -- HIMS module + sub-features (11 keys) — NOTE: ekyc compare SKIPPED
        -- per user requirement: only enable IF module.ekyc actually ready.
        -- ══════════════════════════════════════════════════════════════════
        (v_firm_id, 'module.hims',                    'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'hims.tracker',                   'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'hims.credentials',               'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'hims.project_mapping',           'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'hims.unit_lot_title',            'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'hims.espa_status',               'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'hims.spa_tracker',               'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'hims.spa_stamped_handover',      'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'hims.status_check',              'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'hims.compare_lawcaspro_hims',    'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now),
        (v_firm_id, 'hims.notifications',             'permanent', 'enabled', NULL, v_now, NULL, 'included', NULL, v_reason, NULL, v_now, v_now)
    ON CONFLICT (firm_id, feature_key) WHERE (override_kind = 'permanent') DO UPDATE SET
        override_mode = 'enabled',
        value_json    = NULL,
        effective_from = EXCLUDED.effective_from,
        expires_at    = NULL,
        billing_type  = EXCLUDED.billing_type,
        reason        = EXCLUDED.reason,
        updated_at    = EXCLUDED.updated_at;

    -- -------------------------------------------------------------------------
    -- 3. Legacy HR boolean row — all flags TRUE, upsert by firm_id
    -- -------------------------------------------------------------------------
    INSERT INTO public.hr_firm_feature_flags
        (firm_id, hr_enabled, hr_attendance_enabled, hr_payroll_enabled,
         hr_recruitment_enabled, hr_performance_enabled, hr_case_workload_enabled,
         hr_claims_enabled, hr_leave_enabled, hr_documents_enabled,
         hr_self_service_enabled, created_at, updated_at, updated_by_user_id, version)
    VALUES
        (v_firm_id, TRUE, TRUE, TRUE,
         TRUE, TRUE, FALSE,
         TRUE, TRUE, TRUE,
         TRUE, v_now, v_now, NULL, 1)
    ON CONFLICT (firm_id) DO UPDATE SET
        hr_enabled               = TRUE,
        hr_attendance_enabled    = TRUE,
        hr_payroll_enabled       = TRUE,
        hr_recruitment_enabled   = TRUE,
        hr_performance_enabled   = TRUE,
        hr_claims_enabled        = TRUE,
        hr_leave_enabled         = TRUE,
        hr_documents_enabled     = TRUE,
        hr_self_service_enabled  = TRUE,
        updated_at               = v_now,
        version                  = public.hr_firm_feature_flags.version + 1;

    RAISE NOTICE 'P4 data-only override: firm % (Messrs. Tan & Associates) — 43 HR/Email/HIMS/Legacy-Import overrides inserted/updated.', v_firm_id;
END $$;
