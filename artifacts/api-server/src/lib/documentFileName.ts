import { sql } from "drizzle-orm";
import { resolveSmartFilename, type SmartFilenamePreview, type SmartNamingContext } from "./smartFileNaming";

type DbConn = { execute: (q: any) => any };

async function queryRows(r: DbConn, query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await r.execute(query);
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object" && "rows" in result) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

export function sanitizeDocumentFileName(input: string, fallbackExt: string): string {
  return resolveSmartFilename({
    ctx: { caseId: 0, firmId: 0, documentName: "Document" },
    rule: input,
    originalFileNameOrExt: fallbackExt,
    fallbackExt,
  }).fileName;
}

export function resolveDocumentFileName(params: {
  ctx: SmartNamingContext;
  rule?: string | null;
  originalFileNameOrExt?: string | null;
  fallbackExt: string;
}): SmartFilenamePreview {
  return resolveSmartFilename(params);
}

export async function ensureUniqueCaseDocumentFileName(params: {
  r: DbConn;
  firmId: number;
  caseId: number;
  desiredFileName: string;
}): Promise<{ fileName: string; collisionResolved: boolean; collisionSuffixApplied: number | null }> {
  const desired = String(params.desiredFileName || "").trim() || "Document.docx";
  const dot = desired.lastIndexOf(".");
  const base = dot > 0 ? desired.slice(0, dot) : desired;
  const ext = dot > 0 ? desired.slice(dot) : "";

  const first = await queryRows(params.r, sql`
    SELECT id
    FROM case_documents
    WHERE firm_id = ${params.firmId} AND case_id = ${params.caseId} AND file_name = ${desired}
    LIMIT 1
  `);
  if (!first[0]) return { fileName: desired, collisionResolved: false, collisionSuffixApplied: null };

  for (let i = 2; i <= 9999; i += 1) {
    const candidate = `${base} (${i})${ext}`;
    const rows = await queryRows(params.r, sql`
      SELECT id
      FROM case_documents
      WHERE firm_id = ${params.firmId} AND case_id = ${params.caseId} AND file_name = ${candidate}
      LIMIT 1
    `);
    if (!rows[0]) {
      return { fileName: candidate, collisionResolved: true, collisionSuffixApplied: i };
    }
  }

  const ts = Date.now();
  return { fileName: `${base} (${ts})${ext}`, collisionResolved: true, collisionSuffixApplied: ts };
}

