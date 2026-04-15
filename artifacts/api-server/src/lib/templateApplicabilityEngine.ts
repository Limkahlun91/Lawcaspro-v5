import { evaluateTemplateApplicability, type CaseApplicabilityInputs, type TemplateApplicabilityFields } from "./documentApplicability";

export type ApplicabilityMode = "universal" | "rules_only" | "rules_with_manual_override";
export type ApplicabilityStatus = "applicable" | "not_applicable" | "warning";
export type ApplicabilityOperator =
  | "equals"
  | "not_equals"
  | "in"
  | "not_in"
  | "contains"
  | "is_true"
  | "is_false"
  | "greater_than_or_equal"
  | "less_than_or_equal";

export type ApplicabilityCondition = {
  field: string;
  operator: ApplicabilityOperator;
  value?: unknown;
  values?: unknown[];
  reason?: string;
};

export type ApplicabilityRulesJson = {
  all?: ApplicabilityCondition[];
  any?: ApplicabilityCondition[];
  message?: string;
};

export type ApplicabilityEvaluationResult = {
  applicabilityStatus: ApplicabilityStatus;
  applicabilityReasons: string[];
  matchedRulesCount: number;
  failedRulesCount: number;
  manuallyOverridable: boolean;
  modeUsed: ApplicabilityMode;
};

export function normalizeApplicabilityMode(v: unknown): ApplicabilityMode {
  if (v === "rules_only") return "rules_only";
  if (v === "rules_with_manual_override") return "rules_with_manual_override";
  return "universal";
}

function toComparable(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

function getContextValue(ctx: Record<string, unknown>, field: string): unknown {
  const f = String(field || "").trim();
  if (!f) return undefined;
  if (Object.prototype.hasOwnProperty.call(ctx, f)) return ctx[f];
  return undefined;
}

function evalCondition(cond: ApplicabilityCondition, ctx: Record<string, unknown>): { ok: boolean | null; reason?: string } {
  const fieldValue = getContextValue(ctx, cond.field);
  const op = cond.operator;
  if (fieldValue === undefined || fieldValue === null || fieldValue === "") return { ok: null, reason: `Field missing: ${cond.field}` };
  const fv = toComparable(fieldValue);
  const vv = toComparable(cond.value);
  if (op === "equals") return { ok: fv === vv };
  if (op === "not_equals") return { ok: fv !== vv };
  if (op === "contains") return { ok: fv.includes(vv) };
  if (op === "is_true") return { ok: fv === "true" || fv === "1" || fv === "yes" };
  if (op === "is_false") return { ok: fv === "false" || fv === "0" || fv === "no" };
  if (op === "in") {
    const vals = Array.isArray(cond.values) ? cond.values.map(toComparable) : [vv];
    return { ok: vals.includes(fv) };
  }
  if (op === "not_in") {
    const vals = Array.isArray(cond.values) ? cond.values.map(toComparable) : [vv];
    return { ok: !vals.includes(fv) };
  }
  if (op === "greater_than_or_equal") {
    const a = Number(fieldValue);
    const b = Number(cond.value);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return { ok: null, reason: `Non-numeric compare: ${cond.field}` };
    return { ok: a >= b };
  }
  if (op === "less_than_or_equal") {
    const a = Number(fieldValue);
    const b = Number(cond.value);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return { ok: null, reason: `Non-numeric compare: ${cond.field}` };
    return { ok: a <= b };
  }
  return { ok: null, reason: `Unknown operator: ${op}` };
}

export function evaluateTemplateApplicabilityV2(params: {
  legacyTemplate: TemplateApplicabilityFields;
  legacyInput: CaseApplicabilityInputs;
  context: Record<string, unknown>;
  applicabilityMode?: unknown;
  applicabilityRules?: unknown;
}): ApplicabilityEvaluationResult {
  const mode = normalizeApplicabilityMode(params.applicabilityMode);
  const base = evaluateTemplateApplicability(params.legacyTemplate, params.legacyInput);
  const reasons = [...base.reasons];
  let matched = 0;
  let failed = base.applicable ? 0 : Math.max(1, base.reasons.length);
  const warns: string[] = [];

  if (mode !== "universal" && params.applicabilityRules && typeof params.applicabilityRules === "object") {
    const rules = params.applicabilityRules as ApplicabilityRulesJson;
    const all = Array.isArray(rules.all) ? rules.all : [];
    const any = Array.isArray(rules.any) ? rules.any : [];

    for (const c of all) {
      const r = evalCondition(c, params.context);
      if (r.ok === true) matched += 1;
      else if (r.ok === false) {
        failed += 1;
        reasons.push(c.reason || `Rule failed: ${c.field} ${c.operator}`);
      } else if (r.reason) {
        warns.push(r.reason);
      }
    }

    if (any.length > 0) {
      let anyMatched = false;
      let anyFailed = 0;
      for (const c of any) {
        const r = evalCondition(c, params.context);
        if (r.ok === true) {
          anyMatched = true;
          matched += 1;
        } else if (r.ok === false) {
          anyFailed += 1;
        } else if (r.reason) {
          warns.push(r.reason);
        }
      }
      if (!anyMatched && anyFailed > 0) {
        failed += 1;
        reasons.push(rules.message || "No optional applicability rule matched");
      }
    }
  }

  let status: ApplicabilityStatus = "applicable";
  if (failed > 0) status = "not_applicable";
  else if (warns.length > 0) status = "warning";
  const allReasons = [...reasons, ...warns];
  return {
    applicabilityStatus: status,
    applicabilityReasons: allReasons,
    matchedRulesCount: matched,
    failedRulesCount: failed,
    manuallyOverridable: mode === "rules_with_manual_override",
    modeUsed: mode,
  };
}

