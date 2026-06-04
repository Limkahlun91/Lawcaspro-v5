import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../app";
import { db, casesTable, casePurchasersTable, caseAssignmentsTable, clientsTable } from "@workspace/db";
import { eq, and, desc, or, inArray } from "drizzle-orm";

let partnerToken: string;
let partnerFirmId: number;
let projectId: number;
let developerId: number;
let wrongDeveloperId: number;
let lawyerUserId: number;

beforeAll(async () => {
  const loginRes = await request(app)
    .post("/api/auth/login")
    .send({ email: "partner@tan-associates.my", password: "lawyer123" });
  partnerToken = loginRes.body.data.token;
  partnerFirmId = loginRes.body.data.firmId;

  // Pre-clean test clients (cascade through case_purchasers first to avoid FK violations)
  const testClients = await db.select().from(clientsTable).where(and(
    eq(clientsTable.firmId, partnerFirmId),
    or(
      eq(clientsTable.icNo, "801231-07-0001"),
      eq(clientsTable.icNo, "820405-07-0002"),
      eq(clientsTable.icNo, "901010-07-0003"),
      eq(clientsTable.icNo, "TEST-DEDUP-IC-0001"),
      eq(clientsTable.name, "TEST-DEDUP-NAME-ONLY-USER")
    )
  ));
  for (const c of testClients) {
    await db.delete(casePurchasersTable).where(eq(casePurchasersTable.clientId, c.id));
    await db.delete(clientsTable).where(eq(clientsTable.id, c.id));
  }

  const projRes = await request(app)
    .get("/api/projects?limit=5")
    .set("Authorization", `Bearer ${partnerToken}`);
  const projects = projRes.body.data;
  projectId = projects[0].id;
  developerId = projects[0].developerId;

  // Pick a different developerId to test mismatch (use another project's developer, or fallback to developerId + 99999)
  const otherProject = projects.find((p: { developerId: number }) => p.developerId !== developerId);
  wrongDeveloperId = otherProject ? otherProject.developerId : developerId + 99999;

  const usersRes = await request(app)
    .get("/api/users?limit=10")
    .set("Authorization", `Bearer ${partnerToken}`);
  const lawyer = usersRes.body.data.find(
    (u: { roleName?: string }) =>
      u.roleName?.toLowerCase().includes("lawyer") || u.roleName?.toLowerCase().includes("partner")
  );
  lawyerUserId = lawyer.id;
});

afterAll(async () => {
  const testParcelNos = [
    "TEST-REGRESSION-001",
  ];
  const testCases = await db
    .select()
    .from(casesTable)
    .where(and(
      eq(casesTable.firmId, partnerFirmId),
      inArray(casesTable.parcelNo, testParcelNos),
    ))
    .orderBy(desc(casesTable.createdAt));
  for (const c of testCases) {
    await db.delete(casePurchasersTable).where(eq(casePurchasersTable.caseId, c.id));
    await db.delete(caseAssignmentsTable).where(eq(caseAssignmentsTable.caseId, c.id));
    await db.delete(casesTable).where(eq(casesTable.id, c.id));
  }
  // Clean up inline-created test clients
  await db.delete(clientsTable).where(and(
    eq(clientsTable.firmId, partnerFirmId),
    or(
      eq(clientsTable.icNo, "801231-07-0001"),
      eq(clientsTable.icNo, "820405-07-0002"),
      eq(clientsTable.icNo, "901010-07-0003"),
      eq(clientsTable.icNo, "TEST-DEDUP-IC-0001"),
      eq(clientsTable.name, "TEST-DEDUP-NAME-ONLY-USER")
    )
  ));
});

describe("POST /api/cases — create case regression", () => {
  it("returns structured validation errors when body is empty", async () => {
    const res = await request(app)
      .post("/api/cases")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
    expect(res.body.fields).toHaveProperty("caseType");
    expect(typeof res.body.fields).toBe("object");
  });

  it("Perfection minimal payload succeeds (no titleType/project/developer/purchasers)", async () => {
    const res = await request(app)
      .post("/api/cases")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        caseType: "perfection",
        perfectionType: "transfer_and_charge",
        parcelNo: "TEST-REGRESSION-001",
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.approvalStatus).toBe("pending_approval");
    expect(res.body.referenceNo).toBeNull();
    expect(res.body.projectId).toBeNull();
    expect(res.body.developerId).toBeNull();
  });

  it("Subsale minimal payload succeeds", async () => {
    const res = await request(app)
      .post("/api/cases")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        caseType: "subsale",
        titleType: "master",
        landCondition: "freehold",
        encumbrances: "no_encumbrance",
        actingFor: "vendor",
        parcelNo: "TEST-REGRESSION-001",
      });
    expect(res.status).toBe(201);
    expect(res.body.approvalStatus).toBe("pending_approval");
    expect(res.body.referenceNo).toBeNull();
    expect(res.body.projectId).toBeNull();
    expect(res.body.developerId).toBeNull();
  });

  it("Developer Sales minimal payload succeeds (no referenceNo / no purchasers required)", async () => {
    const res = await request(app)
      .post("/api/cases")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        caseType: "developer_sales",
        projectId,
        developerId,
        purchaseMode: "cash",
        titleType: "master",
        parcelNo: "TEST-REGRESSION-001",
      });
    expect(res.status).toBe(201);
    expect(res.body.approvalStatus).toBe("pending_approval");
    expect(res.body.referenceNo).toBeNull();
  });

  it("creates a case successfully with inline purchasers", async () => {
    // "801231-07-0001" was created in the first passing test
    const res = await request(app)
      .post("/api/cases")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        caseType: "developer_sales",
        projectId,
        purchaseMode: "loan",
        titleType: "master",
        purchasers: [
          { name: "Regression Purchaser One", ic: "801231-07-0001" },
          { name: "Regression Purchaser Two", ic: "820405-07-0002" },
        ],
        parcelNo: "TEST-REGRESSION-001",
      });
    expect(res.status).toBe(201);
    expect(res.body.referenceNo).toBeNull();
    expect(res.body.purchasers).toHaveLength(2);
  });

  it("returns 401 when creating a case without authentication", async () => {
    const res = await request(app)
      .post("/api/cases")
      .send({ projectId, purchaseMode: "loan", titleType: "master", assignedLawyerId: lawyerUserId });
    expect(res.status).toBe(401);
  });
});
