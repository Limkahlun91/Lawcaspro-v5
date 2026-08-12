import { and, eq, isNotNull, or, inArray } from "drizzle-orm";
import {
  db,
  legacyCaseImportBatchesTable,
  legacyCaseImportRowsTable,
  projectsTable,
  developersTable,
  auditLogsTable,
} from "@workspace/db";
import {
  detectLegacyDuplicates,
  normalizeLegacyReference,
  normalizeLegacyNric,
  normalizeLegacyName,
  normalizeLegacyParcel,
  type LegacyDuplicateResult,
  type LegacyPossibleDuplicateResult,
} from "./legacy-case-duplicate-detector.js";
import { parseLegacyDate } from "./legacy-date-parser.js";
import {
  applyRowMapping,
  type ExcelColumnMapping,
  type MappingTemplateDefinition,
  type MappedRowPayload,
} from "./mapping-engine.js";
import {
  createCaseCanonical,
  createCaseCanonicalInTx,
  type CanonicalCaseCreateContext,
  type CanonicalCaseCreateInput,
  type CanonicalPurchaserInput,
  type CanonicalBorrowerInput,
} from "../create-case-canonical.service.js";

type DbConnLike = any;

export const LEGACY_IMPORT_V1_CASE_TYPE = "developer_sales" as const;
export type LegacyImportV1CaseType = typeof LEGACY_IMPORT_V1_CASE_TYPE;

export type LegacyFixedValues = {
  projectId: number | null;
  developerId: number | null;
  caseType: LegacyImportV1CaseType;
  preserveRef: boolean;
};

export function deriveLegacyPurchaseMode(
  borrowers: unknown[],
  financing: Record<string, unknown> | null | undefined,
): "cash" | "loan" {
  if (Array.isArray(borrowers) && borrowers.length > 0) return "loan";
  if (!financing) return "cash";
  const nonBlank = (v: unknown) =>
    (typeof v === "string" && v.trim().length > 0) ||
    (typeof v === "number" && Number.isFinite(v) && v > 0) ||
    (typeof v === "number" && Number.isFinite(v));
  if (nonBlank(financing.endFinancierBank ?? financing.end_financier ?? financing.endFinancier)) return "loan";
  const financingSum = financing.propertyFinancingSum ?? financing.financingAmount ?? financing.loanAmount;
  if (typeof financingSum === "number" && Number.isFinite(financingSum) && financingSum > 0) return "loan";
  const loanAmount = financing.loanAmount ?? financing.loan_amount ?? financing.totalLoan;
  if (typeof loanAmount === "number" && Number.isFinite(loanAmount) && loanAmount > 0) return "loan";
  if (nonBlank(financing.bankRef)) return "loan";
  return "cash";
}

function normalizeIdentityKey(p: { ic?: string | null; tin?: string | null; name: string }): string {
  if (p.ic && String(p.ic).trim()) return `ic:${String(p.ic).trim().toLowerCase()}`;
  if (p.tin && String(p.tin).trim()) return `tin:${String(p.tin).trim().toLowerCase()}`;
  return `name:${String(p.name ?? "").trim().toLowerCase()}`;
}

export function deriveLegacyLoanPartyType(
  purchasers: CanonicalPurchaserInput[],
  borrowers: CanonicalBorrowerInput[],
): { loanPartyType: "1st_party" | "3rd_party"; borrowerMode: "same_as_purchaser" | "separate" | "none" } {
  if (!borrowers || borrowers.length === 0) return { loanPartyType: "1st_party", borrowerMode: "none" };
  if (!purchasers || purchasers.length === 0) return { loanPartyType: "3rd_party", borrowerMode: "separate" };
  const purchaserKeys = new Set(purchasers.map(normalizeIdentityKey));
  let matches = 0;
  for (const b of borrowers) {
    const k = normalizeIdentityKey(b);
    if (purchaserKeys.has(k)) matches++;
  }
  if (matches === borrowers.length && purchasers.length >= borrowers.length) {
    return { loanPartyType: "1st_party", borrowerMode: "same_as_purchaser" };
  }
  return { loanPartyType: "3rd_party", borrowerMode: "separate" };
}

export type FixedValuesInput = {
  firmId: number;
  projectId?: number | null;
  developerId?: number | null;
};

export type FixedValuesResult =
  | {
      ok: true;
      project: typeof projectsTable.$inferSelect | null;
      developer: typeof developersTable.$inferSelect | null;
    }
  | {
      ok: false;
      code:
        | "PROJECT_NOT_FOUND"
        | "DEVELOPER_NOT_FOUND"
        | "PROJECT_CROSS_FIRM"
        | "DEVELOPER_CROSS_FIRM";
      message: string;
    };

export type ValidationIssue = {
  code: string;
  field?: string | null;
  message: string;
};

export type RowStatus =
  | "HARD_DUPLICATE"
  | "INVALID"
  | "REVIEW_REQUIRED"
  | "WARNING"
  | "READY";

export type DryRunValidateRowResult = {
  rowStatus: RowStatus;
  warnings: ValidationIssue[];
  errors: ValidationIssue[];
  possibleDuplicates: LegacyPossibleDuplicateResult[];
  topDuplicateScore?: number | null;
  purchaserSummary: string | null;
  borrowerSummary: string | null;
  propertySummary: string | null;
};

