import * as XLSX from "xlsx";

export function escapeCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (s.length === 0) return s;
  const first = s.charAt(0);
  if (first === "=" || first === "-" || first === "+" || first === "@") {
    return "'" + s;
  }
  return s;
}

type ReportRow = {
  sourceRowNo?: number | null;
  sourceReference?: string | null;
  purchaserSummary?: string | null;
  parcelNo?: string | null;
  result?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  warnings?: Array<{ code: string; field?: string; message: string }>;
  rawRow?: Record<string, unknown>;
};

export function writeLegacyErrorReportXlsxBuffer(reportRows: ReportRow[]): Buffer {
  const headerRow = [
    "Row No",
    "Our Ref",
    "Purchaser(s)",
    "Parcel No",
    "Status",
    "Error Code",
    "Error Message",
    "Warnings",
  ];

  const warningKeys: string[] = [];
  const rawKeys: string[] = [];

  for (const row of reportRows) {
    if (row.warnings) {
      for (const w of row.warnings) {
        if (w.field && !warningKeys.includes(w.field)) {
          warningKeys.push(w.field);
        }
      }
    }
    if (row.rawRow) {
      for (const k of Object.keys(row.rawRow)) {
        if (!rawKeys.includes(k)) {
          rawKeys.push(k);
        }
      }
    }
  }

  const headers = [...headerRow, ...warningKeys, ...rawKeys];

  const aoaData: unknown[][] = [headers.map((h) => escapeCell(h))];

  for (const row of reportRows) {
    const warningsMap: Record<string, string> = {};
    if (row.warnings) {
      for (const w of row.warnings) {
        if (w.field) {
          warningsMap[w.field] = w.message;
        }
      }
    }
    const warningsStr = row.warnings
      ? row.warnings.map((w) => `${w.code}: ${w.message}`).join(" | ")
      : "";

    const baseRow = [
      row.sourceRowNo ?? "",
      row.sourceReference ?? "",
      row.purchaserSummary ?? "",
      row.parcelNo ?? "",
      row.result ?? "",
      row.errorCode ?? "",
      row.errorMessage ?? "",
      warningsStr,
    ];

    const warningCols = warningKeys.map((k) => warningsMap[k] ?? "");
    const rawCols = rawKeys.map((k) =>
      row.rawRow ? escapeCell(row.rawRow[k]) : ""
    );

    const escapedBase = baseRow.map((v) => escapeCell(v));
    const escapedWarnings = warningCols.map((v) => escapeCell(v));

    aoaData.push([...escapedBase, ...escapedWarnings, ...rawCols]);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoaData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Errors");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return Buffer.from(buffer);
}
