import express, { type Router as ExpressRouter } from "express";
import { eq, desc, and, count } from "drizzle-orm";
import { db, quotationItemsTable, quotationsTable, regulatoryRuleSetsTable, regulatoryRuleVersionsTable, sql } from "@workspace/db";
import { requireAuth, requireFirmUser, type AuthRequest } from "../lib/auth.js";
import { applyRule } from "./regulatory.js";
import { logger } from "../lib/logger.js";

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
  post: (path: string, ...handlers: unknown[]) => unknown;
  patch: (path: string, ...handlers: unknown[]) => unknown;
  put: (path: string, ...handlers: unknown[]) => unknown;
  delete: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

const DEFAULT_TAX_RATE = 8;

function computeTax(amountExclTax: number, taxCode: string, taxRate: number = DEFAULT_TAX_RATE) {
  if (taxCode === "NT" || taxCode === "ZR" || amountExclTax === 0) {
    return { taxAmount: 0, amountInclTax: amountExclTax };
  }
  const taxAmount = Math.round(amountExclTax * taxRate) / 100;
  return { taxAmount, amountInclTax: amountExclTax + taxAmount };
}

function normalizeItem(item: any, quotationId: number, idx: number) {
  const amountExclTax = parseFloat(item.amountExclTax) || 0;
  const taxCode = item.taxCode || "T";
  const taxRate = parseFloat(item.taxRate) || DEFAULT_TAX_RATE;
  const { taxAmount, amountInclTax } = computeTax(amountExclTax, taxCode, taxRate);

  return {
    quotationId,
    section: item.section,
    category: item.category || null,
    itemNo: item.itemNo || null,
    subItemNo: item.subItemNo || null,
    description: item.description,
    taxCode,
    amountExclTax: String(amountExclTax),
    taxRate: String(taxRate),
    taxAmount: String(taxAmount),
    amountInclTax: String(amountInclTax),
    sortOrder: item.sortOrder ?? idx,
  };
}

