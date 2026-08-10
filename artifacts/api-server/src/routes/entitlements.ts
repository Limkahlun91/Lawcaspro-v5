import express, { type Router as ExpressRouter } from "express";
import { and, eq, inArray, gte, isNull, or } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  firmEntitlementOverridesTable,
  subscriptionHistoryTable,
  subscriptionPlansTable,
  planEntitlementsTable,
  billingLedgerTable,
  firmsTable,
} from "@workspace/db";
import {
  resolveEntitlementsBulk,
  getEffectiveEntitlement,
  listAllFeatures,
  listPlanEntitlements,
  listFirmOverrides,
  resolveSubscriptionPolicy,
  setFirmEntitlementsCacheDirty,
  setGlobalCacheDirty,
  requireFirmFeature,
  canUseFeature,
  canFirmRunJobsFor,
  filterFirmsForJob,
} from "../services/entitlement-resolver.js";
import { FEATURE_REGISTRY, FEATURE_REGISTRY_MAP, isFeatureRegistered, platformFeaturesTable, collectJobGuardToFeatureMap } from "@workspace/db";
import {
  getFirmUsageSummary,
  getMetricUsage,
  bumpUsageCounter,
  assertUsageBelowLimit,
  currentMonthlyPeriod,
} from "../services/usage-meter.js";
import {
  appendLedgerEntry,
  getFirmLedger,
  getFirmOutstandingBalance,
  reverseLedgerEntry,
  generateMonthlySubscriptionCharge,
  type BillingEntryType,
} from "../services/billing-ledger.js";
import {
  requireAuth,
  requireFounder,
  requireFirmUser,
  writeAuditLog,
  requireFounderPermission,
  type AuthRequest,
} from "../lib/auth.js";
import { ApiError, sendError, sendOk, parseIntParam, type ResLike } from "../lib/api-response.js";

const expressRouter = express.Router();
type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
  patch: (path: string, ...handlers: unknown[]) => unknown;
  put: (path: string, ...handlers: unknown[]) => unknown;
  delete: (path: string, ...handlers: unknown[]) => unknown;
};
const router = expressRouter as unknown as RouterInternalLike;

// ---------------------------------------------------------------------------
// A. Platform feature catalog
// ---------------------------------------------------------------------------

router.get("/platform/features", requireAuth, async (_req: AuthRequest, res: ResLike) => {
  try {
    const items = await listAllFeatures();
    sendOk(res, { items });
  } catch (err) { sendError(res, err); }
});

// ---------------------------------------------------------------------------
// B. Firm's own effective entitlements + single feature
// ---------------------------------------------------------------------------

const resolveBody = z.object({ keys: z.union([z.array(z.string().trim().min(1)).max(200), z.string()]).optional() });

router.get("/firm/entitlements", requireAuth, requireFirmUser, async (req: AuthRequest, res: ResLike) => {
  try {
    const firmId = Number(req.firmId);
    if (!firmId) throw new ApiError({ status: 400, code: "NO_FIRM", message: "", retryable: false });
    const parsed = resolveBody.safeParse(req.query);
    const rawKeys = parsed.success && parsed.data.keys ? parsed.data.keys : undefined;
    const explicitKeys = Array.isArray(rawKeys) ? rawKeys : (typeof rawKeys === "string" ? [rawKeys] : undefined);

    let targetKeys: string[];
    if (explicitKeys && explicitKeys.length > 0) {
      targetKeys = explicitKeys;
    } else {
      const all = await listAllFeatures();
      targetKeys = all.filter(f => f.status === "active" || f.status === "deprecated").map(f => f.featureKey);
    }
    const items = await resolveEntitlementsBulk(firmId, targetKeys, { conn: req.rlsDb ?? undefined });
    sendOk(res, { firmId, items, period: currentMonthlyPeriod() });
  } catch (err) { sendError(res, err); }
});

router.get("/firm/entitlements/:featureKey", requireAuth, requireFirmUser, async (req: AuthRequest, res: ResLike) => {
  try {
    const firmId = Number(req.firmId);
    if (!firmId) throw new ApiError({ status: 400, code: "NO_FIRM", message: "", retryable: false });
    const featureKey = String((req.params as any)?.featureKey ?? "");
    if (!featureKey) throw new ApiError({ status: 400, code: "BAD_PARAM", message: "featureKey missing", retryable: false });
    const item = await getEffectiveEntitlement(firmId, featureKey, { conn: req.rlsDb ?? undefined });
    sendOk(res, { firmId, item });
  } catch (err) { sendError(res, err); }
});

// ---------------------------------------------------------------------------
// C. Firm's own usage
// ---------------------------------------------------------------------------

router.get("/firm/usage", requireAuth, requireFirmUser, async (req: AuthRequest, res: ResLike) => {
  try {
    const firmId = Number(req.firmId);
    if (!firmId) throw new ApiError({ status: 400, code: "NO_FIRM", message: "", retryable: false });
    const usage = await getFirmUsageSummary(firmId, { conn: req.rlsDb ?? undefined, recomputeIfMissing: true });
    sendOk(res, { firmId, period: currentMonthlyPeriod(), usage });
  } catch (err) { sendError(res, err); }
});

