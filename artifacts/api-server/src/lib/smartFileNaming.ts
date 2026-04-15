type TokenKey =
  | "our_ref"
  | "case_id"
  | "document_title"
  | "template_name"
  | "generated_date"
  | "generated_datetime"
  | "primary_client_name"
  | "purchaser_names"
  | "borrower_names"
  | "project_name"
  | "developer_name"
  | "unit_no"
  | "parcel_no"
  | "property_description_short"
  | "bank_name"
  | "date_ymd"
  | "date_dmy"
  | "timestamp_compact"
  // Backward-compat aliases kept for P6/P7 clients
  | "case_reference"
  | "our_reference"
  | "file_reference"
  | "client_name"
  | "document_name"
  | "status"
  | "title_type"
  | "loan_bank"
  | "sequence";

export type SmartNamingContext = {
  caseId: number;
  firmId: number;
  caseReferenceNo?: string | null;
  parcelNo?: string | null;
  unitNo?: string | null;
  clientName?: string | null;
  primaryClientName?: string | null;
  purchaserNames?: string | null;
  borrowerNames?: string | null;
  projectName?: string | null;
  propertyDescriptionShort?: string | null;
  developerName?: string | null;
  documentName?: string | null;
  templateName?: string | null;
  bankName?: string | null;
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
  warnings: string[];
  fallbackUsed: boolean;
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
  const withoutTrailingDots = withoutReserved.replace(/[. ]+$/g, "").replace(/^[. ]+/g, "");
  const collapsedSpaces = withoutTrailingDots.replace(/\s+/g, " ").trim();
  const normalized = collapsedSpaces
    .replace(/\s*-\s*/g, " - ")
    .replace(/\s*\|\s*/g, " | ")
    .replace(/\s*_\s*/g, "_")
    .replace(/\s+/g, " ")
    .replace(/(?:\s*[-|_]\s*){2,}/g, " ")
    .trim();
  const safe = normalized
    .replace(/\s{2,}/g, " ")
    .replace(/\.\.+/g, ".")
    .replace(/-+/g, "-")
    .replace(/_+/g, "_")
    .replace(/^[_\-|.\s]+|[_\-|.\s]+$/g, "");
  return safe || "document";
}

export function truncateFileNamePreserveExt(fileName: string, maxLen: number, basenameMaxLen?: number): string {
  const name = String(fileName ?? "");
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return name.length <= maxLen ? name : name.slice(0, maxLen);
  const ext = name.slice(dot);
  const base = name.slice(0, dot);
  const byBase = typeof basenameMaxLen === "number" && basenameMaxLen > 0 ? base.slice(0, basenameMaxLen) : base;
  const composed = `${byBase}${ext}`;
  if (composed.length <= maxLen) return composed;
  const baseMax = Math.max(1, maxLen - ext.length);
  return `${byBase.slice(0, baseMax)}${ext}`;
}

function tokenValue(ctx: SmartNamingContext, key: TokenKey): string {
  const now = ctx.now ?? new Date();
  const dt = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  if (key === "our_ref") return String(ctx.caseReferenceNo || "").trim();
  if (key === "case_id") return String(ctx.caseId || "").trim();
  if (key === "document_title") return String(ctx.documentName || "").trim();
  if (key === "generated_date") return fmtDateYMD(now);
  if (key === "generated_datetime") return dt;
  if (key === "primary_client_name") return String(ctx.primaryClientName || ctx.clientName || "").trim();
  if (key === "purchaser_names") return String(ctx.purchaserNames || "").trim();
  if (key === "borrower_names") return String(ctx.borrowerNames || "").trim();
  if (key === "unit_no") return String(ctx.unitNo || "").trim();
  if (key === "parcel_no") return String(ctx.parcelNo || "").trim();
  if (key === "property_description_short") return String(ctx.propertyDescriptionShort || "").trim();
  if (key === "bank_name") return String(ctx.bankName || ctx.loanBank || "").trim();
  if (key === "timestamp_compact") return dt;
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
  basenameMaxLen?: number;
}): SmartFilenamePreview {
  const ruleUsed = (params.rule || "").trim() || SYSTEM_DEFAULT_NAMING_RULE;
  const maxLen = typeof params.maxLen === "number" && Number.isFinite(params.maxLen) ? params.maxLen : 160;
  const basenameMaxLen = typeof params.basenameMaxLen === "number" && Number.isFinite(params.basenameMaxLen) ? params.basenameMaxLen : 150;
  const ext = extractExtension(params.originalFileNameOrExt ?? null, params.fallbackExt);

  const tokenKeys: TokenKey[] = [
    "our_ref",
    "case_id",
    "document_title",
    "template_name",
    "generated_date",
    "generated_datetime",
    "primary_client_name",
    "purchaser_names",
    "borrower_names",
    "case_reference",
    "our_reference",
    "file_reference",
    "client_name",
    "project_name",
    "developer_name",
    "unit_no",
    "parcel_no",
    "property_description_short",
    "bank_name",
    "document_name",
    "date_ymd",
    "date_dmy",
    "timestamp_compact",
    "status",
    "title_type",
    "loan_bank",
    "sequence",
  ];

  const tokens = Object.fromEntries(tokenKeys.map((k) => [k, tokenValue(params.ctx, k)])) as Record<TokenKey, string>;
  const usedInRule = new Set<TokenKey>();
  const resolvedTokens: TokenKey[] = [];
  const fallbackTokens: TokenKey[] = [];

  const tokenSet = new Set(tokenKeys);
  const rendered = ruleUsed
    // Primary syntax: {{variable_key}}
    .replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_m, keyRaw: string) => {
      const key = String(keyRaw).toLowerCase() as TokenKey;
      if (!tokenSet.has(key)) return "";
      usedInRule.add(key);
      const v = String(tokens[key] || "").trim();
      if (v) resolvedTokens.push(key);
      else fallbackTokens.push(key);
      return v;
    })
    // Backward compatibility: {variable_key}
    .replace(/\{([a-z0-9_]+)\}/gi, (_m, keyRaw: string) => {
      const key = String(keyRaw).toLowerCase() as TokenKey;
      if (!tokenSet.has(key)) return "";
      if (usedInRule.has(key)) return String(tokens[key] || "").trim();
    usedInRule.add(key);
    const v = String(tokens[key] || "").trim();
    if (v) resolvedTokens.push(key);
    else fallbackTokens.push(key);
    return v;
  });

  for (const k of usedInRule) {
    if (!resolvedTokens.includes(k) && !fallbackTokens.includes(k)) fallbackTokens.push(k);
  }

  const warnings: string[] = [];
  if (fallbackTokens.length > 0) warnings.push(`Missing values: ${fallbackTokens.join(", ")}`);
  const stemRaw = sanitizeFileStem(rendered);
  const fallbackUsed = !stemRaw || stemRaw === "document";
  const stem = fallbackUsed
    ? sanitizeFileStem(`${ctxSafe(params.ctx.caseReferenceNo) || "CASE"} ${ctxSafe(params.ctx.documentName) || ctxSafe(params.ctx.templateName) || "Document"} ${fmtDateYMD(params.ctx.now ?? new Date())}`)
    : stemRaw;
  if (fallbackUsed) warnings.push("Rule rendered empty; fallback filename pattern applied");
  const fileName = truncateFileNamePreserveExt(`${stem}.${ext}`, maxLen, basenameMaxLen);

  return {
    fileName,
    ruleUsed,
    tokens,
    resolvedTokens,
    fallbackTokens,
    warnings,
    fallbackUsed,
  };
}

function ctxSafe(v: string | null | undefined): string {
  return String(v || "").trim();
}
