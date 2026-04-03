import { Router, type IRouter } from "express";
import { eq, and, or, ilike, isNull, desc } from "drizzle-orm";
import { z } from "zod";
import {
  db, partiesTable, complianceProfilesTable, casePartiesTable,
  beneficialOwnersTable,
} from "@workspace/db";
import { requireAuth, requireFirmUser, type AuthRequest, writeAuditLog } from "../lib/auth";
import { sensitiveRateLimiter } from "../lib/rate-limit";

const router: IRouter = Router();

const CreatePartyBody = z.object({
  partyType: z.enum(["natural_person", "company", "trust"]).default("natural_person"),
  fullName: z.string().min(1),
  nric: z.string().optional(),
  passportNo: z.string().optional(),
  companyRegNo: z.string().optional(),
  dob: z.string().optional(),
  incorporationDate: z.string().optional(),
  nationality: z.string().optional(),
  jurisdiction: z.string().optional(),
  address: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  occupation: z.string().optional(),
  natureOfBusiness: z.string().optional(),
  transactionPurpose: z.string().optional(),
  isPep: z.boolean().default(false),
  pepDetails: z.string().optional(),
  isHighRiskJurisdiction: z.boolean().default(false),
  hasNomineeArrangement: z.boolean().default(false),
  hasLayeredOwnership: z.boolean().default(false),
  directors: z.array(z.object({
    name: z.string(),
    nric: z.string().optional(),
    role: z.string().optional(),
  })).optional(),
});

const UpdatePartyBody = CreatePartyBody.partial();

const CreateBeneficialOwnerBody = z.object({
  ownerName: z.string().min(1),
  ownerType: z.enum(["natural_person", "company"]).default("natural_person"),
  ownershipPercentage: z.string().optional(),
  nric: z.string().optional(),
  passportNo: z.string().optional(),
  nationality: z.string().optional(),
  address: z.string().optional(),
  isPep: z.boolean().default(false),
  isUltimateBeneficialOwner: z.boolean().default(false),
  throughEntityName: z.string().optional(),
});

// ---------------------------------------------------------------------------
// GET /parties — list firm parties with optional search
// ---------------------------------------------------------------------------
router.get("/parties", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const { q, type } = req.query as Record<string, string>;
  let query = db.select().from(partiesTable)
    .where(and(
      eq(partiesTable.firmId, req.firmId!),
      isNull(partiesTable.deletedAt),
      type ? eq(partiesTable.partyType, type) : undefined,
      q ? or(
        ilike(partiesTable.fullName, `%${q}%`),
        ilike(partiesTable.nric, `%${q}%`),
        ilike(partiesTable.passportNo, `%${q}%`),
        ilike(partiesTable.companyRegNo, `%${q}%`),
      ) : undefined,
    ))
    .orderBy(desc(partiesTable.createdAt))
    .limit(100);

  const parties = await query;
  res.json({ data: parties });
});

// ---------------------------------------------------------------------------
// POST /parties — create a party
// ---------------------------------------------------------------------------
router.post("/parties", sensitiveRateLimiter, requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const parsed = CreatePartyBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  const data = parsed.data;
  const [party] = await db.insert(partiesTable).values({
    firmId: req.firmId!,
    ...data,
    directors: data.directors ?? [],
    createdBy: req.userId,
  }).returning();

  // Auto-create compliance profile
  await db.insert(complianceProfilesTable).values({
    firmId: req.firmId!,
    partyId: party.id,
    cddStatus: "not_started",
    riskLevel: data.isPep || data.isHighRiskJurisdiction ? "high" : "low",
    riskScore: (data.isPep ? 30 : 0) + (data.isHighRiskJurisdiction ? 25 : 0) +
               (data.hasNomineeArrangement ? 20 : 0) + (data.hasLayeredOwnership ? 15 : 0),
    eddTriggered: data.isPep || data.isHighRiskJurisdiction,
    eddReason: data.isPep ? "PEP identified" : data.isHighRiskJurisdiction ? "High-risk jurisdiction" : null,
  });

  await writeAuditLog({
    actorId: req.userId, firmId: req.firmId, actorType: "firm_user",
    action: "compliance.party_created", entityType: "party", entityId: party.id,
    detail: `${data.fullName} (${data.partyType})`, ipAddress: req.ip, userAgent: req.headers["user-agent"],
  });

  res.status(201).json(party);
});

