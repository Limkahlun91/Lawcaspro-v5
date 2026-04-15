-- Document Engine P9: Template Applicability Rules

ALTER TABLE document_templates
  ADD COLUMN IF NOT EXISTS applicability_mode text NULL;

ALTER TABLE document_templates
  ADD COLUMN IF NOT EXISTS applicability_rules jsonb NULL;

ALTER TABLE platform_documents
  ADD COLUMN IF NOT EXISTS applicability_mode text NULL;

ALTER TABLE platform_documents
  ADD COLUMN IF NOT EXISTS applicability_rules jsonb NULL;

