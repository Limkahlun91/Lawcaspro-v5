import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PV_PATH = resolve(__dirname, "../routes/payment-vouchers.ts");
const pvSrc = readFileSync(PV_PATH, "utf8");

const CASES_PATH = resolve(__dirname, "../routes/cases.ts");
const casesSrc = readFileSync(CASES_PATH, "utf8");

const REPORTS_PATH = resolve(__dirname, "../routes/reports.ts");
const reportsSrc = readFileSync(REPORTS_PATH, "utf8");

describe("4A: Case Ledger (/cases/:caseId/ledger) — dedicated case context", () => {
  it("Case Ledger route handler uses WHERE eq(caseLedgersTable.firmId, req.firmId!) AND eq(caseLedgersTable.caseId, params.data.caseId) — strict case context", () => {
    expect(casesSrc).toMatch(/\/cases\/:caseId\/ledger[\s\S]*?where\(and\(eq\(caseLedgersTable\.firmId,\s*req\.firmId!\),\s*eq\(caseLedgersTable\.caseId,\s*params\.data\.caseId\)\)/);
  });
  it("Case Ledger select retains sourceType + sourceId so drill-through back to accounting source (invoice/receipt/pv) works", () => {
    expect(casesSrc).toMatch(/sourceType:\s*caseLedgersTable\.sourceType,[\s\S]*?sourceId:\s*caseLedgersTable\.sourceId,/);
  });
});

describe("4B: General Ledger (/ledger) caseReferenceNo enrichment 1-select no N+1 pattern", () => {
  it("General ledger list handler already uses canonical fail-closed getRlsDb(req,res); if (!r) return; — no fallback", () => {
    expect(pvSrc).toMatch(/router\.get\("\/ledger"[\s\S]*?const r\s*=\s*getRlsDb\(req,\s*res\);\s*if\s*\(\s*!r\s*\)\s*return;/);
  });
  it("After rows fetched: collects caseIds → dedup Array.from(new Set(...)) → single cases SELECT WHERE firmId + inArray caseIds", () => {
    expect(pvSrc).toMatch(/caseIds\.length\s*>\s*0[\s\S]*?distinctCaseIds\s*=\s*Array\.from\(new Set\(caseIds\)\)/);
    expect(pvSrc).toMatch(/from\(casesTable\)[\s\S]*?where\(and\(eq\(casesTable\.firmId,\s*req\.firmId!\),\s*inArray\(casesTable\.id,\s*distinctCaseIds\)\)/);
  });
  it("Maps each row → spreads original ledger row + adds explicit caseReferenceNo field populated from Map (null when no caseId)", () => {
    expect(pvSrc).toMatch(/const caseReferenceNo\s*=\s*Number\.isFinite\(cid\)\s*&&\s*cid\s*>\s*0\s*\?\s*\(caseRefById\.get\(cid\)\s*\?\?\s*null\)\s*:\s*null/);
    expect(pvSrc).toMatch(/return\s*\{\s*\.\.\.row,\s*caseReferenceNo\s*\}/);
  });
  it("Ledger summary endpoint (firm aggregate) does NOT attempt case-by-case enrichment — it's FIRM_AGGREGATE by design (accountType groups only)", () => {
    const block = pvSrc.match(/router\.get\("\/ledger\/summary"[\s\S]*?res\.json\(rows\)/)?.[0] ?? "";
    expect(block).toMatch(/groupBy\(accountTypeExpr\)/);
    expect(block).not.toContain("caseIds");
    expect(block).not.toContain("reference_no");
    expect(block).not.toContain("caseReferenceNo");
  });
});

describe("4C: Reports overview classification", () => {
  it("/reports/overview case counts, status, month — FIRM_AGGREGATE by definition (groups, counts, workload) → individual case reference NOT required", () => {
    expect(reportsSrc).toMatch(/casesByStatus[\s\S]*?groupBy\(casesTable\.status\)/);
    expect(reportsSrc).toContain("casesByMonth");
    expect(reportsSrc).toContain("monthExpr");
    expect(reportsSrc).toMatch(/TO_CHAR\([\s\S]*?'YYYY-MM'\)/);
    expect(reportsSrc).toMatch(/lawyerWorkload[\s\S]*?countDistinct\(caseAssignmentsTable\.caseId\)/);
  });
  it("workflowCompletion drilldown 10 rows returns CASE_BASED data with case_id AND reference_no (reference_no via casesTable.referenceNo select)", () => {
    expect(reportsSrc).toMatch(/workflowCompletion[\s\S]*?case_id:\s*casesTable\.id,[\s\S]*?reference_no:\s*casesTable\.referenceNo,[\s\S]*?innerJoin\(caseWorkflowStepsTable/);
  });
  it("Billing totals when canSeeAccounting uses computeInvoiceMetrics(firm-level OR assigned caseIds) → FIRM_AGGREGATE/team aggregate, no per-case row ref needed", () => {
    expect(reportsSrc).toMatch(/canSeeAccounting[\s\S]*?computeInvoiceMetrics/);
  });
  it("reports.ts overview helper now uses canonical fail-closed getRlsDb(req, res); if (!r) return; — 0 fallbacks", () => {
    expect(reportsSrc).not.toMatch(/req\.rlsDb\s*\?\?\s*db/);
    expect(reportsSrc).toContain("const r = getRlsDb(req, res);");
    expect(reportsSrc).toMatch(/if\s*\(\s*!r\s*\)\s*return;/);
  });
});
