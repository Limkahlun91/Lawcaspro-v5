import type { TemplateBinding, VariableDefinition } from "./documentVariables";
import { listDocumentVariablesByKeys, resolveVariablesForTemplate } from "./documentVariables";
import { getFirmTemplateBindings, getPlatformDocumentBindings } from "./documentBindings";
import { sql } from "@workspace/db";
import { normalizeClauseCode, renderClauseBodyWithResolvedVariables, scanPlaceholdersInText } from "./clauseLibrary";
import { applyResolvedAliases, listEffectiveCustomVariables, listVariableAliases, resolveCustomVariables } from "./customVariables";

type DbConn = { execute: (q: any) => any };

export type PreviewInput = {
  firmId: number;
  caseContext: Record<string, unknown>;
  templateRef:
    | { kind: "firm"; templateId: number }
    | { kind: "platform"; documentId: number };
  placeholders: string[];
  overrides?: Record<string, unknown> | null;
};

export type PreviewResult = {
  registry: VariableDefinition[];
  bindings: TemplateBinding[];
  resolvedVariables: Record<string, unknown>;
  missingRequiredVariables: Array<{ variableKey: string; reason: string }>;
  unusedBindings: string[];
  placeholderWarnings: Array<{ placeholder: string; warning: string }>;
  usedMode: "bindings" | "legacy";
};

async function queryRows(r: DbConn, query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await r.execute(query);
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object" && "rows" in result) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

export async function runDocumentPreview(r: DbConn, input: PreviewInput): Promise<PreviewResult> {
  const bindings =
    input.templateRef.kind === "firm"
      ? await getFirmTemplateBindings(r, input.firmId, input.templateRef.templateId)
      : await getPlatformDocumentBindings(r, input.firmId, input.templateRef.documentId);

  const firmClauses = await queryRows(
    r,
    sql`SELECT clause_code, body, status FROM firm_clauses WHERE firm_id = ${input.firmId} AND status <> 'archived'`
  );

  const keys = new Set<string>();
  for (const p of input.placeholders ?? []) if (typeof p === "string" && p.trim()) keys.add(p.trim());
  for (const b of bindings ?? []) if (typeof b?.variableKey === "string" && b.variableKey.trim()) keys.add(b.variableKey.trim());
  for (const row of firmClauses) {
    const body = typeof row.body === "string" ? row.body : "";
    for (const k of scanPlaceholdersInText(body)) {
      if (typeof k === "string" && k.trim()) keys.add(k.trim());
    }
  }
  const registry = await listDocumentVariablesByKeys(r, Array.from(keys), { active: true });

  const resolved = resolveVariablesForTemplate({
    registry,
    bindings,
    caseContext: input.caseContext,
    placeholders: input.placeholders,
    overrides: input.overrides ?? null,
  });

  let resolvedVariablesWithClauses = { ...resolved.resolvedVariables } as Record<string, unknown>;

  const templateIdForCustom =
    input.templateRef.kind === "firm" ? input.templateRef.templateId : null;
  const [customVars, aliases] = await Promise.all([
    listEffectiveCustomVariables(r, {
      firmId: input.firmId,
      templateId: templateIdForCustom,
      includeUnpublishedFounder: true,
    }),
    listVariableAliases(r),
  ]);
  if (customVars.length > 0) {
    const cv = resolveCustomVariables({
      customVariables: customVars.map((v) => ({ key: v.key, bodyTemplate: v.bodyTemplate })),
      baseResolved: resolvedVariablesWithClauses,
      maxDepth: 5,
    });
    resolvedVariablesWithClauses = cv.resolved;
    for (const w of cv.warnings) {
      resolved.placeholderWarnings.push({
        placeholder: w.key,
        warning: `Custom variable: ${w.warning}`,
      });
    }
  }
  {
    const aliased = applyResolvedAliases(resolvedVariablesWithClauses, aliases);
    resolvedVariablesWithClauses = aliased.resolved;
    for (const fromKey of aliased.usedAliases) {
      resolved.placeholderWarnings.push({
        placeholder: fromKey,
        warning: "Alias resolved to replacement token",
      });
    }
  }
  for (const row of firmClauses) {
    const status = typeof row.status === "string" ? row.status : "draft";
    if (status === "archived") continue;
    const clauseCodeRaw = typeof row.clause_code === "string" ? row.clause_code : "";
    const clauseCode = normalizeClauseCode(clauseCodeRaw);
    const body = typeof row.body === "string" ? row.body : "";
    const rendered = renderClauseBodyWithResolvedVariables({ body, resolvedVariables: resolvedVariablesWithClauses }).rendered;
    resolvedVariablesWithClauses[`clause_${clauseCode}`] = rendered;
  }

  if (!Object.prototype.hasOwnProperty.call(resolvedVariablesWithClauses, "purchasers")) {
    const p = (input.caseContext as any)?.purchasers;
    if (Array.isArray(p)) resolvedVariablesWithClauses.purchasers = p;
  }

  if (!Object.prototype.hasOwnProperty.call(resolvedVariablesWithClauses, "is_plural_purchaser")) {
    const p = (input.caseContext as any)?.purchasers;
    resolvedVariablesWithClauses.is_plural_purchaser = Array.isArray(p) ? p.length > 1 : false;
  }

  if (!Object.prototype.hasOwnProperty.call(resolvedVariablesWithClauses, "is_3rd_party_loan")) {
    const v = (input.caseContext as any)?.is_3rd_party_loan;
    resolvedVariablesWithClauses.is_3rd_party_loan = Boolean(v);
  }
  if (!Object.prototype.hasOwnProperty.call(resolvedVariablesWithClauses, "is_direct_loan")) {
    const v = (input.caseContext as any)?.is_direct_loan;
    resolvedVariablesWithClauses.is_direct_loan = Boolean(v);
  }

  return {
    registry,
    bindings,
    resolvedVariables: resolvedVariablesWithClauses,
    missingRequiredVariables: resolved.missingRequiredVariables,
    unusedBindings: resolved.unusedBindings,
    placeholderWarnings: resolved.placeholderWarnings,
    usedMode: resolved.usedMode,
  };
}

