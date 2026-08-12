process.env.NODE_ENV = "test";
process.env.VITEST_SKIP_DB = "1";

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import * as XLSX from "xlsx";

const {
  TEST_FIRM_ID,
  TEST_USER_ID,
  TEST_USER_TYPE,
  TEST_BATCH_ID,
  TEST_BATCH_ID_OTHER_FIRM,
  argsCapture,
  makeFluent,
  currentReqState,
  BATCH_OWNERSHIP,
} = vi.hoisted(() => {
  type FakeFluent = {
    where: (cond?: unknown) => any;
    limit: (n: number) => any;
    orderBy: (...args: unknown[]) => any;
    offset: (n: number) => any;
    groupBy: (...args: unknown[]) => any;
    returning: () => Promise<unknown[]>;
    onConflictDoUpdate: (opts: unknown) => any;
    set: (values: unknown) => any;
    values: (vals: unknown) => any;
    from: (table: unknown) => any;
  };

  const makeFluentImpl = (rowsFactory: () => unknown[] = () => []): FakeFluent => {
    const self: Partial<FakeFluent> = {};
    const makePromise = (v: unknown[]) => {
      const p = Promise.resolve(v) as any;
      Object.assign(p, self);
      return p;
    };
    self.where = () => makePromise(rowsFactory());
    self.limit = () => makePromise(rowsFactory());
    self.orderBy = () => makePromise(rowsFactory());
    self.offset = () => makePromise(rowsFactory());
    self.groupBy = () => makePromise(rowsFactory());
    self.returning = () => makePromise(rowsFactory());
    self.from = () => makePromise(rowsFactory());
    self.set = () => makePromise(rowsFactory());
    self.onConflictDoUpdate = () => makePromise(rowsFactory());
    self.values = () => makePromise(rowsFactory());
    return self as FakeFluent;
  };

  const T_FIRM = 1;
  const T_USER = 1;
  const T_BATCH = 42;
  const T_BATCH_OTHER = 99;
  const OWNERSHIP: Map<number, number> = new Map();
  OWNERSHIP.set(T_BATCH, T_FIRM);
  OWNERSHIP.set(T_BATCH_OTHER, T_FIRM + 1);

  return {
    TEST_FIRM_ID: T_FIRM,
    TEST_USER_ID: T_USER,
    TEST_USER_TYPE: "firm_user",
    TEST_BATCH_ID: T_BATCH,
    TEST_BATCH_ID_OTHER_FIRM: T_BATCH_OTHER,
    argsCapture: {
      currentRunImportOptions: null as any,
      partialFailedMode: false as boolean,
    },
    makeFluent: makeFluentImpl,
    currentReqState: {
      firmId: T_FIRM,
      batchId: T_BATCH,
    },
    BATCH_OWNERSHIP: OWNERSHIP,
  };
});

vi.mock("../lib/auth.js", () => {
  let authFirmId = TEST_FIRM_ID;
  let authUserId = TEST_USER_ID;
  let authUserType = TEST_USER_TYPE;

  const passthrough = async (req: any, _res: any, next: any) => {
    req.userType = authUserType;
    req.userId = authUserId;
    req.firmId = authFirmId;
    req.roleId = null;
    currentReqState.firmId = authFirmId;
    try {
      const firstSeg = (req.path || "").split("/").filter(Boolean)[0];
      if (firstSeg && /^\d+$/.test(firstSeg)) {
        currentReqState.batchId = Number(firstSeg);
      }
    } catch {
      // ignore
    }
    try {
      req.headers = req.headers ?? {};
      req.headers["user-agent"] = req.headers["user-agent"] ?? "vitest/1.0";
      Object.defineProperty(req, "ip", {
        configurable: true,
        get: () => "127.0.0.1",
      });
    } catch {
      // ignore in some test transports
    }
    next();
  };

  return {
    requireAuth: passthrough,
    requireFirmUser: passthrough,
    requirePermission: () => async (_req: any, _res: any, next: any) => next(),
    requireReAuth: async (_req: any, _res: any, next: any) => next(),
    writeAuditLog: async () => undefined,
    __setAuthContext: (firmId: number, userId: number, userType: string) => {
      authFirmId = firmId;
      authUserId = userId;
      authUserType = userType;
    },
  };
});

