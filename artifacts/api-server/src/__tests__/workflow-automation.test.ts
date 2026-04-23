import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import app from "../app";
import { db, casesTable, casePurchasersTable, caseAssignmentsTable, clientsTable, caseWorkflowDocumentsTable } from "@workspace/db";
import { and, eq, desc, or } from "drizzle-orm";
import { SupabaseStorageService, ObjectNotFoundError } from "../lib/objectStorage";

let token: string;
let firmId: number;
let projectId: number;
let lawyerUserId: number;
let createdCaseId: number;
let purchaserIc: string;

beforeAll(async () => {
  const loginRes = await request(app)
    .post("/api/auth/login")
    .send({ email: "partner@tan-associates.my", password: "lawyer123" });
  expect(loginRes.status).toBe(200);
  token = loginRes.body.data.token;
  firmId = loginRes.body.data.firmId;

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
  purchaserIc = `790101-07-${suffix.slice(-4).padStart(4, "0")}`;
  const parcelNo = `TEST-WF-AUTO-${suffix}`;

  const createRes = await request(app)
    .post("/api/cases")
    .set("Authorization", `Bearer ${token}`)
    .send({
      projectId,
      purchaseMode: "loan",
      titleType: "master",
      assignedLawyerId: lawyerUserId,
      purchasers: [{ name: "WF Auto Test", ic: purchaserIc }],
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
});

afterAll(async () => {
  if (!createdCaseId) return;
  await db.delete(caseWorkflowDocumentsTable).where(and(eq(caseWorkflowDocumentsTable.firmId, firmId), eq(caseWorkflowDocumentsTable.caseId, createdCaseId)));
  await db.delete(casePurchasersTable).where(eq(casePurchasersTable.caseId, createdCaseId));
  await db.delete(caseAssignmentsTable).where(eq(caseAssignmentsTable.caseId, createdCaseId));
  await db.delete(casesTable).where(and(eq(casesTable.firmId, firmId), eq(casesTable.id, createdCaseId)));
  await db.delete(clientsTable).where(and(
    eq(clientsTable.firmId, firmId),
    or(eq(clientsTable.icNo, purchaserIc), eq(clientsTable.name, "WF Auto Test")),
  ));
});

describe("Workflow automation (reversible + date+file rules)", () => {
  it("requires date+file for SPA stamped step; supports rollback on date clear and file missing status", async () => {
    const kd1 = await request(app)
      .patch(`/api/cases/${createdCaseId}/key-dates`)
      .set("Authorization", `Bearer ${token}`)
      .send({ spa_stamped_date: "2026-04-10" });
    expect(kd1.status).toBe(200);

    const wf1 = await request(app)
      .get(`/api/cases/${createdCaseId}/workflow`)
      .set("Authorization", `Bearer ${token}`);
    expect(wf1.status).toBe(200);
    const spaStep1 = wf1.body.find((x: any) => x.stepKey === "spa_stamped");
    expect(spaStep1.status).toBe("pending");

    const objectPath1 = `/objects/cases/${firmId}/case-${createdCaseId}/workflow/spa_stamped/${Date.now()}-spa.pdf`;
    const up = await request(app)
      .post(`/api/cases/${createdCaseId}/workflow-documents`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        milestoneKey: "spa_stamped",
        objectPath: objectPath1,
        fileName: "spa.pdf",
        mimeType: "application/pdf",
        fileSize: 123,
        dateYmd: "2026-04-10",
      });
    expect([200, 201]).toContain(up.status);
    const docId = up.body.id;

    const wf2 = await request(app)
      .get(`/api/cases/${createdCaseId}/workflow`)
      .set("Authorization", `Bearer ${token}`);
    const spaStep2 = wf2.body.find((x: any) => x.stepKey === "spa_stamped");
    expect(spaStep2.status).toBe("completed");

    const kd2 = await request(app)
      .patch(`/api/cases/${createdCaseId}/key-dates`)
      .set("Authorization", `Bearer ${token}`)
      .send({ spa_stamped_date: null });
    expect(kd2.status).toBe(200);

    const wf3 = await request(app)
      .get(`/api/cases/${createdCaseId}/workflow`)
      .set("Authorization", `Bearer ${token}`);
    const spaStep3 = wf3.body.find((x: any) => x.stepKey === "spa_stamped");
    expect(spaStep3.status).toBe("pending");

    const kd3 = await request(app)
      .patch(`/api/cases/${createdCaseId}/key-dates`)
      .set("Authorization", `Bearer ${token}`)
      .send({ spa_stamped_date: "2026-04-11" });
    expect(kd3.status).toBe(200);

    const wf4 = await request(app)
      .get(`/api/cases/${createdCaseId}/workflow`)
      .set("Authorization", `Bearer ${token}`);
    const spaStep4 = wf4.body.find((x: any) => x.stepKey === "spa_stamped");
    expect(spaStep4.status).toBe("completed");

    const del = await request(app)
      .delete(`/api/cases/${createdCaseId}/workflow-documents/${docId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(204);

    const wf5 = await request(app)
      .get(`/api/cases/${createdCaseId}/workflow`)
      .set("Authorization", `Bearer ${token}`);
    const spaStep5 = wf5.body.find((x: any) => x.stepKey === "spa_stamped");
    expect(spaStep5.status).toBe("pending");

    const prog = await request(app)
      .get(`/api/cases/${createdCaseId}/progress`)
      .set("Authorization", `Bearer ${token}`);
    expect(prog.status).toBe(200);
    const spaAttach = prog.body.attachments.find((x: any) => x.docKey === "spa_stamped");
    expect(spaAttach.status).toBe("missing_file");
  });

  it("download returns 404 when storage object not found (mocked)", async () => {
    const up = await request(app)
      .post(`/api/cases/${createdCaseId}/workflow-documents`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        milestoneKey: "spa_stamped",
        objectPath: `/objects/cases/${firmId}/case-${createdCaseId}/workflow/spa_stamped/${Date.now()}-spa.pdf`,
        fileName: "spa.pdf",
        mimeType: "application/pdf",
        fileSize: 123,
        dateYmd: "2026-04-12",
      });
    const docId = up.body.id;

    const spy = vi
      .spyOn(SupabaseStorageService.prototype, "fetchPrivateObjectResponse")
      .mockRejectedValueOnce(new ObjectNotFoundError());

    const dl = await request(app)
      .get(`/api/cases/${createdCaseId}/workflow-documents/${docId}/download`)
      .set("Authorization", `Bearer ${token}`);
    expect(dl.status).toBe(404);
    spy.mockRestore();
  });
});
