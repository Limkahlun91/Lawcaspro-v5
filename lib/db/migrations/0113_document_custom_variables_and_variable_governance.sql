BEGIN;

ALTER TABLE document_variable_definitions
  ADD COLUMN IF NOT EXISTS group_key text NOT NULL DEFAULT 'case';
ALTER TABLE document_variable_definitions
  ADD COLUMN IF NOT EXISTS is_hidden boolean NOT NULL DEFAULT false;
ALTER TABLE document_variable_definitions
  ADD COLUMN IF NOT EXISTS is_published boolean NOT NULL DEFAULT true;
ALTER TABLE document_variable_definitions
  ADD COLUMN IF NOT EXISTS deprecated_at timestamptz NULL;
ALTER TABLE document_variable_definitions
  ADD COLUMN IF NOT EXISTS replacement_key text NULL;

UPDATE document_variable_definitions
SET group_key = category
WHERE group_key IS NULL OR group_key = '' OR group_key = 'case';

CREATE INDEX IF NOT EXISTS idx_document_variable_definitions_visibility
  ON document_variable_definitions (is_published, is_hidden, category, sort_order, key);
CREATE INDEX IF NOT EXISTS idx_document_variable_definitions_deprecated
  ON document_variable_definitions (deprecated_at);

CREATE TABLE IF NOT EXISTS document_variable_aliases (
  id serial PRIMARY KEY,
  from_key text NOT NULL,
  to_key text NOT NULL,
  created_by integer NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true
);

ALTER TABLE document_variable_aliases
  DROP CONSTRAINT IF EXISTS uq_document_variable_aliases_from_key;
ALTER TABLE document_variable_aliases
  ADD CONSTRAINT uq_document_variable_aliases_from_key UNIQUE (from_key);

CREATE INDEX IF NOT EXISTS idx_document_variable_aliases_to_key
  ON document_variable_aliases (to_key);

ALTER TABLE document_variable_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_variable_aliases FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS variable_aliases_read ON document_variable_aliases;
DROP POLICY IF EXISTS variable_aliases_manage ON document_variable_aliases;
CREATE POLICY variable_aliases_read ON document_variable_aliases FOR SELECT TO PUBLIC
  USING (true);
CREATE POLICY variable_aliases_manage ON document_variable_aliases FOR ALL TO PUBLIC
  USING (current_setting('app.is_founder',true)='true')
  WITH CHECK (current_setting('app.is_founder',true)='true');

