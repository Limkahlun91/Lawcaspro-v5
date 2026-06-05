import { sql } from "@workspace/db";
import { scanPlaceholdersInText } from "./clauseLibrary";

type DbConn = { execute: (q: any) => any };

async function queryRows(r: DbConn, query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  const result = await r.execute(query);
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object" && "rows" in result) return (result as { rows: Record<string, unknown>[] }).rows;
  return [];
}

export type CustomVariableScope = "founder_master" | "firm" | "template_specific";
export type CustomVariableStatus = "active" | "disabled" | "deprecated";

export type CustomVariableRow = {
  id: number;
  scope: CustomVariableScope;
  firmId: number | null;
  templateId: number | null;
  key: string;
  displayName: string;
  groupKey: string;
  status: CustomVariableStatus;
  isPublished: boolean;
  deprecatedAt: string | null;
  currentVersionNo: number;
  bodyTemplate: string;
  createdAt: string;
  updatedAt: string;
};

export type VariableAliasRow = { fromKey: string; toKey: string; isActive: boolean };

function toIso(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  return null;
}

export async function listVariableAliases(r: DbConn): Promise<VariableAliasRow[]> {
  const rows = await queryRows(
    r,
    sql`
      SELECT from_key, to_key, is_active
      FROM document_variable_aliases
      WHERE is_active = true
    `,
  );
  return rows
    .map((x) => ({
      fromKey: String((x as any).from_key ?? ""),
      toKey: String((x as any).to_key ?? ""),
      isActive: Boolean((x as any).is_active ?? true),
    }))
    .filter((x) => x.fromKey && x.toKey);
}

export async function listEffectiveCustomVariables(r: DbConn, args: {
  firmId: number;
  templateId?: number | null;
  includeUnpublishedFounder?: boolean;
}): Promise<CustomVariableRow[]> {
  const tplId = typeof args.templateId === "number" ? args.templateId : null;
  const includeUnpublishedFounder = Boolean(args.includeUnpublishedFounder);

  const rows = await queryRows(
    r,
    sql`
      SELECT
        v.id, v.scope, v.firm_id, v.template_id,
        v.key, v.display_name, v.group_key, v.status,
        v.is_published, v.deprecated_at, v.current_version_no,
        v.created_at, v.updated_at,
        vv.body_template
      FROM document_custom_variables v
      JOIN document_custom_variable_versions vv
        ON vv.custom_variable_id = v.id
       AND vv.version_no = v.current_version_no
      WHERE (
        (v.scope = 'template_specific' AND v.firm_id = ${args.firmId} AND v.template_id = ${tplId})
        OR (v.scope = 'firm' AND v.firm_id = ${args.firmId} AND v.template_id IS NULL)
        OR (v.scope = 'founder_master' AND v.firm_id IS NULL AND v.template_id IS NULL AND (${includeUnpublishedFounder} OR v.is_published = true))
      )
    `,
  );

  const all = rows.map((x) => ({
    id: Number((x as any).id),
    scope: String((x as any).scope ?? "") as CustomVariableScope,
    firmId: typeof (x as any).firm_id === "number" ? Number((x as any).firm_id) : ((x as any).firm_id ? Number((x as any).firm_id) : null),
    templateId: typeof (x as any).template_id === "number" ? Number((x as any).template_id) : ((x as any).template_id ? Number((x as any).template_id) : null),
    key: String((x as any).key ?? ""),
    displayName: String((x as any).display_name ?? ""),
    groupKey: String((x as any).group_key ?? "custom_variables"),
    status: String((x as any).status ?? "active") as CustomVariableStatus,
    isPublished: Boolean((x as any).is_published ?? false),
    deprecatedAt: toIso((x as any).deprecated_at),
    currentVersionNo: typeof (x as any).current_version_no === "number" ? Number((x as any).current_version_no) : Number((x as any).current_version_no ?? 1),
    bodyTemplate: String((x as any).body_template ?? ""),
    createdAt: toIso((x as any).created_at) ?? new Date().toISOString(),
    updatedAt: toIso((x as any).updated_at) ?? new Date().toISOString(),
  })).filter((x) => x.key);

  const priority = (s: CustomVariableScope): number =>
    s === "template_specific" ? 3 : s === "firm" ? 2 : 1;
  const byKey = new Map<string, CustomVariableRow>();
  for (const v of all) {
    const existing = byKey.get(v.key);
    if (!existing || priority(v.scope) > priority(existing.scope)) byKey.set(v.key, v);
  }
  return Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key));
}

