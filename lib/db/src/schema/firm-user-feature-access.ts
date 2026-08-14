import {
  pgTable,
  bigserial,
  integer,
  text,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { firmsTable } from "./firms";
import { usersTable } from "./users";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const firmUserFeatureAccessTable = pgTable(
  "firm_user_feature_access",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    firmId: integer("firm_id")
      .notNull()
      .references(() => firmsTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    featureKey: text("feature_key").notNull(),
    isEnabled: boolean("is_enabled").notNull().default(true),
    updatedByUserId: integer("updated_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    unqFirmUserFeature: uniqueIndex(
      "uq_firm_user_feature_access_firm_user_feature",
    ).on(t.firmId, t.userId, t.featureKey),
    idxFirmUser: index("idx_firm_user_feature_access_firm_user").on(
      t.firmId,
      t.userId,
    ),
    idxFirmFeature: index("idx_firm_user_feature_access_feature").on(
      t.firmId,
      t.featureKey,
    ),
  }),
);

export const insertFirmUserFeatureAccessSchema = createInsertSchema(
  firmUserFeatureAccessTable,
).omit({ id: true, createdAt: true, updatedAt: true });

export const selectFirmUserFeatureAccessSchema = createSelectSchema(
  firmUserFeatureAccessTable,
);

export type FirmUserFeatureAccess =
  typeof firmUserFeatureAccessTable.$inferSelect;
export type InsertFirmUserFeatureAccess = z.infer<
  typeof insertFirmUserFeatureAccessSchema
>;
