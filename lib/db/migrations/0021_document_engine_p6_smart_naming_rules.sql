-- Document Engine P6: Smart Naming Engine (template naming rules)

ALTER TABLE document_templates
  ADD COLUMN IF NOT EXISTS file_naming_rule text NULL;

ALTER TABLE platform_documents
  ADD COLUMN IF NOT EXISTS file_naming_rule text NULL;

