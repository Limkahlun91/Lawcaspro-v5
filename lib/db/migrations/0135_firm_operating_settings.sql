-- Migration 0135: firm_operating_settings — Neutral Shared Table (Decision A2)
-- Step 2/3 cutover: legacy mirrored columns in accounting_settings retained for backward reads;
-- will be DROPPED in FUTURE additive migration (NOT THIS FILE) once full read path cutover is signed off.
-- Safe: this file never DROPs any accounting_settings column. (B0135-03 explicit sign-off block)
-- Scope: This is the SINGLE source of truth for operating configuration
-- shared between HR and Accounting modules.
--
-- Rules (per Corrective Review Decision A2):
--   * HR MUST read only firm_operating_settings for timezone / working days /
--     working hours / public holiday region / holiday calendar / weekend rules.
--   * HR MUST NOT read accounting_settings columns that overlap with this table.
--   * Accounting retains its accounting_settings table (including duplicated
--     timezone/weekend cols) during the cutover window. New values are written
--     to firm_operating_settings first; legacy reads use
--     COALESCE(new.shared_col, legacy.accounting_col) until cutover complete.
--   * No bidirectional triggers; cutover is application-driven.
--
-- Rollback:
--   * Application code MUST stop reading firm_operating_settings BEFORE any
--     DROP. Reverse order: (1) remove reads, (2) remove writes,
--     (3) DROP POLICY, (4) ALTER TABLE ... DISABLE RLS, (5) DROP TABLE.
--   * Table is additive. Dropping it destroys only firm-level overrides that
--     were backfilled/edited after this migration; legacy accounting_settings
--     values remain intact.
--
-- THIS MIGRATION IS A LOCAL DRAFT. DO NOT apply to Supabase or any environment
-- outside a local dev clone until the corrective review of 0127-0134 + 0135
-- is 100% signed off.

