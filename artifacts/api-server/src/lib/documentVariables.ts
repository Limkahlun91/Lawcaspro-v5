import { sql } from "@workspace/db";
import { extractDbErrorInfo } from "./db-error";

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
  groupKey?: string | null;
  valueType: VariableValueType;
  sourcePath: string | null;
  formatter: string | null;
  exampleValue: string | null;
  isSystem: boolean;
  isActive: boolean;
  isHidden?: boolean;
  isPublished?: boolean;
  deprecatedAt?: string | null;
  replacementKey?: string | null;
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

async function queryRowsWithSavepoint(r: DbConn, query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const sp = `sp_vars_${Math.random().toString(16).slice(2, 10)}`;
  try {
    await r.execute(sql.raw(`SAVEPOINT ${sp}`));
  } catch {}
  try {
    const rows = await queryRows(r, query);
    try {
      await r.execute(sql.raw(`RELEASE SAVEPOINT ${sp}`));
    } catch {}
    return rows;
  } catch (err) {
    try {
      await r.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${sp}`));
    } catch {}
    try {
      await r.execute(sql.raw(`RELEASE SAVEPOINT ${sp}`));
    } catch {}
    throw err;
  }
}

export async function listDocumentVariables(r: DbConn, filters: { category?: string; active?: boolean } = {}): Promise<VariableDefinition[]> {
  const where: any[] = [sql`1=1`];
  if (filters.category) where.push(sql`category = ${filters.category}`);
  if (typeof filters.active === "boolean") where.push(sql`is_active = ${filters.active}`);
  const rows = await (async () => {
    try {
      return await queryRowsWithSavepoint(
        r,
        sql`
          SELECT
            id, key, label, description, category, value_type,
            group_key, source_path, formatter, example_value,
            is_system, is_active, is_hidden, is_published,
            deprecated_at, replacement_key,
            sort_order
          FROM document_variable_definitions
          WHERE ${sql.join(where, sql` AND `)}
          ORDER BY category ASC, sort_order ASC, key ASC
        `
      );
    } catch (err) {
      const info = extractDbErrorInfo(err);
      if (info.sqlstate) return [];
      return [];
    }
  })();
  return rows.map((x) => ({
    id: Number(x.id),
    key: String(x.key),
    label: String(x.label),
    description: typeof x.description === "string" ? x.description : null,
    category: String(x.category) as VariableCategory,
    groupKey: typeof (x as any).group_key === "string" ? String((x as any).group_key) : (typeof (x as any).groupKey === "string" ? String((x as any).groupKey) : null),
    valueType: String(x.value_type) as VariableValueType,
    sourcePath: typeof x.source_path === "string" ? x.source_path : null,
    formatter: typeof x.formatter === "string" ? x.formatter : null,
    exampleValue: typeof x.example_value === "string" ? x.example_value : null,
    isSystem: Boolean(x.is_system),
    isActive: Boolean(x.is_active),
    isHidden: Boolean((x as any).is_hidden ?? false),
    isPublished: Boolean((x as any).is_published ?? true),
    deprecatedAt: typeof (x as any).deprecated_at === "string" ? String((x as any).deprecated_at) : ((x as any).deprecated_at instanceof Date ? (x as any).deprecated_at.toISOString() : null),
    replacementKey: typeof (x as any).replacement_key === "string" ? String((x as any).replacement_key) : null,
    sortOrder: typeof x.sort_order === "number" ? x.sort_order : Number(x.sort_order ?? 0),
  }));
}

export async function listDocumentVariablesByKeys(
  r: DbConn,
  keys: string[],
  filters: { active?: boolean } = {}
): Promise<VariableDefinition[]> {
  const cleaned = Array.from(new Set(keys.filter((k) => typeof k === "string" && Boolean(k.trim())).map((k) => k.trim())));
  if (cleaned.length === 0) return [];
  const where: any[] = [sql`key = ANY(${cleaned}::text[])`];
  if (typeof filters.active === "boolean") where.push(sql`is_active = ${filters.active}`);
  const rows = await (async () => {
    try {
      return await queryRowsWithSavepoint(
        r,
        sql`
          SELECT
            id, key, label, description, category, value_type,
            group_key, source_path, formatter, example_value,
            is_system, is_active, is_hidden, is_published,
            deprecated_at, replacement_key,
            sort_order
          FROM document_variable_definitions
          WHERE ${sql.join(where, sql` AND `)}
          ORDER BY category ASC, sort_order ASC, key ASC
        `
      );
    } catch (err) {
      const info = extractDbErrorInfo(err);
      if (info.sqlstate) return [];
      return [];
    }
  })();
  return rows.map((x) => ({
    id: Number(x.id),
    key: String(x.key),
    label: String(x.label),
    description: typeof x.description === "string" ? x.description : null,
    category: String(x.category) as VariableCategory,
    groupKey: typeof (x as any).group_key === "string" ? String((x as any).group_key) : (typeof (x as any).groupKey === "string" ? String((x as any).groupKey) : null),
    valueType: String(x.value_type) as VariableValueType,
    sourcePath: typeof x.source_path === "string" ? x.source_path : null,
    formatter: typeof x.formatter === "string" ? x.formatter : null,
    exampleValue: typeof x.example_value === "string" ? x.example_value : null,
    isSystem: Boolean(x.is_system),
    isActive: Boolean(x.is_active),
    isHidden: Boolean((x as any).is_hidden ?? false),
    isPublished: Boolean((x as any).is_published ?? true),
    deprecatedAt: typeof (x as any).deprecated_at === "string" ? String((x as any).deprecated_at) : ((x as any).deprecated_at instanceof Date ? (x as any).deprecated_at.toISOString() : null),
    replacementKey: typeof (x as any).replacement_key === "string" ? String((x as any).replacement_key) : null,
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

export function formatPersonList(persons: Array<{ name?: unknown; nric?: unknown }> | null | undefined): string {
  const items = Array.isArray(persons)
    ? persons
        .map((p) => ({
          name: typeof p?.name === "string" ? p.name.trim() : String(p?.name ?? "").trim(),
          nric: typeof p?.nric === "string" ? p.nric.trim() : String(p?.nric ?? "").trim(),
        }))
        .filter((p) => Boolean(p.name))
        .map((p) => (p.nric ? `${p.name} (NRIC NO.: ${p.nric})` : p.name))
    : [];
  return joinNamesWithAmpersand(items);
}

export function joinNamesWithAmpersand(names: unknown): string {
  const items = Array.isArray(names)
    ? names
        .map((n) => (typeof n === "string" ? n.trim() : String(n ?? "").trim()))
        .filter(Boolean)
    : [];
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} & ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} & ${items[items.length - 1]}`;
}

function formatNameInlineList(names: unknown): string {
  return joinNamesWithAmpersand(names);
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

  const purchasersInline = (() => {
    const ps = Array.isArray((params.caseContext as any)?.purchasers) ? (params.caseContext as any).purchasers : [];
    const direct = formatNameInlineList(ps.map((p: any) => p?.name));
    if (direct) return direct;
    const fallback =
      typeof (params.caseContext as any)?.purchasers_names === "string" ? String((params.caseContext as any).purchasers_names).trim()
        : typeof (params.caseContext as any)?.purchaser_names === "string" ? String((params.caseContext as any).purchaser_names).trim()
          : typeof (params.caseContext as any)?.buyer_names === "string" ? String((params.caseContext as any).buyer_names).trim()
            : typeof (params.caseContext as any)?.client_names === "string" ? String((params.caseContext as any).client_names).trim()
              : "";
    return fallback;
  })();

  const borrowersInline = (() => {
    const arr = Array.isArray((params.caseContext as any)?.borrowers) ? (params.caseContext as any).borrowers : null;
    if (arr) return formatNameInlineList(arr.map((b: any) => b?.name));
    const b1n = (params.caseContext as any)?.borrower1_name;
    const b2n = (params.caseContext as any)?.borrower2_name;
    const b3n = (params.caseContext as any)?.borrower3_name;
    const out: unknown[] = [];
    if (b1n) out.push(b1n);
    if (b2n) out.push(b2n);
    if (b3n) out.push(b3n);
    return formatNameInlineList(out);
  })();
  const borrowerAddresses = (() => {
    const arr = Array.isArray((params.caseContext as any)?.borrowers) ? (params.caseContext as any).borrowers : null;
    if (arr) {
      return arr
        .map((b: any) => (typeof b?.address === "string" ? b.address.trim() : ""))
        .filter(Boolean)
        .join(", ");
    }
    const a1 = typeof (params.caseContext as any)?.borrower1_address === "string" ? String((params.caseContext as any).borrower1_address).trim() : "";
    const a2 = typeof (params.caseContext as any)?.borrower2_address === "string" ? String((params.caseContext as any).borrower2_address).trim() : "";
    return [a1, a2].filter(Boolean).join(", ");
  })();
  const vendorsInline = formatPersonList((() => {
    const arr = Array.isArray((params.caseContext as any)?.vendors) ? (params.caseContext as any).vendors : null;
    if (arr) return arr.map((v: any) => ({ name: v?.name, nric: v?.nric ?? v?.ic ?? v?.ic_no }));
    const vn = (params.caseContext as any)?.vendor_name;
    const vi = (params.caseContext as any)?.vendor_ic;
    if (!vn) return [];
    return [{ name: vn, nric: vi }];
  })());

  if (isEmptyValue(resolved.purchasers_inline) && purchasersInline) resolved.purchasers_inline = purchasersInline;
  if (isEmptyValue(resolved.borrowers_inline) && borrowersInline) resolved.borrowers_inline = borrowersInline;
  if (!Object.prototype.hasOwnProperty.call(resolved, "borrower_addresses")) resolved.borrower_addresses = borrowerAddresses || null;
  if (!Object.prototype.hasOwnProperty.call(resolved, "borrower_1_address")) resolved.borrower_1_address = typeof (params.caseContext as any)?.borrower_1_address === "string" ? String((params.caseContext as any).borrower_1_address) : (typeof (params.caseContext as any)?.borrower1_address === "string" ? String((params.caseContext as any).borrower1_address) : null);
  if (!Object.prototype.hasOwnProperty.call(resolved, "borrower_2_address")) resolved.borrower_2_address = typeof (params.caseContext as any)?.borrower_2_address === "string" ? String((params.caseContext as any).borrower_2_address) : (typeof (params.caseContext as any)?.borrower2_address === "string" ? String((params.caseContext as any).borrower2_address) : null);
  if (!Object.prototype.hasOwnProperty.call(resolved, "borrower1_address")) resolved.borrower1_address = typeof (params.caseContext as any)?.borrower1_address === "string" ? String((params.caseContext as any).borrower1_address) : null;
  if (!Object.prototype.hasOwnProperty.call(resolved, "borrower2_address")) resolved.borrower2_address = typeof (params.caseContext as any)?.borrower2_address === "string" ? String((params.caseContext as any).borrower2_address) : null;
  if (!Object.prototype.hasOwnProperty.call(resolved, "vendors_inline")) resolved.vendors_inline = vendorsInline || null;

  const purchaserCount = Array.isArray((params.caseContext as any)?.purchasers) ? (params.caseContext as any).purchasers.length : 0;
  const isJoint = purchaserCount > 1;
  if (!Object.prototype.hasOwnProperty.call(resolved, "is_joint_purchaser")) resolved.is_joint_purchaser = isJoint;
  if (!Object.prototype.hasOwnProperty.call(resolved, "purchaser_pronoun")) resolved.purchaser_pronoun = isJoint ? "We" : "I";
  if (!Object.prototype.hasOwnProperty.call(resolved, "purchaser_verb")) resolved.purchaser_verb = isJoint ? "are" : "am";

  return {
    resolvedVariables: resolved,
    missingRequiredVariables: missing,
    unusedBindings,
    placeholderWarnings: warnings,
    usedMode,
  };
}
