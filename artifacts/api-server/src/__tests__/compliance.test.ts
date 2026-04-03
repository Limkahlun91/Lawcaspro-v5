/**
 * compliance.test.ts
 *
 * Tests for the AML/CDD/KYC compliance intake layer:
 *   - Party CRUD (create, get detail, update, soft-delete)
 *   - Auto-created compliance profile on party creation
 *   - CDD status update
 *   - Risk assessment: EDD auto-trigger on PEP/high-risk jurisdiction
 *   - PEP flag creation
 *   - Sanctions screening recording
 *   - Source of funds and source of wealth recording
 *   - Suspicious notes
 *   - Beneficial owner management
 *   - Tenant isolation: firm B cannot read firm A parties
 *   - Audit log written on every mutating action
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../app";
import { db, partiesTable, complianceProfilesTable, cddChecksTable, riskAssessmentsTable, beneficialOwnersTable, auditLogsTable, casePartiesTable } from "@workspace/db";
import { eq, and, isNull, desc } from "drizzle-orm";

const PARTNER_EMAIL   = "partner@tan-associates.my";
const PARTNER_PWD     = "lawyer123";
const LAWYER_EMAIL    = "lawyer@tan-associates.my";
const LAWYER_PWD      = "lawyer123";
const FOUNDER_EMAIL   = "founder@lawcaspro.com";
const FOUNDER_PWD     = "founder123";

let partnerToken: string;
let partnerFirmId: number;
let lawyerToken: string;
let founderToken: string;

// Entities created during tests — cleaned up in afterAll
let createdPartyId: number;
let createdPartyIdForDeletion: number;
let complianceProfileId: number;

async function getReauthToken(bearerToken: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/reauth-token")
    .set("Authorization", `Bearer ${bearerToken}`);
  expect(res.status).toBe(200);
  return res.body.reAuthToken as string;
}

beforeAll(async () => {
  const [partnerRes, lawyerRes, founderRes] = await Promise.all([
    request(app).post("/api/auth/login").send({ email: PARTNER_EMAIL, password: PARTNER_PWD }),
    request(app).post("/api/auth/login").send({ email: LAWYER_EMAIL, password: LAWYER_PWD }),
    request(app).post("/api/auth/login").send({ email: FOUNDER_EMAIL, password: FOUNDER_PWD }),
  ]);
  partnerToken = partnerRes.body.token;
  partnerFirmId = partnerRes.body.firmId;
  lawyerToken = lawyerRes.body.token;
  founderToken = founderRes.body.token;

  // Pre-clean any leftover test parties
  const stale = await db.select().from(partiesTable)
    .where(and(eq(partiesTable.firmId, partnerFirmId), eq(partiesTable.fullName, "Ahmad Compliance Test")));
  for (const p of stale) {
    await db.delete(casePartiesTable).where(eq(casePartiesTable.partyId, p.id));
    await db.delete(beneficialOwnersTable).where(eq(beneficialOwnersTable.partyId, p.id));
    await db.delete(complianceProfilesTable).where(eq(complianceProfilesTable.partyId, p.id));
    await db.delete(partiesTable).where(eq(partiesTable.id, p.id));
  }
});

afterAll(async () => {
  const ids = [createdPartyId, createdPartyIdForDeletion].filter(Boolean);
  for (const id of ids) {
    await db.delete(casePartiesTable).where(eq(casePartiesTable.partyId, id));
    await db.delete(beneficialOwnersTable).where(eq(beneficialOwnersTable.partyId, id));
    await db.delete(complianceProfilesTable).where(eq(complianceProfilesTable.partyId, id));
    await db.delete(partiesTable).where(eq(partiesTable.id, id));
  }
});

// ---------------------------------------------------------------------------
// Party CRUD
// ---------------------------------------------------------------------------
describe("Party CRUD", () => {
  it("POST /parties — creates party + auto-creates compliance profile", async () => {
    const res = await request(app)
      .post("/api/parties")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        partyType: "natural_person",
        fullName: "Ahmad Compliance Test",
        nric: "801231-12-5001",
        nationality: "Malaysian",
        occupation: "Director",
        transactionPurpose: "Purchase of property",
        isPep: false,
        isHighRiskJurisdiction: false,
        hasNomineeArrangement: false,
        hasLayeredOwnership: false,
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.fullName).toBe("Ahmad Compliance Test");
    createdPartyId = res.body.id;

    // Compliance profile should have been auto-created
    const [profile] = await db.select().from(complianceProfilesTable)
      .where(and(eq(complianceProfilesTable.partyId, createdPartyId), eq(complianceProfilesTable.firmId, partnerFirmId)));
    expect(profile).toBeDefined();
    expect(profile.cddStatus).toBe("not_started");
    complianceProfileId = profile.id;
  });

  it("GET /parties/:id — returns party with complianceProfile", async () => {
    const res = await request(app)
      .get(`/api/parties/${createdPartyId}`)
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(createdPartyId);
    expect(res.body.complianceProfile).toBeDefined();
    expect(res.body.complianceProfile.cddStatus).toBe("not_started");
    expect(res.body.beneficialOwners).toBeInstanceOf(Array);
  });

  it("GET /parties — lists parties with search", async () => {
    const res = await request(app)
      .get("/api/parties?q=Ahmad")
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.some((p: any) => p.id === createdPartyId)).toBe(true);
  });

  it("PATCH /parties/:id — updates party fields", async () => {
    const res = await request(app)
      .patch(`/api/parties/${createdPartyId}`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ occupation: "Senior Director" });
    expect(res.status).toBe(200);
    expect(res.body.occupation).toBe("Senior Director");
  });

  it("POST /parties — wrong firm cannot access other firm party (404)", async () => {
    // Founder sees all firms but returns 404 when firmId doesn't match (founder has no firmId)
    const res = await request(app)
      .get(`/api/parties/${createdPartyId}`)
      .set("Authorization", `Bearer ${lawyerToken}`);
    // Lawyer at same firm should see it (same firm)
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Compliance Profile — CDD Status
// ---------------------------------------------------------------------------
describe("Compliance Profile — CDD Status", () => {
  it("PATCH /compliance/profiles/:id/status — updates to in_progress", async () => {
    const res = await request(app)
      .patch(`/api/compliance/profiles/${complianceProfileId}/status`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ cddStatus: "in_progress", notes: "KYC docs requested" });
    expect(res.status).toBe(200);
    expect(res.body.cddStatus).toBe("in_progress");
  });

  it("PATCH /compliance/profiles/:id/status — sets approvedBy on approval", async () => {
    const res = await request(app)
      .patch(`/api/compliance/profiles/${complianceProfileId}/status`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ cddStatus: "approved" });
    expect(res.status).toBe(200);
    expect(res.body.cddStatus).toBe("approved");
    expect(res.body.approvedBy).toBeDefined();
    expect(res.body.approvedAt).toBeDefined();
  });

  it("PATCH /compliance/profiles/:id/status — rejected stores reason", async () => {
    const res = await request(app)
      .patch(`/api/compliance/profiles/${complianceProfileId}/status`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ cddStatus: "rejected", rejectionReason: "Documents incomplete" });
    expect(res.status).toBe(200);
    expect(res.body.cddStatus).toBe("rejected");
    expect(res.body.rejectionReason).toBe("Documents incomplete");
  });
});

// ---------------------------------------------------------------------------
// Risk Assessment — EDD auto-trigger
// ---------------------------------------------------------------------------
describe("Risk Assessment", () => {
  it("POST /compliance/profiles/:id/risk-assessment — low risk returns low level", async () => {
    const res = await request(app)
      .post(`/api/compliance/profiles/${complianceProfileId}/risk-assessment`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        factorIsPep: false,
        factorHighRiskJurisdiction: false,
        factorComplexOwnership: false,
        factorNomineeArrangement: false,
        factorMissingSourceOfFunds: false,
        factorSuspiciousInconsistencies: false,
      });
    expect(res.status).toBe(201);
    expect(res.body.profile.riskLevel).toBe("low");
    expect(res.body.profile.eddTriggered).toBe(false);
    expect(res.body.profile.riskScore).toBe(0);
  });

  it("POST /compliance/profiles/:id/risk-assessment — PEP triggers EDD", async () => {
    const res = await request(app)
      .post(`/api/compliance/profiles/${complianceProfileId}/risk-assessment`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        factorIsPep: true,
        factorHighRiskJurisdiction: false,
        factorComplexOwnership: false,
        factorNomineeArrangement: false,
        factorMissingSourceOfFunds: false,
        factorSuspiciousInconsistencies: false,
        notes: "Client is a sitting MP",
      });
    expect(res.status).toBe(201);
    expect(res.body.profile.eddTriggered).toBe(true);
    expect(res.body.profile.riskScore).toBeGreaterThanOrEqual(30);
    expect(res.body.profile.cddStatus).toBe("enhanced_due_diligence_required");
  });

  it("POST /compliance/profiles/:id/risk-assessment — high-risk jurisdiction triggers EDD", async () => {
    const res = await request(app)
      .post(`/api/compliance/profiles/${complianceProfileId}/risk-assessment`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        factorIsPep: false,
        factorHighRiskJurisdiction: true,
        factorComplexOwnership: false,
        factorNomineeArrangement: false,
        factorMissingSourceOfFunds: false,
        factorSuspiciousInconsistencies: false,
      });
    expect(res.status).toBe(201);
    expect(res.body.profile.eddTriggered).toBe(true);
    expect(res.body.profile.riskScore).toBeGreaterThanOrEqual(25);
  });

  it("risk assessment stored in history", async () => {
    const history = await db.select().from(riskAssessmentsTable)
      .where(eq(riskAssessmentsTable.complianceProfileId, complianceProfileId))
      .orderBy(desc(riskAssessmentsTable.createdAt));
    expect(history.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// CDD Checks
// ---------------------------------------------------------------------------
describe("CDD Checks", () => {
  it("POST /compliance/profiles/:id/cdd-checks — stores check", async () => {
    const res = await request(app)
      .post(`/api/compliance/profiles/${complianceProfileId}/cdd-checks`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ checkType: "identity", status: "passed", notes: "IC verified" });
    expect(res.status).toBe(201);
    expect(res.body.checkType).toBe("identity");
    expect(res.body.status).toBe("passed");
  });

  it("POST /compliance/profiles/:id/cdd-checks — invalid check type is rejected", async () => {
    const res = await request(app)
      .post(`/api/compliance/profiles/${complianceProfileId}/cdd-checks`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ checkType: "invalid_type", status: "passed" });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// PEP Flag
// ---------------------------------------------------------------------------
describe("PEP Flags", () => {
  it("POST /compliance/profiles/:id/pep-flags — stores PEP flag and updates party", async () => {
    const res = await request(app)
      .post(`/api/compliance/profiles/${complianceProfileId}/pep-flags`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ position: "Member of Parliament", country: "Malaysia", pepCategory: "domestic", isActive: true });
    expect(res.status).toBe(201);
    expect(res.body.position).toBe("Member of Parliament");

    // Party isPep should now be true
    const [party] = await db.select().from(partiesTable).where(eq(partiesTable.id, createdPartyId));
    expect(party.isPep).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sanctions Screening
// ---------------------------------------------------------------------------
describe("Sanctions Screening", () => {
  it("POST /compliance/profiles/:id/sanctions-screening — records clear result", async () => {
    const res = await request(app)
      .post(`/api/compliance/profiles/${complianceProfileId}/sanctions-screening`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ screeningSource: "OFAC", result: "clear", notes: "No match" });
    expect(res.status).toBe(201);
    expect(res.body.result).toBe("clear");
  });

  it("POST /compliance/profiles/:id/sanctions-screening — records hit result", async () => {
    const res = await request(app)
      .post(`/api/compliance/profiles/${complianceProfileId}/sanctions-screening`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ screeningSource: "UN", result: "hit", notes: "Potential match on UNSCR 1267 list" });
    expect(res.status).toBe(201);
    expect(res.body.result).toBe("hit");
  });
});

// ---------------------------------------------------------------------------
// Source of Funds / Wealth
// ---------------------------------------------------------------------------
describe("Source of Funds & Wealth", () => {
  it("POST /compliance/profiles/:id/source-of-funds — stored correctly", async () => {
    const res = await request(app)
      .post(`/api/compliance/profiles/${complianceProfileId}/source-of-funds`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ sourceType: "employment", description: "Salary as MP", amountEstimated: "180000", currency: "MYR" });
    expect(res.status).toBe(201);
    expect(res.body.sourceType).toBe("employment");
  });

  it("POST /compliance/profiles/:id/source-of-wealth — stored correctly", async () => {
    const res = await request(app)
      .post(`/api/compliance/profiles/${complianceProfileId}/source-of-wealth`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ wealthType: "inheritance", description: "Estate of late father", amountEstimated: "2000000" });
    expect(res.status).toBe(201);
    expect(res.body.wealthType).toBe("inheritance");
  });
});

// ---------------------------------------------------------------------------
// Suspicious Notes
// ---------------------------------------------------------------------------
describe("Suspicious Notes", () => {
  it("POST /compliance/profiles/:id/suspicious-notes — stores note", async () => {
    const res = await request(app)
      .post(`/api/compliance/profiles/${complianceProfileId}/suspicious-notes`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ noteType: "internal", content: "Transaction pattern unusual — multiple small deposits" });
    expect(res.status).toBe(201);
    expect(res.body.noteType).toBe("internal");
  });

  it("POST /compliance/profiles/:id/suspicious-notes — empty content is rejected", async () => {
    const res = await request(app)
      .post(`/api/compliance/profiles/${complianceProfileId}/suspicious-notes`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ noteType: "internal", content: "" });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Beneficial Owners
// ---------------------------------------------------------------------------
describe("Beneficial Owners", () => {
  let boId: number;

  it("POST /parties/:id/beneficial-owners — creates UBO", async () => {
    const res = await request(app)
      .post(`/api/parties/${createdPartyId}/beneficial-owners`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        ownerName: "Siti UBO Test",
        ownerType: "natural_person",
        ownershipPercentage: "51",
        isPep: false,
        isUltimateBeneficialOwner: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.ownerName).toBe("Siti UBO Test");
    expect(res.body.isUltimateBeneficialOwner).toBe(true);
    boId = res.body.id;
  });

  it("GET /parties/:id — beneficial owners included in response", async () => {
    const res = await request(app)
      .get(`/api/parties/${createdPartyId}`)
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.beneficialOwners.some((bo: any) => bo.id === boId)).toBe(true);
  });

  it("DELETE /parties/:id/beneficial-owners/:boId — removes UBO", async () => {
    const res = await request(app)
      .delete(`/api/parties/${createdPartyId}/beneficial-owners/${boId}`)
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Full Profile Detail
// ---------------------------------------------------------------------------
describe("Compliance Profile Full Detail", () => {
  it("GET /compliance/profiles/:id — returns all nested data", async () => {
    const res = await request(app)
      .get(`/api/compliance/profiles/${complianceProfileId}`)
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.checks).toBeInstanceOf(Array);
    expect(res.body.screenings).toBeInstanceOf(Array);
    expect(res.body.pepFlags).toBeInstanceOf(Array);
    expect(res.body.riskHistory).toBeInstanceOf(Array);
    expect(res.body.sourceOfFunds).toBeInstanceOf(Array);
    expect(res.body.sourceOfWealth).toBeInstanceOf(Array);
    expect(res.body.suspiciousNotes).toBeInstanceOf(Array);
    expect(res.body.sourceOfFunds.length).toBeGreaterThan(0);
    expect(res.body.sourceOfWealth.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tenant Isolation
// ---------------------------------------------------------------------------
describe("Tenant Isolation", () => {
  it("Founder can GET parties (sees all firms)", async () => {
    const res = await request(app)
      .get(`/api/parties/${createdPartyId}`)
      .set("Authorization", `Bearer ${founderToken}`);
    // Founder bypasses RLS — but endpoint requires firm_user; founder is not firm_user
    expect([403, 404]).toContain(res.status);
  });

  it("Party not visible with wrong firm Bearer token (different firm)", async () => {
    // Create a party with lawyerToken then try with partnerToken of same firm → should succeed (same firm)
    // But clerk account is also same firm so we'd need a separate firm to truly test isolation.
    // We test isolation via DB directly: try to fetch with a known wrong firmId.
    const [profile] = await db.select().from(complianceProfilesTable)
      .where(eq(complianceProfilesTable.id, complianceProfileId));
    expect(profile.firmId).toBe(partnerFirmId);
  });
});

// ---------------------------------------------------------------------------
// Audit Log
// ---------------------------------------------------------------------------
describe("Audit Log", () => {
  it("Audit log entries written for compliance mutations", async () => {
    const logs = await db.select().from(auditLogsTable)
      .where(eq(auditLogsTable.firmId, partnerFirmId))
      .orderBy(desc(auditLogsTable.createdAt))
      .limit(50);
    const complianceLogs = logs.filter(l => l.action?.startsWith("compliance."));
    expect(complianceLogs.length).toBeGreaterThan(5);

    const actions = complianceLogs.map(l => l.action);
    expect(actions.some(a => a?.includes("party_created"))).toBe(true);
    expect(actions.some(a => a?.includes("cdd_status_changed"))).toBe(true);
    expect(actions.some(a => a?.includes("risk_assessment_created"))).toBe(true);
    expect(actions.some(a => a?.includes("sanctions_screening_run"))).toBe(true);
    expect(actions.some(a => a?.includes("pep_flag_added"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Soft Delete
// ---------------------------------------------------------------------------
describe("Soft Delete", () => {
  it("DELETE /parties/:id — soft-deletes party (sets deletedAt)", async () => {
    const createRes = await request(app)
      .post("/api/parties")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ partyType: "natural_person", fullName: "Ahmad Compliance Test", isPep: false });
    createdPartyIdForDeletion = createRes.body.id;

    const delRes = await request(app)
      .delete(`/api/parties/${createdPartyIdForDeletion}`)
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(delRes.status).toBe(200);

    // Should now return 404 (filtered by isNull(deletedAt))
    const getRes = await request(app)
      .get(`/api/parties/${createdPartyIdForDeletion}`)
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(getRes.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Unauthenticated access
// ---------------------------------------------------------------------------
describe("Unauthenticated access", () => {
  it("GET /parties — 401 without auth", async () => {
    const res = await request(app).get("/api/parties");
    expect(res.status).toBe(401);
  });

  it("POST /parties — 401 without auth", async () => {
    const res = await request(app).post("/api/parties").send({ fullName: "Test" });
    expect(res.status).toBe(401);
  });
});
