BEGIN;

CREATE TABLE IF NOT EXISTS firm_document_folders (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  name text NOT NULL,
  parent_id integer NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_firm_doc_folders_firm ON firm_document_folders (firm_id);
CREATE INDEX IF NOT EXISTS idx_firm_doc_folders_parent ON firm_document_folders (firm_id, parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_firm_doc_folders_root_name ON firm_document_folders (firm_id, name) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_firm_doc_folders_child_name ON firm_document_folders (firm_id, parent_id, name) WHERE parent_id IS NOT NULL;

ALTER TABLE firm_document_folders
  DROP CONSTRAINT IF EXISTS fk_firm_doc_folders_parent;
ALTER TABLE firm_document_folders
  ADD CONSTRAINT fk_firm_doc_folders_parent
  FOREIGN KEY (parent_id) REFERENCES firm_document_folders(id) ON DELETE CASCADE;

ALTER TABLE firm_document_folders
  DROP CONSTRAINT IF EXISTS fk_firm_doc_folders_firm;
ALTER TABLE firm_document_folders
  ADD CONSTRAINT fk_firm_doc_folders_firm
  FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE;

ALTER TABLE document_templates
  ADD COLUMN IF NOT EXISTS folder_id integer NULL;
ALTER TABLE document_templates
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'template';
ALTER TABLE document_templates
  ADD COLUMN IF NOT EXISTS mime_type text NULL;
ALTER TABLE document_templates
  ADD COLUMN IF NOT EXISTS extension text NULL;
ALTER TABLE document_templates
  ADD COLUMN IF NOT EXISTS file_size integer NULL;
ALTER TABLE document_templates
  ADD COLUMN IF NOT EXISTS is_template_capable boolean NOT NULL DEFAULT true;

ALTER TABLE document_templates
  DROP CONSTRAINT IF EXISTS fk_document_templates_folder;
ALTER TABLE document_templates
  ADD CONSTRAINT fk_document_templates_folder
  FOREIGN KEY (folder_id) REFERENCES firm_document_folders(id) ON DELETE SET NULL;

ALTER TABLE document_templates
  DROP CONSTRAINT IF EXISTS chk_document_templates_kind;
ALTER TABLE document_templates
  ADD CONSTRAINT chk_document_templates_kind
  CHECK (kind IN ('template','reference'));

CREATE INDEX IF NOT EXISTS idx_document_templates_firm_folder ON document_templates (firm_id, folder_id);
CREATE INDEX IF NOT EXISTS idx_document_templates_firm_kind ON document_templates (firm_id, kind);
CREATE INDEX IF NOT EXISTS idx_document_templates_template_capable ON document_templates (firm_id, is_template_capable);

CREATE TABLE IF NOT EXISTS firm_letterheads (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  name text NOT NULL,
  description text NULL,
  is_default boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  footer_mode text NOT NULL DEFAULT 'every_page',
  first_page_object_path text NOT NULL,
  first_page_file_name text NOT NULL,
  first_page_mime_type text NOT NULL,
  first_page_extension text NOT NULL,
  first_page_file_size integer NULL,
  continuation_header_object_path text NOT NULL,
  continuation_header_file_name text NOT NULL,
  continuation_header_mime_type text NOT NULL,
  continuation_header_extension text NOT NULL,
  continuation_header_file_size integer NULL,
  footer_object_path text NULL,
  footer_file_name text NULL,
  footer_mime_type text NULL,
  footer_extension text NULL,
  footer_file_size integer NULL,
  created_by integer NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE firm_letterheads
  DROP CONSTRAINT IF EXISTS fk_firm_letterheads_firm;
ALTER TABLE firm_letterheads
  ADD CONSTRAINT fk_firm_letterheads_firm
  FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE;

ALTER TABLE firm_letterheads
  DROP CONSTRAINT IF EXISTS chk_firm_letterheads_status;
ALTER TABLE firm_letterheads
  ADD CONSTRAINT chk_firm_letterheads_status
  CHECK (status IN ('active','inactive'));

ALTER TABLE firm_letterheads
  DROP CONSTRAINT IF EXISTS chk_firm_letterheads_footer_mode;
ALTER TABLE firm_letterheads
  ADD CONSTRAINT chk_firm_letterheads_footer_mode
  CHECK (footer_mode IN ('every_page','last_page_only'));

CREATE INDEX IF NOT EXISTS idx_firm_letterheads_firm ON firm_letterheads (firm_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_firm_letterheads_default ON firm_letterheads (firm_id) WHERE is_default;

ALTER TABLE firm_document_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE firm_document_folders FORCE ROW LEVEL SECURITY;
ALTER TABLE firm_letterheads ENABLE ROW LEVEL SECURITY;
ALTER TABLE firm_letterheads FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON firm_document_folders;
DROP POLICY IF EXISTS tenant_isolation ON firm_letterheads;

CREATE POLICY tenant_isolation ON firm_document_folders FOR ALL TO PUBLIC
  USING (
    (firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer)
    OR current_setting('app.is_founder',true)='true'
  )
  WITH CHECK (
    (firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer)
    OR current_setting('app.is_founder',true)='true'
  );

CREATE POLICY tenant_isolation ON firm_letterheads FOR ALL TO PUBLIC
  USING (
    (firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer)
    OR current_setting('app.is_founder',true)='true'
  )
  WITH CHECK (
    (firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer)
    OR current_setting('app.is_founder',true)='true'
  );

COMMIT;
