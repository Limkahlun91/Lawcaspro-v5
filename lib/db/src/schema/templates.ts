import { pgTable, serial, text, integer, boolean, timestamp, index, jsonb } from "drizzle-orm/pg-core";

export const templatesTable = pgTable("templates", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id"),
  name: text("name").notNull(),
  fileType: text("file_type").notNull(),
  storagePath: text("storage_path").notNull(),
  mappingConfig: jsonb("mapping_config"),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  firmIdx: index("idx_templates_firm").on(t.firmId),
  firmActiveIdx: index("idx_templates_firm_active").on(t.firmId, t.isActive),
  activeIdx: index("idx_templates_active").on(t.isActive),
  fileTypeIdx: index("idx_templates_file_type").on(t.fileType),
}));