router.get("/quotations", requireAuth, requireFirmUser, async (req, res): Promise<void> => {
  try {
    const firmId = (req as AuthRequest).firmId!;
    const rows = await db.select().from(quotationsTable)
      .where(eq(quotationsTable.firmId, firmId))
      .orderBy(desc(quotationsTable.createdAt));

    const results = await Promise.all(rows.map(async (q) => {
      const [itemCount] = await db.select({ count: count() }).from(quotationItemsTable)
        .where(eq(quotationItemsTable.quotationId, q.id));

      const items = await db.select().from(quotationItemsTable)
        .where(eq(quotationItemsTable.quotationId, q.id));

      const totalExclTax = items.reduce((sum, i) => sum + parseFloat(i.amountExclTax || "0"), 0);
      const totalTax = items.reduce((sum, i) => sum + parseFloat(i.taxAmount || "0"), 0);
      const totalInclTax = items.reduce((sum, i) => sum + parseFloat(i.amountInclTax || "0"), 0);

      return {
        ...q,
        purchasePrice: q.purchasePrice ? parseFloat(q.purchasePrice) : null,
        itemCount: itemCount?.count || 0,
        totalExclTax,
        totalTax,
        totalInclTax,
        createdAt: q.createdAt.toISOString(),
        updatedAt: q.updatedAt.toISOString(),
      };
    }));

    res.json(results);
    return;
  } catch (err) {
    logger.error({ err, path: req.path }, "[quotations]");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
});

router.post("/quotations", requireAuth, requireFirmUser, async (req, res): Promise<void> => {
  try {
    const firmId = (req as AuthRequest).firmId!;
    const userId = (req as AuthRequest).userId!;
    const { items, ...quotationData } = req.body;

    const result = await db.transaction(async (tx) => {
      const [quotation] = await tx.insert(quotationsTable).values({
        ...quotationData,
        firmId,
        createdBy: userId,
      }).returning();

      if (items && Array.isArray(items) && items.length > 0) {
        const itemRows = items.map((item: any, idx: number) => normalizeItem(item, quotation.id, idx));
        await tx.insert(quotationItemsTable).values(itemRows);
      }

      const allItems = await tx.select().from(quotationItemsTable)
        .where(eq(quotationItemsTable.quotationId, quotation.id))
        .orderBy(quotationItemsTable.sortOrder);

      return {
        ...quotation,
        purchasePrice: quotation.purchasePrice ? parseFloat(quotation.purchasePrice) : null,
        items: allItems.map(formatItem),
        createdAt: quotation.createdAt.toISOString(),
        updatedAt: quotation.updatedAt.toISOString(),
      };
    });

    res.status(201).json(result);
    return;
  } catch (err) {
    logger.error({ err, path: req.path }, "[quotations]");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
});

router.get("/quotations/:id", requireAuth, requireFirmUser, async (req, res): Promise<void> => {
  try {
    const firmId = (req as AuthRequest).firmId!;
    const idStr = one(req.params.id);
    const id = idStr ? parseInt(idStr, 10) : NaN;
    if (isNaN(id)) { res.status(400).json({ error: "Invalid quotation ID" }); return; }

    const [quotation] = await db.select().from(quotationsTable)
      .where(and(eq(quotationsTable.id, id), eq(quotationsTable.firmId, firmId)));

    if (!quotation) { res.status(404).json({ error: "Quotation not found" }); return; }

    const items = await db.select().from(quotationItemsTable)
      .where(eq(quotationItemsTable.quotationId, id))
      .orderBy(quotationItemsTable.sortOrder);

    res.json({
      ...quotation,
      purchasePrice: quotation.purchasePrice ? parseFloat(quotation.purchasePrice) : null,
      items: items.map(formatItem),
      createdAt: quotation.createdAt.toISOString(),
      updatedAt: quotation.updatedAt.toISOString(),
    });
    return;
  } catch (err) {
    logger.error({ err, path: req.path }, "[quotations]");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
});

router.patch("/quotations/:id", requireAuth, requireFirmUser, async (req, res): Promise<void> => {
  try {
    const firmId = (req as AuthRequest).firmId!;
    const idStr = one(req.params.id);
    const id = idStr ? parseInt(idStr, 10) : NaN;
    if (isNaN(id)) { res.status(400).json({ error: "Invalid quotation ID" }); return; }
    const { items, ...quotationData } = req.body;

    const [existing] = await db.select().from(quotationsTable)
      .where(and(eq(quotationsTable.id, id), eq(quotationsTable.firmId, firmId)));

    if (!existing) { res.status(404).json({ error: "Quotation not found" }); return; }

    const result = await db.transaction(async (tx) => {
      const [updated] = await tx.update(quotationsTable)
        .set(quotationData)
        .where(eq(quotationsTable.id, id))
        .returning();

      if (items && Array.isArray(items)) {
        await tx.delete(quotationItemsTable).where(eq(quotationItemsTable.quotationId, id));
        if (items.length > 0) {
          const itemRows = items.map((item: any, idx: number) => normalizeItem(item, id, idx));
          await tx.insert(quotationItemsTable).values(itemRows);
        }
      }

      const allItems = await tx.select().from(quotationItemsTable)
        .where(eq(quotationItemsTable.quotationId, id))
        .orderBy(quotationItemsTable.sortOrder);

      return {
        ...updated,
        purchasePrice: updated.purchasePrice ? parseFloat(updated.purchasePrice) : null,
        items: allItems.map(formatItem),
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      };
    });

    res.json(result);
    return;
  } catch (err) {
    logger.error({ err, path: req.path }, "[quotations]");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
});

router.delete("/quotations/:id", requireAuth, requireFirmUser, async (req, res): Promise<void> => {
  try {
    const firmId = (req as AuthRequest).firmId!;
    const idStr = one(req.params.id);
    const id = idStr ? parseInt(idStr, 10) : NaN;
    if (isNaN(id)) { res.status(400).json({ error: "Invalid quotation ID" }); return; }

    const [existing] = await db.select().from(quotationsTable)
      .where(and(eq(quotationsTable.id, id), eq(quotationsTable.firmId, firmId)));

    if (!existing) { res.status(404).json({ error: "Quotation not found" }); return; }

    await db.transaction(async (tx) => {
      await tx.delete(quotationItemsTable).where(eq(quotationItemsTable.quotationId, id));
      await tx.delete(quotationsTable).where(eq(quotationsTable.id, id));
    });

    res.json({ success: true });
    return;
  } catch (err) {
    logger.error({ err, path: req.path }, "[quotations]");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
});

router.post("/quotations/:id/duplicate", requireAuth, requireFirmUser, async (req, res): Promise<void> => {
  try {
    const firmId = (req as AuthRequest).firmId!;
    const userId = (req as AuthRequest).userId!;
    const idStr = one(req.params.id);
    const id = idStr ? parseInt(idStr, 10) : NaN;
    if (isNaN(id)) { res.status(400).json({ error: "Invalid quotation ID" }); return; }

    const [original] = await db.select().from(quotationsTable)
      .where(and(eq(quotationsTable.id, id), eq(quotationsTable.firmId, firmId)));

    if (!original) { res.status(404).json({ error: "Quotation not found" }); return; }

    const result = await db.transaction(async (tx) => {
      const [newQuotation] = await tx.insert(quotationsTable).values({
        firmId,
        caseId: original.caseId,
        referenceNo: `${original.referenceNo} (Copy)`,
        stNo: original.stNo,
        clientName: original.clientName,
        propertyDescription: original.propertyDescription,
        purchasePrice: original.purchasePrice,
        bankName: original.bankName,
        loanAmount: original.loanAmount,
        status: "draft",
        notes: original.notes,
        createdBy: userId,
      }).returning();

      const originalItems = await tx.select().from(quotationItemsTable)
        .where(eq(quotationItemsTable.quotationId, id));

      if (originalItems.length > 0) {
        await tx.insert(quotationItemsTable).values(
          originalItems.map(item => ({
            quotationId: newQuotation.id,
            section: item.section,
            category: item.category,
            itemNo: item.itemNo,
            subItemNo: item.subItemNo,
            description: item.description,
            taxCode: item.taxCode,
            amountExclTax: item.amountExclTax,
            taxRate: item.taxRate,
            taxAmount: item.taxAmount,
            amountInclTax: item.amountInclTax,
            sortOrder: item.sortOrder,
          }))
        );
      }

      const items = await tx.select().from(quotationItemsTable)
        .where(eq(quotationItemsTable.quotationId, newQuotation.id))
        .orderBy(quotationItemsTable.sortOrder);

      return {
        ...newQuotation,
        purchasePrice: newQuotation.purchasePrice ? parseFloat(newQuotation.purchasePrice) : null,
        items: items.map(formatItem),
        createdAt: newQuotation.createdAt.toISOString(),
        updatedAt: newQuotation.updatedAt.toISOString(),
      };
    });

    res.status(201).json(result);
    return;
  } catch (err) {
    logger.error({ err, path: req.path }, "[quotations]");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
});

// ── Auto-calculate fees from Malaysian SRO rules ─────────────────────────────

async function getActiveRule(code: string, asOf: string) {
  const [set] = await db.select().from(regulatoryRuleSetsTable).where(eq(regulatoryRuleSetsTable.code, code));
  if (!set) return null;
  const versions = await db.select().from(regulatoryRuleVersionsTable)
    .where(eq(regulatoryRuleVersionsTable.ruleSetId, set.id));
  return versions.find(v => v.effectiveFrom <= asOf && (!v.effectiveTo || v.effectiveTo >= asOf)) || null;
}

router.post("/quotations/:id/auto-calculate", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  try {
    const quotationIdStr = one(req.params.id);
    const quotationId = quotationIdStr ? parseInt(quotationIdStr) : NaN;
    if (isNaN(quotationId)) { res.status(400).json({ error: "Invalid quotation ID" }); return; }
    const firmId = req.firmId!;
    const [q] = await db.select().from(quotationsTable).where(and(eq(quotationsTable.id, quotationId), eq(quotationsTable.firmId, firmId)));
    if (!q) { res.status(404).json({ error: "Quotation not found" }); return; }

    const purchasePrice = parseFloat(String(q.purchasePrice ?? req.body.purchasePrice ?? 0));
    const loanAmount = parseFloat(String(q.loanAmountNum ?? q.loanAmount ?? req.body.loanAmount ?? 0));
    const asOf = new Date().toISOString().slice(0, 10);
    const sstRate = 0.08;

    // Fetch active rule versions
    const [sroSpa, sroLoan, stampMot, stampLoan] = await Promise.all([
      getActiveRule("SRO_SPA", asOf),
      getActiveRule("SRO_LOAN", asOf),
      getActiveRule("STAMP_DUTY_MOT", asOf),
      getActiveRule("STAMP_DUTY_LOAN", asOf),
    ]);

    const systemItems: {
      section: string; description: string; taxCode: string;
      amountExclTax: number; taxRate: number; taxAmount: number; amountInclTax: number;
      isSystemGenerated: boolean; itemType: string; sortOrder: number;
    }[] = [];
    let sortOrder = 0;

    // 1. SRO SPA professional fee
    if (purchasePrice > 0 && sroSpa) {
      const { fee, breakdown } = applyRule(sroSpa.rules as any, purchasePrice);
      const tax = +(fee * sstRate).toFixed(2);
      systemItems.push({
        section: "A", description: `Professional Fee — SPA (SRO 2023, RM${purchasePrice.toLocaleString("en-MY")})`,
        taxCode: "T", amountExclTax: fee, taxRate: sstRate * 100, taxAmount: tax, amountInclTax: fee + tax,
        isSystemGenerated: true, itemType: "professional_fee", sortOrder: sortOrder++,
      });
      // Breakdown note items
      breakdown.forEach(b => {
        systemItems.push({
          section: "A", description: `  ↳ ${b.label}: RM${b.chargeable.toLocaleString("en-MY")} × ${(b.rate * 100).toFixed(1)}% = RM${b.fee.toLocaleString("en-MY")}`,
          taxCode: "NT", amountExclTax: 0, taxRate: 0, taxAmount: 0, amountInclTax: 0,
          isSystemGenerated: true, itemType: "professional_fee", sortOrder: sortOrder++,
        });
      });
    }

    // 2. Stamp Duty on Transfer (MOT)
    if (purchasePrice > 0 && stampMot) {
      const { fee, breakdown } = applyRule(stampMot.rules as any, purchasePrice);
      systemItems.push({
        section: "B", description: `Stamp Duty — Transfer/MOT (RM${purchasePrice.toLocaleString("en-MY")})`,
        taxCode: "NT", amountExclTax: fee, taxRate: 0, taxAmount: 0, amountInclTax: fee,
        isSystemGenerated: true, itemType: "disbursement", sortOrder: sortOrder++,
      });
      breakdown.forEach(b => {
        systemItems.push({
          section: "B", description: `  ↳ ${b.label}: RM${b.chargeable.toLocaleString("en-MY")} × ${(b.rate * 100).toFixed(0)}% = RM${b.fee.toLocaleString("en-MY")}`,
          taxCode: "NT", amountExclTax: 0, taxRate: 0, taxAmount: 0, amountInclTax: 0,
          isSystemGenerated: true, itemType: "disbursement", sortOrder: sortOrder++,
        });
      });
    }

    // 3. SRO Loan professional fee
    if (loanAmount > 0 && sroLoan) {
      const { fee, breakdown } = applyRule(sroLoan.rules as any, loanAmount);
      const tax = +(fee * sstRate).toFixed(2);
      systemItems.push({
        section: "C", description: `Professional Fee — Loan Agreement (SRO 2023, RM${loanAmount.toLocaleString("en-MY")})`,
        taxCode: "T", amountExclTax: fee, taxRate: sstRate * 100, taxAmount: tax, amountInclTax: fee + tax,
        isSystemGenerated: true, itemType: "professional_fee", sortOrder: sortOrder++,
      });
      breakdown.forEach(b => {
        systemItems.push({
          section: "C", description: `  ↳ ${b.label}: RM${b.chargeable.toLocaleString("en-MY")} × ${(b.rate * 100).toFixed(1)}% = RM${b.fee.toLocaleString("en-MY")}`,
          taxCode: "NT", amountExclTax: 0, taxRate: 0, taxAmount: 0, amountInclTax: 0,
          isSystemGenerated: true, itemType: "professional_fee", sortOrder: sortOrder++,
        });
      });
    }

    // 4. Stamp Duty on Loan Agreement
    if (loanAmount > 0 && stampLoan) {
      const { fee } = applyRule(stampLoan.rules as any, loanAmount);
      systemItems.push({
        section: "D", description: `Stamp Duty — Loan Agreement/Charge (RM${loanAmount.toLocaleString("en-MY")})`,
        taxCode: "NT", amountExclTax: fee, taxRate: 0, taxAmount: 0, amountInclTax: fee,
        isSystemGenerated: true, itemType: "disbursement", sortOrder: sortOrder++,
      });
    }

    // Remove existing system-generated items, keep manual ones
    await db.delete(quotationItemsTable).where(
      and(eq(quotationItemsTable.quotationId, quotationId), eq(quotationItemsTable.isSystemGenerated, true))
    );

    // Re-sort non-system items after sortOrder
    const manualItems = await db.select().from(quotationItemsTable).where(eq(quotationItemsTable.quotationId, quotationId)).orderBy(quotationItemsTable.sortOrder);
    for (let i = 0; i < manualItems.length; i++) {
      await db.update(quotationItemsTable).set({ sortOrder: sortOrder + i }).where(eq(quotationItemsTable.id, manualItems[i].id));
    }

    // Insert system items
    if (systemItems.length) {
      await db.insert(quotationItemsTable).values(systemItems.map(i => ({
        quotationId,
        section: i.section,
        description: i.description,
        taxCode: i.taxCode,
        amountExclTax: String(i.amountExclTax),
        taxRate: String(i.taxRate),
        taxAmount: String(i.taxAmount),
        amountInclTax: String(i.amountInclTax),
        isSystemGenerated: i.isSystemGenerated,
        itemType: i.itemType,
        sortOrder: i.sortOrder,
      })));
    }

    const allItems = await db.select().from(quotationItemsTable).where(eq(quotationItemsTable.quotationId, quotationId)).orderBy(quotationItemsTable.sortOrder);
    const totals = {
      subtotal: allItems.reduce((s, i) => s + parseFloat(i.amountExclTax || "0"), 0),
      tax: allItems.reduce((s, i) => s + parseFloat(i.taxAmount || "0"), 0),
      grandTotal: allItems.reduce((s, i) => s + parseFloat(i.amountInclTax || "0"), 0),
    };

    res.json({ items: allItems.map(formatItem), totals, breakdown: { purchasePrice, loanAmount } });
    return;
  } catch (err) {
    logger.error({ err, path: req.path }, "[quotations]");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
});

function formatItem(item: typeof quotationItemsTable.$inferSelect) {
  return {
    ...item,
    amountExclTax: parseFloat(item.amountExclTax || "0"),
    taxRate: parseFloat(item.taxRate || "8"),
    taxAmount: parseFloat(item.taxAmount || "0"),
    amountInclTax: parseFloat(item.amountInclTax || "0"),
    createdAt: item.createdAt.toISOString(),
  };
}

const exportedRouter = expressRouter as unknown as ExpressRouter;
export { exportedRouter as router };
export default exportedRouter;
