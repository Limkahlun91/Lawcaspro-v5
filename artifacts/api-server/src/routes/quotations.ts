import express, { type Router as ExpressRouter } from "express";
import { eq, desc, and, count } from "drizzle-orm";
import { db, quotationItemsTable, quotationsTable, regulatoryRuleSetsTable, regulatoryRuleVersionsTable, sql } from "@workspace/db";
import { requireAuth, requireFirmUser, requireRlsDb, type AuthRequest } from "../lib/auth.js";
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
  const code = String(taxCode || "").trim().toUpperCase();
  if (code === "Z" || code === "ZR" || code === "O" || code === "NT" || amountExclTax === 0) {
    return { taxAmount: 0, amountInclTax: amountExclTax };
  }
  const taxAmount = Math.round(amountExclTax * taxRate) / 100;
  return { taxAmount, amountInclTax: amountExclTax + taxAmount };
}

function normalizeQuotationTaxRate(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TAX_RATE;
}

type QuotationClientDetail = { name: string; tin?: string };

function normalizeClientDetails(v: unknown): QuotationClientDetail[] {
  if (!Array.isArray(v)) return [];
  const out: QuotationClientDetail[] = [];
  for (const row of v) {
    if (!row || typeof row !== "object") continue;
    const name = typeof (row as any).name === "string" ? (row as any).name.trim() : "";
    if (!name) continue;
    const tinRaw = (row as any).tin;
    const tin = typeof tinRaw === "string" && tinRaw.trim() ? tinRaw.trim() : undefined;
    out.push({ name, ...(tin ? { tin } : {}) });
  }
  return out;
}

function joinClientNames(details: QuotationClientDetail[]): string {
  return details.map((d) => d.name).filter(Boolean).join(" & ");
}

