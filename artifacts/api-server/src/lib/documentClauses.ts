import { ensureDocxHasPlaceholderAtEnd } from "./docxPlaceholder";
import { getFirmClauseById, getPlatformClauseById, renderClauseBodyWithResolvedVariables, scanPlaceholdersInText } from "./clauseLibrary";

export type SelectedClauseRef = { scope: "platform" | "firm"; id: number; includeTitle?: boolean };

export type ClauseInsertionWarning = { clauseId: number; scope: "platform" | "firm"; unknownVariables: string[] };

export async function buildClauseInsertion(params: {
  r: { execute: (q: any) => any };
  firmId: number;
  selected: SelectedClauseRef[];
  resolvedVariables: Record<string, unknown>;
}): Promise<{
  clausesText: string;
  perClauseValues: Record<string, string>;
  warnings: ClauseInsertionWarning[];
}> {
  const selected = params.selected;
  const perClauseValues: Record<string, string> = {};
  const warnings: ClauseInsertionWarning[] = [];

  const blocks: string[] = [];
  for (const ref of selected) {
    const row = ref.scope === "platform"
      ? await getPlatformClauseById(params.r, ref.id)
      : await getFirmClauseById(params.r, params.firmId, ref.id);
    if (!row) continue;
    const clauseCode = typeof (row as any).clause_code === "string" ? String((row as any).clause_code) : String((row as any).clauseCode ?? "");
    const title = typeof (row as any).title === "string" ? String((row as any).title) : "";
    const body = typeof (row as any).body === "string" ? String((row as any).body) : "";

    const placeholders = scanPlaceholdersInText(body);
    const unknown = placeholders.filter((k) => !Object.prototype.hasOwnProperty.call(params.resolvedVariables, k));
    if (unknown.length) warnings.push({ clauseId: ref.id, scope: ref.scope, unknownVariables: unknown });

    const rendered = renderClauseBodyWithResolvedVariables({ body, resolvedVariables: params.resolvedVariables }).rendered;
    const block = (ref.includeTitle ? `${title}\n${rendered}` : rendered).trim();
    if (block) blocks.push(block);

    if (clauseCode) {
      const key = `clause_${clauseCode}`;
      perClauseValues[key] = block;
    }
  }

  return {
    clausesText: blocks.join("\n\n"),
    perClauseValues,
    warnings,
  };
}

export function applyClauseInsertionToDocx(params: {
  docxBytes: Buffer;
  data: Record<string, unknown>;
  clausesText: string;
  perClauseValues?: Record<string, string>;
}): { docxBytes: Buffer; data: Record<string, unknown> } {
  const per = params.perClauseValues ?? {};
  if (!params.clausesText.trim() && Object.keys(per).length === 0) return { docxBytes: params.docxBytes, data: params.data };
  const nextBytes = ensureDocxHasPlaceholderAtEnd(params.docxBytes, "clauses");
  const nextData = { ...params.data, ...per, clauses: params.clausesText };
  return { docxBytes: nextBytes, data: nextData };
}
