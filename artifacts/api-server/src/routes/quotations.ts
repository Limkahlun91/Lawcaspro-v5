import express, { type Router as ExpressRouter, type Response } from "express";
import { eq, desc, and, count, inArray, isNull } from "drizzle-orm";
import { db, quotationItemsTable, quotationsTable, regulatoryRuleSetsTable, regulatoryRuleVersionsTable, sql } from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest, writeAuditLog } from "../lib/auth.js";
import { applyRule } from "./regulatory.js";
import { logger } from "../lib/logger.js";
import { requireUserFeatureAccess } from "../services/user-feature-access.js";

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

const ALLOWED_QUOTATION_STATUSES = ["draft", "sent", "accepted", "rejected"] as const;
type AllowedQuotationStatus = typeof ALLOWED_QUOTATION_STATUSES[number];

const REQUIRED_RULE_KEYS = ["SRO_SPA", "SRO_LOAN", "STAMP_DUTY_MOT", "STAMP_DUTY_LOAN"] as const;

function parseIncludeItems(raw: string | undefined): boolean | { error: string } {
  if (raw === undefined) return true;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return { error: "invalid_include_items" };
}

function parseStatusCsv(raw: string | undefined): AllowedQuotationStatus[] | { error: string; unknown: string[] } {
  if (!raw) return [];
  const tokens = String(raw).split(",").map(s => s.trim()).filter(Boolean);
  const allowed = new Set<string>(ALLOWED_QUOTATION_STATUSES);
  const unknown: string[] = [];
  const result: AllowedQuotationStatus[] = [];
  for (const t of tokens) {
    if (allowed.has(t)) {
      result.push(t as AllowedQuotationStatus);
    } else {
      unknown.push(t);
    }
  }
  if (unknown.length > 0) return { error: "invalid_status", unknown };
  return result;
}

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

async function fetchQuotationsWithAggregates(
  firmId: number,
  opts: {
    caseId?: number;
    statuses: AllowedQuotationStatus[];
    includeItems: boolean;
    limit: number;
    offset: number;
    q?: string;
    allowDeleted?: boolean;
  }
) {
  const { caseId, statuses, includeItems, limit, offset, q, allowDeleted } = opts;

  const where = [eq(quotationsTable.firmId, firmId)];
  if (!allowDeleted) where.push(isNull(quotationsTable.deletedAt));
  if (caseId) where.push(eq(quotationsTable.caseId, caseId));
  if (statuses.length > 0) where.push(inArray(quotationsTable.status, statuses));
  if (q) {
    const search = `%${q}%`;
    where.push(sql`(${quotationsTable.referenceNo} ILIKE ${search} OR ${quotationsTable.clientName} ILIKE ${search})`);
  }
  const whereClause = where.length === 1 ? where[0]! : and(...where);

  const totalResult = await db
    .select({ value: count() })
    .from(quotationsTable)
    .where(whereClause);
  const total = Number(totalResult[0]?.value ?? 0);

  const rows = await db.select().from(quotationsTable)
    .where(whereClause)
    .orderBy(desc(quotationsTable.createdAt))
    .limit(limit)
    .offset(offset);

  const qIds = rows.map(r => r.id);
  const results: any[] = rows.map(q => ({
    ...q,
    purchasePrice: q.purchasePrice ? parseFloat(q.purchasePrice) : null,
    taxRate: q.taxRate ? parseFloat(q.taxRate) : DEFAULT_TAX_RATE,
    createdAt: q.createdAt.toISOString(),
    updatedAt: q.updatedAt.toISOString(),
    itemCount: 0,
    totalExclTax: 0,
    totalTax: 0,
    totalInclTax: 0,
  }));

  if (includeItems && qIds.length > 0) {
    const itemCountsRaw = await db
      .select({ quotationId: quotationItemsTable.quotationId, count: count() })
      .from(quotationItemsTable)
      .where(inArray(quotationItemsTable.quotationId, qIds))
      .groupBy(quotationItemsTable.quotationId);
    const itemCountById = new Map<number, number>();
    for (const r of itemCountsRaw) itemCountById.set(r.quotationId, Number(r.count || 0));

    const allItems = await db.select().from(quotationItemsTable)
      .where(inArray(quotationItemsTable.quotationId, qIds));
    const itemsById = new Map<number, any[]>();
    for (const it of allItems) {
      if (!itemsById.has(it.quotationId)) itemsById.set(it.quotationId, []);
      itemsById.get(it.quotationId)!.push(it);
    }

    for (const r of results) {
      const items = itemsById.get(r.id) || [];
      r.itemCount = itemCountById.get(r.id) || 0;
      r.totalExclTax = items.reduce((s, i) => s + parseFloat(i.amountExclTax || "0"), 0);
      r.totalTax = items.reduce((s, i) => s + parseFloat(i.taxAmount || "0"), 0);
      r.totalInclTax = items.reduce((s, i) => s + parseFloat(i.amountInclTax || "0"), 0);
    }
  }

  return { results, total };
}

