import * as XLSX from "xlsx";
import { createHash } from "node:crypto";

export type LegacyExcelFormat = "xlsx" | "xlsm" | "xls" | "csv";

export type LegacyExcelSecurityError =
  | { code: "LEGACY_IMPORT_FILE_TOO_LARGE"; detail: { maxBytes: number; actualBytes: number } }
  | { code: "LEGACY_IMPORT_TOO_MANY_ROWS"; detail: { maxRows: number; actualRows: number } }
  | { code: "LEGACY_IMPORT_TOO_MANY_COLUMNS"; detail: { maxCols: number; actualCols: number } }
  | { code: "LEGACY_IMPORT_TOO_MANY_SHEETS"; detail: { maxSheets: number; actualSheets: number } }
  | { code: "LEGACY_IMPORT_FORMAT_UNSUPPORTED"; detail: { extension: string } }
  | { code: "LEGACY_IMPORT_PARSE_FAILED"; detail: { message: string } };

export const LEGACY_IMPORT_LIMITS = {
  MAX_FILE_BYTES: 25 * 1024 * 1024,
  MAX_SHEETS: 50,
  MAX_ROWS: 10_000,
  MAX_COLUMNS: 500,
} as const;

export type ParsedExcelWorkbook = {
  format: LegacyExcelFormat;
  sheetNames: string[];
  sheets: Record<string, ParsedExcelSheet>;
};

export type ParsedExcelSheet = {
  name: string;
  headers: string[];
  rows: Array<Record<string, unknown>>;
  totalRowCount: number;
  columnCount: number;
  hasMacros?: boolean;
};

export function detectExcelFormat(fileName: string): LegacyExcelFormat | null {
  const ext = fileName.includes(".")
    ? fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase()
    : "";
  switch (ext) {
    case "xlsx":
      return "xlsx";
    case "xlsm":
      return "xlsm";
    case "xls":
      return "xls";
    case "csv":
      return "csv";
    default:
      return null;
  }
}

export function normalizeHeader(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return "";
  if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return "";
  return String(v)
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function computeHeaderFingerprint(headers: string[]): string {
  const nonEmpty = headers
    .map(normalizeHeader)
    .filter((h) => h.length > 0);
  const joined = nonEmpty.join("||");
  return createHash("sha256").update(joined, "utf8").digest("hex");
}

export async function parseExcelWorkbook(
  buffer: Buffer,
  fileName: string
): Promise<{ ok: true; data: ParsedExcelWorkbook } | { ok: false; error: LegacyExcelSecurityError }> {
  const actualBytes = buffer.length;
  if (actualBytes > LEGACY_IMPORT_LIMITS.MAX_FILE_BYTES) {
    return {
      ok: false,
      error: {
        code: "LEGACY_IMPORT_FILE_TOO_LARGE",
        detail: {
          maxBytes: LEGACY_IMPORT_LIMITS.MAX_FILE_BYTES,
          actualBytes,
        },
      },
    };
  }

  const format = detectExcelFormat(fileName);
  if (format === null) {
    const extension = fileName.includes(".")
      ? fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase()
      : "";
    return {
      ok: false,
      error: {
        code: "LEGACY_IMPORT_FORMAT_UNSUPPORTED",
        detail: { extension },
      },
    };
  }

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, {
      type: "buffer",
      cellDates: true,
      cellNF: false,
      cellHTML: false,
      ...({ VBA: false } as XLSX.ParsingOptions),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: {
        code: "LEGACY_IMPORT_PARSE_FAILED",
        detail: { message },
      },
    };
  }

  const sheetNames = workbook.SheetNames;
  const actualSheets = sheetNames.length;
  if (actualSheets > LEGACY_IMPORT_LIMITS.MAX_SHEETS) {
    return {
      ok: false,
      error: {
        code: "LEGACY_IMPORT_TOO_MANY_SHEETS",
        detail: {
          maxSheets: LEGACY_IMPORT_LIMITS.MAX_SHEETS,
          actualSheets,
        },
      },
    };
  }

  const hasMacros = format === "xlsm";
  const sheets: Record<string, ParsedExcelSheet> = {};

  for (const sheetName of sheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;

    const rawMatrix = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
      header: 1,
      defval: null,
      blankrows: false,
    });

    if (rawMatrix.length === 0) {
      sheets[sheetName] = {
        name: sheetName,
        headers: [],
        rows: [],
        totalRowCount: 0,
        columnCount: 0,
        hasMacros,
      };
      continue;
    }

    const rawHeaders = rawMatrix[0] ?? [];
    const actualCols = rawHeaders.length;
    if (actualCols > LEGACY_IMPORT_LIMITS.MAX_COLUMNS) {
      return {
        ok: false,
        error: {
          code: "LEGACY_IMPORT_TOO_MANY_COLUMNS",
          detail: {
            maxCols: LEGACY_IMPORT_LIMITS.MAX_COLUMNS,
            actualCols,
          },
        },
      };
    }

    const headers = rawHeaders.map(normalizeHeader);

    const dataRows = rawMatrix.slice(1);
    const totalRowCount = dataRows.length;
    if (totalRowCount > LEGACY_IMPORT_LIMITS.MAX_ROWS) {
      return {
        ok: false,
        error: {
          code: "LEGACY_IMPORT_TOO_MANY_ROWS",
          detail: {
            maxRows: LEGACY_IMPORT_LIMITS.MAX_ROWS,
            actualRows: totalRowCount,
          },
        },
      };
    }

    const rows: Array<Record<string, unknown>> = [];
    for (const rawRow of dataRows) {
      const rowObj: Record<string, unknown> = {};
      for (let i = 0; i < headers.length; i++) {
        const key = headers[i];
        if (!key) continue;
        rowObj[key] = rawRow[i] ?? null;
      }
      rows.push(rowObj);
    }

    sheets[sheetName] = {
      name: sheetName,
      headers,
      rows,
      totalRowCount,
      columnCount: actualCols,
      hasMacros,
    };
  }

  return {
    ok: true,
    data: {
      format,
      sheetNames,
      sheets,
    },
  };
}
