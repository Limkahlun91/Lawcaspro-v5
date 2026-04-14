import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import app from "../app";
import { db, casesTable, casePurchasersTable, caseAssignmentsTable, clientsTable, documentTemplatesTable } from "@workspace/db";
import { and, eq, desc, or } from "drizzle-orm";
import PizZip from "pizzip";
import { SupabaseStorageService } from "../lib/objectStorage";

const PARTNER_EMAIL = "partner@tan-associates.my";
const PARTNER_PWD = "lawyer123";
const skipDb = process.env.VITEST_SKIP_DB === "1";
const suite = skipDb ? describe.skip : describe;

let token: string;
let firmId: number;
let projectId: number;
let lawyerUserId: number;
let createdCaseId: number;
let purchaserIc: string;
let parcelNo: string;
let tplIdCashOnly: number;
let tplIdSpaGroup: number;
let tplIdReady: number;

beforeAll(async () => {
  if (skipDb) return;

  const loginRes = await request(app)
    .post("/api/auth/login")
    .send({ email: PARTNER_EMAIL, password: PARTNER_PWD });
  expect(loginRes.status).toBe(200);
  token = loginRes.body.token;
  firmId = loginRes.body.firmId;

  const projRes = await request(app)
    .get("/api/projects?limit=5")
    .set("Authorization", `Bearer ${token}`);
  expect(projRes.status).toBe(200);
  projectId = projRes.body.data[0].id;

  const usersRes = await request(app)
    .get("/api/users?limit=20")
    .set("Authorization", `Bearer ${token}`);
  expect(usersRes.status).toBe(200);
  const lawyer = usersRes.body.data.find(
    (u: { roleName?: string }) =>
      u.roleName?.toLowerCase().includes("lawyer") || u.roleName?.toLowerCase().includes("partner")
  );
  lawyerUserId = lawyer.id;

  const suffix = String(Date.now());
  purchaserIc = `820101-07-${suffix.slice(-4).padStart(4, "0")}`;
  parcelNo = `TEST-DOCS-CHECKLIST-${suffix}`;

  const createRes = await request(app)
    .post("/api/cases")
    .set("Authorization", `Bearer ${token}`)
    .send({
      projectId,
      purchaseMode: "loan",
      titleType: "master",
      assignedLawyerId: lawyerUserId,
      purchasers: [{ name: "Docs Checklist Test", ic: purchaserIc }],
      caseType: "Primary Market",
      parcelNo,
    });
  if (createRes.status === 201) {
    createdCaseId = createRes.body.id;
  } else {
    const rows = await db
      .select({ id: casesTable.id })
      .from(casesTable)
      .where(and(eq(casesTable.firmId, firmId), eq(casesTable.parcelNo, parcelNo)))
      .orderBy(desc(casesTable.createdAt))
      .limit(1);
    createdCaseId = rows[0]?.id;
  }
  expect(createdCaseId).toBeTruthy();

  await db.update(casesTable).set({
    spaDetails: JSON.stringify({ purchasers: [{ name: "Docs Checklist Test", ic: purchaserIc }] }),
  }).where(and(eq(casesTable.firmId, firmId), eq(casesTable.id, createdCaseId)));

  const [cashTpl] = await db.insert(documentTemplatesTable).values({
    firmId,
    name: "Cash only template",
    kind: "template",
    documentType: "other",
    isActive: true,
    appliesToPurchaseMode: "cash",
    appliesToTitleType: "any",
    appliesToCaseType: null,
    documentGroup: "SPA",
    sortOrder: 1,
    objectPath: `/objects/cases/${firmId}/templates/${suffix}-cash.docx`,
    fileName: "cash.docx",
    extension: "docx",
    isTemplateCapable: true,
    createdBy: lawyerUserId,
  }).returning();
  tplIdCashOnly = cashTpl.id;

  const [spaTpl] = await db.insert(documentTemplatesTable).values({
    firmId,
    name: "SPA readiness template",
    kind: "template",
    documentType: "other",
    isActive: true,
    appliesToPurchaseMode: "both",
    appliesToTitleType: "any",
    appliesToCaseType: null,
    documentGroup: "SPA",
    sortOrder: 2,
    objectPath: `/objects/cases/${firmId}/templates/${suffix}-spa.docx`,
    fileName: "spa.docx",
    extension: "docx",
    isTemplateCapable: true,
    createdBy: lawyerUserId,
  }).returning();
  tplIdSpaGroup = spaTpl.id;

  const [readyTpl] = await db.insert(documentTemplatesTable).values({
    firmId,
    name: "Ready template",
    kind: "template",
    documentType: "other",
    isActive: true,
    appliesToPurchaseMode: "both",
    appliesToTitleType: "any",
    appliesToCaseType: null,
    documentGroup: "Others",
    sortOrder: 3,
    objectPath: `/objects/cases/${firmId}/templates/${suffix}-ready.docx`,
    fileName: "ready.docx",
    extension: "docx",
    isTemplateCapable: true,
    createdBy: lawyerUserId,
  }).returning();
  tplIdReady = readyTpl.id;
});