export type DryRunContext = {
  firmId: number;
  actorUserId: number;
  batchId: number;
  fixedProjectId: number | null;
  fixedDeveloperId: number | null;
  preserveRef?: boolean;
};

export type DryRunValidateRowInput = {
  sourceRowNo: number;
  idempotencyKey: string;
  rawRow: Record<string, unknown>;
  mapping: MappingTemplateDefinition;
  purchasers: CanonicalPurchaserInput[];
  borrowers: CanonicalBorrowerInput[];
};

export type RunDryRunSummary = {
  batchId: number;
  totalRows: number;
  readyRows: number;
  warningRows: number;
  reviewRows: number;
  duplicateRows: number;
  invalidRows: number;
  status: typeof legacyCaseImportBatchesTable.$inferSelect.status;
  summary: {
    total: number;
    ready: number;
    warnings: number;
    reviewRequired: number;
    hardDuplicates: number;
    invalid: number;
  };
};

export type ImportOptions = {
  rowIds?: number[];
  includeWarnings?: boolean;
  reviewOverrides?: Record<number, { duplicateAction: "import_anyway" | "skip" }>;
};

export type RunImportSummary = {
  batchId: number;
  status: "completed" | "partial_failed" | "failed";
  summary: {
    requested: number;
    created: number;
    alreadyImported: number;
    duplicatesSkipped: number;
    failed: number;
  };
};

export type RetryOptions = ImportOptions;

export type BatchStatusSummary = {
  total: number;
  imported: number;
  failed: number;
  duplicates: number;
  reviewRequired: number;
  remaining: number;
};

export type RefreshBatchStatusResult = {
  batchId: number;
  status: "importing" | "partial_failed" | "failed" | "completed";
  summary: BatchStatusSummary;
};

export async function writeLegacyImportAuditInTx(
  tx: DbConnLike,
  params: {
    firmId: number;
    actorId: number;
    actorType: string;
    action: string;
    entityType: string;
    entityId: number;
    detail: string;
  },
): Promise<void> {
  await tx.insert(auditLogsTable).values({
    firmId: params.firmId,
    actorId: params.actorId,
    actorType: params.actorType,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId,
    detail: params.detail,
    ipAddress: null,
    userAgent: null,
  });
}

export async function refreshLegacyImportBatchStatus(
  dbConn: DbConnLike,
  batchId: number,
  firmId: number,
): Promise<RefreshBatchStatusResult> {
  const statusRows = await dbConn
    .select({
      rowStatus: legacyCaseImportRowsTable.rowStatus,
      count: dbConn.$count(legacyCaseImportRowsTable.id),
    })
    .from(legacyCaseImportRowsTable)
    .where(
      and(
        eq(legacyCaseImportRowsTable.batchId, batchId),
        eq(legacyCaseImportRowsTable.firmId, firmId),
      ),
    )
    .groupBy(legacyCaseImportRowsTable.rowStatus);

  const counts: Record<string, number> = {};
  for (const sr of statusRows) {
    counts[String(sr.rowStatus)] = Number(sr.count);
  }

  const total = statusRows.reduce((acc, sr) => acc + Number(sr.count), 0);
  const imported = counts["imported"] ?? 0;
  const failed = counts["failed"] ?? 0;
  const duplicates = counts["HARD_DUPLICATE"] ?? 0;
  const reviewRequired = counts["REVIEW_REQUIRED"] ?? 0;

  const readyCount = counts["READY"] ?? 0;
  const warningCount = counts["WARNING"] ?? 0;
  const reviewCountForRemaining = counts["REVIEW_REQUIRED"] ?? 0;
  const remaining = readyCount + warningCount + reviewCountForRemaining > 0
    ? readyCount + warningCount + reviewCountForRemaining
    : 0;

  let status: RefreshBatchStatusResult["status"];
  if (remaining > 0) {
    status = "importing";
  } else if (failed > 0 && imported > 0) {
    status = "partial_failed";
  } else if (failed > 0) {
    status = "failed";
  } else {
    status = "completed";
  }

  const updatePayload: Partial<typeof legacyCaseImportBatchesTable.$inferInsert> = {
    status,
    importedRows: imported,
    failedRows: failed,
    updatedAt: new Date(),
  };
  if (status !== "importing") {
    updatePayload.completedAt = new Date();
  }

  await dbConn
    .update(legacyCaseImportBatchesTable)
    .set(updatePayload)
    .where(
      and(
        eq(legacyCaseImportBatchesTable.id, batchId),
        eq(legacyCaseImportBatchesTable.firmId, firmId),
      ),
    );

  return {
    batchId,
    status,
    summary: {
      total,
      imported,
      failed,
      duplicates,
      reviewRequired,
      remaining,
    },
  };
}