// ---------------------------------------------------------------------------
// GET /parties/:id — get party detail with compliance profile
// ---------------------------------------------------------------------------
router.get("/parties/:id", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const id = Number(req.params.id);
  const [party] = await db.select().from(partiesTable)
    .where(and(eq(partiesTable.id, id), eq(partiesTable.firmId, req.firmId!), isNull(partiesTable.deletedAt)));
  if (!party) { res.status(404).json({ error: "Party not found" }); return; }

  const [profile] = await db.select().from(complianceProfilesTable)
    .where(and(eq(complianceProfilesTable.partyId, id), eq(complianceProfilesTable.firmId, req.firmId!)));

  const bos = await db.select().from(beneficialOwnersTable)
    .where(and(eq(beneficialOwnersTable.partyId, id), eq(beneficialOwnersTable.firmId, req.firmId!)));

  const caseLinks = await db.select().from(casePartiesTable)
    .where(and(eq(casePartiesTable.partyId, id), eq(casePartiesTable.firmId, req.firmId!)));

  res.json({ ...party, complianceProfile: profile ?? null, beneficialOwners: bos, caseLinks });
});

// ---------------------------------------------------------------------------
// PATCH /parties/:id — update party
// ---------------------------------------------------------------------------
router.patch("/parties/:id", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const id = Number(req.params.id);
  const [party] = await db.select().from(partiesTable)
    .where(and(eq(partiesTable.id, id), eq(partiesTable.firmId, req.firmId!), isNull(partiesTable.deletedAt)));
  if (!party) { res.status(404).json({ error: "Party not found" }); return; }

  const parsed = UpdatePartyBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  const [updated] = await db.update(partiesTable).set(parsed.data).where(eq(partiesTable.id, id)).returning();

  await writeAuditLog({
    actorId: req.userId, firmId: req.firmId, actorType: "firm_user",
    action: "compliance.party_updated", entityType: "party", entityId: id,
    detail: JSON.stringify(Object.keys(parsed.data)), ipAddress: req.ip, userAgent: req.headers["user-agent"],
  });

  res.json(updated);
});

// ---------------------------------------------------------------------------
// DELETE /parties/:id — soft-delete party
// ---------------------------------------------------------------------------
router.delete("/parties/:id", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const id = Number(req.params.id);
  const [party] = await db.select().from(partiesTable)
    .where(and(eq(partiesTable.id, id), eq(partiesTable.firmId, req.firmId!), isNull(partiesTable.deletedAt)));
  if (!party) { res.status(404).json({ error: "Party not found" }); return; }

  await db.update(partiesTable).set({ deletedAt: new Date() }).where(eq(partiesTable.id, id));
  await writeAuditLog({
    actorId: req.userId, firmId: req.firmId, actorType: "firm_user",
    action: "compliance.party_deleted", entityType: "party", entityId: id,
    ipAddress: req.ip, userAgent: req.headers["user-agent"],
  });
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// POST /parties/:id/beneficial-owners — add a beneficial owner
// ---------------------------------------------------------------------------
router.post("/parties/:id/beneficial-owners", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const partyId = Number(req.params.id);
  const [party] = await db.select().from(partiesTable)
    .where(and(eq(partiesTable.id, partyId), eq(partiesTable.firmId, req.firmId!), isNull(partiesTable.deletedAt)));
  if (!party) { res.status(404).json({ error: "Party not found" }); return; }

  const parsed = CreateBeneficialOwnerBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  const [bo] = await db.insert(beneficialOwnersTable).values({
    firmId: req.firmId!,
    partyId,
    ...parsed.data,
  }).returning();

  await writeAuditLog({
    actorId: req.userId, firmId: req.firmId, actorType: "firm_user",
    action: "compliance.beneficial_owner_added", entityType: "party", entityId: partyId,
    detail: parsed.data.ownerName, ipAddress: req.ip, userAgent: req.headers["user-agent"],
  });

  res.status(201).json(bo);
});