vi.mock("../modules/platform/firm-feature-service.js", async () => {
  const actual = await import("../modules/platform/firm-feature-service.js");
  let featureDisabled = false;

  const assertFirmFeatureEnabled = async (..._args: unknown[]): Promise<void> => {
    if (featureDisabled) {
      const { ApiError } = await import("../lib/api-response.js");
      throw new ApiError({
        status: 403,
        code: "FEATURE_DISABLED",
        message: "Feature disabled for this firm",
        retryable: false,
      });
    }
  };

  return {
    ...actual,
    assertFirmFeatureEnabled,
    __setFeatureDisabled: (disabled: boolean) => {
      featureDisabled = disabled;
    },
  };
});

vi.mock("@workspace/db", async (orig) => {
  const actual = await orig<typeof import("@workspace/db")>();

  const fakeSql = (strings: TemplateStringsArray, ...vals: unknown[]) => ({
    getSQL: () => strings.join("?"),
    params: vals,
  });

  type FakeFluent2 = ReturnType<typeof makeFluent>;

  const makeDb = (overrides: Partial<Record<string, unknown>> = {}) => {
    const db: any = {
      execute: async () => [],
      $count: (_field: unknown) => ({ __count: true }),
      desc: () => ({}),
      asc: () => ({}),
      or: (..._a: unknown[]) => ({}),
      and: (..._a: unknown[]) => ({}),
      eq: (..._a: unknown[]) => ({}),
      inArray: (..._a: unknown[]) => ({}),
      select: (selectShape?: unknown) => {
        const isCountSelect =
          selectShape &&
          typeof selectShape === "object" &&
          selectShape !== null &&
          "count" in (selectShape as Record<string, unknown>);

        return {
          from: (fromTable: any) => {
            let rawStr = "";
            try {
              rawStr = typeof fromTable === "string" ? fromTable : JSON.stringify({
                k: Object.keys(fromTable ?? {}),
                dbName: typeof fromTable?.dbName === "string" ? fromTable.dbName : "",
                n: typeof fromTable?.name === "string" ? fromTable.name : "",
                tn: typeof fromTable?.tableName === "string" ? fromTable.tableName : "",
              });
            } catch {
              rawStr = "";
            }
            const dbName: unknown = fromTable?.dbName;
            const asStr = typeof dbName === "string" ? dbName : rawStr;
            const keysOf = typeof fromTable === "object" && fromTable !== null ? Object.keys(fromTable) : [];
            const has = (k: string) => keysOf.includes(k);
            const isBatches =
              asStr.includes("legacy_case_import_batches") ||
              rawStr.includes("legacy_case_import_batches") ||
              (has("firmId") && has("sourceFileName") && has("sourceFileHash"));
            const isRows =
              asStr.includes("legacy_case_import_rows") ||
              rawStr.includes("legacy_case_import_rows") ||
              (has("batchId") && has("rowStatus") && has("sourceRowNo"));
            const isTemplates =
              asStr.includes("legacy_case_import_mapping_templates") ||
              rawStr.includes("legacy_case_import_mapping_templates") ||
              (has("firmId") && has("mappingJson") && has("headerFingerprint"));

            let tableName: string;
            if (isBatches) tableName = "legacy_case_import_batches";
            else if (isRows) tableName = "legacy_case_import_rows";
            else if (isTemplates) tableName = "legacy_case_import_mapping_templates";
            else if (asStr.includes("projects") || rawStr.includes("projects") || (has("firmId") && has("name") && has("developerId"))) tableName = "projects";
            else if (asStr.includes("developers") || rawStr.includes("developers") || (has("firmId") && has("name") && has("registrationNo"))) tableName = "developers";
            else if (asStr.includes("users") || rawStr.includes("users") || (has("email") && has("firmId"))) tableName = "users";
            else if (asStr.includes("audit_logs") || rawStr.includes("audit_logs") || (has("actorUserId") && has("actionType"))) tableName = "audit_logs";
            else tableName = typeof dbName === "string" ? dbName : (typeof fromTable === "string" ? fromTable : "unknown_table");

            if (isBatches) {
              const self: any = {};
              const makeBatch = (qid: number) => ({
                id: qid,
                firmId: currentReqState.firmId,
                createdBy: TEST_USER_ID,
                sourceFileName: "test-import.xlsx",
                sourceFileHash: "abc123",
                sourceSheetName: "Sheet1",
                sourceFormat: "M LEGASI Master Data",
                mappingTemplateId: null,
                headerFingerprint: "fp-abc",
                status: "uploaded",
                optionsJson: {
                  sheetNames: ["Sheet1", "Sheet2"],
                  suggestedSheet: "Sheet1",
                  detectedFormat: "M LEGASI Master Data",
                  savedMappingAvailable: false,
                  columns: [
                    { excelHeader: "Our Ref", target: "case.referenceNo" },
                    { excelHeader: "Purchaser 1", target: "purchaser.name", arrayIndex: 0 },
                  ],
                  fixedValues: {
                    projectId: 5,
                    developerId: 10,
                    caseType: "developer_sales",
                    preserveRef: true,
                  },
                },
                totalRows: 5,
                readyRows: 0,
                warningRows: 0,
                reviewRows: 0,
                duplicateRows: 0,
                importedRows: 0,
                failedRows: 0,
                createdAt: new Date(),
                updatedAt: new Date(),
                completedAt: null,
              });
              let cachedResult: unknown[] | null = null;
              const resolveBatch = (rawId: unknown, cond: unknown) => {
                let queryBatchId = Number(rawId ?? currentReqState.batchId ?? TEST_BATCH_ID);
                try {
                  const str = JSON.stringify(cond ?? {});
                  if (/\b99\b/.test(str)) queryBatchId = TEST_BATCH_ID_OTHER_FIRM;
                  else if (/\b42\b/.test(str)) queryBatchId = TEST_BATCH_ID;
                  else {
                    const m = str.match(/"value":\s*(\d+)/);
                    if (m) queryBatchId = Number(m[1]);
                  }
                } catch {
                  queryBatchId = Number(currentReqState.batchId ?? rawId ?? TEST_BATCH_ID);
                }
                const ownerFirm = BATCH_OWNERSHIP.get(queryBatchId);
                if (ownerFirm !== undefined && Number(currentReqState.firmId) !== ownerFirm) {
                  return [];
                }
                return [makeBatch(queryBatchId)];
              };
              const currentResult = () => Object.assign(Promise.resolve(cachedResult ?? [makeBatch(TEST_BATCH_ID)]), self);

              self.where = (cond: any) => {
                cachedResult = resolveBatch(undefined, cond);
                return currentResult();
              };
              self.limit = () => {
                if (cachedResult === null) cachedResult = resolveBatch(TEST_BATCH_ID, undefined);
                return currentResult();
              };
              self.orderBy = () => currentResult();
              return self;
            }
            if (tableName === "legacy_case_import_rows") {
              const self: any = {};
              const buildRows = () => [
                {
                  id: 1,
                  firmId: TEST_FIRM_ID,
                  batchId: TEST_BATCH_ID,
                  sourceRowNo: 1,
                  sourceRowHash: "hash1",
                  sourceReference: "REF-001",
                  rawRowJson: { "Our Ref": "REF-001", "Purchaser 1": "Ali Bin Ahmad" },
                  mappedPayloadJson: null,
                  validationJson: {
                    purchaserSummary: "Ali Bin Ahmad",
                    borrowerSummary: null,
                    propertySummary: "PT 123",
                    warnings: [{ code: "W1", message: "Warning 1" }],
                    errors: [],
                  },
                  rowStatus: "READY",
                  idempotencyKey: "key-1",
                  duplicateType: null,
                  duplicateCaseId: null,
                  duplicateScore: null,
                  createdCaseId: null,
                  errorCode: null,
                  errorMessage: null,
                },
                {
                  id: 2,
                  firmId: TEST_FIRM_ID,
                  batchId: TEST_BATCH_ID,
                  sourceRowNo: 2,
                  sourceRowHash: "hash2",
                  sourceReference: "REF-002",
                  rawRowJson: { "Our Ref": "REF-002", "Purchaser 1": "Siti Binti Yusof" },
                  mappedPayloadJson: null,
                  validationJson: {
                    purchaserSummary: "Siti Binti Yusof",
                    borrowerSummary: "Maybank",
                    propertySummary: null,
                    warnings: [],
                    errors: [{ code: "E1", message: "Missing IC" }],
                  },
                  rowStatus: "HARD_DUPLICATE",
                  idempotencyKey: "key-2",
                  duplicateType: "reference_no",
                  duplicateCaseId: 55,
                  duplicateScore: "1.00",
                  createdCaseId: null,
                  errorCode: null,
                  errorMessage: null,
                },
                {
                  id: 3,
                  firmId: TEST_FIRM_ID,
                  batchId: TEST_BATCH_ID,
                  sourceRowNo: 3,
                  sourceRowHash: "hash3",
                  sourceReference: "REF-003",
                  rawRowJson: { "Our Ref": "REF-003", "Purchaser 1": "Tan Wei Ling" },
                  mappedPayloadJson: null,
                  validationJson: {
                    purchaserSummary: "Tan Wei Ling",
                    borrowerSummary: null,
                    propertySummary: "Lot 789",
                    warnings: [],
                    errors: [],
                  },
                  rowStatus: "imported",
                  idempotencyKey: "key-3",
                  duplicateType: null,
                  duplicateCaseId: null,
                  duplicateScore: null,
                  createdCaseId: 120,
                  errorCode: null,
                  errorMessage: null,
                },
              ];
              const withRows = () => Object.assign(Promise.resolve(buildRows()), self);
              const withCount = () => Object.assign(Promise.resolve([{ count: 3 }]), self);
              self.where = () => (isCountSelect ? withCount() : withRows());
              self.limit = () => withRows();
              self.offset = () => withRows();
              self.orderBy = () => withRows();
              self.groupBy = () =>
                Object.assign(
                  Promise.resolve([
                    { rowStatus: "READY", count: 1 },
                    { rowStatus: "HARD_DUPLICATE", count: 1 },
                    { rowStatus: "imported", count: 1 },
                  ]),
                  self,
                );
              return self;
            }
            if (tableName === "legacy_case_import_mapping_templates") {
              return makeFluent(() => []);
            }
            if (tableName === "projects") {
              return makeFluent(() => [{ id: 5, firmId: TEST_FIRM_ID }]);
            }
            if (tableName === "developers") {
              return makeFluent(() => [{ id: 10, firmId: TEST_FIRM_ID }]);
            }
            if (tableName === "users") {
              return makeFluent(() => [{ id: 1 }]);
            }
            if (tableName === "audit_logs") {
              return makeFluent(() => []);
            }
            return makeFluent(() => []);
          },
        };
      },
      insert: (_table: unknown) => ({
        values: (values: unknown) => {
          const p = Promise.resolve([{ id: TEST_BATCH_ID }]) as any;
          p.returning = async () => [{ id: TEST_BATCH_ID }];
          p.onConflictDoUpdate = (opts: unknown) => {
            const p2 = Promise.resolve([{ id: 1 }]) as any;
            p2.returning = async () => [{ id: 1 }];
            return p2;
          };
          return p;
        },
      }),
      update: (_table: unknown) => ({
        set: (values: unknown) => {
          const self = makeFluent(() => [
            {
              id: TEST_BATCH_ID,
              optionsJson:
                values && typeof values === "object" && "optionsJson" in values
                  ? (values as any).optionsJson
                  : { columns: [], fixedValues: {} },
              status: "uploaded",
            },
          ]);
          return self;
        },
      }),
      delete: () => ({ where: () => makeFluent(() => []) }),
      transaction: async (fn: (tx: any) => Promise<any>) => {
        return await fn(makeDb());
      },
    };
    Object.assign(db, overrides);
    return db;
  };

  return {
    ...actual,
    db: makeDb(),
    sql: actual.sql ?? fakeSql,
    legacyCaseImportBatchesTable: actual.legacyCaseImportBatchesTable,
    legacyCaseImportRowsTable: actual.legacyCaseImportRowsTable,
    legacyCaseImportMappingTemplatesTable: actual.legacyCaseImportMappingTemplatesTable,
    projectsTable: actual.projectsTable,
    developersTable: actual.developersTable,
    usersTable: actual.usersTable,
    auditLogsTable: actual.auditLogsTable,
  };
});