export function applyResolvedAliases(resolved: Record<string, unknown>, aliases: VariableAliasRow[]): { resolved: Record<string, unknown>; usedAliases: string[] } {
  const used: string[] = [];
  for (const a of aliases) {
    if (!a.isActive) continue;
    const from = String(a.fromKey ?? "").trim();
    const to = String(a.toKey ?? "").trim();
    if (!from || !to) continue;
    if (Object.prototype.hasOwnProperty.call(resolved, from)) continue;
    if (!Object.prototype.hasOwnProperty.call(resolved, to)) continue;
    (resolved as any)[from] = (resolved as any)[to];
    used.push(from);
  }
  return { resolved, usedAliases: used };
}

function renderTemplateOnce(body: string, vars: Record<string, unknown>): { rendered: string; used: string[]; missing: string[] } {
  const { rendered, used, missing } = (() => {
    const outUsed: string[] = [];
    const outMissing: string[] = [];
    const out = body.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (_m, keyRaw: string) => {
      const k = String(keyRaw ?? "").trim();
      if (!k) return "";
      if (!outUsed.includes(k)) outUsed.push(k);
      const v = (vars as any)[k];
      const s = v === null || v === undefined ? "" : String(v);
      if (!s.trim()) {
        if (!outMissing.includes(k)) outMissing.push(k);
      }
      return s;
    });
    return { rendered: out, used: outUsed, missing: outMissing };
  })();
  return { rendered, used, missing };
}

export function resolveCustomVariables(params: {
  customVariables: Array<{ key: string; bodyTemplate: string }>;
  baseResolved: Record<string, unknown>;
  maxDepth?: number;
}): { resolved: Record<string, unknown>; warnings: Array<{ key: string; warning: string }>; referencedKeys: Record<string, string[]> } {
  const maxDepth = typeof params.maxDepth === "number" ? params.maxDepth : 5;
  const defs = new Map<string, { body: string }>();
  for (const v of params.customVariables) {
    const key = String(v.key ?? "").trim();
    if (!key) continue;
    defs.set(key, { body: String(v.bodyTemplate ?? "") });
  }

  const resolved = { ...params.baseResolved } as Record<string, unknown>;
  const warnings: Array<{ key: string; warning: string }> = [];
  const referencedKeys: Record<string, string[]> = {};

  const stack: string[] = [];
  const memo = new Map<string, string>();

  const evalKey = (key: string, depth: number): string => {
    if (memo.has(key)) return memo.get(key)!;
    if (depth > maxDepth) {
      warnings.push({ key, warning: `Max recursion depth (${maxDepth}) reached` });
      memo.set(key, "");
      return "";
    }
    if (stack.includes(key)) {
      warnings.push({ key, warning: "Recursive reference detected" });
      memo.set(key, "");
      return "";
    }
    const def = defs.get(key);
    if (!def) {
      memo.set(key, "");
      return "";
    }
    stack.push(key);
    const used = scanPlaceholdersInText(def.body);
    referencedKeys[key] = used;
    const localVars = new Proxy(resolved as any, {
      get(target, prop) {
        const k = String(prop);
        if (defs.has(k)) return evalKey(k, depth + 1);
        return (target as any)[k];
      },
    });
    const rendered = renderTemplateOnce(def.body, localVars as any).rendered;
    stack.pop();
    memo.set(key, rendered);
    return rendered;
  };

  for (const key of defs.keys()) {
    const v = evalKey(key, 1);
    (resolved as any)[key] = v.trim() ? v : null;
  }
  return { resolved, warnings, referencedKeys };
}

