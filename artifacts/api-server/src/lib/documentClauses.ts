import { detectClausePlaceholders, ensureDocxHasPlaceholderAtEnd } from "./docxPlaceholder";
import { getFirmClauseById, getPlatformClauseById, renderClauseBodyWithResolvedVariables, scanPlaceholdersInText } from "./clauseLibrary";

export type SelectedClauseRef = { scope: "platform" | "firm"; id: number; includeTitle?: boolean };

export type ClauseInsertionWarning = { clauseId: number; scope: "platform" | "firm"; unknownVariables: string[] };

export type ClauseInsertionMode = "explicit_placeholder_only" | "append_to_end" | "prefer_placeholder_else_append";
export type ClauseInsertionTarget = "using {{clauses}}" | "using {{clause_CODE}}" | "appended to end" | "none";

export type DuplicateClauseWarning = { scope: "platform" | "firm"; id: number };

export type SelectedClauseResolved = {
  scope: "platform" | "firm";
  id: number;
  clauseCode: string;
  title: string;
  includeTitle: boolean;
  body: string;
  renderedBody: string;
  renderedBlock: string;
};

export function normalizeClauseInsertionMode(input: unknown): ClauseInsertionMode {
  if (input === "explicit_placeholder_only") return "explicit_placeholder_only";
  if (input === "append_to_end") return "append_to_end";
  if (input === "prefer_placeholder_else_append") return "prefer_placeholder_else_append";
  return "prefer_placeholder_else_append";
}

export function decideClauseInsertion(params: {
  mode: ClauseInsertionMode;
  hasClausesPlaceholder: boolean;
  foundClauseCodes: string[];
  selectedClauseCodes: string[];
}): { insertionModeUsed: ClauseInsertionMode; insertionTarget: ClauseInsertionTarget; insertionError: string | null } {
  const mode = params.mode;
  const selectedCodes = params.selectedClauseCodes.filter(Boolean);
  const foundSet = new Set(params.foundClauseCodes);
  const allClauseCodesPlaceholdersPresent = selectedCodes.length > 0 && selectedCodes.every((c) => foundSet.has(c));

  if (mode === "append_to_end") {
    return { insertionModeUsed: mode, insertionTarget: "appended to end", insertionError: null };
  }

  if (mode === "explicit_placeholder_only") {
    if (allClauseCodesPlaceholdersPresent) return { insertionModeUsed: mode, insertionTarget: "using {{clause_CODE}}", insertionError: null };
    if (params.hasClausesPlaceholder) return { insertionModeUsed: mode, insertionTarget: "using {{clauses}}", insertionError: null };
    return { insertionModeUsed: mode, insertionTarget: "none", insertionError: "No clause placeholder found. Add {{clauses}} or {{clause_CODE}} to the template, or change insertion mode." };
  }

  if (allClauseCodesPlaceholdersPresent) return { insertionModeUsed: mode, insertionTarget: "using {{clause_CODE}}", insertionError: null };
  if (params.hasClausesPlaceholder) return { insertionModeUsed: mode, insertionTarget: "using {{clauses}}", insertionError: null };
  return { insertionModeUsed: mode, insertionTarget: "appended to end", insertionError: null };
}

