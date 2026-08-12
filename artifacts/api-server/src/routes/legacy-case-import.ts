import express, { type Router as ExpressRouter, type RequestHandler } from "express";
import multer from "multer";
import { requireAuth, requireFirmUser, requirePermission, writeAuditLog, type AuthRequest } from "../lib/auth.js";
import { db, legacyCaseImportBatchesTable, legacyCaseImportRowsTable, legacyCaseImportMappingTemplatesTable, projectsTable, developersTable, usersTable } from "@workspace/db";
import { eq, and, inArray, or, desc, asc } from "drizzle-orm";
import { z } from "zod";
import { parseExcelWorkbook, computeHeaderFingerprint, normalizeHeader, LEGACY_IMPORT_LIMITS } from "../modules/cases/legacy-import/excel-parser.js";
import { M_LEGASI_PRESET_MAPPING, LEGACY_FIELD_CATALOG, type FieldMappingGroup } from "../modules/cases/legacy-import/legacy-case-field-catalog.js";
import { autoMapHeaders, applyRowMapping, type ExcelColumnMapping, type MappingTemplateDefinition } from "../modules/cases/legacy-import/mapping-engine.js";
import { buildIdempotencyKey } from "../modules/cases/legacy-import/legacy-case-duplicate-detector.js";
import { runDryRun, runImport, retryFailedRows, validateFixedValues } from "../modules/cases/legacy-import/legacy-batch-pipeline.service.js";
import { writeLegacyErrorReportXlsxBuffer } from "../modules/cases/legacy-import/legacy-error-report.js";
import crypto from "node:crypto";

const requireAuthHandler = requireAuth as RequestHandler;
const requireFirmUserHandler = requireFirmUser as RequestHandler;

const one = (v: unknown): string | undefined =>
  Array.isArray(v) ? v[0] : typeof v === "string" ? v : undefined;

const oneNum = (v: string | string[] | undefined): number | undefined => {
  const s = one(v);
  if (!s) return undefined;
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  return undefined;
};

function sha256Hex(buf: Buffer | string): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

const routerInternal = express.Router();
type RouterLike = { use: (...a: unknown[]) => RouterLike };
const ri = routerInternal as unknown as RouterLike;

ri.use(requireAuthHandler);
ri.use(requireFirmUserHandler);
ri.use(requirePermission("cases", "create") as RequestHandler);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LEGACY_IMPORT_LIMITS.MAX_FILE_BYTES },
});

type AuthedHandler = (
  req: AuthRequest,
  res: any,
  next: any
) => void | Promise<void>;

const authed = (handler: AuthedHandler): RequestHandler => {
  return (req, res, next) => {
    Promise.resolve(handler(req as AuthRequest, res as any, next)).catch(next);
  };
};

async function getBatchOr404(
  firmId: number,
  batchId: number
): Promise<typeof legacyCaseImportBatchesTable.$inferSelect | null> {
  const [batch] = await db
    .select()
    .from(legacyCaseImportBatchesTable)
    .where(
      and(
        eq(legacyCaseImportBatchesTable.id, batchId),
        eq(legacyCaseImportBatchesTable.firmId, firmId)
      )
    )
    .limit(1);
  return batch ?? null;
}

