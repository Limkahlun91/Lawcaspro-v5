CREATE TABLE IF NOT EXISTS public.case_workflow_documents (
  id SERIAL PRIMARY KEY,
  firm_id INT NOT NULL REFERENCES public.firms(id) ON DELETE CASCADE,
  case_id INT NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  milestone_key TEXT NOT NULL,
  label TEXT NOT NULL,
  date_value DATE,
  object_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT,
  file_size INT,
  uploaded_by INT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_case_workflow_documents_firm_case ON public.case_workflow_documents(firm_id, case_id);
CREATE INDEX IF NOT EXISTS idx_case_workflow_documents_case ON public.case_workflow_documents(case_id);
CREATE INDEX IF NOT EXISTS idx_case_workflow_documents_firm_key ON public.case_workflow_documents(firm_id, milestone_key);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_case_workflow_documents_active ON public.case_workflow_documents(firm_id, case_id, milestone_key) WHERE deleted_at IS NULL;

ALTER TABLE public.case_workflow_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_case_workflow_documents_select ON public.case_workflow_documents;
CREATE POLICY rls_case_workflow_documents_select ON public.case_workflow_documents
FOR SELECT USING (firm_id = current_setting('app.firm_id')::int);

DROP POLICY IF EXISTS rls_case_workflow_documents_insert ON public.case_workflow_documents;
CREATE POLICY rls_case_workflow_documents_insert ON public.case_workflow_documents
FOR INSERT WITH CHECK (firm_id = current_setting('app.firm_id')::int);

DROP POLICY IF EXISTS rls_case_workflow_documents_update ON public.case_workflow_documents;
CREATE POLICY rls_case_workflow_documents_update ON public.case_workflow_documents
FOR UPDATE USING (firm_id = current_setting('app.firm_id')::int) WITH CHECK (firm_id = current_setting('app.firm_id')::int);

DROP POLICY IF EXISTS rls_case_workflow_documents_delete ON public.case_workflow_documents;
CREATE POLICY rls_case_workflow_documents_delete ON public.case_workflow_documents
FOR DELETE USING (firm_id = current_setting('app.firm_id')::int);

CREATE TABLE IF NOT EXISTS public.case_loan_stamping_items (
  id SERIAL PRIMARY KEY,
  firm_id INT NOT NULL REFERENCES public.firms(id) ON DELETE CASCADE,
  case_id INT NOT NULL REFERENCES public.cases(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  custom_name TEXT,
  dated_on DATE,
  stamped_on DATE,
  object_path TEXT,
  file_name TEXT,
  mime_type TEXT,
  file_size INT,
  uploaded_by INT REFERENCES public.users(id) ON DELETE SET NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_case_loan_stamping_items_firm_case ON public.case_loan_stamping_items(firm_id, case_id);
CREATE INDEX IF NOT EXISTS idx_case_loan_stamping_items_case ON public.case_loan_stamping_items(case_id);
CREATE INDEX IF NOT EXISTS idx_case_loan_stamping_items_firm_key ON public.case_loan_stamping_items(firm_id, item_key);
CREATE INDEX IF NOT EXISTS idx_case_loan_stamping_items_sort ON public.case_loan_stamping_items(firm_id, case_id, sort_order);

ALTER TABLE public.case_loan_stamping_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_case_loan_stamping_items_select ON public.case_loan_stamping_items;
CREATE POLICY rls_case_loan_stamping_items_select ON public.case_loan_stamping_items
FOR SELECT USING (firm_id = current_setting('app.firm_id')::int);

DROP POLICY IF EXISTS rls_case_loan_stamping_items_insert ON public.case_loan_stamping_items;
CREATE POLICY rls_case_loan_stamping_items_insert ON public.case_loan_stamping_items
FOR INSERT WITH CHECK (firm_id = current_setting('app.firm_id')::int);

DROP POLICY IF EXISTS rls_case_loan_stamping_items_update ON public.case_loan_stamping_items;
CREATE POLICY rls_case_loan_stamping_items_update ON public.case_loan_stamping_items
FOR UPDATE USING (firm_id = current_setting('app.firm_id')::int) WITH CHECK (firm_id = current_setting('app.firm_id')::int);

DROP POLICY IF EXISTS rls_case_loan_stamping_items_delete ON public.case_loan_stamping_items;
CREATE POLICY rls_case_loan_stamping_items_delete ON public.case_loan_stamping_items
FOR DELETE USING (firm_id = current_setting('app.firm_id')::int);

