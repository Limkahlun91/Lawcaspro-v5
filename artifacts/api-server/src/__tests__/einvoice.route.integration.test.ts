import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq, count } from "drizzle-orm";
import { ApiError } from "../lib/api-response.js";
import {
  einvoiceSubmissionAuditTable,
  einvoiceIntegrationsTable,
  invoicesTable,
} from "@workspace/db";
import { submitEinvoice } from "../modules/accounting/einvoice-adapter-boundary.service.js";

const FIRM_ID = 85001;
const INVOICE_ID = 9101;
let pg: PGlite;
let r: ReturnType<typeof drizzle>;

const EINVOICE_DDL = `
CREATE TABLE IF NOT EXISTS einvoice_integrations (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  provider TEXT NOT NULL DEFAULT 'lhdn_myinvois',
  status TEXT NOT NULL DEFAULT 'not_configured',
  display_name TEXT NOT NULL DEFAULT 'MyInvois (LHDN)',
  base_url TEXT,
  api_version TEXT DEFAULT 'v2024-06-01',
  tin TEXT,
  seller_id_type TEXT,
  seller_id_value TEXT,
  firm_msic_code TEXT,
  encrypted_credentials TEXT,
  encrypted_access_token TEXT,
  encrypted_refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  enable_auto_submit BOOLEAN NOT NULL DEFAULT FALSE,
  enable_auto_cancel BOOLEAN NOT NULL DEFAULT FALSE,
  enable_auto_validation BOOLEAN NOT NULL DEFAULT TRUE,
  enable_webhooks_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  webhook_secret_hash TEXT,
  auto_submit_cutoff_minutes INTEGER NOT NULL DEFAULT 1440,
  retry_max_attempts INTEGER NOT NULL DEFAULT 5,
  retry_backoff_seconds INTEGER NOT NULL DEFAULT 60,
  last_tested_at TIMESTAMPTZ,
  last_test_result TEXT,
  last_connected_at TIMESTAMPTZ,
  last_error TEXT,
  last_error_at TIMESTAMPTZ,
  idempotency_key TEXT,
  configured_by_user_id INTEGER,
  configured_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS einvoice_submission_audit (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  invoice_id INTEGER,
  integration_id INTEGER,
  action_type TEXT NOT NULL DEFAULT 'SUBMIT',
  submission_status TEXT NOT NULL DEFAULT 'BOUNDARY_CHECK',
  boundary_passed BOOLEAN NOT NULL DEFAULT FALSE,
  boundary_error_code TEXT,
  boundary_error_message TEXT,
  provider TEXT,
  einvoice_integration_status TEXT,
  idempotency_key TEXT,
  submission_request_json JSONB,
  submission_response_json JSONB,
  external_submission_uid TEXT,
  external_einvoice_uuid TEXT,
  external_status_url TEXT,
  external_qr_code_data TEXT,
  request_sent_at TIMESTAMPTZ,
  response_received_at TIMESTAMPTZ,
  retry_attempt INTEGER NOT NULL DEFAULT 0,
  scheduled_retry_at TIMESTAMPTZ,
  actor_user_id INTEGER,
  actor_role TEXT,
  client_request_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  invoice_no_snapshot TEXT,
  grand_total_snapshot NUMERIC(18,2),
  invoice_status_snapshot TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_einvoice_sub_audit_idem
  ON einvoice_submission_audit(firm_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  case_id INTEGER,
  quotation_id INTEGER,
  invoice_no TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  grand_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(18,2) NOT NULL DEFAULT 0,
  amount_due NUMERIC(18,2) NOT NULL DEFAULT 0,
  issued_date DATE,
  due_date DATE,
  notes TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  deleted_at TIMESTAMPTZ,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  einvoice_status TEXT NOT NULL DEFAULT 'DRAFT',
  einvoice_external_submission_id TEXT,
  einvoice_submitted_at TIMESTAMPTZ,
  einvoice_last_checked_at TIMESTAMPTZ,
  einvoice_error_code TEXT,
  einvoice_error_message TEXT,
  einvoice_retry_count INTEGER NOT NULL DEFAULT 0,
  einvoice_classification TEXT,
  einvoice_source_invoice_id INTEGER
);
`;

