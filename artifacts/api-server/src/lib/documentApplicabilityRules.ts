import { sql } from "drizzle-orm";

type DbConn = { execute: (q: any) => any };

export type TemplateApplicabilityRulesRow = {
  id: number;
  firmId: number | null;
  templateId: number | null;
  platformDocumentId: number | null;
  isActive: boolean | null;
  isRequired: boolean | null;
  purchaseMode: string | null;
  titleType: string | null;
  titleSubType: string | null;
  projectType: string | null;
  developmentCondition: string | null;
  unitCategory: string | null;
  isTemplateCapable: boolean | null;
};

async function queryRows(r: DbConn, query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await r.execute(query);
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object" && "rows" in result) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

function rowToRules(x: Record<string, unknown>): TemplateApplicabilityRulesRow {
  return {
    id: Number(x.id),
    firmId: x.firm_id === null ? null : Number(x.firm_id),
    templateId: x.template_id === null ? null : Number(x.template_id),
    platformDocumentId: x.platform_document_id === null ? null : Number(x.platform_document_id),
    isActive: typeof x.is_active === "boolean" ? x.is_active : (x.is_active === null ? null : Boolean(x.is_active)),
    isRequired: typeof x.is_required === "boolean" ? x.is_required : (x.is_required === null ? null : Boolean(x.is_required)),
    purchaseMode: typeof x.purchase_mode === "string" ? x.purchase_mode : null,
    titleType: typeof x.title_type === "string" ? x.title_type : null,
    titleSubType: typeof x.title_sub_type === "string" ? x.title_sub_type : null,
    projectType: typeof x.project_type === "string" ? x.project_type : null,
    developmentCondition: typeof x.development_condition === "string" ? x.development_condition : null,
    unitCategory: typeof x.unit_category === "string" ? x.unit_category : null,
    isTemplateCapable: typeof x.is_template_capable === "boolean" ? x.is_template_capable : (x.is_template_capable === null ? null : Boolean(x.is_template_capable)),
  };
}

export async function getFirmTemplateApplicabilityRules(r: DbConn, firmId: number, templateId: number): Promise<TemplateApplicabilityRulesRow | null> {
  const rows = await queryRows(r, sql`
    SELECT *
    FROM document_template_applicability_rules
    WHERE firm_id = ${firmId} AND template_id = ${templateId}
    LIMIT 1
  `);
  return rows[0] ? rowToRules(rows[0]) : null;
}

export async function upsertFirmTemplateApplicabilityRules(r: DbConn, firmId: number, templateId: number, patch: Partial<TemplateApplicabilityRulesRow>): Promise<void> {
  await queryRows(r, sql`
    INSERT INTO document_template_applicability_rules (
      firm_id, template_id, platform_document_id,
      is_active, is_required, purchase_mode, title_type, title_sub_type,
      project_type, development_condition, unit_category, is_template_capable, updated_at
    ) VALUES (
      ${firmId}, ${templateId}, NULL,
      ${patch.isActive ?? null}, ${patch.isRequired ?? null}, ${patch.purchaseMode ?? null}, ${patch.titleType ?? null}, ${patch.titleSubType ?? null},
      ${patch.projectType ?? null}, ${patch.developmentCondition ?? null}, ${patch.unitCategory ?? null}, ${patch.isTemplateCapable ?? null}, now()
    )
    ON CONFLICT (template_id) WHERE template_id IS NOT NULL
    DO UPDATE SET
      is_active = EXCLUDED.is_active,
      is_required = EXCLUDED.is_required,
      purchase_mode = EXCLUDED.purchase_mode,
      title_type = EXCLUDED.title_type,
      title_sub_type = EXCLUDED.title_sub_type,
      project_type = EXCLUDED.project_type,
      development_condition = EXCLUDED.development_condition,
      unit_category = EXCLUDED.unit_category,
      is_template_capable = EXCLUDED.is_template_capable,
      updated_at = now()
  `);
}

export async function getPlatformDocumentApplicabilityRules(r: DbConn, firmId: number | null, documentId: number): Promise<TemplateApplicabilityRulesRow | null> {
  const rows = await queryRows(r, sql`
    SELECT *
    FROM document_template_applicability_rules
    WHERE platform_document_id = ${documentId}
      AND (${firmId === null ? sql`firm_id IS NULL` : sql`(firm_id = ${firmId} OR firm_id IS NULL)`})
    ORDER BY firm_id DESC NULLS LAST
    LIMIT 1
  `);
  return rows[0] ? rowToRules(rows[0]) : null;
}

export async function upsertPlatformDocumentApplicabilityRules(r: DbConn, firmId: number | null, documentId: number, patch: Partial<TemplateApplicabilityRulesRow>): Promise<void> {
  await queryRows(r, sql`
    INSERT INTO document_template_applicability_rules (
      firm_id, template_id, platform_document_id,
      is_active, is_required, purchase_mode, title_type, title_sub_type,
      project_type, development_condition, unit_category, is_template_capable, updated_at
    ) VALUES (
      ${firmId as any}, NULL, ${documentId},
      ${patch.isActive ?? null}, ${patch.isRequired ?? null}, ${patch.purchaseMode ?? null}, ${patch.titleType ?? null}, ${patch.titleSubType ?? null},
      ${patch.projectType ?? null}, ${patch.developmentCondition ?? null}, ${patch.unitCategory ?? null}, ${patch.isTemplateCapable ?? null}, now()
    )
    ON CONFLICT (platform_document_id) WHERE platform_document_id IS NOT NULL
    DO UPDATE SET
      firm_id = EXCLUDED.firm_id,
      is_active = EXCLUDED.is_active,
      is_required = EXCLUDED.is_required,
      purchase_mode = EXCLUDED.purchase_mode,
      title_type = EXCLUDED.title_type,
      title_sub_type = EXCLUDED.title_sub_type,
      project_type = EXCLUDED.project_type,
      development_condition = EXCLUDED.development_condition,
      unit_category = EXCLUDED.unit_category,
      is_template_capable = EXCLUDED.is_template_capable,
      updated_at = now()
  `);
}