router.get("/firm/usage/:metricKey", requireAuth, requireFirmUser, async (req: AuthRequest, res: ResLike) => {
  try {
    const firmId = Number(req.firmId);
    if (!firmId) throw new ApiError({ status: 400, code: "NO_FIRM", message: "", retryable: false });
    const metricKey = String((req.params as any)?.metricKey ?? "");
    if (!metricKey) throw new ApiError({ status: 400, code: "BAD_PARAM", message: "", retryable: false });
    const item = await getMetricUsage(firmId, metricKey, { conn: req.rlsDb ?? undefined, recomputeIfMissing: true });
    sendOk(res, { firmId, period: currentMonthlyPeriod(), item });
  } catch (err) { sendError(res, err); }
});

// ---------------------------------------------------------------------------
// D. Firm's own billing ledger (read-only)
// ---------------------------------------------------------------------------

router.get("/firm/billing/ledger", requireAuth, requireFirmUser, async (req: AuthRequest, res: ResLike) => {
  try {
    const firmId = Number(req.firmId);
    if (!firmId) throw new ApiError({ status: 400, code: "NO_FIRM", message: "", retryable: false });
    const limit = Math.min(parseIntParam("limit", (req.query as any)?.limit, { required: false, min: 1 }) ?? 100, 500);
    const offset = Math.max(0, parseIntParam("offset", (req.query as any)?.offset, { required: false, min: 0 }) ?? 0);
    const page = await getFirmLedger(firmId, { limit, offset });
    const balance = await getFirmOutstandingBalance(firmId);
    sendOk(res, { firmId, period: currentMonthlyPeriod(), balance, page });
  } catch (err) { sendError(res, err); }
});

// ---------------------------------------------------------------------------
// E. Founder: plan entitlements (list + bulk upsert)
// ---------------------------------------------------------------------------

router.get("/founder/plans/:planId/entitlements", requireAuth, requireFounder, requireFounderPermission("platform.manage"), async (req: AuthRequest, res: ResLike) => {
  try {
    const planId = parseIntParam("planId", (req.params as any)?.planId, { required: true, min: 1 })!;
    const features = await listAllFeatures();
    const entitlements = await listPlanEntitlements(planId);
    sendOk(res, { planId, features, entitlements });
  } catch (err) { sendError(res, err); }
});

const planEntitlementsBody = z.object({
  entries: z.array(z.object({
    featureKey: z.string().trim().min(1),
    valueJson: z.any(),
  })).max(500),
});

router.put("/founder/plans/:planId/entitlements", requireAuth, requireFounder, requireFounderPermission("platform.manage"), async (req: AuthRequest, res: ResLike) => {
  try {
    const planId = parseIntParam("planId", (req.params as any)?.planId, { required: true, min: 1 })!;
    const parsed = planEntitlementsBody.safeParse(req.body);
    if (!parsed.success) throw new ApiError({ status: 400, code: "VALIDATION_ERROR", message: parsed.error.message, retryable: false });

    await db.transaction(async (tx) => {
      for (const e of parsed.data.entries) {
        await tx
          .insert(planEntitlementsTable)
          .values({ planId, featureKey: e.featureKey, valueJson: e.valueJson })
          .onConflictDoUpdate({
            target: [planEntitlementsTable.planId, planEntitlementsTable.featureKey],
            set: { valueJson: e.valueJson, updatedAt: new Date() },
          });
      }
    });
    await writeAuditLog({ actorId: req.userId, actorType: req.userType, action: "founder.plan_entitlements.update", entityType: "subscription_plan", entityId: planId, detail: `entries=${parsed.data.entries.length}`, ipAddress: (req as any).ip, userAgent: (req as any).headers?.["user-agent"] }, { strict: false });
    setGlobalCacheDirty(); // Plan entitlement change affects all firms on this plan
    sendOk(res, { planId, updated: parsed.data.entries.length });
  } catch (err) { sendError(res, err); }
});

// ---------------------------------------------------------------------------
// F. Founder: firm entitlements view + override CRUD
// ---------------------------------------------------------------------------

