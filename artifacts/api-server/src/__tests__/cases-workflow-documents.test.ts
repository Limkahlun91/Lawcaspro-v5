import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import app from "../app";
import { SupabaseStorageService, ObjectNotFoundError, getSupabaseStorageConfigError } from "../lib/objectStorage";
import { db, casesTable, caseWorkflowDocumentsTable, casePurchasersTable, caseAssignmentsTable, clientsTable } from "@workspace/db";
import { and, eq, desc, or } from "drizzle-orm";

let tokenA: string;
let firmIdA: number;
let tokenB: string;
let createdCaseId: number;
let parcelNo: string;
let purchaserIc: string;
let projectId: number;
let lawyerUserId: number;

beforeAll(async () => {
  const loginResA = await request(app)
    .post("/api/auth/login")
    .send({ email: "partner@tan-associates.my", password: "lawyer123" });
  expect(loginResA.status).toBe(200);
  tokenA = loginResA.body.token;
  firmIdA = loginResA.body.firmId;

  const loginResB = await request(app)
    .post("/api/auth/login")
    .send({ email: "partner@test.com", password: "password123" });
  expect(loginResB.status).toBe(200);
  tokenB = loginResB.body.token;

  const projRes = await request(app)
    .get("/api/projects?limit=5")
    .set("Authorization", `Bearer ${tokenA}`);
  expect(projRes.status).toBe(200);
  projectId = projRes.body.data[0].id;

  const usersRes = await request(app)
    .get("/api/users?limit=20")
    .set("Authorization", `Bearer ${tokenA}`);
  expect(usersRes.status).toBe(200);
  const lawyer = usersRes.body.data.find(
    (u: { roleName?: string }) =>
      u.roleName?.toLowerCase().includes("lawyer") || u.roleName?.toLowerCase().includes("partner")
  );
  lawyerUserId = lawyer.id;

  const suffix = String(Date.now());
  parcelNo = `TEST-WF-DOCS-${suffix}`;
  purchaserIc = `801231-07-${suffix.slice(-4).padStart(4, "0")}`;

  const createRes = await request(app)
    .post("/api/cases")
    .set("Authorization", `Bearer ${tokenA}`)
    .send({
      projectId,
      purchaseMode: "loan",
      titleType: "master",
      assignedLawyerId: lawyerUserId,
      purchasers: [{ name: "WF Docs Test", ic: purchaserIc }],
      caseType: "Primary Market",
      parcelNo,
    });
  if (createRes.status === 201) {
    createdCaseId = createRes.body.id;
  } else {
    const rows = await db
      .select({ id: casesTable.id })
      .from(casesTable)
      .where(and(eq(casesTable.firmId, firmIdA), eq(casesTable.parcelNo, parcelNo)))
      .orderBy(desc(casesTable.createdAt))
      .limit(1);
    createdCaseId = rows[0]?.id;
  }
  expect(createdCaseId).toBeTruthy();
});

afterAll(async () => {
  if (!createdCaseId) return;
  await db.delete(caseWorkflowDocumentsTable).where(and(eq(caseWorkflowDocumentsTable.firmId, firmIdA), eq(caseWorkflowDocumentsTable.caseId, createdCaseId)));
  await db.delete(casePurchasersTable).where(eq(casePurchasersTable.caseId, createdCaseId));
  await db.delete(caseAssignmentsTable).where(eq(caseAssignmentsTable.caseId, createdCaseId));
  await db.delete(casesTable).where(and(eq(casesTable.firmId, firmIdA), eq(casesTable.id, createdCaseId)));
  await db.delete(clientsTable).where(and(
    eq(clientsTable.firmId, firmIdA),
    or(eq(clientsTable.icNo, purchaserIc), eq(clientsTable.name, "WF Docs Test")),
  ));
});

