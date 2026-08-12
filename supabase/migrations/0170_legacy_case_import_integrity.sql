-- Migration 0170: Legacy Case Import Integrity (FK constraints)
-- Additive-only, defensive DO blocks. All constraints use IF NOT EXISTS.
-- ON DELETE semantics:
--   rows.batch_id     → batches.id              CASCADE  (delete rows with batch)
--   rows.created_case_id → cases.id             SET NULL (orphan safe on case delete)
--   rows.duplicate_case_id → cases.id           SET NULL
--   batches.mapping_template_id → templates.id  SET NULL

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'legacy_case_import_rows_batch_id_fkey'
      AND conrelid = 'public.legacy_case_import_rows'::regclass
  ) THEN
    ALTER TABLE public.legacy_case_import_rows
      ADD CONSTRAINT legacy_case_import_rows_batch_id_fkey
      FOREIGN KEY (batch_id)
      REFERENCES public.legacy_case_import_batches (id)
      ON DELETE CASCADE;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'legacy_case_import_rows_created_case_id_fkey'
      AND conrelid = 'public.legacy_case_import_rows'::regclass
  ) THEN
    ALTER TABLE public.legacy_case_import_rows
      ADD CONSTRAINT legacy_case_import_rows_created_case_id_fkey
      FOREIGN KEY (created_case_id)
      REFERENCES public.cases (id)
      ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'legacy_case_import_rows_duplicate_case_id_fkey'
      AND conrelid = 'public.legacy_case_import_rows'::regclass
  ) THEN
    ALTER TABLE public.legacy_case_import_rows
      ADD CONSTRAINT legacy_case_import_rows_duplicate_case_id_fkey
      FOREIGN KEY (duplicate_case_id)
      REFERENCES public.cases (id)
      ON DELETE SET NULL;
  END IF;
END $do$;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'legacy_case_import_batches_mapping_template_id_fkey'
      AND conrelid = 'public.legacy_case_import_batches'::regclass
  ) THEN
    ALTER TABLE public.legacy_case_import_batches
      ADD CONSTRAINT legacy_case_import_batches_mapping_template_id_fkey
      FOREIGN KEY (mapping_template_id)
      REFERENCES public.legacy_case_import_mapping_templates (id)
      ON DELETE SET NULL;
  END IF;
END $do$;
