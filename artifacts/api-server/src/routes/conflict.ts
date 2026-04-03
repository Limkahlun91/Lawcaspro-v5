import { Router, type IRouter } from "express";
import { eq, and, or, ilike, ne, isNull, desc } from "drizzle-orm";
import { z } from "zod";
import {
  db, conflictChecksTable, conflictMatchesTable, conflictOverridesTable,
  casesTable, casePartiesTable, partiesTable, casePurchasersTable, clientsTable,
} from "@workspace/db";
import {
  requireAuth, requireFirmUser, requirePartner, requireReAuth,
  type AuthRequest, writeAuditLog,
} from "../lib/auth";
import { sensitiveRateLimiter } from "../lib/rate-limit";

const router: IRouter = Router();

function rdb(req: AuthRequest) { return req.rlsDb ?? db; }

// ---------------------------------------------------------------------------
// Name similarity engine
//
// Uses a simple normalised token-based overlap to estimate how similar two
// names are.  Returns 0–100.  We avoid heavy NLP libraries intentionally.
// ---------------------------------------------------------------------------
function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSimilarity(a: string, b: string): number {
  const tokA = new Set(normaliseName(a).split(" ").filter(Boolean));
  const tokB = new Set(normaliseName(b).split(" ").filter(Boolean));
  if (tokA.size === 0 || tokB.size === 0) return 0;
  let shared = 0;
  for (const t of tokA) { if (tokB.has(t)) shared++; }
  return Math.round((2 * shared) / (tokA.size + tokB.size) * 100);
}

