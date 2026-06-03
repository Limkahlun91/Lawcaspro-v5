ALTER TABLE case_documents
  ADD COLUMN IF NOT EXISTS checklist_key text;

ALTER TABLE case_documents
  ADD COLUMN IF NOT EXISTS document_type text;

ALTER TABLE case_documents
  ADD COLUMN IF NOT EXISTS object_path text;

ALTER TABLE case_documents
  ADD COLUMN IF NOT EXISTS file_name text;

UPDATE case_documents
  SET document_type = COALESCE(document_type, 'generated')
  WHERE document_type IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'case_documents'
      AND column_name = 'name'
  ) THEN
    EXECUTE $sql$
      UPDATE case_documents
        SET file_name = COALESCE(file_name, name)
        WHERE file_name IS NULL
    $sql$;
  END IF;
END $$;
