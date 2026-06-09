import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import app from "../app";
import {
  caseAssignmentsTable,
  casesTable,
  db,
  developersTable,
  firmFileRefSettingsTable,
  projectsTable,
} from "@workspace/db";

const skipDb = process.env.VITEST_SKIP_DB === "1" || !process.env.DATABASE_URL;
const suite = skipDb ? describe.skip : describe;

let token = "";
let firmId = 0;
let lawyerUserId = 0;
let developerId = 0;
let projectId = 0;
const createdCaseIds: number[] = [];

async function createDeveloperSalesCase(parcelNo: string): Promise<number> {
  const res = await request(app)
    .post("/api/cases")
    .set("Authorization", `Bearer ${token}`)
    .send({
      caseType: "developer_sales",
      developerId,
      projectId,
      purchaseMode: "cash",
      titleType: "master",
      assignedLawyerId: lawyerUserId,
      parcelNo,
    });

  expect(res.status).toBe(201);
  const caseId = Number(res.body.id);
  createdCaseIds.push(caseId);
  return caseId;
}

if (!skipDb) {
  beforeAll(async () => {
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: "partner@tan-associates.my", password: "lawyer123" });
    expect(loginRes.status).toBe(200);

    token = String(loginRes.body.data.token);
    firmId = Number(loginRes.body.data.firmId);

    const usersRes = await request(app)
      .get("/api/users?limit=10")
      .set("Authorization", `Bearer ${token}`);
    expect(usersRes.status).toBe(200);
    lawyerUserId = Number(usersRes.body.data[0].id);

    const [developer] = await db.insert(developersTable).values({
      firmId,
      name: "Maju Sepakat",
    }).returning({ id: developersTable.id });
    developerId = Number(developer.id);

    const [project] = await db.insert(projectsTable).values({
      firmId,
      developerId,
      name: "Legasi",
      developerName: "Maju Sepakat",
      projectType: "highrise",
      titleType: "master",
      extraFields: { projectRefCode: "LEGASI" },
    }).returning({ id: projectsTable.id });
    projectId = Number(project.id);
  });

  afterAll(async () => {
    for (const caseId of createdCaseIds) {
      await db.delete(caseAssignmentsTable).where(eq(caseAssignmentsTable.caseId, caseId));
      await db.delete(casesTable).where(eq(casesTable.id, caseId));
    }
    await db.delete(firmFileRefSettingsTable).where(and(
      eq(firmFileRefSettingsTable.firmId, firmId),
      eq(firmFileRefSettingsTable.caseType, `project_${projectId}`),
    ));
    if (projectId) {
      await db.delete(projectsTable).where(eq(projectsTable.id, projectId));
    }
    if (developerId) {
      await db.delete(developersTable).where(eq(developersTable.id, developerId));
    }
  });
}

suite("reference suggestions", () => {
  it("returns starting number, next number, highest existing number and warning for project-specific rules", async () => {
    const saveSetting = await request(app)
      .put("/api/firm-file-ref-settings")
      .set("Authorization", `Bearer ${token}`)
      .send({
        caseType: `project_${projectId}`,
        formatPattern: "CON/{DEVELOPER_CODE}-{PROJECT_CODE}/{SEQ:4}/{YY}({LAWYER_INITIALS}){CLERK_INITIALS}",
        startingSequence: 4000,
        currentSequence: 4000,
      });
    expect(saveSetting.status).toBe(200);
    expect(saveSetting.body.startingSequence).toBe(4000);
    expect(saveSetting.body.currentSequence).toBe(4000);

    const firstPendingCaseId = await createDeveloperSalesCase(`SEQ-PENDING-${Date.now()}-A`);
    const firstSuggestion = await request(app)
      .get("/api/cases/reference-suggestions")
      .query({ caseId: firstPendingCaseId })
      .set("Authorization", `Bearer ${token}`);
    expect(firstSuggestion.status).toBe(200);
    expect(firstSuggestion.body.startingNumber).toBe(4000);
    expect(firstSuggestion.body.nextNumber).toBe(4000);
    expect(firstSuggestion.body.highestExistingNumber).toBeNull();
    expect(firstSuggestion.body.suggestedReference.startsWith("CON/MS-LEGASI/4000/")).toBe(true);

    const approvedCaseId = await createDeveloperSalesCase(`SEQ-APPROVED-${Date.now()}-B`);
    const approveRes = await request(app)
      .post(`/api/cases/${approvedCaseId}/approve`)
      .set("Authorization", `Bearer ${token}`)
      .send({ referenceNo: "CON/MS-LEGASI/4005/26(FYS)GHY", approvalNote: null });
    expect(approveRes.status).toBe(200);

    const secondPendingCaseId = await createDeveloperSalesCase(`SEQ-PENDING-${Date.now()}-C`);
    const secondSuggestion = await request(app)
      .get("/api/cases/reference-suggestions")
      .query({ caseId: secondPendingCaseId })
      .set("Authorization", `Bearer ${token}`);
    expect(secondSuggestion.status).toBe(200);
    expect(secondSuggestion.body.startingNumber).toBe(4000);
    expect(secondSuggestion.body.highestExistingNumber).toBe(4005);
    expect(secondSuggestion.body.nextNumber).toBe(4006);
    expect(secondSuggestion.body.sequenceWarning).toBe("This number is lower than existing references. The system will continue from the highest existing number.");
    expect(secondSuggestion.body.suggestedReference.startsWith("CON/MS-LEGASI/4006/")).toBe(true);
  });

  it("keeps duplicate checks and allows manual reference approval", async () => {
    const approvedManualCaseId = await createDeveloperSalesCase(`MANUAL-${Date.now()}-A`);
    const firstApprove = await request(app)
      .post(`/api/cases/${approvedManualCaseId}/approve`)
      .set("Authorization", `Bearer ${token}`)
      .send({ referenceNo: "MANUAL-REF-1001", approvalNote: null });
    expect(firstApprove.status).toBe(200);

    const duplicateCaseId = await createDeveloperSalesCase(`MANUAL-${Date.now()}-B`);
    const duplicateSuggestion = await request(app)
      .get("/api/cases/reference-suggestions")
      .query({ caseId: duplicateCaseId, referenceNo: "MANUAL-REF-1001" })
      .set("Authorization", `Bearer ${token}`);
    expect(duplicateSuggestion.status).toBe(200);
    expect(duplicateSuggestion.body.duplicateWarning?.isDuplicate).toBe(true);

    const duplicateApprove = await request(app)
      .post(`/api/cases/${duplicateCaseId}/approve`)
      .set("Authorization", `Bearer ${token}`)
      .send({ referenceNo: "MANUAL-REF-1001", approvalNote: null });
    expect(duplicateApprove.status).toBe(409);

    const uniqueApprove = await request(app)
      .post(`/api/cases/${duplicateCaseId}/approve`)
      .set("Authorization", `Bearer ${token}`)
      .send({ referenceNo: "MANUAL-REF-1002", approvalNote: null });
    expect(uniqueApprove.status).toBe(200);
  });
});
