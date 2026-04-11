-- 0008_case_list_saved_views.sql
-- Saved filter views for Cases list (per-firm, per-user).

CREATE TABLE IF NOT EXISTS case_list_saved_views (
  id serial PRIMARY KEY,
  firm_id integer NOT NULL,
  user_id integer NOT NULL,
  name text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_case_list_saved_views_firm_user ON case_list_saved_views(firm_id, user_id);

ALTER TABLE case_list_saved_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_list_saved_views FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS case_list_saved_views_select ON case_list_saved_views;
CREATE POLICY case_list_saved_views_select ON case_list_saved_views
  FOR SELECT
  USING (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
    AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::integer
  );

DROP POLICY IF EXISTS case_list_saved_views_insert ON case_list_saved_views;
CREATE POLICY case_list_saved_views_insert ON case_list_saved_views
  FOR INSERT
  WITH CHECK (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
    AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::integer
  );

DROP POLICY IF EXISTS case_list_saved_views_update ON case_list_saved_views;
CREATE POLICY case_list_saved_views_update ON case_list_saved_views
  FOR UPDATE
  USING (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
    AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::integer
  )
  WITH CHECK (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
    AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::integer
  );

DROP POLICY IF EXISTS case_list_saved_views_delete ON case_list_saved_views;
CREATE POLICY case_list_saved_views_delete ON case_list_saved_views
  FOR DELETE
  USING (
    firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::integer
    AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::integer
  );

