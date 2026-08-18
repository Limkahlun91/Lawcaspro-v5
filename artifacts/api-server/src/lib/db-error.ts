export type DbErrorInfo = {
  sqlstate?: string | null;
  sqlState?: string | null;
  code?: string | null;
  name?: string | null;
  table?: string | null;
  column?: string | null;
  constraint?: string | null;
  schema?: string | null;
  detail?: string | null;
  hint?: string | null;
  position?: string | null;
  message?: string | null;
  queryName?: string | null;
  route?: string | null;
  stage?: string | null;
};

export type SafeDatabaseError = DbErrorInfo;

export type DatabaseAvailabilityCategory =
  | "DB_BUSY"
  | "DB_UNAVAILABLE"
  | "DB_RESOURCE_EXHAUSTED"
  | "DATA_ERROR"
  | "INTEGRITY_ERROR"
  | "AUTHZ_ERROR"
  | "UNKNOWN";

const DB_BUSY_SQLSTATES = new Set(["53300"]);
const DB_BUSY_CODES = new Set([
  "ERR_POOL_TIMED_OUT",
  "POOL_TIMEOUT",
  "TIMEOUT",
]);
const DB_BUSY_MESSAGE_TOKENS = [
  "too_many_connections",
  "too many connections",
  "pool_timeout",
  "pool timed out",
  "connection acquisition",
  "saturation",
  "remaining connection slots are reserved",
];

const DB_RESOURCE_EXHAUSTED_SQLSTATES = new Set(["53000", "53100", "53200", "53400"]);
const DB_RESOURCE_EXHAUSTED_CODES = new Set<string>([]);
const DB_RESOURCE_EXHAUSTED_MESSAGE_TOKENS = [
  "insufficient_resources",
  "insufficient resources",
  "disk_full",
  "disk full",
  "out_of_memory",
  "out of memory",
  "configuration_limit_exceeded",
  "configuration limit exceeded",
];

const DB_UNAVAILABLE_SQLSTATES = new Set([
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "57P01",
  "57P02",
  "57P03",
  "57P04",
  "58000",
  "58030",
]);
const DB_UNAVAILABLE_CODES = new Set([
  "PROTOCOL_CONNECTION_LOST",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOENT",
  "ERR_SOCKET_CLOSED",
  "CONNECTION_CLOSED",
]);
const DB_UNAVAILABLE_MESSAGE_TOKENS = [
  "connection refused",
  "connection reset",
  "no route to host",
  "network is unreachable",
  "host unreachable",
  "connection timed out",
  "socket hang up",
  "the database system is starting up",
  "the database system is shutting down",
  "aborting any active transactions",
  "terminating connection due to administrator command",
  "could not translate host name",
  "Name or service not known",
  "getaddrinfo",
];

const INTEGRITY_SQLSTATES = new Set(["23000", "23502", "23503", "23505", "23514"]);
const DATA_SQLSTATES = new Set(["22000", "22001", "22003", "22007", "22008", "22012", "22023"]);
const AUTHZ_SQLSTATES = new Set(["42501", "28000", "28P01", "0P000"]);

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function getString(obj: Record<string, unknown> | null, key: string): string | null {
  if (!obj) return null;
  const v = obj[key];
  return typeof v === "string" && v ? v : null;
}

function parseMessageForRelation(msg: string): { table: string | null; column: string | null } {
  const rel = /relation\s+"([^"]+)"\s+does\s+not\s+exist/i.exec(msg);
  if (rel?.[1]) return { table: rel[1], column: null };
  const perm = /permission\s+denied\s+for\s+relation\s+"?([^"\s]+)"?/i.exec(msg);
  if (perm?.[1]) return { table: perm[1], column: null };
  const colOfRel = /column\s+"([^"]+)"\s+of\s+relation\s+"([^"]+)"\s+does\s+not\s+exist/i.exec(msg);
  if (colOfRel?.[1] && colOfRel?.[2]) return { column: colOfRel?.[1], table: colOfRel[2] };
  const col = /column\s+"([^"]+)"\s+does\s+not\s+exist/i.exec(msg);
  if (col?.[1]) return { column: col[1], table: null };
  return { table: null, column: null };
}

function getFirstDbLikeRecord(err: unknown): Record<string, unknown> | null {
  const seen = new Set<unknown>();
  const queue: unknown[] = [err];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (!cur || seen.has(cur)) continue;
    seen.add(cur);
    const rec = asRecord(cur);
    if (!rec) continue;
    if (typeof rec.code === "string") return rec;
    for (const k of ["cause", "original", "parent", "error", "err"]) {
      const next = rec[k];
      if (next && typeof next === "object") queue.push(next);
    }
  }
  return null;
}

function getErrorCode(err: unknown): string | null {
  const rec = getFirstDbLikeRecord(err);
  const direct = asRecord(err);
  return getString(rec, "code") ?? getString(direct, "code") ?? null;
}

function getErrorMessage(err: unknown): string | null {
  if (err instanceof Error && err.message) return err.message;
  const rec = asRecord(err);
  if (rec && typeof rec.message === "string") return rec.message;
  const db = getFirstDbLikeRecord(err);
  return getString(db, "message") ?? getString(db, "detail") ?? null;
}

