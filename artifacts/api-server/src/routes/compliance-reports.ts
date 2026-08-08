import express, { type Response, type Router as ExpressRouter } from "express";
import ExcelJS from "exceljs";
import { eq, and, desc, isNull, inArray, sql, count } from "drizzle-orm";
import {
  caseAssignmentsTable,
  caseNotesTable,
  casePurchasersTable,
  casesTable,
  clientsTable,
  db,
  invoiceItemsTable,
  invoicesTable,
  ledgerEntriesTable,
  paymentVouchersTable,
  receiptAllocationsTable,
  receiptsTable,
  usersTable,
} from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, type AuthRequest } from "../lib/auth.js";
import { queryOne } from "../lib/http.js";
import {
  parseLedgerAmount,
  parseLedgerAmountToNumber,
  type LedgerBadRowInfo,
} from "../modules/accounting/ledger-money.js";
import { withDbStatementTimeout, type StatementTimeoutCategory } from "../modules/db/statement-timeout.js";
import pino from "pino";

const cl = pino({ name: "compliance-reports" });

type RouterInternalLike = {
  get: (path: string, ...handlers: unknown[]) => unknown;
};

const expressRouter = express.Router();
const router = expressRouter as unknown as RouterInternalLike;

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const isYmd = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v);
const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  const needs = /[",\n\r]/.test(s);
  const escaped = s.replace(/"/g, "\"\"");
  return needs ? `"${escaped}"` : escaped;
};

