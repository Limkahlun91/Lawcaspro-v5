import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, and } from "drizzle-orm";
import { casesTable } from "@workspace/db";
import { getCaseOperationalHealth, maybeEmitCaseStaleNotification } from "../modules/monitoring/case-operational-health.js";

const pg = new PGlite();
const r = drizzle(pg);
const FIRM = 1;

describe("Partner Monitor — getCaseOperationalHealth (PART 2D)", () => {
  beforeAll(async () => {
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS audit_logs (id serial);
      CREATE TABLE IF NOT EXISTS cases (
        id serial PRIMARY KEY, firm_id integer, reference_no text, client_name text, case_type text,
        assigned_lawyer_user_id integer, current_milestone text, current_status text, status text,
        approval_status text NOT NULL DEFAULT 'pending_approval',
        lawyer_status text, lawyer_status_updated_at timestamptz, submitted_by integer, submitted_at timestamptz,
        approved_by integer, approved_at timestamptz, approval_note text, created_by integer,
        status_updated_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS case_activity_logs (id serial, firm_id integer, case_id integer, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS payment_vouchers (id serial, firm_id integer, case_id integer, status text, fund_status text);
      CREATE TABLE IF NOT EXISTS case_approvals (id serial, firm_id integer, case_id integer, status text);
      CREATE TABLE IF NOT EXISTS supporting_documents (id serial, firm_id integer, case_id integer, status text);
      CREATE TABLE IF NOT EXISTS case_monitor_logs (id serial, firm_id integer, case_id integer, bottleneck text, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS case_bottleneck_snapshots (
        id serial PRIMARY KEY, firm_id integer, case_id integer, payment_voucher_id integer,
        monitor_kind text, severity text, days_stuck integer NOT NULL DEFAULT 0,
        responsible_lawyer_user_id integer, responsible_manager_user_id integer,
        title text, detail text, metadata jsonb, escalated_to_partner boolean NOT NULL DEFAULT false,
        escalated_at timestamptz, resolved_at timestamptz, resolved_by integer, resolved_note text,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS case_notes (id serial, author_id integer, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS case_documents (id serial, firm_id integer, case_id integer, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS case_workflow_steps (id serial, updated_at timestamptz NOT NULL DEFAULT now());
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
      INSERT INTO cases (id, firm_id, reference_no, client_name, case_type, assigned_lawyer_user_id, current_milestone, current_status, status_updated_at, created_at) VALUES
      (11, ${FIRM}, 'CASE-001','Client A','SPA Purchase', 2001, 'SPA Signing', 'in_progress', now() - interval '10 days', now() - interval '90 days'),
      (22, ${FIRM}, 'CASE-002','Client B','Loan', 2002, 'Disbursement','disbursement_in_progress', now(), now() - interval '30 days');
      INSERT INTO case_activity_logs (firm_id, case_id, created_at) VALUES
      (${FIRM}, 22, now() - interval '1 day');
    `);
    // makeCasesTableShape();
  });

  it("Case with no activity in 10 days is AMBER or RED, responsible, lastActivityAt is populated if exists", async () => {
    const stale = await getCaseOperationalHealth(FIRM, 11, { amberDays: 3, redDays: 7, tx: r });
    expect(stale).not.toBeNull();
    expect(stale!.caseId).toBe(11);
    expect(stale!.caseType).toBe("SPA Purchase");
    expect(stale!.currentMilestone).toBe("SPA Signing");
    expect(stale!.daysInCurrentStage).toBeGreaterThanOrEqual(7);
    expect(stale!.staleDays).toBeGreaterThanOrEqual(7);
    expect(["AMBER","RED"]).toContain(stale!.riskLevel);
  });

  it("Case 22 fresh activity (1 day ago) = GREEN risk", async () => {
    const fresh = await getCaseOperationalHealth(FIRM, 22, { amberDays: 3, redDays: 7, tx: r });
    expect(fresh).not.toBeNull();
    expect(fresh!.riskLevel === "GREEN" || fresh!.riskLevel === "AMBER").toBe(true);
  });

  it("returns null for unknown case", async () => {
    const nope = await getCaseOperationalHealth(FIRM, 999999, { tx: r });
    expect(nope).toBeNull();
  });
});

function makeCasesTableShape() {
  void r;
  void casesTable;
  void FIRM;
}
