CREATE TABLE IF NOT EXISTS developer_documents (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  developer_id integer NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  document_name text NOT NULL,
  object_path text NOT NULL,
  file_name text NOT NULL,
  mime_type text,
  file_size integer,
  has_expiry boolean NOT NULL DEFAULT false,
  valid_from date,
  valid_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_developer_documents_firm_developer
  ON developer_documents (firm_id, developer_id);

CREATE INDEX IF NOT EXISTS idx_developer_documents_firm_valid_to
  ON developer_documents (firm_id, valid_to);