routerInternal.post(
  "/upload",
  (req: any, res: any, next: any) => {
    upload.single("file")(req, res, (err: any) => {
      if (err) {
        return res.status(400).json({
          error: {
            code: "UPLOAD_ERROR",
            message: err?.message || "File upload failed",
          },
        });
      }
      next();
    });
  },
  authed(async (req, res) => {
    const firmId = req.firmId!;
    const actor = req.userId!;

    if (!req.file) {
      return res.status(400).json({
        error: { code: "NO_FILE", message: "No file uploaded" },
      });
    }

    const buffer: Buffer = req.file.buffer;
    const originalName: string = req.file.originalname;

    const parsed = await parseExcelWorkbook(buffer, originalName);
    if (!parsed.ok) {
      const error = parsed as unknown as { ok: false; error: { code: string; message?: string; detail?: unknown } };
      return res.status(400).json({ error: error.error });
    }
    const parseOk = parsed as unknown as { ok: true; data: { sheetNames: string[]; sheets: Record<string, { headers: unknown[]; rows: Record<string, unknown>[] }> } };

    const sheetNames = parseOk.data.sheetNames;
    const nonEmptySheets = sheetNames.filter(
      (n) => parseOk.data.sheets[n]?.headers?.length > 0
    );
    const suggestedSheet = nonEmptySheets.includes("Sheet1")
      ? "Sheet1"
      : nonEmptySheets[0] ?? sheetNames[0] ?? "Sheet1";

    const firstSheet = parseOk.data.sheets[suggestedSheet];
    const headers = firstSheet?.headers ?? [];
    const headerFingerprint = computeHeaderFingerprint(headers as string[]);

    const presetKeysNormalized = Object.keys(M_LEGASI_PRESET_MAPPING).map(
      (k) => normalizeHeader(k)
    );
    const headerSet = new Set(headers.map((h) => normalizeHeader(h)));
    const hasOurRef = headerSet.has(normalizeHeader("our ref"));
    const hasPurchaser1 = headerSet.has(normalizeHeader("purchaser 1"));
    const detectedFormat =
      hasOurRef && hasPurchaser1 ? "M LEGASI Master Data" : "Custom";

    const [defaultTemplate] = await db
      .select({ id: legacyCaseImportMappingTemplatesTable.id })
      .from(legacyCaseImportMappingTemplatesTable)
      .where(
        and(
          eq(legacyCaseImportMappingTemplatesTable.firmId, firmId),
          eq(legacyCaseImportMappingTemplatesTable.isDefault, true),
          eq(legacyCaseImportMappingTemplatesTable.headerFingerprint, headerFingerprint)
        )
      )
      .limit(1);
    const savedMappingAvailable = Boolean(defaultTemplate);

    const optionsJson: Record<string, unknown> = {
      sheetNames,
      suggestedSheet,
      detectedFormat,
      savedMappingAvailable,
    };

    const rows = firstSheet?.rows ?? [];
    const totalRows = rows.length;

    const [insertedBatch] = await (db as any)
      .insert(legacyCaseImportBatchesTable)
      .values({
        firmId,
        createdBy: actor,
        sourceFileName: originalName,
        sourceFileHash: sha256Hex(buffer),
        sourceSheetName: suggestedSheet,
        sourceFormat: detectedFormat,
        headerFingerprint,
        status: "uploaded",
        optionsJson,
        totalRows,
      })
      .returning();

    const batchId = insertedBatch.id;

    await (db as any).transaction(async (tx: any) => {
      const inserts: Array<typeof legacyCaseImportRowsTable.$inferInsert> = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const sourceRowNo = i + 1;
        const sourceRowHash = sha256Hex(JSON.stringify(row));
        const idempotencyKey = buildIdempotencyKey(
          firmId,
          batchId,
          sourceRowNo,
          sourceRowHash
        );
        const sourceReference =
          (row as Record<string, unknown>)[normalizeHeader("Our Ref")] !== undefined
            ? String((row as Record<string, unknown>)[normalizeHeader("Our Ref")])
            : null;

        inserts.push({
          firmId,
          batchId,
          sourceRowNo,
          sourceRowHash,
          sourceReference,
          rawRowJson: row as any,
          idempotencyKey,
          rowStatus: "pending",
        });
      }

      if (inserts.length > 0) {
          for (let i = 0; i < inserts.length; i += 200) {
            await tx.insert(legacyCaseImportRowsTable).values(inserts.slice(i, i + 200));
          }
      }
    });

    await writeAuditLog(
      {
        firmId,
        actorId: actor,
        actorType: req.userType ?? "firm_user",
        action: "cases.legacy_import.batch_created",
        entityType: "legacy_case_import_batch",
        entityId: batchId,
        detail: `batchId=${batchId} fileName=${originalName}`,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      },
      { db: db as any }
    );

    res.status(201).json({
      batchId,
      fileName: originalName,
      sheetNames,
      suggestedSheet,
      detectedFormat,
      savedMappingAvailable,
    });
  })
);

routerInternal.get(
  "/:batchId",
  authed(async (req, res) => {
    const firmId = req.firmId!;
    const batchId = oneNum(req.params.batchId);
    if (!batchId) return res.status(400).json({ error: "Invalid batchId" });

    const batch = await getBatchOr404(firmId, batchId);
    if (!batch) return res.status(404).json({ error: "Batch not found" });

    const statusCounts: Array<{ rowStatus: string | null; count: string | number }> =
      await db
        .select({
          rowStatus: legacyCaseImportRowsTable.rowStatus,
          count: db.$count(legacyCaseImportRowsTable.id),
        })
        .from(legacyCaseImportRowsTable)
        .where(
          and(
            eq(legacyCaseImportRowsTable.batchId, batchId),
            eq(legacyCaseImportRowsTable.firmId, firmId)
          )
        )
        .groupBy(legacyCaseImportRowsTable.rowStatus);

    const summary: Record<string, number> = {};
    for (const s of statusCounts) {
      summary[String(s.rowStatus ?? "null")] = Number(s.count);
    }

    res.json({
      ...batch,
      rowsByStatus: summary,
    });
  })
);

