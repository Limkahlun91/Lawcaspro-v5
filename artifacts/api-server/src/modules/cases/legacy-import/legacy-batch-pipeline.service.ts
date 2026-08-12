import { and, eq, isNotNull, or } from "drizzle-orm";
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
  type CanonicalCaseCreateContext,
  type CanonicalCaseCreateInput,
  type CanonicalPurchaserInput,
  type CanonicalBorrowerInput,
} from "../create-case-canonical.service.js";

type DbConnLike = any;

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
  { field: "keydate.spa_date", code: "WARN_SPA_DATE_BLANK" },
  { field: "keydate.letter_of_offer_date", code: "WARN_LO_DATE_BLANK" },
  { field: "keydate.spa_stamped_date", code: "WARN_STAMPED_DATE_BLANK" },
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
  for (const dateSpec of DATE_FIELD_CODES) {
    const key = dateSpec.field.split(".").pop()!;
    const val = keyDates[key];
    if (val === null || val === undefined) {
      const rawVal = (rawRow as Record<string, unknown>)[key] ?? (rawRow as Record<string, unknown>)[dateSpec.field];
      const parsed = parseLegacyDate(rawVal);
      if (parsed.status === "blank") {
        warnings.push({
          code: dateSpec.code,
          field: dateSpec.field,
          message: `${dateSpec.field} is blank`,
        });
      }
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

async function writeAudit(
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
): Promise<RunImportSummary> {
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

  const requested = eligibleRows.length;
  let created = 0;
  let alreadyImported = 0;
  let failed = 0;

  const CHUNK_SIZE = 4;

  for (let i = 0; i < eligibleRows.length; i += CHUNK_SIZE) {
    const chunk = eligibleRows.slice(i, i + CHUNK_SIZE);
    for (const row of chunk) {
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
        alreadyImported++;
        continue;
      }

      const mappedPayload = row.mappedPayloadJson as Record<string, unknown> | null;
      if (!mappedPayload || typeof mappedPayload !== "object") {
        failed++;
        await dbConn
          .update(legacyCaseImportRowsTable)
          .set({
            rowStatus: "failed",
            errorCode: "NO_MAPPED_PAYLOAD",
            errorMessage: "Mapped payload missing. Run dry-run first.",
          })
          .where(eq(legacyCaseImportRowsTable.id, rowId));
        continue;
      }

      const caseData = (mappedPayload.case ?? {}) as Record<string, unknown>;
      const purchasers = (mappedPayload.purchasers ?? []) as CanonicalPurchaserInput[];
      const borrowers = (mappedPayload.borrowers ?? []) as CanonicalBorrowerInput[];
      const propertyData = (mappedPayload.property ?? {}) as Record<string, unknown>;
      const financingData = (mappedPayload.financing ?? {}) as Record<string, unknown>;
      const keyDates = (mappedPayload.keyDates ?? {}) as Record<string, string | null>;

      const projectId = typeof caseData.projectId === "number" ? caseData.projectId : null;
      const developerId = typeof caseData.developerId === "number" ? caseData.developerId : null;

      const createInput: CanonicalCaseCreateInput = {
        caseType: "developer_sales",
        projectId: projectId ?? null,
        developerId: developerId ?? null,
        referenceNo: typeof caseData.referenceNo === "string" ? caseData.referenceNo : null,
        purchaseMode: "cash",
        titleType: typeof caseData.titleType === "string" ? caseData.titleType : null,
        assignedLawyerId: typeof caseData.assignedLawyerId === "number" ? caseData.assignedLawyerId : null,
        assignedClerkId: typeof caseData.assignedClerkId === "number" ? caseData.assignedClerkId : null,
        purchasers,
        borrowerMode: borrowers.length > 0 ? "separate" : "none",
        loanPartyType: "1st_party",
        borrowers,
        parcelNo: typeof caseData.parcelNo === "string" ? caseData.parcelNo : null,
        propertyAddress: typeof propertyData.propertyAddress === "string" ? propertyData.propertyAddress : null,
        propertyDetails: propertyData,
        loanDetails: financingData,
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
          preserveReferenceNo: true,
          approvalMode: "already_approved",
          suppressNewCaseNotifications: true,
        },
      };

      let createdCaseId: number | null = null;
      let importError: { code: string; message: string } | null = null;

      try {
        const txResult = await db.transaction(async (tx) => {
          const ctx: CanonicalCaseCreateContext = {
            db: tx as any,
            firmId,
            actorUserId,
            canAssignAny: true,
            source: "legacy_excel_import",
          };
          return await createCaseCanonical(ctx, createInput);
        });
        createdCaseId = txResult.case.id;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        importError = {
          code: err instanceof Error && (err as any).code ? String((err as any).code) : "IMPORT_ERROR",
          message: msg.length > 1000 ? msg.slice(0, 997) + "..." : msg,
        };
      }

      if (createdCaseId !== null) {
        created++;
        await dbConn
          .update(legacyCaseImportRowsTable)
          .set({
            rowStatus: "imported",
            createdCaseId,
            importedAt: new Date(),
          })
          .where(eq(legacyCaseImportRowsTable.id, rowId));

        await writeAudit(dbConn, {
          firmId,
          actorId: actorUserId,
          actorType: "firm_user",
          action: "cases.legacy_import.row_imported",
          entityType: "case",
          entityId: createdCaseId,
          detail: `batchId=${batchId} rowId=${rowId} sourceRowNo=${row.sourceRowNo} caseId=${createdCaseId}`,
        });
      } else if (importError) {
        failed++;
        await dbConn
          .update(legacyCaseImportRowsTable)
          .set({
            rowStatus: "failed",
            errorCode: importError.code,
            errorMessage: importError.message,
          })
          .where(eq(legacyCaseImportRowsTable.id, rowId));

        await writeAudit(dbConn, {
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
  }

  for (const row of hardDuplicateRows) {
    await writeAudit(dbConn, {
      firmId,
      actorId: actorUserId,
      actorType: "firm_user",
      action: "cases.legacy_import.row_skipped_duplicate",
      entityType: "legacy_case_import_row",
      entityId: row.id,
      detail: `batchId=${batchId} rowId=${row.id} duplicateType=${row.duplicateType ?? "unknown"} caseId=${row.duplicateCaseId ?? "null"}`,
    });
  }

  let status: RunImportSummary["status"];
  if (failed === 0 && requested > 0) {
    status = "completed";
  } else if (created > 0 && failed > 0) {
    status = "partial_failed";
  } else if (requested === 0) {
    status = "completed";
  } else {
    status = "failed";
  }

  const duplicatesSkipped = hardDuplicateRows.length;

  const summaryCounts = await dbConn
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

  let importedRows = 0;
  let failedRowsCount = 0;
  for (const sc of summaryCounts) {
    if (sc.rowStatus === "imported") importedRows = Number(sc.count);
    if (sc.rowStatus === "failed") failedRowsCount = Number(sc.count);
  }

  await dbConn
    .update(legacyCaseImportBatchesTable)
    .set({
      status,
      importedRows,
      failedRows: failedRowsCount,
      completedAt: new Date(),
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
    status,
    summary: {
      requested,
      created,
      alreadyImported,
      duplicatesSkipped,
      failed,
    },
  };
}

export async function retryFailedRows(
  dbConn: DbConnLike,
  batchId: number,
  firmId: number,
  actorUserId: number,
  opts: RetryOptions = {},
): Promise<RunImportSummary> {
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