router.get("/quotations", requireAuth, requireFirmUser, requireUserFeatureAccess("accounting.quotation"), requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const firmId = req.firmId!;
    const caseIdStr = one((req.query as any)?.caseId);
    const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
    if (caseIdStr && (!Number.isInteger(caseId) || caseId <= 0)) {
      res.status(400).json({ error: "Invalid caseId" });
      return;
    }
    const statusRaw = one((req.query as any)?.status);
    const statusParse = parseStatusCsv(statusRaw);
    if ("error" in statusParse) {
      res.status(400).json({ error: statusParse.error, unknown: statusParse.unknown });
      return;
    }
    const statuses = statusParse;

    const includeItemsRaw = one((req.query as any)?.includeItems);
    const includeItemsParse = parseIncludeItems(includeItemsRaw);
    if (typeof includeItemsParse === "object" && "error" in includeItemsParse) {
      res.status(400).json({ error: includeItemsParse.error });
      return;
    }
    const includeItems = includeItemsParse as boolean;

    const qRaw = one((req.query as any)?.q);
    const q = qRaw ? String(qRaw).trim() : undefined;

    const paginatedRaw = one((req.query as any)?.paginated);
    const paginated = paginatedRaw === "true" || paginatedRaw === "1";

    const limitRaw = one((req.query as any)?.limit);
    const pageRaw = one((req.query as any)?.page);
    const offsetRaw = one((req.query as any)?.offset);

    const limit = limitRaw ? parseInt(limitRaw, 10) : NaN;
    const page = pageRaw ? parseInt(pageRaw, 10) : NaN;
    const offset = offsetRaw ? parseInt(offsetRaw, 10) : NaN;

    let finalLimit: number;
    let finalOffset: number;

    if (paginated) {
      finalLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 30;
      if (Number.isInteger(page) && page >= 1) {
        finalOffset = (page - 1) * finalLimit;
      } else {
        finalOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
      }
    } else {
      finalLimit = Number.isInteger(limit) && limit > 0
        ? Math.min(limit, 200)
        : 30;
      finalOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
    }

    const { results, total } = await fetchQuotationsWithAggregates(firmId, {
      caseId: caseIdStr ? caseId : undefined,
      statuses,
      includeItems,
      limit: finalLimit,
      offset: finalOffset,
      q,
    });

    if (paginated) {
      const currentPage = Number.isInteger(page) && page >= 1 ? page : Math.floor(finalOffset / finalLimit) + 1;
      const hasMore = finalOffset + results.length < total;
      res.json({
        rows: results,
        total,
        page: currentPage,
        limit: finalLimit,
        hasMore,
      });
    } else {
      res.json(results);
    }
    return;
  } catch (err) {
    logger.error({ err, path: req.path }, "[quotations]");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
});

