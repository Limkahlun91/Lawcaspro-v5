import { describe, expect, it } from "vitest";
import { writeDocumentGenerationLog } from "../routes/documents";

function extractSqlLowered(q: unknown): string {
  if (!q || typeof q !== "object") return "";
  const tryFns: Array<(x: any) => string> = [
    (x) => {
      const s = x?.strings;
      return Array.isArray(s) ? s.join(" ? ") : "";
    },
    (x) => {
      const chunks = x?.queryChunks;
      if (Array.isArray(chunks)) {
        const parts: string[] = [];
        for (const c of chunks) {
          if (c && typeof c === "object" && Array.isArray((c as any).value)) {
            parts.push((c as any).value.join(""));
          } else if (typeof c === "string") {
            parts.push(c);
          } else {
            parts.push("?");
          }
        }
        return parts.join("");
      }
      return "";
    },
    (x) => (typeof x?.sql === "string" ? x.sql : ""),
  ];
  for (const fn of tryFns) {
    const v = fn(q);
    if (v && v.length > 0) return v.toLowerCase();
  }
  return "";
}

describe("§2 Document Automation Logging reliability targeted tests", () => {
  type DbConnShape = { execute: (q: unknown) => Promise<unknown> };

  function buildConn(
    insertBehavior: "tier1_success" | "tier2_success" | "tier3_success" | "all_fail",
  ): { conn: DbConnShape; executeCount: { count: number }; insertIds: number[] } {
    const counter = { count: 0 };
    const ids: number[] = [];
    let logInsertAttempt = 0;
    const conn: DbConnShape = {
      execute: async (q: unknown): Promise<unknown> => {
        const sql = extractSqlLowered(q);
        counter.count++;
        if (sql.includes("to_regclass")) {
          if (sql.includes("document_generation_log_cases")) return { rows: [{ reg: "public.document_generation_log_cases" }] };
          return { rows: [{ reg: "public.document_generation_logs" }] };
        }
        if (sql.includes("insert into document_generation_log_cases")) return { rows: [] };
        if (!sql.includes("insert into document_generation_logs")) return { rows: [] };
        logInsertAttempt++;
        if (insertBehavior === "tier1_success") {
          const id = counter.count * 1000;
          ids.push(id);
          return { rows: [{ id }] };
        }
        if (insertBehavior === "tier2_success") {
          if (logInsertAttempt === 1) {
            const err: any = new Error("tier1 column missing");
            err.code = "42703";
            throw err;
          }
          const id = 1002;
          ids.push(id);
          return { rows: [{ id }] };
        }
        if (insertBehavior === "tier3_success") {
          if (logInsertAttempt <= 2) {
            const err: any = new Error(`tier${logInsertAttempt} constraint`);
            err.code = logInsertAttempt === 1 ? "23514" : "42703";
            throw err;
          }
          const id = 1003;
          ids.push(id);
          return { rows: [{ id }] };
        }
        const fail: any = new Error("unrecoverable DB constraint");
        fail.code = "55006";
        fail.sqlState = "55006";
        throw fail;
      },
    };
    return { conn, executeCount: counter, insertIds: ids };
  }

  it("Test L1: STARTED tier1 success → NO throw, id returned", async () => {
    const { conn, executeCount, insertIds } = buildConn("tier1_success");
    let threw = false;
    try {
      await writeDocumentGenerationLog(conn as any, {
        firmId: 9, userId: 3, actionType: "DOCUMENT_GENERATION_STARTED",
        caseIds: [11], jobId: "j-log-test-1", requestId: "req1",
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(executeCount.count).toBeGreaterThanOrEqual(1);
    expect(insertIds.length).toBeGreaterThanOrEqual(1);
  });

  it("Test L2: SUCCESS tier1 ok no throw", async () => {
    const { conn, executeCount, insertIds } = buildConn("tier1_success");
    let threw = false;
    try {
      await writeDocumentGenerationLog(conn as any, {
        firmId: 1, userId: 1, actionType: "DOCUMENT_GENERATION_SUCCEEDED",
        caseIds: [1], jobId: "j-log-2", requestId: "req2",
      });
    } catch { threw = true; }
    expect(threw).toBe(false);
    expect(executeCount.count).toBeGreaterThan(0);
    expect(insertIds.length).toBe(1);
  });

  it("Test L3: PARTIAL valid", async () => {
    const { conn, executeCount, insertIds } = buildConn("tier1_success");
    let threw = false;
    try {
      await writeDocumentGenerationLog(conn as any, {
        firmId: 1, userId: 1, actionType: "DOCUMENT_GENERATION_PARTIAL", caseIds: [1, 2],
      });
    } catch { threw = true; }
    expect(threw).toBe(false);
    expect(executeCount.count).toBeGreaterThan(0);
    expect(insertIds.length).toBe(1);
  });

  it("Test L4: FAILED valid", async () => {
    const { conn, executeCount, insertIds } = buildConn("tier1_success");
    let threw = false;
    try {
      await writeDocumentGenerationLog(conn as any, {
        firmId: 1, userId: 1, actionType: "DOCUMENT_GENERATION_FAILED", caseIds: [1, 2, 3],
      });
    } catch { threw = true; }
    expect(threw).toBe(false);
    expect(executeCount.count).toBeGreaterThan(0);
    expect(insertIds.length).toBe(1);
  });

  it("Test L5: ZIP_CREATED valid", async () => {
    const { conn, executeCount, insertIds } = buildConn("tier1_success");
    let threw = false;
    try {
      await writeDocumentGenerationLog(conn as any, {
        firmId: 1, userId: 1, actionType: "DOCUMENT_ZIP_CREATED", caseIds: [1, 2],
      });
    } catch { threw = true; }
    expect(threw).toBe(false);
    expect(executeCount.count).toBeGreaterThan(0);
    expect(insertIds.length).toBe(1);
  });

  it("Test L6: ZIP_DOWNLOAD_SUCCEEDED + ZIP_DOWNLOAD_FAILED valid", async () => {
    const { conn } = buildConn("tier1_success");
    let threw = false;
    try {
      await writeDocumentGenerationLog(conn as any, {
        firmId: 1, userId: 1, actionType: "DOCUMENT_ZIP_DOWNLOAD_SUCCEEDED", caseIds: [1],
      });
      await writeDocumentGenerationLog(conn as any, {
        firmId: 1, userId: 1, actionType: "DOCUMENT_ZIP_DOWNLOAD_FAILED", caseIds: [1],
      });
    } catch { threw = true; }
    expect(threw).toBe(false);
  });

  it("Test L7: SYSTEM_PRINT_PREPARED valid", async () => {
    const { conn, executeCount, insertIds } = buildConn("tier1_success");
    let threw = false;
    try {
      await writeDocumentGenerationLog(conn as any, {
        firmId: 1, userId: 1, actionType: "DOCUMENT_SYSTEM_PRINT_PREPARED", caseIds: [1],
      });
    } catch { threw = true; }
    expect(threw).toBe(false);
    expect(executeCount.count).toBeGreaterThan(0);
    expect(insertIds.length).toBe(1);
  });

  it("Test L8: fallback tier2 → observable (tier1 throws, tier2 succeeds)", async () => {
    const { conn, executeCount, insertIds } = buildConn("tier2_success");
    let threw = false;
    try {
      await writeDocumentGenerationLog(conn as any, {
        firmId: 2, userId: 4, actionType: "DOCUMENT_GENERATION_STARTED",
        caseIds: [22], jobId: "j-log-fallback", requestId: "req-fb",
      });
    } catch { threw = true; }
    expect(threw).toBe(false);
    expect(executeCount.count).toBeGreaterThanOrEqual(2);
    expect(insertIds.length).toBe(1);
    expect(insertIds[0]).toBe(1002);
  });

  it("Test L9: fallback tier3 → observable (tier1/tier2 throws, tier3 succeeds)", async () => {
    const { conn, executeCount, insertIds } = buildConn("tier3_success");
    let threw = false;
    try {
      await writeDocumentGenerationLog(conn as any, {
        firmId: 3, userId: 5, actionType: "DOCUMENT_GENERATION_PARTIAL",
        caseIds: [11, 12, 13], jobId: "j-log-fb-3", requestId: "req-fb3",
      });
    } catch { threw = true; }
    expect(threw).toBe(false);
    expect(executeCount.count).toBeGreaterThanOrEqual(3);
    expect(insertIds.length).toBe(1);
    expect(insertIds[0]).toBe(1003);
  });

  it("Test L10: DB all fail → function returns gracefully; NO throw ever", async () => {
    const { conn, executeCount } = buildConn("all_fail");
    let threw = false;
    try {
      await writeDocumentGenerationLog(conn as any, {
        firmId: 7, userId: 9, actionType: "DOCUMENT_GENERATION_SUCCEEDED",
        caseIds: [5, 6], jobId: "j-err-test", requestId: "req_xyz",
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(executeCount.count).toBeGreaterThanOrEqual(3);
  });
});
