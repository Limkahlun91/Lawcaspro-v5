import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  complianceProfilesTable, cddChecksTable, cddDocumentsTable,
  sanctionsScreeningsTable, pepFlagsTable, riskAssessmentsTable,
  sourceOfFundsRecordsTable, sourceOfWealthRecordsTable,
  suspiciousReviewNotesTable, complianceRetentionRecordsTable,
  partiesTable,
} from "@workspace/db";
import { requireAuth, requireFirmUser, type AuthRequest, writeAuditLog } from "../lib/auth";
import { sensitiveRateLimiter } from "../lib/rate-limit";

const router: IRouter = Router();

function rdb(req: AuthRequest) { return req.rlsDb ?? db; }

// ---------------------------------------------------------------------------
// Risk scoring helper
// ---------------------------------------------------------------------------
const RISK_WEIGHTS = {
  isPep: 30,
  highRiskJurisdiction: 25,
  complexOwnership: 20,
  nomineeArrangement: 20,
  missingSourceOfFunds: 15,
  suspiciousInconsistencies: 25,
};

function computeRiskScore(factors: {
  factorIsPep: boolean;
  factorHighRiskJurisdiction: boolean;
  factorComplexOwnership: boolean;
  factorNomineeArrangement: boolean;
  factorMissingSourceOfFunds: boolean;
  factorSuspiciousInconsistencies: boolean;
}): { riskScore: number; riskLevel: string; eddTriggered: boolean; eddReason: string | null } {
  let score = 0;
  if (factors.factorIsPep) score += RISK_WEIGHTS.isPep;
  if (factors.factorHighRiskJurisdiction) score += RISK_WEIGHTS.highRiskJurisdiction;
  if (factors.factorComplexOwnership) score += RISK_WEIGHTS.complexOwnership;
  if (factors.factorNomineeArrangement) score += RISK_WEIGHTS.nomineeArrangement;
  if (factors.factorMissingSourceOfFunds) score += RISK_WEIGHTS.missingSourceOfFunds;
  if (factors.factorSuspiciousInconsistencies) score += RISK_WEIGHTS.suspiciousInconsistencies;

  let riskLevel = "low";
  if (score >= 70) riskLevel = "very_high";
  else if (score >= 45) riskLevel = "high";
  else if (score >= 25) riskLevel = "medium";

  const eddTriggered = factors.factorIsPep || factors.factorHighRiskJurisdiction || score >= 45;
  const reasons: string[] = [];
  if (factors.factorIsPep) reasons.push("PEP identified");
  if (factors.factorHighRiskJurisdiction) reasons.push("High-risk jurisdiction");
  if (score >= 45 && !factors.factorIsPep && !factors.factorHighRiskJurisdiction) {
    reasons.push("High aggregate risk score");
  }

  return { riskScore: score, riskLevel, eddTriggered, eddReason: reasons.length ? reasons.join("; ") : null };
}

// ---------------------------------------------------------------------------
// GET /compliance/profiles — list profiles for the firm
// ---------------------------------------------------------------------------
router.get("/compliance/profiles", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const { status } = req.query as Record<string, string>;
  const profiles = await rdb(req).select({
    id: complianceProfilesTable.id,
    partyId: complianceProfilesTable.partyId,
    cddStatus: complianceProfilesTable.cddStatus,
    riskLevel: complianceProfilesTable.riskLevel,
    riskScore: complianceProfilesTable.riskScore,
    eddTriggered: complianceProfilesTable.eddTriggered,
    updatedAt: complianceProfilesTable.updatedAt,
    partyName: partiesTable.fullName,
    partyType: partiesTable.partyType,
  })
    .from(complianceProfilesTable)
    .leftJoin(partiesTable, eq(partiesTable.id, complianceProfilesTable.partyId))
    .where(and(
      eq(complianceProfilesTable.firmId, req.firmId!),
      status ? eq(complianceProfilesTable.cddStatus, status) : undefined,
    ))
    .orderBy(desc(complianceProfilesTable.updatedAt))
    .limit(200);
  res.json({ data: profiles });
});

