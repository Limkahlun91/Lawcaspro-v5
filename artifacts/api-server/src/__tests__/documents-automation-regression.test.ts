import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Application } from "express";
import yazl from "yazl";
import { PDFDocument, StandardFonts } from "pdf-lib";

const TEST_JOB_ID = "11111111-1111-1111-1111-111111111111";
let lastUploadedZipBytes: Buffer | null = null;
let mockJobStatus: "finalizing" | "completed" | "running" = "finalizing";
let mockDownloadObjectPath: string | null = null;
let lockHeld = false;
let delayNextJobSelectMs = 0;

type FakeDb = {
  execute: (query?: unknown) => Promise<unknown>;
  select: (sel?: unknown) => {
    from: (table: unknown) => {
      where: (cond?: unknown) => unknown;
      orderBy: (...args: unknown[]) => unknown;
      limit: (n: number) => unknown;
    };
  };
};

var sharedDb: unknown;

function queryable(getRows: () => Promise<unknown[]>) {
  const q: any = {};
  q.then = (resolve: (v: unknown[]) => unknown, reject: (e: unknown) => unknown) => getRows().then(resolve, reject);
  q.where = () => q;
  q.orderBy = () => q;
  q.limit = () => q;
  return q;
}

function extractZipEntryNames(zipBytes: Buffer): string[] {
  const out: string[] = [];
  for (let i = 0; i + 46 < zipBytes.length; i++) {
    if (zipBytes.readUInt32LE(i) !== 0x02014b50) continue;
    const fileNameLen = zipBytes.readUInt16LE(i + 28);
    const extraLen = zipBytes.readUInt16LE(i + 30);
    const commentLen = zipBytes.readUInt16LE(i + 32);
    const nameStart = i + 46;
    const nameEnd = nameStart + fileNameLen;
    if (nameEnd > zipBytes.length) break;
    out.push(zipBytes.slice(nameStart, nameEnd).toString("utf8"));
    i = nameEnd + extraLen + commentLen - 1;
  }
  return out;
}

function makeDb(): FakeDb {
  const queryText = (query: any): string => {
    const chunks = query?.queryChunks;
    if (!Array.isArray(chunks)) return "";
    return chunks.map((c: any) => (typeof c === "string" ? c : "?")).join("");
  };

  const db: FakeDb = {
    execute: async (query?: unknown) => {
      const text = queryText(query as any);
      if (text.includes("pg_try_advisory_lock")) {
        const locked = !lockHeld;
        if (locked) lockHeld = true;
        return [{ locked }];
      }
      if (text.includes("pg_advisory_unlock")) {
        lockHeld = false;
        return [{ unlocked: true }];
      }
      if (text.includes("SELECT show_master_documents FROM firms")) {
        return [{ show_master_documents: true }];
      }
      if (
        text.includes("COUNT(*) AS total") &&
        text.includes("FROM document_generation_job_items")
      ) {
        return [{ total: 2, success: 1, failed: 1, pending: 0, running: 0 }];
      }
      if (text.includes("FROM cases c") && text.includes("WHERE c.id")) {
        return [{
          id: 3,
          reference_no: "CON-001",
          case_type: "conveyancing",
          parcel_no: null,
          spa_price: null,
          apdl_price: null,
          developer_discount: null,
          bumiputra_discount: null,
          purchase_mode: "cash",
          loan_party_type: null,
          title_type: "individual",
          status: "active",
          spa_details: null,
          property_details: null,
          loan_details: null,
          borrowers: null,
          company_details: null,
          project_name: null,
          project_phase: null,
          project_type: null,
          project_title_type: null,
          project_title_subtype: null,
          project_master_title_no: null,
          project_master_title_size: null,
          project_mukim: null,
          project_daerah: null,
          project_negeri: null,
          project_land_use: null,
          project_development_condition: null,
          project_developer_name: null,
          unit_category: null,
          project_extra_fields: null,
          developer_name: null,
          developer_reg_no: null,
          developer_address: null,
          developer_business_address: null,
          developer_contact: null,
          developer_phone: null,
          developer_email: null,
          developer_contacts_json: null,
        }];
      }
      if (text.includes("FROM case_purchasers cp") && text.includes("JOIN clients cl")) {
        return [{ case_id: 3, name: "LIMKL" }];
      }
      if (text.includes("FROM document_templates") && text.includes("WHERE firm_id")) {
        const rows: any[] = [];
        for (let i = 1; i <= 25; i++) {
          rows.push({
            id: i,
            name: i === 7 ? "Acting Letter" : `Template ${i}`,
            object_path: `/objects/templates/firm/1/template-${i}.pdf`,
            file_name: `template-${i}.pdf`,
            mime_type: "application/pdf",
            is_template_capable: true,
            print_mode: "double",
          });
        }
        return rows;
      }
      if (text.includes("FROM document_generation_jobs")) {
        if (delayNextJobSelectMs > 0) {
          const ms = delayNextJobSelectMs;
          delayNextJobSelectMs = 0;
          await new Promise<void>((r) => setTimeout(r, ms));
        }
        return [{
          id: TEST_JOB_ID,
          firm_id: 1,
          status: mockJobStatus,
          action: "download",
          case_ids: [3],
          config: { outputFormat: "pdf", templates: [{ source: "firm", id: 7 }] },
          download_object_path: mockDownloadObjectPath,
          download_file_name: mockDownloadObjectPath ? "Document_Automation_2026-06-03.zip" : null,
          download_mime_type: mockDownloadObjectPath ? "application/zip" : null,
        }];
      }
      if (text.includes("FROM document_generation_job_items")) {
        return [
          {
            id: 1,
            job_id: TEST_JOB_ID,
            firm_id: 1,
            case_id: 3,
            status: "success",
            object_path: "/objects/temp-generated/1/document-generation-jobs/item-1.pdf",
            file_name: "Acting Letter.pdf",
            mime_type: "application/pdf",
            template_name: "Acting Letter",
            template_source: "firm",
            template_id: 7,
            platform_document_id: null,
          },
          {
            id: 2,
            job_id: TEST_JOB_ID,
            firm_id: 1,
            case_id: 3,
            status: "failed",
            object_path: null,
            file_name: null,
            mime_type: null,
            template_name: "Template 2",
            template_source: "firm",
            template_id: 2,
            platform_document_id: null,
          },
        ];
      }
      if (text.includes("FROM cases") && text.includes("id IN")) {
        const rows: any[] = [];
        for (let i = 1; i <= 20; i++) {
          rows.push({ id: i, reference_no: i === 3 ? "CON-001" : `CON-${String(i).padStart(3, "0")}` });
        }
        return rows;
      }
      return [];
    },
    select: (_sel?: unknown) => ({
      from: (_table: unknown) => {
        const q = queryable(async () => []);
        return q;
      },
    }),
  };
  return db;
}