vi.mock("../modules/cases/legacy-import/legacy-batch-pipeline.service.js", async () => {
  const actual = await import("../modules/cases/legacy-import/legacy-batch-pipeline.service.js");

  const runDryRun = async (..._args: unknown[]): Promise<{
    batchId: number;
    summary: {
      total: number;
      ready: number;
      warnings: number;
      reviewRequired: number;
      hardDuplicates: number;
      invalid: number;
    };
  }> => {
    return {
      batchId: TEST_BATCH_ID,
      summary: {
        total: 10,
        ready: 6,
        warnings: 2,
        reviewRequired: 1,
        hardDuplicates: 1,
        invalid: 0,
      },
    };
  };

  const runImport = async (..._args: unknown[]): Promise<void> => {
    return;
  };

  const refreshLegacyImportBatchStatus = async (
    _dbConn: any,
    batchId: number,
    _firmId: number,
  ): Promise<{
    batchId: number;
    status: "importing" | "partial_failed" | "failed" | "completed";
    summary: {
      total: number;
      imported: number;
      failed: number;
      duplicates: number;
      reviewRequired: number;
      remaining: number;
    };
  }> => {
    const usePartialFailed = argsCapture.partialFailedMode;
    const status = usePartialFailed ? "partial_failed" : "completed";

    return {
      batchId,
      status,
      summary: {
        total: 10,
        imported: usePartialFailed ? 7 : 8,
        failed: usePartialFailed ? 1 : 0,
        duplicates: 1,
        reviewRequired: 1,
        remaining: usePartialFailed ? 1 : 0,
      },
    };
  };

  const validateFixedValues = async (..._args: unknown[]): Promise<{ ok: true }> => {
    return { ok: true };
  };

  return {
    ...actual,
    runDryRun,
    runImport,
    refreshLegacyImportBatchStatus,
    validateFixedValues,
    __argsCapture: argsCapture,
  };
});