// ---------------------------------------------------------------------------
// GET /compliance/profiles/:id — full profile detail
// ---------------------------------------------------------------------------
router.get("/compliance/profiles/:id", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const id = Number(req.params.id);
  const [profile] = await rdb(req).select().from(complianceProfilesTable)
    .where(and(eq(complianceProfilesTable.id, id), eq(complianceProfilesTable.firmId, req.firmId!)));
  if (!profile) { res.status(404).json({ error: "Compliance profile not found" }); return; }

  const [party] = await rdb(req).select().from(partiesTable).where(eq(partiesTable.id, profile.partyId));
  const checks = await rdb(req).select().from(cddChecksTable)
    .where(and(eq(cddChecksTable.complianceProfileId, id), eq(cddChecksTable.firmId, req.firmId!)));
  const documents = await rdb(req).select().from(cddDocumentsTable)
    .where(and(eq(cddDocumentsTable.complianceProfileId, id), eq(cddDocumentsTable.firmId, req.firmId!)));
  const screenings = await rdb(req).select().from(sanctionsScreeningsTable)
    .where(and(eq(sanctionsScreeningsTable.complianceProfileId, id), eq(sanctionsScreeningsTable.firmId, req.firmId!)));
  const peps = await rdb(req).select().from(pepFlagsTable)
    .where(and(eq(pepFlagsTable.partyId, profile.partyId), eq(pepFlagsTable.firmId, req.firmId!)));
  const riskHistory = await rdb(req).select().from(riskAssessmentsTable)
    .where(and(eq(riskAssessmentsTable.complianceProfileId, id), eq(riskAssessmentsTable.firmId, req.firmId!)))
    .orderBy(desc(riskAssessmentsTable.createdAt));
  const sof = await rdb(req).select().from(sourceOfFundsRecordsTable)
    .where(and(eq(sourceOfFundsRecordsTable.complianceProfileId, id), eq(sourceOfFundsRecordsTable.firmId, req.firmId!)));
  const sow = await rdb(req).select().from(sourceOfWealthRecordsTable)
    .where(and(eq(sourceOfWealthRecordsTable.complianceProfileId, id), eq(sourceOfWealthRecordsTable.firmId, req.firmId!)));
  const notes = await rdb(req).select().from(suspiciousReviewNotesTable)
    .where(and(eq(suspiciousReviewNotesTable.complianceProfileId, id), eq(suspiciousReviewNotesTable.firmId, req.firmId!)));

  res.json({
    ...profile, party, checks, documents, screenings, pepFlags: peps,
    riskHistory, sourceOfFunds: sof, sourceOfWealth: sow, suspiciousNotes: notes,
  });
});