router.get("/founder/firms/:firmId/entitlements", requireAuth, requireFounder, requireFounderPermission("founder.firms.read"), async (req: AuthRequest, res: ResLike) => {
  try {
    const firmId = parseIntParam("firmId", (req.params as any)?.firmId, { required: true, min: 1 })!;
    const keysQ = resolveBody.safeParse(req.query);
    const rawKeys = keysQ.success && keysQ.data.keys ? keysQ.data.keys : undefined;
    const explicitKeys = Array.isArray(rawKeys) ? rawKeys : (typeof rawKeys === "string" ? [rawKeys] : undefined);
    let keys: string[];
    if (explicitKeys && explicitKeys.length > 0) {
      keys = explicitKeys;
    } else {
      const all = await listAllFeatures();
      keys = all.map(f => f.featureKey);
    }
    const items = await resolveEntitlementsBulk(firmId, keys, { actingAsFounder: true });
    const overrides = await listFirmOverrides(firmId);
    const [firmRow] = await db.select({
      id: firmsTable.id, status: firmsTable.status, subStatus: firmsTable.subscriptionStatus,
      planId: firmsTable.subscriptionPlanId,
      isCustomPlan: firmsTable.isCustomPlan, customPriceMonthly: firmsTable.customPriceMonthly,
    }).from(firmsTable).where(eq(firmsTable.id, firmId)).limit(1);
    const planIdNum = Number(firmRow?.planId ?? 0);
    const [planRow] = planIdNum > 0
      ? await db.select().from(subscriptionPlansTable).where(eq(subscriptionPlansTable.id, planIdNum)).limit(1)
      : [undefined];
    const subPolicy = firmRow ? resolveSubscriptionPolicy({ firmId, subscriptionStatus: String(firmRow.subStatus ?? "active"), planId: Number(firmRow.planId), isCustomPlan: !!firmRow.isCustomPlan, customPriceMonthly: firmRow.customPriceMonthly ? String(firmRow.customPriceMonthly) : null }) : null;
    sendOk(res, { firm: firmRow ?? null, plan: planRow ?? null, subscriptionPolicy: subPolicy, items, overrides });
  } catch (err) { sendError(res, err); }
});

const overrideInsertSchema = z.object({
  featureKey: z.string().trim().min(1),
  overrideKind: z.enum(["permanent", "temporary"]).optional(),
  overrideMode: z.enum(["plan_default", "enabled", "disabled", "custom"]),
  valueJson: z.any().optional(),
  effectiveFrom: z.union([z.string().datetime({ offset: true }), z.string().date()]).optional().nullable(),
  expiresAt: z.union([z.string().datetime({ offset: true }), z.string().date()]).optional().nullable(),
  billingType: z.enum(["included", "paid_addon", "complimentary", "trial"]).optional(),
  priceOverride: z.union([z.number(), z.string()]).nullable().optional(),
  reason: z.string().trim().max(500).optional(),
}).superRefine((b, ctx) => {
  // Enforcement matching 0148 SQL CHECK constraints:
  //  - permanent → effectiveFrom must be NULL AND expiresAt must be NULL
  //  - temporary → effectiveFrom is REQUIRED (expiresAt optional = "until further notice")
  const kind = b.overrideKind ?? "temporary";
  if (kind === "permanent") {
    if (b.effectiveFrom !== undefined && b.effectiveFrom !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["effectiveFrom"],
        message: "permanent overrides must not have effectiveFrom" });
    }
    if (b.expiresAt !== undefined && b.expiresAt !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"],
        message: "permanent overrides must not have expiresAt" });
    }
  } else {
    if (b.effectiveFrom === undefined || b.effectiveFrom === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["effectiveFrom"],
        message: "temporary overrides require effectiveFrom" });
    }
  }
});

router.post("/founder/firms/:firmId/entitlements/override", requireAuth, requireFounder, requireFounderPermission("founder.firms.manage"), async (req: AuthRequest, res: ResLike) => {
  try {
    const firmId = parseIntParam("firmId", (req.params as any)?.firmId, { required: true, min: 1 })!;
    const parsed = overrideInsertSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError({ status: 400, code: "VALIDATION_ERROR", message: parsed.error.message, retryable: false });
    const b = parsed.data;
    const kind = b.overrideKind ?? "temporary";
    const [row] = await db
      .insert(firmEntitlementOverridesTable)
      .values({
        firmId,
        featureKey: b.featureKey,
        overrideKind: kind,
        overrideMode: b.overrideMode,
        valueJson: b.valueJson ?? null,
        effectiveFrom: kind === "permanent" ? null : (b.effectiveFrom ? new Date(b.effectiveFrom) : null),
        expiresAt: kind === "permanent" ? null : (b.expiresAt ? new Date(b.expiresAt) : null),
        billingType: b.billingType ?? "included",
        priceOverride: b.priceOverride === undefined ? null : (b.priceOverride === null ? null : String(Number(b.priceOverride).toFixed(2)) as any),
        reason: b.reason ?? null,
        createdBy: req.userId ?? null,
      })
      .returning();
    await writeAuditLog({ firmId, actorId: req.userId, actorType: req.userType, action: "founder.entitlement_override.create", entityType: "firm_entitlement_override", entityId: Number(row.id), detail: JSON.stringify(b), ipAddress: (req as any).ip, userAgent: (req as any).headers?.["user-agent"] });
    setFirmEntitlementsCacheDirty(firmId);
    sendOk(res, { item: row }, { status: 201 });
  } catch (err) { sendError(res, err); }
});

