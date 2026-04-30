-- 0039_supabase_private_bucket.sql
-- Idempotent creation of the default private bucket used by API private uploads.
-- Safe no-op on non-Supabase Postgres (when storage schema is absent).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'storage'
      AND table_name = 'buckets'
  ) THEN
    INSERT INTO storage.buckets (id, name, public)
    VALUES ('lawcaspro-private', 'lawcaspro-private', FALSE)
    ON CONFLICT (id) DO UPDATE
      SET name = EXCLUDED.name,
          public = FALSE;
  END IF;
END $$;