const toYmd = (v: unknown): string | null => {
  if (!v) return null;
  if (typeof v === "string") return v.slice(0, 10);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

const ACCOUNTING_FMT = `_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)`;

function setHeaderRow(ws: ExcelJS.Worksheet, rowIdx: number, labels: string[]) {
  const row = ws.getRow(rowIdx);
  for (let i = 0; i < labels.length; i++) {
    row.getCell(i + 1).value = labels[i];
    row.getCell(i + 1).alignment = { horizontal: "center", vertical: "middle" };
    row.getCell(i + 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
  }
  row.font = { bold: true, color: { argb: "FF334155" } };
  row.height = 18;
}

function setCell(ws: ExcelJS.Worksheet, row: number, col: number, value: ExcelJS.CellValue) {
  ws.getRow(row).getCell(col).value = value;
}

function setNumberCell(ws: ExcelJS.Worksheet, row: number, col: number, value: number) {
  const cell = ws.getRow(row).getCell(col);
  cell.value = value;
  cell.numFmt = ACCOUNTING_FMT;
}

function setDateCell(ws: ExcelJS.Worksheet, row: number, col: number, ymd: string | null) {
  ws.getRow(row).getCell(col).value = ymd ?? "";
  ws.getRow(row).getCell(col).alignment = { horizontal: "center", vertical: "middle" };
}

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function setRight(ws: ExcelJS.Worksheet, row: number, col: number) {
  ws.getRow(row).getCell(col).alignment = { horizontal: "right", vertical: "middle" };
}

function setLeft(ws: ExcelJS.Worksheet, row: number, col: number) {
  ws.getRow(row).getCell(col).alignment = { horizontal: "left", vertical: "middle" };
}

function setCenter(ws: ExcelJS.Worksheet, row: number, col: number) {
  ws.getRow(row).getCell(col).alignment = { horizontal: "center", vertical: "middle" };
}

function applyZebra(ws: ExcelJS.Worksheet, startRow: number, endRow: number, colCount: number) {
  for (let r = startRow; r <= endRow; r++) {
    const isStripe = (r - startRow) % 2 === 1;
    if (!isStripe) continue;
    for (let c = 1; c <= colCount; c++) {
      ws.getRow(r).getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
    }
  }
}

function styleTotalsRow(ws: ExcelJS.Worksheet, rowIdx: number, colCount: number) {
  const row = ws.getRow(rowIdx);
  row.font = { bold: true };
  for (let c = 1; c <= colCount; c++) {
    row.getCell(c).border = {
      top: { style: "thin", color: { argb: "FF94A3B8" } },
      bottom: { style: "double", color: { argb: "FF94A3B8" } },
    };
  }
}

// ── Bills Delivered Book ──────────────────────────────────────────────────────
// Malaysian Solicitors' Accounts Rules: firms must maintain a bills-delivered book
router.get("/reports/bills-delivered-book", requireAuth, requireFirmUser, requirePermission("reports", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const r = req.rlsDb;
  if (!r) { res.status(500).json({ error: "Internal Server Error" }); return; }
  const from = one((req.query as any).from);
  const to = one((req.query as any).to);
  const format = one((req.query as any).format);
  if (from && !isYmd(from)) { res.status(400).json({ error: "Invalid from date (YYYY-MM-DD)" }); return; }
  if (to && !isYmd(to)) { res.status(400).json({ error: "Invalid to date (YYYY-MM-DD)" }); return; }
  if (from && to && from > to) { res.status(400).json({ error: "Invalid date range" }); return; }
  let dateCond = and(eq(invoicesTable.firmId, req.firmId!), isNull(invoicesTable.deletedAt));
  if (from) dateCond = and(dateCond, sql`issued_date >= ${from}`) as any;
  if (to)   dateCond = and(dateCond, sql`issued_date <= ${to}`) as any;

  const invoices = await r.select({
    id: invoicesTable.id,
    invoiceNo: invoicesTable.invoiceNo,
    caseId: invoicesTable.caseId,
    quotationId: invoicesTable.quotationId,
    status: invoicesTable.status,
    issuedDate: invoicesTable.issuedDate,
    dueDate: invoicesTable.dueDate,
    subtotal: invoicesTable.subtotal,
    taxTotal: invoicesTable.taxTotal,
    grandTotal: invoicesTable.grandTotal,
    amountPaid: invoicesTable.amountPaid,
    amountDue: sql<string>`CASE WHEN ${invoicesTable.status} = 'void' THEN 0 ELSE ${invoicesTable.amountDue} END`,
  }).from(invoicesTable).where(dateCond).orderBy(desc(invoicesTable.issuedDate));

  const invoiceIds = invoices.map((x) => x.id);
  const caseIds = Array.from(new Set(invoices.map((x) => x.caseId).filter((x): x is number => typeof x === "number")));

  const [caseRows, itemRows, allocRows, directReceiptRows] = await Promise.all([
    caseIds.length
      ? r
          .select({ caseId: casesTable.id, caseRef: casesTable.referenceNo, clientName: clientsTable.name })
          .from(casesTable)
          .leftJoin(casePurchasersTable, eq(casePurchasersTable.caseId, casesTable.id))
          .leftJoin(clientsTable, eq(clientsTable.id, casePurchasersTable.clientId))
          .where(and(eq(casesTable.firmId, req.firmId!), inArray(casesTable.id, caseIds)))
      : Promise.resolve([]),
    invoiceIds.length
      ? r
          .select({
            invoiceId: invoiceItemsTable.invoiceId,
            itemType: invoiceItemsTable.itemType,
            amountExclTax: invoiceItemsTable.amountExclTax,
            taxRate: invoiceItemsTable.taxRate,
            taxAmount: invoiceItemsTable.taxAmount,
          })
          .from(invoiceItemsTable)
          .where(inArray(invoiceItemsTable.invoiceId, invoiceIds))
      : Promise.resolve([]),
    invoiceIds.length
      ? r
          .select({
            invoiceId: receiptAllocationsTable.invoiceId,
            receiptNo: receiptsTable.receiptNo,
            receivedDate: receiptsTable.receivedDate,
          })
          .from(receiptAllocationsTable)
          .innerJoin(receiptsTable, eq(receiptsTable.id, receiptAllocationsTable.receiptId))
          .where(
            and(
              eq(receiptsTable.firmId, req.firmId!),
              eq(receiptsTable.isReversed, false),
              inArray(receiptAllocationsTable.invoiceId, invoiceIds)
            )
          )
      : Promise.resolve([]),
    invoiceIds.length
      ? r
          .select({ invoiceId: receiptsTable.invoiceId, receiptNo: receiptsTable.receiptNo, receivedDate: receiptsTable.receivedDate })
          .from(receiptsTable)
          .where(and(eq(receiptsTable.firmId, req.firmId!), eq(receiptsTable.isReversed, false), inArray(receiptsTable.invoiceId, invoiceIds)))
      : Promise.resolve([]),
  ]);

  const caseById = new Map<number, { caseRef: string | null; clientName: string | null }>();
  for (const row of caseRows as any[]) {
    const cid = typeof row.caseId === "number" ? row.caseId : NaN;
    if (!Number.isFinite(cid)) continue;
    if (!caseById.has(cid)) caseById.set(cid, { caseRef: row.caseRef ?? null, clientName: row.clientName ?? null });
  }

  const disbByInvoiceId = new Map<number, { taxable: number; nonTaxable: number }>();
  for (const it of itemRows as any[]) {
    const iid = typeof it.invoiceId === "number" ? it.invoiceId : NaN;
    if (!Number.isFinite(iid)) continue;
    if (String(it.itemType ?? "") !== "disbursement") continue;
    const taxRate = num(it.taxRate);
    const taxAmount = num(it.taxAmount);
    const amt = num(it.amountExclTax);
    const cur = disbByInvoiceId.get(iid) ?? { taxable: 0, nonTaxable: 0 };
    if (taxRate > 0 || taxAmount > 0) cur.taxable += amt;
    else cur.nonTaxable += amt;
    disbByInvoiceId.set(iid, cur);
  }

  const receiptsByInvoiceId = new Map<number, { receiptNumbers: string[]; paymentDates: string[] }>();
  const addReceipt = (invoiceId: number, receiptNo: unknown, receivedDate: unknown) => {
    if (!Number.isFinite(invoiceId)) return;
    const rn = typeof receiptNo === "string" && receiptNo.trim() ? receiptNo.trim() : null;
    const dt = toYmd(receivedDate);
    if (!rn && !dt) return;
    const cur = receiptsByInvoiceId.get(invoiceId) ?? { receiptNumbers: [], paymentDates: [] };
    if (rn && !cur.receiptNumbers.includes(rn)) cur.receiptNumbers.push(rn);
    if (dt && !cur.paymentDates.includes(dt)) cur.paymentDates.push(dt);
    receiptsByInvoiceId.set(invoiceId, cur);
  };
  for (const rr of allocRows as any[]) addReceipt(Number(rr.invoiceId), rr.receiptNo, rr.receivedDate);
  for (const rr of directReceiptRows as any[]) addReceipt(Number(rr.invoiceId), rr.receiptNo, rr.receivedDate);
  for (const v of receiptsByInvoiceId.values()) v.paymentDates.sort((a, b) => a.localeCompare(b));

  const enriched = invoices.map((inv) => {
    const info = typeof inv.caseId === "number" ? caseById.get(inv.caseId) : undefined;
    const disb = disbByInvoiceId.get(inv.id) ?? { taxable: 0, nonTaxable: 0 };
    const rc = receiptsByInvoiceId.get(inv.id) ?? { receiptNumbers: [], paymentDates: [] };
    return {
      ...inv,
      caseRef: info?.caseRef ?? null,
      clientName: info?.clientName ?? null,
      taxableDisbursements: disb.taxable.toFixed(2),
      nonTaxableDisbursements: disb.nonTaxable.toFixed(2),
      receiptNumbers: rc.receiptNumbers,
      paymentDates: rc.paymentDates,
    };
  });

  const totals = {
    count: enriched.length,
    totalBilled: enriched.reduce((s, i) => s + Number(i.grandTotal), 0).toFixed(2),
    totalPaid: enriched.reduce((s, i) => s + Number(i.amountPaid), 0).toFixed(2),
    totalOutstanding: enriched.reduce((s, i) => s + Number(i.amountDue), 0).toFixed(2),
  };

  if (format === "csv") {
    const lines: string[] = [];
    lines.push([
      "invoice_no", "issued_date", "due_date", "status",
      "case_ref", "client_name",
      "subtotal", "tax_total", "grand_total", "amount_paid", "amount_due",
      "taxable_disbursements", "non_taxable_disbursements",
      "receipt_numbers", "payment_dates",
    ].join(","));
    for (const inv of enriched) {
      lines.push([
        csvCell(inv.invoiceNo),
        csvCell(inv.issuedDate),
        csvCell(inv.dueDate),
        csvCell(inv.status),
        csvCell((inv as any).caseRef),
        csvCell((inv as any).clientName),
        csvCell(inv.subtotal),
        csvCell(inv.taxTotal),
        csvCell(inv.grandTotal),
        csvCell(inv.amountPaid),
        csvCell(inv.amountDue),
        csvCell((inv as any).taxableDisbursements),
        csvCell((inv as any).nonTaxableDisbursements),
        csvCell(Array.isArray((inv as any).receiptNumbers) ? (inv as any).receiptNumbers.join("; ") : ""),
        csvCell(Array.isArray((inv as any).paymentDates) ? (inv as any).paymentDates.join("; ") : ""),
      ].join(","));
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="bills-delivered-book${from ? `_${from}` : ""}${to ? `_${to}` : ""}.csv"`);
    res.send("\ufeff" + lines.join("\n"));
    return;
  }

  if (format === "xlsx") {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Bills Delivered Book");
    ws.properties.defaultRowHeight = 16;
    ws.getColumn(1).width = 14;
    ws.getColumn(2).width = 16;
    ws.getColumn(3).width = 16;
    ws.getColumn(4).width = 18;
    ws.getColumn(5).width = 28;
    ws.getColumn(6).width = 16;
    ws.getColumn(7).width = 16;
    ws.getColumn(8).width = 16;
    ws.getColumn(9).width = 16;
    ws.getColumn(10).width = 18;
    ws.getColumn(11).width = 18;
    ws.getColumn(12).width = 18;
    ws.getColumn(13).width = 24;
    ws.getColumn(14).width = 24;
    ws.getColumn(15).width = 24;

    setHeaderRow(ws, 4, [
      "Issued Date",
      "Invoice No.",
      "Due Date",
      "Status",
      "File Ref",
      "Client",
      "Subtotal",
      "Tax",
      "Gross",
      "Paid",
      "Due",
      "Taxable Disb.",
      "Non-taxable Disb.",
      "Receipt No(s)",
      "Payment Date(s)",
    ]);

    let row = 5;
    for (const inv of enriched as any[]) {
      setDateCell(ws, row, 1, toYmd(inv.issuedDate));
      setCell(ws, row, 2, String(inv.invoiceNo ?? ""));
      setDateCell(ws, row, 3, toYmd(inv.dueDate));
      setCell(ws, row, 4, String(inv.status ?? ""));
      setCell(ws, row, 5, String(inv.caseRef ?? ""));
      setCell(ws, row, 6, String(inv.clientName ?? ""));
      setNumberCell(ws, row, 7, num(inv.subtotal));
      setNumberCell(ws, row, 8, num(inv.taxTotal));
      setNumberCell(ws, row, 9, num(inv.grandTotal));
      setNumberCell(ws, row, 10, num(inv.amountPaid));
      setNumberCell(ws, row, 11, num(inv.amountDue));
      setNumberCell(ws, row, 12, num(inv.taxableDisbursements));
      setNumberCell(ws, row, 13, num(inv.nonTaxableDisbursements));
      setCell(ws, row, 14, Array.isArray(inv.receiptNumbers) ? inv.receiptNumbers.join("; ") : "");
      setCell(ws, row, 15, Array.isArray(inv.paymentDates) ? inv.paymentDates.join("; ") : "");

      setCenter(ws, row, 2);
      setCenter(ws, row, 4);
      setCenter(ws, row, 5);
      setLeft(ws, row, 6);
      for (const c of [7, 8, 9, 10, 11, 12, 13]) setRight(ws, row, c);
      setLeft(ws, row, 14);
      setCenter(ws, row, 15);

      row++;
    }

    const lastDataRow = row - 1;
    const totalsRow = row;
    ws.getRow(totalsRow).font = { bold: true };
    setCell(ws, totalsRow, 1, "Totals");
    ws.mergeCells(totalsRow, 1, totalsRow, 6);
    setRight(ws, totalsRow, 6);
    const sum = (col: number) => ({ formula: `SUM(${ws.getColumn(col).letter}5:${ws.getColumn(col).letter}${lastDataRow})` });
    setCell(ws, totalsRow, 7, sum(7));
    setCell(ws, totalsRow, 8, sum(8));
    setCell(ws, totalsRow, 9, sum(9));
    setCell(ws, totalsRow, 10, sum(10));
    setCell(ws, totalsRow, 11, sum(11));
    setCell(ws, totalsRow, 12, sum(12));
    setCell(ws, totalsRow, 13, sum(13));
    for (const c of [7, 8, 9, 10, 11, 12, 13]) {
      ws.getRow(totalsRow).getCell(c).numFmt = ACCOUNTING_FMT;
      setRight(ws, totalsRow, c);
    }

    if (lastDataRow >= 5) applyZebra(ws, 5, lastDataRow, 15);
    styleTotalsRow(ws, totalsRow, 15);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="bills-delivered-book${from ? `_${from}` : ""}${to ? `_${to}` : ""}.xlsx"`);
    const buf = await wb.xlsx.writeBuffer();
    res.send(Buffer.from(buf as ArrayBuffer));
    return;
  }

  res.json({ invoices: enriched, totals });
});

// ── Client Account Statement (Trust) ──────────────────────────────────────────
router.get("/reports/trust-account-statement", requireAuth, requireFirmUser, requirePermission("reports", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const r = req.rlsDb;
  const conn = req.rlsClient;
  if (!r) { res.status(500).json({ error: "Internal Server Error" }); return; }
  const caseId = one((req.query as any).caseId);
  const format = one((req.query as any).format);
  const category: StatementTimeoutCategory = "report";

  let cond = and(eq(ledgerEntriesTable.firmId, req.firmId!), sql`${ledgerEntriesTable.accountType} IN ('client','trust')`);
  if (caseId) {
    const cid = parseInt(caseId, 10);
    if (Number.isNaN(cid)) { res.status(400).json({ error: "Invalid case ID" }); return; }
    cond = and(cond, eq(ledgerEntriesTable.caseId, cid)) as any;
  }

  try {
    const problemRows: LedgerBadRowInfo[] = [];
    const badRowCb: (info: LedgerBadRowInfo) => void = (info) => { problemRows.push(info); };

    const fetchChunked = async (maxRows = 50_000, chunkSize = 1000) => {
      const acc: any[] = [];
      let lastId: number | null = null;
      for (let round = 0; round < Math.ceil(maxRows / chunkSize); round++) {
        const where = lastId != null
          ? and(cond, sql`${ledgerEntriesTable.id} > ${lastId}`)
          : cond;
        const chunk: any[] = conn
          ? await withDbStatementTimeout(conn, category, () =>
              (r as any)
                .select({
                  id: ledgerEntriesTable.id,
                  firmId: ledgerEntriesTable.firmId,
                  caseId: ledgerEntriesTable.caseId,
                  entryDate: ledgerEntriesTable.entryDate,
                  entryType: ledgerEntriesTable.entryType,
                  accountType: ledgerEntriesTable.accountType,
                  debit: ledgerEntriesTable.debit,
                  credit: ledgerEntriesTable.credit,
                  balanceAfter: ledgerEntriesTable.balanceAfter,
                  description: ledgerEntriesTable.description,
                  referenceNo: ledgerEntriesTable.referenceNo,
                  sourceType: ledgerEntriesTable.sourceType,
                  sourceId: ledgerEntriesTable.sourceId,
                  createdAt: ledgerEntriesTable.createdAt,
                })
                .from(ledgerEntriesTable)
                .where(where)
                .orderBy(ledgerEntriesTable.id)
                .limit(chunkSize),
              category,
            )
          : await (r as any)
              .select({
                id: ledgerEntriesTable.id,
                firmId: ledgerEntriesTable.firmId,
                caseId: ledgerEntriesTable.caseId,
                entryDate: ledgerEntriesTable.entryDate,
                entryType: ledgerEntriesTable.entryType,
                accountType: ledgerEntriesTable.accountType,
                debit: ledgerEntriesTable.debit,
                credit: ledgerEntriesTable.credit,
                balanceAfter: ledgerEntriesTable.balanceAfter,
                description: ledgerEntriesTable.description,
                referenceNo: ledgerEntriesTable.referenceNo,
                sourceType: ledgerEntriesTable.sourceType,
                sourceId: ledgerEntriesTable.sourceId,
                createdAt: ledgerEntriesTable.createdAt,
              })
              .from(ledgerEntriesTable)
              .where(where)
              .orderBy(ledgerEntriesTable.id)
              .limit(chunkSize);
        if (!chunk.length) break;
        acc.push(...chunk);
        lastId = (chunk[chunk.length - 1] as any).id;
        if (chunk.length < chunkSize) break;
      }
      return acc;
    };

    const entries = await fetchChunked();

    const voucherIds = Array.from(
      new Set(
        entries
          .filter((e) => String(e.sourceType ?? "") === "payment_voucher" && typeof e.sourceId === "number")
          .map((e) => e.sourceId as number)
      )
    );
    const vouchers = voucherIds.length
      ? await r
          .select({
            id: paymentVouchersTable.id,
            status: paymentVouchersTable.status,
            paymentMethod: paymentVouchersTable.paymentMethod,
            bankChequeRefNo: paymentVouchersTable.bankChequeRefNo,
          })
          .from(paymentVouchersTable)
          .where(and(eq(paymentVouchersTable.firmId, req.firmId!), inArray(paymentVouchersTable.id, voucherIds)))
      : [];
    const voucherById = new Map<number, { status: string; paymentMethod: string | null; bankChequeRefNo: string | null }>();
    for (const v of vouchers as any[]) {
      voucherById.set(Number(v.id), {
        status: String(v.status ?? ""),
        paymentMethod: typeof v.paymentMethod === "string" ? v.paymentMethod : null,
        bankChequeRefNo: typeof v.bankChequeRefNo === "string" ? v.bankChequeRefNo : null,
      });
    }

    const entriesWithCheque = entries.map((e) => {
      const voucher = typeof e.sourceId === "number" ? voucherById.get(e.sourceId) : undefined;
      const isCheque = Boolean(voucher && ((voucher.paymentMethod ?? "").toLowerCase().includes("cheque") || (voucher.bankChequeRefNo ?? "").trim()));
      const chequeStatus: "issued" | "cleared" | "unpresented" | null = (() => {
        if (!isCheque) return null;
        if (voucher?.status === "completed") return "cleared";
        if (voucher?.status === "paid_pending_collection") return "unpresented";
        return "issued";
      })();
      return { ...e, chequeStatus };
    });

    let ledgerBookBalance = 0;
    let unpresentedTotal = 0;
    for (const e of entriesWithCheque as any[]) {
      const cr = parseLedgerAmountToNumber(e.credit, badRowCb, { rowId: e.id, column: "credit", table: "ledger_entries" });
      const dr = parseLedgerAmountToNumber(e.debit, badRowCb, { rowId: e.id, column: "debit", table: "ledger_entries" });
      ledgerBookBalance += cr - dr;
      if (e.chequeStatus === "unpresented") unpresentedTotal += dr;
    }
    const availableBalance = ledgerBookBalance - unpresentedTotal;

    if (format === "csv") {
      const lines: string[] = [];
      lines.push(["entry_date", "entry_type", "reference_no", "description", "debit", "credit", "balance_after", "cheque_status"].join(","));
      let lineNumber = 1;
      for (const e of entriesWithCheque as any[]) {
        lineNumber++;
        const rowBadBeforeFilter = problemRows.length;
        const debit = parseLedgerAmountToNumber(e.debit, badRowCb, { rowId: e.id, lineNumber, column: "debit", table: "ledger_entries" });
        const credit = parseLedgerAmountToNumber(e.credit, badRowCb, { rowId: e.id, lineNumber, column: "credit", table: "ledger_entries" });
        const balanceAfter = parseLedgerAmountToNumber(e.balanceAfter, badRowCb, { rowId: e.id, lineNumber, column: "balance", table: "ledger_entries" });
        const isBadRow = problemRows.length > rowBadBeforeFilter;
        const desc = isBadRow && typeof e.description === "string"
          ? `[Malformed amount reported to admin] ${e.description}`
          : e.description;
        lines.push([
          csvCell(e.entryDate),
          csvCell(e.entryType),
          csvCell(e.referenceNo),
          csvCell(desc),
          csvCell(debit.toFixed(2)),
          csvCell(credit.toFixed(2)),
          csvCell(balanceAfter.toFixed(2)),
          csvCell(e.chequeStatus),
        ].join(","));
      }
      if (problemRows.length > 0) {
        lines.push("");
        lines.push("# WARNING: Malformed monetary amounts detected. The following ledger row IDs were zeroed. Report to admin for review.");
        lines.push("# " + problemRows.map((r: any) => `rowId=${String(r.rowId ?? "?")} col=${r.column ?? "?"}`).join(" | "));
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="trust-account-statement${caseId ? `_${caseId}` : ""}.csv"`);
      res.send("\ufeff" + lines.join("\n"));
      return;
    }

    if (format === "xlsx") {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Client Account Statement");
      ws.properties.defaultRowHeight = 16;
      ws.getColumn(1).width = 14;
      ws.getColumn(2).width = 10;
      ws.getColumn(3).width = 18;
      ws.getColumn(4).width = 50;
      ws.getColumn(5).width = 16;
      ws.getColumn(6).width = 16;
      ws.getColumn(7).width = 18;
      ws.getColumn(8).width = 14;

      setHeaderRow(ws, 4, ["Date", "Case", "Ref", "Description", "Debit", "Credit", "Balance After", "Cheque Status"]);

      let row = 5;
      for (const e of entriesWithCheque as any[]) {
        const lineNumber = row;
        const rowBadBefore = problemRows.length;
        const debit = parseLedgerAmountToNumber(e.debit, badRowCb, { rowId: e.id, lineNumber, column: "debit", table: "ledger_entries" });
        const credit = parseLedgerAmountToNumber(e.credit, badRowCb, { rowId: e.id, lineNumber, column: "credit", table: "ledger_entries" });
        const balanceAfter = parseLedgerAmountToNumber(e.balanceAfter, badRowCb, { rowId: e.id, lineNumber, column: "balance", table: "ledger_entries" });
        const isBadRow = problemRows.length > rowBadBefore;
        setDateCell(ws, row, 1, toYmd(e.entryDate));
        setCell(ws, row, 2, e.caseId ?? "");
        setCell(ws, row, 3, String(e.referenceNo ?? ""));
        const descText = isBadRow && typeof e.description === "string"
          ? `[Malformed amount reported to admin] ${e.description}`
          : String(e.description ?? "");
        setCell(ws, row, 4, descText);
        setNumberCell(ws, row, 5, debit);
        setNumberCell(ws, row, 6, credit);
        setNumberCell(ws, row, 7, balanceAfter);
        setCell(ws, row, 8, e.chequeStatus ?? "");

        if (isBadRow) {
          for (const c of [5, 6, 7]) {
            try { ws.getRow(row).getCell(c).note = "Malformed amount reported to admin — value zeroed for export."; } catch {
            }
          }
        }

        setCenter(ws, row, 2);
        setCenter(ws, row, 3);
        setLeft(ws, row, 4);
        for (const c of [5, 6, 7]) setRight(ws, row, c);
        setCenter(ws, row, 8);
        row++;
      }

      const lastDataRow = row - 1;
      const totalsRow = row;
      ws.getRow(totalsRow).font = { bold: true };
      setCell(ws, totalsRow, 1, "Totals");
      ws.mergeCells(totalsRow, 1, totalsRow, 4);
      setRight(ws, totalsRow, 4);
      const sum = (col: number) => ({ formula: `SUM(${ws.getColumn(col).letter}5:${ws.getColumn(col).letter}${lastDataRow})` });
      setCell(ws, totalsRow, 5, sum(5));
      setCell(ws, totalsRow, 6, sum(6));
      for (const c of [5, 6]) {
        ws.getRow(totalsRow).getCell(c).numFmt = ACCOUNTING_FMT;
        setRight(ws, totalsRow, c);
      }
      setCell(ws, totalsRow, 7, { formula: `${ws.getColumn(6).letter}${totalsRow}-${ws.getColumn(5).letter}${totalsRow}` });
      ws.getRow(totalsRow).getCell(7).numFmt = ACCOUNTING_FMT;
      setRight(ws, totalsRow, 7);

      if (lastDataRow >= 5) applyZebra(ws, 5, lastDataRow, 8);
      styleTotalsRow(ws, totalsRow, 8);

      const metaRow = totalsRow + 2;
      ws.getRow(metaRow).getCell(1).value = "Ledger Book Balance";
      ws.getRow(metaRow).getCell(2).value = ledgerBookBalance;
      ws.getRow(metaRow).getCell(2).numFmt = ACCOUNTING_FMT;
      ws.getRow(metaRow + 1).getCell(1).value = "Available Balance";
      ws.getRow(metaRow + 1).getCell(2).value = availableBalance;
      ws.getRow(metaRow + 1).getCell(2).numFmt = ACCOUNTING_FMT;

      if (problemRows.length > 0) {
        const errWs = wb.addWorksheet("error_markers");
        errWs.getColumn(1).width = 14;
        errWs.getColumn(2).width = 14;
        errWs.getColumn(3).width = 18;
        errWs.getColumn(4).width = 14;
        errWs.getColumn(5).width = 50;
        errWs.getColumn(6).width = 24;
        setHeaderRow(errWs, 1, ["Row ID (ledger_entries)", "Line Number", "Column", "Table", "Raw Value", "Reason"]);
        let rIdx = 2;
        for (const bad of problemRows) {
          setCell(errWs, rIdx, 1, typeof bad.rowId === "number" || typeof bad.rowId === "string" ? String(bad.rowId) : "");
          setCell(errWs, rIdx, 2, typeof bad.lineNumber === "number" ? String(bad.lineNumber) : "");
          setCell(errWs, rIdx, 3, String(bad.column ?? ""));
          setCell(errWs, rIdx, 4, String(bad.table ?? ""));
          setCell(errWs, rIdx, 5, JSON.stringify(bad.rawValue ?? ""));
          setCell(errWs, rIdx, 6, String(bad.reason ?? "malformed_amount"));
          rIdx++;
        }
      }

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="trust-account-statement${caseId ? `_${caseId}` : ""}.xlsx"`);
      const buf = await wb.xlsx.writeBuffer();
      res.send(Buffer.from(buf as ArrayBuffer));
      return;
    }

    res.json({
      entries: entriesWithCheque,
      ledgerBookBalance: Number(ledgerBookBalance.toFixed(2)),
      availableBalance: Number(availableBalance.toFixed(2)),
      balance: Number(ledgerBookBalance.toFixed(2)),
      problem_rows: problemRows,
    });
  } catch (err) {
    cl.error({ err, path: req.path, firmId: req.firmId }, "trust_account_statement.failed");
    if (err instanceof Error && (err as any).code === "STATEMENT_TIMEOUT") {
      res.status(504).json({ error: (err as Error).message });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to build trust account statement" });
  }
});

router.get("/reports/client-account-statement", requireAuth, requireFirmUser, requirePermission("reports", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const r = req.rlsDb ?? db;
  const conn = req.rlsClient;
  const caseId = one((req.query as any).caseId);
  const category: StatementTimeoutCategory = "report";
  let cond = and(eq(ledgerEntriesTable.firmId, req.firmId!), eq(ledgerEntriesTable.accountType, "client"));
  if (caseId) {
    const cid = parseInt(caseId, 10);
    if (Number.isNaN(cid)) { res.status(400).json({ error: "Invalid case ID" }); return; }
    cond = and(cond, eq(ledgerEntriesTable.caseId, cid)) as any;
  }
  try {
    const problemRows: LedgerBadRowInfo[] = [];
    const badRowCb: any = (info: LedgerBadRowInfo) => { problemRows.push(info); };
    const chunkSize = 1000;
    const maxRows = 50_000;
    let lastId: number | null = null;
    const entries: any[] = [];
    for (let round = 0; round < Math.ceil(maxRows / chunkSize); round++) {
      const where = lastId != null
        ? and(cond as any, sql`${ledgerEntriesTable.id} > ${lastId}`)
        : cond;
      const chunk: any[] = conn
        ? await withDbStatementTimeout(conn, category, () =>
            (r as any).select().from(ledgerEntriesTable).where(where).orderBy(ledgerEntriesTable.id).limit(chunkSize),
            category,
          )
        : await (r as any).select().from(ledgerEntriesTable).where(where).orderBy(ledgerEntriesTable.id).limit(chunkSize);
      if (!chunk.length) break;
      entries.push(...chunk);
      lastId = (chunk[chunk.length - 1] as any).id;
      if (chunk.length < chunkSize) break;
    }
    let balance = 0;
    for (const e of entries as any[]) {
      const cr = parseLedgerAmountToNumber(e.credit, badRowCb, { rowId: e.id, column: "credit", table: "ledger_entries" });
      const dr = parseLedgerAmountToNumber(e.debit, badRowCb, { rowId: e.id, column: "debit", table: "ledger_entries" });
      balance += cr - dr;
    }
    res.json({ entries, balance: balance.toFixed(2), problem_rows: problemRows });
  } catch (err) {
    cl.error({ err, path: req.path, firmId: req.firmId }, "client_account_statement.failed");
    if (err instanceof Error && (err as any).code === "STATEMENT_TIMEOUT") {
      res.status(504).json({ error: (err as Error).message });
      return;
    }
    res.status(500).json({ error: "Failed to build client account statement" });
  }
});

// ── Matter Aging Report ───────────────────────────────────────────────────────
router.get("/reports/matter-aging", requireAuth, requireFirmUser, requirePermission("reports", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const r = req.rlsDb;
  if (!r) { res.status(500).json({ error: "Internal Server Error" }); return; }
  const format = one((req.query as any).format);
  const today = new Date().toISOString().slice(0, 10);
  const invoices = await r.select({
    id: invoicesTable.id,
    invoiceNo: invoicesTable.invoiceNo,
    caseId: invoicesTable.caseId,
    issuedDate: invoicesTable.issuedDate,
    dueDate: invoicesTable.dueDate,
    amountDue: invoicesTable.amountDue,
    grandTotal: invoicesTable.grandTotal,
    status: invoicesTable.status,
  }).from(invoicesTable).where(
    and(eq(invoicesTable.firmId, req.firmId!), isNull(invoicesTable.deletedAt), sql`status IN ('issued','partially_paid') AND amount_due > 0`)
  ).orderBy(invoicesTable.dueDate);

  const caseIds = Array.from(new Set(invoices.map((x) => x.caseId).filter((x): x is number => typeof x === "number")));
  const [caseRows, assignmentRows, chaserRows] = await Promise.all([
    caseIds.length
      ? r
          .select({ caseId: casesTable.id, caseRef: casesTable.referenceNo })
          .from(casesTable)
          .where(and(eq(casesTable.firmId, req.firmId!), inArray(casesTable.id, caseIds)))
      : Promise.resolve([]),
    caseIds.length
      ? r
          .select({
            caseId: caseAssignmentsTable.caseId,
            roleInCase: caseAssignmentsTable.roleInCase,
            assignedAt: caseAssignmentsTable.assignedAt,
            userName: usersTable.name,
          })
          .from(caseAssignmentsTable)
          .innerJoin(usersTable, eq(usersTable.id, caseAssignmentsTable.userId))
          .where(and(inArray(caseAssignmentsTable.caseId, caseIds), isNull(caseAssignmentsTable.unassignedAt)))
          .orderBy(desc(caseAssignmentsTable.assignedAt))
      : Promise.resolve([]),
    caseIds.length
      ? r
          .select({
            caseId: caseNotesTable.caseId,
            lastChaserDate: sql<string>`MAX(${caseNotesTable.createdAt})`,
          })
          .from(caseNotesTable)
          .where(
            and(
              inArray(caseNotesTable.caseId, caseIds),
              sql`(lower(${caseNotesTable.content}) LIKE '%chaser%' OR lower(${caseNotesTable.content}) LIKE '%follow up%' OR lower(${caseNotesTable.content}) LIKE '%follow-up%')`
            )
          )
          .groupBy(caseNotesTable.caseId)
      : Promise.resolve([]),
  ]);

  const caseRefById = new Map<number, string>();
  for (const c of caseRows as any[]) {
    if (typeof c.caseId === "number") caseRefById.set(c.caseId, String(c.caseRef ?? ""));
  }

  const staffByCaseId = new Map<number, { name: string; score: number }>();
  const roleScore = (role: unknown): number => {
    const r = String(role ?? "").toLowerCase();
    if (r === "lawyer") return 3;
    if (r === "partner") return 2;
    if (r === "clerk") return 1;
    return 0;
  };
  for (const a of assignmentRows as any[]) {
    const cid = typeof a.caseId === "number" ? a.caseId : NaN;
    if (!Number.isFinite(cid)) continue;
    const name = typeof a.userName === "string" ? a.userName : "";
    if (!name) continue;
    const score = roleScore(a.roleInCase);
    const cur = staffByCaseId.get(cid);
    if (!cur || score > cur.score) staffByCaseId.set(cid, { name, score });
  }

  const lastChaserByCaseId = new Map<number, string | null>();
  for (const row of chaserRows as any[]) {
    const cid = typeof row.caseId === "number" ? row.caseId : NaN;
    if (!Number.isFinite(cid)) continue;
    lastChaserByCaseId.set(cid, toYmd(row.lastChaserDate));
  }

  const enriched = invoices.map((inv) => {
    const cid = typeof inv.caseId === "number" ? inv.caseId : null;
    const due = toYmd(inv.dueDate);
    const dueBase = due ? new Date(due).getTime() : new Date(today).getTime();
    const days = Math.max(0, Math.floor((new Date(today).getTime() - dueBase) / 86400000));
    const bucket =
      days <= 30 ? "days0_30"
      : days <= 60 ? "days31_60"
      : days <= 90 ? "days61_90"
      : days <= 180 ? "days91_180"
      : "days180_plus";
    return {
      ...inv,
      caseRef: cid ? (caseRefById.get(cid) ?? String(cid)) : null,
      handlingStaffName: cid ? (staffByCaseId.get(cid)?.name ?? null) : null,
      lastChaserDate: cid ? (lastChaserByCaseId.get(cid) ?? null) : null,
      daysOutstanding: days,
      bucket,
    };
  });

  const buckets: Record<string, any[]> = { days0_30: [], days31_60: [], days61_90: [], days91_180: [], days180_plus: [] };
  for (const inv of enriched as any[]) buckets[String(inv.bucket)]?.push(inv);

  const bucketTotals = Object.entries(buckets).map(([key, items]) => ({
    bucket: key,
    count: items.length,
    total: items.reduce((s, i) => s + Number(i.amountDue), 0).toFixed(2),
    items,
  }));

  if (format === "csv") {
    const lines: string[] = [];
    lines.push(["bucket", "invoice_no", "case_ref", "handling_staff_name", "last_chaser_date", "issued_date", "due_date", "days_outstanding", "amount_due"].join(","));
    for (const b of bucketTotals) {
      for (const inv of b.items as any[]) {
        lines.push([
          csvCell(b.bucket),
          csvCell(inv.invoiceNo),
          csvCell(inv.caseRef),
          csvCell(inv.handlingStaffName),
          csvCell(inv.lastChaserDate),
          csvCell(inv.issuedDate),
          csvCell(inv.dueDate),
          csvCell(inv.daysOutstanding),
          csvCell(inv.amountDue),
        ].join(","));
      }
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=\"matter-aging.csv\"");
    res.send("\ufeff" + lines.join("\n"));
    return;
  }

  if (format === "xlsx") {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Matter Aging");
    ws.properties.defaultRowHeight = 16;
    ws.getColumn(1).width = 16;
    ws.getColumn(2).width = 18;
    ws.getColumn(3).width = 22;
    ws.getColumn(4).width = 16;
    ws.getColumn(5).width = 14;
    ws.getColumn(6).width = 14;
    ws.getColumn(7).width = 10;
    ws.getColumn(8).width = 18;
    ws.getColumn(9).width = 14;

    setHeaderRow(ws, 4, [
      "Invoice No.",
      "File Ref",
      "Handling Staff",
      "Last Chaser Date",
      "Issue Date",
      "Due Date",
      "Days",
      "Outstanding",
      "Bucket",
    ]);

    let row = 5;
    for (const inv of enriched as any[]) {
      setCell(ws, row, 1, String(inv.invoiceNo ?? ""));
      setCell(ws, row, 2, String(inv.caseRef ?? ""));
      setCell(ws, row, 3, String(inv.handlingStaffName ?? ""));
      setDateCell(ws, row, 4, toYmd(inv.lastChaserDate));
      setDateCell(ws, row, 5, toYmd(inv.issuedDate));
      setDateCell(ws, row, 6, toYmd(inv.dueDate));
      setCell(ws, row, 7, num(inv.daysOutstanding));
      setNumberCell(ws, row, 8, num(inv.amountDue));
      setCell(ws, row, 9, String(inv.bucket ?? ""));

      setCenter(ws, row, 1);
      setCenter(ws, row, 2);
      setLeft(ws, row, 3);
      setCenter(ws, row, 7);
      setRight(ws, row, 8);
      setCenter(ws, row, 9);

      const needsWarn = inv.bucket === "days91_180" || inv.bucket === "days180_plus";
      if (needsWarn && num(inv.amountDue) > 0) {
        const cell = ws.getRow(row).getCell(8);
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDE8E8" } };
        cell.font = { bold: true, color: { argb: "FF991B1B" } };
      }

      row++;
    }

    const lastDataRow = row - 1;
    const totalsRow = row;
    ws.getRow(totalsRow).font = { bold: true };
    setCell(ws, totalsRow, 1, "Total Outstanding");
    ws.mergeCells(totalsRow, 1, totalsRow, 7);
    setRight(ws, totalsRow, 7);
    setCell(ws, totalsRow, 8, { formula: `SUM(${ws.getColumn(8).letter}5:${ws.getColumn(8).letter}${lastDataRow})` });
    ws.getRow(totalsRow).getCell(8).numFmt = ACCOUNTING_FMT;
    setRight(ws, totalsRow, 8);

    if (lastDataRow >= 5) applyZebra(ws, 5, lastDataRow, 9);
    styleTotalsRow(ws, totalsRow, 9);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=\"matter-aging.xlsx\"");
    const buf = await wb.xlsx.writeBuffer();
    res.send(Buffer.from(buf as ArrayBuffer));
    return;
  }

  res.json({ buckets: bucketTotals, grandTotal: Number(enriched.reduce((s, i: any) => s + num(i.amountDue), 0).toFixed(2)) });
});

// ── Time Summary Report ────────────────────────────────────────────────────────
router.get("/reports/time-summary", requireAuth, requireFirmUser, requirePermission("reports", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const r = req.rlsDb ?? db;
  const from = one((req.query as any).from);
  const to = one((req.query as any).to);
  if (from && !isYmd(from)) { res.status(400).json({ error: "Invalid from date (YYYY-MM-DD)" }); return; }
  if (to && !isYmd(to)) { res.status(400).json({ error: "Invalid to date (YYYY-MM-DD)" }); return; }
  if (from && to && from > to) { res.status(400).json({ error: "Invalid date range" }); return; }
  const { timeEntriesTable } = await import("@workspace/db");
  let cond = eq(timeEntriesTable.firmId, req.firmId!);
  if (from) cond = and(cond, sql`entry_date >= ${from}`) as any;
  if (to)   cond = and(cond, sql`entry_date <= ${to}`) as any;

  const [summary] = await r.select({
    totalHours: sql<string>`COALESCE(SUM(hours), 0)`,
    totalAmount: sql<string>`COALESCE(SUM(hours * rate_per_hour), 0)`,
    billableHours: sql<string>`COALESCE(SUM(CASE WHEN is_billable THEN hours ELSE 0 END), 0)`,
    unbilledAmount: sql<string>`COALESCE(SUM(CASE WHEN is_billable AND NOT is_billed THEN hours * rate_per_hour ELSE 0 END), 0)`,
  }).from(timeEntriesTable).where(cond);

  const byUser = await r.select({
    userId: timeEntriesTable.userId,
    hours: sql<string>`COALESCE(SUM(hours), 0)`,
    amount: sql<string>`COALESCE(SUM(hours * rate_per_hour), 0)`,
  }).from(timeEntriesTable).where(cond).groupBy(timeEntriesTable.userId);

  res.json({ summary, byUser });
});

const exportedRouter = expressRouter as unknown as ExpressRouter;
export default exportedRouter;
