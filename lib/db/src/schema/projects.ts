import { pgTable, serial, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const projectsTable = pgTable("projects", {
  id: serial("id").primaryKey(),
  firmId: integer("firm_id").notNull(),
  developerId: integer("developer_id").notNull(),
  name: text("name").notNull(),
  phase: text("phase"),
  developerName: text("developer_name"),
  projectType: text("project_type").notNull().default("highrise"),
  titleType: text("title_type").notNull().default("master"),
  titleSubtype: text("title_subtype"),
  masterTitleNumber: text("master_title_number"),
  masterTitleLandSize: text("master_title_land_size"),
  mukim: text("mukim"),
  daerah: text("daerah"),
  negeri: text("negeri"),
  landUse: text("land_use"),
  developmentCondition: text("development_condition"),
  unitCategory: text("unit_category"),
  extraFields: jsonb("extra_fields").default({}),
  createdBy: integer("created_by"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  archivedBy: integer("archived_by"),
  archivedReason: text("archived_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertProjectSchema = createInsertSchema(projectsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projectsTable.$inferSelect;
