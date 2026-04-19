import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  caseAssignmentsTable,
  casePartiesTable,
  casePurchasersTable,
  casesTable,
  clientsTable,
  developersTable,
  sql,
  partiesTable,
  projectsTable,
  usersTable,
  caseKeyDatesTable,
  quotationsTable,
  invoicesTable,
} from "@workspace/db";
import { requireAuth, requireFirmUser, type AuthRequest, writeAuditLog } from "../lib/auth";

const router: IRouter = Router();

const listQuerySchema = z.object({
  q: z.string().trim().optional().default(""),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

type DbConn = typeof db | NonNullable<AuthRequest["rlsDb"]>;
const rdb = (req: AuthRequest): DbConn => req.rlsDb ?? db;

function parseJsonObject(s: string | null): Record<string, unknown> | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    return v as Record<string, unknown>;
  } catch {
    return null;
  }
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function firstNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

router.get("/case-files", requireAuth, requireFirmUser, async (req: AuthRequest, res): Promise<void> => {
  const r = rdb(req);
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query" });
    return;
  }

  const { q: rawQ, page, limit } = parsed.data;
  const q = rawQ.trim();
  const offset = (page - 1) * limit;
  const like = `%${q}%`;

  const whereBase = and(
    eq(casesTable.firmId, req.firmId!),
    sql`${casesTable.deletedAt} IS NULL`,
  );

  const whereSearch = q
    ? sql`(
      ${casesTable.referenceNo} ILIKE ${like}
      OR ${projectsTable.name} ILIKE ${like}
      OR ${developersTable.name} ILIKE ${like}
      OR COALESCE(${casesTable.parcelNo}, '') ILIKE ${like}
      OR COALESCE(${casesTable.loanDetails}, '') ILIKE ${like}
      OR COALESCE(${casesTable.propertyDetails}, '') ILIKE ${like}
      OR EXISTS (
        SELECT 1
        FROM ${casePurchasersTable} cp
        JOIN ${clientsTable} cl ON cp.client_id = cl.id
        WHERE cp.case_id = ${casesTable.id}
          AND cl.firm_id = ${casesTable.firmId}
          AND (cl.name ILIKE ${like} OR COALESCE(cl.ic_no, '') ILIKE ${like})
      )
      OR EXISTS (
        SELECT 1
        FROM ${casePartiesTable} cpt
        JOIN ${partiesTable} p ON cpt.party_id = p.id
        WHERE cpt.case_id = ${casesTable.id}
          AND cpt.firm_id = ${casesTable.firmId}
          AND (
            p.full_name ILIKE ${like}
            OR COALESCE(p.nric, '') ILIKE ${like}
            OR COALESCE(p.passport_no, '') ILIKE ${like}
            OR COALESCE(p.company_reg_no, '') ILIKE ${like}
          )
      )
      OR EXISTS (
        SELECT 1
        FROM ${caseAssignmentsTable} ca
        JOIN ${usersTable} u ON ca.user_id = u.id
        WHERE ca.case_id = ${casesTable.id}
          AND ca.unassigned_at IS NULL
          AND u.name ILIKE ${like}
      )
    )`
    : undefined;

  const where = whereSearch ? and(whereBase, whereSearch) : whereBase;

  const lawyerNameSql = sql<string | null>`(
    SELECT ${usersTable.name}
    FROM ${caseAssignmentsTable}
    JOIN ${usersTable} ON ${caseAssignmentsTable.userId} = ${usersTable.id}
    WHERE ${caseAssignmentsTable.caseId} = ${casesTable.id}
      AND ${caseAssignmentsTable.roleInCase} = 'lawyer'
      AND ${caseAssignmentsTable.unassignedAt} IS NULL
    ORDER BY ${caseAssignmentsTable.assignedAt} DESC
    LIMIT 1
  )`;
  const clerkNameSql = sql<string | null>`(
    SELECT ${usersTable.name}
    FROM ${caseAssignmentsTable}
    JOIN ${usersTable} ON ${caseAssignmentsTable.userId} = ${usersTable.id}
    WHERE ${caseAssignmentsTable.caseId} = ${casesTable.id}
      AND ${caseAssignmentsTable.roleInCase} = 'clerk'
      AND ${caseAssignmentsTable.unassignedAt} IS NULL
    ORDER BY ${caseAssignmentsTable.assignedAt} DESC
    LIMIT 1
  )`;

  const latestQuotationSql = sql<string | null>`(
    SELECT json_build_object(
      'id', q.id,
      'date', q.created_at,
      'billedTo', q.client_name,
      'amount', q.purchase_price
    )::text
    FROM ${quotationsTable} q
    WHERE q.case_id = ${casesTable.id}
      AND q.firm_id = ${casesTable.firmId}
      AND q.deleted_at IS NULL
    ORDER BY q.created_at DESC
    LIMIT 1
  )`;

  const latestInvoiceSql = sql<string | null>`(
    SELECT json_build_object(
      'id', i.id,
      'date', i.created_at,
      'amount', i.grand_total,
      'invoiceNo', i.invoice_no
    )::text
    FROM ${invoicesTable} i
    WHERE i.case_id = ${casesTable.id}
      AND i.firm_id = ${casesTable.firmId}
      AND i.deleted_at IS NULL
    ORDER BY i.created_at DESC
    LIMIT 1
  )`;

  const [{ count }] = await r
    .select({ count: sql<number>`COUNT(*)` })
    .from(casesTable)
    .innerJoin(projectsTable, eq(projectsTable.id, casesTable.projectId))
    .innerJoin(developersTable, eq(developersTable.id, casesTable.developerId))
    .where(where);

  const rows = await r
    .select({
      id: casesTable.id,
      referenceNo: casesTable.referenceNo,
      purchaseMode: casesTable.purchaseMode,
      spaPrice: casesTable.spaPrice,
      parcelNo: casesTable.parcelNo,
      loanDetails: casesTable.loanDetails,
      propertyDetails: casesTable.propertyDetails,
      status: casesTable.status,
      projectName: projectsTable.name,
      developerName: developersTable.name,
      lawyerName: lawyerNameSql,
      clerkName: clerkNameSql,
      createdAt: casesTable.createdAt,
      updatedAt: casesTable.updatedAt,
      completionDate: caseKeyDatesTable.completionDate,
      latestQuotation: latestQuotationSql,
      latestInvoice: latestInvoiceSql,
    })
    .from(casesTable)
    .innerJoin(projectsTable, eq(projectsTable.id, casesTable.projectId))
    .innerJoin(developersTable, eq(developersTable.id, casesTable.developerId))
    .leftJoin(caseKeyDatesTable, and(eq(caseKeyDatesTable.caseId, casesTable.id), eq(caseKeyDatesTable.firmId, casesTable.firmId)))
    .where(where)
    .orderBy(desc(casesTable.updatedAt))
    .limit(limit)
    .offset(offset);

  const caseIds = rows.map((x) => x.id);
  const purchasersRows = caseIds.length
    ? await r
        .select({
          caseId: casePurchasersTable.caseId,
          orderNo: casePurchasersTable.orderNo,
          role: casePurchasersTable.role,
          name: clientsTable.name,
          icNo: clientsTable.icNo,
        })
        .from(casePurchasersTable)
        .innerJoin(clientsTable, eq(casePurchasersTable.clientId, clientsTable.id))
        .where(inArray(casePurchasersTable.caseId, caseIds))
        .orderBy(casePurchasersTable.caseId, casePurchasersTable.orderNo)
    : [];

  const partiesRows = caseIds.length
    ? await r
        .select({
          caseId: casePartiesTable.caseId,
          orderNo: casePartiesTable.orderNo,
          role: casePartiesTable.partyRole,
          name: partiesTable.fullName,
          nric: partiesTable.nric,
          passportNo: partiesTable.passportNo,
          companyRegNo: partiesTable.companyRegNo,
        })
        .from(casePartiesTable)
        .innerJoin(partiesTable, eq(casePartiesTable.partyId, partiesTable.id))
        .where(inArray(casePartiesTable.caseId, caseIds))
        .orderBy(casePartiesTable.caseId, casePartiesTable.orderNo)
    : [];

  const purchasersByCase = new Map<number, typeof purchasersRows>();
  for (const p of purchasersRows) {
    const list = purchasersByCase.get(p.caseId) ?? [];
    list.push(p);
    purchasersByCase.set(p.caseId, list);
  }

  const partiesByCase = new Map<number, typeof partiesRows>();
  for (const p of partiesRows) {
    const list = partiesByCase.get(p.caseId) ?? [];
    list.push(p);
    partiesByCase.set(p.caseId, list);
  }

  const data = rows.map((row) => {
    const loan = parseJsonObject(row.loanDetails);
    const prop = parseJsonObject(row.propertyDetails);

    const loanBank = firstString(
      loan?.endFinancier,
      loan?.bankName,
      loan?.financier,
      loan?.bank,
      loan?.bankBranch,
    );
    const loanAmount = firstNumber(
      loan?.financingSum,
      loan?.totalLoan,
      loan?.loanAmount,
    );

    const purchasePrice = row.spaPrice != null
      ? Number(row.spaPrice)
      : firstNumber(prop?.purchasePrice, prop?.spaPrice);

    const propertySummary = [
      row.projectName,
      firstString(prop?.propertyName, prop?.property, prop?.unitNo, prop?.unit, prop?.address, prop?.propertyAddress),
      row.parcelNo ? `Parcel ${row.parcelNo}` : null,
    ].filter(Boolean).join(" • ");

    const partiesList: Array<{ role: string; name: string; idNo: string | null }> = [];
    const dedupe = new Set<string>();

    const purchasers = purchasersByCase.get(row.id) ?? [];
    for (const p of purchasers) {
      const idNo = p.icNo ?? null;
      const role = p.role === "main" ? "buyer" : "buyer (joint)";
      const key = `${role}::${p.name}::${idNo ?? ""}`;
      if (dedupe.has(key)) continue;
      dedupe.add(key);
      partiesList.push({ role, name: p.name, idNo });
    }

    const cps = partiesByCase.get(row.id) ?? [];
    for (const p of cps) {
      const idNo = firstString(p.nric, p.passportNo, p.companyRegNo);
      const role = String(p.role || "other");
      const key = `${role}::${p.name}::${idNo ?? ""}`;
      if (dedupe.has(key)) continue;
      dedupe.add(key);
      partiesList.push({ role, name: p.name, idNo: idNo ?? null });
    }

    const openDate = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
    let closedDate: Date | null = null;
    if (row.completionDate) {
      closedDate = new Date(row.completionDate);
    } else if (row.status.toLowerCase().includes("closed")) {
      closedDate = row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt);
    }
    
    let daysToClose: number | null = null;
    let daysSinceOpen: number | null = null;
    const today = new Date();
    
    if (closedDate) {
      const diffTime = Math.abs(closedDate.getTime() - openDate.getTime());
      daysToClose = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    } else {
      const diffTime = Math.abs(today.getTime() - openDate.getTime());
      daysSinceOpen = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    }

    return {
      id: row.id,
      referenceNo: row.referenceNo,
      clientParties: partiesList,
      purchasePrice,
      purchaseMode: row.purchaseMode,
      loanBank,
      loanAmount,
      propertyInfo: propertySummary || row.projectName,
      lawyerInCharge: row.lawyerName,
      clerkInCharge: row.clerkName,
      status: row.status,
      openFileDate: openDate.toISOString(),
      closedFileDate: closedDate ? closedDate.toISOString() : null,
      daysToClose,
      daysSinceOpen,
      latestQuotation: parseJsonObject(row.latestQuotation),
      latestInvoice: parseJsonObject(row.latestInvoice),
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : new Date(row.updatedAt).toISOString(),
    };
  });

  res.json({ data, page, limit, total: Number(count) });
});

export default router;