CREATE TABLE IF NOT EXISTS firm_operating_settings (
  firm_id integer PRIMARY KEY REFERENCES firms(id) ON DELETE CASCADE,
  timezone text NOT NULL DEFAULT 'Asia/Kuala_Lumpur',
  working_days jsonb NOT NULL DEFAULT '["Monday","Tuesday","Wednesday","Thursday","Friday"]'::jsonb,
  working_hours jsonb NOT NULL DEFAULT '{"start":"09:00","end":"18:00","break_start":"13:00","break_end":"14:00"}'::jsonb,
  public_holiday_region text NOT NULL DEFAULT 'Malaysia-Peninsular',
  holiday_calendar jsonb NOT NULL DEFAULT '[]'::jsonb,
  weekend_rules jsonb NOT NULL DEFAULT '{"saturday_off":true,"sunday_off":true,"friday_off":false}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id integer NULL REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id integer NULL REFERENCES users(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_firm_operating_settings_timezone
  ON firm_operating_settings (timezone);
CREATE INDEX IF NOT EXISTS idx_firm_operating_settings_holiday_region
  ON firm_operating_settings (public_holiday_region);

ALTER TABLE firm_operating_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE firm_operating_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS firm_operating_settings_tenant_isolation ON firm_operating_settings;
CREATE POLICY firm_operating_settings_tenant_isolation ON firm_operating_settings
  FOR ALL TO PUBLIC
  USING (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  )
  WITH CHECK (
    current_setting('app.is_founder', true) = 'true'
    OR firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
  );

COMMENT ON TABLE firm_operating_settings IS 'Neutral shared operating settings (Decision A2). Single source of truth for timezone, working days/hours, public holiday region, holiday calendar, weekend rules. Shared by HR and Accounting modules. HR read path MUST NOT reach accounting_settings for these columns.';
COMMENT ON COLUMN firm_operating_settings.timezone IS 'IANA timezone used for all date math (attendance punch rounding, pay period boundaries, approval SLA deadlines). Default Asia/Kuala_Lumpur for Malaysia firms.';
COMMENT ON COLUMN firm_operating_settings.working_days IS 'Ordered array of weekday names treated as standard working days. Applications MUST reconcile with weekend_rules if the two ever diverge; weekend_rules acts as the weekend override when a day is present in working_days but weekend_rules says off.';
COMMENT ON COLUMN firm_operating_settings.working_hours IS 'Standard office hours window with break. Shape: {start, end, break_start, break_end} all HH:MM 24h in the firm timezone. Default working_hours.break_start=13:00 break_end=14:00 M2a ratified 2026-08-07 Malaysia standard lunch hour; firms may override via HR settings. (B0135-04 sign-off)';
COMMENT ON COLUMN firm_operating_settings.public_holiday_region IS 'Region code used to resolve public holiday lookups. Suggested values: Malaysia-Peninsular, Malaysia-Sabah, Malaysia-Sarawak, Singapore, Other.';
COMMENT ON COLUMN firm_operating_settings.holiday_calendar IS 'Firm-specific additional holidays beyond public region calendar. Array of {date: YYYY-MM-DD, name, type}. Use for firm closed days, Chinese New Year extras, etc.';
COMMENT ON COLUMN firm_operating_settings.weekend_rules IS 'Fixed weekend configuration. Shape: {saturday_off, sunday_off, friday_off}. All boolean. Future-proof for Friday-Saturday weekend regions.';
COMMENT ON COLUMN firm_operating_settings.version IS 'Optimistic-lock version; application service MUST increment on every update and reject stale writes (HTTP 409 HR_RECORD_CONFLICT pattern).';

-- Idempotent backfill for existing firms.
--   * Prefers values already present in accounting_settings.
--   * Firms with no accounting_settings row get Malaysia defaults from column DEFAULTs.
--   * ON CONFLICT (firm_id) DO NOTHING ensures manual edits after first apply
--     are NEVER overwritten on re-runs.
INSERT INTO firm_operating_settings (
  firm_id,
  timezone,
  working_days,
  working_hours,
  public_holiday_region,
  holiday_calendar,
  weekend_rules,
  created_at,
  updated_at,
  version
)
SELECT
  f.id AS firm_id,
  COALESCE(acs.timezone, 'Asia/Kuala_Lumpur') AS timezone,
  CASE
    WHEN acs.exclude_saturday = true AND acs.exclude_sunday = true
      THEN '["Monday","Tuesday","Wednesday","Thursday","Friday"]'::jsonb
    WHEN acs.exclude_sunday = true AND (acs.exclude_saturday IS NULL OR acs.exclude_saturday = false)
      THEN '["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"]'::jsonb
    ELSE '["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]'::jsonb
  END AS working_days,
  jsonb_build_object(
    'start', COALESCE(acs.working_hours_start, '09:00'),
    'end',   COALESCE(acs.working_hours_end,   '18:00'),
    'break_start', '13:00',
    'break_end',   '14:00'
  ) AS working_hours,
  'Malaysia-Peninsular' AS public_holiday_region,
  COALESCE(acs.firm_holidays, '[]'::jsonb) AS holiday_calendar,
  jsonb_build_object(
    'saturday_off', COALESCE(acs.exclude_saturday, true),
    'sunday_off',   COALESCE(acs.exclude_sunday,   true),
    'friday_off',   false
  ) AS weekend_rules,
  now() AS created_at,
  now() AS updated_at,
  1 AS version
FROM firms f
LEFT JOIN accounting_settings acs ON acs.firm_id = f.id
ON CONFLICT (firm_id) DO NOTHING;

-- Forward migration ends here.
--
-- ###########################################################################
-- CUTOVER PROCEDURE (HR + Accounting, documented for future migration apply)
-- ###########################################################################
--
-- Step 1 (this migration, 0135): Create table + RLS + backfill. Application
--         still writes both legacy accounting_settings AND new
--         firm_operating_settings (double-write). Reads still prefer legacy.
-- Step 2 (future application release): HR domain read service cutover — HR
--         stops reading accounting_settings entirely and reads only
--         firm_operating_settings. Service layer ensures HR routes never
--         touch accounting_settings. Automated tests MUST assert no import
--         of accounting_settings paths from HR modules.
-- Step 3 (future application release): Accounting read path cutover —
--         Accounting read service reads new table first with
--         COALESCE(new.col, legacy.col) fallback. After N days verified,
--         fallback removed; reads only from new.
-- Step 4 (future migration): DROP duplicated cols from accounting_settings
--         (timezone, working_hours_start, working_hours_end, exclude_saturday,
--         exclude_sunday, firm_holidays). Keep role_ids / approval_rules /
--         payment_voucher_sla / clerk_action_sla / payment_proof_required
--         because those are Accounting-only and never shared.
-- Step 5 (final): Confirm no Accounting code references dropped cols.
--
-- ###########################################################################
-- ROLLBACK PROCEDURE
-- ###########################################################################
-- To roll back this migration WITHOUT losing firm overrides written after
-- backfill, first run the application-level reverse copy:
--
--   UPDATE accounting_settings acs
--   SET
--     timezone             = fos.timezone,
--     working_hours_start  = fos.working_hours->>'start',
--     working_hours_end    = fos.working_hours->>'end',
--     exclude_saturday     = COALESCE((fos.weekend_rules->>'saturday_off')::boolean, true),
--     exclude_sunday       = COALESCE((fos.weekend_rules->>'sunday_off')::boolean,   true),
--     firm_holidays        = fos.holiday_calendar,
--     updated_at           = now()
--   FROM firm_operating_settings fos
--   WHERE fos.firm_id = acs.firm_id;
--
-- After reverse copy confirmed, remove RLS/policy and drop the table:
--   DROP POLICY IF EXISTS firm_operating_settings_tenant_isolation ON firm_operating_settings;
--   ALTER TABLE firm_operating_settings DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE firm_operating_settings NO FORCE ROW LEVEL SECURITY;
--   DROP INDEX IF EXISTS idx_firm_operating_settings_timezone;
--   DROP INDEX IF EXISTS idx_firm_operating_settings_holiday_region;
--   DROP TABLE IF EXISTS firm_operating_settings;