router.patch("/founder/firms/:firmId/entitlements/override/:overrideId", requireAuth, requireFounder, requireFounderPermission("founder.firms.manage"), async (req: AuthRequest, res: ResLike) => {
  try {
    const firmId = parseIntParam("firmId", (req.params as any)?.firmId, { required: true, min: 1 })!;
    const overrideId = parseIntParam("overrideId", (req.params as any)?.overrideId, { required: true, min: 1 })!;
    const parsed = overrideInsertSchema.partial().safeParse(req.body);
    if (!parsed.success) throw new ApiError({ status: 400, code: "VALIDATION_ERROR", message: parsed.error.message, retryable: false });
    const b = parsed.data;
    const updates: any = { updatedAt: new Date() };
    if (b.overrideKind !== undefined) updates.overrideKind = b.overrideKind;
    if (b.overrideMode !== undefined) updates.overrideMode = b.overrideMode;
    if ("valueJson" in b) updates.valueJson = b.valueJson ?? null;
    if ("effectiveFrom" in b) updates.effectiveFrom = b.effectiveFrom ? new Date(b.effectiveFrom) : null;
    if ("expiresAt" in b) updates.expiresAt = b.expiresAt ? new Date(b.expiresAt) : null;
    if (b.billingType !== undefined) updates.billingType = b.billingType;
    if ("priceOverride" in b) updates.priceOverride = b.priceOverride === null ? null : (b.priceOverride === undefined ? undefined : String(Number(b.priceOverride).toFixed(2)) as any);
    if (b.reason !== undefined) updates.reason = b.reason ?? null;
    const [row] = await db.update(firmEntitlementOverridesTable).set(updates).where(and(eq(firmEntitlementOverridesTable.id, overrideId), eq(firmEntitlementOverridesTable.firmId, firmId))).returning();
    if (!row) throw new ApiError({ status: 404, code: "NOT_FOUND", message: "Override not found", retryable: false });
    await writeAuditLog({ firmId, actorId: req.userId, actorType: req.userType, action: "founder.entitlement_override.update", entityType: "firm_entitlement_override", entityId: Number(row.id), detail: JSON.stringify(b), ipAddress: (req as any).ip, userAgent: (req as any).headers?.["user-agent"] });
    setFirmEntitlementsCacheDirty(firmId);
    sendOk(res, { item: row });
  } catch (err) { sendError(res, err); }
});

router.delete("/founder/firms/:firmId/entitlements/override/:overrideId", requireAuth, requireFounder, requireFounderPermission("founder.firms.manage"), async (req: AuthRequest, res: ResLike) => {
  try {
    const firmId = parseIntParam("firmId", (req.params as any)?.firmId, { required: true, min: 1 })!;
    const overrideId = parseIntParam("overrideId", (req.params as any)?.overrideId, { required: true, min: 1 })!;
    const [row] = await db.delete(firmEntitlementOverridesTable).where(and(eq(firmEntitlementOverridesTable.id, overrideId), eq(firmEntitlementOverridesTable.firmId, firmId))).returning();
    if (!row) throw new ApiError({ status: 404, code: "NOT_FOUND", message: "Override not found", retryable: false });
    await writeAuditLog({ firmId, actorId: req.userId, actorType: req.userType, action: "founder.entitlement_override.delete", entityType: "firm_entitlement_override", entityId: Number(row.id), ipAddress: (req as any).ip, userAgent: (req as any).headers?.["user-agent"] });
    setFirmEntitlementsCacheDirty(firmId);
    sendOk(res, { deleted: true });
  } catch (err) { sendError(res, err); }
});

// ---------------------------------------------------------------------------
// G. Founder: firm plan/subscription status change + history
// ---------------------------------------------------------------------------

const firmSubscriptionBody = z.object({
  planId: z.number().int().positive().optional(),
  status: z.enum(["trial", "active", "past_due", "suspended", "cancelled", "expired"]).optional(),
  isCustomPlan: z.boolean().optional(),
  customPriceMonthly: z.union([z.number(), z.string()]).nullable().optional(),
  reason: z.string().trim().max(500).optional(),
});

router.patch("/founder/firms/:firmId/subscription", requireAuth, requireFounder, requireFounderPermission("founder.firms.manage"), async (req: AuthRequest, res: ResLike) => {
  try {
    const firmId = parseIntParam("firmId", (req.params as any)?.firmId, { required: true, min: 1 })!;
    const parsed = firmSubscriptionBody.safeParse(req.body);
    if (!parsed.success) throw new ApiError({ status: 400, code: "VALIDATION_ERROR", message: parsed.error.message, retryable: false });
    const b = parsed.data;
    const [before] = await db.select().from(firmsTable).where(eq(firmsTable.id, firmId)).limit(1);
    if (!before) throw new ApiError({ status: 404, code: "NOT_FOUND", message: "Firm not found", retryable: false });
    const updates: any = { updatedAt: new Date() };
    if (b.planId !== undefined) updates.subscriptionPlanId = b.planId;
    if (b.status !== undefined) updates.subscriptionStatus = b.status;
    if (b.isCustomPlan !== undefined) updates.isCustomPlan = b.isCustomPlan;
    if ("customPriceMonthly" in b) updates.customPriceMonthly = b.customPriceMonthly === null ? null : (b.customPriceMonthly === undefined ? undefined : Number(b.customPriceMonthly));
    const [after] = await db.update(firmsTable).set(updates).where(eq(firmsTable.id, firmId)).returning();
    await db.insert(subscriptionHistoryTable).values({
      firmId,
      oldPlanId: before.subscriptionPlanId,
      newPlanId: after.subscriptionPlanId,
      oldStatus: before.subscriptionStatus,
      newStatus: after.subscriptionStatus,
      priceSnapshot: after.customPriceMonthly ?? (null as any),
      changedBy: req.userId ?? null,
      reason: b.reason ?? null,
      beforeJson: JSON.parse(JSON.stringify(before)) as any,
      afterJson: JSON.parse(JSON.stringify(after)) as any,
    });
    await writeAuditLog({ firmId, actorId: req.userId, actorType: req.userType, action: "founder.subscription.update", entityType: "firm", entityId: firmId, detail: JSON.stringify(b), ipAddress: (req as any).ip, userAgent: (req as any).headers?.["user-agent"], before: before as any, after: after as any, reason: b.reason ?? undefined });
    setFirmEntitlementsCacheDirty(firmId);
    sendOk(res, { item: after });
  } catch (err) { sendError(res, err); }
});

