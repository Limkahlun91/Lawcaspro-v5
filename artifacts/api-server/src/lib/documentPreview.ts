import type { TemplateBinding, VariableDefinition } from "./documentVariables";
import { listDocumentVariables, resolveVariablesForTemplate } from "./documentVariables";
import { getFirmTemplateBindings, getPlatformDocumentBindings } from "./documentBindings";

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

export async function runDocumentPreview(r: DbConn, input: PreviewInput): Promise<PreviewResult> {
  const registry = await listDocumentVariables(r, { active: true });
  const bindings =
    input.templateRef.kind === "firm"
      ? await getFirmTemplateBindings(r, input.firmId, input.templateRef.templateId)
      : await getPlatformDocumentBindings(r, input.firmId, input.templateRef.documentId);

  const resolved = resolveVariablesForTemplate({
    registry,
    bindings,
    caseContext: input.caseContext,
    placeholders: input.placeholders,
    overrides: input.overrides ?? null,
  });

  return {
    registry,
    bindings,
    resolvedVariables: resolved.resolvedVariables,
    missingRequiredVariables: resolved.missingRequiredVariables,
    unusedBindings: resolved.unusedBindings,
    placeholderWarnings: resolved.placeholderWarnings,
    usedMode: resolved.usedMode,
  };
}

