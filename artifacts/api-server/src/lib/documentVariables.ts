import { sql } from "@workspace/db";

type DbConn = { execute: (q: any) => any };

export type VariableCategory =
  | "case"
  | "purchaser"
  | "property"
  | "loan"
  | "developer"
  | "project"
  | "workflow"
  | "custom";

export type VariableValueType =
  | "string"
  | "number"
  | "date"
  | "boolean"
  | "richtext"
  | "array";

export type VariableDefinition = {
  id: number;
  key: string;
  label: string;
  description: string | null;
  category: VariableCategory;
  valueType: VariableValueType;
  sourcePath: string | null;
  formatter: string | null;
  exampleValue: string | null;
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
};

export type TemplateBinding = {
  id?: number;
  firmId?: number | null;
  templateId?: number | null;
  platformDocumentId?: number | null;
  variableKey: string;
  sourceMode: "registry_default" | "custom_path" | "fixed_value";
  sourcePath: string | null;
  fixedValue: string | null;
  formatterOverride: string | null;
  isRequired: boolean;
  fallbackValue: string | null;
  notes: string | null;
};

export type MissingRequiredVariable = {
  variableKey: string;
  reason: string;
};

export type PlaceholderWarning = {
  placeholder: string;
  warning: string;
};

export type ResolveVariablesResult = {
  resolvedVariables: Record<string, unknown>;
  missingRequiredVariables: MissingRequiredVariable[];
  unusedBindings: string[];
  placeholderWarnings: PlaceholderWarning[];
  usedMode: "bindings" | "legacy";
};