router.get("/founder/firms/:firmId/subscription/history", requireAuth, requireFounder, requireFounderPermission("founder.firms.read"), async (req: AuthRequest, res: ResLike) => {
  try {
    const firmId = parseIntParam("firmId", (req.params as any)?.firmId, { required: true, min: 1 })!;
    const items = await db.select().from(subscriptionHistoryTable).where(eq(subscriptionHistoryTable.firmId, firmId)).orderBy(subscriptionHistoryTable.createdAt);
    sendOk(res, { firmId, items });
  } catch (err) { sendError(res, err); }
});

// ---------------------------------------------------------------------------
// H. Founder: firm billing ledger + append + reverse + generate month charge
// ---------------------------------------------------------------------------

router.get("/founder/firms/:firmId/billing/ledger", requireAuth, requireFounder, requireFounderPermission("founder.dashboard.read"), async (req: AuthRequest, res: ResLike) => {
  try {
    const firmId = parseIntParam("firmId", (req.params as any)?.firmId, { required: true, min: 1 })!;
    const limit = Math.min(parseIntParam("limit", (req.query as any)?.limit, { required: false, min: 1 }) ?? 200, 500);
    const offset = Math.max(0, parseIntParam("offset", (req.query as any)?.offset, { required: false, min: 0 }) ?? 0);
    const page = await getFirmLedger(firmId, { limit, offset });
    const balance = await getFirmOutstandingBalance(firmId);
    sendOk(res, { firmId, balance, page });
  } catch (err) { sendError(res, err); }
});

const ledgerAppendBody = z.object({
  entryType: z.enum(["subscription_charge","usage_charge","addon_charge","adjustment","reversal","credit_note","debit_note","payment","refund","write_off","rounding","complimentary"]),
  description: z.string().trim().min(1).max(500),
  debit: z.union([z.number(), z.string()]).optional(),
  credit: z.union([z.number(), z.string()]).optional(),
  invoiceId: z.number().int().positive().nullable().optional(),
  idempotencyKey: z.string().trim().max(100).optional().nullable(),
  referenceNo: z.string().trim().max(100).optional(),
  sourceType: z.string().trim().max(100).optional(),
  sourceId: z.number().int().positive().optional(),
  dueDate: z.string().date().optional(),
  paidDate: z.string().date().optional(),
  status: z.enum(["pending", "posted", "voided"]).optional(),
  paymentReference: z.string().trim().max(100).optional(),
  paymentMethod: z.string().trim().max(50).optional(),
});

router.post("/founder/firms/:firmId/billing/ledger/append", requireAuth, requireFounder, requireFounderPermission("founder.ops.manage"), async (req: AuthRequest, res: ResLike) => {
  try {
    const firmId = parseIntParam("firmId", (req.params as any)?.firmId, { required: true, min: 1 })!;
    const parsed = ledgerAppendBody.safeParse(req.body);
    if (!parsed.success) throw new ApiError({ status: 400, code: "VALIDATION_ERROR", message: parsed.error.message, retryable: false });
    const b = parsed.data;
    const result = await appendLedgerEntry({
      firmId, entryType: b.entryType as BillingEntryType, description: b.description,
      debit: b.debit ?? 0, credit: b.credit ?? 0,
      invoiceId: b.invoiceId ?? null, idempotencyKey: b.idempotencyKey ?? null,
      referenceNo: b.referenceNo ?? null,
      sourceType: b.sourceType ?? null, sourceId: b.sourceId ?? null,
      dueDate: b.dueDate ?? null, paidDate: b.paidDate ?? null,
      status: b.status ?? "posted", paymentReference: b.paymentReference ?? null, paymentMethod: b.paymentMethod ?? null,
      createdBy: req.userId ?? null,
    });
    await writeAuditLog({ firmId, actorId: req.userId, actorType: req.userType, action: "founder.billing.ledger.append", entityType: "billing_ledger", entityId: result.id, detail: `type=${b.entryType} D=${b.debit ?? 0} C=${b.credit ?? 0}`, ipAddress: (req as any).ip, userAgent: (req as any).headers?.["user-agent"] });
    sendOk(res, { id: result.id, runningBalance: result.runningBalance }, { status: 201 });
  } catch (err) { sendError(res, err); }
});