CREATE TABLE IF NOT EXISTS document_custom_variables (
  id serial PRIMARY KEY,
  scope text NOT NULL,
  firm_id integer NULL,
  template_id integer NULL,
  key text NOT NULL,
  display_name text NOT NULL,
  group_key text NOT NULL DEFAULT 'custom_variables',
  status text NOT NULL DEFAULT 'active',
  is_published boolean NOT NULL DEFAULT false,
  deprecated_at timestamptz NULL,
  current_version_no integer NOT NULL DEFAULT 1,
  created_by integer NULL,
  updated_by integer NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE document_custom_variables
  DROP CONSTRAINT IF EXISTS chk_document_custom_variables_scope;
ALTER TABLE document_custom_variables
  ADD CONSTRAINT chk_document_custom_variables_scope
  CHECK (scope IN ('founder_master','firm','template_specific'));

ALTER TABLE document_custom_variables
  DROP CONSTRAINT IF EXISTS chk_document_custom_variables_status;
ALTER TABLE document_custom_variables
  ADD CONSTRAINT chk_document_custom_variables_status
  CHECK (status IN ('active','disabled','deprecated'));

ALTER TABLE document_custom_variables
  DROP CONSTRAINT IF EXISTS chk_document_custom_variables_target;
ALTER TABLE document_custom_variables
  ADD CONSTRAINT chk_document_custom_variables_target
  CHECK (
    (scope = 'founder_master' AND firm_id IS NULL AND template_id IS NULL)
    OR (scope = 'firm' AND firm_id IS NOT NULL AND template_id IS NULL)
    OR (scope = 'template_specific' AND firm_id IS NOT NULL AND template_id IS NOT NULL)
  );

ALTER TABLE document_custom_variables
  DROP CONSTRAINT IF EXISTS fk_document_custom_variables_firm;
ALTER TABLE document_custom_variables
  ADD CONSTRAINT fk_document_custom_variables_firm
  FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE;

ALTER TABLE document_custom_variables
  DROP CONSTRAINT IF EXISTS fk_document_custom_variables_template;
ALTER TABLE document_custom_variables
  ADD CONSTRAINT fk_document_custom_variables_template
  FOREIGN KEY (template_id) REFERENCES document_templates(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_document_custom_variables_scoped_key
  ON document_custom_variables (scope, COALESCE(firm_id, 0), COALESCE(template_id, 0), key);

CREATE INDEX IF NOT EXISTS idx_document_custom_variables_lookup
  ON document_custom_variables (scope, firm_id, template_id, key);
CREATE INDEX IF NOT EXISTS idx_document_custom_variables_visible
  ON document_custom_variables (scope, firm_id, template_id, is_published, status, group_key);

CREATE TABLE IF NOT EXISTS document_custom_variable_versions (
  id serial PRIMARY KEY,
  custom_variable_id integer NOT NULL,
  version_no integer NOT NULL,
  body_template text NOT NULL,
  created_by integer NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE document_custom_variable_versions
  DROP CONSTRAINT IF EXISTS fk_document_custom_variable_versions_parent;
ALTER TABLE document_custom_variable_versions
  ADD CONSTRAINT fk_document_custom_variable_versions_parent
  FOREIGN KEY (custom_variable_id) REFERENCES document_custom_variables(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_document_custom_variable_versions
  ON document_custom_variable_versions (custom_variable_id, version_no);
CREATE INDEX IF NOT EXISTS idx_document_custom_variable_versions_parent
  ON document_custom_variable_versions (custom_variable_id, created_at DESC);

ALTER TABLE document_custom_variables ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_custom_variables FORCE ROW LEVEL SECURITY;
ALTER TABLE document_custom_variable_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_custom_variable_versions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS custom_variables_read ON document_custom_variables;
DROP POLICY IF EXISTS custom_variables_manage ON document_custom_variables;
CREATE POLICY custom_variables_read ON document_custom_variables FOR SELECT TO PUBLIC
  USING (
    scope = 'founder_master'
    OR firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer
    OR current_setting('app.is_founder',true)='true'
  );
CREATE POLICY custom_variables_manage ON document_custom_variables FOR ALL TO PUBLIC
  USING (
    (scope = 'founder_master' AND current_setting('app.is_founder',true)='true')
    OR (scope <> 'founder_master' AND firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer)
    OR current_setting('app.is_founder',true)='true'
  )
  WITH CHECK (
    (scope = 'founder_master' AND current_setting('app.is_founder',true)='true')
    OR (scope <> 'founder_master' AND firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer)
    OR current_setting('app.is_founder',true)='true'
  );

DROP POLICY IF EXISTS custom_variable_versions_read ON document_custom_variable_versions;
DROP POLICY IF EXISTS custom_variable_versions_manage ON document_custom_variable_versions;
CREATE POLICY custom_variable_versions_read ON document_custom_variable_versions FOR SELECT TO PUBLIC
  USING (
    EXISTS (
      SELECT 1
      FROM document_custom_variables v
      WHERE v.id = custom_variable_id
        AND (
          v.scope = 'founder_master'
          OR v.firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer
          OR current_setting('app.is_founder',true)='true'
        )
    )
  );
CREATE POLICY custom_variable_versions_manage ON document_custom_variable_versions FOR ALL TO PUBLIC
  USING (
    EXISTS (
      SELECT 1
      FROM document_custom_variables v
      WHERE v.id = custom_variable_id
        AND (
          (v.scope = 'founder_master' AND current_setting('app.is_founder',true)='true')
          OR (v.scope <> 'founder_master' AND v.firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer)
          OR current_setting('app.is_founder',true)='true'
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM document_custom_variables v
      WHERE v.id = custom_variable_id
        AND (
          (v.scope = 'founder_master' AND current_setting('app.is_founder',true)='true')
          OR (v.scope <> 'founder_master' AND v.firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer)
          OR current_setting('app.is_founder',true)='true'
        )
    )
  );

COMMIT;

