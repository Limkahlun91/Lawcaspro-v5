CREATE TABLE IF NOT EXISTS "templates" (
  "id" serial PRIMARY KEY NOT NULL,
  "firm_id" integer,
  "name" text NOT NULL,
  "file_type" text NOT NULL,
  "storage_path" text NOT NULL,
  "mapping_config" jsonb,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_by" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'templates_file_type_chk'
  ) THEN
    ALTER TABLE "templates"
      ADD CONSTRAINT "templates_file_type_chk"
      CHECK ("file_type" IN ('docx','pdf'));
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_templates_firm" ON "templates" ("firm_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_templates_firm_active" ON "templates" ("firm_id","is_active");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_templates_active" ON "templates" ("is_active");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_templates_file_type" ON "templates" ("file_type");