export async function validateFixedValues(
  r: DbConnLike,
  firmId: number,
  fixed: { projectId?: number | null; developerId?: number | null },
): Promise<FixedValuesResult> {
  const projectId = fixed.projectId ?? null;
  const developerId = fixed.developerId ?? null;

  let project: typeof projectsTable.$inferSelect | null = null;
  let developer: typeof developersTable.$inferSelect | null = null;

  if (projectId !== null) {
    const projects = await r
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId))
      .limit(1);
    if (projects.length === 0) {
      return {
        ok: false,
        code: "PROJECT_NOT_FOUND",
        message: "Project not found",
      };
    }
    project = projects[0];
    if (project.firmId !== firmId) {
      return {
        ok: false,
        code: "PROJECT_CROSS_FIRM",
        message: "Project does not belong to this firm",
      };
    }
  }

  if (developerId !== null) {
    const devs = await r
      .select()
      .from(developersTable)
      .where(eq(developersTable.id, developerId))
      .limit(1);
    if (devs.length === 0) {
      return {
        ok: false,
        code: "DEVELOPER_NOT_FOUND",
        message: "Developer not found",
      };
    }
    developer = devs[0];
    if (developer.firmId !== firmId) {
      return {
        ok: false,
        code: "DEVELOPER_CROSS_FIRM",
        message: "Developer does not belong to this firm",
      };
    }
  }

  return { ok: true, project, developer };
}

function buildPurchaserSummary(purchasers: CanonicalPurchaserInput[]): string | null {
  const names = purchasers
    .map((p) => p.name)
    .filter((n): n is string => Boolean(n && n.trim()))
    .join(" & ");
  return names.length > 0 ? names : null;
}

function buildBorrowerSummary(borrowers: CanonicalBorrowerInput[]): string | null {
  const names = borrowers
    .map((b) => b.name)
    .filter((n): n is string => Boolean(n && n.trim()))
    .join(" & ");
  return names.length > 0 ? names : null;
}

function buildPropertySummary(
  parcel: string | null | undefined,
  address: string | null | undefined,
): string | null {
  const parts: string[] = [];
  if (parcel && String(parcel).trim()) parts.push(String(parcel).trim());
  if (address && String(address).trim()) {
    const addr = String(address).trim();
    parts.push(addr.length > 80 ? addr.slice(0, 77) + "..." : addr);
  }
  const joined = parts.join(" | ");
  return joined.length > 0 ? joined : null;
}

const DATE_FIELD_CODES = [
  { field: "keydate.spa_date" },
  { field: "keydate.letter_of_offer_date" },
  { field: "keydate.spa_stamped_date" },
];

