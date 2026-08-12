export type LegacyParsedDateStatus = "valid" | "blank" | "not_applicable" | "unknown" | "ambiguous" | "invalid";

export type LegacyParsedDate = {
  rawValue: unknown;
  normalizedDate: string | null;
  status: LegacyParsedDateStatus;
  warnings: string[];
};

function isValidYmd(yyyy: number, mm: number, dd: number): boolean {
  if (!Number.isFinite(yyyy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return false;
  if (mm < 1 || mm > 12) return false;
  if (dd < 1 || dd > 31) return false;
  const dt = new Date(Date.UTC(yyyy, mm - 1, dd));
  return (
    dt.getUTCFullYear() === yyyy &&
    dt.getUTCMonth() + 1 === mm &&
    dt.getUTCDate() === dd
  );
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatYmd(yyyy: number, mm: number, dd: number): string {
  return `${yyyy}-${pad2(mm)}-${pad2(dd)}`;
}

function excelSerialToDate(serial: number): Date | null {
  if (!Number.isFinite(serial)) return null;
  if (serial < 0) return null;
  const EXCEL_EPOCH_OFFSET = 25569;
  const SECONDS_PER_DAY = 86400;
  const corrected = serial >= 60 ? serial - 1 : serial;
  const utcDays = corrected - EXCEL_EPOCH_OFFSET;
  const timestamp = utcDays * SECONDS_PER_DAY * 1000;
  const dt = new Date(timestamp);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function tryParseDirect(s: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (isValidYmd(y, mo, d)) return formatYmd(y, mo, d);
    return null;
  }
  return null;
}

function tryParseDotted(s: string): string | null {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const y = Number(m[3]);
    if (isValidYmd(y, mo, d)) return formatYmd(y, mo, d);
    return null;
  }
  return null;
}

function tryParseSlashed(s: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const y = Number(m[3]);
    if (isValidYmd(y, mo, d)) return formatYmd(y, mo, d);
    return null;
  }
  return null;
}

const DATE_PATTERN_INFO = [
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, order: "ymd" as const },
  { re: /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g, order: "dmy" as const },
  { re: /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, order: "dmy" as const },
];

type DateMatch = { y: number; mo: number; d: number; rawMatch: string };

function findAllDateMatches(s: string): DateMatch[] {
  const results: DateMatch[] = [];
  for (const { re, order } of DATE_PATTERN_INFO) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      let y: number, mo: number, d: number;
      if (order === "ymd") {
        y = Number(m[1]);
        mo = Number(m[2]);
        d = Number(m[3]);
      } else {
        d = Number(m[1]);
        mo = Number(m[2]);
        y = Number(m[3]);
      }
      if (isValidYmd(y, mo, d)) {
        results.push({ y, mo, d, rawMatch: m[0] });
      }
    }
  }
  return results;
}

export function parseLegacyDate(raw: unknown): LegacyParsedDate {
  if (raw === undefined || raw === null) {
    return { rawValue: raw, normalizedDate: null, status: "blank", warnings: [] };
  }

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return { rawValue: raw, normalizedDate: null, status: "blank", warnings: [] };
    }

    const upper = trimmed.toUpperCase();
    if (upper === "N/A" || upper === "NA" || trimmed === "-") {
      return { rawValue: raw, normalizedDate: null, status: "not_applicable", warnings: [] };
    }

    if (trimmed === "?") {
      return { rawValue: raw, normalizedDate: null, status: "unknown", warnings: [] };
    }

    const direct = tryParseDirect(trimmed);
    if (direct) {
      return { rawValue: raw, normalizedDate: direct, status: "valid", warnings: [] };
    }

    const dotted = tryParseDotted(trimmed);
    if (dotted) {
      return { rawValue: raw, normalizedDate: dotted, status: "valid", warnings: [] };
    }

    const slashed = tryParseSlashed(trimmed);
    if (slashed) {
      return { rawValue: raw, normalizedDate: slashed, status: "valid", warnings: [] };
    }

    const matches = findAllDateMatches(trimmed);
    if (matches.length >= 2) {
      return {
        rawValue: raw,
        normalizedDate: null,
        status: "ambiguous",
        warnings: ["MULTIPLE_DATES_DETECTED"],
      };
    }

    if (matches.length === 1) {
      const { y, mo, d, rawMatch } = matches[0];
      const surrounding = trimmed.replace(rawMatch, "").trim();
      const hasSurroundingContext = surrounding.length > 0;
      if (hasSurroundingContext) {
        return {
          rawValue: raw,
          normalizedDate: null,
          status: "ambiguous",
          warnings: ["MULTIPLE_DATES_DETECTED"],
        };
      }
      return {
        rawValue: raw,
        normalizedDate: formatYmd(y, mo, d),
        status: "valid",
        warnings: [],
      };
    }

    return {
      rawValue: raw,
      normalizedDate: null,
      status: "invalid",
      warnings: ["INVALID_DATE_FORMAT"],
    };
  }

  if (typeof raw === "number") {
    if (Number.isNaN(raw) || !Number.isFinite(raw)) {
      return {
        rawValue: raw,
        normalizedDate: null,
        status: "invalid",
        warnings: ["INVALID_DATE_FORMAT"],
      };
    }
    const dt = excelSerialToDate(raw);
    if (dt) {
      const y = dt.getUTCFullYear();
      const mo = dt.getUTCMonth() + 1;
      const d = dt.getUTCDate();
      return {
        rawValue: raw,
        normalizedDate: formatYmd(y, mo, d),
        status: "valid",
        warnings: [],
      };
    }
    return {
      rawValue: raw,
      normalizedDate: null,
      status: "invalid",
      warnings: ["INVALID_DATE_FORMAT"],
    };
  }

  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) {
      return {
        rawValue: raw,
        normalizedDate: null,
        status: "invalid",
        warnings: ["INVALID_DATE_FORMAT"],
      };
    }
    const y = raw.getUTCFullYear();
    const mo = raw.getUTCMonth() + 1;
    const d = raw.getUTCDate();
    return {
      rawValue: raw,
      normalizedDate: formatYmd(y, mo, d),
      status: "valid",
      warnings: [],
    };
  }

  return {
    rawValue: raw,
    normalizedDate: null,
    status: "invalid",
    warnings: ["INVALID_DATE_FORMAT"],
  };
}
