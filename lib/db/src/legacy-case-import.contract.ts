import { z } from "zod/v4";

export type CanonicalRowStatus =
  | "READY"
  | "WARNING"
  | "REVIEW_REQUIRED"
  | "HARD_DUPLICATE"
  | "INVALID"
  | "imported"
  | "failed"
  | "pending";

export type UiRowStatus =
  | "ready"
  | "warning"
  | "review"
  | "duplicate"
  | "invalid"
  | "imported"
  | "failed"
  | "pending";

export function mapLegacyRowStatus(status: string | null | undefined): UiRowStatus {
  switch (status) {
    case "READY":
      return "ready";
    case "WARNING":
      return "warning";
    case "REVIEW_REQUIRED":
      return "review";
    case "HARD_DUPLICATE":
      return "duplicate";
    case "INVALID":
      return "invalid";
    case "imported":
      return "imported";
    case "failed":
      return "failed";
    case "pending":
      return "pending";
    default:
      return "pending";
  }
}

export const ExcelColumnMappingSchema = z.object({
  excelHeader: z.string(),
  target: z.string(),
  arrayIndex: z.number().int().optional(),
});

export type ExcelColumnMapping = z.infer<typeof ExcelColumnMappingSchema>;

export const SolMappingSchema = z.record(z.string(), z.number().nullable());

export const FixedValuesSchema = z.object({
  projectId: z.number().nullish(),
  developerId: z.number().nullish(),
  caseType: z.enum(["developer_sales", "subsale", "perfection"]).optional(),
  preserveRef: z.boolean().optional(),
  solMapping: SolMappingSchema.optional(),
});

export type FixedValues = z.infer<typeof FixedValuesSchema>;

export const UploadResponseSchema = z.object({
  batchId: z.union([z.number(), z.string()]),
  fileName: z.string(),
  sheetNames: z.array(z.string()),
  suggestedSheet: z.string(),
  detectedFormat: z.string(),
  savedMappingAvailable: z.boolean(),
  totalRows: z.number(),
});

export type UploadResponse = z.infer<typeof UploadResponseSchema>;

export type FieldMappingGroup =
  | "Core Case"
  | "Purchaser"
  | "Borrower"
  | "Property"
  | "Financing"
  | "Existing Dates / Milestones"
  | "Other";

export type FieldCatalogEntry = {
  target: string;
  group: FieldMappingGroup;
  label: string;
  dataType:
    | "string"
    | "number"
    | "date"
    | "boolean"
    | "user"
    | "project"
    | "developer";
  arrayIndex?: number;
  description?: string;
  optional?: boolean;
};

export type MappingSource = "saved_template" | "auto_detected" | "manual";

export const MappingResponseSchema = z.object({
  batch: z.union([z.number(), z.string()]),
  savedMappingTemplateId: z.union([z.number(), z.string(), z.null()]).optional(),
  mappingSource: z.enum(["saved_template", "auto_detected", "manual"]).optional(),
  mappingSourceWarning: z.string().nullish(),
  columns: z.array(ExcelColumnMappingSchema),
  fixedValues: FixedValuesSchema,
  headerFingerprint: z.string().nullish(),
  sourceSheetName: z.string().nullish(),
  catalog: z.array(z.custom<FieldCatalogEntry>((v) => true)),
});

export type MappingResponse = z.infer<typeof MappingResponseSchema>;

export type ValidationIssue = {
  code: string;
  field?: string | null;
  message: string;
};

export const PreviewRowSchema = z.object({
  id: z.union([z.number(), z.string()]),
  sourceRowNo: z.number(),
  sourceReference: z.string().nullish(),
  purchaserSummary: z.string().nullish(),
  borrowerSummary: z.string().nullish(),
  propertySummary: z.string().nullish(),
  rowStatus: z.string(),
  warnings: z.array(z.custom<ValidationIssue>((v) => true)).optional(),
  errors: z.array(z.custom<ValidationIssue>((v) => true)).optional(),
  duplicateType: z.string().nullish(),
  duplicateCaseId: z.union([z.number(), z.string()]).nullish(),
  duplicateScore: z.union([z.number(), z.string()]).nullish(),
  createdCaseId: z.union([z.number(), z.string()]).nullish(),
});

export type PreviewRow = z.infer<typeof PreviewRowSchema>;

export const PreviewRowsResponseSchema = z.object({
  batchId: z.union([z.number(), z.string()]),
  limit: z.number(),
  offset: z.number(),
  rows: z.array(PreviewRowSchema),
  total: z.number().optional(),
});

export type PreviewRowsResponse = z.infer<typeof PreviewRowsResponseSchema>;

export const DryRunSummarySchema = z.object({
  total: z.number(),
  ready: z.number(),
  warnings: z.number(),
  reviewRequired: z.number(),
  hardDuplicates: z.number(),
  invalid: z.number(),
});

export const DryRunResponseSchema = z.object({
  batchId: z.union([z.number(), z.string()]),
  summary: DryRunSummarySchema,
});

export type DryRunResponse = z.infer<typeof DryRunResponseSchema>;

export const BatchSummarySchema = z.object({
  total: z.number(),
  imported: z.number(),
  failed: z.number(),
  duplicates: z.number(),
  reviewRequired: z.number(),
  remaining: z.number(),
});

export const BatchStatusResponseSchema = z.object({
  batchId: z.union([z.number(), z.string()]),
  status: z.string(),
  summary: BatchSummarySchema,
});

export type BatchStatusResponse = z.infer<typeof BatchStatusResponseSchema>;

export type ReviewOverride = {
  duplicateAction: "import_anyway" | "skip";
};

export const ImportBodySchema = z.object({
  rowIds: z.array(z.union([z.number(), z.string()])).optional(),
  includeWarnings: z.boolean().optional().default(true),
  reviewOverrides: z.record(z.string(), z.object({
    duplicateAction: z.enum(["import_anyway", "skip"]),
  })).optional(),
});

export type ImportBody = z.infer<typeof ImportBodySchema>;

export const ImportResponseSchema = z.object({
  batchId: z.union([z.number(), z.string()]),
  status: z.enum(["completed", "partial_failed", "failed", "importing"]),
  summary: z.object({
    requested: z.number(),
    created: z.number(),
    alreadyImported: z.number(),
    duplicatesSkipped: z.number(),
    failed: z.number(),
  }),
});

export type ImportResponse = z.infer<typeof ImportResponseSchema>;

export const RecentImportSchema = z.object({
  batchId: z.union([z.number(), z.string()]),
  fileName: z.string(),
  importedAt: z.string().nullish(),
  importedBy: z.string().nullish(),
  created: z.number(),
  failed: z.number(),
  status: z.string(),
});

export type RecentImport = z.infer<typeof RecentImportSchema>;

export type CaseTypeApiValue = "developer_sales" | "subsale" | "perfection";

export const CASE_TYPE_LABELS: Record<CaseTypeApiValue, string> = {
  developer_sales: "Developer Sales",
  subsale: "Subsale",
  perfection: "Perfection",
};
