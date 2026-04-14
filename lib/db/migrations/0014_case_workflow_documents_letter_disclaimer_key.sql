-- Rename workflow document milestone_key from legacy `letter_disclaimer_received_on`
-- to the correct `letter_disclaimer_dated` used in case key dates UI.
--
-- Safe and repeatable:
-- - Only touches non-deleted rows.
-- - Avoids unique conflicts when a `letter_disclaimer_dated` row already exists.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'case_workflow_documents'
  ) THEN
    UPDATE public.case_workflow_documents d
    SET
      milestone_key = 'letter_disclaimer_dated',
      label = 'Letter Disclaimer Dated',
      updated_at = now()
    WHERE
      d.deleted_at IS NULL
      AND d.milestone_key = 'letter_disclaimer_received_on'
      AND NOT EXISTS (
        SELECT 1
        FROM public.case_workflow_documents x
        WHERE
          x.deleted_at IS NULL
          AND x.firm_id = d.firm_id
          AND x.case_id = d.case_id
          AND x.milestone_key = 'letter_disclaimer_dated'
      );

    UPDATE public.case_workflow_documents d
    SET
      deleted_at = now(),
      updated_at = now()
    WHERE
      d.deleted_at IS NULL
      AND d.milestone_key = 'letter_disclaimer_received_on'
      AND EXISTS (
        SELECT 1
        FROM public.case_workflow_documents x
        WHERE
          x.deleted_at IS NULL
          AND x.firm_id = d.firm_id
          AND x.case_id = d.case_id
          AND x.milestone_key = 'letter_disclaimer_dated'
      );
  END IF;
END $$;

