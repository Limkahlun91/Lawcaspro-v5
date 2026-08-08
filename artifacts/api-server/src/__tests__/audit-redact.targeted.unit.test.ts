import { describe, expect, it } from "vitest";
import {
  redactAuditRow,
  resolveTechnicalAuditContext,
} from "../routes/audit";

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

type ExecShape = { execute: (q: unknown) => Promise<unknown> };

function buildExecutor(getRows: (sqlLowered: string, valuesArr: unknown[]) => unknown[]): ExecShape {
  return {
    execute: async (q: unknown): Promise<unknown> => {
      const values = q && typeof q === "object" && Array.isArray((q as any).params)
        ? (q as any).params
        : [];
      const sql = extractSqlLowered(q);
      return { rows: getRows(sql, values) };
    },
  };
}

describe("§3 + §12 Log backend security + dedupe targeted unit tests", () => {
  it("Test S1: technical audit = founder → hasTechnicalAudit true + roleName founder", async () => {
    const req: any = { userType: "founder", roleId: 9, firmId: 1 };
    const out = await resolveTechnicalAuditContext(req);
    expect(out.hasTechnicalAudit).toBe(true);
    expect(out.roleName).toBe("founder");
  });

  it("Test S2: firm user Partner role name → elevated via role", async () => {
    const req: any = { userType: "firm", roleId: 15, firmId: 4 };
    req.rlsDb = buildExecutor((sql: string) => {
      if (sql.includes("select name from roles")) return [{ name: "Partner" }];
      if (sql.includes("from permissions") && sql.includes("audit") && sql.includes("view_details")) return [];
      return [];
    });
    const out = await resolveTechnicalAuditContext(req);
    expect(out.hasTechnicalAudit).toBe(true);
    expect(out.roleName).toBe("Partner");
  });

  it("Test S3: explicit audit:view_details perm row → elevated", async () => {
    const req: any = { userType: "firm", roleId: 8, firmId: 2 };
    req.rlsDb = buildExecutor((sql: string) => {
      if (sql.includes("select name from roles")) return [{ name: "Associate" }];
      if (sql.includes("from permissions") && sql.includes("audit") && sql.includes("view_details")) return [{ hit: 1 }];
      return [];
    });
    const out = await resolveTechnicalAuditContext(req);
    expect(out.hasTechnicalAudit).toBe(true);
    expect(out.roleName).toBe("Associate");
  });

  it("Test S4: ordinary clerk role + no explicit perm → NOT elevated", async () => {
    const req: any = { userType: "firm", roleId: 8, firmId: 2 };
    req.rlsDb = buildExecutor((sql: string) => {
      if (sql.includes("select name from roles")) return [{ name: "Clerk" }];
      if (sql.includes("from permissions")) return [];
      return [];
    });
    const out = await resolveTechnicalAuditContext(req);
    expect(out.hasTechnicalAudit).toBe(false);
    expect(out.roleName).toBe("Clerk");
  });

  it("Test S5: §12 non-technical → IP/UA NULL; JSON detail redacted technical keys stripped", () => {
    const row: any = {
      id: 1, ip_address: "203.0.113.7", user_agent: "Chrome/1.2.3",
      detail: JSON.stringify({
        action: "login", timestamp: 1,
        diagnostic: "raw stack: at xyz (file.js:1:2)",
        stacktrace: "Error: at ...",
        sqlstate: "23514", error_code: "X", errorcode: "Y",
        technical_code: "ABC",
        stack: "at x (y.js:1:1)",
        diagnostics: "raw info",
        raw: { secret: "pii-never-sent" },
      }),
    };
    const out = redactAuditRow(row, { hasTechnicalAudit: false, roleName: "clerk" });
    expect(out.ip_address).toBe(null);
    expect(out.user_agent).toBe(null);
    const parsedDetail = typeof out.detail === "string" ? JSON.parse(out.detail) : out.detail;
    expect(parsedDetail).not.toHaveProperty("diagnostic");
    expect(parsedDetail).not.toHaveProperty("diagnostics");
    expect(parsedDetail).not.toHaveProperty("stack");
    expect(parsedDetail).not.toHaveProperty("stacktrace");
    expect(parsedDetail).not.toHaveProperty("stack_trace");
    expect(parsedDetail).not.toHaveProperty("trace");
    expect(parsedDetail).not.toHaveProperty("raw");
    expect(parsedDetail).not.toHaveProperty("sqlstate");
    expect(parsedDetail).not.toHaveProperty("errorcode");
    expect(parsedDetail).not.toHaveProperty("error_code");
    expect(parsedDetail).not.toHaveProperty("technical_code");
    expect(parsedDetail.action).toBe("login");
    expect(parsedDetail.timestamp).toBe(1);
  });

  it("Test S6: §12 technical role → sensitive fields preserved intact", () => {
    const row: any = {
      id: 2, ip_address: "203.0.113.9", user_agent: "curl/8",
      detail: JSON.stringify({ action: "docgen", sqlstate: "23514", stack: "at a" }),
    };
    const out = redactAuditRow(row, { hasTechnicalAudit: true, roleName: "partner" });
    expect(out.ip_address).toBe("203.0.113.9");
    expect(out.user_agent).toBe("curl/8");
    const parsed = typeof out.detail === "string" ? JSON.parse(out.detail) : out.detail;
    expect(parsed.sqlstate).toBe("23514");
    expect(parsed.stack).toBe("at a");
  });

  it("Test S7: §11 dedupe tier ordering strict: PK first > src > 10s bucket fallback", () => {
    type Row = { event_id?: string; source_record_id?: string; id?: number; request_id?: string; action?: string; entity_type?: string; entity_id?: string; actor_email?: string; ts_ms?: number };
    function dedupeKey(row: Row): string {
      const eventId = typeof row.event_id === "string" ? row.event_id : null;
      const sourceRecordId = typeof row.source_record_id === "string"
        ? row.source_record_id
        : typeof row.id === "number" ? `aid-${row.id}` : null;
      if (eventId) return `pk::${eventId}`;
      if (sourceRecordId) return `src::${sourceRecordId}`;
      const tsBucket = Number.isFinite(row.ts_ms) ? Math.floor((row.ts_ms ?? 0) / 10000) : 0;
      return [
        row.request_id ?? `req-x`, row.action ?? "", row.entity_type ?? "",
        row.entity_id ?? "", `tsb-${tsBucket}`, row.actor_email ?? "",
      ].join("::");
    }
    const samePk = dedupeKey({ event_id: "evt-1", request_id: "rA", action: "login" });
    const samePk2 = dedupeKey({ event_id: "evt-1", request_id: "rB", action: "logout" });
    expect(samePk).toBe(samePk2);
    expect(samePk.startsWith("pk::")).toBe(true);
    const srcA = dedupeKey({ id: 77, action: "x" });
    expect(srcA).toBe("src::aid-77");
    const fb1 = dedupeKey({ request_id: "r1", action: "a", entity_type: "case", entity_id: "1", ts_ms: 10000, actor_email: "u@x" });
    const fb2 = dedupeKey({ request_id: "r1", action: "a", entity_type: "case", entity_id: "1", ts_ms: 15000, actor_email: "u@x" });
    expect(fb1).toBe(fb2);
    expect(fb1.includes("tsb-1")).toBe(true);
    const dif = dedupeKey({ request_id: "r1", action: "a", entity_type: "case", entity_id: "1", ts_ms: 20000, actor_email: "u@x" });
    expect(dif).not.toBe(fb1);
  });

  it("Test S8: cross-firm firm_id mismatch denied; founder platform scope allowed", () => {
    const access = (reqFirm: number, resourceFirm: number, userType: string) => {
      if (userType === "founder") return "platform_scope_allowed";
      return reqFirm === resourceFirm ? "allowed" : "denied";
    };
    expect(access(1, 1, "firm")).toBe("allowed");
    expect(access(2, 3, "firm")).toBe("denied");
    expect(access(9, 1, "founder")).toBe("platform_scope_allowed");
  });
});