function normalizeItem(item: any, quotationId: number, idx: number, defaultTaxRate: number) {
  const amountExclTax = parseFloat(item.amountExclTax) || 0;
  const taxCode = item.taxCode || "T";
  const code = String(taxCode || "").trim().toUpperCase();
  const taxRate = (code === "Z" || code === "ZR" || code === "O" || code === "NT") ? 0 : defaultTaxRate;
  const { taxAmount, amountInclTax } = computeTax(amountExclTax, taxCode, taxRate);
  const section = typeof item.section === "string" ? item.section : "disbursement";
  const itemCategory =
    item.itemCategory === "fee" || item.itemCategory === "disbursement"
      ? item.itemCategory
      : section === "fees"
        ? "fee"
        : "disbursement";
  const itemType =
    typeof item.itemType === "string" && item.itemType
      ? item.itemType
      : itemCategory === "fee"
        ? "professional_fee"
        : "disbursement";

  return {
    quotationId,
    section,
    category: item.category || null,
    itemNo: item.itemNo || null,
    subItemNo: item.subItemNo || null,
    description: item.description,
    taxCode,
    itemCategory,
    itemType,
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
    const rlsDb = (req as AuthRequest).rlsDb ?? db;
    const caseIdStr = one((req.query as any)?.caseId);
    const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
    if (caseIdStr && (!Number.isInteger(caseId) || caseId <= 0)) {
      res.status(400).json({ error: "Invalid caseId" });
      return;
    }
    const where = caseIdStr
      ? and(eq(quotationsTable.firmId, firmId), eq(quotationsTable.caseId, caseId))
      : eq(quotationsTable.firmId, firmId);
    const rows = await rlsDb.select().from(quotationsTable)
      .where(where)
      .orderBy(desc(quotationsTable.createdAt));

    const results = await Promise.all(rows.map(async (q) => {
      const [itemCount] = await rlsDb.select({ count: count() }).from(quotationItemsTable)
        .where(eq(quotationItemsTable.quotationId, q.id));

      const items = await rlsDb.select().from(quotationItemsTable)
        .where(eq(quotationItemsTable.quotationId, q.id));

      const totalExclTax = items.reduce((sum, i) => sum + parseFloat(i.amountExclTax || "0"), 0);
      const totalTax = items.reduce((sum, i) => sum + parseFloat(i.taxAmount || "0"), 0);
      const totalInclTax = items.reduce((sum, i) => sum + parseFloat(i.amountInclTax || "0"), 0);

      return {
        ...q,
        purchasePrice: q.purchasePrice ? parseFloat(q.purchasePrice) : null,
        taxRate: q.taxRate ? parseFloat(q.taxRate) : DEFAULT_TAX_RATE,
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
    const rlsDb = (req as AuthRequest).rlsDb ?? db;
    const {
      items,
      taxRate,
      clientDetails,
      client_details,
      clientName,
      clientTin,
      ...quotationData
    } = req.body ?? {};
    const taxRateNum = normalizeQuotationTaxRate(taxRate);

    const normalizedClientDetails = (() => {
      const details = normalizeClientDetails(clientDetails ?? client_details);
      if (details.length > 0) return details;
      const legacyName = typeof clientName === "string" ? clientName.trim() : "";
      const legacyTin = typeof clientTin === "string" ? clientTin.trim() : "";
      if (!legacyName) return [];
      return [{ name: legacyName, ...(legacyTin ? { tin: legacyTin } : {}) }];
    })();
    const derivedClientName = joinClientNames(normalizedClientDetails);
    const finalClientName = derivedClientName || (typeof clientName === "string" ? clientName.trim() : "");
    if (!finalClientName) { res.status(400).json({ error: "clientName or clientDetails is required" }); return; }

    const result = await rlsDb.transaction(async (tx) => {
      const [quotation] = await tx.insert(quotationsTable).values({
        ...quotationData,
        clientName: finalClientName,
        clientDetails: normalizedClientDetails,
        taxRate: String(taxRateNum),
        firmId,
        createdBy: userId,
      }).returning();

      if (items && Array.isArray(items) && items.length > 0) {
        const itemRows = items.map((item: any, idx: number) => normalizeItem(item, quotation.id, idx, taxRateNum));
        await tx.insert(quotationItemsTable).values(itemRows);
      }

      const allItems = await tx.select().from(quotationItemsTable)
        .where(eq(quotationItemsTable.quotationId, quotation.id))
        .orderBy(quotationItemsTable.sortOrder);

      return {
        ...quotation,
        purchasePrice: quotation.purchasePrice ? parseFloat(quotation.purchasePrice) : null,
        taxRate: quotation.taxRate ? parseFloat(quotation.taxRate) : taxRateNum,
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
    const rlsDb = (req as AuthRequest).rlsDb ?? db;
    const idStr = one(req.params.id);
    const id = idStr ? parseInt(idStr, 10) : NaN;
    if (isNaN(id)) { res.status(400).json({ error: "Invalid quotation ID" }); return; }

    const [quotation] = await rlsDb.select().from(quotationsTable)
      .where(and(eq(quotationsTable.id, id), eq(quotationsTable.firmId, firmId)));

    if (!quotation) { res.status(404).json({ error: "Quotation not found" }); return; }

    const items = await rlsDb.select().from(quotationItemsTable)
      .where(eq(quotationItemsTable.quotationId, id))
      .orderBy(quotationItemsTable.sortOrder);

    res.json({
      ...quotation,
      purchasePrice: quotation.purchasePrice ? parseFloat(quotation.purchasePrice) : null,
      taxRate: quotation.taxRate ? parseFloat(quotation.taxRate) : DEFAULT_TAX_RATE,
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
    const rlsDb = (req as AuthRequest).rlsDb ?? db;
    const idStr = one(req.params.id);
    const id = idStr ? parseInt(idStr, 10) : NaN;
    if (isNaN(id)) { res.status(400).json({ error: "Invalid quotation ID" }); return; }
    const {
      items,
      taxRate,
      clientDetails,
      client_details,
      clientName,
      clientTin,
      ...quotationData
    } = req.body ?? {};

    const [existing] = await rlsDb.select().from(quotationsTable)
      .where(and(eq(quotationsTable.id, id), eq(quotationsTable.firmId, firmId)));
    if (!existing) { res.status(404).json({ error: "Quotation not found" }); return; }

    const nextTaxRate = normalizeQuotationTaxRate(taxRate ?? (existing as any).taxRate);
    const normalizedClientDetails = normalizeClientDetails(clientDetails ?? client_details);
    const derivedClientName = normalizedClientDetails.length > 0 ? joinClientNames(normalizedClientDetails) : "";

    const result = await rlsDb.transaction(async (tx) => {
      const updateData: Record<string, unknown> = { ...quotationData, taxRate: String(nextTaxRate) };
      if (normalizedClientDetails.length > 0) {
        updateData.clientDetails = normalizedClientDetails;
        updateData.clientName = derivedClientName;
      } else if (typeof clientName === "string" && clientName.trim()) {
        updateData.clientName = clientName.trim();
        const legacyTin = typeof clientTin === "string" ? clientTin.trim() : "";
        updateData.clientDetails = [{ name: clientName.trim(), ...(legacyTin ? { tin: legacyTin } : {}) }];
      }

      const [updated] = await tx.update(quotationsTable)
        .set(updateData)
        .where(eq(quotationsTable.id, id))
        .returning();

      if (items && Array.isArray(items)) {
        await tx.delete(quotationItemsTable).where(eq(quotationItemsTable.quotationId, id));
        if (items.length > 0) {
          const itemRows = items.map((item: any, idx: number) => normalizeItem(item, id, idx, nextTaxRate));
          await tx.insert(quotationItemsTable).values(itemRows);
        }
      }

      const allItems = await tx.select().from(quotationItemsTable)
        .where(eq(quotationItemsTable.quotationId, id))
        .orderBy(quotationItemsTable.sortOrder);

      return {
        ...updated,
        purchasePrice: updated.purchasePrice ? parseFloat(updated.purchasePrice) : null,
        taxRate: updated.taxRate ? parseFloat(updated.taxRate) : nextTaxRate,
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
    const rlsDb = (req as AuthRequest).rlsDb ?? db;
    const idStr = one(req.params.id);
    const id = idStr ? parseInt(idStr, 10) : NaN;
    if (isNaN(id)) { res.status(400).json({ error: "Invalid quotation ID" }); return; }

    const [existing] = await rlsDb.select().from(quotationsTable)
      .where(and(eq(quotationsTable.id, id), eq(quotationsTable.firmId, firmId)));

    if (!existing) { res.status(404).json({ error: "Quotation not found" }); return; }

    await rlsDb.transaction(async (tx) => {
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
    const rlsDb = (req as AuthRequest).rlsDb ?? db;
    const idStr = one(req.params.id);
    const id = idStr ? parseInt(idStr, 10) : NaN;
    if (isNaN(id)) { res.status(400).json({ error: "Invalid quotation ID" }); return; }

    const [original] = await rlsDb.select().from(quotationsTable)
      .where(and(eq(quotationsTable.id, id), eq(quotationsTable.firmId, firmId)));

    if (!original) { res.status(404).json({ error: "Quotation not found" }); return; }

    const result = await rlsDb.transaction(async (tx) => {
      const [newQuotation] = await tx.insert(quotationsTable).values({
        firmId,
        caseId: original.caseId,
        referenceNo: `${original.referenceNo} (Copy)`,
        clientName: original.clientName,
        clientDetails: (original as any).clientDetails ?? [],
        clientAddress: (original as any).clientAddress ?? null,
        clientTin: (original as any).clientTin ?? null,
        propertyDescription: original.propertyDescription,
        purchasePrice: original.purchasePrice,
        bankName: original.bankName,
        loanAmount: original.loanAmount,
        taxRate: (original as any).taxRate ?? String(DEFAULT_TAX_RATE),
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
            itemCategory: item.itemCategory,
            itemType: item.itemType,
            amountExclTax: item.amountExclTax,
            taxRate: item.taxRate,
            taxAmount: item.taxAmount,
            amountInclTax: item.amountInclTax,
            isSystemGenerated: item.isSystemGenerated,
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
        taxRate: (newQuotation as any).taxRate ? parseFloat(String((newQuotation as any).taxRate)) : DEFAULT_TAX_RATE,
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

router.post("/quotations/:id/auto-calculate", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  try {
    const quotationIdStr = one(req.params.id);
    const quotationId = quotationIdStr ? parseInt(quotationIdStr, 10) : NaN;
    if (isNaN(quotationId)) { res.status(400).json({ error: "Invalid quotation ID" }); return; }
    const firmId = req.firmId!;
    const rlsDb = requireRlsDb(req);

    const result = await rlsDb.transaction(async (tx) => {
      const [q] = await tx.select().from(quotationsTable).where(and(eq(quotationsTable.id, quotationId), eq(quotationsTable.firmId, firmId)));
      if (!q) {
        const e = new Error("Quotation not found") as any;
        e.status = 404;
        throw e;
      }

      const purchasePrice = parseFloat(String(q.purchasePrice ?? req.body.purchasePrice ?? 0));
      const loanAmount = parseFloat(String((q as any).loanAmountNum ?? q.loanAmount ?? req.body.loanAmount ?? 0));
      const asOf = new Date().toISOString().slice(0, 10);
      const sstRate = 0.08;

      const getActiveRuleTx = async (code: string, asOfDate: string) => {
        const [set] = await tx.select().from(regulatoryRuleSetsTable).where(eq(regulatoryRuleSetsTable.code, code));
        if (!set) return null;
        const versions = await tx.select().from(regulatoryRuleVersionsTable).where(eq(regulatoryRuleVersionsTable.ruleSetId, set.id));
        return versions.find((v: any) => v.effectiveFrom <= asOfDate && (!v.effectiveTo || v.effectiveTo >= asOfDate)) || null;
      };

      const [sroSpa, sroLoan, stampMot, stampLoan] = await Promise.all([
        getActiveRuleTx("SRO_SPA", asOf),
        getActiveRuleTx("SRO_LOAN", asOf),
        getActiveRuleTx("STAMP_DUTY_MOT", asOf),
        getActiveRuleTx("STAMP_DUTY_LOAN", asOf),
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

      await tx.delete(quotationItemsTable).where(
        and(eq(quotationItemsTable.quotationId, quotationId), eq(quotationItemsTable.isSystemGenerated, true))
      );

      const manualItems = await tx.select().from(quotationItemsTable).where(eq(quotationItemsTable.quotationId, quotationId)).orderBy(quotationItemsTable.sortOrder);
      for (let i = 0; i < manualItems.length; i++) {
        await tx.update(quotationItemsTable).set({ sortOrder: sortOrder + i }).where(eq(quotationItemsTable.id, manualItems[i].id));
      }

      if (systemItems.length) {
        await tx.insert(quotationItemsTable).values(systemItems.map(i => ({
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

      const allItems = await tx.select().from(quotationItemsTable).where(eq(quotationItemsTable.quotationId, quotationId)).orderBy(quotationItemsTable.sortOrder);
      const totals = {
        subtotal: allItems.reduce((s, i) => s + parseFloat(i.amountExclTax || "0"), 0),
        tax: allItems.reduce((s, i) => s + parseFloat(i.taxAmount || "0"), 0),
        grandTotal: allItems.reduce((s, i) => s + parseFloat(i.amountInclTax || "0"), 0),
      };

      return { allItems, totals, breakdown: { purchasePrice, loanAmount } };
    });

    res.json({ items: result.allItems.map(formatItem), totals: result.totals, breakdown: result.breakdown });
    return;
  } catch (err) {
    const status = (err as any)?.status && Number.isInteger((err as any).status) ? Number((err as any).status) : 500;
    logger.error({ err, path: req.path }, "[quotations]");
    res.status(status).json({ error: status === 500 ? "Internal Server Error" : String((err as any)?.message ?? "Internal Server Error") });
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
