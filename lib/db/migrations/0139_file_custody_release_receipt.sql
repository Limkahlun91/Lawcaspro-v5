-- 0139: File Custody Tracking — Release / Receipt / Acknowledge / Return (custody model)
-- Additive only. firm_id tenant isolation via RLS + FORCE RLS. Destructive=0.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_file_custody_items_phys_digital') THEN
    ALTER TABLE file_custody_items
      ADD CONSTRAINT chk_file_custody_items_phys_digital
      CHECK (physical_or_digital IN ('physical','digital','hybrid'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_file_custody_items_lifecycle') THEN
    ALTER TABLE file_custody_items
      ADD CONSTRAINT chk_file_custody_items_lifecycle
      CHECK (lifecycle_status IN ('in_office','out_on_loan','out_with_counsel','out_with_client','out_external','returned','archived','lost'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_file_custody_items_category') THEN
    ALTER TABLE file_custody_items
      ADD CONSTRAINT chk_file_custody_items_category
      CHECK (category IN ('court_document','spa','loan_agreement','land_title','caveat','identity_document','invoice','payment_voucher','quotation','firm_letter','correspondence','bundle','file_will','other'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_file_custody_mv_kind') THEN
    ALTER TABLE file_custody_movements
      ADD CONSTRAINT chk_file_custody_mv_kind
      CHECK (movement_kind IN ('release','transfer','acknowledge','return','overdue_auto_flag','archived','reinstated','lost_flag','found'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_file_custody_mv_severity') THEN
    ALTER TABLE file_custody_movements
      ADD CONSTRAINT chk_file_custody_mv_severity
      CHECK (severity IN ('info','normal','high','urgent','critical'));
  END IF;
END $$;

ALTER TABLE file_custody_items ADD COLUMN IF NOT EXISTS status_set_at timestamptz;
ALTER TABLE file_custody_movements ADD COLUMN IF NOT EXISTS escalated_at timestamptz;
ALTER TABLE file_custody_movements ADD COLUMN IF NOT EXISTS escalated_to_partner boolean;
ALTER TABLE file_custody_movements ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_file_custody_items_status_set_at
  ON file_custody_items (firm_id, status_set_at DESC)
  WHERE lifecycle_status IN ('out_on_loan','out_with_counsel','out_with_client','out_external');

CREATE INDEX IF NOT EXISTS idx_file_custody_mv_escalated
  ON file_custody_movements (firm_id, escalated_at DESC NULLS LAST)
  WHERE escalated_to_partner = TRUE;

ALTER TABLE file_custody_items ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN ALTER TABLE file_custody_items FORCE ROW LEVEL SECURITY; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DROP POLICY IF EXISTS file_custody_items_tenant ON file_custody_items;
CREATE POLICY file_custody_items_tenant ON file_custody_items
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (firm_id = (current_setting('app.current_firm_id', true)::int))
  WITH CHECK (firm_id = (current_setting('app.current_firm_id', true)::int));

ALTER TABLE file_custody_movements ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN ALTER TABLE file_custody_movements FORCE ROW LEVEL SECURITY; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DROP POLICY IF EXISTS file_custody_movements_tenant ON file_custody_movements;
CREATE POLICY file_custody_movements_tenant ON file_custody_movements
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (firm_id = (current_setting('app.current_firm_id', true)::int))
  WITH CHECK (firm_id = (current_setting('app.current_firm_id', true)::int));

CREATE OR REPLACE FUNCTION file_custody_items_set_updated_at()
RETURNS trigger AS $fc$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fc$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS file_custody_items_set_updated_at ON file_custody_items;
CREATE TRIGGER file_custody_items_set_updated_at
  BEFORE UPDATE ON file_custody_items
  FOR EACH ROW EXECUTE FUNCTION file_custody_items_set_updated_at();

CREATE OR REPLACE FUNCTION file_custody_movements_set_updated_at()
RETURNS trigger AS $fcm$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fcm$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS file_custody_movements_set_updated_at ON file_custody_movements;
CREATE TRIGGER file_custody_movements_set_updated_at
  BEFORE UPDATE ON file_custody_movements
  FOR EACH ROW EXECUTE FUNCTION file_custody_movements_set_updated_at();
