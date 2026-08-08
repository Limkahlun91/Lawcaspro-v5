import { describe, expect, it } from "vitest";
import { finalizeDocGenJobIfDone } from "../routes/documents";

type DbConnShape = {
  execute: (q: unknown) => Promise<unknown>;
};

function extractSqlLowered(q: unknown): string {
  if (!q || typeof q !== "object") return "";
  const tryGetSql: Array<(x: any) => string> = [
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
    (x) => {
      const s = x?.sql;
      return typeof s === "string" ? s : "";
    },
  ];
  for (const fn of tryGetSql) {
    const v = fn(q);
    if (v && typeof v === "string" && v.length > 0) return v.toLowerCase();
  }
  return "";
}

function buildConn(
  rowsByKeyword: Record<string, unknown[]>,
): { conn: DbConnShape } {
  const conn: DbConnShape = {
    execute: async (q: unknown): Promise<unknown> => {
      const sql = extractSqlLowered(q);
      const keysOrdered = Object.keys(rowsByKeyword);
      let matched: unknown[] = [];
      for (let i = 0; i < keysOrdered.length; i++) {
        const k = keysOrdered[i];
        if (sql.includes(k.toLowerCase())) {
          matched = rowsByKeyword[k];
          break;
        }
      }
      return { rows: matched };
    },
  };
  return { conn };
}

describe("Document Automation §8/§9/§G: finalizeDocGenJobIfDone + counters targeted tests", () => {
  it("Test B (§1.B): 6 case × 1 template all success → finalizing + 6/6/0 + finalized=true", async () => {
    const { conn } = buildConn({
      "from document_generation_job_items": [
        { total: 6, success: 6, failed: 0, pending: 0, running: 0 },
      ],
      "from document_generation_jobs where id": [
        {
          status: "running",
          action: "generate",
          download_object_path: null,
          download_file_name: null,
          download_mime_type: null,
          config: {},
          case_ids: [101, 102, 103, 104, 105, 106],
          user_id: 7,
        },
      ],
      "to_regclass": [{ reg: "public.document_generation_logs" }],
    });
    const out = await finalizeDocGenJobIfDone(conn as any, { firmId: 99, jobId: "job_b_all_success" });
    expect(out.progress.total).toBe(6);
    expect(out.progress.success).toBe(6);
    expect(out.progress.failed).toBe(0);
    expect(out.progress.pending).toBe(0);
    expect(out.progress.running).toBe(0);
    expect(out.status).toBe("finalizing");
    expect(out.finalized).toBe(true);
  });

  it("Test C (§1.C): 5 success 1 failed → completed_with_errors partial finalizing", async () => {
    const { conn } = buildConn({
      "from document_generation_job_items": [
        { total: 6, success: 5, failed: 1, pending: 0, running: 0 },
      ],
      "from document_generation_jobs where id": [
        {
          status: "running", action: "generate",
          download_object_path: "/firm/z.zip", download_file_name: "z.zip",
          case_ids: [1, 2], user_id: 1,
        },
      ],
      "to_regclass": [{ reg: "public.document_generation_logs" }],
    });
    const out = await finalizeDocGenJobIfDone(conn as any, { firmId: 1, jobId: "job_c_partial" });
    expect(out.progress).toEqual(expect.objectContaining({ total: 6, success: 5, failed: 1 }));
    expect(out.status).toBe("finalizing");
    expect(out.finalized).toBe(true);
  });

  it("Test D (§1.D): 0 success 6 fail → FAILED statusToSet failed", async () => {
    const { conn } = buildConn({
      "from document_generation_job_items": [
        { total: 6, success: 0, failed: 6, pending: 0, running: 0 },
      ],
      "from document_generation_jobs where id": [
        { status: "running", action: "generate", download_object_path: null, case_ids: [], user_id: 3 },
      ],
      "to_regclass": [{ reg: "public.document_generation_logs" }],
    });
    const out = await finalizeDocGenJobIfDone(conn as any, { firmId: 1, jobId: "job_d_all_fail" });
    expect(out.progress).toEqual(expect.objectContaining({ total: 6, success: 0, failed: 6 }));
    expect(out.status).toBe("failed");
    expect(out.finalized).toBe(true);
  });

  it("Test G (§1.G): already finalized completed → refresh twice = same state (idempotent)", async () => {
    const { conn } = buildConn({
      "from document_generation_job_items": [
        { total: 6, success: 6, failed: 0, pending: 0, running: 0 },
      ],
      "from document_generation_jobs where id": [
        {
          status: "completed", action: "generate",
          download_object_path: "/firm/xxx.zip",
          download_file_name: "xxx.zip",
          case_ids: [1, 2, 3, 4, 5, 6],
          user_id: 11,
        },
      ],
    });
    const first = await finalizeDocGenJobIfDone(conn as any, { firmId: 1, jobId: "job_finalized_before" });
    expect(first.finalized).toBe(false);
    expect(first.status).toBe("completed");
    expect(first.progress.total).toBe(6);
    expect(first.downloadObjectPath).toBe("/firm/xxx.zip");
    expect(first.downloadFileName).toBe("xxx.zip");
    const second = await finalizeDocGenJobIfDone(conn as any, { firmId: 1, jobId: "job_finalized_before" });
    expect(second.status).toBe(first.status);
    expect(second.finalized).toBe(first.finalized);
    expect(second.progress).toEqual(first.progress);
    expect(second.downloadObjectPath).toBe(first.downloadObjectPath);
    expect(second.downloadFileName).toBe(first.downloadFileName);
  });

  it("Test B1: still running 1 pending → not finalized and status running", async () => {
    const { conn } = buildConn({
      "from document_generation_job_items": [
        { total: 3, success: 1, failed: 1, pending: 1, running: 0 },
      ],
      "from document_generation_jobs where id": [{ status: "running", case_ids: [1], user_id: 1 }],
    });
    const out = await finalizeDocGenJobIfDone(conn as any, { firmId: 1, jobId: "job_still_running" });
    expect(out.finalized).toBe(false);
    expect(out.status).toBe("running");
  });
});
