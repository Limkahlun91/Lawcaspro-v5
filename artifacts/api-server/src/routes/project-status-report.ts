import express, { type Response, type Router as ExpressRouter } from "express";
import ExcelJS from "exceljs";
import OpenAI from "openai";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  caseAssignmentsTable,
  casePurchasersTable,
  casesTable,
  clientsTable,
  projectsTable,
  invoicesTable,
  receiptsTable,
  usersTable,
} from "@workspace/db";
import { requireAuth, requireFirmUser, requirePermission, writeAuditLog, type AuthRequest } from "../lib/auth.js";
import { logger } from "../lib/logger.js";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";

const router: ExpressRouter = express.Router();

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const isYmd = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v);

const ACCOUNTING_FMT = `_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)`;

const STAGES = [
  "1. Intake Sandbox",
  "2. SPA Drafting",
  "3. Pending Signing",
  "4. SPA Signed & Stamped",
  "5. Loan Execution",
  "6. Pending Presentation",
  "7. Fully Completed",
] as const;

type StageLabel = (typeof STAGES)[number];

const toYmd = (v: unknown): string | null => {
  if (!v) return null;
  if (typeof v === "string") return v.slice(0, 10);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

function stageForCaseStatus(statusRaw: unknown): StageLabel {
  const s = String(statusRaw ?? "").toLowerCase();
  if (s.includes("sandbox") || s.includes("intake")) return "1. Intake Sandbox";
  if (s.includes("draft")) return "2. SPA Drafting";
  if (s.includes("pending signing") || s.includes("signing")) return "3. Pending Signing";
  if (s.includes("stamped") || (s.includes("spa") && s.includes("signed"))) return "4. SPA Signed & Stamped";
  if (s.includes("loan") && (s.includes("execut") || s.includes("docs") || s.includes("bank"))) return "5. Loan Execution";
  if (s.includes("presentation")) return "6. Pending Presentation";
  if (s.includes("fully completed") || s.includes("completed")) return "7. Fully Completed";
  return "3. Pending Signing";
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  const needs = /[",\n\r]/.test(s);
  const escaped = s.replace(/"/g, "\"\"");
  return needs ? `"${escaped}"` : escaped;
}

type ReportFilters = {
  projectId?: number;
  staffId?: number;
  startDate?: string;
  endDate?: string;
};

function parseFilters(req: AuthRequest): { filters: ReportFilters; format?: string } | { error: string } {
  const projectIdRaw = one((req.query as any).projectId);
  const staffIdRaw = one((req.query as any).staffId);
  const startDate = one((req.query as any).startDate);
  const endDate = one((req.query as any).endDate);
  const format = one((req.query as any).format);

  const projectId = projectIdRaw ? Number.parseInt(projectIdRaw, 10) : undefined;
  const staffId = staffIdRaw ? Number.parseInt(staffIdRaw, 10) : undefined;

  if (projectIdRaw && (!Number.isFinite(projectId!) || projectId! <= 0)) return { error: "Invalid projectId" };
  if (staffIdRaw && (!Number.isFinite(staffId!) || staffId! <= 0)) return { error: "Invalid staffId" };
  if (startDate && !isYmd(startDate)) return { error: "Invalid startDate (YYYY-MM-DD)" };
  if (endDate && !isYmd(endDate)) return { error: "Invalid endDate (YYYY-MM-DD)" };
  if (startDate && endDate && startDate > endDate) return { error: "Invalid date range" };

  return {
    filters: {
      ...(projectId ? { projectId } : {}),
      ...(staffId ? { staffId } : {}),
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
    },
    ...(format ? { format } : {}),
  };
}

async function buildProjectStatusReport(r: any, firmId: number, filters: ReportFilters) {
  let cond: any = and(eq(casesTable.firmId, firmId), isNull(casesTable.deletedAt));
  if (filters.projectId) cond = and(cond, eq(casesTable.projectId, filters.projectId)) as any;
  if (filters.startDate) cond = and(cond, sql`date(${casesTable.createdAt}) >= ${filters.startDate}`) as any;
  if (filters.endDate) cond = and(cond, sql`date(${casesTable.createdAt}) <= ${filters.endDate}`) as any;

  const baseCases = await r
    .select({
      caseId: casesTable.id,
      firmId: casesTable.firmId,
      projectId: casesTable.projectId,
      developerId: casesTable.developerId,
      referenceNo: casesTable.referenceNo,
      parcelNo: casesTable.parcelNo,
      status: casesTable.status,
      createdAt: casesTable.createdAt,
      projectName: projectsTable.name,
    })
    .from(casesTable)
    .innerJoin(projectsTable, eq(projectsTable.id, casesTable.projectId))
    .where(cond)
    .orderBy(desc(casesTable.createdAt));

  const caseIds = baseCases.map((c: any) => c.caseId);
  if (caseIds.length === 0) {
    return {
      kpi: { totalCases: 0, totalInvoiced: 0, totalCollected: 0, outstandingBalance: 0 },
      milestoneStages: STAGES.map((label) => ({ label, count: 0 })),
      rows: [],
    };
  }

  const [purchaserRows, assignmentRows, invoiceAggRows, receiptAggRows] = await Promise.all([
    r
      .select({
        caseId: casePurchasersTable.caseId,
        orderNo: casePurchasersTable.orderNo,
        clientName: clientsTable.name,
      })
      .from(casePurchasersTable)
      .innerJoin(clientsTable, eq(clientsTable.id, casePurchasersTable.clientId))
      .where(inArray(casePurchasersTable.caseId, caseIds)),
    r
      .select({
        caseId: caseAssignmentsTable.caseId,
        userId: caseAssignmentsTable.userId,
        roleInCase: caseAssignmentsTable.roleInCase,
        assignedAt: caseAssignmentsTable.assignedAt,
        unassignedAt: caseAssignmentsTable.unassignedAt,
        userName: usersTable.name,
      })
      .from(caseAssignmentsTable)
      .innerJoin(usersTable, eq(usersTable.id, caseAssignmentsTable.userId))
      .where(and(inArray(caseAssignmentsTable.caseId, caseIds), isNull(caseAssignmentsTable.unassignedAt)))
      .orderBy(desc(caseAssignmentsTable.assignedAt)),
    r
      .select({
        caseId: invoicesTable.caseId,
        totalFees: sql<string>`COALESCE(SUM(${invoicesTable.grandTotal}), 0)`,
        amountPaid: sql<string>`COALESCE(SUM(${invoicesTable.amountPaid}), 0)`,
        balanceDue: sql<string>`COALESCE(SUM(${invoicesTable.amountDue}), 0)`,
      })
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.firmId, firmId),
          isNull(invoicesTable.deletedAt),
          sql`${invoicesTable.status} IN ('issued','partially_paid','paid')`,
          inArray(invoicesTable.caseId, caseIds),
          ...(filters.startDate ? [sql`${invoicesTable.issuedDate} >= ${filters.startDate}`] : []),
          ...(filters.endDate ? [sql`${invoicesTable.issuedDate} <= ${filters.endDate}`] : []),
        ),
      )
      .groupBy(invoicesTable.caseId),
    r
      .select({
        caseId: receiptsTable.caseId,
        totalCollected: sql<string>`COALESCE(SUM(${receiptsTable.amount}), 0)`,
      })
      .from(receiptsTable)
      .where(
        and(
          eq(receiptsTable.firmId, firmId),
          eq(receiptsTable.isReversed, false),
          inArray(receiptsTable.caseId, caseIds),
          ...(filters.startDate ? [sql`${receiptsTable.receivedDate} >= ${filters.startDate}`] : []),
          ...(filters.endDate ? [sql`${receiptsTable.receivedDate} <= ${filters.endDate}`] : []),
        ),
      )
      .groupBy(receiptsTable.caseId),
  ]);

  const purchaserByCaseId = new Map<number, string>();
  for (const p of purchaserRows as any[]) {
    const cid = Number(p.caseId);
    if (!Number.isFinite(cid)) continue;
    const name = typeof p.clientName === "string" ? p.clientName : "";
    if (!name) continue;
    const existing = purchaserByCaseId.get(cid);
    if (!existing) purchaserByCaseId.set(cid, name);
  }

  const assignmentByCaseId = new Map<number, string>();
  const roleScore = (role: unknown): number => {
    const r = String(role ?? "").toLowerCase();
    if (r === "lawyer") return 3;
    if (r === "partner") return 2;
    if (r === "clerk") return 1;
    return 0;
  };
  const bestByCaseId = new Map<number, { name: string; score: number }>();
  for (const a of assignmentRows as any[]) {
    const cid = Number(a.caseId);
    if (!Number.isFinite(cid)) continue;
    const name = typeof a.userName === "string" ? a.userName : "";
    if (!name) continue;
    const score = roleScore(a.roleInCase);
    const cur = bestByCaseId.get(cid);
    if (!cur || score > cur.score) bestByCaseId.set(cid, { name, score });
  }
  for (const [cid, v] of bestByCaseId) assignmentByCaseId.set(cid, v.name);

  const invoiceAggByCaseId = new Map<number, { totalFees: number; amountPaid: number; balanceDue: number }>();
  for (const row of invoiceAggRows as any[]) {
    const cid = Number(row.caseId);
    if (!Number.isFinite(cid)) continue;
    invoiceAggByCaseId.set(cid, {
      totalFees: num(row.totalFees),
      amountPaid: num(row.amountPaid),
      balanceDue: num(row.balanceDue),
    });
  }

  const collectedByCaseId = new Map<number, number>();
  for (const row of receiptAggRows as any[]) {
    const cid = Number(row.caseId);
    if (!Number.isFinite(cid)) continue;
    collectedByCaseId.set(cid, num(row.totalCollected));
  }

  const filtered = filters.staffId
    ? baseCases.filter((c: any) => {
        const a = assignmentRows.find((x: any) => Number(x.caseId) === Number(c.caseId) && Number(x.userId) === filters.staffId);
        return Boolean(a);
      })
    : baseCases;

  const rows = filtered.map((c: any) => {
    const inv = invoiceAggByCaseId.get(c.caseId) ?? { totalFees: 0, amountPaid: 0, balanceDue: 0 };
    const stage = stageForCaseStatus(c.status);
    return {
      fileRef: String(c.referenceNo ?? ""),
      projectName: String(c.projectName ?? ""),
      unitNo: String(c.parcelNo ?? ""),
      purchaserName: purchaserByCaseId.get(c.caseId) ?? "",
      assignedStaff: assignmentByCaseId.get(c.caseId) ?? "",
      currentStatus: String(c.status ?? ""),
      milestoneStage: stage,
      totalFeesRm: Number(inv.totalFees.toFixed(2)),
      amountPaidRm: Number(inv.amountPaid.toFixed(2)),
      balanceDueRm: Number(inv.balanceDue.toFixed(2)),
      collectedRm: Number((collectedByCaseId.get(c.caseId) ?? 0).toFixed(2)),
    };
  });

  const totalCases = rows.length;
  const totalInvoiced = rows.reduce((s, r) => s + num(r.totalFeesRm), 0);
  const totalCollected = rows.reduce((s, r) => s + num(r.collectedRm), 0);
  const outstandingBalance = rows.reduce((s, r) => s + num(r.balanceDueRm), 0);

  const stageCounts = new Map<StageLabel, number>();
  for (const s of STAGES) stageCounts.set(s, 0);
  for (const r0 of rows) stageCounts.set(r0.milestoneStage, (stageCounts.get(r0.milestoneStage) ?? 0) + 1);

  return {
    kpi: {
      totalCases,
      totalInvoiced: Number(totalInvoiced.toFixed(2)),
      totalCollected: Number(totalCollected.toFixed(2)),
      outstandingBalance: Number(outstandingBalance.toFixed(2)),
    },
    milestoneStages: STAGES.map((label) => ({ label, count: stageCounts.get(label) ?? 0 })),
    rows,
  };
}

