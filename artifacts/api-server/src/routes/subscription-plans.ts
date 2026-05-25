import express, { type Router as ExpressRouter } from "express";
import { and, count, eq, sql } from "drizzle-orm";
import { db, firmsTable, subscriptionPlansTable } from "@workspace/db";
import { z } from "zod/v4";
import { ApiError, sendError, sendOk, parseIntParam, type ResLike } from "../lib/api-response.js";
import { requireAuth, requireFounder, requireFounderPermission, type AuthRequest } from "../lib/auth.js";

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
  put: (path: string, ...handlers: unknown[]) => unknown;
  delete: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

const PlanBodySchema = z.object({
  name: z.string().trim().min(1),
  priceMonthly: z.union([z.number().finite(), z.string().trim().min(1)]),
  maxUsers: z.number().int().positive().nullable().optional(),
  maxCasesPerMonth: z.number().int().positive().nullable().optional(),
  features: z.record(z.string(), z.unknown()).optional(),
  isActive: z.boolean().optional(),
});

const parseMoney = (v: unknown): string => {
  if (typeof v === "number" && Number.isFinite(v)) return v.toFixed(2);
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n.toFixed(2);
  }
  throw new ApiError({ status: 400, code: "INVALID_PRICE", message: "Invalid priceMonthly", retryable: false });
};

router.get("/subscription-plans", requireAuth, requireFounder, requireFounderPermission("platform.manage"), async (_req: AuthRequest, res: ResLike) => {
  try {
    const items = await db
      .select()
      .from(subscriptionPlansTable)
      .orderBy(sql`${subscriptionPlansTable.isActive} desc, ${subscriptionPlansTable.id} asc`);
    sendOk(res, { items });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/subscription-plans", requireAuth, requireFounder, requireFounderPermission("platform.manage"), async (req: AuthRequest, res: ResLike) => {
  try {
    const parsed = PlanBodySchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError({ status: 400, code: "VALIDATION_ERROR", message: parsed.error.message, retryable: false });
    const body = parsed.data;
    const [row] = await db
      .insert(subscriptionPlansTable)
      .values({
        name: body.name,
        priceMonthly: parseMoney(body.priceMonthly),
        maxUsers: body.maxUsers ?? null,
        maxCasesPerMonth: body.maxCasesPerMonth ?? null,
        features: body.features ?? {},
        isActive: body.isActive ?? true,
      })
      .returning();
    sendOk(res, { item: row }, { status: 201 });
  } catch (err) {
    sendError(res, err);
  }
});

router.put("/subscription-plans/:planId", requireAuth, requireFounder, requireFounderPermission("platform.manage"), async (req: AuthRequest, res: ResLike) => {
  try {
    const planId = parseIntParam("planId", (req.params as any)?.planId, { required: true, min: 1 })!;
    const parsed = PlanBodySchema.partial().safeParse(req.body);
    if (!parsed.success) throw new ApiError({ status: 400, code: "VALIDATION_ERROR", message: parsed.error.message, retryable: false });
    const body = parsed.data;
    const updates: Partial<(typeof subscriptionPlansTable)["$inferInsert"]> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.priceMonthly !== undefined) updates.priceMonthly = parseMoney(body.priceMonthly);
    if (body.maxUsers !== undefined) updates.maxUsers = body.maxUsers ?? null;
    if (body.maxCasesPerMonth !== undefined) updates.maxCasesPerMonth = body.maxCasesPerMonth ?? null;
    if (body.features !== undefined) updates.features = body.features ?? {};
    if (body.isActive !== undefined) updates.isActive = body.isActive;
    const [row] = await db.update(subscriptionPlansTable).set(updates).where(eq(subscriptionPlansTable.id, planId)).returning();
    if (!row) throw new ApiError({ status: 404, code: "NOT_FOUND", message: "Plan not found", retryable: false });
    sendOk(res, { item: row });
  } catch (err) {
    sendError(res, err);
  }
});

router.delete("/subscription-plans/:planId", requireAuth, requireFounder, requireFounderPermission("platform.manage"), async (req: AuthRequest, res: ResLike) => {
  try {
    const planId = parseIntParam("planId", (req.params as any)?.planId, { required: true, min: 1 })!;
    const [ref] = await db.select({ c: count() }).from(firmsTable).where(eq(firmsTable.subscriptionPlanId, planId));
    const c = Number(ref?.c ?? 0);
    if (c > 0) throw new ApiError({ status: 409, code: "PLAN_IN_USE", message: "Plan is currently assigned to at least one firm", retryable: false });
    const [row] = await db.delete(subscriptionPlansTable).where(eq(subscriptionPlansTable.id, planId)).returning();
    if (!row) throw new ApiError({ status: 404, code: "NOT_FOUND", message: "Plan not found", retryable: false });
    sendOk(res, { result: { deleted: true } });
  } catch (err) {
    sendError(res, err);
  }
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export { exportedRouter as router };
export default exportedRouter;