export async function dryRunValidateRow(
  r: DbConnLike,
  context: DryRunContext,
  input: DryRunValidateRowInput,
): Promise<{
  validation: DryRunValidateRowResult;
  mapped: MappedRowPayload;
  duplicate: LegacyDuplicateResult;
}> {
  const { firmId, batchId, fixedProjectId, fixedDeveloperId, preserveRef } = context;
  const { sourceRowNo, idempotencyKey, rawRow, mapping } = input;

  const mapped = applyRowMapping(rawRow, mapping, parseLegacyDate);

  const purchasers: CanonicalPurchaserInput[] = input.purchasers;
  const borrowers: CanonicalBorrowerInput[] = input.borrowers;

  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const purchaser1 = purchasers[0];
  if (!purchaser1 || !purchaser1.name || !purchaser1.name.trim()) {
    errors.push({
      code: "PURCHASER1_NAME_MISSING",
      field: "purchaser.name",
      message: "Purchaser 1 name is required",
    });
  }

  const caseData = mapped.case ?? {};
  const rowProjectId = typeof caseData.projectId === "number" ? caseData.projectId : fixedProjectId;
  const rowDeveloperId = typeof caseData.developerId === "number" ? caseData.developerId : fixedDeveloperId;

  if (rowProjectId === null || rowProjectId === undefined) {
    errors.push({
      code: "NO_PROJECT_SELECTED",
      field: "case.projectId",
      message: "Project must be selected",
    });
  }
  if (rowDeveloperId === null || rowDeveloperId === undefined) {
    errors.push({
      code: "NO_DEVELOPER_SELECTED",
      field: "case.developerId",
      message: "Developer must be selected",
    });
  }

  const referenceRaw = typeof caseData.referenceNo === "string" ? caseData.referenceNo : null;
  const normalizedRef = normalizeLegacyReference(referenceRaw);
  if (preserveRef && (!referenceRaw || !referenceRaw.trim())) {
    errors.push({
      code: "PRESERVE_REF_WITHOUT_VALUE",
      field: "case.referenceNo",
      message: "Preserve reference requires a value in Our Ref column",
    });
  }

  const propertyData = mapped.property ?? {};
  const parcelNoRaw = typeof caseData.parcelNo === "string" ? caseData.parcelNo : (propertyData.parcelNo as string | undefined ?? null);
  const propertyAddress = typeof propertyData.propertyAddress === "string" ? propertyData.propertyAddress : null;
  const propertyDescription = typeof propertyData.description === "string" ? propertyData.description : null;

  const hasParcel = typeof parcelNoRaw === "string" && parcelNoRaw.trim().length > 0;
  const hasAddress = Boolean((propertyAddress && propertyAddress.trim()) || (propertyDescription && propertyDescription.trim()));
  if (!hasParcel && !hasAddress) {
    errors.push({
      code: "NO_PROPERTY_IDENTIFIER",
      field: "case.parcelNo",
      message: "Either parcel number or property address/description is required",
    });
  }

  if (purchaser1 && (!purchaser1.ic || !purchaser1.ic.trim())) {
    warnings.push({
      code: "WARN_PURCHASER_IC_MISSING",
      field: "purchaser[0].ic",
      message: "Purchaser 1 IC / Company number is missing",
    });
  }

  const hasAnyBorrowerBlank = borrowers.some((b) => !b.name || !b.name.trim());
  if (hasAnyBorrowerBlank) {
    warnings.push({
      code: "WARN_BORROWER_BLANK",
      field: "borrower.name",
      message: "Some borrower entries are blank",
    });
  }

  const financingData = mapped.financing ?? {};
  const loanAmount = financingData.loanAmount ?? financingData.propertyFinancingSum;
  const endFinancierBank = financingData.endFinancierBank ?? financingData.end_financier ?? financingData.endFinancier;
  if (loanAmount !== null && loanAmount !== undefined && !(endFinancierBank && String(endFinancierBank).trim())) {
    warnings.push({
      code: "WARN_BANK_MISSING",
      field: "financing.endFinancierBank",
      message: "End Financier Bank is missing for loan",
    });
  }

  const keyDates = mapped.keyDates ?? {};
  const mappedKeypaths = new Set<string>();
  for (const col of mapping.columns) {
    if (DATE_FIELD_CODES.some((d) => col.target === d.field)) {
      mappedKeypaths.add(col.target);
    }
  }
  for (const dateSpec of DATE_FIELD_CODES) {
    const key = dateSpec.field.split(".").pop()!;
    const val = keyDates[key];
    if (val === null || val === undefined) {
      // Only warn for blanks if the user did NOT explicitly map the column.
      // Per rule: blank → no error no warning; not_applicable → no error no warning.
      // We skip any WARN_*_DATE_BLANK generation entirely.
    }
  }

  const caseTypeRaw = typeof caseData.caseType === "string" ? caseData.caseType : null;
  const assignedLawyerId = typeof caseData.assignedLawyerId === "number" ? caseData.assignedLawyerId : null;
  const assignedClerkId = typeof caseData.assignedClerkId === "number" ? caseData.assignedClerkId : null;
  if (caseTypeRaw && !assignedLawyerId) {
    warnings.push({
      code: "WARN_SOL_UNRESOLVED",
      field: "case.assignedLawyerId",
      message: "Solicitor-in-charge not resolved",
    });
  }

  const contactFields = [
    { obj: purchaser1, label: "Purchaser 1 contact" },
  ];
  for (const cf of contactFields) {
    const p = cf.obj as CanonicalPurchaserInput | undefined;
    if (p && (!p.phone || !p.phone.trim())) {
      warnings.push({
        code: "WARN_CONTACT_MISSING",
        field: "purchaser[0].phone",
        message: `${cf.label} phone missing`,
      });
    }
    if (p && (!p.email || !p.email.trim())) {
      warnings.push({
        code: "WARN_EMAIL_MISSING",
        field: "purchaser[0].email",
        message: `${cf.label} email missing`,
      });
    }
  }

  const headerToDateFieldMap: Record<string, { field: string }> = {};
  for (const col of mapping.columns) {
    if (DATE_FIELD_CODES.some((d) => col.target === d.field)) {
      headerToDateFieldMap[col.excelHeader] = { field: col.target };
    }
  }
  for (const header of Object.keys(rawRow)) {
    const mappingInfo = headerToDateFieldMap[header];
    if (mappingInfo) {
      const parsed = parseLegacyDate((rawRow as Record<string, unknown>)[header]);
      if (parsed.status === "invalid" || parsed.status === "ambiguous") {
        warnings.push({
          code: "WARN_INVALID_DATE",
          field: mappingInfo.field,
          message: `Invalid or ambiguous date in ${header}`,
        });
      }
    }
  }

  if (fixedDeveloperId !== null && rowDeveloperId !== null && fixedDeveloperId !== rowDeveloperId) {
    warnings.push({
      code: "DEVELOPER_VALUE_MISMATCH",
      field: "case.developerId",
      message: "Developer value in row does not match fixed developer value",
    });
  }

  const normalizedParcel = normalizeLegacyParcel(parcelNoRaw);
  const purchaserIcArray = purchasers
    .map((p) => normalizeLegacyNric(p.ic))
    .filter((n) => n.length > 0);
  const purchaserNameArray = purchasers
    .map((p) => normalizeLegacyName(p.name))
    .filter((n) => n.length > 0);

  const duplicate = await detectLegacyDuplicates(r, {
    firmId,
    batchId,
    sourceRowNo,
    idempotencyKey,
    referenceRaw,
    normalizedRef,
    projectId: rowProjectId ?? null,
    developerId: rowDeveloperId ?? null,
    normalizedParcel,
    purchaserIcArray,
    purchaserNameArray,
  });

  let rowStatus: RowStatus;
  let topDuplicateScore: number | null = null;

  if (duplicate.hard !== null) {
    rowStatus = "HARD_DUPLICATE";
  } else if (errors.length > 0) {
    rowStatus = "INVALID";
  } else if (duplicate.possible.length > 0) {
    rowStatus = "REVIEW_REQUIRED";
    topDuplicateScore = duplicate.possible[0].score;
  } else if (warnings.length > 0) {
    rowStatus = "WARNING";
  } else {
    rowStatus = "READY";
  }

  const purchaserSummary = buildPurchaserSummary(purchasers);
  const borrowerSummary = buildBorrowerSummary(borrowers);
  const propertySummary = buildPropertySummary(parcelNoRaw, propertyAddress);

  return {
    validation: {
      rowStatus,
      warnings,
      errors,
      possibleDuplicates: duplicate.possible,
      topDuplicateScore,
      purchaserSummary,
      borrowerSummary,
      propertySummary,
    },
    mapped,
    duplicate,
  };
}

