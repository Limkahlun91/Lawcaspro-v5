import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Application } from "express";
import { PDFDocument, StandardFonts } from "pdf-lib";
import PizZip from "pizzip";

let app: Application;

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
  q.then = (resolve: (v: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
    getRows().then(resolve, reject);
  q.where = () => q;
  q.orderBy = () => q;
  q.limit = () => q;
  return q;
}

function makeDocxTemplate(args: { bodyXml: string; headerXml?: string; footerXml?: string }): Buffer {
  const zip = new PizZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
</Types>`,
  );
  zip.folder("_rels")?.file(
    ".rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.folder("word")?.file("document.xml", args.bodyXml);
  zip.folder("word")?.file("header1.xml", args.headerXml ?? "<w:hdr xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"/>");
  zip.folder("word")?.file("footer1.xml", args.footerXml ?? "<w:ftr xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"/>");
  zip.folder("word")?.folder("_rels")?.file(
    "document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
</Relationships>`,
  );
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
}

const templateDocxBytes = makeDocxTemplate({
  bodyXml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p><w:r><w:t>Acting Letter {{case_reference}} {{date_today}}</w:t></w:r></w:p>
    <w:sectPr>
      <w:headerReference w:type="default" r:id="rId1"/>
      <w:footerReference w:type="default" r:id="rId2"/>
    </w:sectPr>
  </w:body>
</w:document>`,
});

let hasTemplate = false;

function makeDb(): FakeDb {
  const queryText = (query: any): string => {
    const chunks = query?.queryChunks;
    if (!Array.isArray(chunks)) return "";
    return chunks.map((c: any) => (typeof c === "string" ? c : "?")).join("");
  };

  const db: FakeDb = {
    execute: async (query?: unknown) => {
      const text = queryText(query as any);

      if (text.includes("FROM document_templates") && text.includes("document_type IN")) {
        if (!hasTemplate) return [];
        return [{
          id: 7,
          name: "Acting Letter Issued",
          document_type: "acting_letter",
          kind: "template",
          is_template_capable: true,
          file_name: "Acting Letter Issued.docx",
          created_at: "2026-06-08T00:00:00.000Z",
        }];
      }

      if (text.includes("FROM document_templates") && text.includes("AND kind = 'template'") && text.includes("LIMIT 20")) {
        if (!hasTemplate) return [];
        return [{
          id: 7,
          firm_id: 1,
          name: "Acting Letter Issued",
          document_type: "acting_letter",
          kind: "template",
          is_template_capable: true,
          file_name: "Acting Letter Issued.docx",
          object_path: "/objects/templates/firms/1/document-templates/acting-letter.docx",
          extension: "docx",
          mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          is_active: true,
          created_at: "2026-06-08T00:00:00.000Z",
          updated_at: "2026-06-08T00:00:00.000Z",
          print_mode: "double",
          file_naming_rule: null,
          document_group: "Others",
        }];
      }

      if (text.includes("FROM cases c") && text.includes("WHERE c.id")) {
        const params = Array.isArray((query as any)?.params) ? (query as any).params : [];
        const caseId = typeof params[0] === "number" ? params[0] : Number.parseInt(String(params[0] ?? ""), 10);
        const firmId = typeof params[1] === "number" ? params[1] : Number.parseInt(String(params[1] ?? ""), 10);
        if (!Number.isFinite(caseId) || caseId !== 3) return [];
        if (!Number.isFinite(firmId) || firmId !== 1) return [];
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
          purchasers: [{ name: "LIMKL", ic: "900101-01-1234", address: "ADDR" }],
          vendors: [],
          financiers: [],
          custom_variables: {},
          firm_logo_url: "",
        }];
      }

      if (text.includes("FROM document_template_versions") && text.includes("status = 'published'")) {
        return [{ id: 77 }];
      }

      if (text.includes("SELECT * FROM document_template_versions") && text.includes("WHERE id =")) {
        return [{
          id: 77,
          firm_id: 1,
          template_id: 7,
          status: "published",
          source_object_path: "/objects/templates/firms/1/document-templates/acting-letter.docx",
          filename: "Acting Letter Issued.docx",
          variables_snapshot: null,
          published_at: "2026-06-08T00:00:00.000Z",
        }];
      }

      if (text.includes("INSERT INTO document_generation_runs")) {
        return [{ id: 9001 }];
      }

      if (text.includes("UPDATE document_generation_runs") && text.includes("SET template_version_id")) {
        return [{ id: 9001 }];
      }

      if (text.includes("FROM case_document_variable_overrides")) {
        return [];
      }

      if (text.includes("information_schema") && text.includes("case_workflow_documents")) return [];
      if (text.includes("information_schema") && text.includes("case_loan_stamping_items")) return [];
      if (text.includes("information_schema") && text.includes("case_document_checklist_items")) return [];

      if (text.includes("FROM firm_letterheads") && text.includes("LIMIT 1")) return [];

      if (text.includes("SELECT COUNT(*)::int AS c") && text.includes("FROM case_documents")) {
        return [{ c: 0 }];
      }

      if (text.includes("FROM case_documents") && text.includes("WHERE firm_id")) return [];

      if (text.includes("INSERT INTO case_documents")) {
        return [{
          id: 123,
          case_id: 3,
          firm_id: 1,
          object_path: "/objects/generated/1/case-3/printed.pdf",
          file_name: "Acting Letter - CON-001.pdf",
          mime_type: "application/pdf",
          file_size: 9999,
        }];
      }

      if (text.includes("UPDATE document_generation_runs") && text.includes("SET status = 'success'")) {
        return [{ id: 9001 }];
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
    requireFirmUser: (req: any, res: any, next: any) => {
      req.userId = 10;
      req.userType = "firm_user";
      req.firmId = 1;
      req.roleId = 7;
      req.rlsDb = sharedDb;
      next();
    },
    requirePermission: () => (req: any, res: any, next: any) => {
      if (String(req.headers["x-test-deny"] ?? "") === "1") {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      next();
    },
    writeAuditLog: async () => undefined,
  };
});

vi.mock("../lib/documentApplicabilityRules.js", async (orig) => {
  const actual = await orig<typeof import("../lib/documentApplicabilityRules.js")>();
  return {
    ...actual,
    getFirmTemplateApplicabilityRules: async () => ({
      isActive: true,
      isTemplateCapable: true,
      purchaseMode: null,
      titleType: "any",
      caseType: null,
    }),
  };
});

vi.mock("../lib/documentPreview.js", async (orig) => {
  const actual = await orig<typeof import("../lib/documentPreview.js")>();
  return {
    ...actual,
    runDocumentPreview: async () => ({
      usedMode: "bindings",
      resolvedVariables: {
        case_reference: "CON-001",
        date_today: "08.06.2026",
        firm_logo_url: "",
      },
    }),
  };
});

vi.mock("../services/document-generation/docx-to-pdf.js", async (orig) => {
  const actual = await orig<typeof import("../services/document-generation/docx-to-pdf.js")>();
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("PDF OK", { x: 50, y: 780, size: 12, font });
  const pdfBytes = Buffer.from(await pdf.save());
  return {
    ...actual,
    convertDocxToPdf: async () => pdfBytes,
    getDocxToPdfHealth: async () => ({ ok: true, engine: "http_service", configured: true }),
  };
});

vi.mock("../lib/objectStorage.js", async (orig) => {
  const actual = await orig<typeof import("../lib/objectStorage.js")>();
  class SupabaseStorageServiceMock {
    assertConfigured() {
    }
    async fetchPrivateObjectResponse(_objectPath: string, _opts?: { timeoutMs?: number }) {
      return new Response(templateDocxBytes, {
        headers: {
          "content-type":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "content-length": String(templateDocxBytes.length),
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

beforeAll(async () => {
  const mod = await import("../app");
  app = mod.default;
});

describe("Milestone printer connector", () => {
  it("GET /api/printable-config returns not_configured when no template exists", async () => {
    hasTemplate = false;
    const res = await request(app).get("/api/printable-config");
    expect(res.status).toBe(200);
    const acting = (res.body as any[]).find((x) => x?.printKey === "acting_letter");
    expect(acting?.status).toBe("not_configured");
  });

  it("GET /api/printable-config returns configured when firm template exists", async () => {
    hasTemplate = true;
    const res = await request(app).get("/api/printable-config");
    expect(res.status).toBe(200);
    const acting = (res.body as any[]).find((x) => x?.printKey === "acting_letter");
    expect(acting?.status).toBe("configured");
  });

  it("POST /api/cases/:caseId/documents/print enqueues one-item job", async () => {
    hasTemplate = true;
    const res = await request(app)
      .post("/api/cases/3/documents/print")
      .send({ printKey: "acting_letter", outputFormat: "pdf" });
    expect(res.status).toBe(202);
    expect(res.body?.ok).toBe(true);
    expect(res.body?.mode).toBe("job");
    expect(typeof res.body?.jobId).toBe("string");
    expect(res.body?.total).toBe(1);
    expect(res.body?.caseId).toBe(3);
  });

  it("POST /api/cases/:caseId/documents/print rejects without permission", async () => {
    hasTemplate = true;
    const res = await request(app)
      .post("/api/cases/3/documents/print")
      .set("x-test-deny", "1")
      .send({ printKey: "acting_letter", outputFormat: "pdf" });
    expect(res.status).toBe(403);
  });

  it("POST /api/cases/:caseId/documents/print respects firm isolation (case not found)", async () => {
    hasTemplate = true;
    const res = await request(app)
      .post("/api/cases/999/documents/print")
      .send({ printKey: "acting_letter", outputFormat: "pdf" });
    expect(res.status).toBe(404);
  });
});