routerInternal.get(
  "/:batchId/rows",
  authed(async (req, res) => {
    const firmId = req.firmId!;
    const batchId = oneNum(req.params.batchId);
    if (!batchId) return res.status(400).json({ error: "Invalid batchId" });

    const batch = await getBatchOr404(firmId, batchId);
    if (!batch) return res.status(404).json({ error: "Batch not found" });

    const limit = Math.min(oneNum(req.query.limit as any) ?? 100, 500);
    const offset = oneNum(req.query.offset as any) ?? 0;

    const rows = await db
      .select()
      .from(legacyCaseImportRowsTable)
      .where(
        and(
          eq(legacyCaseImportRowsTable.batchId, batchId),
          eq(legacyCaseImportRowsTable.firmId, firmId)
        )
      )
      .orderBy(legacyCaseImportRowsTable.sourceRowNo)
      .limit(limit)
      .offset(offset);

    const previewRows = rows.map((r) => ({
      id: r.id,
      sourceRowNo: r.sourceRowNo,
      sourceReference: r.sourceReference,
      rowStatus: r.rowStatus,
      createdCaseId: r.createdCaseId,
      duplicateType: r.duplicateType,
      duplicateCaseId: r.duplicateCaseId,
      duplicateScore: r.duplicateScore,
      possibleDuplicate: Boolean(r.duplicateType),
      errorCode: r.errorCode,
      errorMessage: r.errorMessage,
      rawRowJson: r.rawRowJson,
      validationJson: r.validationJson,
    }));

    res.json({
      batchId,
      limit,
      offset,
      rows: previewRows,
    });
  })
);

routerInternal.get(
  "/:batchId/mapping",
  authed(async (req, res) => {
    const firmId = req.firmId!;
    const batchId = oneNum(req.params.batchId);
    if (!batchId) return res.status(400).json({ error: "Invalid batchId" });

    const batch = await getBatchOr404(firmId, batchId);
    if (!batch) return res.status(404).json({ error: "Batch not found" });

    const optionsJson = (batch.optionsJson as Record<string, unknown>) ?? {};
    const savedColumns = (optionsJson.columns as ExcelColumnMapping[]) ?? null;

    let columns: ExcelColumnMapping[];
    if (savedColumns && Array.isArray(savedColumns) && savedColumns.length > 0) {
      columns = savedColumns;
    } else {
      const firstRow = (await db
        .select({ rawRowJson: legacyCaseImportRowsTable.rawRowJson })
        .from(legacyCaseImportRowsTable)
        .where(
          and(
            eq(legacyCaseImportRowsTable.batchId, batchId),
            eq(legacyCaseImportRowsTable.firmId, firmId)
          )
        )
        .orderBy(legacyCaseImportRowsTable.sourceRowNo)
        .limit(1))[0];

      const headerKeys = firstRow?.rawRowJson
        ? Object.keys(firstRow.rawRowJson as Record<string, unknown>)
        : [];
      const autoMapped = autoMapHeaders(headerKeys, M_LEGASI_PRESET_MAPPING);
      columns = autoMapped.columns;
    }

    const fixedValues = (optionsJson.fixedValues as Record<string, unknown>) ?? {
      projectId: null,
      developerId: null,
      caseType: "developer_sales",
      borrowerModeSuggested: null,
      solMapping: {},
    };

    res.json({
      batch: batch.id,
      savedMappingTemplateId: batch.mappingTemplateId ?? null,
      fixedValues,
      columns,
      headerFingerprint: batch.headerFingerprint,
      sourceSheetName: batch.sourceSheetName,
      catalog: LEGACY_FIELD_CATALOG,
    });
  })
);

const PatchMappingBody = z.object({
  columns: z.array(
    z.object({
      excelHeader: z.string(),
      target: z.string(),
      arrayIndex: z.number().int().optional(),
    })
  ),
  fixedValues: z.object({
    projectId: z.number().nullish(),
    developerId: z.number().nullish(),
    caseType: z
      .enum(["developer_sales", "subsale", "perfection"])
      .optional(),
    solMapping: z.record(z.string(), z.number().nullable()),
  }),
  mappingTemplateId: z.number().nullish().optional(),
});