export async function runDryRun(
  dbConn: DbConnLike,
  batchId: number,
  firmId: number,
  actorUserId: number,
): Promise<RunDryRunSummary> {
  const [batch] = await dbConn
    .select()
    .from(legacyCaseImportBatchesTable)
    .where(
      and(
        eq(legacyCaseImportBatchesTable.id, batchId),
        eq(legacyCaseImportBatchesTable.firmId, firmId),
      ),
    )
    .limit(1);

  if (!batch) {
    throw new Error(`Batch ${batchId} not found for firm ${firmId}`);
  }

  const optionsJson: Record<string, unknown> =
    (batch.optionsJson as Record<string, unknown> | null | undefined) ?? {};

  const columnsRaw = (optionsJson.columns as unknown) ?? null;
  const columns: ExcelColumnMapping[] =
    Array.isArray(columnsRaw) ? (columnsRaw as ExcelColumnMapping[]) : [];

  const fixedValuesRaw: Record<string, unknown> =
    (optionsJson.fixedValues as Record<string, unknown> | null | undefined) ?? {};

  const mappingTemplate: MappingTemplateDefinition = {
    columns,
    fixedValues: fixedValuesRaw,
  };

  const selectedFixedValues: {
    projectId: number | null;
    developerId: number | null;
    preserveRef: boolean;
  } = {
    projectId:
      typeof fixedValuesRaw.projectId === "number" ? fixedValuesRaw.projectId : null,
    developerId:
      typeof fixedValuesRaw.developerId === "number" ? fixedValuesRaw.developerId : null,
    preserveRef:
      typeof fixedValuesRaw.preserveRef === "boolean"
        ? fixedValuesRaw.preserveRef
        : true,
  };

  const sheetName =
    typeof batch.sourceSheetName === "string" ? batch.sourceSheetName : "Sheet1";

  const rows = await dbConn
    .select()
    .from(legacyCaseImportRowsTable)
    .where(
      and(
        eq(legacyCaseImportRowsTable.batchId, batchId),
        eq(legacyCaseImportRowsTable.firmId, firmId),
      ),
    )
    .orderBy(legacyCaseImportRowsTable.sourceRowNo);

  const totalRows = rows.length;
  let readyRows = 0;
  let warningRows = 0;
  let reviewRows = 0;
  let duplicateRows = 0;
  let invalidRows = 0;

  const CHUNK_SIZE = 5;

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const chunkResults: Array<{
      row: typeof rows[number];
      result: Awaited<ReturnType<typeof dryRunValidateRow>>;
      purchasers: CanonicalPurchaserInput[];
      borrowers: CanonicalBorrowerInput[];
    }> = [];

    for (const row of chunk) {
      const rawRow = (row.rawRowJson as Record<string, unknown>) ?? {};

      const tempMapped = applyRowMapping(rawRow, mappingTemplate, parseLegacyDate);
      const purchasers: CanonicalPurchaserInput[] = [];
      const borrowers: CanonicalBorrowerInput[] = [];

      for (const p of tempMapped.purchasers) {
        if (p && typeof p.name === "string" && p.name.trim()) {
          purchasers.push({
            name: p.name,
            ic: typeof p.ic === "string" ? p.ic : null,
            phone: typeof p.phone === "string" ? p.phone : null,
            email: typeof p.email === "string" ? p.email : null,
            address: typeof p.address === "string" ? p.address : null,
          });
        }
      }
      for (const b of tempMapped.borrowers) {
        if (b && typeof b.name === "string" && b.name.trim()) {
          borrowers.push({
            name: b.name,
            ic: typeof b.ic === "string" ? b.ic : null,
            tin: typeof b.tin === "string" ? b.tin : null,
            hp: typeof b.hp === "string" ? b.hp : null,
            email: typeof b.email === "string" ? b.email : null,
            address: typeof b.address === "string" ? b.address : null,
            addressLine1: typeof b.addressLine1 === "string" ? b.addressLine1 : null,
            addressLine2: typeof b.addressLine2 === "string" ? b.addressLine2 : null,
            addressLine3: typeof b.addressLine3 === "string" ? b.addressLine3 : null,
            addressLine4: typeof b.addressLine4 === "string" ? b.addressLine4 : null,
            addressLine5: typeof b.addressLine5 === "string" ? b.addressLine5 : null,
            postcode: typeof b.postcode === "string" ? b.postcode : null,
            city: typeof b.city === "string" ? b.city : null,
            state: typeof b.state === "string" ? b.state : null,
          });
        }
      }

      const result = await dryRunValidateRow(dbConn, {
        firmId,
        actorUserId,
        batchId,
        fixedProjectId: selectedFixedValues.projectId ?? null,
        fixedDeveloperId: selectedFixedValues.developerId ?? null,
        preserveRef: selectedFixedValues.preserveRef ?? true,
      }, {
        sourceRowNo: row.sourceRowNo,
        idempotencyKey: row.idempotencyKey,
        rawRow,
        mapping: mappingTemplate,
        purchasers,
        borrowers,
      });

      chunkResults.push({ row, result, purchasers, borrowers });
    }

    for (const { row, result, purchasers, borrowers } of chunkResults) {
      const status: string = result.validation.rowStatus;
      switch (result.validation.rowStatus) {
        case "READY": readyRows++; break;
        case "WARNING": warningRows++; break;
        case "REVIEW_REQUIRED": reviewRows++; break;
        case "HARD_DUPLICATE": duplicateRows++; break;
        case "INVALID": invalidRows++; break;
      }

      const dupType = result.duplicate.hard?.type ?? null;
      const dupCaseId = result.duplicate.hard?.caseId ??
        (result.validation.possibleDuplicates.length > 0 ? result.validation.possibleDuplicates[0].caseId : null);
      const dupScore = result.validation.topDuplicateScore ??
        (result.duplicate.hard ? 100 : null);

      const mappedPayloadStorable: Record<string, unknown> = {
        case: result.mapped.case,
        purchasers,
        borrowers,
        property: result.mapped.property,
        financing: result.mapped.financing,
        keyDates: result.mapped.keyDates,
        purchaserSummary: result.validation.purchaserSummary,
        borrowerSummary: result.validation.borrowerSummary,
        propertySummary: result.validation.propertySummary,
        fixedValues: {
          projectId: selectedFixedValues.projectId ?? null,
          developerId: selectedFixedValues.developerId ?? null,
          caseType: LEGACY_IMPORT_V1_CASE_TYPE,
          preserveRef: selectedFixedValues.preserveRef ?? true,
        },
      };

      const validationJson = {
        rowStatus: result.validation.rowStatus,
        warnings: result.validation.warnings,
        errors: result.validation.errors,
        possibleDuplicates: result.validation.possibleDuplicates,
        purchaserSummary: result.validation.purchaserSummary,
        borrowerSummary: result.validation.borrowerSummary,
        propertySummary: result.validation.propertySummary,
      };

      await dbConn
        .update(legacyCaseImportRowsTable)
        .set({
          rowStatus: status,
          validationJson: validationJson as any,
          mappedPayloadJson: mappedPayloadStorable as any,
          duplicateType: dupType as any,
          duplicateCaseId: dupCaseId,
          duplicateScore: dupScore ? String(dupScore) as any : null,
        })
        .where(
          and(
            eq(legacyCaseImportRowsTable.id, row.id),
            eq(legacyCaseImportRowsTable.firmId, firmId),
          ),
        );
    }
  }

  await dbConn
    .update(legacyCaseImportBatchesTable)
    .set({
      status: "dry_run_completed",
      totalRows,
      readyRows,
      warningRows,
      reviewRows,
      duplicateRows,
      sourceSheetName: sheetName,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(legacyCaseImportBatchesTable.id, batchId),
        eq(legacyCaseImportBatchesTable.firmId, firmId),
      ),
    );

  return {
    batchId,
    totalRows,
    readyRows,
    warningRows,
    reviewRows,
    duplicateRows,
    invalidRows,
    status: "dry_run_completed",
    summary: {
      total: totalRows,
      ready: readyRows,
      warnings: warningRows,
      reviewRequired: reviewRows,
      hardDuplicates: duplicateRows,
      invalid: invalidRows,
    },
  };
}

