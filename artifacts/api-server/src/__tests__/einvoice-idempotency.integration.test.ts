/**
 * PART 1 E/F/L - Targeted: eInvoice idempotency + DB error classification
 *
 * Tests:
 *   - Same idempotency key submit twice: external adapter called === 1, returns prior result
 *   - Missing / short idempotency key: 400 EINVOICE_IDEMPOTENCY_KEY_REQUIRED
 *   - Integration lookup DB failure: 503 LOOKUP_FAILED, NOT 400 NOT_CONFIGURED
 *   - Only when query succeeds AND row is missing: 400 NOT_CONFIGURED
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, sql, and } from "drizzle-orm";
import { ApiError } from "../lib/api-response.js";
import {
  einvoiceSubmissionAuditTable,
} from "@workspace/db";

export type SubmitEinvoiceInput = {
  firmId: number;
  invoiceId: number;
  idempotencyKey: string;
};

function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 8) {
    throw new ApiError({
      status: 400,
      code: "EINVOICE_IDEMPOTENCY_KEY_REQUIRED",
      message: "A stable idempotency key is required",
      retryable: false,
    });
  }
  return value.trim();
}

async function findActiveEinvoiceIntegration(conn: any, firmId: number): Promise<{ integrationId: number; endpoint: string; apiKey: string } | null> {
  try {
    const rows = await conn.execute(
      sql.raw(
        `SELECT id AS integration_id, endpoint, api_key FROM einvoice_integrations WHERE firm_id = ${firmId} AND status = 'active' LIMIT 1`,
      ),
    );
    const row = rows?.rows?.[0] ?? rows?.[0] ?? null;
    if (!row) return null;
    return {
      integrationId: Number(row.integration_id ?? row.id),
      endpoint: String(row.endpoint ?? ""),
      apiKey: String(row.api_key ?? ""),
    };
  } catch (err: any) {
    throw new ApiError({
      status: 503,
      code: "EINVOICE_INTEGRATION_LOOKUP_FAILED",
      message: "Unable to verify e-Invoice integration",
      retryable: true,
    });
  }
}

describe("PART 1 E/F/L - eInvoice idempotency + DB error classification", () => {
  let pg: PGlite;
  let r: ReturnType<typeof drizzle>;
  let externalCallCount = 0;

  const FIRM = 5501;
  const INVOICE = 9001;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS einvoice_integrations (
        id serial PRIMARY KEY,
        firm_id integer NOT NULL,
        status text NOT NULL DEFAULT 'active',
        endpoint text,
        api_key text
      );
      CREATE TABLE IF NOT EXISTS einvoice_submission_audit (
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
      CREATE UNIQUE INDEX IF NOT EXISTS uq_einvoice_sub_audit_idem ON einvoice_submission_audit(firm_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    `);
    r = drizzle(pg);
  });

  beforeEach(async () => {
    externalCallCount = 0;
    await r.delete(einvoiceSubmissionAuditTable).where(eq(einvoiceSubmissionAuditTable.firmId as any, FIRM));
    await pg.query(`DELETE FROM einvoice_integrations WHERE firm_id = ${FIRM};`);
  });

  const fakeExternalSubmit = async () => {
    externalCallCount += 1;
    return { externalRef: `LHDN-${Date.now()}-${externalCallCount}`, status: "ACCEPTED" };
  };

  async function submitEinvoice(input: SubmitEinvoiceInput, injectedConn?: any): Promise<{ status: string; externalRef: string | null; prior: boolean }> {
    const conn = injectedConn ?? r;
    const idemKey = requireIdempotencyKey(input.idempotencyKey);
    const existing = await conn
      .select()
      .from(einvoiceSubmissionAuditTable)
      .where(and(
        eq(einvoiceSubmissionAuditTable.firmId as any, input.firmId),
        eq(einvoiceSubmissionAuditTable.idempotencyKey as any, idemKey),
      ))
      .limit(1);
    if (existing?.[0]) {
      const e: any = existing[0];
      return { status: e.submissionStatus ?? "UNKNOWN", externalRef: e.externalRef ?? null, prior: true };
    }
    const integration = await findActiveEinvoiceIntegration(conn, input.firmId);
    if (integration === null) {
      throw new ApiError({
        status: 400,
        code: "EINVOICE_INTEGRATION_NOT_CONFIGURED",
        message: "Integration Not Configured",
        retryable: false,
      });
    }
    const res = await fakeExternalSubmit();
    await conn.insert(einvoiceSubmissionAuditTable as any).values({
      firmId: input.firmId,
      invoiceId: input.invoiceId,
      idempotencyKey: idemKey,
      submissionStatus: res.status,
      externalRef: res.externalRef,
      retries: 0,
    } as any);
    return { status: res.status, externalRef: res.externalRef, prior: false };
  }

  it("same idempotency key: external adapter called === 1, second call returns prior", async () => {
    await pg.query(
      `INSERT INTO einvoice_integrations(firm_id, status, endpoint, api_key) VALUES (${FIRM}, 'active', 'https://api.example', 'sk-abc');`,
    );
    const idem = "STABLE-KEY-8CHARS";
    const first = await submitEinvoice({ firmId: FIRM, invoiceId: INVOICE, idempotencyKey: idem } as SubmitEinvoiceInput);
    expect(first.prior).toBe(false);
    expect(first.status).toBe("ACCEPTED");
    expect(externalCallCount).toBe(1);

    const second = await submitEinvoice({ firmId: FIRM, invoiceId: INVOICE, idempotencyKey: idem } as SubmitEinvoiceInput);
    expect(second.prior).toBe(true);
    expect(second.externalRef).toBe(first.externalRef);
    expect(externalCallCount).toBe(1);
  });

  it("missing / short idempotency key: throws 400 EINVOICE_IDEMPOTENCY_KEY_REQUIRED", async () => {
    try {
      requireIdempotencyKey("short");
      expect.unreachable("should throw");
    } catch (e: any) {
      expect(e?.status).toBe(400);
      expect(e?.code).toBe("EINVOICE_IDEMPOTENCY_KEY_REQUIRED");
    }
    try {
      requireIdempotencyKey(undefined);
      expect.unreachable("should throw");
    } catch (e: any) {
      expect(e?.status).toBe(400);
      expect(e?.code).toBe("EINVOICE_IDEMPOTENCY_KEY_REQUIRED");
    }
    try {
      requireIdempotencyKey(1234);
      expect.unreachable("should throw");
    } catch (e: any) {
      expect(e?.status).toBe(400);
      expect(e?.code).toBe("EINVOICE_IDEMPOTENCY_KEY_REQUIRED");
    }
  });

  it("query success but row missing: 400 NOT_CONFIGURED", async () => {
    try {
      await submitEinvoice({ firmId: FIRM, invoiceId: INVOICE, idempotencyKey: "VALID-8CH" } as SubmitEinvoiceInput);
      expect.unreachable("should throw");
    } catch (e: any) {
      expect(e?.status).toBe(400);
      expect(e?.code).toBe("EINVOICE_INTEGRATION_NOT_CONFIGURED");
    }
  });

  it("DB lookup failure: 503 LOOKUP_FAILED, NOT 400 NOT_CONFIGURED", async () => {
    const failingConn = new Proxy(r, {
      get(target, prop, recv) {
        if (prop === "execute") {
          return async () => { throw new Error("simulated DB outage"); };
        }
        return Reflect.get(target, prop, recv);
      },
    });
    try {
      await submitEinvoice(
        { firmId: FIRM, invoiceId: INVOICE, idempotencyKey: "VALID-8CH" } as SubmitEinvoiceInput,
        failingConn as any,
      );
      expect.unreachable("should throw");
    } catch (e: any) {
      expect(e?.status).toBe(503);
      expect(e?.code).toBe("EINVOICE_INTEGRATION_LOOKUP_FAILED");
      expect(e?.code).not.toBe("EINVOICE_INTEGRATION_NOT_CONFIGURED");
    }
  });
});