afterAll(async () => {
  if (skipDb) return;
  if (tplIdCashOnly) await db.delete(documentTemplatesTable).where(and(eq(documentTemplatesTable.firmId, firmId), eq(documentTemplatesTable.id, tplIdCashOnly)));
  if (tplIdSpaGroup) await db.delete(documentTemplatesTable).where(and(eq(documentTemplatesTable.firmId, firmId), eq(documentTemplatesTable.id, tplIdSpaGroup)));
  if (tplIdReady) await db.delete(documentTemplatesTable).where(and(eq(documentTemplatesTable.firmId, firmId), eq(documentTemplatesTable.id, tplIdReady)));
  if (!createdCaseId) return;
  await db.delete(casePurchasersTable).where(eq(casePurchasersTable.caseId, createdCaseId));
  await db.delete(caseAssignmentsTable).where(eq(caseAssignmentsTable.caseId, createdCaseId));
  await db.delete(casesTable).where(and(eq(casesTable.firmId, firmId), eq(casesTable.id, createdCaseId)));
  await db.delete(clientsTable).where(and(
    eq(clientsTable.firmId, firmId),
    or(eq(clientsTable.icNo, purchaserIc), eq(clientsTable.name, "Docs Checklist Test")),
  ));
});

suite("Documents checklist + applicability", () => {
  function buildMinimalDocxTemplateBytes(): Uint8Array {
    const zip = new PizZip();
    zip.file(
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
        `</Types>`
    );
    zip.folder("_rels")!.file(
      ".rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
        `</Relationships>`
    );
    zip.folder("word")!.file(
      "document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<w:body>` +
        `<w:p><w:r><w:t>{{reference_no}}</w:t></w:r></w:p>` +
        `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>` +
        `</w:body></w:document>`
    );
    zip.folder("word")!.folder("_rels")!.file(
      "document.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`
    );
    return zip.generate({ type: "uint8array", compression: "DEFLATE" });
  }

  it("GET /api/cases/:caseId/documents/checklist returns sections and items", async () => {
    const res = await request(app)
      .get(`/api/cases/${createdCaseId}/documents/checklist`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sections)).toBe(true);
    const spaSection = res.body.sections.find((s: any) => s.section === "SPA");
    expect(spaSection).toBeTruthy();
    const ids = spaSection.items.map((x: any) => x.templateId);
    expect(ids).toContain(tplIdCashOnly);
    expect(ids).toContain(tplIdSpaGroup);
  });

  it("POST generate blocks non-applicable templates", async () => {
    const res = await request(app)
      .post(`/api/cases/${createdCaseId}/documents/generate`)
      .set("Authorization", `Bearer ${token}`)
      .send({ templateId: tplIdCashOnly });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("TEMPLATE_NOT_APPLICABLE");
  });

  it("POST generate returns structured missing list for not-ready templates", async () => {
    const res = await request(app)
      .post(`/api/cases/${createdCaseId}/documents/generate`)
      .set("Authorization", `Bearer ${token}`)
      .send({ templateId: tplIdSpaGroup });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("TEMPLATE_NOT_READY");
    expect(Array.isArray(res.body.missing)).toBe(true);
  });

  it("POST generate succeeds for ready templates and returns created case document", async () => {
    const bytes = buildMinimalDocxTemplateBytes();
    const fetchSpy = vi
      .spyOn(SupabaseStorageService.prototype, "fetchPrivateObjectResponse")
      .mockImplementation(async () => new Response(bytes, { headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } }));
    const uploadSpy = vi
      .spyOn(SupabaseStorageService.prototype, "uploadPrivateObject")
      .mockResolvedValue(undefined);

    const res = await request(app)
      .post(`/api/cases/${createdCaseId}/documents/generate`)
      .set("Authorization", `Bearer ${token}`)
      .send({ templateId: tplIdReady });

    uploadSpy.mockRestore();
    fetchSpy.mockRestore();

    expect(res.status).toBe(201);
    expect(typeof res.body.id).toBe("number");
    expect(typeof res.body.object_path).toBe("string");
    expect(typeof res.body.file_name).toBe("string");
    expect(String(res.body.file_name)).toMatch(/\.docx$/i);
  });
});