router.post("/founder/billing/ledger/:entryId/reverse", requireAuth, requireFounder, requireFounderPermission("founder.ops.manage"), async (req: AuthRequest, res: ResLike) => {
  try {
    const entryId = parseIntParam("entryId", (req.params as any)?.entryId, { required: true, min: 1 })!;
    const bodySchema = z.object({ reason: z.string().trim().max(500).optional(), referenceNo: z.string().trim().max(100).optional() });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError({ status: 400, code: "VALIDATION_ERROR", message: parsed.error.message, retryable: false });
    const result = await reverseLedgerEntry(entryId, { actorId: req.userId ?? null, reason: parsed.data.reason, referenceNo: parsed.data.referenceNo });
    const [firmRow] = await db.select({ firmId: billingLedgerTable.firmId }).from(billingLedgerTable).where(eq(billingLedgerTable.id, entryId)).limit(1);
    await writeAuditLog({ firmId: Number(firmRow?.firmId ?? 0) || undefined, actorId: req.userId, actorType: req.userType, action: "founder.billing.ledger.reverse", entityType: "billing_ledger", entityId: entryId, detail: parsed.data.reason ?? "", ipAddress: (req as any).ip, userAgent: (req as any).headers?.["user-agent"] });
    sendOk(res, { reversalId: result.reversalId, runningBalance: result.runningBalance });
  } catch (err) { sendError(res, err); }
});

router.post("/founder/firms/:firmId/billing/generate-monthly", requireAuth, requireFounder, requireFounderPermission("founder.ops.manage"), async (req: AuthRequest, res: ResLike) => {
  try {
    const firmId = parseIntParam("firmId", (req.params as any)?.firmId, { required: true, min: 1 })!;
    const d = new Date();
    const periodStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    const periodEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    const result = await generateMonthlySubscriptionCharge(firmId, periodStart, periodEnd, { actorId: req.userId ?? null });
    await writeAuditLog({ firmId, actorId: req.userId, actorType: req.userType, action: "founder.billing.charge_monthly_generated", entityType: "billing_ledger", entityId: result.chargeId, detail: `amount=${result.amount}`, ipAddress: (req as any).ip, userAgent: (req as any).headers?.["user-agent"] });
    sendOk(res, { chargeId: result.chargeId, amount: result.amount, runningBalance: result.runningBalance, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString() });
  } catch (err) { sendError(res, err); }
});

// ---------------------------------------------------------------------------
// I. Founder: firm usage (cross-firm read + bump)
// ---------------------------------------------------------------------------

router.get("/founder/firms/:firmId/usage", requireAuth, requireFounder, requireFounderPermission("founder.firms.read"), async (req: AuthRequest, res: ResLike) => {
  try {
    const firmId = parseIntParam("firmId", (req.params as any)?.firmId, { required: true, min: 1 })!;
    const usage = await getFirmUsageSummary(firmId, { recomputeIfMissing: true });
    sendOk(res, { firmId, period: currentMonthlyPeriod(), usage });
  } catch (err) { sendError(res, err); }
});