import legacyCaseImportRouter from "../routes/legacy-case-import.js";
import type { Router as ExpressRouterType } from "express";
import * as firmFeatMod from "../modules/platform/firm-feature-service.js";
import * as authMod from "../lib/auth.js";
import * as pipelineMod from "../modules/cases/legacy-import/legacy-batch-pipeline.service.js";

beforeAll(() => {
  vi.spyOn(global.console, "warn").mockImplementation(() => void 0);
  vi.spyOn(global.console, "error").mockImplementation(() => void 0);
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  argsCapture.currentRunImportOptions = null;
  argsCapture.partialFailedMode = false;
  (firmFeatMod as any).__setFeatureDisabled?.(false);
  (authMod as any).__setAuthContext?.(TEST_FIRM_ID, TEST_USER_ID, TEST_USER_TYPE);
});

function buildMinimalWorkbook(): Buffer {
  const headers = ["Our Ref", "Parcel No", "Purchaser 1", "IC 1", "Property", "Purchase Price"];
  const rows = [
    headers,
    ["REF-001", "P1", "Ali", "900101-00-0001", "PT 1", 500000],
    ["REF-002", "P2", "Siti", "900101-00-0002", "PT 2", 600000],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const out = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
  return Buffer.from(out);
}

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(legacyCaseImportRouter as unknown as ExpressRouterType);
  app.use((err: any, _req: any, res: any, _next: any) => {
    const status = Number(err?.status ?? 500);
    const code = String(err?.code ?? "UNKNOWN_ERROR");
    const message = String(err?.message ?? "Internal error");
    res.status(status).json({ error: { code, message } });
  });
  return app;
}

