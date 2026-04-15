-- Document Engine P8: Smart Naming Engine hardening

ALTER TABLE case_documents
  ADD COLUMN IF NOT EXISTS naming_snapshot jsonb NULL;

