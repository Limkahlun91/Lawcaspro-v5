DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'department'
  ) THEN
    ALTER TABLE "users" ADD COLUMN "department" text;
  END IF;
END
$$;
