ALTER TABLE case_documents
  ADD COLUMN IF NOT EXISTS document_type text;

ALTER TABLE case_documents
  ADD COLUMN IF NOT EXISTS object_path text;

ALTER TABLE case_documents
  ADD COLUMN IF NOT EXISTS file_name text;

UPDATE case_documents
  SET document_type = COALESCE(document_type, 'generated')
  WHERE document_type IS NULL;

UPDATE case_documents
  SET file_name = COALESCE(file_name, name)
  WHERE file_name IS NULL;

