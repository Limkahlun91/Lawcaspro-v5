-- 0009_case_list_saved_views_route_key.sql
-- Align saved views with route_key and unique name per (firm,user,route_key).

ALTER TABLE case_list_saved_views
  ADD COLUMN IF NOT EXISTS route_key text NOT NULL DEFAULT 'cases';

CREATE UNIQUE INDEX IF NOT EXISTS idx_case_list_saved_views_unique
  ON case_list_saved_views(firm_id, user_id, route_key, name);

