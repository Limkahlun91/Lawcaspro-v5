import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import app from "../app";
import { db, documentCustomVariablesTable, documentCustomVariableVersionsTable, firmsTable } from "@workspace/db";
import { desc, inArray, ne } from "drizzle-orm";

const PARTNER_EMAIL = "partner@tan-associates.my";
const PARTNER_PWD = "lawyer123";
const skipDb = process.env.VITEST_SKIP_DB === "1";
const suite = skipDb ? describe.skip : describe;

suite("Documents Custom Variables", () => {
  let token: string;
  let firmId: number;
  const cleanupIds: number[] = [];

  beforeAll(async () => {
    const loginRes = await request(app).post("/api/auth/login").send({ email: PARTNER_EMAIL, password: PARTNER_PWD });
    expect(loginRes.status).toBe(200);
    token = loginRes.body.data.token;
    firmId = loginRes.body.data.firmId;
  });

  afterAll(async () => {
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
});