function setHeaderRow(ws: ExcelJS.Worksheet, rowIdx: number, labels: string[]) {
  const row = ws.getRow(rowIdx);
  row.values = ["", ...labels];
  row.font = { bold: true, color: { argb: "FF1B365D" } };
  row.alignment = { vertical: "middle", horizontal: "center" };
  row.height = 18;
}

function setNumberCell(ws: ExcelJS.Worksheet, row: number, col: number, value: number) {
  const cell = ws.getRow(row).getCell(col);
  cell.value = value;
  cell.numFmt = ACCOUNTING_FMT;
  cell.alignment = { horizontal: "right", vertical: "middle" };
}

async function renderWeasyPrintPdf(html: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "lawcaspro-report-"));
  const htmlPath = join(dir, "input.html");
  const pdfPath = join(dir, "output.pdf");
  const scriptPath = new URL("../../scripts/weasyprint_render.py", import.meta.url);
  try {
    await writeFile(htmlPath, html, "utf8");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("python", [scriptPath.pathname, htmlPath, pdfPath], { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => { stderr += String(d); });
      child.on("error", (e) => reject(e));
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr || `WeasyPrint exited with code ${code}`));
      });
    });
    return await readFile(pdfPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function buildPdfHtml(payload: any): string {
  const navy = "#1B365D";
  const kpi = payload.kpi ?? {};
  const rows = Array.isArray(payload.rows) ? payload.rows : [];

  const money = (v: unknown) => Number(v ?? 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const kpiTable = `
    <table class="kpi" cellspacing="0" cellpadding="0">
      <tr>
        <td>
          <div class="kpi-label">Total Cases</div>
          <div class="kpi-value">${esc(kpi.totalCases)}</div>
        </td>
        <td>
          <div class="kpi-label">Total Invoiced (RM)</div>
          <div class="kpi-value money">${money(kpi.totalInvoiced)}</div>
        </td>
        <td>
          <div class="kpi-label">Total Collected (RM)</div>
          <div class="kpi-value money">${money(kpi.totalCollected)}</div>
        </td>
        <td>
          <div class="kpi-label">Outstanding Balance (RM)</div>
          <div class="kpi-value money">${money(kpi.outstandingBalance)}</div>
        </td>
      </tr>
    </table>
  `;

  const bodyRows = rows.map((r: any) => `
    <tr>
      <td class="center">${esc(r.fileRef)}</td>
      <td>${esc(r.projectName)}</td>
      <td class="center">${esc(r.unitNo)}</td>
      <td>${esc(r.purchaserName)}</td>
      <td class="center">${esc(r.assignedStaff)}</td>
      <td>${esc(r.currentStatus)}</td>
      <td class="right">${money(r.totalFeesRm)}</td>
      <td class="right">${money(r.amountPaidRm)}</td>
      <td class="right">${money(r.balanceDueRm)}</td>
    </tr>
  `).join("");

  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    @page { size: A4; margin: 14mm; }
    body { font-family: Arial, sans-serif; font-size: 11px; color: #0f1729; }
    h1 { margin: 0 0 8px 0; font-size: 16px; color: ${navy}; }
    .meta { margin: 0 0 10px 0; color: #334155; font-size: 10px; }
    .kpi { width: 100%; table-layout: fixed; border-collapse: collapse; margin-bottom: 10px; }
    .kpi td { background: #f1f5f9; border: 1px solid #e2e8f0; padding: 10px; vertical-align: top; }
    .kpi-label { font-size: 10px; color: #475569; }
    .kpi-value { font-size: 14px; font-weight: 700; color: ${navy}; margin-top: 4px; }
    .kpi-value.money { text-align: right; }
    table.report { width: 100%; border-collapse: collapse; table-layout: fixed; }
    table.report th { background: ${navy}; color: #ffffff; font-size: 10px; padding: 6px; border: 1px solid #163154; text-align: left; }
    table.report td { border: 1px solid #e2e8f0; padding: 6px; vertical-align: top; }
    .right { text-align: right; }
    .center { text-align: center; }
  </style>
</head>
<body>
  <h1>Project Status & Case Analytics Report</h1>
  <div class="meta">Generated on ${esc(new Date().toISOString().slice(0, 10))}</div>
  ${kpiTable}
  <table class="report" cellspacing="0" cellpadding="0">
    <thead>
      <tr>
        <th style="width: 10%;">File Ref</th>
        <th style="width: 16%;">Project Name</th>
        <th style="width: 8%;">Unit No.</th>
        <th style="width: 16%;">Purchaser Name</th>
        <th style="width: 12%;">Assigned Staff</th>
        <th style="width: 18%;">Current Status</th>
        <th style="width: 7%;">Total Fees (RM)</th>
        <th style="width: 7%;">Amount Paid (RM)</th>
        <th style="width: 6%;">Balance Due (RM)</th>
      </tr>
    </thead>
    <tbody>
      ${bodyRows}
    </tbody>
  </table>
</body>
</html>
  `.trim();
}

router.get("/reports/project-status", requireAuth, requireFirmUser, requirePermission("reports", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const r = req.rlsDb;
  if (!r) { res.status(500).json({ error: "Internal Server Error" }); return; }
  const parsed = parseFilters(req);
  if ("error" in parsed) { res.status(400).json({ error: parsed.error }); return; }

  const payload = await buildProjectStatusReport(r, req.firmId!, parsed.filters);

  if (parsed.format === "csv") {
    const lines: string[] = [];
    lines.push([
      "File Ref",
      "Project Name",
      "Unit No.",
      "Purchaser Name",
      "Assigned Staff",
      "Current Status",
      "Total Fees (RM)",
      "Amount Paid (RM)",
      "Balance Due (RM)",
    ].join(","));
    for (const row of payload.rows as any[]) {
      lines.push([
        csvCell(row.fileRef),
        csvCell(row.projectName),
        csvCell(row.unitNo),
        csvCell(row.purchaserName),
        csvCell(row.assignedStaff),
        csvCell(row.currentStatus),
        csvCell(Number(row.totalFeesRm ?? 0).toFixed(2)),
        csvCell(Number(row.amountPaidRm ?? 0).toFixed(2)),
        csvCell(Number(row.balanceDueRm ?? 0).toFixed(2)),
      ].join(","));
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=\"project-status-report.csv\"");
    res.send(lines.join("\n"));
    return;
  }

  if (parsed.format === "xlsx") {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Project Status");
    ws.properties.defaultRowHeight = 16;
    ws.getColumn(1).width = 14;
    ws.getColumn(2).width = 22;
    ws.getColumn(3).width = 10;
    ws.getColumn(4).width = 26;
    ws.getColumn(5).width = 18;
    ws.getColumn(6).width = 28;
    ws.getColumn(7).width = 16;
    ws.getColumn(8).width = 16;
    ws.getColumn(9).width = 16;

    setHeaderRow(ws, 3, [
      "File Ref",
      "Project Name",
      "Unit No.",
      "Purchaser Name",
      "Assigned Staff",
      "Current Status",
      "Total Fees (RM)",
      "Amount Paid (RM)",
      "Balance Due (RM)",
    ]);

    let rowIdx = 4;
    for (const row of payload.rows as any[]) {
      ws.getRow(rowIdx).getCell(1).value = String(row.fileRef ?? "");
      ws.getRow(rowIdx).getCell(2).value = String(row.projectName ?? "");
      ws.getRow(rowIdx).getCell(3).value = String(row.unitNo ?? "");
      ws.getRow(rowIdx).getCell(4).value = String(row.purchaserName ?? "");
      ws.getRow(rowIdx).getCell(5).value = String(row.assignedStaff ?? "");
      ws.getRow(rowIdx).getCell(6).value = String(row.currentStatus ?? "");
      setNumberCell(ws, rowIdx, 7, num(row.totalFeesRm));
      setNumberCell(ws, rowIdx, 8, num(row.amountPaidRm));
      setNumberCell(ws, rowIdx, 9, num(row.balanceDueRm));

      ws.getRow(rowIdx).getCell(1).alignment = { horizontal: "center", vertical: "middle" };
      ws.getRow(rowIdx).getCell(3).alignment = { horizontal: "center", vertical: "middle" };
      ws.getRow(rowIdx).getCell(5).alignment = { horizontal: "center", vertical: "middle" };
      ws.getRow(rowIdx).getCell(6).alignment = { horizontal: "left", vertical: "middle" };
      ws.getRow(rowIdx).getCell(2).alignment = { horizontal: "left", vertical: "middle" };
      ws.getRow(rowIdx).getCell(4).alignment = { horizontal: "left", vertical: "middle" };

      rowIdx++;
    }

    const firstDataRow = 4;
    const lastDataRow = rowIdx - 1;
    const totalsRow = rowIdx;
    ws.getRow(totalsRow).font = { bold: true };
    ws.getRow(totalsRow).getCell(1).value = "Totals";
    ws.mergeCells(totalsRow, 1, totalsRow, 6);
    ws.getRow(totalsRow).getCell(6).alignment = { horizontal: "right", vertical: "middle" };
    const sum = (col: number) => ({ formula: `SUM(${ws.getColumn(col).letter}${firstDataRow}:${ws.getColumn(col).letter}${lastDataRow})` });
    ws.getRow(totalsRow).getCell(7).value = sum(7);
    ws.getRow(totalsRow).getCell(8).value = sum(8);
    ws.getRow(totalsRow).getCell(9).value = sum(9);
    for (const c of [7, 8, 9]) {
      ws.getRow(totalsRow).getCell(c).numFmt = ACCOUNTING_FMT;
      ws.getRow(totalsRow).getCell(c).alignment = { horizontal: "right", vertical: "middle" };
    }

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=\"project-status-report.xlsx\"");
    const buf = await wb.xlsx.writeBuffer();
    res.send(Buffer.from(buf as ArrayBuffer));
    return;
  }

  res.json(payload);
});

router.get("/reports/project-status/download-pdf", requireAuth, requireFirmUser, requirePermission("reports", "read"), async (req: AuthRequest, res: Response): Promise<void> => {
  const r = req.rlsDb;
  if (!r) { res.status(500).json({ error: "Internal Server Error" }); return; }
  const parsed = parseFilters(req);
  if ("error" in parsed) { res.status(400).json({ error: parsed.error }); return; }

  const payload = await buildProjectStatusReport(r, req.firmId!, parsed.filters);
  const html = buildPdfHtml(payload);

  try {
    const pdf = await renderWeasyPrintPdf(html);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=\"project-status-report.pdf\"");
    res.send(pdf);
  } catch (err) {
    logger.error({ err, firmId: req.firmId, userId: req.userId }, "[reports.project-status.pdf] weasyprint failed");
    res.status(501).json({ error: "PDF generation is not available on this server. Please install Python + WeasyPrint." });
  }
});

const AiMakeBody = z.object({
  instruction: z.string().trim().min(1),
  projectId: z.number().int().positive().optional(),
  staffId: z.number().int().positive().optional(),
  startDate: z.string().trim().optional(),
  endDate: z.string().trim().optional(),
});

router.post("/reports/project-status/ai-make", requireAuth, requireFirmUser, requirePermission("reports", "read"), express.json({ limit: "2mb" }), async (req: AuthRequest, res: Response): Promise<void> => {
  const r = req.rlsDb;
  if (!r) { res.status(500).json({ error: "Internal Server Error" }); return; }

  try {
    const parsed = AiMakeBody.parse(req.body);
    const filters: ReportFilters = {
      ...(parsed.projectId ? { projectId: parsed.projectId } : {}),
      ...(parsed.staffId ? { staffId: parsed.staffId } : {}),
      ...(parsed.startDate && isYmd(parsed.startDate) ? { startDate: parsed.startDate } : {}),
      ...(parsed.endDate && isYmd(parsed.endDate) ? { endDate: parsed.endDate } : {}),
    };

    const data = await buildProjectStatusReport(r, req.firmId!, filters);
    const openaiKey = process.env.OPENAI_API_KEY ? String(process.env.OPENAI_API_KEY) : "";
    const geminiKey = process.env.GEMINI_API_KEY ? String(process.env.GEMINI_API_KEY) : "";

    const system = [
      "You are a senior commercial legal advisor at a top-tier Malaysian law firm (conveyancing practice).",
      "Regardless of the language used by the user, you MUST respond in strict professional legal English only.",
      "Return a clean HTML document fragment (no Markdown, no code fences).",
      "Use concise headings, bullet points, and short tables where appropriate.",
      "Do not invent numbers. Only use the provided JSON data.",
    ].join("\n");

    const user = [
      "User instruction:",
      parsed.instruction,
      "",
      "Data (JSON):",
      JSON.stringify(data),
    ].join("\n");

    let html = "";

    if (openaiKey) {
      const model = String(process.env.OPENAI_MODEL || "gpt-4o-mini");
      const client = new OpenAI({ apiKey: openaiKey });
      const completion = await client.chat.completions.create({
        model,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });
      html = String(completion.choices?.[0]?.message?.content ?? "").trim();
    } else if (geminiKey) {
      const model = String(process.env.GEMINI_MODEL || "gemini-1.5-flash");
      const prompt = [system, "", user].join("\n");
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiKey)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2 },
          }),
        },
      );
      const json = (await resp.json().catch(() => ({}))) as any;
      html = String(json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim();
    } else {
      const kpi = data.kpi;
      html = [
        `<h2>Executive Summary</h2>`,
        `<p>This report summarises current project progress and case-level financial exposure for internal management review.</p>`,
        `<table style="width:100%;border-collapse:collapse;">`,
        `<tr><th style="text-align:left;border-bottom:1px solid #e2e8f0;">KPI</th><th style="text-align:right;border-bottom:1px solid #e2e8f0;">Value</th></tr>`,
        `<tr><td>Total Cases</td><td style="text-align:right;">${kpi.totalCases}</td></tr>`,
        `<tr><td>Total Invoiced (RM)</td><td style="text-align:right;">${kpi.totalInvoiced.toLocaleString("en-MY", { minimumFractionDigits: 2 })}</td></tr>`,
        `<tr><td>Total Collected (RM)</td><td style="text-align:right;">${kpi.totalCollected.toLocaleString("en-MY", { minimumFractionDigits: 2 })}</td></tr>`,
        `<tr><td>Outstanding Balance (RM)</td><td style="text-align:right;">${kpi.outstandingBalance.toLocaleString("en-MY", { minimumFractionDigits: 2 })}</td></tr>`,
        `</table>`,
        `<p><em>AI generation is disabled because no LLM API key is configured.</em></p>`,
      ].join("");
    }

    await writeAuditLog({
      firmId: req.firmId,
      actorId: req.userId,
      actorType: req.userType,
      action: "reports.project_status.ai_make",
      entityType: "report",
      entityId: null,
      detail: `projectId=${filters.projectId ?? ""} staffId=${filters.staffId ?? ""} startDate=${filters.startDate ?? ""} endDate=${filters.endDate ?? ""}`,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    res.json({ html });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid request";
    logger.error({ err, firmId: req.firmId, userId: req.userId }, "[reports.project-status.ai-make] failed");
    res.status(400).json({ error: msg });
  }
});

export default router;
