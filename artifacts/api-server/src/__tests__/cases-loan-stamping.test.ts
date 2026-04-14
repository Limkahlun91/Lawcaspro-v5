import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../app";
import { db, casesTable, casePurchasersTable, caseAssignmentsTable, clientsTable, caseLoanStampingItemsTable } from "@workspace/db";
import { and, eq, desc, or } from "drizzle-orm";

let token: string;
let firmId: number;
let projectId: number;
let lawyerUserId: number;
let createdCaseId: number;
let parcelNo: string;
let purchaserIc: string;

beforeAll(async () => {
  const loginRes = await request(app)
    .post("/api/auth/login")
    .send({ email: "partner@tan-associates.my", password: "lawyer123" });
  token = loginRes.body.token;
  firmId = loginRes.body.firmId;
  expect(loginRes.status).toBe(200);

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
  parcelNo = `TEST-STAMPING-${suffix}`;
  purchaserIc = `901010-07-${suffix.slice(-4).padStart(4, "0")}`;

  const createRes = await request(app)
    .post("/api/cases")
    .set("Authorization", `Bearer ${token}`)
    .send({
      projectId,
      purchaseMode: "loan",
      titleType: "master",
      assignedLawyerId: lawyerUserId,
      purchasers: [{ name: "Stamping Test", ic: purchaserIc }],
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
  await db.delete(caseLoanStampingItemsTable).where(and(eq(caseLoanStampingItemsTable.firmId, firmId), eq(caseLoanStampingItemsTable.caseId, createdCaseId)));
  await db.delete(casePurchasersTable).where(eq(casePurchasersTable.caseId, createdCaseId));
  await db.delete(caseAssignmentsTable).where(eq(caseAssignmentsTable.caseId, createdCaseId));
  await db.delete(casesTable).where(and(eq(casesTable.firmId, firmId), eq(casesTable.id, createdCaseId)));
  await db.delete(clientsTable).where(and(
    eq(clientsTable.firmId, firmId),
    or(eq(clientsTable.icNo, purchaserIc), eq(clientsTable.name, "Stamping Test")),
  ));
});

describe("Loan stamping API", () => {
  it("GET returns default empty list for new case", async () => {
    const res = await request(app)
      .get(`/api/cases/${createdCaseId}/loan-stamping`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("PUT saves fixed + other, and preserves sort_order ordering", async () => {
    const res = await request(app)
      .put(`/api/cases/${createdCaseId}/loan-stamping`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        items: [
          { itemKey: "facility_agreement", datedOn: "2026-04-09", stampedOn: "2026-04-10", sortOrder: 10 },
          { itemKey: "other", customName: "Custom Doc A", datedOn: "2026-04-11", stampedOn: null, sortOrder: 20 },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);

    const getRes = await request(app)
      .get(`/api/cases/${createdCaseId}/loan-stamping`)
      .set("Authorization", `Bearer ${token}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body[0].sortOrder).toBe(10);
    expect(getRes.body[1].sortOrder).toBe(20);
  });

  it("allows upload without manual Save (ensure row then bind file)", async () => {
    const ensured = await request(app)
      .post(`/api/cases/${createdCaseId}/loan-stamping/ensure`)
      .set("Authorization", `Bearer ${token}`)
      .send({ itemKey: "facility_agreement" });
    expect(ensured.status).toBe(200);
    const id = ensured.body.id;
    expect(id).toBeTruthy();

    const bind = await request(app)
      .post(`/api/cases/${createdCaseId}/loan-stamping/${id}/file`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        objectPath: `/objects/cases/${firmId}/case-${createdCaseId}/loan-stamping/${Date.now()}-fa.pdf`,
        fileName: "fa.pdf",
        mimeType: "application/pdf",
        fileSize: 12,
      });
    expect(bind.status).toBe(200);

    const list = await request(app)
      .get(`/api/cases/${createdCaseId}/loan-stamping`)
      .set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    const fa = list.body.find((x: any) => x.itemKey === "facility_agreement");
    expect(fa?.fileName).toBe("fa.pdf");
  });

  it("DELETE removes a row", async () => {
    const list = await request(app)
      .get(`/api/cases/${createdCaseId}/loan-stamping`)
      .set("Authorization", `Bearer ${token}`);
    const other = list.body.find((x: any) => x.itemKey === "other");
    expect(other?.id).toBeTruthy();

    const del = await request(app)
      .delete(`/api/cases/${createdCaseId}/loan-stamping/${other.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(204);
  });
});
