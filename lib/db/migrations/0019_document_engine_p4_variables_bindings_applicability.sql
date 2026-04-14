BEGIN;

CREATE TABLE IF NOT EXISTS document_variable_definitions (
  id serial PRIMARY KEY,
  key text NOT NULL,
  label text NOT NULL,
  description text NULL,
  category text NOT NULL DEFAULT 'case',
  value_type text NOT NULL DEFAULT 'string',
  source_path text NULL,
  formatter text NULL,
  example_value text NULL,
  is_system boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE document_variable_definitions
  DROP CONSTRAINT IF EXISTS uq_document_variable_definitions_key;
ALTER TABLE document_variable_definitions
  ADD CONSTRAINT uq_document_variable_definitions_key UNIQUE (key);

ALTER TABLE document_variable_definitions
  DROP CONSTRAINT IF EXISTS chk_document_variable_definitions_category;
ALTER TABLE document_variable_definitions
  ADD CONSTRAINT chk_document_variable_definitions_category
  CHECK (category IN ('case','purchaser','property','loan','developer','project','workflow','custom'));

ALTER TABLE document_variable_definitions
  DROP CONSTRAINT IF EXISTS chk_document_variable_definitions_value_type;
ALTER TABLE document_variable_definitions
  ADD CONSTRAINT chk_document_variable_definitions_value_type
  CHECK (value_type IN ('string','number','date','boolean','richtext','array'));

CREATE INDEX IF NOT EXISTS idx_document_variable_definitions_active ON document_variable_definitions (is_active, category, sort_order, key);

CREATE TABLE IF NOT EXISTS document_template_bindings (
  id serial PRIMARY KEY,
  firm_id integer NULL,
  template_id integer NULL,
  platform_document_id integer NULL,
  variable_key text NOT NULL,
  source_mode text NOT NULL DEFAULT 'registry_default',
  source_path text NULL,
  fixed_value text NULL,
  formatter_override text NULL,
  is_required boolean NOT NULL DEFAULT false,
  fallback_value text NULL,
  notes text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE document_template_bindings
  DROP CONSTRAINT IF EXISTS fk_document_template_bindings_firm;
ALTER TABLE document_template_bindings
  ADD CONSTRAINT fk_document_template_bindings_firm
  FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE;

ALTER TABLE document_template_bindings
  DROP CONSTRAINT IF EXISTS fk_document_template_bindings_template;
ALTER TABLE document_template_bindings
  ADD CONSTRAINT fk_document_template_bindings_template
  FOREIGN KEY (template_id) REFERENCES document_templates(id) ON DELETE CASCADE;

ALTER TABLE document_template_bindings
  DROP CONSTRAINT IF EXISTS fk_document_template_bindings_platform_document;
ALTER TABLE document_template_bindings
  ADD CONSTRAINT fk_document_template_bindings_platform_document
  FOREIGN KEY (platform_document_id) REFERENCES platform_documents(id) ON DELETE CASCADE;

ALTER TABLE document_template_bindings
  DROP CONSTRAINT IF EXISTS chk_document_template_bindings_target;
ALTER TABLE document_template_bindings
  ADD CONSTRAINT chk_document_template_bindings_target
  CHECK (
    (template_id IS NOT NULL AND platform_document_id IS NULL AND firm_id IS NOT NULL)
    OR (template_id IS NULL AND platform_document_id IS NOT NULL)
  );

ALTER TABLE document_template_bindings
  DROP CONSTRAINT IF EXISTS chk_document_template_bindings_source_mode;
ALTER TABLE document_template_bindings
  ADD CONSTRAINT chk_document_template_bindings_source_mode
  CHECK (source_mode IN ('registry_default','custom_path','fixed_value'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_document_template_bindings_template_key
  ON document_template_bindings (template_id, variable_key)
  WHERE template_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_template_bindings_platform_key
  ON document_template_bindings (platform_document_id, variable_key)
  WHERE platform_document_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_document_template_bindings_firm ON document_template_bindings (firm_id);
CREATE INDEX IF NOT EXISTS idx_document_template_bindings_template ON document_template_bindings (firm_id, template_id);
CREATE INDEX IF NOT EXISTS idx_document_template_bindings_platform ON document_template_bindings (platform_document_id);
CREATE INDEX IF NOT EXISTS idx_document_template_bindings_key ON document_template_bindings (firm_id, variable_key);

CREATE TABLE IF NOT EXISTS document_template_applicability_rules (
  id serial PRIMARY KEY,
  firm_id integer NULL,
  template_id integer NULL,
  platform_document_id integer NULL,
  is_active boolean NULL,
  purchase_mode text NULL,
  title_type text NULL,
  title_sub_type text NULL,
  project_type text NULL,
  development_condition text NULL,
  unit_category text NULL,
  is_template_capable boolean NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE document_template_applicability_rules
  DROP CONSTRAINT IF EXISTS fk_document_template_applicability_rules_firm;
ALTER TABLE document_template_applicability_rules
  ADD CONSTRAINT fk_document_template_applicability_rules_firm
  FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE;

ALTER TABLE document_template_applicability_rules
  DROP CONSTRAINT IF EXISTS fk_document_template_applicability_rules_template;
ALTER TABLE document_template_applicability_rules
  ADD CONSTRAINT fk_document_template_applicability_rules_template
  FOREIGN KEY (template_id) REFERENCES document_templates(id) ON DELETE CASCADE;

ALTER TABLE document_template_applicability_rules
  DROP CONSTRAINT IF EXISTS fk_document_template_applicability_rules_platform_document;
ALTER TABLE document_template_applicability_rules
  ADD CONSTRAINT fk_document_template_applicability_rules_platform_document
  FOREIGN KEY (platform_document_id) REFERENCES platform_documents(id) ON DELETE CASCADE;

ALTER TABLE document_template_applicability_rules
  DROP CONSTRAINT IF EXISTS chk_document_template_applicability_rules_target;
ALTER TABLE document_template_applicability_rules
  ADD CONSTRAINT chk_document_template_applicability_rules_target
  CHECK (
    (template_id IS NOT NULL AND platform_document_id IS NULL AND firm_id IS NOT NULL)
    OR (template_id IS NULL AND platform_document_id IS NOT NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_document_template_applicability_rules_template
  ON document_template_applicability_rules (template_id)
  WHERE template_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_template_applicability_rules_platform
  ON document_template_applicability_rules (platform_document_id)
  WHERE platform_document_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_document_template_applicability_rules_firm ON document_template_applicability_rules (firm_id);
CREATE INDEX IF NOT EXISTS idx_document_template_applicability_rules_template ON document_template_applicability_rules (firm_id, template_id);
CREATE INDEX IF NOT EXISTS idx_document_template_applicability_rules_platform ON document_template_applicability_rules (platform_document_id);

ALTER TABLE document_variable_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_variable_definitions FORCE ROW LEVEL SECURITY;
ALTER TABLE document_template_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_template_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE document_template_applicability_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_template_applicability_rules FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS variable_registry_read ON document_variable_definitions;
DROP POLICY IF EXISTS variable_registry_manage ON document_variable_definitions;
CREATE POLICY variable_registry_read ON document_variable_definitions FOR SELECT TO PUBLIC
  USING (true);
CREATE POLICY variable_registry_manage ON document_variable_definitions FOR ALL TO PUBLIC
  USING (current_setting('app.is_founder',true)='true')
  WITH CHECK (current_setting('app.is_founder',true)='true');

DROP POLICY IF EXISTS tenant_isolation ON document_template_bindings;
DROP POLICY IF EXISTS tenant_isolation ON document_template_applicability_rules;

CREATE POLICY tenant_isolation ON document_template_bindings FOR ALL TO PUBLIC
  USING (
    (firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer)
    OR firm_id IS NULL
    OR current_setting('app.is_founder',true)='true'
  )
  WITH CHECK (
    (firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer)
    OR (firm_id IS NULL AND current_setting('app.is_founder',true)='true')
  );

CREATE POLICY tenant_isolation ON document_template_applicability_rules FOR ALL TO PUBLIC
  USING (
    (firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer)
    OR firm_id IS NULL
    OR current_setting('app.is_founder',true)='true'
  )
  WITH CHECK (
    (firm_id = NULLIF(current_setting('app.current_firm_id',true),'')::integer)
    OR (firm_id IS NULL AND current_setting('app.is_founder',true)='true')
  );

INSERT INTO document_variable_definitions (key, label, description, category, value_type, source_path, formatter, example_value, is_system, is_active, sort_order)
VALUES
  ('reference_no','Case Reference No.','Case reference number','case','string','reference_no',NULL,'LCP-000123',true,true,10),
  ('date','Document Date (formatted)','Human-readable document date','case','string','date','date_dmy','14/04/2026',true,true,20),
  ('purchase_mode','Purchase Mode','cash/loan','case','string','purchase_mode',NULL,'loan',true,true,30),
  ('title_type','Title Type','master/strata/individual','case','string','title_type',NULL,'strata',true,true,40),
  ('project_name','Project Name','Project name','project','string','project_name',NULL,'Taman Example',true,true,50),
  ('project_type','Project Type','Project type','project','string','project_type',NULL,'Landed',true,true,60),
  ('project_development_condition','Development Condition','Development condition','project','string','project_development_condition',NULL,'Under Construction',true,true,70),
  ('unit_category','Unit Category','Unit category','project','string','unit_category',NULL,'Residential',true,true,80),
  ('spa_price','SPA Price (formatted)','Formatted SPA price','case','string','spa_price','currency','RM 500,000.00',true,true,90),
  ('spa_price_raw','SPA Price (raw)','Raw SPA price','case','number','spa_price_raw',NULL,'500000',true,true,100),
  ('purchaser_name','Main Purchaser Name','Primary purchaser name','purchaser','string','spa_purchaser1_name',NULL,'Ali Bin Abu',true,true,110),
  ('purchaser_ic','Main Purchaser IC No.','Primary purchaser IC','purchaser','string','spa_purchaser1_ic','nric','900101-14-5678',true,true,120),
  ('developer_name','Developer Name','Developer/company name','developer','string','developer_name',NULL,'ABC Development Sdn Bhd',true,true,130)
ON CONFLICT (key) DO NOTHING;

COMMIT;
