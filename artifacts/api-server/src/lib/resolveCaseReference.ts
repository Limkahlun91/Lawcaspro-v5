import {
  buildReferencePatternRegex,
  computeEffectiveNextNumber,
  ensureSequencePlaceholder,
  extractRunningNumber,
  renderFileReferencePattern,
} from "./fileReferenceSequence";

export function deriveSanitizedCodeFromName(
  nameRaw: unknown,
  opts?: { maxLen?: number; mode?: "initials" | "token" }
): string {
  const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
  if (!name) return "";
  const maxLen = Math.max(2, Math.min(12, opts?.maxLen ?? 6));
  const mode = opts?.mode === "initials" ? "initials" : "token";

  const asciiOnly = name
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/[^A-Za-z0-9\s\-'&.]/g, "")
    .trim();
  if (!asciiOnly) return "";

  let out: string;
  if (mode === "initials") {
    const parts = asciiOnly
      .split(/[\s\-/&.]+/)
      .map((p) => p.replace(/[^A-Za-z0-9]/g, ""))
      .filter(Boolean);
    if (parts.length === 0) return "";
    if (parts.length === 1) {
      const only = parts[0]!;
      out = only.slice(0, Math.min(maxLen, only.length)).toUpperCase();
    } else {
      const firstLetters = parts
        .map((p) => p[0]!)
        .join("")
        .toUpperCase();
      out = firstLetters.slice(0, maxLen);
    }
  } else {
    const parts = asciiOnly
      .split(/[\s\-/&.]+/)
      .map((p) => p.replace(/[^A-Za-z0-9]/g, ""))
      .filter(Boolean);
    if (parts.length === 0) return "";
    const joined = parts.join("").toUpperCase();
    out = joined.slice(0, maxLen);
  }

  return out.replace(/[^A-Z0-9]/g, "").slice(0, maxLen);
}

export function caseTypeToCode(normalizedCaseType: unknown): string {
  const t = String(normalizedCaseType ?? "").trim().toLowerCase();
  switch (t) {
    case "developer_sales":
      return "CON";
    case "subsale":
      return "SUBSALE";
    case "perfection":
      return "PERFECTION";
    case "transfer":
      return "TRANSFER";
    case "charge":
      return "CHARGE";
    case "loan":
      return "LOAN";
    default:
      return t ? t.slice(0, 12).toUpperCase() : "";
  }
}

export interface MissingUserInitial {
  role: "lawyer" | "clerk";
  userId: number;
  name: string;
}

export interface UserInitialsRequiredError {
  code: "USER_INITIALS_REQUIRED";
  missing: MissingUserInitial[];
}

export type RulePrecedenceTier =
  | "project_exact"
  | "developer_case_type"
  | "case_type_default"
  | "firm_default";

export interface RuleResolutionResult {
  ok: true;
  activeSettingsKey: string;
  formatPattern: string;
  patternRegex: RegExp;
  startingNumber: number;
  configuredNextNumber: number;
  nextNumber: number;
  highestExistingNumber: number | null;
  sequenceWarning: string | null;
  renderedReference: string;
  developerCode: string;
  projectCode: string;
  caseTypeCode: string;
  lawyerInitials: string;
  clerkInitials: string;
  rulePrecedenceTier: RulePrecedenceTier;
}

const CASE_TYPE_CODE_DEFAULT_FALLBACK = "developer_sales";

export function normalizeCaseType(value: unknown): string {
  return String(value ?? "").trim().toLowerCase() || CASE_TYPE_CODE_DEFAULT_FALLBACK;
}

export function ensureDeveloperAndCaseTypeSettingsKey(args: {
  developerId: number | null;
  normalizedCaseType: string;
}): string | null {
  if (!args.developerId) return null;
  if (!args.normalizedCaseType) return null;
  return `developer_${args.developerId}_${args.normalizedCaseType}`;
}

export function projectSettingsKey(projectId: number | null): string | null {
  if (!projectId) return null;
  return `project_${projectId}`;
}

export interface PrecedenceKeysOutcome {
  keys: string[];
  tierByKey: Record<string, RulePrecedenceTier>;
}

export function buildSettingsPrecedenceKeys(args: {
  normalizedCaseType: string;
  projectId: number | null;
  developerId: number | null;
}): PrecedenceKeysOutcome {
  const projectKey = projectSettingsKey(args.projectId);
  const developerCaseTypeKey = ensureDeveloperAndCaseTypeSettingsKey({
    developerId: args.developerId,
    normalizedCaseType: args.normalizedCaseType,
  });
  const caseTypeKey: string = args.normalizedCaseType;
  const defaultKey: string = "default";

  const keys: string[] = [];
  const tierByKey: Record<string, RulePrecedenceTier> = {};

  if (projectKey) {
    keys.push(projectKey);
    tierByKey[projectKey] = "project_exact";
  }
  if (developerCaseTypeKey) {
    keys.push(developerCaseTypeKey);
    tierByKey[developerCaseTypeKey] = "developer_case_type";
  }
  if (caseTypeKey && caseTypeKey !== "default") {
    keys.push(caseTypeKey);
    tierByKey[caseTypeKey] = "case_type_default";
  }
  keys.push(defaultKey);
  tierByKey[defaultKey] = "firm_default";

  return { keys, tierByKey };
}

export interface RuleSettingsRow {
  caseType: string;
  formatPattern: string;
  startingSequence: unknown;
  currentSequence: unknown;
}

export interface ResolvedRuleSelection {
  activeSettingsKey: string;
  rule: { formatPattern: string; startingSequence: number; currentSequence: number };
  tier: RulePrecedenceTier;
}

export function selectRuleByPrecedence(args: {
  settingRows: RuleSettingsRow[];
  precedenceKeys: string[];
  tierByKey: Record<string, RulePrecedenceTier>;
}): ResolvedRuleSelection | null {
  const byKey = new Map<string, {
    formatPattern: string;
    startingSequence: number;
    currentSequence: number;
  }>();
  for (const row of args.settingRows) {
    const k = String(row.caseType ?? "").trim();
    if (!k) continue;
    byKey.set(k, {
      formatPattern: String(row.formatPattern ?? "").trim(),
      startingSequence: Number(row.startingSequence ?? 1000),
      currentSequence: Number(row.currentSequence ?? 0),
    });
  }
  for (const k of args.precedenceKeys) {
    if (byKey.has(k)) {
      return {
        activeSettingsKey: k,
        rule: byKey.get(k)!,
        tier: args.tierByKey[k],
      };
    }
  }
  return null;
}

export function validateReferenceFormat(referenceNo: string, patternRaw: string): boolean {
  const ref = String(referenceNo ?? "").trim();
  if (!ref) return false;
  return buildReferencePatternRegex(patternRaw).test(ref);
}

export function validateRequiredVariables(patternRaw: string, args: {
  lawyerInitials?: string | null;
  clerkInitials?: string | null;
  assignments?: Array<{
    roleInCase: string;
    userId?: number | null;
    name?: string | null;
    initials?: string | null;
  }>;
}): UserInitialsRequiredError | null {
  const pattern = ensureSequencePlaceholder(patternRaw || "");
  const missing: MissingUserInitial[] = [];

  const hasLawyerPlaceholder = pattern.includes("{LAWYER_INITIALS}");
  const hasClerkPlaceholder = pattern.includes("{CLERK_INITIALS}");

  if (!hasLawyerPlaceholder && !hasClerkPlaceholder) return null;

  const assignments = args.assignments ?? [];
  if (hasLawyerPlaceholder) {
    if (args.lawyerInitials && String(args.lawyerInitials).trim()) {
      // explicitly provided short-circuit, OK
    } else {
      const lawyerAssignment = assignments.find(
        (a) => String(a.roleInCase ?? "").trim().toLowerCase() === "lawyer"
      );
      const initialsFromAssignment = String(
        lawyerAssignment?.initials ?? ""
      ).trim();
      if (!initialsFromAssignment) {
        const userId = Number(lawyerAssignment?.userId ?? 0) || 0;
        const name = String(lawyerAssignment?.name ?? "").trim() || "Unassigned Lawyer";
        missing.push({ role: "lawyer", userId, name });
      }
    }
  }
  if (hasClerkPlaceholder) {
    if (args.clerkInitials && String(args.clerkInitials).trim()) {
      // explicitly provided, OK
    } else {
      const clerkAssignment = assignments.find(
        (a) => String(a.roleInCase ?? "").trim().toLowerCase() === "clerk"
      );
      const initialsFromAssignment = String(
        clerkAssignment?.initials ?? ""
      ).trim();
      if (!initialsFromAssignment) {
        const userId = Number(clerkAssignment?.userId ?? 0) || 0;
        const name = String(clerkAssignment?.name ?? "").trim() || "Unassigned Clerk";
        missing.push({ role: "clerk", userId, name });
      }
    }
  }

  if (missing.length > 0) {
    return { code: "USER_INITIALS_REQUIRED", missing };
  }
  return null;
}

export function renderRuleDefaultFallbackPattern(args: {
  normalizedCaseType: string;
}): string {
  switch (args.normalizedCaseType) {
    case "developer_sales":
      return "CON/{DEVELOPER_CODE}-{PROJECT_CODE}/{SEQ:4}/{YY}({LAWYER_INITIALS}){CLERK_INITIALS}";
    case "subsale":
      return "CON/SS/{SEQ:4}/{YY}({LAWYER_INITIALS}){CLERK_INITIALS}";
    case "perfection":
      return "CON/PFT/{SEQ:4}/{YY}({LAWYER_INITIALS}){CLERK_INITIALS}";
    default:
      return "CON/{SEQ:4}/{YY}({LAWYER_INITIALS}){CLERK_INITIALS}";
  }
}

export interface ResolveReferenceContext {
  now: Date;
  pattern: string;
  seq: number;
  developerCode?: string;
  projectCode?: string;
  caseTypeCode?: string;
  lawyerInitials?: string;
  clerkInitials?: string;
}

export function resolveHighestRunningNumberFromRefs(
  refs: string[],
  pattern: string
): number | null {
  let highest: number | null = null;
  for (const ref of refs) {
    const n = extractRunningNumber(ref, pattern);
    if (n == null) continue;
    highest = highest == null ? n : Math.max(highest, n);
  }
  return highest;
}

export function renderRef(ctx: ResolveReferenceContext): string {
  return renderFileReferencePattern(ctx.pattern, {
    now: ctx.now,
    seq: ctx.seq,
    developerCode: ctx.developerCode,
    projectCode: ctx.projectCode,
    caseTypeCode: ctx.caseTypeCode,
    lawyerInitials: ctx.lawyerInitials,
    clerkInitials: ctx.clerkInitials,
  });
}

export {
  buildReferencePatternRegex,
  computeEffectiveNextNumber,
  ensureSequencePlaceholder,
  extractRunningNumber,
  renderFileReferencePattern,
};