// ---------------------------------------------------------------------------
// PATCH /compliance/profiles/:id/status — update CDD status
// ---------------------------------------------------------------------------
router.patch("/compliance/profiles/:id/status", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const id = Number(req.params.id);
  const parsed = z.object({
    cddStatus: z.enum(["not_started","in_progress","pending_review","approved","rejected","enhanced_due_diligence_required"]),
    rejectionReason: z.string().optional(),
    notes: z.string().optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  const [profile] = await rdb(req).select().from(complianceProfilesTable)
    .where(and(eq(complianceProfilesTable.id, id), eq(complianceProfilesTable.firmId, req.firmId!)));
  if (!profile) { res.status(404).json({ error: "Compliance profile not found" }); return; }

  const now = new Date();
  const update: Partial<typeof complianceProfilesTable.$inferInsert> = { cddStatus: parsed.data.cddStatus };
  if (parsed.data.cddStatus === "approved") { update.approvedBy = req.userId; update.approvedAt = now; }
  if (parsed.data.cddStatus === "rejected") {
    update.rejectedBy = req.userId; update.rejectedAt = now;
    update.rejectionReason = parsed.data.rejectionReason ?? null;
  }
  if (parsed.data.notes) update.notes = parsed.data.notes;

  const [updated] = await rdb(req).update(complianceProfilesTable).set(update).where(eq(complianceProfilesTable.id, id)).returning();

  await writeAuditLog({
    actorId: req.userId, firmId: req.firmId, actorType: "firm_user",
    action: `compliance.cdd_status_changed.${parsed.data.cddStatus}`,
    entityType: "compliance_profile", entityId: id,
    detail: parsed.data.rejectionReason ?? parsed.data.cddStatus,
    ipAddress: req.ip, userAgent: req.headers["user-agent"],
  });

  res.json(updated);
});

// ---------------------------------------------------------------------------
// POST /compliance/profiles/:id/cdd-checks — add a CDD check
// ---------------------------------------------------------------------------
router.post("/compliance/profiles/:id/cdd-checks", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const profileId = Number(req.params.id);
  const parsed = z.object({
    checkType: z.enum(["identity","address","source_of_funds","beneficial_ownership","sanctions","pep","other"]),
    status: z.enum(["pending","passed","failed","requires_follow_up"]).default("pending"),
    result: z.string().optional(),
    notes: z.string().optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  const [profile] = await rdb(req).select().from(complianceProfilesTable)
    .where(and(eq(complianceProfilesTable.id, profileId), eq(complianceProfilesTable.firmId, req.firmId!)));
  if (!profile) { res.status(404).json({ error: "Compliance profile not found" }); return; }

  const checkInsert = {
    firmId: req.firmId!,
    complianceProfileId: profileId,
    checkType: parsed.data.checkType,
    status: parsed.data.status,
    result: parsed.data.result,
    notes: parsed.data.notes,
    performedBy: req.userId,
    performedAt: new Date(),
  } satisfies typeof cddChecksTable.$inferInsert;

  const [check] = await rdb(req).insert(cddChecksTable).values(checkInsert).returning();

  await writeAuditLog({
    actorId: req.userId, firmId: req.firmId, actorType: "firm_user",
    action: `compliance.cdd_check_added.${parsed.data.checkType}`,
    entityType: "compliance_profile", entityId: profileId,
    detail: `${parsed.data.checkType}: ${parsed.data.status}`,
    ipAddress: req.ip, userAgent: req.headers["user-agent"],
  });

  res.status(201).json(check);
});

// ---------------------------------------------------------------------------
// POST /compliance/profiles/:id/risk-assessment — run risk scoring
// ---------------------------------------------------------------------------
router.post("/compliance/profiles/:id/risk-assessment", sensitiveRateLimiter, requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const profileId = Number(req.params.id);
  const parsed = z.object({
    factorIsPep: z.boolean().default(false),
    factorHighRiskJurisdiction: z.boolean().default(false),
    factorComplexOwnership: z.boolean().default(false),
    factorNomineeArrangement: z.boolean().default(false),
    factorMissingSourceOfFunds: z.boolean().default(false),
    factorSuspiciousInconsistencies: z.boolean().default(false),
    notes: z.string().optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  const [profile] = await rdb(req).select().from(complianceProfilesTable)
    .where(and(eq(complianceProfilesTable.id, profileId), eq(complianceProfilesTable.firmId, req.firmId!)));
  if (!profile) { res.status(404).json({ error: "Compliance profile not found" }); return; }

  const scoring = computeRiskScore({
    factorIsPep: parsed.data.factorIsPep ?? false,
    factorHighRiskJurisdiction: parsed.data.factorHighRiskJurisdiction ?? false,
    factorComplexOwnership: parsed.data.factorComplexOwnership ?? false,
    factorNomineeArrangement: parsed.data.factorNomineeArrangement ?? false,
    factorMissingSourceOfFunds: parsed.data.factorMissingSourceOfFunds ?? false,
    factorSuspiciousInconsistencies: parsed.data.factorSuspiciousInconsistencies ?? false,
  });

  const assessmentInsert = {
    firmId: req.firmId!,
    partyId: profile.partyId,
    complianceProfileId: profileId,
    factorIsPep: parsed.data.factorIsPep,
    factorHighRiskJurisdiction: parsed.data.factorHighRiskJurisdiction,
    factorComplexOwnership: parsed.data.factorComplexOwnership,
    factorNomineeArrangement: parsed.data.factorNomineeArrangement,
    factorMissingSourceOfFunds: parsed.data.factorMissingSourceOfFunds,
    factorSuspiciousInconsistencies: parsed.data.factorSuspiciousInconsistencies,
    riskScore: scoring.riskScore,
    riskLevel: scoring.riskLevel,
    eddTriggered: scoring.eddTriggered,
    eddReason: scoring.eddReason,
    assessedBy: req.userId,
    assessedAt: new Date(),
    notes: parsed.data.notes,
  } satisfies typeof riskAssessmentsTable.$inferInsert;

  const [assessment] = await rdb(req).insert(riskAssessmentsTable).values(assessmentInsert).returning();

  // Sync back to compliance profile
  const newStatus = scoring.eddTriggered ? "enhanced_due_diligence_required" : profile.cddStatus;
  await rdb(req).update(complianceProfilesTable).set({
    riskScore: scoring.riskScore,
    riskLevel: scoring.riskLevel,
    eddTriggered: scoring.eddTriggered,
    eddReason: scoring.eddReason,
    cddStatus: newStatus,
  }).where(eq(complianceProfilesTable.id, profileId));

  await writeAuditLog({
    actorId: req.userId, firmId: req.firmId, actorType: "firm_user",
    action: "compliance.risk_assessment_created",
    entityType: "compliance_profile", entityId: profileId,
    detail: `score=${scoring.riskScore} level=${scoring.riskLevel} edd=${scoring.eddTriggered}`,
    ipAddress: req.ip, userAgent: req.headers["user-agent"],
  });

  res.status(201).json({ assessment, profile: { riskScore: scoring.riskScore, riskLevel: scoring.riskLevel, eddTriggered: scoring.eddTriggered, cddStatus: newStatus } });
});

// ---------------------------------------------------------------------------
// POST /compliance/profiles/:id/sanctions-screening
// ---------------------------------------------------------------------------
router.post("/compliance/profiles/:id/sanctions-screening", sensitiveRateLimiter, requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const profileId = Number(req.params.id);
  const parsed = z.object({
    screeningSource: z.enum(["OFAC","UN","INTERPOL","Malaysia_BNM","manual"]).default("manual"),
    result: z.enum(["clear","hit","potential_hit","unknown"]).default("unknown"),
    matchDetails: z.record(z.string(), z.unknown()).optional(),
    notes: z.string().optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  const [profile] = await rdb(req).select().from(complianceProfilesTable)
    .where(and(eq(complianceProfilesTable.id, profileId), eq(complianceProfilesTable.firmId, req.firmId!)));
  if (!profile) { res.status(404).json({ error: "Compliance profile not found" }); return; }

  const [screening] = await rdb(req).insert(sanctionsScreeningsTable).values({
    firmId: req.firmId!,
    partyId: profile.partyId,
    complianceProfileId: profileId,
    screenedBy: req.userId,
    screeningSource: parsed.data.screeningSource,
    result: parsed.data.result,
    matchDetails: parsed.data.matchDetails ?? {},
    notes: parsed.data.notes,
  }).returning();

  await writeAuditLog({
    actorId: req.userId, firmId: req.firmId, actorType: "firm_user",
    action: `compliance.sanctions_screening_run.${parsed.data.result}`,
    entityType: "compliance_profile", entityId: profileId,
    detail: `source=${parsed.data.screeningSource} result=${parsed.data.result}`,
    ipAddress: req.ip, userAgent: req.headers["user-agent"],
  });

  res.status(201).json(screening);
});

// ---------------------------------------------------------------------------
// POST /compliance/profiles/:id/pep-flags
// ---------------------------------------------------------------------------
router.post("/compliance/profiles/:id/pep-flags", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const profileId = Number(req.params.id);
  const parsed = z.object({
    position: z.string().min(1),
    country: z.string().optional(),
    pepCategory: z.enum(["domestic","foreign","international_organization"]).default("domestic"),
    isActive: z.boolean().default(true),
    source: z.string().optional(),
    notes: z.string().optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  const [profile] = await rdb(req).select().from(complianceProfilesTable)
    .where(and(eq(complianceProfilesTable.id, profileId), eq(complianceProfilesTable.firmId, req.firmId!)));
  if (!profile) { res.status(404).json({ error: "Compliance profile not found" }); return; }

  const pepFlagInsert = {
    firmId: req.firmId!,
    partyId: profile.partyId,
    flaggedBy: req.userId,
    position: parsed.data.position,
    country: parsed.data.country,
    pepCategory: parsed.data.pepCategory,
    isActive: parsed.data.isActive,
    source: parsed.data.source,
    notes: parsed.data.notes,
  } satisfies typeof pepFlagsTable.$inferInsert;

  const [flag] = await rdb(req).insert(pepFlagsTable).values(pepFlagInsert).returning();

  // Update party isPep flag
  await rdb(req).update(partiesTable).set({ isPep: true, pepDetails: parsed.data.position }).where(eq(partiesTable.id, profile.partyId));

  await writeAuditLog({
    actorId: req.userId, firmId: req.firmId, actorType: "firm_user",
    action: "compliance.pep_flag_added",
    entityType: "compliance_profile", entityId: profileId,
    detail: `${parsed.data.position} (${parsed.data.pepCategory})`,
    ipAddress: req.ip, userAgent: req.headers["user-agent"],
  });

  res.status(201).json(flag);
});

// ---------------------------------------------------------------------------
// DELETE /compliance/profiles/:id/pep-flags/:flagId
// ---------------------------------------------------------------------------
router.delete("/compliance/profiles/:id/pep-flags/:flagId", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const flagId = Number(req.params.flagId);
  const profileId = Number(req.params.id);
  await rdb(req).update(pepFlagsTable).set({ isActive: false }).where(
    and(eq(pepFlagsTable.id, flagId), eq(pepFlagsTable.firmId, req.firmId!))
  );
  await writeAuditLog({
    actorId: req.userId, firmId: req.firmId, actorType: "firm_user",
    action: "compliance.pep_flag_removed",
    entityType: "compliance_profile", entityId: profileId,
    ipAddress: req.ip, userAgent: req.headers["user-agent"],
  });
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// POST /compliance/profiles/:id/source-of-funds
// ---------------------------------------------------------------------------
router.post("/compliance/profiles/:id/source-of-funds", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const profileId = Number(req.params.id);
  const parsed = z.object({
    sourceType: z.enum(["employment","business_income","investment","inheritance","gift","loan","sale_of_asset","other"]),
    description: z.string().optional(),
    amountEstimated: z.string().optional(),
    currency: z.string().default("MYR"),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  const [profile] = await rdb(req).select().from(complianceProfilesTable)
    .where(and(eq(complianceProfilesTable.id, profileId), eq(complianceProfilesTable.firmId, req.firmId!)));
  if (!profile) { res.status(404).json({ error: "Compliance profile not found" }); return; }

  const sourceOfFundsInsert = {
    firmId: req.firmId!,
    partyId: profile.partyId,
    complianceProfileId: profileId,
    sourceType: parsed.data.sourceType,
    description: parsed.data.description,
    amountEstimated: parsed.data.amountEstimated,
    currency: parsed.data.currency,
  } satisfies typeof sourceOfFundsRecordsTable.$inferInsert;

  const [record] = await rdb(req).insert(sourceOfFundsRecordsTable).values(sourceOfFundsInsert).returning();

  await writeAuditLog({
    actorId: req.userId, firmId: req.firmId, actorType: "firm_user",
    action: "compliance.source_of_funds_added",
    entityType: "compliance_profile", entityId: profileId,
    detail: parsed.data.sourceType,
    ipAddress: req.ip, userAgent: req.headers["user-agent"],
  });

  res.status(201).json(record);
});

// ---------------------------------------------------------------------------
// POST /compliance/profiles/:id/source-of-wealth
// ---------------------------------------------------------------------------
router.post("/compliance/profiles/:id/source-of-wealth", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const profileId = Number(req.params.id);
  const parsed = z.object({
    wealthType: z.enum(["employment","business","investment","inheritance","other"]),
    description: z.string().optional(),
    amountEstimated: z.string().optional(),
    currency: z.string().default("MYR"),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  const [profile] = await rdb(req).select().from(complianceProfilesTable)
    .where(and(eq(complianceProfilesTable.id, profileId), eq(complianceProfilesTable.firmId, req.firmId!)));
  if (!profile) { res.status(404).json({ error: "Compliance profile not found" }); return; }

  const sourceOfWealthInsert = {
    firmId: req.firmId!,
    partyId: profile.partyId,
    complianceProfileId: profileId,
    wealthType: parsed.data.wealthType,
    description: parsed.data.description,
    amountEstimated: parsed.data.amountEstimated,
    currency: parsed.data.currency,
  } satisfies typeof sourceOfWealthRecordsTable.$inferInsert;

  const [record] = await rdb(req).insert(sourceOfWealthRecordsTable).values(sourceOfWealthInsert).returning();

  await writeAuditLog({
    actorId: req.userId, firmId: req.firmId, actorType: "firm_user",
    action: "compliance.source_of_wealth_added",
    entityType: "compliance_profile", entityId: profileId,
    detail: parsed.data.wealthType,
    ipAddress: req.ip, userAgent: req.headers["user-agent"],
  });

  res.status(201).json(record);
});

// ---------------------------------------------------------------------------
// POST /compliance/profiles/:id/suspicious-notes
// ---------------------------------------------------------------------------
router.post("/compliance/profiles/:id/suspicious-notes", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const profileId = Number(req.params.id);
  const parsed = z.object({
    noteType: z.enum(["internal","str_consideration","escalated"]).default("internal"),
    content: z.string().min(1),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  const [profile] = await rdb(req).select().from(complianceProfilesTable)
    .where(and(eq(complianceProfilesTable.id, profileId), eq(complianceProfilesTable.firmId, req.firmId!)));
  if (!profile) { res.status(404).json({ error: "Compliance profile not found" }); return; }

  const suspiciousNoteInsert = {
    firmId: req.firmId!,
    partyId: profile.partyId,
    complianceProfileId: profileId,
    createdBy: req.userId!,
    noteType: parsed.data.noteType,
    content: parsed.data.content,
  } satisfies typeof suspiciousReviewNotesTable.$inferInsert;

  const [note] = await rdb(req).insert(suspiciousReviewNotesTable).values(suspiciousNoteInsert).returning();

  await writeAuditLog({
    actorId: req.userId, firmId: req.firmId, actorType: "firm_user",
    action: `compliance.suspicious_note_added.${parsed.data.noteType}`,
    entityType: "compliance_profile", entityId: profileId,
    ipAddress: req.ip, userAgent: req.headers["user-agent"],
  });

  res.status(201).json(note);
});

// ---------------------------------------------------------------------------
// POST /compliance/profiles/:id/retention — set retention record
// ---------------------------------------------------------------------------
router.post("/compliance/profiles/:id/retention", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const profileId = Number(req.params.id);
  const parsed = z.object({
    retentionPeriodYears: z.number().int().min(1).max(99).default(7),
    retentionStartDate: z.string().optional(),
    retentionEndDate: z.string().optional(),
    reason: z.string().optional(),
    caseId: z.number().optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  const [profile] = await rdb(req).select().from(complianceProfilesTable)
    .where(and(eq(complianceProfilesTable.id, profileId), eq(complianceProfilesTable.firmId, req.firmId!)));
  if (!profile) { res.status(404).json({ error: "Compliance profile not found" }); return; }

  const [record] = await rdb(req).insert(complianceRetentionRecordsTable).values({
    firmId: req.firmId!,
    partyId: profile.partyId,
    caseId: parsed.data.caseId ?? null,
    retentionPeriodYears: parsed.data.retentionPeriodYears,
    retentionStartDate: parsed.data.retentionStartDate ?? null,
    retentionEndDate: parsed.data.retentionEndDate ?? null,
    reason: parsed.data.reason ?? null,
    createdBy: req.userId,
  }).returning();

  await writeAuditLog({
    actorId: req.userId, firmId: req.firmId, actorType: "firm_user",
    action: "compliance.retention_record_set",
    entityType: "compliance_profile", entityId: profileId,
    detail: `${parsed.data.retentionPeriodYears} years`,
    ipAddress: req.ip, userAgent: req.headers["user-agent"],
  });

  res.status(201).json(record);
});

export default router;