vi.mock("@workspace/db", async (orig) => {
  const actual = await orig<typeof import("@workspace/db")>();
  const fakeDb = makeDb();
  sharedDb = fakeDb;
  return { ...actual, db: fakeDb as unknown as typeof actual.db };
});

vi.mock("../lib/auth", async (orig) => {
  const actual = await orig<typeof import("../lib/auth")>();
  return {
    ...actual,
    requireAuth: (_req: any, _res: any, next: any) => next(),
    requireFirmUser: (req: any, _res: any, next: any) => {
      req.userId = 10;
      req.userType = "firm_user";
      req.firmId = 1;
      req.roleId = 7;
      req.rlsDb = sharedDb;
      next();
    },
    requireFirmUserSession: (req: any, _res: any, next: any) => {
      req.userId = 10;
      req.userType = "firm_user";
      req.firmId = 1;
      req.roleId = 7;
      req.rlsDb = sharedDb;
      next();
    },
    requirePermission: () => (_req: any, _res: any, next: any) => next(),
    writeAuditLog: async () => undefined,
  };
});

vi.mock("../lib/objectStorage.js", async (orig) => {
  const actual = await orig<typeof import("../lib/objectStorage.js")>();
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  page.drawText("Hello PDF", { x: 50, y: 780, size: 12, font });
  const pdfBytes = Buffer.from(await pdfDoc.save());
  class SupabaseStorageServiceMock {
    assertConfigured() {
    }
    async fetchPrivateObjectResponse(_objectPath: string, _opts?: { timeoutMs?: number }) {
      return new Response(pdfBytes, {
        headers: {
          "content-type": "application/pdf",
          "content-length": String(pdfBytes.length),
        },
      });
    }
    async privateObjectExists() {
      return true;
    }
    async uploadPrivateObject() {
      const args = arguments[0] as any;
      if (args && Buffer.isBuffer(args.fileBytes)) {
        lastUploadedZipBytes = args.fileBytes;
      }
    }
    async deletePrivateObject() {
    }
  }
  return {
    ...actual,
    SupabaseStorageService: SupabaseStorageServiceMock as any,
    getSupabaseStorageConfigError: () => null,
  };
});

