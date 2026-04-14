-- Normalize case_workflow_documents.milestone_key to stable attachment keys.
--
-- New keys:
-- - spa_stamped
-- - lo_stamped
-- - register_poa
-- - letter_disclaimer
--
-- Safe and repeatable:
-- - Only touches non-deleted rows.
-- - Avoids unique conflicts by soft-deleting the legacy row when target exists.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'case_workflow_documents'
  ) THEN
    -- spa_stamped_date -> spa_stamped
    UPDATE public.case_workflow_documents d
    SET milestone_key = 'spa_stamped', label = 'SPA STAMPED', updated_at = now()
    WHERE d.deleted_at IS NULL
      AND d.milestone_key = 'spa_stamped_date'
      AND NOT EXISTS (
        SELECT 1 FROM public.case_workflow_documents x
        WHERE x.deleted_at IS NULL AND x.firm_id = d.firm_id AND x.case_id = d.case_id AND x.milestone_key = 'spa_stamped'
      );
    UPDATE public.case_workflow_documents d
    SET deleted_at = now(), updated_at = now()
    WHERE d.deleted_at IS NULL
      AND d.milestone_key = 'spa_stamped_date'
      AND EXISTS (
        SELECT 1 FROM public.case_workflow_documents x
        WHERE x.deleted_at IS NULL AND x.firm_id = d.firm_id AND x.case_id = d.case_id AND x.milestone_key = 'spa_stamped'
      );

    -- letter_of_offer_stamped_date -> lo_stamped
    UPDATE public.case_workflow_documents d
    SET milestone_key = 'lo_stamped', label = 'LO STAMPED', updated_at = now()
    WHERE d.deleted_at IS NULL
      AND d.milestone_key = 'letter_of_offer_stamped_date'
      AND NOT EXISTS (
        SELECT 1 FROM public.case_workflow_documents x
        WHERE x.deleted_at IS NULL AND x.firm_id = d.firm_id AND x.case_id = d.case_id AND x.milestone_key = 'lo_stamped'
      );
    UPDATE public.case_workflow_documents d
    SET deleted_at = now(), updated_at = now()
    WHERE d.deleted_at IS NULL
      AND d.milestone_key = 'letter_of_offer_stamped_date'
      AND EXISTS (
        SELECT 1 FROM public.case_workflow_documents x
        WHERE x.deleted_at IS NULL AND x.firm_id = d.firm_id AND x.case_id = d.case_id AND x.milestone_key = 'lo_stamped'
      );

    -- register_poa_on -> register_poa
    UPDATE public.case_workflow_documents d
    SET milestone_key = 'register_poa', label = 'Register POA', updated_at = now()
    WHERE d.deleted_at IS NULL
      AND d.milestone_key = 'register_poa_on'
      AND NOT EXISTS (
        SELECT 1 FROM public.case_workflow_documents x
        WHERE x.deleted_at IS NULL AND x.firm_id = d.firm_id AND x.case_id = d.case_id AND x.milestone_key = 'register_poa'
      );
    UPDATE public.case_workflow_documents d
    SET deleted_at = now(), updated_at = now()
    WHERE d.deleted_at IS NULL
      AND d.milestone_key = 'register_poa_on'
      AND EXISTS (
        SELECT 1 FROM public.case_workflow_documents x
        WHERE x.deleted_at IS NULL AND x.firm_id = d.firm_id AND x.case_id = d.case_id AND x.milestone_key = 'register_poa'
      );

    -- letter_disclaimer_* -> letter_disclaimer
    UPDATE public.case_workflow_documents d
    SET milestone_key = 'letter_disclaimer', label = 'Letter Disclaimer', updated_at = now()
    WHERE d.deleted_at IS NULL
      AND d.milestone_key IN ('letter_disclaimer_dated', 'letter_disclaimer_received_on')
      AND NOT EXISTS (
        SELECT 1 FROM public.case_workflow_documents x
        WHERE x.deleted_at IS NULL AND x.firm_id = d.firm_id AND x.case_id = d.case_id AND x.milestone_key = 'letter_disclaimer'
      );
    UPDATE public.case_workflow_documents d
    SET deleted_at = now(), updated_at = now()
    WHERE d.deleted_at IS NULL
      AND d.milestone_key IN ('letter_disclaimer_dated', 'letter_disclaimer_received_on')
      AND EXISTS (
        SELECT 1 FROM public.case_workflow_documents x
        WHERE x.deleted_at IS NULL AND x.firm_id = d.firm_id AND x.case_id = d.case_id AND x.milestone_key = 'letter_disclaimer'
      );
  END IF;
END $$;

