import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, and } from "drizzle-orm";
import { userNotificationsTable } from "@workspace/db";
import { inspectPvForEscalation, emitPvEscalationIfNeeded } from "../modules/accounting/pv-escalation.js";
import { buildNotificationEventKey, type NotificationIdempotentKey } from "../modules/shared/notifications-canonical.js";

const pg = new PGlite();
const r = drizzle(pg);
const FIRM = 1;

function daysAgo(n: number): string {
  return `now() - interval '${n * 24} hours'`;
}

describe("PV Escalation notifications (PART 2C)", () => {
  beforeAll(async () => {
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS audit_logs (id serial);
      CREATE TABLE IF NOT EXISTS roles (id serial PRIMARY KEY, firm_id integer, name text);
      CREATE TABLE IF NOT EXISTS accounting_settings (id serial, firm_id integer);
      CREATE TABLE IF NOT EXISTS payment_vouchers (
        id serial PRIMARY KEY, firm_id integer, case_id integer, status text NOT NULL DEFAULT 'draft', fund_status text,
        responsible_lawyer_id integer, approving_partner_id integer,
        created_at timestamptz NOT NULL DEFAULT now(), approved_at timestamptz,
        completed_at timestamptz, paid_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS user_notifications (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL, user_id integer NOT NULL,
        source_type text NOT NULL, source_id integer NOT NULL, case_id integer,
        notification_type text NOT NULL, title text NOT NULL, message text,
        meta jsonb, is_read boolean NOT NULL DEFAULT false,
        status text NOT NULL DEFAULT 'unread',
        read_at timestamptz, acknowledged_at timestamptz, acknowledged_by integer,
        escalated_at timestamptz, resolved_at timestamptz, resolved_by integer,
        auto_resolved_at timestamptz, target_scope text, target_role_id integer,
        dismissible boolean NOT NULL DEFAULT true, severity text NOT NULL DEFAULT 'normal',
        status_set_at timestamptz, escalated_reason text, resolved_reason text,
        ip_address text, user_agent text, acknowledgement_due_at timestamptz,
        resolution_sla_due_at timestamptz, resolution_mode text NOT NULL DEFAULT 'MANUAL_ALLOWED',
        rule_code text, correlation_id text, entity_type text, entity_id integer,
        last_notified_at timestamptz, next_notify_at timestamptz, delivery_count integer NOT NULL DEFAULT 1,
        event_resolved_at timestamptz, event_auto_resolved_at timestamptz, event_escalated_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
      );
      -- stuck pv approved 180h ago — no transfer yet
      INSERT INTO payment_vouchers (id, firm_id, status, fund_status, responsible_lawyer_id, approving_partner_id, created_at, approved_at) VALUES
      (8001, ${FIRM}, 'approved', 'pending_transfer', 2001, 3001, ${daysAgo(8)}, ${daysAgo(8)}),
      (8002, ${FIRM}, 'paid',     'transferred',      2002, 3002, ${daysAgo(30)}, ${daysAgo(30)}),
      (8003, ${FIRM}, 'approved', 'pending_transfer', 2003, 3003, now(), now());
    `);
  });

  it("Deterministic event key PV_OVERDUE:{pvId}:{level}", () => {
    const k1: NotificationIdempotentKey = { kind: "pv_overdue", pvId: 8001, level: "L1_RESPONSIBLE" };
    const k2: NotificationIdempotentKey = { kind: "pv_overdue", pvId: 8001, level: "L2_PARTNER" };
    expect(buildNotificationEventKey(k1)).toBe("PV_OVERDUE:8001:L1_RESPONSIBLE");
    expect(buildNotificationEventKey(k2)).toBe("PV_OVERDUE:8001:L2_PARTNER");
  });

  it("Stale PV triggers L1 and L2 escalation; second emit bumps delivery_count, does NOT create duplicate rows", async () => {
    const ins = await inspectPvForEscalation(FIRM, 8001, { l1Hours: 1, l2Hours: 2, tx: r });
    expect(ins?.shouldEscalateL1).toBe(true);
    expect(ins?.shouldEscalateL2).toBe(true);
    expect(ins?.completed).toBe(false);
    const first = await emitPvEscalationIfNeeded(ins!, { tx: r });
    expect(first.created.length).toBeGreaterThanOrEqual(1);
    const second = await emitPvEscalationIfNeeded(ins!, { tx: r });
    expect(second.created.length).toBe(0);
    expect(second.updated.length).toBeGreaterThanOrEqual(1);
  });

  it("Completed PV → all active escalation rows automatically resolved", async () => {
    // Make active row first
    const inspectFresh = await inspectPvForEscalation(FIRM, 8002, { l1Hours: 1, l2Hours: 2, tx: r });
    expect(inspectFresh?.completed).toBe(true);
    // Ensure there's at least 1 notification first (e insert to trigger resolve
    await r.insert(userNotificationsTable).values({
      firmId: FIRM, userId: 2002, sourceType: "payment_voucher", sourceId: 8002,
      notificationType: "pv_overdue_responsible", title: "PV", message: "",
      ruleCode: `PV_OVERDUE:8002:L1_RESPONSIBLE:U2002`, entityType: "payment_voucher", entityId: 8002, status: "unread",
    } as any).execute();
    const after = await emitPvEscalationIfNeeded(inspectFresh!, { tx: r });
    expect(after.resolvedCount).toBeGreaterThanOrEqual(1);
  });

  it("Fresh PV (just approved) → no escalation created", async () => {
    const in3 = await inspectPvForEscalation(FIRM, 8003, { l1Hours: 72, l2Hours: 168, tx: r });
    expect(in3?.shouldEscalateL1).toBe(false);
    expect(in3?.shouldEscalateL2).toBe(false);
    const res = await emitPvEscalationIfNeeded(in3!, { tx: r });
    expect(res.created.length).toBe(0);
    expect(res.updated.length).toBe(0);
  });
});