// Levenshtein distance (for single-token close variants, e.g. typos)
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (__, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function computeNameScore(a: string, b: string): number {
  const na = normaliseName(a), nb = normaliseName(b);
  if (na === nb) return 100;
  const tokenScore = tokenSimilarity(a, b);
  const maxLen = Math.max(na.length, nb.length);
  const editDistance = levenshtein(na, nb);
  const charScore = maxLen > 0 ? Math.max(0, Math.round((1 - editDistance / maxLen) * 100)) : 0;
  return Math.max(tokenScore, charScore);
}

// Match result thresholds
const EXACT_THRESHOLD = 100;
const FUZZY_WARNING_THRESHOLD = 75;   // >= 75 triggers warning
const FUZZY_BLOCK_THRESHOLD = 95;     // >= 95 triggers block

interface PartyInput {
  name: string;
  identifier?: string;
  identifierType?: string;
  role?: string;
}

interface ConflictMatchInput {
  conflictCheckId: number;
  firmId: number;
  partyName: string;
  partyIdentifier?: string;
  identifierType?: string;
  matchedCaseId?: number;
  matchedCaseRef?: string;
  matchedPartyRole?: string;
  matchedPartyName?: string;
  matchType: string;
  matchScore: number;
  result: string;
  detail: string;
}

async function runConflictEngine(
  rlsDb: ReturnType<typeof rdb>,
  firmId: number,
  checkId: number,
  caseIdToExclude: number,
  parties: PartyInput[],
): Promise<ConflictMatchInput[]> {
  const matches: ConflictMatchInput[] = [];

  // Gather all parties already on other cases in this firm.
  // We check case_purchasers (legacy) and case_parties (new).
  const existingPurchasers = await rlsDb
    .select({
      caseId: casePurchasersTable.caseId,
      clientId: casePurchasersTable.clientId,
      role: casePurchasersTable.role,
      referenceNo: casesTable.referenceNo,
      clientName: clientsTable.name,
      clientNric: clientsTable.icNo,
    })
    .from(casePurchasersTable)
    .leftJoin(casesTable, eq(casesTable.id, casePurchasersTable.caseId))
    .leftJoin(clientsTable, eq(clientsTable.id, casePurchasersTable.clientId))
    .where(and(
      eq(casesTable.firmId, firmId),
      ne(casePurchasersTable.caseId, caseIdToExclude),
      isNull(casesTable.deletedAt),
    ));

  const existingCaseParties = await rlsDb
    .select({
      caseId: casePartiesTable.caseId,
      partyRole: casePartiesTable.partyRole,
      referenceNo: casesTable.referenceNo,
      fullName: partiesTable.fullName,
      nric: partiesTable.nric,
      passportNo: partiesTable.passportNo,
      companyRegNo: partiesTable.companyRegNo,
    })
    .from(casePartiesTable)
    .leftJoin(casesTable, eq(casesTable.id, casePartiesTable.caseId))
    .leftJoin(partiesTable, eq(partiesTable.id, casePartiesTable.partyId))
    .where(and(
      eq(casePartiesTable.firmId, firmId),
      ne(casePartiesTable.caseId, caseIdToExclude),
      isNull(casesTable.deletedAt),
      isNull(partiesTable.deletedAt),
    ));

  for (const party of parties) {
    // 1. NRIC / passport / company reg exact match (identifier-based)
    if (party.identifier && party.identifierType) {
      // Check case_purchasers (NRIC stored as icNo on clients)
      if (party.identifierType === "nric") {
        for (const ep of existingPurchasers) {
          if (ep.clientNric && ep.clientNric.replace(/[-\s]/g, "") === party.identifier.replace(/[-\s]/g, "")) {
            matches.push({
              conflictCheckId: checkId, firmId,
              partyName: party.name, partyIdentifier: party.identifier, identifierType: party.identifierType,
              matchedCaseId: ep.caseId ?? undefined, matchedCaseRef: ep.referenceNo ?? undefined,
              matchedPartyRole: ep.role ?? undefined, matchedPartyName: ep.clientName ?? undefined,
              matchType: "nric", matchScore: 100, result: "blocked",
              detail: `NRIC exact match: ${party.identifier} — appears in case ${ep.referenceNo ?? ep.caseId} as ${ep.role}`,
            });
          }
        }
        // Check case_parties
        for (const cp of existingCaseParties) {
          if (cp.nric && cp.nric.replace(/[-\s]/g, "") === party.identifier.replace(/[-\s]/g, "")) {
            matches.push({
              conflictCheckId: checkId, firmId,
              partyName: party.name, partyIdentifier: party.identifier, identifierType: party.identifierType,
              matchedCaseId: cp.caseId ?? undefined, matchedCaseRef: cp.referenceNo ?? undefined,
              matchedPartyRole: cp.partyRole ?? undefined, matchedPartyName: cp.fullName ?? undefined,
              matchType: "nric", matchScore: 100, result: "blocked",
              detail: `NRIC exact match: ${party.identifier} — appears in case ${cp.referenceNo ?? cp.caseId} as ${cp.partyRole}`,
            });
          }
        }
      } else if (party.identifierType === "passport") {
        for (const cp of existingCaseParties) {
          if (cp.passportNo && cp.passportNo.toUpperCase() === party.identifier.toUpperCase()) {
            matches.push({
              conflictCheckId: checkId, firmId,
              partyName: party.name, partyIdentifier: party.identifier, identifierType: party.identifierType,
              matchedCaseId: cp.caseId ?? undefined, matchedCaseRef: cp.referenceNo ?? undefined,
              matchedPartyRole: cp.partyRole ?? undefined, matchedPartyName: cp.fullName ?? undefined,
              matchType: "passport", matchScore: 100, result: "blocked",
              detail: `Passport exact match: ${party.identifier} — appears in case ${cp.referenceNo ?? cp.caseId} as ${cp.partyRole}`,
            });
          }
        }
      } else if (party.identifierType === "company_reg") {
        for (const cp of existingCaseParties) {
          if (cp.companyRegNo && cp.companyRegNo.replace(/[-\s]/g, "") === party.identifier.replace(/[-\s]/g, "")) {
            matches.push({
              conflictCheckId: checkId, firmId,
              partyName: party.name, partyIdentifier: party.identifier, identifierType: party.identifierType,
              matchedCaseId: cp.caseId ?? undefined, matchedCaseRef: cp.referenceNo ?? undefined,
              matchedPartyRole: cp.partyRole ?? undefined, matchedPartyName: cp.fullName ?? undefined,
              matchType: "company_reg", matchScore: 100, result: "blocked",
              detail: `Company reg exact match: ${party.identifier} — appears in case ${cp.referenceNo ?? cp.caseId} as ${cp.partyRole}`,
            });
          }
        }
      }
    }

    // 2. Name matching (fuzzy + exact)
    for (const ep of existingPurchasers) {
      if (!ep.clientName) continue;
      const score = computeNameScore(party.name, ep.clientName);
      if (score >= FUZZY_WARNING_THRESHOLD) {
        const result = score >= FUZZY_BLOCK_THRESHOLD ? "blocked" : "warning";
        const matchType = score === EXACT_THRESHOLD ? "name_exact" : "name_fuzzy";
        matches.push({
          conflictCheckId: checkId, firmId,
          partyName: party.name, partyIdentifier: party.identifier, identifierType: party.identifierType,
          matchedCaseId: ep.caseId ?? undefined, matchedCaseRef: ep.referenceNo ?? undefined,
          matchedPartyRole: ep.role ?? undefined, matchedPartyName: ep.clientName,
          matchType, matchScore: score, result,
          detail: `Name match (score ${score}%): "${party.name}" vs "${ep.clientName}" in case ${ep.referenceNo ?? ep.caseId}`,
        });
      }
    }

    for (const cp of existingCaseParties) {
      if (!cp.fullName) continue;
      const score = computeNameScore(party.name, cp.fullName);
      if (score >= FUZZY_WARNING_THRESHOLD) {
        const result = score >= FUZZY_BLOCK_THRESHOLD ? "blocked" : "warning";
        const matchType = score === EXACT_THRESHOLD ? "name_exact" : "name_fuzzy";
        matches.push({
          conflictCheckId: checkId, firmId,
          partyName: party.name, partyIdentifier: party.identifier, identifierType: party.identifierType,
          matchedCaseId: cp.caseId ?? undefined, matchedCaseRef: cp.referenceNo ?? undefined,
          matchedPartyRole: cp.partyRole ?? undefined, matchedPartyName: cp.fullName,
          matchType, matchScore: score, result,
          detail: `Name match (score ${score}%): "${party.name}" vs "${cp.fullName}" in case ${cp.referenceNo ?? cp.caseId}`,
        });
      }
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// POST /conflict/check — run conflict check for a case
// ---------------------------------------------------------------------------
router.post("/conflict/check", sensitiveRateLimiter, requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const parsed = z.object({
    caseId: z.number().int(),
    parties: z.array(z.object({
      name: z.string().min(1),
      identifier: z.string().optional(),
      identifierType: z.enum(["nric","passport","company_reg","none"]).optional(),
      role: z.string().optional(),
    })).min(1),
    notes: z.string().optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  // Verify case belongs to firm
  const [c] = await rdb(req).select().from(casesTable)
    .where(and(eq(casesTable.id, parsed.data.caseId), eq(casesTable.firmId, req.firmId!)));
  if (!c) { res.status(404).json({ error: "Case not found" }); return; }

  const [check] = await rdb(req).insert(conflictChecksTable).values({
    firmId: req.firmId!,
    caseId: parsed.data.caseId,
    status: "running",
    runBy: req.userId,
    runAt: new Date(),
    notes: parsed.data.notes,
  }).returning();

  try {
    const rawMatches = await runConflictEngine(
      rdb(req),
      req.firmId!, check.id, parsed.data.caseId, parsed.data.parties,
    );

    // Deduplicate: one match per (partyName, matchedCaseId) pair.
    // Prefer identifier-based matches (nric/passport/company_reg) over name matches.
    // Within the same type, keep highest score.
    const TYPE_PRIORITY: Record<string, number> = { nric: 5, passport: 5, company_reg: 5, name_exact: 3, name_fuzzy: 1 };
    const seen = new Map<string, ConflictMatchInput>();
    for (const m of rawMatches) {
      const key = `${m.partyName}|${m.matchedCaseId}`;
      const existing = seen.get(key);
      if (!existing) { seen.set(key, m); continue; }
      const mPri = TYPE_PRIORITY[m.matchType] ?? 0;
      const ePri = TYPE_PRIORITY[existing.matchType] ?? 0;
      if (mPri > ePri || (mPri === ePri && m.matchScore > existing.matchScore)) seen.set(key, m);
    }
    const deduped = Array.from(seen.values());

    let insertedMatches: (typeof conflictMatchesTable.$inferSelect)[] = [];
    if (deduped.length > 0) {
      insertedMatches = await rdb(req).insert(conflictMatchesTable).values(deduped).returning();
    }

    const overallResult = insertedMatches.length === 0
      ? "no_match"
      : insertedMatches.some(m => m.result === "blocked")
        ? "blocked_pending_partner_override"
        : "warning";

    const [updated] = await rdb(req).update(conflictChecksTable).set({
      status: "completed",
      completedAt: new Date(),
      overallResult,
    }).where(eq(conflictChecksTable.id, check.id)).returning();

    await writeAuditLog({
      actorId: req.userId, firmId: req.firmId, actorType: "firm_user",
      action: `compliance.conflict_check_run.${overallResult}`,
      entityType: "case", entityId: parsed.data.caseId,
      detail: `${insertedMatches.length} matches; result=${overallResult}`,
      ipAddress: req.ip, userAgent: req.headers["user-agent"],
    });

    res.status(201).json({ check: updated, matches: insertedMatches });
  } catch (err) {
    await rdb(req).update(conflictChecksTable).set({ status: "failed" }).where(eq(conflictChecksTable.id, check.id));
    throw err;
  }
});

// ---------------------------------------------------------------------------
// GET /conflict/checks — list conflict checks for the firm
// ---------------------------------------------------------------------------
router.get("/conflict/checks", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const { caseId } = req.query as Record<string, string>;
  const checks = await rdb(req).select().from(conflictChecksTable)
    .where(and(
      eq(conflictChecksTable.firmId, req.firmId!),
      caseId ? eq(conflictChecksTable.caseId, Number(caseId)) : undefined,
    ))
    .orderBy(desc(conflictChecksTable.createdAt))
    .limit(100);
  res.json({ data: checks });
});

// ---------------------------------------------------------------------------
// GET /conflict/checks/:id — get check detail with matches
// ---------------------------------------------------------------------------
router.get("/conflict/checks/:id", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const id = Number(req.params.id);
  const [check] = await rdb(req).select().from(conflictChecksTable)
    .where(and(eq(conflictChecksTable.id, id), eq(conflictChecksTable.firmId, req.firmId!)));
  if (!check) { res.status(404).json({ error: "Conflict check not found" }); return; }

  const matches = await rdb(req).select().from(conflictMatchesTable)
    .where(and(eq(conflictMatchesTable.conflictCheckId, id), eq(conflictMatchesTable.firmId, req.firmId!)));

  const overrides = await rdb(req).select().from(conflictOverridesTable)
    .where(and(eq(conflictOverridesTable.conflictCheckId, id), eq(conflictOverridesTable.firmId, req.firmId!)));

  res.json({ check, matches, overrides });
});

// ---------------------------------------------------------------------------
// POST /conflict/checks/:id/override — partner override a blocked match
// Requires: requirePartner + requireReAuth
// ---------------------------------------------------------------------------
router.post(
  "/conflict/checks/:id/override",
  sensitiveRateLimiter,
  requireAuth,
  requireFirmUser,
  requirePartner,
  requireReAuth,
  async (req: AuthRequest, res): Promise<void> => {
    const checkId = Number(req.params.id);
    const parsed = z.object({
      conflictMatchId: z.number().int(),
      overrideReason: z.string().min(10, "Override reason must be at least 10 characters"),
    }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

    const [check] = await rdb(req).select().from(conflictChecksTable)
      .where(and(eq(conflictChecksTable.id, checkId), eq(conflictChecksTable.firmId, req.firmId!)));
    if (!check) { res.status(404).json({ error: "Conflict check not found" }); return; }

    const [match] = await rdb(req).select().from(conflictMatchesTable)
      .where(and(
        eq(conflictMatchesTable.id, parsed.data.conflictMatchId),
        eq(conflictMatchesTable.conflictCheckId, checkId),
        eq(conflictMatchesTable.firmId, req.firmId!),
      ));
    if (!match) { res.status(404).json({ error: "Conflict match not found" }); return; }
    if (match.result !== "blocked") {
      res.status(400).json({ error: "Only blocked matches can be overridden" }); return;
    }

    // Check for duplicate override
    const [existing] = await rdb(req).select().from(conflictOverridesTable)
      .where(and(
        eq(conflictOverridesTable.conflictMatchId, parsed.data.conflictMatchId),
        eq(conflictOverridesTable.firmId, req.firmId!),
      ));
    if (existing) { res.status(409).json({ error: "This match has already been overridden" }); return; }

    const [override] = await rdb(req).insert(conflictOverridesTable).values({
      firmId: req.firmId!,
      conflictCheckId: checkId,
      conflictMatchId: parsed.data.conflictMatchId,
      overriddenBy: req.userId!,
      overrideReason: parsed.data.overrideReason,
    }).returning();

    // Check if all blocked matches are now overridden; if so, update check result
    const allMatches = await rdb(req).select().from(conflictMatchesTable)
      .where(and(eq(conflictMatchesTable.conflictCheckId, checkId), eq(conflictMatchesTable.firmId, req.firmId!)));
    const allOverrides = await rdb(req).select().from(conflictOverridesTable)
      .where(and(eq(conflictOverridesTable.conflictCheckId, checkId), eq(conflictOverridesTable.firmId, req.firmId!)));
    const blockedMatchIds = new Set(allMatches.filter(m => m.result === "blocked").map(m => m.id));
    const overriddenIds = new Set(allOverrides.map(o => o.conflictMatchId));
    const allBlockedOverridden = [...blockedMatchIds].every(id => overriddenIds.has(id));

    if (allBlockedOverridden) {
      const newResult = allMatches.some(m => m.result === "warning") ? "warning" : "no_match";
      await rdb(req).update(conflictChecksTable).set({ overallResult: newResult }).where(eq(conflictChecksTable.id, checkId));
    }

    await writeAuditLog({
      actorId: req.userId, firmId: req.firmId, actorType: "firm_user",
      action: "compliance.conflict_override_applied",
      entityType: "conflict_check", entityId: checkId,
      detail: `matchId=${parsed.data.conflictMatchId} reason="${parsed.data.overrideReason}"`,
      ipAddress: req.ip, userAgent: req.headers["user-agent"],
    });

    res.status(201).json(override);
  }
);

export default router;
