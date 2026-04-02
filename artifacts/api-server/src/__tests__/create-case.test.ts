import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../app";
import { db, casesTable, casePurchasersTable, caseAssignmentsTable, clientsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";

let partnerToken: string;
let partnerFirmId: number;
let projectId: number;
let developerId: number;
let lawyerUserId: number;

beforeAll(async () => {
  const loginRes = await request(app)
    .post("/api/auth/login")
    .send({ email: "partner@tan-associates.my", password: "lawyer123" });
  partnerToken = loginRes.body.token;
  partnerFirmId = loginRes.body.firmId;

  const projRes = await request(app)
    .get("/api/projects?limit=1")
    .set("Authorization", `Bearer ${partnerToken}`);
  projectId = projRes.body.data[0].id;
  developerId = projRes.body.data[0].developerId;

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
  // Clean up test cases created during this suite
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
    expect(res.body.fields).toHaveProperty("developerId");
    expect(res.body.fields).toHaveProperty("purchaseMode");
    expect(res.body.fields).toHaveProperty("titleType");
    expect(res.body.fields).toHaveProperty("assignedLawyerId");
    // Confirm it's a structured object, not raw JSON dump
    expect(typeof res.body.fields).toBe("object");
  });

  it("creates a case successfully with inline purchaser data (no pre-existing client IDs)", async () => {
    const res = await request(app)
      .post("/api/cases")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        projectId,
        developerId,
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

  it("derives developerId from selected project — case includes correct developer info", async () => {
    const res = await request(app)
      .post("/api/cases")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        projectId,
        developerId,
        purchaseMode: "cash",
        titleType: "strata",
        assignedLawyerId: lawyerUserId,
        purchasers: [{ name: "Developer Derivation Test", ic: "901010-07-0003" }],
        parcelNo: "TEST-REGRESSION-001",
      });
    expect(res.status).toBe(201);
    expect(res.body.developerId).toBe(developerId);
    expect(res.body.developerName).not.toBe("Unknown");
    expect(res.body.projectId).toBe(projectId);
    expect(res.body.projectName).not.toBe("Unknown");
  });

  it("returns 400 when purchasers array is missing or all names are blank", async () => {
    const res = await request(app)
      .post("/api/cases")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        projectId,
        developerId,
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
      .send({ projectId, developerId, purchaseMode: "loan", titleType: "master", assignedLawyerId: lawyerUserId });
    expect(res.status).toBe(401);
  });
});
