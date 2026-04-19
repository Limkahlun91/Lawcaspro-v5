import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import app from "../app";
import { db, casesTable, casePurchasersTable, caseAssignmentsTable, clientsTable, documentTemplatesTable, documentTemplateBindingsTable, caseDocumentsTable, platformDocumentsTable } from "@workspace/db";
import { and, eq, desc, or } from "drizzle-orm";
import PizZip from "pizzip";
import { SupabaseStorageService } from "../lib/objectStorage";

const PARTNER_EMAIL = "partner@tan-associates.my";
const PARTNER_PWD = "lawyer123";
const FOUNDER_EMAIL = "lun.6923@hotmail.com";
const FOUNDER_PWD = "founder123";
const skipDb = process.env.VITEST_SKIP_DB === "1";
const suite = skipDb ? describe.skip : describe;

let token: string;
let founderToken: string;
let firmId: number;
let projectId: number;
let lawyerUserId: number;
let founderUserId: number;
let createdCaseId: number;
let purchaserIc: string;
let parcelNo: string;
let tplIdCashOnly: number;
let tplIdSpaGroup: number;
let tplIdReady: number;
let tplIdLegacyReady: number;
let platformDocId: number;

beforeAll(async () => {
  if (skipDb) return;

  const loginRes = await request(app)
    .post("/api/auth/login")
    .send({ email: PARTNER_EMAIL, password: PARTNER_PWD });
  expect(loginRes.status).toBe(200);
  token = loginRes.body.token;
  firmId = loginRes.body.firmId;

  const founderLoginRes = await request(app)
    .post("/api/auth/login")
    .send({ email: FOUNDER_EMAIL, password: FOUNDER_PWD });
  expect(founderLoginRes.status).toBe(200);
  founderToken = founderLoginRes.body.token;
  founderUserId = founderLoginRes.body.userId ?? founderLoginRes.body.id;
  expect(typeof founderToken).toBe("string");
  expect(typeof founderUserId).toBe("number");

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

  const [legacyTpl] = await db.insert(documentTemplatesTable).values({
    firmId,
    name: "Legacy ready template (no bindings)",
    kind: "template",
    documentType: "other",
    isActive: true,
    appliesToPurchaseMode: "both",
    appliesToTitleType: "any",
    appliesToCaseType: null,
    documentGroup: "Others",
    sortOrder: 4,
    objectPath: `/objects/cases/${firmId}/templates/${suffix}-legacy-ready.docx`,
    fileName: "legacy-ready.docx",
    extension: "docx",
    isTemplateCapable: true,
    createdBy: lawyerUserId,
  }).returning();
  tplIdLegacyReady = legacyTpl.id;

  const [pdoc] = await db.insert(platformDocumentsTable).values({
    name: `P4 Test Platform Doc ${suffix}`,
    description: "P4 test doc",
    category: "general",
    isActive: true,
    appliesToPurchaseMode: "both",
    appliesToTitleType: "any",
    appliesToCaseType: null,
    documentGroup: "Others",
    sortOrder: 0,
    fileName: "platform-test.docx",
    fileType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    fileSize: 123,
    objectPath: `/objects/platform/${suffix}-platform-test.docx`,
    firmId: null,
    folderId: null,
    pdfMappings: null,
    uploadedBy: founderUserId,
  }).returning();
  platformDocId = pdoc.id;
});

