export type ExcelColumnMapping = {
  excelHeader: string;
  target: string;
  arrayIndex?: number;
};

export type MappingTemplateDefinition = {
  columns: ExcelColumnMapping[];
  fixedValues?: Record<string, unknown>;
};

export type MappedRowPayload = {
  case: Record<string, unknown>;
  purchasers: Array<Record<string, unknown>>;
  borrowers: Array<Record<string, unknown>>;
  property: Record<string, unknown>;
  financing: Record<string, unknown>;
  keyDates: Record<string, unknown>;
  rawSnapshot: Record<string, unknown>;
  warnings: string[];
};

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, " ");
}

function detectArrayIndexFromHeader(
  header: string,
  target: string,
): number | undefined {
  if (
    !target.startsWith("purchaser.") &&
    !target.startsWith("borrower.")
  ) {
    return undefined;
  }

  const normalized = header.trim().toLowerCase();

  const match = normalized.match(/(purchaser|borrower)\s*(\d+)/i);
  if (match && match[2]) {
    const idx = parseInt(match[2], 10);
    if (!isNaN(idx) && idx >= 1 && idx <= 4) {
      return idx - 1;
    }
  }

  return 0;
}

export function autoMapHeaders(
  headers: string[],
  presetMapping: Record<string, string>,
): MappingTemplateDefinition {
  const columns: ExcelColumnMapping[] = [];
  const normalizedPreset: Record<string, string> = {};

  for (const key of Object.keys(presetMapping)) {
    normalizedPreset[normalizeHeader(key)] = presetMapping[key];
  }

  for (const header of headers) {
    const normalized = normalizeHeader(header);
    const target = normalizedPreset[normalized];

    if (target) {
      const arrayIndex = detectArrayIndexFromHeader(header, target);
      columns.push({
        excelHeader: header,
        target,
        ...(arrayIndex !== undefined ? { arrayIndex } : {}),
      });
    }
  }

  return { columns };
}

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  return false;
}

function parseNumericValue(
  raw: unknown,
  header: string,
  warnings: string[],
): number | null {
  if (isBlank(raw)) return null;

  let cleaned: string;
  if (typeof raw === "number") {
    return isNaN(raw) ? null : raw;
  }
  if (typeof raw === "string") {
    cleaned = raw
      .replace(/RM/gi, "")
      .replace(/rm/g, "")
      .replace(/,/g, "")
      .trim();
  } else {
    cleaned = String(raw);
  }

  if (cleaned === "") return null;

  const parsed = Number(cleaned);
  if (isNaN(parsed)) {
    warnings.push(
      `NUMERIC_PARSE_FAILED: header="${header}" value="${String(raw).slice(0, 60)}"`,
    );
    return null;
  }

  return parsed;
}

function getEntityAndField(target: string): {
  entity: string;
  field: string;
} {
  const dotIdx = target.indexOf(".");
  if (dotIdx === -1) {
    return { entity: target, field: target };
  }
  return {
    entity: target.slice(0, dotIdx),
    field: target.slice(dotIdx + 1),
  };
}

const NUMERIC_TARGETS = new Set([
  "case.spaPrice",
  "case.apdlPrice",
  "case.developerDiscount",
  "case.bumiputraDiscount",
  "property.areaSqm",
  "financing.propertyFinancingSum",
  "financing.loanAmount",
]);

const DATE_TARGETS = new Set([
  "keydate.spa_date",
  "keydate.spa_stamped_date",
  "keydate.letter_of_offer_date",
  "keydate.loan_docs_signed_date",
  "keydate.completion_date",
]);

const ACCEPTABLE_DATE_STATUSES = new Set([
  "valid",
  "blank",
  "not_applicable",
  "unknown",
]);

export function applyRowMapping(
  rawRow: Record<string, unknown>,
  mapping: MappingTemplateDefinition,
  dateParser: (raw: unknown) => {
    normalizedDate: string | null;
    status: string;
    warnings: string[];
  },
): MappedRowPayload {
  const payload: MappedRowPayload = {
    case: {},
    purchasers: [{}, {}, {}, {}],
    borrowers: [{}, {}, {}, {}],
    property: {},
    financing: {},
    keyDates: {},
    rawSnapshot: { ...rawRow },
    warnings: [],
  };

  const mappedHeaders = new Set<string>();

  for (const col of mapping.columns) {
    const header = col.excelHeader;
    const rawValue = rawRow[header];

    if (header in rawRow) {
      mappedHeaders.add(header);
    }

    if (col.target === "IGNORE") {
      continue;
    }

    if (col.target === "LEGACY_SNAPSHOT_ONLY") {
      continue;
    }

    if (isBlank(rawValue)) {
      continue;
    }

    const { entity, field } = getEntityAndField(col.target);

    if (NUMERIC_TARGETS.has(col.target)) {
      const numVal = parseNumericValue(rawValue, header, payload.warnings);
      if (numVal !== null) {
        if (entity === "case") {
          payload.case[field] = numVal;
        } else if (entity === "property") {
          payload.property[field] = numVal;
        } else if (entity === "financing") {
          payload.financing[field] = numVal;
        }
      }
      continue;
    }

    if (DATE_TARGETS.has(col.target)) {
      const result = dateParser(rawValue);
      if (result.warnings && result.warnings.length > 0) {
        for (const w of result.warnings) {
          payload.warnings.push(`DATE_PARSER[${header}]: ${w}`);
        }
      }
      if (!ACCEPTABLE_DATE_STATUSES.has(result.status)) {
        payload.warnings.push(
          `DATE_PARSE_WARNING: header="${header}" status="${result.status}" value="${String(rawValue).slice(0, 60)}"`,
        );
      }
      if (result.normalizedDate !== null) {
        payload.keyDates[field] = result.normalizedDate;
      }
      continue;
    }

    const stringValue =
      typeof rawValue === "string" ? rawValue : String(rawValue);

    switch (entity) {
      case "case":
        payload.case[field] = stringValue;
        break;
      case "property":
        payload.property[field] = stringValue;
        break;
      case "financing":
        payload.financing[field] = stringValue;
        break;
      case "purchaser": {
        const idx = col.arrayIndex ?? 0;
        if (idx >= 0 && idx < 4) {
          payload.purchasers[idx][field] = stringValue;
        } else {
          payload.warnings.push(
            `INVALID_ARRAY_INDEX: header="${header}" target="${col.target}" index=${idx}`,
          );
        }
        break;
      }
      case "borrower": {
        const idx = col.arrayIndex ?? 0;
        if (idx >= 0 && idx < 4) {
          payload.borrowers[idx][field] = stringValue;
        } else {
          payload.warnings.push(
            `INVALID_ARRAY_INDEX: header="${header}" target="${col.target}" index=${idx}`,
          );
        }
        break;
      }
      default:
        payload.warnings.push(
          `UNKNOWN_TARGET_ENTITY: header="${header}" target="${col.target}"`,
        );
    }
  }

  for (const header of Object.keys(rawRow)) {
    if (!mappedHeaders.has(header)) {
      payload.warnings.push(`UNKNOWN_COLUMN: header="${header}"`);
    }
  }

  if (mapping.fixedValues && typeof mapping.fixedValues === "object") {
    for (const fk of Object.keys(mapping.fixedValues)) {
      const { entity, field } = getEntityAndField(fk);
      const fv = mapping.fixedValues[fk];
      switch (entity) {
        case "case":
          payload.case[field] = fv;
          break;
        case "property":
          payload.property[field] = fv;
          break;
        case "financing":
          payload.financing[field] = fv;
          break;
        default:
          break;
      }
    }
  }

  return payload;
}
