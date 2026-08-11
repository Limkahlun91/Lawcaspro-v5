DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'communication_drafts'
      AND column_name = 'to_addresses'
  ) THEN
    UPDATE communication_drafts
    SET to_addresses = COALESCE(to_addresses, '[]'::JSONB)
    WHERE to_addresses IS NULL;

    UPDATE communication_drafts
    SET cc_addresses = COALESCE(cc_addresses, '[]'::JSONB)
    WHERE cc_addresses IS NULL;

    UPDATE communication_drafts
    SET bcc_addresses = COALESCE(bcc_addresses, '[]'::JSONB)
    WHERE bcc_addresses IS NULL;

    UPDATE communication_drafts
    SET to_addresses = CASE
      WHEN jsonb_array_length(to_addresses) = 0 AND "to" IS NOT NULL AND jsonb_array_length("to") > 0
      THEN "to"
      ELSE to_addresses
    END
    WHERE TRUE;

    UPDATE communication_drafts
    SET cc_addresses = CASE
      WHEN jsonb_array_length(cc_addresses) = 0 AND cc IS NOT NULL AND jsonb_array_length(cc) > 0
      THEN cc
      ELSE cc_addresses
    END
    WHERE TRUE;

    UPDATE communication_drafts
    SET bcc_addresses = CASE
      WHEN jsonb_array_length(bcc_addresses) = 0 AND bcc IS NOT NULL AND jsonb_array_length(bcc) > 0
      THEN bcc
      ELSE bcc_addresses
    END
    WHERE TRUE;
  END IF;
END $$;
