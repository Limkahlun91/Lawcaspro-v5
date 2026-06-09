const DEFAULT_PATTERN = "{YY}/{SEQ:4}";
export const DEFAULT_STARTING_NUMBER = 1000;

const VARIABLE_PATTERNS: Record<string, string> = {
  YYYY: "\\d{4}",
  YY: "\\d{2}",
  MM: "\\d{2}",
  INITIALS: "[A-Z0-9]{1,5}",
  DEVELOPER_CODE: "[A-Z0-9]{1,12}",
  PROJECT_CODE: "[A-Z0-9]{1,12}",
  CASE_TYPE_CODE: "[A-Z0-9]{1,12}",
  LAWYER_INITIALS: "[A-Z0-9]{1,5}",
  CLERK_INITIALS: "[A-Z0-9]{1,5}",
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeConfiguredSequence(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? Math.trunc(value)
    : (typeof value === "string" ? Math.trunc(Number(value)) : NaN);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function getStartingNumber(value: unknown): number {
  return normalizeConfiguredSequence(value) ?? DEFAULT_STARTING_NUMBER;
}

export function getConfiguredNextNumber(args: { startingSequence?: unknown; currentSequence?: unknown }): number {
  return normalizeConfiguredSequence(args.currentSequence)
    ?? getStartingNumber(args.startingSequence);
}

export function computeEffectiveNextNumber(args: {
  startingSequence?: unknown;
  currentSequence?: unknown;
  highestExistingNumber?: number | null;
}): {
  startingNumber: number;
  configuredNextNumber: number;
  nextNumber: number;
  highestExistingNumber: number | null;
  sequenceWarning: string | null;
} {
  const startingNumber = getStartingNumber(args.startingSequence);
  const configuredNextNumber = getConfiguredNextNumber(args);
  const highestExistingNumber = Number.isFinite(args.highestExistingNumber)
    ? Math.max(0, Math.trunc(args.highestExistingNumber as number))
    : null;
  const requiredNextNumber = highestExistingNumber !== null ? highestExistingNumber + 1 : null;
  const nextNumber = requiredNextNumber !== null
    ? Math.max(startingNumber, configuredNextNumber, requiredNextNumber)
    : Math.max(startingNumber, configuredNextNumber);
  const sequenceWarning = requiredNextNumber !== null && configuredNextNumber < requiredNextNumber
    ? "This number is lower than existing references. The system will continue from the highest existing number."
    : null;

  return {
    startingNumber,
    configuredNextNumber,
    nextNumber,
    highestExistingNumber,
    sequenceWarning,
  };
}

export function padSequenceNumber(seq: number, width: number): string {
  const safeWidth = Number.isFinite(width) && width > 0 && width <= 12 ? Math.trunc(width) : 4;
  const safeSeq = String(Math.max(0, Math.trunc(seq)));
  return safeSeq.padStart(safeWidth, "0");
}

export function ensureSequencePlaceholder(patternRaw: string): string {
  const base0 = String(patternRaw || "").trim() || DEFAULT_PATTERN;
  return /\{SEQ:\d+\}/i.test(base0) ? base0 : `${base0}/{SEQ:4}`;
}

export function renderFileReferencePattern(patternRaw: string, args: {
  now: Date;
  seq: number;
  developerCode?: string;
  projectCode?: string;
  caseTypeCode?: string;
  initials?: string;
  lawyerInitials?: string;
  clerkInitials?: string;
}): string {
  const now = args.now;
  const yyyy = String(now.getFullYear()).padStart(4, "0");
  const yy = yyyy.slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const base = ensureSequencePlaceholder(patternRaw);
  const withVars = base
    .replaceAll("{YYYY}", yyyy)
    .replaceAll("{YY}", yy)
    .replaceAll("{MM}", mm)
    .replaceAll("{INITIALS}", String(args.initials ?? "NA"))
    .replaceAll("{DEVELOPER_CODE}", String(args.developerCode ?? "NA"))
    .replaceAll("{PROJECT_CODE}", String(args.projectCode ?? "NA"))
    .replaceAll("{CASE_TYPE_CODE}", String(args.caseTypeCode ?? "CASE"))
    .replaceAll("{LAWYER_INITIALS}", String(args.lawyerInitials ?? "NA"))
    .replaceAll("{CLERK_INITIALS}", String(args.clerkInitials ?? "NA"));

  return withVars
    .replace(/\{SEQ:(\d+)\}/g, (_m, width: string) => padSequenceNumber(args.seq, Number(width)))
    .replace(/[\r\n\t]/g, " ")
    .replace(/\s+/g, "")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .slice(0, 80);
}

export function buildReferencePatternRegex(patternRaw: string): RegExp {
  const base = ensureSequencePlaceholder(patternRaw);
  let regex = "";

  for (let i = 0; i < base.length;) {
    if (base.startsWith("{SEQ:", i)) {
      const end = base.indexOf("}", i);
      const width = end > i ? Number(base.slice(i + 5, end)) : NaN;
      const minWidth = Number.isFinite(width) && width > 0 ? Math.trunc(width) : 1;
      regex += `(?<seq>\\d{${minWidth},})`;
      i = end > i ? end + 1 : i + 1;
      continue;
    }

    if (base[i] === "{") {
      const end = base.indexOf("}", i);
      if (end > i) {
        const token = base.slice(i + 1, end);
        regex += VARIABLE_PATTERNS[token] ?? "[A-Z0-9_-]+";
        i = end + 1;
        continue;
      }
    }

    regex += escapeRegex(base[i]);
    i += 1;
  }

  return new RegExp(`^${regex}$`, "i");
}

export function extractRunningNumber(referenceNo: string, patternRaw: string): number | null {
  const ref = String(referenceNo ?? "").trim();
  if (!ref) return null;
  const match = ref.match(buildReferencePatternRegex(patternRaw));
  const raw = match?.groups?.seq;
  const parsed = typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.trunc(parsed);
}
