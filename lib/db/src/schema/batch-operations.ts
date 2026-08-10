import { sql } from "drizzle-orm";
import {
  pgTable,
  bigserial,
  text,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const batchOperationsTable = pgTable(
  "batch_operations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    firmId: integer("firm_id").notNull().references(() => firmsRef.id, { onDelete: "cascade" }),
    userId: integer("user_id").references(() => usersRef.id, { onDelete: "set null" }),
    userType: text("user_type").notNull().default("firm_user"),
    operationType: text("operation_type").notNull(),
    status: text("status").notNull().default("running"),
    requestedIds: jsonb("requested_ids").notNull().default(sql`'[]'::jsonb`),
    counts: jsonb("counts").notNull().default(sql`'{}'::jsonb`),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    output: jsonb("output").notNull().default(sql`'{}'::jsonb`),
    itemErrors: jsonb("item_errors").notNull().default(sql`'[]'::jsonb`),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => ({
    idxBatchOpsFirm: index("idx_batch_ops_firm").on(t.firmId, t.createdAt.desc()),
    idxBatchOpsFirmType: index("idx_batch_ops_firm_type").on(t.firmId, t.operationType, t.createdAt.desc()),
    idxBatchOpsUser: index("idx_batch_ops_user").on(t.userId, t.createdAt.desc()),
    idxBatchOpsStatus: index("idx_batch_ops_status").on(t.status, t.createdAt.desc()),
  }),
);

export type BatchOperation = typeof batchOperationsTable.$inferSelect;
export type InsertBatchOperation = typeof batchOperationsTable.$inferInsert;

// -----------------------------------------------------------------------------
// Forward refs — imported at bottom to avoid circular init
// -----------------------------------------------------------------------------
import { firmsTable as firmsRef } from "./firms";
import { usersTable as usersRef } from "./users";
