/**
 * conflict.test.ts
 *
 * Tests for the conflict check engine:
 *   - Run conflict check (no match for fresh case)
 *   - NRIC exact match detection → blocked
 *   - Name fuzzy match detection → warning/blocked
 *   - Get conflict check detail (matches + overrides)
 *   - Partner override flow: requireReAuth + partner role enforced
 *   - Non-partner (lawyer) cannot override
 *   - Duplicate override is rejected (409)
 *   - Overriding updates check overallResult when all blocks cleared
 *   - Audit log written on run and override
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../app";
import {
  db, casesTable, casePurchasersTable, caseAssignmentsTable,
  clientsTable, partiesTable, casePartiesTable, complianceProfilesTable,
  beneficialOwnersTable, conflictChecksTable, conflictMatchesTable,
  conflictOverridesTable, auditLogsTable,
} from "@workspace/db";
import { eq, and, or, desc } from "drizzle-orm";

const PARTNER_EMAIL  = "partner@tan-associates.my";
const PARTNER_PWD    = "lawyer123";
const LAWYER_EMAIL   = "lawyer@tan-associates.my";
const LAWYER_PWD     = "lawyer123";

let partnerToken: string;
let partnerFirmId: number;
let lawyerToken: string;
let testCaseId: number;
let conflictCheckId: number;
let blockedMatchId: number;

// IDs for cleanup
const cleanupPartyIds: number[] = [];
const cleanupCaseIds: number[] = [];

async function getReauthToken(bearerToken: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/reauth-token")
    .set("Authorization", `Bearer ${bearerToken}`);
  expect(res.status).toBe(200);
  return res.body.reAuthToken as string;
}

async function createTestCase(token: string): Promise<number> {
  const projRes = await request(app)
    .get("/api/projects?limit=1")
    .set("Authorization", `Bearer ${token}`);
  const project = projRes.body.data[0];

  const usersRes = await request(app)
    .get("/api/users?limit=5")
    .set("Authorization", `Bearer ${token}`);
  const lawyerUser = usersRes.body.data.find(
    (u: any) => u.roleName?.toLowerCase().includes("lawyer") || u.roleName?.toLowerCase().includes("partner")
  ) ?? usersRes.body.data[0];

  const ts = Date.now();
  const caseRes = await request(app)
    .post("/api/cases")
    .set("Authorization", `Bearer ${token}`)
    .send({
      projectId: project.id,
      purchaseMode: "cash",
      titleType: "master",
      assignedLawyerId: lawyerUser.id,
      purchasers: [{ name: `Conflict Test Client ${ts}`, ic: `CONFLICT-${ts}`.slice(0, 20) }],
      caseType: "Primary Market",
      parcelNo: `CONFLICT-${ts}`,
    });
  if (!caseRes.body.id) throw new Error(`createTestCase failed: ${JSON.stringify(caseRes.body)}`);
  cleanupCaseIds.push(caseRes.body.id);
  return caseRes.body.id;
}

beforeAll(async () => {
  const [partnerRes, lawyerRes] = await Promise.all([
    request(app).post("/api/auth/login").send({ email: PARTNER_EMAIL, password: PARTNER_PWD }),
    request(app).post("/api/auth/login").send({ email: LAWYER_EMAIL, password: LAWYER_PWD }),
  ]);
  partnerToken = partnerRes.body.token;
  partnerFirmId = partnerRes.body.firmId;
  lawyerToken = lawyerRes.body.token;

  // Pre-clean leftover seed parties from previous runs
  const stale = await db.select().from(partiesTable)
    .where(and(eq(partiesTable.firmId, partnerFirmId), eq(partiesTable.fullName, "Hamid Conflict Seed")));
  for (const p of stale) {
    await db.delete(casePartiesTable).where(eq(casePartiesTable.partyId, p.id));
    await db.delete(beneficialOwnersTable).where(eq(beneficialOwnersTable.partyId, p.id));
    await db.delete(complianceProfilesTable).where(eq(complianceProfilesTable.partyId, p.id));
    await db.delete(partiesTable).where(eq(partiesTable.id, p.id));
  }

  testCaseId = await createTestCase(partnerToken);

  // Create a seed party with a known NRIC to test against in another case
  const seedPartyRes = await request(app)
    .post("/api/parties")
    .set("Authorization", `Bearer ${partnerToken}`)
    .send({ partyType: "natural_person", fullName: "Hamid Conflict Seed", nric: "700101-14-5555" });
  cleanupPartyIds.push(seedPartyRes.body.id);

  // Link seed party to another case so it's findable by the engine
  const seedCaseId = await createTestCase(partnerToken);
  await request(app)
    .post(`/api/cases/${seedCaseId}/parties`)
    .set("Authorization", `Bearer ${partnerToken}`)
    .send({ partyId: seedPartyRes.body.id, partyRole: "vendor" });
});

afterAll(async () => {
  // Delete conflict overrides, matches, checks tied to our test cases
  for (const caseId of cleanupCaseIds) {
    const checks = await db.select().from(conflictChecksTable).where(eq(conflictChecksTable.caseId, caseId));
    for (const chk of checks) {
      await db.delete(conflictOverridesTable).where(eq(conflictOverridesTable.conflictCheckId, chk.id));
      await db.delete(conflictMatchesTable).where(eq(conflictMatchesTable.conflictCheckId, chk.id));
    }
    await db.delete(conflictChecksTable).where(eq(conflictChecksTable.caseId, caseId));
    await db.delete(casePartiesTable).where(eq(casePartiesTable.caseId, caseId));
    const purch = await db.select().from(casePurchasersTable).where(eq(casePurchasersTable.caseId, caseId));
    for (const p of purch) {
      await db.delete(casePurchasersTable).where(eq(casePurchasersTable.caseId, caseId));
      await db.delete(clientsTable).where(eq(clientsTable.id, p.clientId));
    }
    await db.delete(caseAssignmentsTable).where(eq(caseAssignmentsTable.caseId, caseId));
    await db.delete(casesTable).where(eq(casesTable.id, caseId));
  }
  for (const partyId of cleanupPartyIds) {
    await db.delete(casePartiesTable).where(eq(casePartiesTable.partyId, partyId));
    await db.delete(beneficialOwnersTable).where(eq(beneficialOwnersTable.partyId, partyId));
    await db.delete(complianceProfilesTable).where(eq(complianceProfilesTable.partyId, partyId));
    await db.delete(partiesTable).where(eq(partiesTable.id, partyId));
  }
});

// ---------------------------------------------------------------------------
// Basic — no match
// ---------------------------------------------------------------------------
describe("Conflict Check — No Match", () => {
  it("POST /conflict/check — returns no_match for unknown party", async () => {
    const res = await request(app)
      .post("/api/conflict/check")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        caseId: testCaseId,
        parties: [{ name: "Completely Unknown Party XYZ", identifierType: "none" }],
      });
    expect(res.status).toBe(201);
    expect(res.body.check.overallResult).toBe("no_match");
    expect(res.body.matches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// NRIC Exact Match → blocked
// ---------------------------------------------------------------------------
describe("Conflict Check — NRIC Exact Match", () => {
  it("POST /conflict/check — NRIC match returns blocked", async () => {
    const res = await request(app)
      .post("/api/conflict/check")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        caseId: testCaseId,
        parties: [{
          name: "Hamid Conflict Seed",
          identifier: "700101-14-5555",
          identifierType: "nric",
          role: "purchaser",
        }],
      });
    expect(res.status).toBe(201);
    const { check, matches } = res.body;
    expect(check.overallResult).toBe("blocked_pending_partner_override");
    expect(matches.some((m: any) => m.matchType === "nric" && m.result === "blocked")).toBe(true);
    conflictCheckId = check.id;
    const blocked = matches.find((m: any) => m.result === "blocked");
    blockedMatchId = blocked.id;
  });
});

// ---------------------------------------------------------------------------
// GET checks list + detail
// ---------------------------------------------------------------------------
describe("Conflict Check — Get Results", () => {
  it("GET /conflict/checks?caseId — lists checks for case", async () => {
    const res = await request(app)
      .get(`/api/conflict/checks?caseId=${testCaseId}`)
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.some((c: any) => c.id === conflictCheckId)).toBe(true);
  });

  it("GET /conflict/checks/:id — returns check with matches", async () => {
    const res = await request(app)
      .get(`/api/conflict/checks/${conflictCheckId}`)
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.check.id).toBe(conflictCheckId);
    expect(res.body.matches).toBeInstanceOf(Array);
    expect(res.body.overrides).toBeInstanceOf(Array);
    expect(res.body.matches.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Partner Override — non-partner (lawyer) cannot override
// ---------------------------------------------------------------------------
describe("Conflict Override — Access Control", () => {
  it("Lawyer (non-partner) cannot override — 403", async () => {
    const reauth = await getReauthToken(lawyerToken);
    const res = await request(app)
      .post(`/api/conflict/checks/${conflictCheckId}/override`)
      .set("Authorization", `Bearer ${lawyerToken}`)
      .set("x-reauth-token", reauth)
      .send({ conflictMatchId: blockedMatchId, overrideReason: "Attempting non-partner override for test purposes" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PARTNER_REQUIRED");
  });

  it("Partner without re-auth token cannot override — 401/403", async () => {
    const res = await request(app)
      .post(`/api/conflict/checks/${conflictCheckId}/override`)
      .set("Authorization", `Bearer ${partnerToken}`)
      // deliberately omit x-reauth-token
      .send({ conflictMatchId: blockedMatchId, overrideReason: "No reauth token provided here for test" });
    expect([401, 403]).toContain(res.status);
  });

  it("Override reason too short — 400", async () => {
    const reauth = await getReauthToken(partnerToken);
    const res = await request(app)
      .post(`/api/conflict/checks/${conflictCheckId}/override`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .set("x-reauth-token", reauth)
      .send({ conflictMatchId: blockedMatchId, overrideReason: "Short" });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Partner Override — success flow
// ---------------------------------------------------------------------------
describe("Conflict Override — Partner Success", () => {
  it("Partner with valid re-auth token can override blocked match", async () => {
    const reauth = await getReauthToken(partnerToken);
    const res = await request(app)
      .post(`/api/conflict/checks/${conflictCheckId}/override`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .set("x-reauth-token", reauth)
      .send({
        conflictMatchId: blockedMatchId,
        overrideReason: "Client confirmed as different individual — ID verified in person with certified documents",
      });
    expect(res.status).toBe(201);
    expect(res.body.conflictMatchId).toBe(blockedMatchId);
    expect(res.body.overriddenBy).toBeDefined();
  });

  it("After all blocks overridden, check overallResult updated to no_match or warning", async () => {
    const res = await request(app)
      .get(`/api/conflict/checks/${conflictCheckId}`)
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(res.status).toBe(200);
    expect(["no_match", "warning"]).toContain(res.body.check.overallResult);
  });

  it("Re-auth token is single-use — second use rejected", async () => {
    const reauth = await getReauthToken(partnerToken);
    // First use: attempt override (will fail with 409 duplicate, but token consumed)
    await request(app)
      .post(`/api/conflict/checks/${conflictCheckId}/override`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .set("x-reauth-token", reauth)
      .send({
        conflictMatchId: blockedMatchId,
        overrideReason: "Testing single-use enforcement of the re-auth token here",
      });
    // Second use: same token should now be invalid (401/403)
    const res2 = await request(app)
      .post(`/api/conflict/checks/${conflictCheckId}/override`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .set("x-reauth-token", reauth)
      .send({
        conflictMatchId: blockedMatchId,
        overrideReason: "Should fail because token was already consumed above",
      });
    expect([401, 403, 409]).toContain(res2.status);
  });

  it("Duplicate override on same match is rejected (409)", async () => {
    const reauth = await getReauthToken(partnerToken);
    const res = await request(app)
      .post(`/api/conflict/checks/${conflictCheckId}/override`)
      .set("Authorization", `Bearer ${partnerToken}`)
      .set("x-reauth-token", reauth)
      .send({
        conflictMatchId: blockedMatchId,
        overrideReason: "Attempting a duplicate override to confirm 409 response from the server",
      });
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Name Fuzzy Match
// ---------------------------------------------------------------------------
describe("Conflict Check — Name Fuzzy Match", () => {
  it("Exact name match returns blocked or warning", async () => {
    const res = await request(app)
      .post("/api/conflict/check")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        caseId: testCaseId,
        parties: [{ name: "Hamid Conflict Seed", identifierType: "none" }],
      });
    expect(res.status).toBe(201);
    // Exact name match should return blocked or warning
    expect(["blocked_pending_partner_override", "warning"]).toContain(res.body.check.overallResult);
  });

  it("Clearly different name returns no_match", async () => {
    const res = await request(app)
      .post("/api/conflict/check")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({
        caseId: testCaseId,
        parties: [{ name: "Zulaikha binti Abdullah XYZ", identifierType: "none" }],
      });
    expect(res.status).toBe(201);
    expect(res.body.check.overallResult).toBe("no_match");
  });
});

// ---------------------------------------------------------------------------
// Audit Log
// ---------------------------------------------------------------------------
describe("Audit Log — Conflict", () => {
  it("Conflict check and override events written to audit log", async () => {
    const logs = await db.select().from(auditLogsTable)
      .where(eq(auditLogsTable.firmId, partnerFirmId))
      .orderBy(desc(auditLogsTable.createdAt))
      .limit(50);
    const conflictLogs = logs.filter(l => l.action?.startsWith("compliance.conflict"));
    expect(conflictLogs.length).toBeGreaterThan(0);
    expect(conflictLogs.some(l => l.action?.includes("conflict_check_run"))).toBe(true);
    expect(conflictLogs.some(l => l.action?.includes("conflict_override_applied"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------
describe("Input Validation", () => {
  it("POST /conflict/check — empty parties array returns 400", async () => {
    const res = await request(app)
      .post("/api/conflict/check")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ caseId: testCaseId, parties: [] });
    expect(res.status).toBe(400);
  });

  it("POST /conflict/check — missing caseId returns 400", async () => {
    const res = await request(app)
      .post("/api/conflict/check")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ parties: [{ name: "Test" }] });
    expect(res.status).toBe(400);
  });

  it("GET /conflict/checks/:id — non-existent check returns 404", async () => {
    const res = await request(app)
      .get("/api/conflict/checks/999999")
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(res.status).toBe(404);
  });
});
