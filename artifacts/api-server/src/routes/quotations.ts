import { Router, type IRouter } from "express";
import { eq, desc, and, count } from "drizzle-orm";
import { db, quotationsTable, quotationItemsTable } from "@workspace/db";
import { requireAuth, requireFirmUser, type AuthRequest } from "../lib/auth";

const router: IRouter = Router();

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

router.get("/quotations", requireAuth, requireFirmUser, async (req, res) => {
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
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/quotations", requireAuth, requireFirmUser, async (req, res) => {
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
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/quotations/:id", requireAuth, requireFirmUser, async (req, res) => {
  try {
    const firmId = (req as AuthRequest).firmId!;
    const id = parseInt(req.params.id, 10);

    const [quotation] = await db.select().from(quotationsTable)
      .where(and(eq(quotationsTable.id, id), eq(quotationsTable.firmId, firmId)));

    if (!quotation) return res.status(404).json({ error: "Quotation not found" });

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
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/quotations/:id", requireAuth, requireFirmUser, async (req, res) => {
  try {
    const firmId = (req as AuthRequest).firmId!;
    const id = parseInt(req.params.id, 10);
    const { items, ...quotationData } = req.body;

    const [existing] = await db.select().from(quotationsTable)
      .where(and(eq(quotationsTable.id, id), eq(quotationsTable.firmId, firmId)));

    if (!existing) return res.status(404).json({ error: "Quotation not found" });

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
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/quotations/:id", requireAuth, requireFirmUser, async (req, res) => {
  try {
    const firmId = (req as AuthRequest).firmId!;
    const id = parseInt(req.params.id, 10);

    const [existing] = await db.select().from(quotationsTable)
      .where(and(eq(quotationsTable.id, id), eq(quotationsTable.firmId, firmId)));

    if (!existing) return res.status(404).json({ error: "Quotation not found" });

    await db.transaction(async (tx) => {
      await tx.delete(quotationItemsTable).where(eq(quotationItemsTable.quotationId, id));
      await tx.delete(quotationsTable).where(eq(quotationsTable.id, id));
    });

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/quotations/:id/duplicate", requireAuth, requireFirmUser, async (req, res) => {
  try {
    const firmId = (req as AuthRequest).firmId!;
    const userId = (req as AuthRequest).userId!;
    const id = parseInt(req.params.id, 10);

    const [original] = await db.select().from(quotationsTable)
      .where(and(eq(quotationsTable.id, id), eq(quotationsTable.firmId, firmId)));

    if (!original) return res.status(404).json({ error: "Quotation not found" });

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
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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

export default router;
