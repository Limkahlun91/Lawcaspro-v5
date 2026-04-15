type TokenKey =
  | "case_reference"
  | "our_reference"
  | "file_reference"
  | "client_name"
  | "project_name"
  | "developer_name"
  | "document_name"
  | "template_name"
  | "date_ymd"
  | "date_dmy"
  | "status"
  | "title_type"
  | "loan_bank"
  | "sequence";

export type SmartNamingContext = {
  caseId: number;
  firmId: number;
  caseReferenceNo?: string | null;
  parcelNo?: string | null;
  clientName?: string | null;
  projectName?: string | null;
  developerName?: string | null;
  documentName?: string | null;
  templateName?: string | null;
  status?: string | null;
  titleType?: string | null;
  loanBank?: string | null;
  sequence?: number | null;
  now?: Date;
};

export type SmartFilenamePreview = {
  fileName: string;
  ruleUsed: string;
  tokens: Record<TokenKey, string>;
  resolvedTokens: TokenKey[];
  fallbackTokens: TokenKey[];
};

export const SYSTEM_DEFAULT_NAMING_RULE = "{case_reference}_{document_name}_{date_ymd}_{sequence}";

function fmtDateYMD(d: Date): string {
  const yyyy = String(d.getFullYear()).padStart(4, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function fmtDateDMY(d: Date): string {
  const yyyy = String(d.getFullYear()).padStart(4, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${dd}${mm}${yyyy}`;
}

export function extractExtension(fileNameOrExt: string | null | undefined, fallbackExt: string): string {
  const raw = (fileNameOrExt || "").trim();
  const extOnly = raw.startsWith(".") ? raw.slice(1) : raw;
  const fromOnly = /^[a-z0-9]{1,10}$/i.test(extOnly) ? extOnly.toLowerCase() : null;
  if (fromOnly) return fromOnly;
  const dot = raw.lastIndexOf(".");
  if (dot > -1 && dot < raw.length - 1) {
    const candidate = raw.slice(dot + 1);
    if (/^[a-z0-9]{1,10}$/i.test(candidate)) return candidate.toLowerCase();
  }
  return (fallbackExt || "bin").replace(/^\./, "").toLowerCase();
}

export function sanitizeFileStem(input: string): string {
  const raw = String(input ?? "");
  const withoutControls = raw.replace(/[\u0000-\u001F\u007F]/g, " ");
  const withoutReserved = withoutControls.replace(/[<>:"/\\|?*]/g, " ");
  const withoutTrailingDots = withoutReserved.replace(/[. ]+$/g, " ").replace(/^[. ]+/g, " ");
  const collapsedSpaces = withoutTrailingDots.replace(/\s+/g, " ").trim();
  const safe = collapsedSpaces
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/-+/g, "-")
    .replace(/__+/g, "_")
    .replace(/_-_/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
  return safe || "document";
}

export function truncateFileNamePreserveExt(fileName: string, maxLen: number): string {
  const name = String(fileName ?? "");
  if (name.length <= maxLen) return name;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return name.slice(0, maxLen);
  const ext = name.slice(dot);
  const baseMax = Math.max(1, maxLen - ext.length);
  return `${name.slice(0, baseMax)}${ext}`;
}

function tokenValue(ctx: SmartNamingContext, key: TokenKey): string {
  const now = ctx.now ?? new Date();
  if (key === "case_reference") return String(ctx.caseReferenceNo || "").trim();
  if (key === "our_reference") return String(ctx.caseReferenceNo || "").trim();
  if (key === "file_reference") return String(ctx.parcelNo || ctx.caseReferenceNo || ctx.caseId).trim();
  if (key === "client_name") return String(ctx.clientName || "").trim();
  if (key === "project_name") return String(ctx.projectName || "").trim();
  if (key === "developer_name") return String(ctx.developerName || "").trim();
  if (key === "document_name") return String(ctx.documentName || "").trim();
  if (key === "template_name") return String(ctx.templateName || "").trim();
  if (key === "date_ymd") return fmtDateYMD(now);
  if (key === "date_dmy") return fmtDateDMY(now);
  if (key === "status") return String(ctx.status || "").trim();
  if (key === "title_type") return String(ctx.titleType || "").trim();
  if (key === "loan_bank") return String(ctx.loanBank || "").trim();
  if (key === "sequence") {
    const n = typeof ctx.sequence === "number" && Number.isFinite(ctx.sequence) && ctx.sequence > 0 ? Math.floor(ctx.sequence) : 1;
    return String(n).padStart(3, "0");
  }
  return "";
}

export function resolveSmartFilename(params: {
  ctx: SmartNamingContext;
  rule?: string | null;
  originalFileNameOrExt?: string | null;
  fallbackExt: string;
  maxLen?: number;
}): SmartFilenamePreview {
  const ruleUsed = (params.rule || "").trim() || SYSTEM_DEFAULT_NAMING_RULE;
  const maxLen = typeof params.maxLen === "number" && Number.isFinite(params.maxLen) ? params.maxLen : 160;
  const ext = extractExtension(params.originalFileNameOrExt ?? null, params.fallbackExt);

  const tokenKeys: TokenKey[] = [
    "case_reference",
    "our_reference",
    "file_reference",
    "client_name",
    "project_name",
    "developer_name",
    "document_name",
    "template_name",
    "date_ymd",
    "date_dmy",
    "status",
    "title_type",
    "loan_bank",
    "sequence",
  ];

  const tokens = Object.fromEntries(tokenKeys.map((k) => [k, tokenValue(params.ctx, k)])) as Record<TokenKey, string>;
  const usedInRule = new Set<TokenKey>();
  const resolvedTokens: TokenKey[] = [];
  const fallbackTokens: TokenKey[] = [];

  const rendered = ruleUsed.replace(/\{([a-z0-9_]+)\}/gi, (_m, keyRaw: string) => {
    const key = String(keyRaw).toLowerCase() as TokenKey;
    if (!tokenKeys.includes(key)) return "";
    usedInRule.add(key);
    const v = String(tokens[key] || "").trim();
    if (v) resolvedTokens.push(key);
    else fallbackTokens.push(key);
    return v;
  });

  for (const k of usedInRule) {
    if (!resolvedTokens.includes(k) && !fallbackTokens.includes(k)) fallbackTokens.push(k);
  }

  const stem = sanitizeFileStem(rendered);
  const fileName = truncateFileNamePreserveExt(`${stem}.${ext}`, maxLen);

  return {
    fileName,
    ruleUsed,
    tokens,
    resolvedTokens,
    fallbackTokens,
  };
}