async function queryRows(r: DbConn, query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await r.execute(query);
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object" && "rows" in result) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

export async function listDocumentVariables(r: DbConn, filters: { category?: string; active?: boolean } = {}): Promise<VariableDefinition[]> {
  const where: any[] = [sql`1=1`];
  if (filters.category) where.push(sql`category = ${filters.category}`);
  if (typeof filters.active === "boolean") where.push(sql`is_active = ${filters.active}`);
  const rows = await queryRows(
    r,
    sql`
      SELECT
        id, key, label, description, category, value_type,
        source_path, formatter, example_value,
        is_system, is_active, sort_order
      FROM document_variable_definitions
      WHERE ${sql.join(where, sql` AND `)}
      ORDER BY category ASC, sort_order ASC, key ASC
    `
  );
  return rows.map((x) => ({
    id: Number(x.id),
    key: String(x.key),
    label: String(x.label),
    description: typeof x.description === "string" ? x.description : null,
    category: String(x.category) as VariableCategory,
    valueType: String(x.value_type) as VariableValueType,
    sourcePath: typeof x.source_path === "string" ? x.source_path : null,
    formatter: typeof x.formatter === "string" ? x.formatter : null,
    exampleValue: typeof x.example_value === "string" ? x.example_value : null,
    isSystem: Boolean(x.is_system),
    isActive: Boolean(x.is_active),
    sortOrder: typeof x.sort_order === "number" ? x.sort_order : Number(x.sort_order ?? 0),
  }));
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function toScalarString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return v.toISOString();
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function tokenizePath(path: string): Array<string | number> {
  const p = path.trim();
  if (!p) return [];
  const out: Array<string | number> = [];
  const re = /([^[.\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(p))) {
    if (m[1]) out.push(m[1]);
    else if (m[2]) out.push(Number(m[2]));
  }
  return out;
}

export function resolveValueFromPath(root: Record<string, unknown>, path: string): unknown {
  const tokens = tokenizePath(path);
  let cur: unknown = root;
  for (const t of tokens) {
    if (typeof t === "number") {
      if (!Array.isArray(cur)) return null;
      cur = cur[t];
      continue;
    }
    const rec = asRecord(cur);
    if (!rec) return null;
    cur = rec[t];
  }
  return cur;
}

function formatDateDmy(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  const d =
    v instanceof Date ? v
    : s ? new Date(s)
    : null;
  if (!d || Number.isNaN(d.getTime())) return typeof v === "string" ? v : null;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = String(d.getFullYear());
  return `${dd}/${mm}/${yyyy}`;
}

function formatCurrency(v: unknown): string | null {
  const n =
    typeof v === "number" ? v
    : typeof v === "string" ? Number(v.replace(/[, ]/g, ""))
    : NaN;
  if (!Number.isFinite(n)) return toScalarString(v);
  const formatted = new Intl.NumberFormat("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  return `RM ${formatted}`;
}

function formatNric(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return toScalarString(v);
  const digits = s.replace(/[^\d]/g, "");
  if (digits.length < 6) return s;
  const masked = `${digits.slice(0, 6)}-**-****`;
  return masked;
}

export function applyFormatter(formatter: string | null | undefined, value: unknown): unknown {
  const f = (formatter || "").trim().toLowerCase();
  if (!f) return value;
  if (f === "upper") return typeof value === "string" ? value.toUpperCase() : toScalarString(value)?.toUpperCase() ?? value;
  if (f === "lower") return typeof value === "string" ? value.toLowerCase() : toScalarString(value)?.toLowerCase() ?? value;
  if (f === "date_dmy") return formatDateDmy(value) ?? value;
  if (f === "currency") return formatCurrency(value) ?? value;
  if (f === "nric") return formatNric(value) ?? value;
  return value;
}

export function resolveVariablesForTemplate(params: {
  registry: VariableDefinition[];
  bindings: TemplateBinding[];
  caseContext: Record<string, unknown>;
  placeholders: string[];
  overrides?: Record<string, unknown> | null;
}): ResolveVariablesResult {
  const registryByKey = new Map(params.registry.map((d) => [d.key, d]));
  const bindingByKey = new Map(params.bindings.map((b) => [b.variableKey, b]));
  const placeholderSet = new Set(params.placeholders);

  const usedMode: "bindings" | "legacy" = params.bindings.length > 0 ? "bindings" : "legacy";
  const keys = new Set<string>([...params.placeholders, ...params.bindings.map((b) => b.variableKey)]);
  const resolved: Record<string, unknown> = {};
  const missing: MissingRequiredVariable[] = [];
  const unusedBindings: string[] = [];
  const warnings: PlaceholderWarning[] = [];

  for (const b of params.bindings) {
    if (!placeholderSet.has(b.variableKey)) unusedBindings.push(b.variableKey);
  }

  for (const key of keys) {
    const override = params.overrides && Object.prototype.hasOwnProperty.call(params.overrides, key) ? params.overrides[key] : undefined;
    const def = registryByKey.get(key);
    const binding = bindingByKey.get(key);

    let raw: unknown = undefined;
    if (override !== undefined) {
      raw = override;
    } else if (binding) {
      if (binding.sourceMode === "fixed_value") raw = binding.fixedValue;
      else if (binding.sourceMode === "custom_path") raw = binding.sourcePath ? resolveValueFromPath(params.caseContext, binding.sourcePath) : null;
      else {
        const p = binding.sourcePath || def?.sourcePath || key;
        raw = p ? resolveValueFromPath(params.caseContext, p) : null;
      }
    } else if (def) {
      const p = def.sourcePath || key;
      raw = p ? resolveValueFromPath(params.caseContext, p) : null;
    } else {
      raw = Object.prototype.hasOwnProperty.call(params.caseContext, key) ? params.caseContext[key] : null;
    }

    const formatter = (binding?.formatterOverride || def?.formatter || null) ?? null;
    let val: unknown = applyFormatter(formatter, raw);

    if (isEmptyValue(val) && binding?.fallbackValue) val = binding.fallbackValue;
    if (isEmptyValue(val)) val = null;

    resolved[key] = val;

    if (binding?.isRequired && placeholderSet.has(key)) {
      if (val === null || val === undefined || (typeof val === "string" && val.trim() === "")) {
        missing.push({ variableKey: key, reason: "Required variable is missing" });
      }
    }

    if (!binding && !def && placeholderSet.has(key)) {
      if (!Object.prototype.hasOwnProperty.call(params.caseContext, key)) {
        warnings.push({ placeholder: key, warning: "No binding/registry match; fallback context key not found" });
      }
    }
  }

  return {
    resolvedVariables: resolved,
    missingRequiredVariables: missing,
    unusedBindings,
    placeholderWarnings: warnings,
    usedMode,
  };
}