describe("Legacy Case Import Contract Integration Tests (C1-C10)", () => {
  describe("C1: POST /upload — response shape contract", () => {
    it("C1: minimal upload returns EXACT keys batchId,fileName,sheetNames,suggestedSheet,detectedFormat,savedMappingAvailable,totalRows — no autoMappings/columns", async () => {
      const app = createApp();
      const buf = buildMinimalWorkbook();
      const res = await request(app)
        .post("/upload")
        .attach("file", buf, "minimal-test.xlsx");

      expect([200, 201]).toContain(res.status);
      const body = res.body;

      const actualKeys = new Set(Object.keys(body));
      const expectedKeys = new Set([
        "batchId",
        "fileName",
        "sheetNames",
        "suggestedSheet",
        "detectedFormat",
        "savedMappingAvailable",
        "totalRows",
      ]);

      expect(actualKeys).toEqual(expectedKeys);
      expect(actualKeys.has("autoMappings")).toBe(false);
      expect(actualKeys.has("columns")).toBe(false);

      expect(typeof body.batchId).toBe("number");
      expect(typeof body.fileName).toBe("string");
      expect(Array.isArray(body.sheetNames)).toBe(true);
      expect(typeof body.suggestedSheet).toBe("string");
      expect(typeof body.detectedFormat).toBe("string");
      expect(typeof body.savedMappingAvailable).toBe("boolean");
      expect(typeof body.totalRows).toBe("number");
    });
  });

  describe("C2: GET /:batchId/mapping — mapping response contract", () => {
    it("C2: mapping endpoint returns columns[] + fixedValues{projectId,developerId,caseType:'developer_sales',preserveRef:true} + catalog[] + mappingSource string", async () => {
      const app = createApp();
      const res = await request(app).get(`/${TEST_BATCH_ID}/mapping`);

      expect(res.status).toBe(200);
      const body = res.body;

      expect(Array.isArray(body.columns)).toBe(true);
      expect(body.columns.length).toBeGreaterThanOrEqual(0);

      expect(body.fixedValues).toBeDefined();
      expect(typeof body.fixedValues).toBe("object");
      expect(body.fixedValues).toHaveProperty("projectId");
      expect(body.fixedValues).toHaveProperty("developerId");
      expect(body.fixedValues.caseType).toBe("developer_sales");
      expect(body.fixedValues.preserveRef).toBe(true);

      expect(Array.isArray(body.catalog)).toBe(true);
      expect(typeof body.mappingSource).toBe("string");
      expect(["saved_template", "auto_detected"]).toContain(body.mappingSource);
    });
  });

  describe("C3: PATCH /:batchId/mapping — update mapping succeeds", () => {
    it("C3: PATCH mapping with columns[] + fixedValues{projectId,developerId,caseType,preserveRef} returns 200 updated batch", async () => {
      const app = createApp();
      const payload = {
        columns: [
          { excelHeader: "Our Ref", target: "case.referenceNo" },
          { excelHeader: "Purchaser 1", target: "purchaser.name", arrayIndex: 0 },
        ],
        fixedValues: {
          projectId: 5,
          developerId: 10,
          caseType: "developer_sales",
          preserveRef: true,
          solMapping: {},
        },
      };

      const res = await request(app)
        .patch(`/${TEST_BATCH_ID}/mapping`)
        .send(payload);

      expect(res.status).toBe(200);
      const body = res.body;

      const returnedRow = Array.isArray(body) ? body[0] : body;
      expect(returnedRow).toBeDefined();

      const opts =
        (returnedRow?.optionsJson as Record<string, unknown>) ??
        (body?.optionsJson as Record<string, unknown>);

      if (opts && Object.keys(opts).length > 0) {
        expect(opts.columns).toBeDefined();
        expect(Array.isArray(opts.columns)).toBe(true);
        expect(opts.fixedValues).toBeDefined();
      }
    });
  });

  describe("C4: POST /:batchId/dry-run — dry run summary shape", () => {
    it("C4: dry-run endpoint returns { batchId, summary:{total,ready,warnings,reviewRequired,hardDuplicates,invalid} }", async () => {
      const app = createApp();
      const res = await request(app)
        .post(`/${TEST_BATCH_ID}/dry-run`)
        .send({});

      expect(res.status).toBe(200);
      const body = res.body;

      expect(body.batchId).toBe(TEST_BATCH_ID);
      expect(body.summary).toBeDefined();
      expect(typeof body.summary).toBe("object");

      const s = body.summary;
      const summaryKeys = new Set(Object.keys(s));
      const requiredSummaryKeys = [
        "total",
        "ready",
        "warnings",
        "reviewRequired",
        "hardDuplicates",
        "invalid",
      ];
      for (const k of requiredSummaryKeys) {
        expect(summaryKeys.has(k)).toBe(true);
        expect(typeof s[k]).toBe("number");
      }
    });
  });

  describe("C5: GET /:batchId/rows — row preview shape contract", () => {
    it("C5: rows endpoint returns rows with id,sourceRowNo,purchaserSummary?,borrowerSummary?,propertySummary?,rowStatus,warnings/errors arrays,duplicateType,duplicateCaseId,createdCaseId — NOT raw row json at top level", async () => {
      const app = createApp();
      const res = await request(app)
        .get(`/${TEST_BATCH_ID}/rows`)
        .query({ limit: "100", offset: "0" });

      expect(res.status).toBe(200);
      const body = res.body;

      expect(body.rows).toBeDefined();
      expect(Array.isArray(body.rows)).toBe(true);
      expect(body.rows.length).toBeGreaterThan(0);

      for (const row of body.rows) {
        expect(typeof row.id).toBe("number");
        expect(typeof row.sourceRowNo).toBe("number");
        expect(row).toHaveProperty("rowStatus");

        if (row.purchaserSummary !== null && row.purchaserSummary !== undefined) {
          expect(typeof row.purchaserSummary).toBe("string");
        }
        if (row.borrowerSummary !== null && row.borrowerSummary !== undefined) {
          expect(typeof row.borrowerSummary).toBe("string");
        }
        if (row.propertySummary !== null && row.propertySummary !== undefined) {
          expect(typeof row.propertySummary).toBe("string");
        }

        expect(Array.isArray(row.warnings)).toBe(true);
        expect(Array.isArray(row.errors)).toBe(true);

        expect(row).toHaveProperty("duplicateType");
        expect(row).toHaveProperty("duplicateCaseId");
        expect(row).toHaveProperty("createdCaseId");

        expect(row.rawRowJson).toBeUndefined();
        expect(row.raw_row_json).toBeUndefined();
        expect(row.sourceRowHash).toBeUndefined();
        expect(row.idempotencyKey).toBeUndefined();
      }
    });
  });

  describe("C6: POST /:batchId/import with rowIds — import body shape uses rowIds not rowIndices", () => {
    it("C6: import with {rowIds:[1,2],includeWarnings:true,reviewOverrides:{}} hits endpoint with correct body shape; response status+summary:{total,imported,failed,duplicates,reviewRequired,remaining}", async () => {
      const originalRunImport = (pipelineMod as any).runImport;

      let capturedArgs: any = null;
      (pipelineMod as any).runImport = async (...args: any[]) => {
        capturedArgs = args;
        argsCapture.currentRunImportOptions = args[4];
        return;
      };

      const app = createApp();
      const body = {
        rowIds: [1, 2],
        includeWarnings: true,
        reviewOverrides: {},
      };

      const res = await request(app)
        .post(`/${TEST_BATCH_ID}/import`)
        .send(body);

      expect(res.status).toBe(200);
      expect(capturedArgs).not.toBeNull();

      const opts = capturedArgs?.[4] ?? {};
      expect(opts.rowIds).toBeDefined();
      expect(Array.isArray(opts.rowIds)).toBe(true);
      expect(opts.rowIds).toEqual([1, 2]);
      expect(opts.rowIndices).toBeUndefined();
      expect(opts.includeWarnings).toBe(true);

      const respBody = res.body;
      expect(respBody).toHaveProperty("status");
      expect(respBody).toHaveProperty("summary");

      const sum = respBody.summary;
      expect(typeof sum).toBe("object");
      expect(sum).toHaveProperty("total");
      expect(sum).toHaveProperty("imported");
      expect(sum).toHaveProperty("failed");
      expect(sum).toHaveProperty("duplicates");
      expect(sum).toHaveProperty("reviewRequired");
      expect(sum).toHaveProperty("remaining");

      for (const k of ["total", "imported", "failed", "duplicates", "reviewRequired", "remaining"]) {
        expect(typeof sum[k]).toBe("number");
      }

      (pipelineMod as any).runImport = originalRunImport;
    });
  });

  describe("C7: reviewOverrides import_anyway — override path is respected", () => {
    it("C7: reviewOverrides { \"1\": { duplicateAction: \"import_anyway\" } } passes through runImport opts as numeric-keyed override", async () => {
      const originalRunImport = (pipelineMod as any).runImport;

      let capturedOpts: any = null;
      (pipelineMod as any).runImport = async (...args: any[]) => {
        capturedOpts = args[4];
        argsCapture.currentRunImportOptions = args[4];
        return;
      };

      const app = createApp();
      const body = {
        rowIds: [1],
        includeWarnings: true,
        reviewOverrides: {
          "1": { duplicateAction: "import_anyway" },
        },
      };

      const res = await request(app)
        .post(`/${TEST_BATCH_ID}/import`)
        .send(body);

      expect(res.status).toBe(200);
      expect(capturedOpts).not.toBeNull();
      expect(capturedOpts.reviewOverrides).toBeDefined();
      expect(typeof capturedOpts.reviewOverrides).toBe("object");

      const overrides = capturedOpts.reviewOverrides ?? {};
      const overrideForRow1 = overrides[1] ?? overrides["1"];
      expect(overrideForRow1).toBeDefined();
      expect(overrideForRow1.duplicateAction).toBe("import_anyway");

      (pipelineMod as any).runImport = originalRunImport;
    });
  });

  describe("C8: Feature disabled → 403 FEATURE_DISABLED (hard API gate)", () => {
    it("C8: assertFirmFeatureEnabled throws ApiError(403,FEATURE_DISABLED) → direct POST /upload returns HTTP 403 with error.code===FEATURE_DISABLED", async () => {
      (firmFeatMod as any).__setFeatureDisabled(true);

      const app = createApp();
      const buf = buildMinimalWorkbook();
      const res = await request(app)
        .post("/upload")
        .attach("file", buf, "minimal-test.xlsx");

      expect(res.status).toBe(403);
      expect(res.body?.error?.code).toBe("FEATURE_DISABLED");
    });
  });

  describe("C9: Cross-firm batch access → 404 (firm isolation)", () => {
    it("C9: batch created by firmId=2 is GET-ed by firmId=1 user → HTTP 404; cross-firm isolation enforced", async () => {
      (authMod as any).__setAuthContext?.(TEST_FIRM_ID, TEST_USER_ID, TEST_USER_TYPE);

      const app = createApp();
      const res = await request(app).get(`/${TEST_BATCH_ID_OTHER_FIRM}/mapping`);
      expect(res.status).toBe(404);
    });
  });

  describe("C10: partial_failed is terminal status", () => {
    it("C10: refreshLegacyImportBatchStatus returns status='partial_failed' → import response status=partial_failed and is a member of terminal set {completed, partial_failed, failed}", async () => {
      argsCapture.partialFailedMode = true;

      const app = createApp();
      const body = {
        rowIds: [1, 2, 3],
        includeWarnings: true,
        reviewOverrides: {},
      };
      const res = await request(app)
        .post(`/${TEST_BATCH_ID}/import`)
        .send(body);

      expect(res.status).toBe(200);
      const terminalSet = new Set(["completed", "partial_failed", "failed"]);
      expect(terminalSet.has(res.body.status)).toBe(true);
      expect(res.body.status).toBe("partial_failed");
      expect(res.body.summary.imported).toBe(7);
      expect(res.body.summary.failed).toBe(1);
    });
  });
});
