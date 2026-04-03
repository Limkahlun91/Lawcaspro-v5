import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, regulatoryRuleSetsTable, regulatoryRuleVersionsTable } from "@workspace/db";
import { requireAuth, requireFirmUser, requireFounder, type AuthRequest } from "../lib/auth";

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

const router: IRouter = Router();

// ── Public read (any authenticated user) ────────────────────────────────────

router.get("/regulatory/rule-sets", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const sets = await db.select().from(regulatoryRuleSetsTable).orderBy(regulatoryRuleSetsTable.code);
  res.json(sets);
});

router.get("/regulatory/rule-sets/:code/versions", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const code = one(req.params.code);
  if (!code) { res.status(400).json({ error: "code required" }); return; }
  const [set] = await db.select().from(regulatoryRuleSetsTable).where(eq(regulatoryRuleSetsTable.code, code));
  if (!set) { res.status(404).json({ error: "Rule set not found" }); return; }
  const versions = await db.select().from(regulatoryRuleVersionsTable)
    .where(eq(regulatoryRuleVersionsTable.ruleSetId, set.id))
    .orderBy(desc(regulatoryRuleVersionsTable.effectiveFrom));
  res.json(versions);
});

// Get active version for a code at a given date (defaults to today)
router.get("/regulatory/rule-sets/:code/active", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const asOf = one(req.query.date as any) || new Date().toISOString().slice(0, 10);
  const code = one(req.params.code);
  if (!code) { res.status(400).json({ error: "code required" }); return; }
  const [set] = await db.select().from(regulatoryRuleSetsTable).where(eq(regulatoryRuleSetsTable.code, code));
  if (!set) { res.status(404).json({ error: "Rule set not found" }); return; }
  const versions = await db.select().from(regulatoryRuleVersionsTable)
    .where(eq(regulatoryRuleVersionsTable.ruleSetId, set.id))
    .orderBy(desc(regulatoryRuleVersionsTable.effectiveFrom));
  const active = versions.find(v => v.effectiveFrom <= asOf && (!v.effectiveTo || v.effectiveTo >= asOf));
  if (!active) { res.status(404).json({ error: "No active version for this date" }); return; }
  res.json(active);
});

// ── Calculation helpers ────────────────────────────────────────────────────

router.post("/regulatory/calculate", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const body = req.body as { ruleSetCode?: string | string[]; amount: number; date?: string | string[] };
  const ruleSetCode = one(body.ruleSetCode);
  const amount = body.amount;
  const date = one(body.date);
  if (!ruleSetCode || amount === undefined) { res.status(400).json({ error: "ruleSetCode and amount required" }); return; }
  const asOf = date || new Date().toISOString().slice(0, 10);
  const [set] = await db.select().from(regulatoryRuleSetsTable).where(eq(regulatoryRuleSetsTable.code, ruleSetCode));
  if (!set) { res.status(404).json({ error: "Rule set not found" }); return; }
  const versions = await db.select().from(regulatoryRuleVersionsTable)
    .where(eq(regulatoryRuleVersionsTable.ruleSetId, set.id))
    .orderBy(desc(regulatoryRuleVersionsTable.effectiveFrom));
  const v = versions.find(ver => ver.effectiveFrom <= asOf && (!ver.effectiveTo || ver.effectiveTo >= asOf));
  if (!v) { res.status(404).json({ error: "No active rule version" }); return; }
  const result = applyRule(v.rules as any, amount);
  res.json({ ruleSetCode, amount, versionId: v.id, version: v.version, ...result });
});

// ── Founder-only write ─────────────────────────────────────────────────────

router.post("/regulatory/rule-sets/:code/versions", requireAuth, requireFounder, async (req: AuthRequest, res): Promise<void> => {
  const code = one(req.params.code);
  if (!code) { res.status(400).json({ error: "code required" }); return; }
  const [set] = await db.select().from(regulatoryRuleSetsTable).where(eq(regulatoryRuleSetsTable.code, code));
  if (!set) { res.status(404).json({ error: "Rule set not found" }); return; }
  const { version, effectiveFrom, effectiveTo, rules, notes } = req.body;
  if (!version || !effectiveFrom || !rules) { res.status(400).json({ error: "version, effectiveFrom, rules required" }); return; }
  const [row] = await db.insert(regulatoryRuleVersionsTable).values({
    ruleSetId: set.id, version, effectiveFrom, effectiveTo: effectiveTo || null,
    rules, notes: notes || null, createdBy: req.userId!,
  }).returning();
  res.status(201).json(row);
});

export default router;

// ── Fee calculation engine ─────────────────────────────────────────────────

export function applyRule(rules: any, amount: number): { fee: number; breakdown: any[] } {
  if (rules.type === "sliding_scale") {
    const tiers = rules.tiers as { from: number; to: number | null; rate: number; label: string }[];
    let remaining = amount;
    let fee = 0;
    const breakdown: any[] = [];
    for (const tier of tiers) {
      if (remaining <= 0) break;
      const bandTop = tier.to !== null ? tier.to : Infinity;
      const bandSize = bandTop - tier.from;
      const chargeable = Math.min(remaining, bandSize);
      const tierFee = chargeable * tier.rate;
      if (chargeable > 0) {
        breakdown.push({ label: tier.label, chargeable: +chargeable.toFixed(2), rate: tier.rate, fee: +tierFee.toFixed(2) });
        fee += tierFee;
      }
      remaining -= chargeable;
    }
    const minFee = rules.minimum_fee || 0;
    const finalFee = Math.max(fee, minFee);
    return { fee: +finalFee.toFixed(2), breakdown };
  }
  if (rules.type === "flat_rate") {
    const fee = +(amount * rules.rate).toFixed(2);
    return { fee, breakdown: [{ label: `${(rules.rate * 100).toFixed(1)}% flat rate`, chargeable: amount, rate: rules.rate, fee }] };
  }
  return { fee: 0, breakdown: [] };
}
