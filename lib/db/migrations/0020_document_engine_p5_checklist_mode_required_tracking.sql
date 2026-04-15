-- Document Engine P5: Checklist Mode + Required Documents Tracking

ALTER TABLE document_template_applicability_rules
  ADD COLUMN IF NOT EXISTS is_required boolean NULL;

CREATE TABLE IF NOT EXISTS case_document_checklist_items (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  case_id integer NOT NULL,
  checklist_key text NOT NULL,
  template_id integer NULL,
  platform_document_id integer NULL,
  case_document_id integer NULL,
  label text NOT NULL,
  source_type text NOT NULL,
  applicability_result jsonb NULL,
  is_required boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending',
  notes text NULL,
  received_at timestamptz NULL,
  received_by integer NULL,
  completed_at timestamptz NULL,
  completed_by integer NULL,
  waived_at timestamptz NULL,
  waived_by integer NULL,
  waived_reason text NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE case_document_checklist_items
  DROP CONSTRAINT IF EXISTS fk_case_document_checklist_items_firm;
ALTER TABLE case_document_checklist_items
  ADD CONSTRAINT fk_case_document_checklist_items_firm
  FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE;

ALTER TABLE case_document_checklist_items
  DROP CONSTRAINT IF EXISTS fk_case_document_checklist_items_case;
ALTER TABLE case_document_checklist_items
  ADD CONSTRAINT fk_case_document_checklist_items_case
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE;

ALTER TABLE case_document_checklist_items
  DROP CONSTRAINT IF EXISTS fk_case_document_checklist_items_template;
ALTER TABLE case_document_checklist_items
  ADD CONSTRAINT fk_case_document_checklist_items_template
  FOREIGN KEY (template_id) REFERENCES document_templates(id) ON DELETE SET NULL;

ALTER TABLE case_document_checklist_items
  DROP CONSTRAINT IF EXISTS fk_case_document_checklist_items_platform_document;
ALTER TABLE case_document_checklist_items
  ADD CONSTRAINT fk_case_document_checklist_items_platform_document
  FOREIGN KEY (platform_document_id) REFERENCES platform_documents(id) ON DELETE SET NULL;

ALTER TABLE case_document_checklist_items
  DROP CONSTRAINT IF EXISTS fk_case_document_checklist_items_case_document;
ALTER TABLE case_document_checklist_items
  ADD CONSTRAINT fk_case_document_checklist_items_case_document
  FOREIGN KEY (case_document_id) REFERENCES case_documents(id) ON DELETE SET NULL;

ALTER TABLE case_document_checklist_items
  DROP CONSTRAINT IF EXISTS fk_case_document_checklist_items_received_by;
ALTER TABLE case_document_checklist_items
  ADD CONSTRAINT fk_case_document_checklist_items_received_by
  FOREIGN KEY (received_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE case_document_checklist_items
  DROP CONSTRAINT IF EXISTS fk_case_document_checklist_items_completed_by;
ALTER TABLE case_document_checklist_items
  ADD CONSTRAINT fk_case_document_checklist_items_completed_by
  FOREIGN KEY (completed_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE case_document_checklist_items
  DROP CONSTRAINT IF EXISTS fk_case_document_checklist_items_waived_by;
ALTER TABLE case_document_checklist_items
  ADD CONSTRAINT fk_case_document_checklist_items_waived_by
  FOREIGN KEY (waived_by) REFERENCES users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_case_document_checklist_items_key
  ON case_document_checklist_items (firm_id, case_id, checklist_key);

CREATE INDEX IF NOT EXISTS idx_case_document_checklist_items_case
  ON case_document_checklist_items (firm_id, case_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_case_document_checklist_items_status
  ON case_document_checklist_items (firm_id, case_id, status);

ALTER TABLE case_document_checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_document_checklist_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON case_document_checklist_items;
CREATE POLICY tenant_isolation ON case_document_checklist_items FOR ALL TO PUBLIC
  USING (firm_id = nullif(current_setting('app.current_firm_id', true), '')::int)
  WITH CHECK (firm_id = nullif(current_setting('app.current_firm_id', true), '')::int);

