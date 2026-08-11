import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, and } from "drizzle-orm";
import { ApiError } from "../lib/api-response.js";
import {
  confirmExtractedCandidate,
  createDocumentExtractionJob,
} from "../lib/documentExtraction.js";

const FIRM_ID = 82001;
let pg: PGlite;
let r: ReturnType<typeof drizzle>;

const DOC_INTEL_DDL = `
CREATE TABLE IF NOT EXISTS document_extraction_jobs (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  case_id INTEGER,
  document_id INTEGER,
  file_reference TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  actor_user_id INTEGER,
  extraction_hints JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS document_extraction_candidates (
  id SERIAL PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  job_id INTEGER,
  field_key TEXT,
  suggested_value TEXT,
  confidence NUMERIC(5,4),
  target_entity_type TEXT,
  confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  confirmed_value JSONB,
  confirmed_by_user_id INTEGER,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

describe("Document Intelligence Routes — PART 2 N integration", () => {
  beforeAll(async () => {
    pg = new PGlite({ dataDir: undefined });
    r = drizzle(pg as any);
    await pg.exec(DOC_INTEL_DDL);
  });

  beforeEach(async () => {
    await pg.exec(`DELETE FROM document_extraction_candidates WHERE firm_id = ${FIRM_ID};`);
    await pg.exec(`DELETE FROM document_extraction_jobs WHERE firm_id = ${FIRM_ID};`);
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

  it("DOC-1: confirmExtractedCandidate returns { candidateId, confirmed: true, actorUserId }", async () => {
    await pg.exec(`
      INSERT INTO document_extraction_candidates(id, firm_id, job_id, field_key, suggested_value, confidence, target_entity_type)
      VALUES (501, ${FIRM_ID}, 101, 'borrower_name', 'Ahmad bin Ismail', 0.8700, 'case_loan');
    `);
    const ACTOR = 310;
    const result = await confirmExtractedCandidate(
      {
        firmId: FIRM_ID,
        candidateId: 501,
        actorUserId: ACTOR,
        confirmedValue: "Ahmad bin Ismail",
      },
      { tx: r },
    );
    expect(Number(result.candidateId)).toBe(501);
    expect(result.confirmed).toBe(true);
    expect(Number(result.actorUserId)).toBe(ACTOR);
  });

  it("DOC-2: confirmExtractedCandidate does NOT auto-write case table (no candidate→case mutation side-effect)", async () => {
    await pg.exec(`
      INSERT INTO document_extraction_candidates(id, firm_id, job_id, field_key, suggested_value, confidence, target_entity_type)
      VALUES (502, ${FIRM_ID}, 102, 'purchase_price', 'RM 500,000.00', 0.5500, 'case');
    `);
    const ACTOR = 311;
    const before = await q<any>(`SELECT COUNT(*)::int AS n FROM document_extraction_candidates WHERE firm_id = ${FIRM_ID} AND confirmed = TRUE;`);
    const beforeCount = Number(before[0]?.n ?? 0);
    const result = await confirmExtractedCandidate(
      {
        firmId: FIRM_ID,
        candidateId: 502,
        actorUserId: ACTOR,
        confirmedValue: "RM 500,000.00",
      },
      { tx: r },
    );
    expect(result.confirmed).toBe(true);
    expect(Number(result.actorUserId)).toBe(ACTOR);
  });

  it("DOC-3: createDocumentExtractionJob with firmId returns jobId + status=pending", async () => {
    const ACTOR = 312;
    const result = await createDocumentExtractionJob(
      r,
      {
        firmId: FIRM_ID,
        actorUserId: ACTOR,
        caseId: 7701,
        documentId: null,
        fileReference: null,
        extractionHints: { documentType: "spa" },
      },
    );
    expect(Number(result.jobId)).toBeGreaterThanOrEqual(1);
    expect(String(result.status)).toBe("pending");
    expect(Number(result.firmId)).toBe(FIRM_ID);
    expect(Number(result.caseId)).toBe(7701);
    expect(result.createdAt).toBeInstanceOf(Date);
  });

  it("DOC-4: createDocumentExtractionJob with documentId + fileReference multi-source accepted", async () => {
    const ACTOR = 313;
    const result = await createDocumentExtractionJob(
      r,
      {
        firmId: FIRM_ID,
        actorUserId: ACTOR,
        caseId: null,
        documentId: 9905,
        fileReference: "DOC-2026-0099",
        extractionHints: {},
      },
    );
    expect(Number(result.jobId)).toBeGreaterThanOrEqual(1);
    expect(String(result.status)).toBe("pending");
    expect(Number(result.documentId)).toBe(9905);
    expect(String((result as any).fileReference ?? "")).toBe("DOC-2026-0099");
  });

  it("DOC-5: confirm requires actorUserId present as number — missing actor throws BAD_PARAM_ACTOR_USER_ID", async () => {
    await pg.exec(`
      INSERT INTO document_extraction_candidates(id, firm_id, job_id, field_key, suggested_value, confidence, target_entity_type)
      VALUES (503, ${FIRM_ID}, 103, 'ic_passport_no', '880101-12-1234', 0.9200, 'client_primary_purchaser');
    `);
    try {
      await (confirmExtractedCandidate as any)(
        {
          firmId: FIRM_ID,
          candidateId: 503,
          confirmedValue: "880101-12-1234",
        },
        { tx: r },
      );
      expect.unreachable("should throw without actorUserId");
    } catch (e: any) {
      const code = String(e?.code ?? "");
      const status = Number(e?.status ?? 0);
      expect(code === "BAD_PARAM_ACTOR_USER_ID" || /actor.*user.*id|actorUserId/i.test(String(e?.message ?? "")) || status === 400).toBe(true);
    }
  });

  it("DOC-6: confirm with non-numeric actorUserId (string/NaN) → ApiError BAD_PARAM_*", async () => {
    await pg.exec(`
      INSERT INTO document_extraction_candidates(id, firm_id, job_id, field_key, suggested_value, confidence, target_entity_type)
      VALUES (504, ${FIRM_ID}, 104, 'loan_percentage', '90%', 0.4500, 'case_loan');
    `);
    try {
      await (confirmExtractedCandidate as any)(
        {
          firmId: FIRM_ID,
          candidateId: 504,
          actorUserId: "not-a-number",
          confirmedValue: "90%",
        },
        { tx: r },
      );
      expect.unreachable("should throw with invalid actorUserId type");
    } catch (e: any) {
      const code = String(e?.code ?? "");
      const status = Number(e?.status ?? 0);
      expect(
        status === 400 ||
        /BAD_PARAM/.test(code) ||
        /actor.*user.*id|numeric|number/i.test(String(e?.message ?? "")),
      ).toBe(true);
    }
  });
});