export async function buildClauseInsertion(params: {
  r: { execute: (q: any) => any };
  firmId: number;
  selected: SelectedClauseRef[];
  resolvedVariables: Record<string, unknown>;
}): Promise<{
  clauseOrder: SelectedClauseRef[];
  selectedClausesResolved: SelectedClauseResolved[];
  clausesText: string;
  perClauseValues: Record<string, string>;
  warnings: ClauseInsertionWarning[];
  duplicateClauseWarnings: DuplicateClauseWarning[];
}> {
  const perClauseValues: Record<string, string> = {};
  const warnings: ClauseInsertionWarning[] = [];
  const duplicateClauseWarnings: DuplicateClauseWarning[] = [];

  const seen = new Set<string>();
  const clauseOrder: SelectedClauseRef[] = [];
  for (const ref of params.selected) {
    const key = `${ref.scope}:${ref.id}`;
    if (seen.has(key)) {
      duplicateClauseWarnings.push({ scope: ref.scope, id: ref.id });
      continue;
    }
    seen.add(key);
    clauseOrder.push(ref);
  }

  const selectedClausesResolved: SelectedClauseResolved[] = [];
  const blocks: string[] = [];
  for (const ref of clauseOrder) {
    const row = ref.scope === "platform"
      ? await getPlatformClauseById(params.r, ref.id)
      : await getFirmClauseById(params.r, params.firmId, ref.id);
    if (!row) continue;
    const clauseCode = typeof (row as any).clause_code === "string" ? String((row as any).clause_code) : String((row as any).clauseCode ?? "");
    const title = typeof (row as any).title === "string" ? String((row as any).title) : "";
    const body = typeof (row as any).body === "string" ? String((row as any).body) : "";
    const includeTitle = Boolean(ref.includeTitle ?? false);

    const placeholders = scanPlaceholdersInText(body);
    const unknown = placeholders.filter((k) => !Object.prototype.hasOwnProperty.call(params.resolvedVariables, k));
    if (unknown.length) warnings.push({ clauseId: ref.id, scope: ref.scope, unknownVariables: unknown });

    const renderedBody = renderClauseBodyWithResolvedVariables({ body, resolvedVariables: params.resolvedVariables }).rendered;
    const renderedBlock = (includeTitle ? `${title}\n${renderedBody}` : renderedBody).trim();
    if (renderedBlock) blocks.push(renderedBlock);

    selectedClausesResolved.push({
      scope: ref.scope,
      id: ref.id,
      clauseCode,
      title,
      includeTitle,
      body,
      renderedBody,
      renderedBlock,
    });
  }

  for (const c of selectedClausesResolved) {
    if (!c.clauseCode) continue;
    perClauseValues[`clause_${c.clauseCode}`] = c.renderedBlock;
  }

  return {
    clauseOrder,
    selectedClausesResolved,
    clausesText: blocks.join("\n\n"),
    perClauseValues,
    warnings,
    duplicateClauseWarnings,
  };
}

export function applyClauseInsertionToDocx(params: {
  docxBytes: Buffer;
  data: Record<string, unknown>;
  clausesText: string;
  perClauseValues?: Record<string, string>;
  insertionMode: ClauseInsertionMode;
  selectedClauseCodes: string[];
}): { docxBytes: Buffer; data: Record<string, unknown> } {
  const per = params.perClauseValues ?? {};
  if (!params.clausesText.trim() && Object.keys(per).length === 0) return { docxBytes: params.docxBytes, data: params.data };

  const detection = detectClausePlaceholders(params.docxBytes, params.selectedClauseCodes);
  const decision = decideClauseInsertion({
    mode: params.insertionMode,
    hasClausesPlaceholder: detection.hasClausesPlaceholder,
    foundClauseCodes: detection.foundClauseCodes,
    selectedClauseCodes: params.selectedClauseCodes,
  });
  if (decision.insertionTarget === "none") {
    return { docxBytes: params.docxBytes, data: params.data };
  }

  if (decision.insertionTarget === "using {{clause_CODE}}") {
    const nextData = { ...params.data, ...per };
    return { docxBytes: params.docxBytes, data: nextData };
  }

  const emptyPer: Record<string, string> = {};
  for (const k of Object.keys(per)) emptyPer[k] = "";

  if (decision.insertionTarget === "using {{clauses}}") {
    const nextData = { ...params.data, ...emptyPer, clauses: params.clausesText };
    return { docxBytes: params.docxBytes, data: nextData };
  }

  const nextBytes = ensureDocxHasPlaceholderAtEnd(params.docxBytes, "clauses");
  const nextData = { ...params.data, ...emptyPer, clauses: params.clausesText };
  return { docxBytes: nextBytes, data: nextData };
}
