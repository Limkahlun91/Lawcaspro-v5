import { pgTable, serial, text, integer, timestamp, jsonb, boolean, date } from "drizzle-orm/pg-core";
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
  isEncumbered: boolean("is_encumbered").notNull().default(false),
  tenure: text("tenure").notNull().default("freehold"),
  masterChargeeBank: text("master_chargee_bank"),
  masterChargeeAccount: text("master_chargee_account"),
  constructionPeriodMonths: integer("construction_period_months"),
  actualVpDate: date("actual_vp_date"),
  cccDate: date("ccc_date"),
  hdaAccount: text("hda_account"),
  hdaBank: text("hda_bank"),
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
