ALTER TABLE document_templates
  ADD COLUMN IF NOT EXISTS pdf_mapping_config jsonb;

