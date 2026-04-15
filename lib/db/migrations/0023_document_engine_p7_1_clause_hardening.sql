-- Document Engine P7.1: Clause Library Hardening

ALTER TABLE document_templates
  ADD COLUMN IF NOT EXISTS clause_insertion_mode text NULL;

ALTER TABLE platform_documents
  ADD COLUMN IF NOT EXISTS clause_insertion_mode text NULL;

ALTER TABLE case_documents
  ADD COLUMN IF NOT EXISTS clause_snapshot jsonb NULL;

