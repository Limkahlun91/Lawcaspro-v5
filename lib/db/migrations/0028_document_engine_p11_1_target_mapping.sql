-- Document Engine P11.1: Extraction hardening (target mapping metadata)

ALTER TABLE document_extraction_suggestions
  ADD COLUMN IF NOT EXISTS target_entity_path text NULL;

ALTER TABLE document_extraction_suggestions
  ADD COLUMN IF NOT EXISTS suggested_target_candidates jsonb NULL;

ALTER TABLE document_extraction_suggestions
  ADD COLUMN IF NOT EXISTS chosen_target_candidate jsonb NULL;