export function extractDbErrorInfo(err: unknown): DbErrorInfo {
  const rec = getFirstDbLikeRecord(err);
  const message = err instanceof Error ? err.message : rec && typeof rec.message === "string" ? String(rec.message) : null;
  const sqlstate = getString(rec, "code") ?? getString(rec, "sqlstate") ?? getString(rec, "sqlState");
  const name = err instanceof Error ? err.name : getString(rec, "name");
  const table = getString(rec, "table");
  const column = getString(rec, "column");
  const constraint = getString(rec, "constraint");
  const schema = getString(rec, "schema");
  const detail = getString(rec, "detail");
  const hint = getString(rec, "hint");
  const position = getString(rec, "position");
  const parsed = message ? parseMessageForRelation(message) : { table: null, column: null };
  return {
    sqlstate,
    sqlState: sqlstate,
    code: sqlstate,
    name,
    table: table ?? parsed.table,
    column: column ?? parsed.column,
    constraint,
    schema,
    detail,
    hint,
    position,
    message: message ? String(message) : null,
  };
}

export const extractSafeDatabaseError = extractDbErrorInfo;

export function classifyDatabaseError(err: unknown): DatabaseAvailabilityCategory {
  const info = extractDbErrorInfo(err);
  const state = (info.sqlstate || info.sqlState || "").toUpperCase();
  const code = (getErrorCode(err) || "").toUpperCase();
  const msg = (getErrorMessage(err) || "").toLowerCase();

  if (state && DB_BUSY_SQLSTATES.has(state)) return "DB_BUSY";
  if (code && DB_BUSY_CODES.has(code)) return "DB_BUSY";
  for (const token of DB_BUSY_MESSAGE_TOKENS) if (msg.includes(token)) return "DB_BUSY";

  if (state && DB_RESOURCE_EXHAUSTED_SQLSTATES.has(state)) return "DB_RESOURCE_EXHAUSTED";
  if (code && DB_RESOURCE_EXHAUSTED_CODES.has(code)) return "DB_RESOURCE_EXHAUSTED";
  for (const token of DB_RESOURCE_EXHAUSTED_MESSAGE_TOKENS) if (msg.includes(token)) return "DB_RESOURCE_EXHAUSTED";

  if (state && DB_UNAVAILABLE_SQLSTATES.has(state)) return "DB_UNAVAILABLE";
  if (code && DB_UNAVAILABLE_CODES.has(code)) return "DB_UNAVAILABLE";
  for (const token of DB_UNAVAILABLE_MESSAGE_TOKENS) if (msg.includes(token)) return "DB_UNAVAILABLE";

  if (state && INTEGRITY_SQLSTATES.has(state)) return "INTEGRITY_ERROR";
  if (state && DATA_SQLSTATES.has(state)) return "DATA_ERROR";
  if (state && AUTHZ_SQLSTATES.has(state)) return "AUTHZ_ERROR";
  return "UNKNOWN";
}

export function databaseErrorHttpStatus(category: DatabaseAvailabilityCategory): number {
  if (category === "DB_BUSY") return 503;
  if (category === "DB_RESOURCE_EXHAUSTED") return 503;
  if (category === "DB_UNAVAILABLE") return 503;
  if (category === "INTEGRITY_ERROR") return 409;
  if (category === "DATA_ERROR") return 400;
  if (category === "AUTHZ_ERROR") return 403;
  return 500;
}

export function databaseErrorCode(category: DatabaseAvailabilityCategory): string {
  switch (category) {
    case "DB_BUSY":
      return "DB_BUSY";
    case "DB_RESOURCE_EXHAUSTED":
      return "DB_RESOURCE_EXHAUSTED";
    case "DB_UNAVAILABLE":
      return "DB_UNAVAILABLE";
    case "INTEGRITY_ERROR":
      return "DB_INTEGRITY";
    case "DATA_ERROR":
      return "DB_DATA";
    case "AUTHZ_ERROR":
      return "DB_AUTHZ";
    default:
      return "DB_ERROR";
  }
}

export function databaseErrorSafeMessage(category: DatabaseAvailabilityCategory): string {
  switch (category) {
    case "DB_BUSY":
      return "Our database is currently under heavy load. Please try again in a few moments.";
    case "DB_RESOURCE_EXHAUSTED":
      return "Our database service is experiencing resource constraints. Please try again shortly or contact support if the issue persists.";
    case "DB_UNAVAILABLE":
      return "Our database service is temporarily unavailable. Please try again shortly or contact support if the issue persists.";
    case "INTEGRITY_ERROR":
      return "The requested operation conflicts with existing data constraints.";
    case "DATA_ERROR":
      return "The request contains invalid data. Please review and try again.";
    case "AUTHZ_ERROR":
      return "Access denied.";
    default:
      return "An unexpected error occurred while processing your request.";
  }
}

export function databaseErrorRetryable(category: DatabaseAvailabilityCategory): boolean {
  return category === "DB_BUSY" || category === "DB_RESOURCE_EXHAUSTED" || category === "DB_UNAVAILABLE";
}

export function databaseErrorLogToken(category: DatabaseAvailabilityCategory): string {
  if (category === "DB_BUSY") return "api.db_busy";
  if (category === "DB_RESOURCE_EXHAUSTED") return "api.db_resource_exhausted";
  if (category === "DB_UNAVAILABLE") return "api.db_unavailable";
  return "api.db_error";
}
