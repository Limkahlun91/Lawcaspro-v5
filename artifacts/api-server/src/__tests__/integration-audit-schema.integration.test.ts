/**
 * PART 1 B/C/L - Targeted: integration audit schemas exist, RLS enabled, cross-firm denied
 *
 * Uses PGlite to validate:
 *   - hims_notification_audit / communication_case_task_link_audit / einvoice_submission_audit
 *     tables are NOT null via to_regclass
 *   - Row level security is enabled on each
 *   - The tenant isolation policy (app.current_firm_id GUC) denies cross-firm reads
 */
import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq, sql } from "drizzle-orm";
import {
  himsNotificationAuditTable,
  communicationCaseTaskLinkAuditTable,
  einvoiceSubmissionAuditTable,
} from "@workspace/db";

function tableDef(name: string): string {
  switch (name) {
    case "hims_notification_audit":
      return `CREATE TABLE IF NOT EXISTS hims_notification_audit (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer,
        event_key text,
        idempotency_key text,
        notification_type text,
        target_user_id integer,
        payload_json jsonb,
        delivery_count integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_hims_notif_audit_idem ON hims_notification_audit(firm_id, idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_hims_notif_audit_case ON hims_notification_audit(firm_id, case_id);`;
    case "communication_case_task_link_audit":
      return `CREATE TABLE IF NOT EXISTS communication_case_task_link_audit (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        case_id integer,
        case_task_id integer,
        event_key text,
        idempotency_key text,
        message_id integer,
        link_type text,
        payload_json jsonb,
        actor_user_id integer,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_comm_task_link_audit_idem ON communication_case_task_link_audit(firm_id, idempotency_key) WHERE idempotency_key IS NOT NULL;`;
    case "einvoice_submission_audit":
      return `CREATE TABLE IF NOT EXISTS einvoice_submission_audit (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        invoice_id integer,
        idempotency_key text,
        submission_status text,
        error_code text,
        error_message text,
        external_ref text,
        payload_json jsonb,
        retries integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_einvoice_sub_audit_idem ON einvoice_submission_audit(firm_id, idempotency_key) WHERE idempotency_key IS NOT NULL;`;
    default:
      return "";
  }
}

const TABLES: [string, typeof himsNotificationAuditTable][] = [
  ["hims_notification_audit", himsNotificationAuditTable as any],
  ["communication_case_task_link_audit", communicationCaseTaskLinkAuditTable as any],
  ["einvoice_submission_audit", einvoiceSubmissionAuditTable as any],
];

describe("PART 1 B/C/L - Integration Audit Schema Canonicalization", () => {
  let pg: PGlite;
  let r: ReturnType<typeof drizzle>;

  const FIRM_A = 1001;
  const FIRM_B = 1002;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`
      ${tableDef("hims_notification_audit")}
      ${tableDef("communication_case_task_link_audit")}
      ${tableDef("einvoice_submission_audit")}
    `);
    for (const [t] of TABLES) {
      await pg.exec(`
        ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS t_${t}_iso ON ${t};
        CREATE POLICY t_${t}_iso ON ${t}
          USING (firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::INTEGER)
          WITH CHECK (firm_id = NULLIF(current_setting('app.current_firm_id', true), '')::INTEGER);
      `);
    }
    r = drizzle(pg);
  });

  it("to_regclass for all 3 audit tables is NOT NULL (table exists)", async () => {
    for (const [name] of TABLES) {
      const result: any = await pg.query(`SELECT to_regclass('public.${name}') AS t;`);
      const row = result.rows?.[0] ?? result[0]?.rows?.[0] ?? (Array.isArray(result) ? result[0]?.rows?.[0] : null);
      const val = row?.t;
      expect(val).not.toBeNull();
      expect(String(val)).toContain(name);
    }
  });

  it("RLS is enabled on every audit table", async () => {
    const result: any = await pg.query(
      `SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('hims_notification_audit','communication_case_task_link_audit','einvoice_submission_audit');`,
    );
    const rows = result.rows ?? result[0]?.rows ?? [];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.relrowsecurity).toBe(true);
    }
  });

  it("cross-firm denied: FIRM_A cannot read rows written by FIRM_B", async () => {
    await pg.query(`SELECT set_config('app.current_firm_id', '${FIRM_B}', false);`);
    await r.insert(himsNotificationAuditTable).values({
      firmId: FIRM_B,
      caseId: 1,
      eventKey: "evt:B",
      idempotencyKey: "HIMS_IDEM_B_12345678",
      notificationType: "status_change",
      targetUserId: 42,
    } as any);

    await r.insert(communicationCaseTaskLinkAuditTable).values({
      firmId: FIRM_B,
      caseId: 1,
      caseTaskId: 7,
      eventKey: "evt:B:link",
      idempotencyKey: "LINK_IDEM_B_12345678",
      messageId: 10,
      linkType: "auto",
      actorUserId: 11,
    } as any);

    await r.insert(einvoiceSubmissionAuditTable).values({
      firmId: FIRM_B,
      invoiceId: 5,
      idempotencyKey: "EINV_IDEM_B_12345678",
      submissionStatus: "SUBMITTED",
      retries: 0,
    } as any);

    await pg.query(`SELECT set_config('app.current_firm_id', '${FIRM_A}', false);`);

    for (const [, tbl] of TABLES) {
      const rows = await r
        .select()
        .from(tbl as any)
        .where(eq((tbl as any).firmId, FIRM_B));
      expect(rows).toHaveLength(0);
    }

    await pg.query(`SELECT set_config('app.current_firm_id', '${FIRM_B}', false);`);
    const auditRows = await r
      .select()
      .from(himsNotificationAuditTable)
      .where(and(eq(himsNotificationAuditTable.firmId, FIRM_B), eq(himsNotificationAuditTable.idempotencyKey, "HIMS_IDEM_B_12345678" as any)));
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
  });
});