routerInternal.patch(
  "/:batchId/mapping",
  authed(async (req, res) => {
    const firmId = req.firmId!;
    const batchId = oneNum(req.params.batchId);
    if (!batchId) return res.status(400).json({ error: "Invalid batchId" });

    const batch = await getBatchOr404(firmId, batchId);
    if (!batch) return res.status(404).json({ error: "Batch not found" });

    const parsed = PatchMappingBody.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Invalid body", issues: parsed.error.issues });
    }

    const { columns, fixedValues, mappingTemplateId } = parsed.data;

    const validation = await validateFixedValues(db as any, firmId, fixedValues);
    if (!validation.ok) {
      const fail = validation as { ok: false; code: string; message: string };
      return res.status(400).json({
        error: "Fixed values invalid",
        code: fail.code,
        message: fail.message,
      });
    }

    const existingOptions = (batch.optionsJson as Record<string, unknown>) ?? {};
    const updatedOptions: Record<string, unknown> = {
      ...existingOptions,
      columns,
      fixedValues,
    };

    const updatePayload: Partial<typeof legacyCaseImportBatchesTable.$inferInsert> = {
      optionsJson: updatedOptions,
    };
    if (mappingTemplateId !== undefined) {
      updatePayload.mappingTemplateId = mappingTemplateId ?? null;
    }

    const [updated] = await db
      .update(legacyCaseImportBatchesTable)
      .set(updatePayload)
      .where(
        and(
          eq(legacyCaseImportBatchesTable.id, batchId),
          eq(legacyCaseImportBatchesTable.firmId, firmId)
        )
      )
      .returning();

    res.json(updated);
  })
);

routerInternal.post(
  "/:batchId/dry-run",
  authed(async (req, res) => {
    const firmId = req.firmId!;
    const actor = req.userId!;
    const batchId = oneNum(req.params.batchId);
    if (!batchId) return res.status(400).json({ error: "Invalid batchId" });

    const batch = await getBatchOr404(firmId, batchId);
    if (!batch) return res.status(404).json({ error: "Batch not found" });

    const optionsJson = (batch.optionsJson as Record<string, unknown>) ?? {};
    const columns = optionsJson.columns as ExcelColumnMapping[] | undefined;
    if (!columns || columns.length === 0) {
      return res.status(400).json({
        error: "No mapping columns configured. Set mapping first.",
        code: "MAPPING_REQUIRED",
      });
    }

    const result = await runDryRun(db, batchId, firmId, actor);

    await writeAuditLog(
      {
        firmId,
        actorId: actor,
        actorType: req.userType ?? "firm_user",
        action: "cases.legacy_import.dry_run",
        entityType: "legacy_case_import_batch",
        entityId: batchId,
        detail: `batchId=${batchId}`,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      },
      { db: db as any }
    );

    res.json({
      batchId,
      summary: result.summary,
    });
  })
);

const ImportBody = z.object({
  rowIds: z.array(z.number().int()).optional(),
  includeWarnings: z.boolean().optional().default(true),
  reviewOverrides: z
    .record(
      z.string(),
      z.object({
        duplicateAction: z.enum(["import_anyway", "skip"]),
      })
    )
    .optional(),
});

type ImportReviewOverrides = Record<string, { duplicateAction: "import_anyway" | "skip" }>;

function reviewOverridesToNumberKeys(
  r: ImportReviewOverrides | undefined
): Record<number, { duplicateAction: "import_anyway" | "skip" }> {
  const out: Record<number, { duplicateAction: "import_anyway" | "skip" }> = {};
  if (!r) return out;
  for (const [k, v] of Object.entries(r)) {
    const num = Number(k);
    if (Number.isFinite(num)) out[num] = { duplicateAction: v.duplicateAction };
  }
  return out;
}

