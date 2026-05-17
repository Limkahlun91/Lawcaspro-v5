ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS ap_number text,
  ADD COLUMN IF NOT EXISTS ap_valid_from date,
  ADD COLUMN IF NOT EXISTS ap_valid_to date,
  ADD COLUMN IF NOT EXISTS dl_number text,
  ADD COLUMN IF NOT EXISTS dl_valid_from date,
  ADD COLUMN IF NOT EXISTS dl_valid_to date,
  ADD COLUMN IF NOT EXISTS construction_period_months integer,
  ADD COLUMN IF NOT EXISTS actual_vp_date date,
  ADD COLUMN IF NOT EXISTS ccc_date date,
  ADD COLUMN IF NOT EXISTS hda_account text,
  ADD COLUMN IF NOT EXISTS hda_bank text,
  ADD COLUMN IF NOT EXISTS master_chargee_account text;

CREATE TABLE IF NOT EXISTS project_documents (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category text NOT NULL,
  document_name text NOT NULL,
  bank_name text,
  document_date date,
  object_path text NOT NULL,
  file_name text NOT NULL,
  mime_type text,
  file_size integer,
  has_expiry boolean NOT NULL DEFAULT false,
  valid_from date,
  valid_to date,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_documents_category_check CHECK (category IN ('general','developer_mlu','bank_mlu'))
);

CREATE INDEX IF NOT EXISTS idx_project_documents_firm_project
  ON project_documents (firm_id, project_id);

CREATE INDEX IF NOT EXISTS idx_project_documents_firm_category
  ON project_documents (firm_id, category);

