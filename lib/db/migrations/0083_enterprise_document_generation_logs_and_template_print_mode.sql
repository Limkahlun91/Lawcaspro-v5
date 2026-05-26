ALTER TABLE document_templates
  ADD COLUMN IF NOT EXISTS print_mode text NOT NULL DEFAULT 'double';

ALTER TABLE document_generation_logs
  ADD COLUMN IF NOT EXISTS case_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE document_generation_logs
  ADD COLUMN IF NOT EXISTS generated_files jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE document_generation_logs
  ADD COLUMN IF NOT EXISTS print_copies integer;

ALTER TABLE document_generation_logs
  ADD COLUMN IF NOT EXISTS ip_address text;

ALTER TABLE document_generation_logs
  ADD COLUMN IF NOT EXISTS user_agent text;

ALTER TABLE document_generation_logs
  DROP CONSTRAINT IF EXISTS document_generation_logs_action_type_check;

ALTER TABLE document_generation_logs
  ADD CONSTRAINT document_generation_logs_action_type_check
  CHECK (action_type IN ('download_zip','system_print','download','print'));