routerInternal.post(
  "/:batchId/import",
  authed(async (req, res) => {
    const firmId = req.firmId!;
    const actor = req.userId!;
    const batchId = oneNum(req.params.batchId);
    if (!batchId) return res.status(400).json({ error: "Invalid batchId" });

    const batch = await getBatchOr404(firmId, batchId);
    if (!batch) return res.status(404).json({ error: "Batch not found" });

    const parsed = ImportBody.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Invalid body", issues: parsed.error.issues });
    }

    await db
      .update(legacyCaseImportBatchesTable)
      .set({ status: "importing" })
      .where(
        and(
          eq(legacyCaseImportBatchesTable.id, batchId),
          eq(legacyCaseImportBatchesTable.firmId, firmId)
        )
      );

    const importOpts = {
      rowIds: parsed.data.rowIds,
      includeWarnings: parsed.data.includeWarnings,
      reviewOverrides: reviewOverridesToNumberKeys(
        parsed.data.reviewOverrides as ImportReviewOverrides
      ),
    };
    const result = await runImport(db as any, batchId, firmId, actor, importOpts);

    const [currentBatch] = await db
      .select({ status: legacyCaseImportBatchesTable.status })
      .from(legacyCaseImportBatchesTable)
      .where(
        and(
          eq(legacyCaseImportBatchesTable.id, batchId),
          eq(legacyCaseImportBatchesTable.firmId, firmId)
        )
      )
      .limit(1);

    const summaryImported = result.summary.created;
    const summaryFailed = result.summary.failed;
    const summarySkipped = result.summary.duplicatesSkipped;
    const summaryRequested = result.summary.requested;

    if (currentBatch && currentBatch.status !== "failed") {
      await writeAuditLog(
        {
          firmId,
          actorId: actor,
          actorType: req.userType ?? "firm_user",
          action: "cases.legacy_import.completed",
          entityType: "legacy_case_import_batch",
          entityId: batchId,
          detail: `batchId=${batchId} imported=${summaryImported} requested=${summaryRequested}`,
          ipAddress: req.ip,
          userAgent: req.headers["user-agent"],
        },
        { db: db as any }
      );

      if (summaryImported + summaryFailed + summarySkipped >= (batch.totalRows ?? 0)) {
        await db
          .update(legacyCaseImportBatchesTable)
          .set({ completedAt: new Date() })
          .where(
            and(
              eq(legacyCaseImportBatchesTable.id, batchId),
              eq(legacyCaseImportBatchesTable.firmId, firmId)
            )
          );
      }
    }

    res.json(result);
  })
);

routerInternal.post(
  "/:batchId/retry-failed",
  authed(async (req, res) => {
    const firmId = req.firmId!;
    const actor = req.userId!;
    const batchId = oneNum(req.params.batchId);
    if (!batchId) return res.status(400).json({ error: "Invalid batchId" });

    const batch = await getBatchOr404(firmId, batchId);
    if (!batch) return res.status(404).json({ error: "Batch not found" });

    const result = await retryFailedRows(db as any, batchId, firmId, actor);

    await writeAuditLog(
      {
        firmId,
        actorId: actor,
        actorType: req.userType ?? "firm_user",
        action: "cases.legacy_import.retry_failed",
        entityType: "legacy_case_import_batch",
        entityId: batchId,
        detail: `batchId=${batchId}`,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      },
      { db: db as any }
    );

    res.json(result);
  })
);

routerInternal.get(
  "/:batchId/error-report",
  authed(async (req, res) => {
    const firmId = req.firmId!;
    const batchId = oneNum(req.params.batchId);
    if (!batchId) return res.status(400).json({ error: "Invalid batchId" });

    const batch = await getBatchOr404(firmId, batchId);
    if (!batch) return res.status(404).json({ error: "Batch not found" });

    const rows = await db
      .select()
      .from(legacyCaseImportRowsTable)
      .where(
        and(
          eq(legacyCaseImportRowsTable.batchId, batchId),
          eq(legacyCaseImportRowsTable.firmId, firmId),
          or(
            eq(legacyCaseImportRowsTable.rowStatus, "failed"),
            eq(legacyCaseImportRowsTable.rowStatus, "WARNING"),
            eq(legacyCaseImportRowsTable.rowStatus, "REVIEW_REQUIRED"),
            eq(legacyCaseImportRowsTable.rowStatus, "HARD_DUPLICATE")
          )
        )
      )
      .orderBy(legacyCaseImportRowsTable.sourceRowNo);

    const rawRows = rows.map((r) => (r.rawRowJson ?? {}) as Record<string, unknown>);

    const reportRows = rows.map((r, idx) => {
      const validation = (r.validationJson ?? {}) as Record<string, unknown>;
      const warnings = Array.isArray(validation.warnings)
        ? (validation.warnings as Array<{ code: string; field?: string; message: string }>)
        : [];
      const purchaserSummary = (() => {
        const raw = rawRows[idx] ?? {};
        const parts: string[] = [];
        for (let i = 1; i <= 4; i++) {
          const pName =
            raw[normalizeHeader(`Purchaser ${i}`)] ??
            raw[normalizeHeader(`Purchaser${i}`)];
          if (pName) parts.push(String(pName));
        }
        return parts.join(", ");
      })();
      const parcelNo =
        (rawRows[idx]?.[normalizeHeader("Parcel No")] as string | null) ?? null;

      return {
        sourceRowNo: r.sourceRowNo,
        sourceReference: r.sourceReference,
        purchaserSummary,
        parcelNo,
        result: r.rowStatus ?? "PENDING",
        errorCode: r.errorCode,
        errorMessage: r.errorMessage,
        warnings,
        rawRow: rawRows[idx],
      };
    });

    const buffer = writeLegacyErrorReportXlsxBuffer(reportRows);

    const now = new Date();
    const yyyymmdd =
      now.getFullYear().toString() +
      String(now.getMonth() + 1).padStart(2, "0") +
      String(now.getDate()).padStart(2, "0");
    const filename = `legacy-import-report-${batchId}-${yyyymmdd}.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`
    );
    res.send(buffer);
  })
);

