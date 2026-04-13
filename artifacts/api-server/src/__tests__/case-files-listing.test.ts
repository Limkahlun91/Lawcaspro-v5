import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../app";
import { db, casesTable, casePurchasersTable, caseAssignmentsTable, clientsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

let token: string;
let firmId: number;
let projectId: number;
let lawyerUserId: number;
let createdCaseId: number | null = null;

beforeAll(async () => {
  const loginRes = await request(app)
    .post("/api/auth/login")
    .send({ email: "partner@tan-associates.my", password: "lawyer123" });
  token = loginRes.body.token;
  firmId = loginRes.body.firmId;

  const projRes = await request(app)
    .get("/api/projects?limit=5")
    .set("Authorization", `Bearer ${token}`);
  projectId = projRes.body.data[0].id;

  const usersRes = await request(app)
    .get("/api/users?limit=10")
    .set("Authorization", `Bearer ${token}`);
  lawyerUserId = usersRes.body.data[0].id;
});

afterAll(async () => {
  if (!createdCaseId) return;
  await db.delete(casePurchasersTable).where(eq(casePurchasersTable.caseId, createdCaseId));
  await db.delete(caseAssignmentsTable).where(eq(caseAssignmentsTable.caseId, createdCaseId));
  await db.delete(casesTable).where(eq(casesTable.id, createdCaseId));
  await db.delete(clientsTable).where(and(eq(clientsTable.firmId, firmId), eq(clientsTable.icNo, "QA-LIST-0001")));
});

describe("Case file listing (regression)", () => {
  it("lists and searches across reference/client/bank and is read-only with status sourced from cases", async () => {
    const createRes = await request(app)
      .post("/api/cases")
      .set("Authorization", `Bearer ${token}`)
      .send({
        projectId,
        purchaseMode: "loan",
        titleType: "master",
        assignedLawyerId: lawyerUserId,
        purchasers: [{ name: "QA Listing Buyer", ic: "QA-LIST-0001" }],
        loanDetails: { endFinancier: "QA Bank Berhad", financingSum: 123456.78 },
        propertyDetails: { address: "QA Property Address" },
        parcelNo: "QA-LIST-CASE-001",
      });
    expect(createRes.status).toBe(201);
    createdCaseId = createRes.body.id;
    const ref = createRes.body.referenceNo;

    const detailRes = await request(app)
      .get(`/api/cases/${createdCaseId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.id).toBe(createdCaseId);

    const wfRes = await request(app)
      .get(`/api/cases/${createdCaseId}/workflow`)
      .set("Authorization", `Bearer ${token}`);
    expect(wfRes.status).toBe(200);
    expect(Array.isArray(wfRes.body)).toBe(true);

    const listRes = await request(app)
      .get("/api/case-files")
      .set("Authorization", `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body.data)).toBe(true);

    const byRef = await request(app)
      .get("/api/case-files")
      .query({ q: ref })
      .set("Authorization", `Bearer ${token}`);
    expect(byRef.status).toBe(200);
    expect(byRef.body.data.some((r: any) => r.id === createdCaseId)).toBe(true);

    const byClient = await request(app)
      .get("/api/case-files")
      .query({ q: "QA Listing Buyer" })
      .set("Authorization", `Bearer ${token}`);
    expect(byClient.status).toBe(200);
    expect(byClient.body.data.some((r: any) => r.id === createdCaseId)).toBe(true);

    const byBank = await request(app)
      .get("/api/case-files")
      .query({ q: "QA Bank" })
      .set("Authorization", `Bearer ${token}`);
    expect(byBank.status).toBe(200);
    expect(byBank.body.data.some((r: any) => r.id === createdCaseId)).toBe(true);

    const row = listRes.body.data.find((r: any) => r.id === createdCaseId);
    expect(row).toBeTruthy();
    expect(typeof row.status).toBe("string");
    expect(row.status).toBe("File Opened / SPA Pending Signing");
    expect(typeof row.openFileDate).toBe("string");
    expect(row.closedFileDate).toBeNull();
    expect("fileListingStatus" in row).toBe(false);
    expect("fileListingReason" in row).toBe(false);
  });
});