describe("Case workflow documents API", () => {
  it("GET returns empty list for fresh case", async () => {
    const res = await request(app)
      .get(`/api/cases/${createdCaseId}/workflow-documents`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
  });

  it("rejects invalid milestoneKey", async () => {
    const res = await request(app)
      .get(`/api/cases/${createdCaseId}/workflow-documents?milestoneKey=bad_key`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(422);
  });

  it("POST rejects invalid milestoneKey", async () => {
    const res = await request(app)
      .post(`/api/cases/${createdCaseId}/workflow-documents`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        milestoneKey: "bad_key",
        objectPath: `/objects/cases/${firmIdA}/case-${createdCaseId}/workflow/bad_key/x.pdf`,
        fileName: "x.pdf",
        mimeType: "application/pdf",
        fileSize: 1,
        dateYmd: "2026-04-09",
      });
    expect(res.status).toBe(422);
  });

  it("POST creates then replaces, and delete old object is invoked", async () => {
    const objectPath1 = `/objects/cases/${firmIdA}/case-${createdCaseId}/workflow/spa_stamped/${Date.now()}-a.pdf`;
    const objectPath2 = `/objects/cases/${firmIdA}/case-${createdCaseId}/workflow/spa_stamped/${Date.now()}-b.pdf`;

    const res = await request(app)
      .post(`/api/cases/${createdCaseId}/workflow-documents`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        milestoneKey: "spa_stamped",
        objectPath: objectPath1,
        fileName: "spa.pdf",
        mimeType: "application/pdf",
        fileSize: 123,
        dateYmd: "2026-04-09",
      });
    expect(res.status).toBe(201);
    expect(res.body.milestoneKey).toBe("spa_stamped");

    const spyDel = vi.spyOn(SupabaseStorageService.prototype, "deletePrivateObject").mockResolvedValueOnce(undefined);
    const res2 = await request(app)
      .post(`/api/cases/${createdCaseId}/workflow-documents`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        milestoneKey: "spa_stamped",
        objectPath: objectPath2,
        fileName: "spa2.pdf",
        mimeType: "application/pdf",
        fileSize: 456,
        dateYmd: "2026-04-10",
      });
    expect(res2.status).toBe(200);
    expect(spyDel).toHaveBeenCalledTimes(1);
    expect(spyDel.mock.calls[0][0]).toBe(objectPath1);
    spyDel.mockRestore();
  });

  it("download success streams with correct headers (mocked storage)", async () => {
    const [row] = await db
      .select({ id: caseWorkflowDocumentsTable.id })
      .from(caseWorkflowDocumentsTable)
      .where(and(
        eq(caseWorkflowDocumentsTable.firmId, firmIdA),
        eq(caseWorkflowDocumentsTable.caseId, createdCaseId),
        eq(caseWorkflowDocumentsTable.milestoneKey, "spa_stamped"),
      ))
      .limit(1);
    expect(row?.id).toBeTruthy();

    const spy = vi
      .spyOn(SupabaseStorageService.prototype, "fetchPrivateObjectResponse")
      .mockResolvedValueOnce(new Response(Buffer.from("ok"), { status: 200, headers: { "content-type": "application/pdf" } }));

    const res = await request(app)
      .get(`/api/cases/${createdCaseId}/workflow-documents/${row.id}/download`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(String(res.headers["content-disposition"] || "")).toContain("attachment");

    spy.mockRestore();
  });

  it("download returns 404 when file missing (mocked storage)", async () => {
    const [row] = await db
      .select({ id: caseWorkflowDocumentsTable.id })
      .from(caseWorkflowDocumentsTable)
      .where(and(
        eq(caseWorkflowDocumentsTable.firmId, firmIdA),
        eq(caseWorkflowDocumentsTable.caseId, createdCaseId),
        eq(caseWorkflowDocumentsTable.milestoneKey, "spa_stamped"),
      ))
      .limit(1);
    expect(row?.id).toBeTruthy();

    const spy = vi
      .spyOn(SupabaseStorageService.prototype, "fetchPrivateObjectResponse")
      .mockRejectedValueOnce(new ObjectNotFoundError());
    const res = await request(app)
      .get(`/api/cases/${createdCaseId}/workflow-documents/${row.id}/download`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(404);
    spy.mockRestore();
  });

  it("download returns 503 when storage unavailable (mocked config error)", async () => {
    const [row] = await db
      .select({ id: caseWorkflowDocumentsTable.id })
      .from(caseWorkflowDocumentsTable)
      .where(and(
        eq(caseWorkflowDocumentsTable.firmId, firmIdA),
        eq(caseWorkflowDocumentsTable.caseId, createdCaseId),
        eq(caseWorkflowDocumentsTable.milestoneKey, "spa_stamped"),
      ))
      .limit(1);
    expect(row?.id).toBeTruthy();

    const spy = vi
      .spyOn(SupabaseStorageService.prototype, "fetchPrivateObjectResponse")
      .mockRejectedValueOnce(new Error("SUPABASE_SERVICE_ROLE_KEY not set"));
    const res = await request(app)
      .get(`/api/cases/${createdCaseId}/workflow-documents/${row.id}/download`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(503);
    spy.mockRestore();
    expect(getSupabaseStorageConfigError(new Error("SUPABASE_SERVICE_ROLE_KEY not set"))?.statusCode).toBe(503);
  });

  it("cross-firm access is denied by caseId+firmId binding", async () => {
    const res = await request(app)
      .get(`/api/cases/${createdCaseId}/workflow-documents`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });
});
