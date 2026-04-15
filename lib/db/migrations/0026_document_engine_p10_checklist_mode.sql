-- Document Engine P10: Checklist Mode

ALTER TABLE document_templates
  ADD COLUMN IF NOT EXISTS checklist_mode text NULL;

ALTER TABLE document_templates
  ADD COLUMN IF NOT EXISTS checklist_items jsonb NULL;

ALTER TABLE platform_documents
  ADD COLUMN IF NOT EXISTS checklist_mode text NULL;

ALTER TABLE platform_documents
  ADD COLUMN IF NOT EXISTS checklist_items jsonb NULL;

