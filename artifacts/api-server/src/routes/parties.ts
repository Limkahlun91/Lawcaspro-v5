import express, { type Response, type Router as ExpressRouter } from "express";
import { eq, and, or, ilike, isNull, desc } from "drizzle-orm";
import { z } from "zod";
import {
  db, partiesTable, complianceProfilesTable, casePartiesTable,
  beneficialOwnersTable,
} from "@workspace/db";
import { requireAuth, requireFirmUser, type AuthRequest, writeAuditLog } from "../lib/auth.js";
import { sensitiveRateLimiter } from "../lib/rate-limit.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
  patch: (path: string, ...handlers: unknown[]) => unknown;
  delete: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

function rdb(req: AuthRequest) { return req.rlsDb ?? db; }

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
router.get("/parties", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
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
router.post("/parties", sensitiveRateLimiter, requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  const parsed = CreatePartyBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  const data = parsed.data;
  const partyInsert = {
    firmId: req.firmId!,
    partyType: data.partyType,
    fullName: data.fullName,
    nric: data.nric,
    passportNo: data.passportNo,
    companyRegNo: data.companyRegNo,
    dob: data.dob,
    incorporationDate: data.incorporationDate,
    nationality: data.nationality,
    jurisdiction: data.jurisdiction,
    address: data.address,
    email: data.email,
    phone: data.phone,
    occupation: data.occupation,
    natureOfBusiness: data.natureOfBusiness,
    transactionPurpose: data.transactionPurpose,
    isPep: data.isPep,
    pepDetails: data.pepDetails,
    isHighRiskJurisdiction: data.isHighRiskJurisdiction,
    hasNomineeArrangement: data.hasNomineeArrangement,
    hasLayeredOwnership: data.hasLayeredOwnership,
    directors: data.directors ?? [],
    createdBy: req.userId,
  } satisfies typeof partiesTable.$inferInsert;

  const [party] = await rdb(req).insert(partiesTable).values(partyInsert).returning();

  // Auto-create compliance profile
  await rdb(req).insert(complianceProfilesTable).values({
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
router.get("/parties/:id", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  const [party] = await rdb(req).select().from(partiesTable)
    .where(and(eq(partiesTable.id, id), eq(partiesTable.firmId, req.firmId!), isNull(partiesTable.deletedAt)));
  if (!party) { res.status(404).json({ error: "Party not found" }); return; }

  const [profile] = await rdb(req).select().from(complianceProfilesTable)
    .where(and(eq(complianceProfilesTable.partyId, id), eq(complianceProfilesTable.firmId, req.firmId!)));

  const bos = await rdb(req).select().from(beneficialOwnersTable)
    .where(and(eq(beneficialOwnersTable.partyId, id), eq(beneficialOwnersTable.firmId, req.firmId!)));

  const caseLinks = await rdb(req).select().from(casePartiesTable)
    .where(and(eq(casePartiesTable.partyId, id), eq(casePartiesTable.firmId, req.firmId!)));

  res.json({ ...party, complianceProfile: profile ?? null, beneficialOwners: bos, caseLinks });
});

// ---------------------------------------------------------------------------
// PATCH /parties/:id — update party
// ---------------------------------------------------------------------------
router.patch("/parties/:id", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  const [party] = await rdb(req).select().from(partiesTable)
    .where(and(eq(partiesTable.id, id), eq(partiesTable.firmId, req.firmId!), isNull(partiesTable.deletedAt)));
  if (!party) { res.status(404).json({ error: "Party not found" }); return; }

  const parsed = UpdatePartyBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  const updatePayload: Partial<typeof partiesTable.$inferInsert> = {};
  if (parsed.data.partyType !== undefined) updatePayload.partyType = parsed.data.partyType;
  if (parsed.data.fullName !== undefined) updatePayload.fullName = parsed.data.fullName;
  if (parsed.data.nric !== undefined) updatePayload.nric = parsed.data.nric;
  if (parsed.data.passportNo !== undefined) updatePayload.passportNo = parsed.data.passportNo;
  if (parsed.data.companyRegNo !== undefined) updatePayload.companyRegNo = parsed.data.companyRegNo;
  if (parsed.data.dob !== undefined) updatePayload.dob = parsed.data.dob;
  if (parsed.data.incorporationDate !== undefined) updatePayload.incorporationDate = parsed.data.incorporationDate;
  if (parsed.data.nationality !== undefined) updatePayload.nationality = parsed.data.nationality;
  if (parsed.data.jurisdiction !== undefined) updatePayload.jurisdiction = parsed.data.jurisdiction;
  if (parsed.data.address !== undefined) updatePayload.address = parsed.data.address;
  if (parsed.data.email !== undefined) updatePayload.email = parsed.data.email;
  if (parsed.data.phone !== undefined) updatePayload.phone = parsed.data.phone;
  if (parsed.data.occupation !== undefined) updatePayload.occupation = parsed.data.occupation;
  if (parsed.data.natureOfBusiness !== undefined) updatePayload.natureOfBusiness = parsed.data.natureOfBusiness;
  if (parsed.data.transactionPurpose !== undefined) updatePayload.transactionPurpose = parsed.data.transactionPurpose;
  if (parsed.data.isPep !== undefined) updatePayload.isPep = parsed.data.isPep;
  if (parsed.data.pepDetails !== undefined) updatePayload.pepDetails = parsed.data.pepDetails;
  if (parsed.data.isHighRiskJurisdiction !== undefined) updatePayload.isHighRiskJurisdiction = parsed.data.isHighRiskJurisdiction;
  if (parsed.data.hasNomineeArrangement !== undefined) updatePayload.hasNomineeArrangement = parsed.data.hasNomineeArrangement;
  if (parsed.data.hasLayeredOwnership !== undefined) updatePayload.hasLayeredOwnership = parsed.data.hasLayeredOwnership;
  if (parsed.data.directors !== undefined) updatePayload.directors = parsed.data.directors;

  const [updated] = await rdb(req).update(partiesTable).set(updatePayload).where(eq(partiesTable.id, id)).returning();

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
router.delete("/parties/:id", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id);
  const [party] = await rdb(req).select().from(partiesTable)
    .where(and(eq(partiesTable.id, id), eq(partiesTable.firmId, req.firmId!), isNull(partiesTable.deletedAt)));
  if (!party) { res.status(404).json({ error: "Party not found" }); return; }

  await rdb(req).update(partiesTable).set({ deletedAt: new Date() }).where(eq(partiesTable.id, id));
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
router.post("/parties/:id/beneficial-owners", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  const partyId = Number(req.params.id);
  const [party] = await rdb(req).select().from(partiesTable)
    .where(and(eq(partiesTable.id, partyId), eq(partiesTable.firmId, req.firmId!), isNull(partiesTable.deletedAt)));
  if (!party) { res.status(404).json({ error: "Party not found" }); return; }

  const parsed = CreateBeneficialOwnerBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  const boInsert = {
    firmId: req.firmId!,
    partyId,
    ownerName: parsed.data.ownerName,
    ownerType: parsed.data.ownerType,
    ownershipPercentage: parsed.data.ownershipPercentage,
    nric: parsed.data.nric,
    passportNo: parsed.data.passportNo,
    nationality: parsed.data.nationality,
    address: parsed.data.address,
    isPep: parsed.data.isPep,
    isUltimateBeneficialOwner: parsed.data.isUltimateBeneficialOwner,
    throughEntityName: parsed.data.throughEntityName,
  } satisfies typeof beneficialOwnersTable.$inferInsert;

  const [bo] = await rdb(req).insert(beneficialOwnersTable).values(boInsert).returning();

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
router.delete("/parties/:id/beneficial-owners/:boId", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  const boId = Number(req.params.boId);
  await rdb(req).delete(beneficialOwnersTable).where(
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
router.get("/cases/:caseId/parties", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  const caseId = Number(req.params.caseId);
  const links = await rdb(req).select({
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
router.post("/cases/:caseId/parties", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  const caseId = Number(req.params.caseId);
  const parsed = z.object({
    partyId: z.number().int(),
    partyRole: z.string().default("client"),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  // Check for duplicate
  const [existing] = await rdb(req).select().from(casePartiesTable)
    .where(and(
      eq(casePartiesTable.caseId, caseId),
      eq(casePartiesTable.partyId, parsed.data.partyId),
      eq(casePartiesTable.firmId, req.firmId!),
    ));
  if (existing) { res.status(409).json({ error: "Party already linked to this case" }); return; }

  const [link] = await rdb(req).insert(casePartiesTable).values({
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
router.delete("/cases/:caseId/parties/:partyId", requireAuth, requireFirmUser, async (req: AuthRequest, res: Response): Promise<void> => {
  const caseId = Number(req.params.caseId);
  const partyId = Number(req.params.partyId);
  await rdb(req).delete(casePartiesTable)
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

const exportedRouter = expressRouter as unknown as ExpressRouter;
export default exportedRouter;