describe("E-Invoice Routes — PART 2 N submit boundary integration", () => {
  beforeAll(async () => {
    pg = new PGlite({ dataDir: undefined });
    r = drizzle(pg as any);
    await pg.exec(EINVOICE_DDL);
  });

  beforeEach(async () => {
    await r.delete(einvoiceSubmissionAuditTable).where(eq(einvoiceSubmissionAuditTable.firmId as any, FIRM_ID));
    await pg.exec(`DELETE FROM einvoice_integrations WHERE firm_id = ${FIRM_ID};`);
    await pg.exec(`DELETE FROM invoices WHERE firm_id = ${FIRM_ID};`);
    await pg.exec(`
      INSERT INTO invoices(id, firm_id, invoice_no, status, grand_total, amount_due)
      VALUES (${INVOICE_ID}, ${FIRM_ID}, 'INV-EINV-0001', 'issued', 1500.00, 1500.00);
    `);
  });

  async function q<T = any>(stmt: string): Promise<T[]> {
    const res: any = await pg.exec(stmt);
    if (res && Array.isArray(res)) {
      if (res[0] && Array.isArray(res[0].rows)) return res[0].rows as T[];
      if (res[0] && Array.isArray(res[0].fields)) {
        const out: any[] = [];
        const fields = res[0].fields.map((f: any) => typeof f === "string" ? f : f.name);
        for (const row of (res[0].rows ?? [])) {
          const o: any = {};
          fields.forEach((k: string, i: number) => { o[k] = row[i]; });
          out.push(o);
        }
        return out as T[];
      }
    }
    if (res && res.rows && Array.isArray(res.rows)) return res.rows as T[];
    if (res && Array.isArray(res)) return res as T[];
    return [];
  }

  it("EINV-1: POST /submit missing idempotencyKey → 400 EINVOICE_IDEMPOTENCY_KEY_REQUIRED", async () => {
    try {
      await (submitEinvoice as any)(
        {
          firmId: FIRM_ID,
          invoiceId: INVOICE_ID,
          actorUserId: 601,
        },
        { tx: r },
      );
      expect.unreachable("should throw without idempotencyKey");
    } catch (e: any) {
      const status = Number(e?.status ?? 0);
      const code = String(e?.code ?? "");
      expect(status).toBe(400);
      expect(code).toBe("EINVOICE_IDEMPOTENCY_KEY_REQUIRED");
    }
  });

  it("EINV-2: short idempotencyKey (<8 chars) → 400 EINVOICE_IDEMPOTENCY_KEY_REQUIRED", async () => {
    try {
      await submitEinvoice(
        {
          firmId: FIRM_ID,
          invoiceId: INVOICE_ID,
          idempotencyKey: "SHORT",
          actorUserId: 602,
        },
        { tx: r },
      );
      expect.unreachable("should throw with short key");
    } catch (e: any) {
      const status = Number(e?.status ?? 0);
      const code = String(e?.code ?? "");
      expect(status).toBe(400);
      expect(code).toBe("EINVOICE_IDEMPOTENCY_KEY_REQUIRED");
    }
  });

  it("EINV-3: integrations row missing (query succeeds, no row) → 400 NOT_CONFIGURED", async () => {
    try {
      await submitEinvoice(
        {
          firmId: FIRM_ID,
          invoiceId: INVOICE_ID,
          idempotencyKey: "VALID-IDEM-8CH",
          actorUserId: 603,
        },
        { tx: r },
      );
      expect.unreachable("should throw not configured");
    } catch (e: any) {
      const status = Number(e?.status ?? 0);
      const code = String(e?.code ?? "");
      expect(status).toBe(400);
      expect(code).toBe("EINVOICE_INTEGRATION_NOT_CONFIGURED");
      expect(code).not.toBe("EINVOICE_INTEGRATION_LOOKUP_FAILED");
    }
  });

  it("EINV-4: integrations lookup DB error (failing conn) → 503 LOOKUP_FAILED (not 400)", async () => {
    const makeThrowingThenable = () => {
      const err = new Error("simulated DB outage for einvoice_integrations");
      const thenable: any = {
        then(_onFulfilled: any, onRejected: any) {
          if (onRejected) return Promise.resolve(onRejected(err));
          return Promise.reject(err);
        },
        catch(onRejected: any) {
          return Promise.resolve(onRejected(err));
        },
        finally(onFinally: any) {
          onFinally?.();
          return this;
        },
      };
      thenable.where = () => thenable;
      thenable.limit = () => thenable;
      thenable.orderBy = () => thenable;
      return thenable;
    };
    const failingProxyDb = new Proxy(r, {
      get(target, prop, recv) {
        if (prop === "select") {
          return (...selectArgs: unknown[]) => {
            const inner = (target as any).select(...selectArgs);
            return new Proxy(inner, {
              get(innerTarget, innerProp, innerRecv) {
                if (innerProp === "from") {
                  return (...fromArgs: any[]) => {
                    if (fromArgs[0] === einvoiceIntegrationsTable) {
                      return makeThrowingThenable();
                    }
                    const fromInner = (innerTarget as any).from(...fromArgs);
                    return fromInner;
                  };
                }
                return Reflect.get(innerTarget, innerProp, innerRecv);
              },
            });
          };
        }
        return Reflect.get(target, prop, recv);
      },
    });
    const ACTOR_USER_ID = 604;
    await expect((async () =>
      submitEinvoice(
        {
          firmId: FIRM_ID,
          invoiceId: INVOICE_ID,
          idempotencyKey: "DB_DOWN_XYZ",
          actorUserId: ACTOR_USER_ID,
        },
        { tx: failingProxyDb },
      )
    )()).rejects.toMatchObject({
      status: 503,
      code: expect.stringMatching(/INTEGRATION_LOOKUP_FAILED/),
    });
  });

  it("EINV-5: same idempotency key submit twice → submission audit row count=1 (external adapter call count===1)", async () => {
    await pg.exec(`
      INSERT INTO einvoice_integrations(firm_id, provider, display_name, status, base_url, enable_auto_submit)
      VALUES (${FIRM_ID}, 'LHDN_SANDBOX', 'LHDN Test', 'active', 'https://api.test.invois.my', TRUE);
    `);
    const IDEM = "STABLE-EINV-KEY-8888";
    const before = await q<any>(`SELECT COUNT(*)::int AS n FROM einvoice_submission_audit WHERE firm_id = ${FIRM_ID} AND idempotency_key = '${IDEM}';`);
    expect(Number(before[0]?.n ?? 0)).toBe(0);

    const first = await submitEinvoice(
      {
        firmId: FIRM_ID,
        invoiceId: INVOICE_ID,
        idempotencyKey: IDEM,
        actorUserId: 605,
      },
      { tx: r },
    );
    expect(first.boundaryPassed).toBe(true);
    expect(first.canProceedToProvider).toBe(true);
    expect(Number(first.auditId)).toBeGreaterThanOrEqual(1);

    const second = await submitEinvoice(
      {
        firmId: FIRM_ID,
        invoiceId: INVOICE_ID,
        idempotencyKey: IDEM,
        actorUserId: 605,
      },
      { tx: r },
    );
    expect(Number(second.auditId)).toBe(Number(first.auditId));
    expect(second.canProceedToProvider).toBe(false);
    expect(second.providerSubmitQueued).toBe(false);

    const [cnt] = await r
      .select({ n: count() })
      .from(einvoiceSubmissionAuditTable)
      .where(and(
        eq(einvoiceSubmissionAuditTable.firmId as any, FIRM_ID),
        eq(einvoiceSubmissionAuditTable.idempotencyKey as any, IDEM),
      ));
    expect(Number(cnt.n)).toBe(1);
  });
});
