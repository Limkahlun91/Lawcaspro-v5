ALTER TABLE project_documents
  ADD COLUMN IF NOT EXISTS license_number text;

ALTER TABLE project_documents
  DROP CONSTRAINT IF EXISTS project_documents_category_check;

ALTER TABLE project_documents
  ADD CONSTRAINT project_documents_category_check
  CHECK (category IN ('general','advertisement_permit','developer_license','developer_mlu','bank_mlu'));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'ap_number'
  ) THEN
    INSERT INTO project_documents (
      firm_id,
      project_id,
      category,
      document_name,
      license_number,
      object_path,
      file_name,
      mime_type,
      file_size,
      has_expiry,
      valid_from,
      valid_to,
      created_at,
      updated_at
    )
    SELECT
      p.firm_id,
      p.id AS project_id,
      'advertisement_permit' AS category,
      'Advertisement Permit' AS document_name,
      p.ap_number AS license_number,
      ('legacy_metadata/projects/' || p.firm_id || '/' || p.id || '/ap/' || gen_random_uuid()) AS object_path,
      'legacy_ap_metadata.txt' AS file_name,
      NULL AS mime_type,
      NULL AS file_size,
      true AS has_expiry,
      p.ap_valid_from AS valid_from,
      p.ap_valid_to AS valid_to,
      now() AS created_at,
      now() AS updated_at
    FROM projects p
    WHERE (p.ap_number IS NOT NULL AND btrim(p.ap_number) <> '')
      OR p.ap_valid_from IS NOT NULL
      OR p.ap_valid_to IS NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'dl_number'
  ) THEN
    INSERT INTO project_documents (
      firm_id,
      project_id,
      category,
      document_name,
      license_number,
      object_path,
      file_name,
      mime_type,
      file_size,
      has_expiry,
      valid_from,
      valid_to,
      created_at,
      updated_at
    )
    SELECT
      p.firm_id,
      p.id AS project_id,
      'developer_license' AS category,
      'Developer License' AS document_name,
      p.dl_number AS license_number,
      ('legacy_metadata/projects/' || p.firm_id || '/' || p.id || '/dl/' || gen_random_uuid()) AS object_path,
      'legacy_dl_metadata.txt' AS file_name,
      NULL AS mime_type,
      NULL AS file_size,
      true AS has_expiry,
      p.dl_valid_from AS valid_from,
      p.dl_valid_to AS valid_to,
      now() AS created_at,
      now() AS updated_at
    FROM projects p
    WHERE (p.dl_number IS NOT NULL AND btrim(p.dl_number) <> '')
      OR p.dl_valid_from IS NOT NULL
      OR p.dl_valid_to IS NOT NULL;
  END IF;
END $$;

ALTER TABLE projects
  DROP COLUMN IF EXISTS ap_number,
  DROP COLUMN IF EXISTS ap_valid_from,
  DROP COLUMN IF EXISTS ap_valid_to,
  DROP COLUMN IF EXISTS dl_number,
  DROP COLUMN IF EXISTS dl_valid_from,
  DROP COLUMN IF EXISTS dl_valid_to;
