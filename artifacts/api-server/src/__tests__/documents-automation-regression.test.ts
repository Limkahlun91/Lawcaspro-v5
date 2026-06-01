import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Application } from "express";
import yazl from "yazl";
import { PDFDocument, StandardFonts } from "pdf-lib";

const TEST_JOB_ID = "11111111-1111-1111-1111-111111111111";

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

function makeDb(): FakeDb {
  const queryText = (query: any): string => {
    const chunks = query?.queryChunks;
    if (!Array.isArray(chunks)) return "";
    return chunks.map((c: any) => (typeof c === "string" ? c : "?")).join("");
  };

  const db: FakeDb = {
    execute: async (query?: unknown) => {
      const text = queryText(query as any);
      if (text.includes("SELECT show_master_documents FROM firms")) {
        return [{ show_master_documents: true }];
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
      if (text.includes("FROM document_templates") && text.includes("WHERE firm_id")) {
        return [{
          id: 7,
          name: "Acting Letter",
          object_path: "/objects/templates/firm/1/acting-letter.pdf",
          file_name: "acting-letter.pdf",
          mime_type: "application/pdf",
          is_template_capable: true,
        }];
      }
      if (text.includes("FROM document_generation_jobs")) {
        return [{
          id: TEST_JOB_ID,
          firm_id: 1,
          status: "completed",
          action: "download",
          case_ids: [3],
          config: { outputFormat: "pdf", templates: [{ source: "firm", id: 7 }] },
          download_object_path: null,
          download_file_name: null,
          download_mime_type: null,
        }];
      }
      if (text.includes("FROM document_generation_job_items")) {
        return [{
          id: 1,
          job_id: TEST_JOB_ID,
          firm_id: 1,
          case_id: 3,
          status: "success",
          object_path: "/objects/temp-generated/1/document-automation-jobs/one.docx",
          file_name: "Acting Letter.pdf",
          mime_type: "application/pdf",
          template_name: "Acting Letter",
          template_source: "firm",
          template_id: 7,
          platform_document_id: null,
        }];
      }
      if (text.includes("FROM cases") && text.includes("id IN")) {
        return [{ id: 3, reference_no: "CON-001" }];
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

  it("GET /api/documents/jobs/:jobId/download returns 200 application/zip even without download_object_path", async () => {
    const res = await request(app)
      .get(`/api/documents/jobs/${TEST_JOB_ID}/download`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(String(res.headers["content-type"] ?? "")).toContain("application/zip");
    const body = res.body as Buffer;
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.length).toBeGreaterThan(10);
    expect(body.slice(0, 2).toString("utf8")).toBe("PK");
  });

  it("POST /api/documents/automation/generate-now returns 202 jobId (async)", async () => {
    const res = await request(app)
      .post("/api/documents/automation/generate-now")
      .send({ caseIds: [3], templates: [{ source: "firm", id: 7 }], config: { action: "download", outputFormat: "pdf" } });
    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty("ok", true);
    expect(typeof res.body.jobId).toBe("string");
  });
});