router.get("/quotations/all", requireAuth, requireFirmUser, requireUserFeatureAccess("accounting.quotation"), requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const firmId = req.firmId!;
    const caseIdStr = one((req.query as any)?.caseId);
    const caseId = caseIdStr ? parseInt(caseIdStr, 10) : NaN;
    if (caseIdStr && (!Number.isInteger(caseId) || caseId <= 0)) {
      res.status(400).json({ error: "Invalid caseId" });
      return;
    }
    const statusRaw = one((req.query as any)?.status);
    const statusParse = parseStatusCsv(statusRaw);
    if ("error" in statusParse) {
      res.status(400).json({ error: statusParse.error, unknown: statusParse.unknown });
      return;
    }
    const statuses = statusParse;

    const includeItemsRaw = one((req.query as any)?.includeItems);
    const includeItemsParse = parseIncludeItems(includeItemsRaw);
    if (typeof includeItemsParse === "object" && "error" in includeItemsParse) {
      res.status(400).json({ error: includeItemsParse.error });
      return;
    }
    const includeItems = includeItemsParse as boolean;

    const limitRaw = one((req.query as any)?.limit);
    const offsetRaw = one((req.query as any)?.offset);
    const limit = limitRaw ? parseInt(limitRaw, 10) : NaN;
    const offset = offsetRaw ? parseInt(offsetRaw, 10) : NaN;
    const finalLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 5000) : 5000;
    const finalOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;

    const { results, total } = await fetchQuotationsWithAggregates(firmId, {
      caseId: caseIdStr ? caseId : undefined,
      statuses,
      includeItems,
      limit: finalLimit,
      offset: finalOffset,
    });

    const hasMore = finalOffset + results.length < total;
    res.json({
      rows: results,
      total,
      offset: finalOffset,
      limit: finalLimit,
      hasMore,
    });
    return;
  } catch (err) {
    logger.error({ err, path: req.path }, "[quotations/all]");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
});