async function writeAuditBestEffort(
  r: DbConnLike,
  params: {
    firmId: number;
    actorId: number;
    actorType: string;
    action: string;
    entityType: string;
    entityId: number;
    detail: string;
  },
): Promise<void> {
  try {
    await r.insert(auditLogsTable).values({
      firmId: params.firmId,
      actorId: params.actorId,
      actorType: params.actorType,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      detail: params.detail,
      ipAddress: null,
      userAgent: null,
    });
  } catch {
  }
}

type EligibleRow = typeof legacyCaseImportRowsTable.$inferSelect;

export async function runImport(
  dbConn: DbConnLike,
  batchId: number,
  firmId: number,
  actorUserId: number,
  opts: ImportOptions = {},
): Promise<RefreshBatchStatusResult> {
  const rowIds = opts.rowIds ?? null;
  const includeWarnings = opts.includeWarnings ?? false;
  const reviewOverrides = opts.reviewOverrides ?? {};

  const baseQuery = dbConn
    .select()
    .from(legacyCaseImportRowsTable)
    .where(
      and(
        eq(legacyCaseImportRowsTable.batchId, batchId),
        eq(legacyCaseImportRowsTable.firmId, firmId),
      ),
    )
    .orderBy(legacyCaseImportRowsTable.sourceRowNo);

  let allRows: EligibleRow[] = await baseQuery;

  if (rowIds !== null && rowIds.length > 0) {
    const rowIdSet = new Set(rowIds);
    allRows = allRows.filter((r) => rowIdSet.has(r.id));
  }

  const eligibleRows: EligibleRow[] = [];
  const hardDuplicateRows: EligibleRow[] = [];

  for (const row of allRows) {
    switch (row.rowStatus) {
      case "READY":
        eligibleRows.push(row);
        break;
      case "WARNING":
        if (includeWarnings) eligibleRows.push(row);
        break;
      case "REVIEW_REQUIRED": {
        const override = reviewOverrides[row.id];
        if (override && override.duplicateAction === "import_anyway") {
          eligibleRows.push(row);
        }
        break;
      }
      case "HARD_DUPLICATE":
        hardDuplicateRows.push(row);
        break;
      case "INVALID":
      default:
        break;
    }
  }

  for (const row of eligibleRows) {
    const rowId = row.id;

    const preCheck = await dbConn
      .select()
      .from(legacyCaseImportRowsTable)
      .where(
        and(
          eq(legacyCaseImportRowsTable.firmId, firmId),
          or(
            eq(legacyCaseImportRowsTable.idempotencyKey, row.idempotencyKey),
            and(
              eq(legacyCaseImportRowsTable.batchId, row.batchId),
              eq(legacyCaseImportRowsTable.sourceRowNo, row.sourceRowNo),
              isNotNull(legacyCaseImportRowsTable.createdCaseId),
            ),
          ),
        ),
      )
      .limit(1);

    if (preCheck.length > 0 && preCheck[0].createdCaseId !== null) {
      continue;
    }

    const mappedPayload = row.mappedPayloadJson as Record<string, unknown> | null;
    if (!mappedPayload || typeof mappedPayload !== "object") {
      await dbConn
        .update(legacyCaseImportRowsTable)
        .set({
          rowStatus: "failed",
          errorCode: "NO_MAPPED_PAYLOAD",
          errorMessage: "Mapped payload missing. Run dry-run first.",
        })
        .where(
          and(
            eq(legacyCaseImportRowsTable.id, rowId),
            eq(legacyCaseImportRowsTable.firmId, firmId),
          ),
        );
      await writeAuditBestEffort(dbConn, {
        firmId,
        actorId: actorUserId,
        actorType: "firm_user",
        action: "cases.legacy_import.row_failed",
        entityType: "legacy_case_import_row",
        entityId: rowId,
        detail: `batchId=${batchId} rowId=${rowId} errorCode=NO_MAPPED_PAYLOAD error=Mapped payload missing. Run dry-run first.`,
      });
      continue;
    }

    const caseData = (mappedPayload.case ?? {}) as Record<string, unknown>;
    const purchasers = (mappedPayload.purchasers ?? []) as CanonicalPurchaserInput[];
    const borrowers = (mappedPayload.borrowers ?? []) as CanonicalBorrowerInput[];
    const propertyData = (mappedPayload.property ?? {}) as Record<string, unknown>;
    const financingData = (mappedPayload.financing ?? {}) as Record<string, unknown>;
    const keyDates = (mappedPayload.keyDates ?? {}) as Record<string, string | null>;
    const rawFixedValues = (mappedPayload.fixedValues ?? {}) as Record<string, unknown>;

    const rowMappedProjectId = typeof caseData.projectId === "number" ? caseData.projectId : null;
    const rowMappedDeveloperId = typeof caseData.developerId === "number" ? caseData.developerId : null;
    const fixedProjectId = typeof rawFixedValues.projectId === "number" ? rawFixedValues.projectId : null;
    const fixedDeveloperId = typeof rawFixedValues.developerId === "number" ? rawFixedValues.developerId : null;
    const effectiveProjectId = rowMappedProjectId ?? fixedProjectId;
    const effectiveDeveloperId = rowMappedDeveloperId ?? fixedDeveloperId;
    const preserveRef = typeof rawFixedValues.preserveRef === "boolean" ? rawFixedValues.preserveRef : true;
    const purchaseMode = deriveLegacyPurchaseMode(borrowers, financingData);
    const loanPartyInfo = purchaseMode === "loan"
      ? deriveLegacyLoanPartyType(purchasers, borrowers)
      : { loanPartyType: "1st_party" as const, borrowerMode: "none" as const };

    const createInput: CanonicalCaseCreateInput = {
      caseType: LEGACY_IMPORT_V1_CASE_TYPE,
      projectId: effectiveProjectId,
      developerId: effectiveDeveloperId,
      referenceNo: typeof caseData.referenceNo === "string" ? caseData.referenceNo : null,
      purchaseMode,
      titleType: typeof caseData.titleType === "string" ? caseData.titleType : null,
      assignedLawyerId: typeof caseData.assignedLawyerId === "number" ? caseData.assignedLawyerId : null,
      assignedClerkId: typeof caseData.assignedClerkId === "number" ? caseData.assignedClerkId : null,
      purchasers,
      borrowerMode: loanPartyInfo.borrowerMode,
      loanPartyType: loanPartyInfo.loanPartyType,
      borrowers,
      parcelNo: typeof caseData.parcelNo === "string" ? caseData.parcelNo : null,
      propertyAddress: typeof propertyData.propertyAddress === "string" ? propertyData.propertyAddress : null,
      propertyDetails: propertyData,
      loanDetails: Object.keys(financingData).length > 0 ? financingData : null,
      spaPrice: typeof caseData.spaPrice === "number" ? caseData.spaPrice : null,
      apdlPrice: typeof caseData.apdlPrice === "number" ? caseData.apdlPrice : null,
      developerDiscount: typeof caseData.developerDiscount === "number" ? caseData.developerDiscount : null,
      bumiputraDiscount: typeof caseData.bumiputraDiscount === "number" ? caseData.bumiputraDiscount : null,
      mappedKeyDates: {
        spa_date: keyDates.spa_date ?? null,
        spa_stamped_date: keyDates.spa_stamped_date ?? null,
        letter_of_offer_date: keyDates.letter_of_offer_date ?? null,
        loan_docs_signed_date: keyDates.loan_docs_signed_date ?? null,
        completion_date: keyDates.completion_date ?? null,
      },
      migration: {
        mode: "legacy_existing_case",
        sourceBatchId: batchId,
        sourceRowNo: row.sourceRowNo,
        preserveReferenceNo: preserveRef,
        approvalMode: "already_approved",
        suppressNewCaseNotifications: true,
      },
    };

    let importError: { code: string; message: string } | null = null;

    try {
      await dbConn.transaction(async (tx: any) => {
        const ctx: CanonicalCaseCreateContext = {
          db: tx as any,
          firmId,
          actorUserId,
          canAssignAny: true,
          source: "legacy_excel_import",
        };
        const txResult = await createCaseCanonicalInTx(ctx, createInput);
        const createdCaseId = txResult.case.id;

        await tx
          .update(legacyCaseImportRowsTable)
          .set({
            rowStatus: "imported",
            createdCaseId,
            importedAt: new Date(),
          })
          .where(
            and(
              eq(legacyCaseImportRowsTable.id, rowId),
              eq(legacyCaseImportRowsTable.firmId, firmId),
            ),
          );

        await writeLegacyImportAuditInTx(tx, {
          firmId,
          actorId: actorUserId,
          actorType: "firm_user",
          action: "cases.legacy_import.row_imported",
          entityType: "case",
          entityId: createdCaseId,
          detail: `batchId=${batchId} rowId=${rowId} sourceRowNo=${row.sourceRowNo} caseId=${createdCaseId}`,
        });
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      importError = {
        code: err instanceof Error && (err as any).code ? String((err as any).code) : "IMPORT_ERROR",
        message: msg.length > 1000 ? msg.slice(0, 997) + "..." : msg,
      };
    }

    if (importError) {
      await dbConn
        .update(legacyCaseImportRowsTable)
        .set({
          rowStatus: "failed",
          errorCode: importError.code,
          errorMessage: importError.message,
        })
        .where(
          and(
            eq(legacyCaseImportRowsTable.id, rowId),
            eq(legacyCaseImportRowsTable.firmId, firmId),
          ),
        );

      await writeAuditBestEffort(dbConn, {
        firmId,
        actorId: actorUserId,
        actorType: "firm_user",
        action: "cases.legacy_import.row_failed",
        entityType: "legacy_case_import_row",
        entityId: rowId,
        detail: `batchId=${batchId} rowId=${rowId} errorCode=${importError.code} error=${importError.message}`,
      });
    }
  }

  for (const row of hardDuplicateRows) {
    await writeAuditBestEffort(dbConn, {
      firmId,
      actorId: actorUserId,
      actorType: "firm_user",
      action: "cases.legacy_import.row_skipped_duplicate",
      entityType: "legacy_case_import_row",
      entityId: row.id,
      detail: `batchId=${batchId} rowId=${row.id} duplicateType=${row.duplicateType ?? "unknown"} caseId=${row.duplicateCaseId ?? "null"}`,
    });
  }

  return refreshLegacyImportBatchStatus(dbConn, batchId, firmId);
}

export async function retryFailedRows(
  dbConn: DbConnLike,
  batchId: number,
  firmId: number,
  actorUserId: number,
  opts: RetryOptions = {},
): Promise<RefreshBatchStatusResult> {
  const failedRows = await dbConn
    .select()
    .from(legacyCaseImportRowsTable)
    .where(
      and(
        eq(legacyCaseImportRowsTable.batchId, batchId),
        eq(legacyCaseImportRowsTable.firmId, firmId),
        eq(legacyCaseImportRowsTable.rowStatus, "failed"),
      ),
    )
    .orderBy(legacyCaseImportRowsTable.sourceRowNo);

  const idsForRetry = failedRows.map((r) => r.id);
  return runImport(dbConn, batchId, firmId, actorUserId, {
    ...opts,
    rowIds: idsForRetry,
  });
}