// ---------------------------------------------------------------------------
// DELETE /parties/:id/beneficial-owners/:boId
// ---------------------------------------------------------------------------
router.delete("/parties/:id/beneficial-owners/:boId", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const boId = Number(req.params.boId);
  await db.delete(beneficialOwnersTable).where(
    and(eq(beneficialOwnersTable.id, boId), eq(beneficialOwnersTable.firmId, req.firmId!))
  );
  await writeAuditLog({
    actorId: req.userId, firmId: req.firmId, actorType: "firm_user",
    action: "compliance.beneficial_owner_removed", entityType: "beneficial_owner", entityId: boId,
    ipAddress: req.ip, userAgent: req.headers["user-agent"],
  });
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// GET /cases/:caseId/parties — list parties linked to a case
// ---------------------------------------------------------------------------
router.get("/cases/:caseId/parties", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const caseId = Number(req.params.caseId);
  const links = await db.select({
    id: casePartiesTable.id,
    partyId: casePartiesTable.partyId,
    partyRole: casePartiesTable.partyRole,
    createdAt: casePartiesTable.createdAt,
  }).from(casePartiesTable)
    .where(and(eq(casePartiesTable.caseId, caseId), eq(casePartiesTable.firmId, req.firmId!)));
  res.json(links);
});

// ---------------------------------------------------------------------------
// POST /cases/:caseId/parties — link a party to a case
// ---------------------------------------------------------------------------
router.post("/cases/:caseId/parties", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const caseId = Number(req.params.caseId);
  const parsed = z.object({
    partyId: z.number().int(),
    partyRole: z.string().default("client"),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  // Check for duplicate
  const [existing] = await db.select().from(casePartiesTable)
    .where(and(
      eq(casePartiesTable.caseId, caseId),
      eq(casePartiesTable.partyId, parsed.data.partyId),
      eq(casePartiesTable.firmId, req.firmId!),
    ));
  if (existing) { res.status(409).json({ error: "Party already linked to this case" }); return; }

  const [link] = await db.insert(casePartiesTable).values({
    firmId: req.firmId!,
    caseId,
    partyId: parsed.data.partyId,
    partyRole: parsed.data.partyRole,
  }).returning();

  await writeAuditLog({
    actorId: req.userId, firmId: req.firmId, actorType: "firm_user",
    action: "compliance.case_party_linked",
    entityType: "case", entityId: caseId,
    detail: `partyId=${parsed.data.partyId} role=${parsed.data.partyRole}`,
    ipAddress: req.ip, userAgent: req.headers["user-agent"],
  });

  res.status(201).json(link);
});

// ---------------------------------------------------------------------------
// DELETE /cases/:caseId/parties/:partyId — unlink a party from a case
// ---------------------------------------------------------------------------
router.delete("/cases/:caseId/parties/:partyId", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const caseId = Number(req.params.caseId);
  const partyId = Number(req.params.partyId);
  await db.delete(casePartiesTable)
    .where(and(
      eq(casePartiesTable.caseId, caseId),
      eq(casePartiesTable.partyId, partyId),
      eq(casePartiesTable.firmId, req.firmId!),
    ));
  await writeAuditLog({
    actorId: req.userId, firmId: req.firmId, actorType: "firm_user",
    action: "compliance.case_party_unlinked",
    entityType: "case", entityId: caseId,
    detail: `partyId=${partyId}`,
    ipAddress: req.ip, userAgent: req.headers["user-agent"],
  });
  res.json({ success: true });
});

export default router;