router.post("/quotations", requireAuth, requireFirmUser, requireUserFeatureAccess("accounting.quotation"), requirePermission("accounting", "create"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const firmId = req.firmId!;
    const userId = req.userId!;
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

    const result = await db.transaction(async (tx) => {
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

    try {
      await writeAuditLog({
        firmId, actorId: userId, actorType: req.userType,
        action: "accounting.quotation.create",
        entityType: "quotation", entityId: result.id,
        detail: `ref=${result.referenceNo ?? ""};client=${finalClientName};items=${result.items.length}`,
        ipAddress: req.ip, userAgent: req.headers["user-agent"],
      });
    } catch (_) { /* audit failure should not block user response */ }

    res.status(201).json(result);
    return;
  } catch (err) {
    logger.error({ err, path: req.path }, "[quotations]");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
});

router.get("/quotations/:id", requireAuth, requireFirmUser, requirePermission("accounting", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
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

router.patch("/quotations/:id", requireAuth, requireFirmUser, requirePermission("accounting", "edit"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const firmId = req.firmId!;
    const userId = req.userId!;
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

    const [existing] = await db.select().from(quotationsTable)
      .where(and(eq(quotationsTable.id, id), eq(quotationsTable.firmId, firmId)));

    if (!existing) { res.status(404).json({ error: "Quotation not found" }); return; }

    const nextTaxRate = normalizeQuotationTaxRate(taxRate ?? (existing as any).taxRate);
    const normalizedClientDetails = normalizeClientDetails(clientDetails ?? client_details);
    const derivedClientName = normalizedClientDetails.length > 0 ? joinClientNames(normalizedClientDetails) : "";

    const result = await db.transaction(async (tx) => {
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

    try {
      const itemsDiff = items !== undefined ? `;items=${result.items.length}` : "";
      const refChange = existing.referenceNo !== result.referenceNo ? `;ref=${existing.referenceNo ?? ""}→${result.referenceNo ?? ""}` : "";
      await writeAuditLog({
        firmId, actorId: userId, actorType: req.userType,
        action: "accounting.quotation.update",
        entityType: "quotation", entityId: id,
        detail: `client=${result.clientName ?? ""}${refChange}${itemsDiff}`,
        ipAddress: req.ip, userAgent: req.headers["user-agent"],
      });
    } catch (_) { /* audit failure should not block user response */ }

    res.json(result);
    return;
  } catch (err) {
    logger.error({ err, path: req.path }, "[quotations]");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
});

router.delete("/quotations/:id", requireAuth, requireFirmUser, requirePermission("accounting", "write"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const firmId = req.firmId!;
    const userId = req.userId!;
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

    try {
      await writeAuditLog({
        firmId, actorId: userId, actorType: req.userType,
        action: "accounting.quotation.delete",
        entityType: "quotation", entityId: id,
        detail: `ref=${existing.referenceNo ?? ""};client=${existing.clientName ?? ""}`,
        ipAddress: req.ip, userAgent: req.headers["user-agent"],
      });
    } catch (_) { /* audit failure should not block user response */ }

    res.json({ success: true });
    return;
  } catch (err) {
    logger.error({ err, path: req.path }, "[quotations]");
    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
});

router.post("/quotations/:id/duplicate", requireAuth, requireFirmUser, requirePermission("accounting", "create"), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const firmId = req.firmId!;
    const userId = req.userId!;
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

    try {
      await writeAuditLog({
        firmId, actorId: userId, actorType: req.userType,
        action: "accounting.quotation.duplicate",
        entityType: "quotation", entityId: result.id,
        detail: `fromId=${id};fromRef=${original.referenceNo ?? ""};newRef=${result.referenceNo ?? ""};items=${result.items.length}`,
        ipAddress: req.ip, userAgent: req.headers["user-agent"],
      });
    } catch (_) { /* audit failure should not block user response */ }

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

router.post("/quotations/:id/auto-calculate", requireAuth, requireFirmUser, requirePermission("accounting", "edit"), async (req: AuthRequest, res: Response): Promise<void> => {
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

    const ruleResult = await Promise.all(REQUIRED_RULE_KEYS.map(async (key) => ({
      key,
      rule: await getActiveRule(key, asOf),
    })));

    const missing: string[] = [];
    const ruleMap: Record<string, any> = {};
    for (const { key, rule } of ruleResult) {
      if (!rule) {
        missing.push(key);
      } else {
        ruleMap[key] = rule;
      }
    }
    if (missing.length > 0) {
      res.status(409).json({
        error: "RULE_CONFIGURATION_MISSING",
        missing,
        message: `Required regulatory rules are not configured: ${missing.join(", ")}`,
      });
      return;
    }

    const sroSpa = ruleMap["SRO_SPA"];
    const sroLoan = ruleMap["SRO_LOAN"];
    const stampMot = ruleMap["STAMP_DUTY_MOT"];
    const stampLoan = ruleMap["STAMP_DUTY_LOAN"];

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

    const generated = systemItems.length;
    const emptyLegitimate = generated === 0 && (purchasePrice <= 0 || loanAmount <= 0);

    try {
      await writeAuditLog({
        firmId: firmId, actorId: req.userId!, actorType: req.userType,
        action: "accounting.quotation.auto_calculate",
        entityType: "quotation", entityId: quotationId,
        detail: `purchase=${purchasePrice.toFixed(2)};loan=${loanAmount.toFixed(2)};systemItems=${systemItems.length};items=${allItems.length};grand=${totals.grandTotal.toFixed(2)};emptyLegitimate=${emptyLegitimate}`,
        ipAddress: req.ip, userAgent: req.headers["user-agent"],
      });
    } catch (_) { /* audit failure should not block user response */ }

    res.json({
      items: allItems.map(formatItem),
      totals,
      breakdown: { purchasePrice, loanAmount },
      generated,
      emptyLegitimate,
    });
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

export {
  ALLOWED_QUOTATION_STATUSES,
  REQUIRED_RULE_KEYS,
  parseIncludeItems,
  parseStatusCsv,
};
