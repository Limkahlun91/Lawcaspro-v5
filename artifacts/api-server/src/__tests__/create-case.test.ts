import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../app";
import { db, casesTable, casePurchasersTable, caseAssignmentsTable, clientsTable } from "@workspace/db";
import { eq, and, desc, or } from "drizzle-orm";

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
  partnerToken = loginRes.body.token;
  partnerFirmId = loginRes.body.firmId;

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
  const testCases = await db
    .select()
    .from(casesTable)
    .where(and(eq(casesTable.firmId, partnerFirmId), eq(casesTable.parcelNo, "TEST-REGRESSION-001")))
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
  it("returns structured validation errors (not raw Zod string) when body is empty", async () => {
    const res = await request(app)
      .post("/api/cases")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
    expect(res.body.fields).toHaveProperty("projectId");
    // developerId is now optional — server derives it; should NOT appear as required error
    expect(res.body.fields).not.toHaveProperty("developerId");
    expect(res.body.fields).toHaveProperty("purchaseMode");
    expect(res.body.fields).toHaveProperty("titleType");
    expect(res.body.fields).toHaveProperty("assignedLawyerId");
    expect(typeof res.body.fields).toBe("object");
  });

  it("creates a case successfully with inline purchaser data (no pre-existing client IDs)", async () => {
    const res = await request(app)
      .post("/api/cases")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        projectId,
        purchaseMode: "loan",
        titleType: "master",
        assignedLawyerId: lawyerUserId,
        purchasers: [
          { name: "Regression Purchaser One", ic: "801231-07-0001" },
          { name: "Regression Purchaser Two", ic: "820405-07-0002" },
        ],
        caseType: "Primary Market",
        parcelNo: "TEST-REGRESSION-001",
        spaDetails: { contactNumber: "012-9999999" },
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.referenceNo).toMatch(/^LCP-/);
    expect(res.body.purchasers).toHaveLength(2);
    expect(res.body.purchasers[0].clientName).toBe("Regression Purchaser One");
    expect(res.body.purchasers[1].clientName).toBe("Regression Purchaser Two");
    expect(res.body.purchasers[0].role).toBe("main");
    expect(res.body.purchasers[1].role).toBe("joint");
    expect(res.body.purchasersCreated).toBe(2);
    expect(res.body.purchasersReused).toBe(0);
  });

  it("auto-creates client records from inline purchaser names in the DB", async () => {
    const clients = await db
      .select()
      .from(clientsTable)
      .where(and(eq(clientsTable.firmId, partnerFirmId), eq(clientsTable.name, "Regression Purchaser One")));
    expect(clients.length).toBeGreaterThanOrEqual(1);
    expect(clients[0].icNo).toBe("801231-07-0001");
    expect(clients[0].firmId).toBe(partnerFirmId);
  });

  it("server derives developerId from projectId — no developerId in request", async () => {
    const res = await request(app)
      .post("/api/cases")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        projectId,
        // developerId intentionally omitted
        purchaseMode: "cash",
        titleType: "strata",
        assignedLawyerId: lawyerUserId,
        purchasers: [{ name: "DeveloperDerivation Test", ic: "901010-07-0003" }],
        parcelNo: "TEST-REGRESSION-001",
      });
    expect(res.status).toBe(201);
    expect(res.body.developerId).toBe(developerId);
    expect(res.body.developerName).not.toBe("Unknown");
    expect(res.body.projectId).toBe(projectId);
    expect(res.body.projectName).not.toBe("Unknown");
  });

  it("returns 409 when client sends developerId that does not match the project's developer", async () => {
    const res = await request(app)
      .post("/api/cases")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        projectId,
        developerId: wrongDeveloperId,
        purchaseMode: "cash",
        titleType: "master",
        assignedLawyerId: lawyerUserId,
        purchasers: [{ name: "Mismatch Test Purchaser", ic: "111111-11-1111" }],
        parcelNo: "TEST-REGRESSION-001",
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/does not match/i);
    expect(res.body.expected).toBe(developerId);
    expect(res.body.received).toBe(wrongDeveloperId);
  });

  it("reuses existing client when IC matches (IC-based dedupe)", async () => {
    // "801231-07-0001" was created in the first passing test
    const clientsBefore = await db
      .select()
      .from(clientsTable)
      .where(and(eq(clientsTable.firmId, partnerFirmId), eq(clientsTable.icNo, "801231-07-0001")));
    const countBefore = clientsBefore.length;

    const res = await request(app)
      .post("/api/cases")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        projectId,
        purchaseMode: "cash",
        titleType: "master",
        assignedLawyerId: lawyerUserId,
        purchasers: [{ name: "Regression Purchaser One", ic: "801231-07-0001" }],
        parcelNo: "TEST-REGRESSION-001",
      });
    expect(res.status).toBe(201);
    expect(res.body.purchasersReused).toBe(1);
    expect(res.body.purchasersCreated).toBe(0);

    // No duplicate client should have been created
    const clientsAfter = await db
      .select()
      .from(clientsTable)
      .where(and(eq(clientsTable.firmId, partnerFirmId), eq(clientsTable.icNo, "801231-07-0001")));
    expect(clientsAfter.length).toBe(countBefore);
  });

  it("reuses existing client when name matches exactly (name-based dedupe, no IC)", async () => {
    const uniqueName = "TEST-DEDUP-NAME-ONLY-USER";

    // First case: creates the client (no IC provided)
    const res1 = await request(app)
      .post("/api/cases")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        projectId,
        purchaseMode: "cash",
        titleType: "master",
        assignedLawyerId: lawyerUserId,
        purchasers: [{ name: uniqueName }],
        parcelNo: "TEST-REGRESSION-001",
      });
    expect(res1.status).toBe(201);

    const clientsAfterFirst = await db
      .select()
      .from(clientsTable)
      .where(and(eq(clientsTable.firmId, partnerFirmId), eq(clientsTable.name, uniqueName)));
    expect(clientsAfterFirst.length).toBe(1);

    // Second case: same name, no IC — backend should reuse
    const res2 = await request(app)
      .post("/api/cases")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        projectId,
        purchaseMode: "cash",
        titleType: "master",
        assignedLawyerId: lawyerUserId,
        purchasers: [{ name: uniqueName }],
        parcelNo: "TEST-REGRESSION-001",
      });
    expect(res2.status).toBe(201);
    expect(res2.body.purchasersReused).toBe(1);
    expect(res2.body.purchasersCreated).toBe(0);

    // Still only one client record
    const clientsAfterSecond = await db
      .select()
      .from(clientsTable)
      .where(and(eq(clientsTable.firmId, partnerFirmId), eq(clientsTable.name, uniqueName)));
    expect(clientsAfterSecond.length).toBe(1);
  });

  it("returns 400 when purchasers array is missing or all names are blank", async () => {
    const res = await request(app)
      .post("/api/cases")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        projectId,
        purchaseMode: "loan",
        titleType: "master",
        assignedLawyerId: lawyerUserId,
        purchasers: [{ name: "  ", ic: "" }],
        parcelNo: "TEST-REGRESSION-001",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("At least one purchaser name is required");
  });

  it("returns 401 when creating a case without authentication", async () => {
    const res = await request(app)
      .post("/api/cases")
      .send({ projectId, purchaseMode: "loan", titleType: "master", assignedLawyerId: lawyerUserId });
    expect(res.status).toBe(401);
  });
});