afterAll(async () => {
  if (skipDb) return;
  if (tplIdReady) {
    await db.delete(documentTemplateBindingsTable).where(and(
      eq(documentTemplateBindingsTable.firmId, firmId),
      eq(documentTemplateBindingsTable.templateId, tplIdReady),
    ));
  }
  if (platformDocId) {
    await db.delete(documentTemplateBindingsTable).where(eq(documentTemplateBindingsTable.platformDocumentId, platformDocId));
  }
  if (tplIdCashOnly) await db.delete(documentTemplatesTable).where(and(eq(documentTemplatesTable.firmId, firmId), eq(documentTemplatesTable.id, tplIdCashOnly)));
  if (tplIdSpaGroup) await db.delete(documentTemplatesTable).where(and(eq(documentTemplatesTable.firmId, firmId), eq(documentTemplatesTable.id, tplIdSpaGroup)));
  if (tplIdReady) await db.delete(documentTemplatesTable).where(and(eq(documentTemplatesTable.firmId, firmId), eq(documentTemplatesTable.id, tplIdReady)));
  if (tplIdLegacyReady) await db.delete(documentTemplatesTable).where(and(eq(documentTemplatesTable.firmId, firmId), eq(documentTemplatesTable.id, tplIdLegacyReady)));
  if (platformDocId) await db.delete(platformDocumentsTable).where(eq(platformDocumentsTable.id, platformDocId));
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

  it("GET /api/cases/:caseId/documents/checklist returns applicable items by default", async () => {
    const res = await request(app)
      .get(`/api/cases/${createdCaseId}/documents/checklist`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sections)).toBe(true);
    const spaSection = res.body.sections.find((s: any) => s.section === "SPA");
    expect(spaSection).toBeTruthy();
    const ids = spaSection.items.map((x: any) => x.templateId);
    expect(ids).toContain(tplIdSpaGroup);
    expect(ids).not.toContain(tplIdCashOnly);
  });

  it("GET /api/document-variables returns 200 (array)", async () => {
    const res = await request(app)
      .get("/api/document-variables?active=1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("GET/PUT /api/document-templates/:templateId/bindings returns and updates bindings", async () => {
    const getRes = await request(app)
      .get(`/api/document-templates/${tplIdReady}/bindings`)
      .set("Authorization", `Bearer ${token}`);
    expect(getRes.status).toBe(200);
    expect(Array.isArray(getRes.body.placeholders)).toBe(true);
    expect(Array.isArray(getRes.body.variables)).toBe(true);
    expect(Array.isArray(getRes.body.bindings)).toBe(true);

    const putRes = await request(app)
      .put(`/api/document-templates/${tplIdReady}/bindings`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        bindings: [
          {
            variableKey: "reference_no",
            sourceMode: "custom_path",
            sourcePath: "reference_no",
            isRequired: false,
          },
        ],
      });
    expect(putRes.status).toBe(200);
    expect(Array.isArray(putRes.body.bindings)).toBe(true);
  });

  it("GET/PUT /api/platform/documents/:documentId/bindings works for founder", async () => {
    const getRes = await request(app)
      .get(`/api/platform/documents/${platformDocId}/bindings`)
      .set("Authorization", `Bearer ${founderToken}`);
    expect(getRes.status).toBe(200);
    expect(Array.isArray(getRes.body.placeholders)).toBe(true);
    expect(Array.isArray(getRes.body.variables)).toBe(true);
    expect(Array.isArray(getRes.body.bindings)).toBe(true);

    const putRes = await request(app)
      .put(`/api/platform/documents/${platformDocId}/bindings`)
      .set("Authorization", `Bearer ${founderToken}`)
      .send({
        bindings: [
          { variableKey: "reference_no", sourceMode: "custom_path", sourcePath: "reference_no" },
        ],
      });
    expect(putRes.status).toBe(200);
    expect(Array.isArray(putRes.body.bindings)).toBe(true);
  });

  it("GET /api/cases/:caseId/documents/checklist?includeAll=1 returns all items for Partner/Admin", async () => {
    const res = await request(app)
      .get(`/api/cases/${createdCaseId}/documents/checklist?includeAll=1`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const spaSection = res.body.sections.find((s: any) => s.section === "SPA");
    expect(spaSection).toBeTruthy();
    const ids = spaSection.items.map((x: any) => x.templateId);
    expect(ids).toContain(tplIdCashOnly);
    expect(ids).toContain(tplIdSpaGroup);
  });

  it("POST generate blocks non-applicable templates (applicability rules)", async () => {
    const res = await request(app)
      .post(`/api/cases/${createdCaseId}/documents/generate`)
      .set("Authorization", `Bearer ${token}`)
      .send({ templateId: tplIdCashOnly });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("TEMPLATE_APPLICABILITY_BLOCKED");
    expect(Array.isArray(res.body.reasons)).toBe(true);
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

  it("POST generate succeeds for legacy templates without bindings (fallback context)", async () => {
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
      .send({ templateId: tplIdLegacyReady });

    uploadSpy.mockRestore();
    fetchSpy.mockRestore();

    expect(res.status).toBe(201);
    expect(typeof res.body.id).toBe("number");
    expect(String(res.body.file_name)).toMatch(/\.docx$/i);
  });

  it("POST /api/cases/:caseId/documents/preview returns structured preview and does not create case_documents", async () => {
    const bytes = buildMinimalDocxTemplateBytes();
    const fetchSpy = vi
      .spyOn(SupabaseStorageService.prototype, "fetchPrivateObjectResponse")
      .mockImplementation(async () => new Response(bytes, { headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } }));
    const uploadSpy = vi
      .spyOn(SupabaseStorageService.prototype, "uploadPrivateObject")
      .mockResolvedValue(undefined);

    const before = await db.select({ id: caseDocumentsTable.id }).from(caseDocumentsTable).where(eq(caseDocumentsTable.caseId, createdCaseId));

    try {
      const res = await request(app)
        .post(`/api/cases/${createdCaseId}/documents/preview`)
        .set("Authorization", `Bearer ${token}`)
        .send({ templateId: tplIdReady });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("resolvedVariables");
      expect(res.body).toHaveProperty("missingRequiredVariables");
      expect(res.body).toHaveProperty("unusedBindings");
      expect(res.body).toHaveProperty("placeholderWarnings");
      expect(res.body).toHaveProperty("applicabilityResult");
      expect(res.body).toHaveProperty("renderMode");
      expect(res.body).toHaveProperty("previewSummary");
      expect(uploadSpy).not.toHaveBeenCalled();
    } finally {
      uploadSpy.mockRestore();
      fetchSpy.mockRestore();
    }

    const after = await db.select({ id: caseDocumentsTable.id }).from(caseDocumentsTable).where(eq(caseDocumentsTable.caseId, createdCaseId));
    expect(after.length).toBe(before.length);
  });

  it("POST /api/cases/:caseId/documents/preview returns applicabilityResult.applicable=false for blocked templates", async () => {
    const bytes = buildMinimalDocxTemplateBytes();
    const fetchSpy = vi
      .spyOn(SupabaseStorageService.prototype, "fetchPrivateObjectResponse")
      .mockImplementation(async () => new Response(bytes, { headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } }));
    try {
      const res = await request(app)
        .post(`/api/cases/${createdCaseId}/documents/preview`)
        .set("Authorization", `Bearer ${token}`)
        .send({ templateId: tplIdCashOnly });
      expect(res.status).toBe(200);
      expect(res.body?.applicabilityResult?.applicable).toBe(false);
      expect(Array.isArray(res.body?.applicabilityResult?.reasons)).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("POST /api/cases/:caseId/documents/preview returns missingRequiredVariables for required bindings", async () => {
    const bytes = (() => {
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
          `<w:p><w:r><w:t>{{required_missing}}</w:t></w:r></w:p>` +
          `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>` +
          `</w:body></w:document>`
      );
      zip.folder("word")!.folder("_rels")!.file(
        "document.xml.rels",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`
      );
      return zip.generate({ type: "uint8array", compression: "DEFLATE" });
    })();

    await db.insert(documentTemplateBindingsTable).values({
      firmId,
      templateId: tplIdReady,
      variableKey: "required_missing",
      sourceMode: "fixed_value",
      fixedValue: null,
      sourcePath: null,
      formatterOverride: null,
      isRequired: true,
      fallbackValue: null,
      notes: null,
    });

    const fetchSpy = vi
      .spyOn(SupabaseStorageService.prototype, "fetchPrivateObjectResponse")
      .mockImplementation(async () => new Response(bytes, { headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } }));

    try {
      const res = await request(app)
        .post(`/api/cases/${createdCaseId}/documents/preview`)
        .set("Authorization", `Bearer ${token}`)
        .send({ templateId: tplIdReady });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.missingRequiredVariables)).toBe(true);
      expect(res.body.missingRequiredVariables.length).toBeGreaterThan(0);
    } finally {
      fetchSpy.mockRestore();
      await db.delete(documentTemplateBindingsTable).where(and(
        eq(documentTemplateBindingsTable.firmId, firmId),
        eq(documentTemplateBindingsTable.templateId, tplIdReady),
        eq(documentTemplateBindingsTable.variableKey, "required_missing"),
      ));
    }
  });

  it("POST generate returns 422 with missingRequiredVariables when required bindings are missing", async () => {
    const bytes = (() => {
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
          `<w:p><w:r><w:t>{{required_missing}}</w:t></w:r></w:p>` +
          `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>` +
          `</w:body></w:document>`
      );
      zip.folder("word")!.folder("_rels")!.file(
        "document.xml.rels",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`
      );
      return zip.generate({ type: "uint8array", compression: "DEFLATE" });
    })();

    await db.insert(documentTemplateBindingsTable).values({
      firmId,
      templateId: tplIdReady,
      variableKey: "required_missing",
      sourceMode: "fixed_value",
      fixedValue: null,
      sourcePath: null,
      formatterOverride: null,
      isRequired: true,
      fallbackValue: null,
      notes: null,
    });

    const fetchSpy = vi
      .spyOn(SupabaseStorageService.prototype, "fetchPrivateObjectResponse")
      .mockImplementation(async () => new Response(bytes, { headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } }));
    const uploadSpy = vi
      .spyOn(SupabaseStorageService.prototype, "uploadPrivateObject")
      .mockResolvedValue(undefined);

    try {
      const res = await request(app)
        .post(`/api/cases/${createdCaseId}/documents/generate`)
        .set("Authorization", `Bearer ${token}`)
        .send({ templateId: tplIdReady });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe("TEMPLATE_BINDING_MISSING");
      expect(Array.isArray(res.body.missingRequiredVariables)).toBe(true);
      expect(uploadSpy).not.toHaveBeenCalled();
    } finally {
      uploadSpy.mockRestore();
      fetchSpy.mockRestore();
      await db.delete(documentTemplateBindingsTable).where(and(
        eq(documentTemplateBindingsTable.firmId, firmId),
        eq(documentTemplateBindingsTable.templateId, tplIdReady),
        eq(documentTemplateBindingsTable.variableKey, "required_missing"),
      ));
    }
  });

  it("Checklist P5 tracking: manual item create -> waive -> reopen -> received -> completed", async () => {
    const before = await request(app)
      .get(`/api/cases/${createdCaseId}/documents/checklist`)
      .set("Authorization", `Bearer ${token}`);
    expect(before.status).toBe(200);
    expect(before.body).toHaveProperty("summary");

    const create = await request(app)
      .post(`/api/cases/${createdCaseId}/documents/checklist/items`)
      .set("Authorization", `Bearer ${token}`)
      .send({ label: "P5 Manual Required Doc", isRequired: true });
    expect(create.status).toBe(201);
    const checklistKey = String(create.body.checklist_key ?? create.body.checklistKey ?? "");
    expect(checklistKey).toMatch(/^manual:/);

    const afterCreate = await request(app)
      .get(`/api/cases/${createdCaseId}/documents/checklist`)
      .set("Authorization", `Bearer ${token}`);
    expect(afterCreate.status).toBe(200);
    expect(afterCreate.body.summary.requiredMissing).toBeGreaterThanOrEqual(before.body.summary.requiredMissing);

    const waive = await request(app)
      .post(`/api/cases/${createdCaseId}/documents/checklist/items/${encodeURIComponent(checklistKey)}/waive`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "Not needed for this case" });
    expect(waive.status).toBe(200);

    const reopen = await request(app)
      .post(`/api/cases/${createdCaseId}/documents/checklist/items/${encodeURIComponent(checklistKey)}/reopen`)
      .set("Authorization", `Bearer ${token}`);
    expect(reopen.status).toBe(200);

    const received = await request(app)
      .post(`/api/cases/${createdCaseId}/documents/checklist/items/${encodeURIComponent(checklistKey)}/received`)
      .set("Authorization", `Bearer ${token}`)
      .send({ notes: "Received via email" });
    expect(received.status).toBe(200);

    const completed = await request(app)
      .post(`/api/cases/${createdCaseId}/documents/checklist/items/${encodeURIComponent(checklistKey)}/completed`)
      .set("Authorization", `Bearer ${token}`);
    expect(completed.status).toBe(200);

    const history = await request(app)
      .get(`/api/cases/${createdCaseId}/documents/checklist/history`)
      .set("Authorization", `Bearer ${token}`);
    expect(history.status).toBe(200);
    expect(Array.isArray(history.body)).toBe(true);
    const actions = (history.body as Array<{ action?: string }>).map((x) => String(x.action ?? ""));
    expect(actions.some((a) => a.startsWith("checklist."))).toBe(true);
  });
});