const usageBumpBody = z.object({
  metricKey: z.string().trim().min(1),
  delta: z.number().int().optional(),
  period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

router.post("/founder/firms/:firmId/usage/bump", requireAuth, requireFounder, requireFounderPermission("founder.ops.manage"), async (req: AuthRequest, res: ResLike) => {
  try {
    const firmId = parseIntParam("firmId", (req.params as any)?.firmId, { required: true, min: 1 })!;
    const parsed = usageBumpBody.safeParse(req.body);
    if (!parsed.success) throw new ApiError({ status: 400, code: "VALIDATION_ERROR", message: parsed.error.message, retryable: false });
    await bumpUsageCounter(db, firmId, parsed.data.metricKey, parsed.data.delta ?? 1);
    const item = await getMetricUsage(firmId, parsed.data.metricKey, { periodKey: parsed.data.period ?? currentMonthlyPeriod() });
    await writeAuditLog({ firmId, actorId: req.userId, actorType: req.userType, action: "founder.usage.bump", entityType: "usage_counter", entityId: 0, detail: `metric=${parsed.data.metricKey} delta=${parsed.data.delta ?? 1}`, ipAddress: (req as any).ip, userAgent: (req as any).headers?.["user-agent"] });
    sendOk(res, { firmId, item });
  } catch (err) { sendError(res, err); }
});

// ---------------------------------------------------------------------------
// K. Emergency kill switch (Part 2 §9): global emergency-disable feature OR
//    firm-specific emergency-disable + audit log
// ---------------------------------------------------------------------------
const emergencyGlobalBody = z.object({
  featureKey: z.string().trim().min(1),
  enabled: z.boolean(),
  reason: z.string().trim().max(500),
});
router.post("/founder/platform/features/emergency", requireAuth, requireFounder, requireFounderPermission("platform.manage"), async (req: AuthRequest, res: ResLike) => {
  try {
    const parsed = emergencyGlobalBody.safeParse(req.body);
    if (!parsed.success) throw new ApiError({ status: 400, code: "VALIDATION_ERROR", message: parsed.error.message, retryable: false });
    if (!isFeatureRegistered(parsed.data.featureKey)) {
      throw new ApiError({ status: 404, code: "FEATURE_NOT_FOUND", message: `Feature not registered: ${parsed.data.featureKey}`, retryable: false });
    }
    const status = parsed.data.enabled ? "active" : "emergency_disabled";
    const [before] = await db.select().from(platformFeaturesTable).where(eq(platformFeaturesTable.featureKey, parsed.data.featureKey)).limit(1);
    const [after] = await db
      .update(platformFeaturesTable)
      .set({ status: status as any, updatedAt: new Date() })
      .where(eq(platformFeaturesTable.featureKey, parsed.data.featureKey))
      .returning();
    if (!after) throw new ApiError({ status: 404, code: "FEATURE_NOT_FOUND", message: `Feature row missing in DB (seed required?): ${parsed.data.featureKey}`, retryable: false });
    await writeAuditLog({
      actorId: req.userId, actorType: req.userType,
      action: parsed.data.enabled ? "founder.platform.feature_emergency_enable" : "founder.platform.feature_emergency_disable",
      entityType: "platform_feature", entityId: Number(before?.id ?? after.id),
      detail: parsed.data.reason,
      before: before as any, after: after as any, reason: parsed.data.reason,
      ipAddress: (req as any).ip, userAgent: (req as any).headers?.["user-agent"],
    }, { strict: false });
    setGlobalCacheDirty();
    sendOk(res, { feature: after });
  } catch (err) { sendError(res, err); }
});

const emergencyFirmBody = z.object({
  featureKey: z.string().trim().min(1),
  enabled: z.boolean(),
  expiresAt: z.union([z.string().datetime({ offset: true }), z.string().date()]).optional().nullable(),
  reason: z.string().trim().max(500),
});
router.post("/founder/firms/:firmId/entitlements/emergency", requireAuth, requireFounder, requireFounderPermission("founder.firms.manage"), async (req: AuthRequest, res: ResLike) => {
  try {
    const firmId = parseIntParam("firmId", (req.params as any)?.firmId, { required: true, min: 1 })!;
    const parsed = emergencyFirmBody.safeParse(req.body);
    if (!parsed.success) throw new ApiError({ status: 400, code: "VALIDATION_ERROR", message: parsed.error.message, retryable: false });
    if (!isFeatureRegistered(parsed.data.featureKey)) {
      throw new ApiError({ status: 404, code: "FEATURE_NOT_FOUND", message: `Feature not registered: ${parsed.data.featureKey}`, retryable: false });
    }
    // Emergency disable = TEMPORARY override (always temporary because emergency implies a bounded event;
    // if expiresAt not provided we keep effectiveFrom=now WITHOUT expiresAt = "until manually lifted via new override").
    // Explicit override_kind='temporary' + effective_from=now() to satisfy the 0148 SQL CHECK
    // firm_entitlement_overrides_temporary_effective (override_kind='temporary' IMPLIES effective_from NOT NULL).
    const [row] = await db
      .insert(firmEntitlementOverridesTable)
      .values({
        firmId,
        featureKey: parsed.data.featureKey,
        overrideKind: "temporary",
        overrideMode: parsed.data.enabled ? "enabled" : "disabled",
        effectiveFrom: new Date(),
        expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
        billingType: "complimentary",
        reason: parsed.data.reason ?? "founder emergency override",
        createdBy: req.userId ?? null,
      })
      .returning();
    await writeAuditLog({
      firmId, actorId: req.userId, actorType: req.userType,
      action: parsed.data.enabled ? "founder.firm.emergency_enable" : "founder.firm.emergency_disable",
      entityType: "firm_entitlement_override", entityId: Number(row.id),
      detail: JSON.stringify(parsed.data),
      ipAddress: (req as any).ip, userAgent: (req as any).headers?.["user-agent"],
    });
    setFirmEntitlementsCacheDirty(firmId);
    sendOk(res, { item: row }, { status: 201 });
  } catch (err) { sendError(res, err); }
});

// ---------------------------------------------------------------------------
// L. Bulk operations (Part 2 §4 UI): enable-all / disable-all / reset-to-plan
// ---------------------------------------------------------------------------
const bulkOverrideBody = z.object({
  // exact feature keys to set (UI controls search/filter/expand)
  featureKeys: z.array(z.string().trim().min(1)).max(500),
  mode: z.enum(["enabled", "disabled", "plan_default"]),
  reason: z.string().trim().max(500).optional(),
});
router.post("/founder/firms/:firmId/entitlements/bulk-override", requireAuth, requireFounder, requireFounderPermission("founder.firms.manage"), async (req: AuthRequest, res: ResLike) => {
  try {
    const firmId = parseIntParam("firmId", (req.params as any)?.firmId, { required: true, min: 1 })!;
    const parsed = bulkOverrideBody.safeParse(req.body);
    if (!parsed.success) throw new ApiError({ status: 400, code: "VALIDATION_ERROR", message: parsed.error.message, retryable: false });
    for (const k of parsed.data.featureKeys) {
      if (!isFeatureRegistered(k)) throw new ApiError({ status: 400, code: "VALIDATION_ERROR", message: `Unknown feature: ${k}`, retryable: false });
    }
    if (parsed.data.mode === "plan_default") {
      // Remove active overrides for these keys (reset to plan default) – we soft-delete by setting expiresAt to NOW
      const now = new Date();
      await db
        .update(firmEntitlementOverridesTable)
        .set({ expiresAt: now, updatedAt: now })
        .where(
          and(
            eq(firmEntitlementOverridesTable.firmId, firmId),
            inArray(firmEntitlementOverridesTable.featureKey, parsed.data.featureKeys),
            or(isNull(firmEntitlementOverridesTable.expiresAt), gte(firmEntitlementOverridesTable.expiresAt, now)),
          ),
        );
    } else {
      // enabled/disabled bulk = permanent overrides (no time bound).
      // Permanent overrides use override_kind='permanent' with effectiveFrom=NULL, expiresAt=NULL.
      // The DB unique index uq_firm_entitlement_permanent enforces one permanent row per (firm, feature).
      await db.transaction(async (tx) => {
        for (const k of parsed.data.featureKeys) {
          await tx
            .insert(firmEntitlementOverridesTable)
            .values({
              firmId,
              featureKey: k,
              overrideKind: "permanent",
              overrideMode: parsed.data.mode as any,
              effectiveFrom: null,
              expiresAt: null,
              reason: parsed.data.reason ?? null,
              createdBy: req.userId ?? null,
            })
            .onConflictDoNothing({ target: [firmEntitlementOverridesTable.firmId, firmEntitlementOverridesTable.featureKey] });
        }
      });
    }
    await writeAuditLog({
      firmId, actorId: req.userId, actorType: req.userType,
      action: "founder.firm.entitlements.bulk_override",
      entityType: "firm_entitlement_override", entityId: firmId,
      detail: `mode=${parsed.data.mode} n=${parsed.data.featureKeys.length}`,
      ipAddress: (req as any).ip, userAgent: (req as any).headers?.["user-agent"],
    });
    setFirmEntitlementsCacheDirty(firmId);
    sendOk(res, { firmId, mode: parsed.data.mode, count: parsed.data.featureKeys.length });
  } catch (err) { sendError(res, err); }
});

// Reset ALL overrides for a firm (back to plan defaults)
router.post("/founder/firms/:firmId/entitlements/reset", requireAuth, requireFounder, requireFounderPermission("founder.firms.manage"), async (req: AuthRequest, res: ResLike) => {
  try {
    const firmId = parseIntParam("firmId", (req.params as any)?.firmId, { required: true, min: 1 })!;
    const reason = String((req.body as any)?.reason ?? "reset").slice(0, 500);
    const now = new Date();
    const res2 = await db
      .update(firmEntitlementOverridesTable)
      .set({ expiresAt: now, updatedAt: now })
      .where(
        and(
          eq(firmEntitlementOverridesTable.firmId, firmId),
          or(isNull(firmEntitlementOverridesTable.expiresAt), gte(firmEntitlementOverridesTable.expiresAt, now)),
        ),
      );
    await writeAuditLog({
      firmId, actorId: req.userId, actorType: req.userType,
      action: "founder.firm.entitlements.reset",
      entityType: "firm", entityId: firmId, detail: reason,
      ipAddress: (req as any).ip, userAgent: (req as any).headers?.["user-agent"],
    });
    setFirmEntitlementsCacheDirty(firmId);
    sendOk(res, { firmId, reset: (res2 as any)?.rowCount ?? null });
  } catch (err) { sendError(res, err); }
});

// ---------------------------------------------------------------------------
// M. Feature Registry JSON endpoint (source of truth for UI list)
// ---------------------------------------------------------------------------
router.get("/platform/feature-registry", requireAuth, async (_req: AuthRequest, res: ResLike) => {
  try {
    const registry = FEATURE_REGISTRY.map(f => ({
      featureKey: f.featureKey, name: f.name, module: f.module,
      parentFeatureKey: f.parentFeatureKey, valueType: f.valueType,
      defaultValue: f.defaultValue ?? null, dependencies: f.dependencies ?? [],
      configurable: f.configurable !== false, founderOnly: !!f.founderOnly,
      planControlled: f.planControlled !== false,
      firmControlledOverride: f.firmControlledOverride !== false,
      routeHint: f.routeHint ?? null, backendGuardKey: f.backendGuardKey ?? null,
      status: f.status ?? "active", sortOrder: f.sortOrder ?? 0, description: f.description ?? null,
      jobGuards: f.jobGuards ?? [],
    }));
    sendOk(res, { registry, jobGuardMap: collectJobGuardToFeatureMap() });
  } catch (err) { sendError(res, err); }
});

// ---------------------------------------------------------------------------
// J. Export (assertUsageBelowLimit imported for other routes; no public route)
// ---------------------------------------------------------------------------
export { assertUsageBelowLimit };

const exportedRouter = expressRouter as unknown as ExpressRouter;
export { exportedRouter as router };
export default exportedRouter;
