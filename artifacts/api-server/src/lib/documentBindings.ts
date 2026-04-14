import { sql } from "drizzle-orm";
import type { TemplateBinding } from "./documentVariables";

type DbConn = { execute: (q: any) => any };

async function queryRows(r: DbConn, query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await r.execute(query);
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object" && "rows" in result) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

function rowToBinding(x: Record<string, unknown>): TemplateBinding {
  return {
    id: typeof x.id === "number" ? x.id : Number(x.id),
    firmId: typeof x.firm_id === "number" ? x.firm_id : (x.firm_id === null ? null : Number(x.firm_id)),
    templateId: typeof x.template_id === "number" ? x.template_id : (x.template_id === null ? null : Number(x.template_id)),
    platformDocumentId: typeof x.platform_document_id === "number" ? x.platform_document_id : (x.platform_document_id === null ? null : Number(x.platform_document_id)),
    variableKey: String(x.variable_key),
    sourceMode: (String(x.source_mode) as any) || "registry_default",
    sourcePath: typeof x.source_path === "string" ? x.source_path : null,
    fixedValue: typeof x.fixed_value === "string" ? x.fixed_value : null,
    formatterOverride: typeof x.formatter_override === "string" ? x.formatter_override : null,
    isRequired: Boolean(x.is_required),
    fallbackValue: typeof x.fallback_value === "string" ? x.fallback_value : null,
    notes: typeof x.notes === "string" ? x.notes : null,
  };
}

export async function getFirmTemplateBindings(r: DbConn, firmId: number, templateId: number): Promise<TemplateBinding[]> {
  const rows = await queryRows(r, sql`
    SELECT *
    FROM document_template_bindings
    WHERE firm_id = ${firmId} AND template_id = ${templateId}
    ORDER BY variable_key ASC
  `);
  return rows.map(rowToBinding);
}

export async function replaceFirmTemplateBindings(r: DbConn, firmId: number, templateId: number, bindings: TemplateBinding[]): Promise<void> {
  await queryRows(r, sql`DELETE FROM document_template_bindings WHERE firm_id = ${firmId} AND template_id = ${templateId}`);
  for (const b of bindings) {
    await queryRows(r, sql`
      INSERT INTO document_template_bindings (
        firm_id, template_id, platform_document_id,
        variable_key, source_mode, source_path, fixed_value,
        formatter_override, is_required, fallback_value, notes, updated_at
      ) VALUES (
        ${firmId}, ${templateId}, NULL,
        ${b.variableKey}, ${b.sourceMode}, ${b.sourcePath}, ${b.fixedValue},
        ${b.formatterOverride}, ${b.isRequired}, ${b.fallbackValue}, ${b.notes}, now()
      )
    `);
  }
}

export async function getPlatformDocumentBindings(r: DbConn, firmId: number | null, documentId: number): Promise<TemplateBinding[]> {
  const rows = await queryRows(r, sql`
    SELECT *
    FROM document_template_bindings
    WHERE platform_document_id = ${documentId}
      AND (${firmId === null ? sql`firm_id IS NULL` : sql`(firm_id = ${firmId} OR firm_id IS NULL)`})
    ORDER BY firm_id DESC NULLS LAST, variable_key ASC
  `);
  const byKey = new Map<string, TemplateBinding>();
  for (const row of rows.map(rowToBinding)) {
    if (!byKey.has(row.variableKey)) byKey.set(row.variableKey, row);
  }
  return Array.from(byKey.values()).sort((a, b) => a.variableKey.localeCompare(b.variableKey));
}

export async function replacePlatformDocumentBindings(r: DbConn, firmId: number | null, documentId: number, bindings: TemplateBinding[]): Promise<void> {
  if (firmId === null) {
    await queryRows(r, sql`DELETE FROM document_template_bindings WHERE firm_id IS NULL AND platform_document_id = ${documentId}`);
    for (const b of bindings) {
      await queryRows(r, sql`
        INSERT INTO document_template_bindings (
          firm_id, template_id, platform_document_id,
          variable_key, source_mode, source_path, fixed_value,
          formatter_override, is_required, fallback_value, notes, updated_at
        ) VALUES (
          NULL, NULL, ${documentId},
          ${b.variableKey}, ${b.sourceMode}, ${b.sourcePath}, ${b.fixedValue},
          ${b.formatterOverride}, ${b.isRequired}, ${b.fallbackValue}, ${b.notes}, now()
        )
      `);
    }
    return;
  }

  await queryRows(r, sql`DELETE FROM document_template_bindings WHERE firm_id = ${firmId} AND platform_document_id = ${documentId}`);
  for (const b of bindings) {
    await queryRows(r, sql`
      INSERT INTO document_template_bindings (
        firm_id, template_id, platform_document_id,
        variable_key, source_mode, source_path, fixed_value,
        formatter_override, is_required, fallback_value, notes, updated_at
      ) VALUES (
        ${firmId}, NULL, ${documentId},
        ${b.variableKey}, ${b.sourceMode}, ${b.sourcePath}, ${b.fixedValue},
        ${b.formatterOverride}, ${b.isRequired}, ${b.fallbackValue}, ${b.notes}, now()
      )
    `);
  }
}

