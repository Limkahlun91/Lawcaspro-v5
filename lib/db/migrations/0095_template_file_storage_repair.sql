-- =============================================================================
-- 0095_template_file_storage_repair.sql
--
-- Production repair migration:
-- - Ensure runtime role app_user has required SELECT/INSERT/UPDATE grants for
--   document generation + template/version reads.
-- - Add a couple of safe indexes to speed up resolving latest published versions.
-- - Safely backfill published version source_object_path from template.object_path
--   only when the published version path is blank and template.object_path is set.
-- - Includes an optional diagnostic query (comment) for identifying broken templates.
-- =============================================================================

DO $do$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $do$;

GRANT USAGE ON SCHEMA public TO app_user;

DO $do$ BEGIN
  IF to_regclass('public.document_templates') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT ON TABLE public.document_templates TO app_user';
  END IF;
  IF to_regclass('public.document_template_versions') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.document_template_versions TO app_user';
  END IF;
  IF to_regclass('public.document_generation_jobs') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.document_generation_jobs TO app_user';
  END IF;
  IF to_regclass('public.document_generation_job_items') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.document_generation_job_items TO app_user';
  END IF;
  IF to_regclass('public.document_generation_runs') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.document_generation_runs TO app_user';
  END IF;
  IF to_regclass('public.case_documents') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.case_documents TO app_user';
  END IF;
END $do$;

CREATE INDEX IF NOT EXISTS idx_document_template_versions_firm_template_status
  ON public.document_template_versions (firm_id, template_id, status);

CREATE INDEX IF NOT EXISTS idx_document_template_versions_firm_status_source_object_path
  ON public.document_template_versions (firm_id, status, source_object_path);

DO $do$ BEGIN
  IF to_regclass('public.document_templates') IS NOT NULL AND to_regclass('public.document_template_versions') IS NOT NULL THEN
    WITH latest_published AS (
      SELECT DISTINCT ON (v.firm_id, v.template_id)
        v.firm_id,
        v.template_id,
        v.id AS version_id
      FROM public.document_template_versions v
      WHERE v.status = 'published'
      ORDER BY v.firm_id, v.template_id, v.published_at DESC NULLS LAST, v.id DESC
    )
    UPDATE public.document_template_versions v
    SET source_object_path = t.object_path,
        filename = COALESCE(NULLIF(v.filename, ''), NULLIF(t.file_name, ''), v.filename)
    FROM latest_published lp
    JOIN public.document_templates t
      ON t.firm_id = lp.firm_id AND t.id = lp.template_id
    WHERE v.firm_id = lp.firm_id
      AND v.template_id = lp.template_id
      AND v.id = lp.version_id
      AND btrim(COALESCE(v.source_object_path, '')) = ''
      AND btrim(COALESCE(t.object_path, '')) <> '';
  END IF;
END $do$;

SELECT pg_notify('pgrst', 'reload schema');

-- Diagnostic query (manual run in Supabase SQL Editor):
-- WITH latest_published AS (
--   SELECT DISTINCT ON (v.firm_id, v.template_id)
--     v.firm_id,
--     v.template_id,
--     v.id AS version_id,
--     v.status AS version_status,
--     v.source_object_path AS version_source_object_path
--   FROM document_template_versions v
--   ORDER BY v.firm_id, v.template_id, v.published_at DESC NULLS LAST, v.id DESC
-- )
-- SELECT
--   t.firm_id,
--   t.id AS template_id,
--   t.name AS template_name,
--   t.kind,
--   t.is_active,
--   t.object_path AS template_object_path,
--   lp.version_id AS latest_version_id,
--   lp.version_status AS latest_version_status,
--   lp.version_source_object_path AS latest_version_source_object_path
-- FROM document_templates t
-- LEFT JOIN latest_published lp
--   ON lp.firm_id = t.firm_id AND lp.template_id = t.id
-- WHERE t.kind = 'template'
--   AND t.is_template_capable = true
--   AND (
--     btrim(COALESCE(t.object_path, '')) = ''
--     OR lp.version_id IS NULL
--     OR btrim(COALESCE(lp.version_source_object_path, '')) = ''
--   )
-- ORDER BY t.firm_id, t.id;