routerInternal.get(
  "/mapping-templates",
  authed(async (req, res) => {
    const firmId = req.firmId!;

    const templates = await db
      .select()
      .from(legacyCaseImportMappingTemplatesTable)
      .where(eq(legacyCaseImportMappingTemplatesTable.firmId, firmId))
      .orderBy(
        desc(legacyCaseImportMappingTemplatesTable.isDefault),
        asc(legacyCaseImportMappingTemplatesTable.name)
      );

    res.json(templates);
  })
);

const SaveTemplateBody = z.object({
  name: z.string().trim().min(1).max(200),
  isDefault: z.boolean().optional().default(false),
});

routerInternal.post(
  "/:batchId/save-mapping-template",
  authed(async (req, res) => {
    const firmId = req.firmId!;
    const actor = req.userId!;
    const batchId = oneNum(req.params.batchId);
    if (!batchId) return res.status(400).json({ error: "Invalid batchId" });

    const batch = await getBatchOr404(firmId, batchId);
    if (!batch) return res.status(404).json({ error: "Batch not found" });

    const parsed = SaveTemplateBody.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Invalid body", issues: parsed.error.issues });
    }

    const { name, isDefault } = parsed.data;

    const optionsJson = (batch.optionsJson as Record<string, unknown>) ?? {};
    const columns = (optionsJson.columns as ExcelColumnMapping[]) ?? [];
    const fixedValuesRaw = (optionsJson.fixedValues as Record<string, unknown>) ?? {};

    const solMappingRaw = (fixedValuesRaw.solMapping ?? {}) as Record<string, number | null>;
    const cleanSolMapping: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(solMappingRaw)) {
      if (k === "userId") continue;
      cleanSolMapping[k] = v;
    }
    const cleanFixedValues: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fixedValuesRaw)) {
      if (k === "solMapping") {
        cleanFixedValues.solMapping = cleanSolMapping;
      } else {
        cleanFixedValues[k] = v;
      }
    }

    const mappingJson: MappingTemplateDefinition = {
      columns,
      fixedValues: cleanFixedValues,
    };

    if (isDefault) {
      await db
        .update(legacyCaseImportMappingTemplatesTable)
        .set({ isDefault: false })
        .where(
          and(
            eq(legacyCaseImportMappingTemplatesTable.firmId, firmId),
            eq(legacyCaseImportMappingTemplatesTable.name, name)
          )
        );
    }

    const [created] = await db
      .insert(legacyCaseImportMappingTemplatesTable)
      .values({
        firmId,
        name,
        headerFingerprint: batch.headerFingerprint,
        sourceSheetName: batch.sourceSheetName,
        mappingJson: mappingJson as any,
        fixedValuesJson: cleanFixedValues as any,
        isDefault,
        createdBy: actor,
      })
      .onConflictDoUpdate({
        target: [
          legacyCaseImportMappingTemplatesTable.firmId,
          legacyCaseImportMappingTemplatesTable.name,
        ],
        set: {
          headerFingerprint: batch.headerFingerprint,
          sourceSheetName: batch.sourceSheetName,
          mappingJson: mappingJson as any,
          fixedValuesJson: cleanFixedValues as any,
          isDefault,
          updatedAt: new Date(),
        },
      })
      .returning();

    res.status(201).json(created);
  })
);

const exported = routerInternal as unknown as ExpressRouter;
export default exported;
export { exported as router };