vi.mock("../services/dashboard-stats", () => ({
  computeDashboardStats: async () => ({
    ok: true,
    degraded: false,
    warnings: [],
    unavailableFields: [],
    totalCases: 0,
    activeCases: 0,
    completedCases: 0,
    totalClients: 0,
    totalProjects: 0,
    totalDevelopers: 0,
    milestoneSections: [],
    milestoneCards: [],
    recentCases: [],
    commsThisMonth: 0,
    completionSlaOverdue: [],
    cashCases: 0,
    loanCases: 0,
    masterTitleCases: 0,
    individualTitleCases: 0,
    strataTitleCases: 0,
  }),
}));

let app: Application;

beforeAll(async () => {
  const mod = await import("../app");
  app = mod.default;
});

describe("Documents automation regressions", () => {
  it("POST /api/documents/automation/generate-job returns 202 and jobId (firm only)", async () => {
    const res = await request(app).post("/api/documents/automation/generate-job?blind=true").send({
      caseIds: [3],
      templateIds: [7],
      templates: [{ source: "firm", id: 7 }],
      config: { action: "download" },
    });
    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty("ok", true);
    expect(typeof res.body.jobId).toBe("string");
    expect(res.body.jobId.length).toBeGreaterThan(10);
    expect(res.body).toHaveProperty("status");
  });

  it("POST /api/documents/automation/generate-job supports 1 case x 12 templates", async () => {
    const templates = Array.from({ length: 12 }, (_, i) => ({ source: "firm" as const, id: i + 1 }));
    const res = await request(app)
      .post("/api/documents/automation/generate-job?blind=true")
      .send({ caseIds: [3], templates, config: { action: "download", outputFormat: "pdf" } });
    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty("ok", true);
    expect(typeof res.body.jobId).toBe("string");
  });

  it("POST /api/documents/automation/generate-job supports 5 cases x 3 templates", async () => {
    const caseIds = Array.from({ length: 5 }, (_, i) => i + 1);
    const templates = Array.from({ length: 3 }, (_, i) => ({ source: "firm" as const, id: i + 1 }));
    const res = await request(app)
      .post("/api/documents/automation/generate-job?blind=true")
      .send({ caseIds, templates, config: { action: "download", outputFormat: "pdf" } });
    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty("ok", true);
    expect(typeof res.body.jobId).toBe("string");
  });

  it("GET /api/firm-settings returns 200 with defaults even without firm_settings row", async () => {
    const res = await request(app).get("/api/firm-settings");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("ok", true);
    expect(res.body).toHaveProperty("settings");
    expect(res.body.settings).toHaveProperty("useMasterDocuments", true);
    expect(res.body.settings).toHaveProperty("enableFirmLetterhead", false);
  });

  it("GET /api/hub/documents returns 200 (no 503)", async () => {
    const res = await request(app).get("/api/hub/documents");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("ok", true);
    expect(Array.isArray(res.body.documents)).toBe(true);
    expect(Array.isArray(res.body.folders)).toBe(true);
  });

  it("GET /api/dashboard returns 200 and does not require accounting", async () => {
    const res = await request(app).get("/api/dashboard");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("ok", true);
    expect(res.body).toHaveProperty("dashboard");
    expect(res.body.dashboard).toHaveProperty("totalCases");
    expect(res.body.dashboard).toHaveProperty("milestoneSections");
    expect(Array.isArray(res.body.dashboard.milestoneSections)).toBe(true);
  });

  it("GET /api/documents/jobs/:jobId/download returns 409 JOB_NOT_COMPLETED while finalizing", async () => {
    mockJobStatus = "finalizing";
    mockDownloadObjectPath = null;
    const res = await request(app).get(`/api/documents/jobs/${TEST_JOB_ID}/download`);
    expect(res.status).toBe(409);
    expect(res.body?.ok).toBe(false);
    expect(res.body?.error?.code).toBe("JOB_NOT_COMPLETED");
  });

  it("GET /api/documents/jobs/:jobId/download returns bytes only after completed", async () => {
    mockJobStatus = "completed";
    mockDownloadObjectPath = "/objects/temp-generated/1/document-generation-jobs/download.zip";
    const res = await request(app).get(`/api/documents/jobs/${TEST_JOB_ID}/download`);
    expect(res.status).toBe(200);
    expect(typeof res.headers["content-type"]).toBe("string");
    expect(Number(res.headers["content-length"] ?? "0")).toBeGreaterThan(0);
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect((res.body as Buffer).length).toBeGreaterThan(100);
  });

  it("POST /api/documents/automation/generate-now returns 410 deprecated", async () => {
    const res = await request(app)
      .post("/api/documents/automation/generate-now")
      .send({ caseIds: [3], templates: [{ source: "firm", id: 7 }], config: { action: "download", outputFormat: "pdf" } });
    expect(res.status).toBe(410);
    expect(res.body).toHaveProperty("ok", false);
    expect(res.body?.error?.code).toBe("DEPRECATED");
  });

  it("POST /api/cases/bulk/generate-documents-zip returns 202 JSON wrapper (no blob)", async () => {
    const res = await request(app)
      .post("/api/cases/bulk/generate-documents-zip")
      .send({ caseIds: [3, 2], templateIds: [5], actionType: "download" });
    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty("ok", true);
    expect(typeof res.body.jobId).toBe("string");
  });

  it("POST /api/documents/automation/generate-job allows 120 items (10 cases x 12 templates)", async () => {
    const caseIds = Array.from({ length: 10 }, (_, i) => i + 1);
    const templates = Array.from({ length: 12 }, (_, i) => ({ source: "firm" as const, id: i + 1 }));
    const res = await request(app)
      .post("/api/documents/automation/generate-job?blind=true")
      .send({ caseIds, templates, config: { action: "download", outputFormat: "pdf" } });
    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty("ok", true);
    expect(typeof res.body.jobId).toBe("string");
  });

  it("POST /api/documents/automation/generate-job rejects 121 items with 422 TOO_MANY_ITEMS", async () => {
    const caseIds = Array.from({ length: 11 }, (_, i) => i + 1);
    const templates = Array.from({ length: 11 }, (_, i) => ({ source: "firm" as const, id: i + 1 }));
    const res = await request(app)
      .post("/api/documents/automation/generate-job?blind=true")
      .send({ caseIds, templates, config: { action: "download", outputFormat: "pdf" } });
    expect(res.status).toBe(422);
    expect(res.body?.ok).toBe(false);
    expect(res.body?.error?.code).toBe("TOO_MANY_ITEMS");
    expect(String(res.body?.error?.message ?? "")).toMatch(/split/i);
  });

  it("POST /api/documents/jobs/:jobId/finalize builds zip without diagnostics or __ERROR__.pdf", async () => {
    lastUploadedZipBytes = null;
    mockJobStatus = "finalizing";
    mockDownloadObjectPath = null;
    const res = await request(app).post(`/api/documents/jobs/${TEST_JOB_ID}/finalize`);
    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    expect(res.body?.status).toBe("completed_with_errors");
    expect(Buffer.isBuffer(lastUploadedZipBytes)).toBe(true);
    const zipBytes = lastUploadedZipBytes as Buffer;
    const names = extractZipEntryNames(zipBytes);
    expect(names.length).toBe(1);
    expect(names[0]).toMatch(/^Document_Automation_\d{4}-\d{2}-\d{2}\/01_.+\/01_.+\.pdf$/);
    expect(names[0]).not.toContain("__ERROR__");
    expect(names[0]).not.toContain("_GENERATION_WARNINGS");
    expect(names[0]).not.toContain("_manifest.json");
  });

  it("POST /api/documents/jobs/:jobId/run-next is routable (invalid jobId returns 400 INVALID_JOB_ID)", async () => {
    const res = await request(app).post("/api/documents/jobs/not-a-uuid/run-next");
    expect(res.status).toBe(400);
    expect(res.body?.ok).toBe(false);
    expect(res.body?.error?.code).toBe("INVALID_JOB_ID");
  });

  it("POST /api/documents/jobs/:jobId/run-next returns 409 RUN_NEXT_IN_FLIGHT on concurrent call", async () => {
    mockJobStatus = "running";
    mockDownloadObjectPath = null;
    lockHeld = false;
    delayNextJobSelectMs = 40;
    const p1 = request(app).post(`/api/documents/jobs/${TEST_JOB_ID}/run-next`);
    await new Promise<void>((r) => setTimeout(r, 5));
    const p2 = request(app).post(`/api/documents/jobs/${TEST_JOB_ID}/run-next`);
    const [r1, r2] = await Promise.all([p1, p2]);
    const one409 = r1.status === 409 ? r1 : r2.status === 409 ? r2 : null;
    expect(one409?.body?.error?.code).toBe("RUN_NEXT_IN_FLIGHT");
    expect(one409?.body?.error?.retryable).toBe(true);
  });

  it("GET /api/documents/jobs/:jobId/status is routable (not route-level 404)", async () => {
    mockJobStatus = "running";
    const res = await request(app).get(`/api/documents/jobs/${TEST_JOB_ID}/status`);
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body).toHaveProperty("ok", true);
      expect(res.body).toHaveProperty("jobId", TEST_JOB_ID);
    }
    if (res.status === 404) {
      expect(res.body?.error?.code).toBe("JOB_NOT_FOUND");
    }
  });
});
