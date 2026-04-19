import { sql } from "@workspace/db";
import { listDocumentVariables } from "./documentVariables";

type DbConn = { execute: (q: any) => any };

async function queryRows(r: DbConn, query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await r.execute(query);
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object" && "rows" in result) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

export const CLAUSE_CATEGORIES = [
  "SPA",
  "Loan",
  "Banking",
  "Property",
  "Litigation",
  "Corporate",
  "General",
  "Special Condition",
] as const;

export type ClauseStatus = "draft" | "active" | "archived";
export type ClauseScope = "platform" | "firm";

export type ClauseRow = {
  id: number;
  scope: ClauseScope;
  firmId: number | null;
  sourcePlatformClauseId: number | null;
  clauseCode: string;
  title: string;
  category: string;
  language: string;
  body: string;
  notes: string | null;
  tags: string[];
  status: ClauseStatus;
  isSystem: boolean;
  sortOrder: number;
  applicability: Record<string, unknown> | null;
  createdBy: number | null;
  updatedBy: number | null;
  createdAt: string;
  updatedAt: string;
};

export function normalizeClauseCode(input: string): string {
  const raw = String(input ?? "").trim();
  const upper = raw.toUpperCase();
  const cleaned = upper.replace(/[^A-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "CLAUSE";
}

export function scanPlaceholdersInText(text: string): string[] {
  const out: string[] = [];
  const re = /\{\{\s*([^{}\s]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const k = m[1] ? String(m[1]).trim() : "";
    if (!k) continue;
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

export async function findUnknownVariablesInClause(r: DbConn, body: string): Promise<{ variables: string[]; unknown: string[] }> {
  const variables = scanPlaceholdersInText(body);
  const defs = await listDocumentVariables(r, { active: true });
  const known = new Set(defs.map((d) => d.key));
  const unknown = variables.filter((k) => !known.has(k));
  return { variables, unknown };
}

export function renderClauseBodyWithResolvedVariables(params: {
  body: string;
  resolvedVariables: Record<string, unknown>;
}): { rendered: string; used: string[]; missing: string[] } {
  const used: string[] = [];
  const missing: string[] = [];
  const rendered = params.body.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (_m, keyRaw: string) => {
    const key = String(keyRaw).trim();
    if (!key) return "";
    if (!used.includes(key)) used.push(key);
    const v = (params.resolvedVariables as any)[key];
    const str = v === null || v === undefined ? "" : String(v);
    if (!str.trim()) {
      if (!missing.includes(key)) missing.push(key);
    }
    return str;
  });
  return { rendered, used, missing };
}

export function isClauseApplicable(applicability: Record<string, unknown> | null, caseContext: Record<string, unknown>): boolean {
  if (!applicability) return true;
  const purchaseMode = typeof applicability.purchaseMode === "string" ? applicability.purchaseMode : null;
  const titleType = typeof applicability.titleType === "string" ? applicability.titleType : null;
  const caseType = typeof applicability.caseType === "string" ? applicability.caseType : null;
  const bank = typeof applicability.bank === "string" ? applicability.bank : null;
  const projectType = typeof applicability.projectType === "string" ? applicability.projectType : null;

  const ctxPurchase = typeof (caseContext as any).purchase_mode === "string" ? String((caseContext as any).purchase_mode) : null;
  const ctxTitle = typeof (caseContext as any).title_type === "string" ? String((caseContext as any).title_type) : null;
  const ctxCaseType = typeof (caseContext as any).case_type === "string" ? String((caseContext as any).case_type) : null;
  const ctxBank = typeof (caseContext as any).end_financier === "string" ? String((caseContext as any).end_financier) : null;
  const ctxProjectType = typeof (caseContext as any).project_type === "string" ? String((caseContext as any).project_type) : null;

  if (purchaseMode && purchaseMode !== "both" && ctxPurchase && purchaseMode !== ctxPurchase) return false;
  if (titleType && titleType !== "any" && ctxTitle && titleType !== ctxTitle) return false;
  if (caseType && ctxCaseType && caseType !== ctxCaseType) return false;
  if (projectType && ctxProjectType && projectType !== ctxProjectType) return false;
  if (bank && ctxBank && bank.toLowerCase() !== ctxBank.toLowerCase()) return false;
  return true;
}

export async function getPlatformClauseById(r: DbConn, id: number): Promise<Record<string, unknown> | null> {
  const rows = await queryRows(r, sql`SELECT * FROM platform_clauses WHERE id = ${id} LIMIT 1`);
  return rows[0] ?? null;
}

export async function getFirmClauseById(r: DbConn, firmId: number, id: number): Promise<Record<string, unknown> | null> {
  const rows = await queryRows(r, sql`SELECT * FROM firm_clauses WHERE firm_id = ${firmId} AND id = ${id} LIMIT 1`);
  return rows[0] ?? null;
}
