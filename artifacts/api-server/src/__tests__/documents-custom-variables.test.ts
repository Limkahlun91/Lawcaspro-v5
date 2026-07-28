import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import app from "../app";
import { casesTable, db, documentCustomVariablesTable, documentCustomVariableVersionsTable, documentTemplatesTable, firmsTable } from "@workspace/db";
import { and, desc, eq, inArray, ne } from "drizzle-orm";

const PARTNER_EMAIL = "partner@tan-associates.my";
const PARTNER_PWD = "lawyer123";
const skipDb = process.env.VITEST_SKIP_DB === "1";
const suite = skipDb ? describe.skip : describe;

suite("Documents Custom Variables", () => {
  let token: string;
  let firmId: number;
  let partnerCaseId: number | null = null;
  const cleanupIds: number[] = [];
  const cleanupTemplateIds: number[] = [];

  beforeAll(async () => {
    const loginRes = await request(app).post("/api/auth/login").send({ email: PARTNER_EMAIL, password: PARTNER_PWD });
    expect(loginRes.status).toBe(200);
    token = loginRes.body.data.token;
    firmId = loginRes.body.data.firmId;
    const [caseRow] = await db
      .select({ id: casesTable.id })
      .from(casesTable)
      .where(eq(casesTable.firmId, firmId))
      .limit(1);
    partnerCaseId = caseRow?.id ?? null;
  });

  afterAll(async () => {
    if (cleanupTemplateIds.length) {
      await db.delete(documentTemplatesTable).where(inArray(documentTemplatesTable.id, cleanupTemplateIds));
    }
    if (cleanupIds.length) {
      await db.delete(documentCustomVariableVersionsTable).where(inArray(documentCustomVariableVersionsTable.customVariableId, cleanupIds));
      await db.delete(documentCustomVariablesTable).where(inArray(documentCustomVariablesTable.id, cleanupIds));
    }
    if (token) {
      await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${token}`);
    }
  });

  it("creates with spaces/uppercase canonicalized to snake_case", async () => {
    const createRes = await request(app)
      .post("/api/documents/custom-variables")
      .set("Authorization", `Bearer ${token}`)
      .send({
        key: "M LEGASI PROPERTY DETAILS",
        displayName: "M LEGASI PROPERTY DETAILS",
        groupKey: "custom_variables",
        status: "active",
        bodyTemplate: "Parcel {{parcel_no}} Type {{property_type}}",
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body).toMatchObject({ ok: true });
    const id = Number(createRes.body.id);
    expect(Number.isFinite(id)).toBe(true);
    cleanupIds.push(id);

    const listRes = await request(app)
      .get("/api/documents/custom-variables?q=m_legasi_property_details")
      .set("Authorization", `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    const row = (listRes.body.data as any[]).find((x) => x.id === id);
    expect(row).toBeTruthy();
    expect(row.key).toBe("m_legasi_property_details");
  });

  it("updates bodyTemplate and list returns updated current version", async () => {
    const createRes = await request(app)
      .post("/api/documents/custom-variables")
      .set("Authorization", `Bearer ${token}`)
      .send({
        key: "update_test",
        displayName: "Update test",
        groupKey: "custom_variables",
        status: "active",
        bodyTemplate: "Hello {{parcel_no}}",
      });
    expect(createRes.status).toBe(201);
    const id = Number(createRes.body.id);
    cleanupIds.push(id);

    const updateRes = await request(app)
      .put(`/api/documents/custom-variables/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ bodyTemplate: "Hello {{parcel_no}} world" });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body).toMatchObject({ ok: true });

    const listRes = await request(app)
      .get("/api/documents/custom-variables?q=update_test")
      .set("Authorization", `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    const row = (listRes.body.data as any[]).find((x) => x.id === id);
    expect(row).toBeTruthy();
    expect(row.body_template).toBe("Hello {{parcel_no}} world");
    expect(Number(row.current_version_no)).toBeGreaterThanOrEqual(2);
  });

  it("returns field issues for invalid key (starts with number)", async () => {
    const res = await request(app)
      .post("/api/documents/custom-variables")
      .set("Authorization", `Bearer ${token}`)
      .send({
        key: "1abc",
        displayName: "bad",
        groupKey: "custom_variables",
        status: "active",
        bodyTemplate: "Hello",
      });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(typeof res.body.meta?.request_id).toBe("string");
    const issues = res.body.error?.details?.issues;
    expect(Array.isArray(issues)).toBe(true);
    expect(issues.some((x: any) => Array.isArray(x.path) && x.path[0] === "key")).toBe(true);
  });

  it("returns 409 with field=key on duplicate key in same firm", async () => {
    const createRes = await request(app)
      .post("/api/documents/custom-variables")
      .set("Authorization", `Bearer ${token}`)
      .send({
        key: "duplicate_key_test",
        displayName: "dup",
        groupKey: "custom_variables",
        status: "active",
        bodyTemplate: "Hello {{parcel_no}}",
      });
    expect(createRes.status).toBe(201);
    cleanupIds.push(Number(createRes.body.id));

    const dupRes = await request(app)
      .post("/api/documents/custom-variables")
      .set("Authorization", `Bearer ${token}`)
      .send({
        key: "DUPLICATE KEY TEST",
        displayName: "dup2",
        groupKey: "custom_variables",
        status: "active",
        bodyTemplate: "Hello {{parcel_no}}",
      });
    expect(dupRes.status).toBe(409);
    expect(dupRes.body.ok).toBe(false);
    expect(dupRes.body.error?.code).toBe("CUSTOM_VARIABLE_KEY_EXISTS");
    expect(dupRes.body.error?.details?.field).toBe("key");
  });

  it("does not treat other firm's key as duplicate (tenant scoped uniqueness)", async () => {
    const otherFirm = await db
      .select({ id: firmsTable.id })
      .from(firmsTable)
      .where(ne(firmsTable.id, firmId))
      .orderBy(desc(firmsTable.id))
      .limit(1);
    if (!otherFirm[0]?.id) return;

    const [inserted] = await db
      .insert(documentCustomVariablesTable)
      .values({
        scope: "firm",
        firmId: otherFirm[0].id,
        templateId: null,
        key: "tenant_scoped_key",
        displayName: "Tenant scoped key",
        groupKey: "custom_variables",
        status: "active",
        isPublished: false,
        deprecatedAt: null,
        currentVersionNo: 1,
        createdBy: null,
        updatedBy: null,
      })
      .returning();
    const otherId = inserted.id;
    cleanupIds.push(otherId);
    await db.insert(documentCustomVariableVersionsTable).values({
      customVariableId: otherId,
      versionNo: 1,
      bodyTemplate: "Hello {{parcel_no}}",
      createdBy: null,
    });

    const createRes = await request(app)
      .post("/api/documents/custom-variables")
      .set("Authorization", `Bearer ${token}`)
      .send({
        key: "tenant_scoped_key",
        displayName: "tenant scoped key",
        groupKey: "custom_variables",
        status: "active",
        bodyTemplate: "Hello {{parcel_no}}",
      });
    expect(createRes.status).toBe(201);
    cleanupIds.push(Number(createRes.body.id));
  });

  it("returns bodyTemplate issue for invalid token syntax", async () => {
    const res = await request(app)
      .post("/api/documents/custom-variables")
      .set("Authorization", `Bearer ${token}`)
      .send({
        key: "token_syntax_bad",
        displayName: "bad token",
        groupKey: "custom_variables",
        status: "active",
        bodyTemplate: "Hello {{ parcel_no }}",
      });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    const issues = res.body.error?.details?.issues;
    expect(Array.isArray(issues)).toBe(true);
    expect(issues.some((x: any) => Array.isArray(x.path) && x.path[0] === "bodyTemplate")).toBe(true);
  });

  it("permits one concurrent create and rejects the duplicate with field-specific 409", async () => {
    const payload = {
      key: "race_duplicate_key",
      displayName: "Race duplicate key",
      groupKey: "custom_variables",
      status: "active",
      bodyTemplate: "Hello {{parcel_no}}",
    };

    const [resA, resB] = await Promise.all([
      request(app).post("/api/documents/custom-variables").set("Authorization", `Bearer ${token}`).send(payload),
      request(app).post("/api/documents/custom-variables").set("Authorization", `Bearer ${token}`).send(payload),
    ]);

    const statuses = [resA.status, resB.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);
    const success = [resA, resB].find((x) => x.status === 201);
    const duplicate = [resA, resB].find((x) => x.status === 409);
    if (success?.body?.id) cleanupIds.push(Number(success.body.id));
    expect(duplicate?.body.ok).toBe(false);
    expect(duplicate?.body.error?.code).toBe("CUSTOM_VARIABLE_KEY_EXISTS");
    expect(duplicate?.body.error?.details?.field).toBe("key");
  });

  it("does not list another firm's private variable", async () => {
    const otherFirm = await db
      .select({ id: firmsTable.id })
      .from(firmsTable)
      .where(ne(firmsTable.id, firmId))
      .orderBy(desc(firmsTable.id))
      .limit(1);
    if (!otherFirm[0]?.id) return;

    const [inserted] = await db
      .insert(documentCustomVariablesTable)
      .values({
        scope: "firm",
        firmId: otherFirm[0].id,
        templateId: null,
        key: "other_firm_private_key",
        displayName: "Other firm private key",
        groupKey: "custom_variables",
        status: "active",
        isPublished: false,
        deprecatedAt: null,
        currentVersionNo: 1,
        createdBy: null,
        updatedBy: null,
      })
      .returning();
    cleanupIds.push(inserted.id);
    await db.insert(documentCustomVariableVersionsTable).values({
      customVariableId: inserted.id,
      versionNo: 1,
      bodyTemplate: "Other {{parcel_no}}",
      createdBy: null,
    });

    const listRes = await request(app)
      .get("/api/documents/custom-variables?q=other_firm_private_key")
      .set("Authorization", `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    const rows = Array.isArray(listRes.body.data) ? listRes.body.data : [];
    expect(rows.some((row: any) => row.id === inserted.id || row.key === "other_firm_private_key")).toBe(false);
  });

  it("returns generic not found when previewing another firm's private variable", async () => {
    if (!partnerCaseId) return;
    const otherFirm = await db
      .select({ id: firmsTable.id })
      .from(firmsTable)
      .where(ne(firmsTable.id, firmId))
      .orderBy(desc(firmsTable.id))
      .limit(1);
    if (!otherFirm[0]?.id) return;

    const [inserted] = await db
      .insert(documentCustomVariablesTable)
      .values({
        scope: "firm",
        firmId: otherFirm[0].id,
        templateId: null,
        key: "other_firm_preview_only",
        displayName: "Other firm preview only",
        groupKey: "custom_variables",
        status: "active",
        isPublished: false,
        deprecatedAt: null,
        currentVersionNo: 1,
        createdBy: null,
        updatedBy: null,
      })
      .returning();
    cleanupIds.push(inserted.id);
    await db.insert(documentCustomVariableVersionsTable).values({
      customVariableId: inserted.id,
      versionNo: 1,
      bodyTemplate: "Other {{parcel_no}}",
      createdBy: null,
    });

    const previewRes = await request(app)
      .get(`/api/documents/custom-variables/${inserted.id}/preview?caseId=${partnerCaseId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(previewRes.status).toBe(404);
    expect(previewRes.body.ok).toBe(false);
    expect(previewRes.body.error?.code).toBe("NOT_FOUND");
    expect(String(previewRes.body.error?.message ?? "")).not.toContain("firm");
  });

  it("returns generic not found when updating another firm's variable", async () => {
    const otherFirm = await db
      .select({ id: firmsTable.id })
      .from(firmsTable)
      .where(ne(firmsTable.id, firmId))
      .orderBy(desc(firmsTable.id))
      .limit(1);
    if (!otherFirm[0]?.id) return;

    const [inserted] = await db
      .insert(documentCustomVariablesTable)
      .values({
        scope: "firm",
        firmId: otherFirm[0].id,
        templateId: null,
        key: "other_firm_update_only",
        displayName: "Other firm update only",
        groupKey: "custom_variables",
        status: "active",
        isPublished: false,
        deprecatedAt: null,
        currentVersionNo: 1,
        createdBy: null,
        updatedBy: null,
      })
      .returning();
    cleanupIds.push(inserted.id);
    await db.insert(documentCustomVariableVersionsTable).values({
      customVariableId: inserted.id,
      versionNo: 1,
      bodyTemplate: "Other {{parcel_no}}",
      createdBy: null,
    });

    const updateRes = await request(app)
      .put(`/api/documents/custom-variables/${inserted.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ bodyTemplate: "Changed {{parcel_no}}" });
    expect(updateRes.status).toBe(404);
    expect(updateRes.body.ok).toBe(false);
    expect(updateRes.body.error?.code).toBe("NOT_FOUND");
    expect(String(updateRes.body.error?.message ?? "")).not.toContain("firm");
  });

  it("rejects template_specific create when template belongs to another firm", async () => {
    const otherFirm = await db
      .select({ id: firmsTable.id })
      .from(firmsTable)
      .where(ne(firmsTable.id, firmId))
      .orderBy(desc(firmsTable.id))
      .limit(1);
    if (!otherFirm[0]?.id) return;

    const [template] = await db
      .insert(documentTemplatesTable)
      .values({
        firmId: otherFirm[0].id,
        name: `Other Firm Template ${Date.now()}`,
        kind: "template",
        documentType: "other",
        isActive: true,
        printMode: "double",
        documentGroup: "Others",
        sortOrder: 0,
        objectPath: `/objects/templates/${otherFirm[0].id}/cross-firm-${Date.now()}.docx`,
        fileName: `cross-firm-${Date.now()}.docx`,
        isTemplateCapable: true,
      })
      .returning();
    cleanupTemplateIds.push(template.id);

    const createRes = await request(app)
      .post("/api/documents/custom-variables")
      .set("Authorization", `Bearer ${token}`)
      .send({
        key: "cross_firm_template_key",
        displayName: "Cross firm template key",
        groupKey: "custom_variables",
        status: "active",
        scope: "template_specific",
        templateId: template.id,
        bodyTemplate: "Hello {{parcel_no}}",
      });
    expect(createRes.status).toBe(404);
    expect(createRes.body.ok).toBe(false);
    expect(createRes.body.error?.code).toBe("NOT_FOUND");
  });

  it("returns 401 without revealing existence when unauthenticated caller requests preview", async () => {
    if (!partnerCaseId) return;
    const createRes = await request(app)
      .post("/api/documents/custom-variables")
      .set("Authorization", `Bearer ${token}`)
      .send({
        key: "unauth_probe_key",
        displayName: "Unauth probe key",
        groupKey: "custom_variables",
        status: "active",
        bodyTemplate: "Hello {{parcel_no}}",
      });
    expect(createRes.status).toBe(201);
    const id = Number(createRes.body.id);
    cleanupIds.push(id);

    const previewRes = await request(app).get(`/api/documents/custom-variables/${id}/preview?caseId=${partnerCaseId}`);
    expect(previewRes.status).toBe(401);
    expect(String(previewRes.body?.error?.message ?? previewRes.body?.error ?? "")).not.toContain(String(id));
  });
});
