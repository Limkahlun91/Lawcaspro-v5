import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ============================================================
// Document Generation run-next duplicate-output check
// URGENT MINIMAL FIX — root causes:
//   1. Firm-template branch referenced NON-EXISTENT case_documents column
//      `document_template_id` -> actual column is `template_id`.
//   2. The enclosing try/catch silently swallowed (catch(skipErr){}) any
//      postgres errors from the duplicate SELECT, leaving the current
//      transaction in aborted state and producing misleading late 25P02.
// ============================================================

const hoisted = vi.hoisted(() => {
  const fakeLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return { fakeLogger };
});

vi.mock("../lib/logger.js", () => ({ logger: hoisted.fakeLogger }));

const ROUTES_DOCS_PATH = path.resolve(
  __dirname,
  "..",
  "routes",
  "documents.ts",
);
const SCHEMA_DOCS_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "lib",
  "db",
  "src",
  "schema",
  "documents.ts",
);

describe("docgen run-next — duplicate existing output check (Server A 25P02 root cause fix)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Part 1 — source audit of WHERE columns", () => {
    it("Schema: case_documents declares template_id + platform_document_id; there is NO document_template_id column", () => {
      expect(fs.existsSync(SCHEMA_DOCS_PATH)).toBe(true);
      const schema = fs.readFileSync(SCHEMA_DOCS_PATH, "utf8");
      // Find the caseDocumentsTable pgTable() declaration block:
      // locate line "caseDocumentsTable = pgTable("case_documents", {" and capture
      // everything until the closing "}," just before table index tuple.
      const startIdx = schema.indexOf('caseDocumentsTable = pgTable("case_documents",');
      expect(startIdx).toBeGreaterThanOrEqual(0);
      // Grab 4000 chars forward (enough for all columns) — search for lines with
      // serial/text/integer/boolean/timestamp/jsonb/uuid/date( column-name-regex
      // pattern inside this block.
      const slice = schema.slice(startIdx, startIdx + 5000);
      const colMatches = [
        ...slice.matchAll(
          /(\w+):\s*(?:serial|integer|text|boolean|timestamp|jsonb|uuid|date)\("([^"]+)"\)/g,
        ),
      ];
      const sqlColNames = colMatches.map(([, _ts, sql]) => sql as string);
      expect(sqlColNames).toContain("template_id");
      expect(sqlColNames).toContain("platform_document_id");
      expect(sqlColNames).toContain("template_source");
      expect(sqlColNames).not.toContain("document_template_id");
    });

    it("Firm branch: duplicate-output check on case_documents references template_id (not document_template_id)", () => {
      expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
      const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
      // Locate the duplicate existing output WHERE block using triple anchors:
      //   (a) `const templateIdWhere = ...` (b) templateSource === "master"
      //   (c) SELECT id, object_path, file_name FROM case_documents
      const re =
        /const\s+templateIdWhere\s*=\s*[\s\S]*?templateSource\s*===\s*"master"[\s\S]*?SELECT\s+id,\s*object_path,\s*file_name\s+FROM\s+case_documents/m;
      const match = src.match(re);
      expect(match).toBeDefined();
      expect(match).not.toBeNull();
      const block = match![0] ?? "";
      // Firm branch (`:` clause of ternary) MUST reference the real column `template_id`
      expect(block).toMatch(
        /:\s*sql`template_id\s*=\s*\$\{templateId\}`/,
      );
      // Firm branch MUST NOT reference the fake `document_template_id` column
      expect(block).not.toMatch(
        /:\s*sql`document_template_id\s*=\s*\$\{templateId\}`/,
      );
    });

    it("Master branch: duplicate-output check on case_documents still uses platform_document_id", () => {
      const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
      const re =
        /const\s+templateIdWhere\s*=\s*[\s\S]*?templateSource\s*===\s*"master"[\s\S]*?SELECT\s+id,\s*object_path,\s*file_name\s+FROM\s+case_documents/m;
      const match = src.match(re);
      expect(match).not.toBeNull();
      const block = match![0] ?? "";
      expect(block).toMatch(
        /\?\s*sql`platform_document_id\s*=\s*\$\{platformDocumentId\}`/,
      );
    });

    it("Repo-wide audit: zero remaining references to case_documents.document_template_id (raw SQL or drizzle)", () => {
      const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
      // In routes/documents.ts: any WHERE/SET/raw SQL reference to document_template_id against case_documents
      // must be zero.
      expect(src).not.toMatch(/\bdocument_template_id\b/);
    });
  });

  describe("Part 2 — catch-block must NOT silently swallow (prevents misleading 25P02)", () => {
    // Replicate the EXACT catch block logic for an isolated unit test,
    // using the same imports the production code would use (we mock logger +
    // extractDbErrorInfo to match contracts), so we can verify:
    //   (a) logger.error fires with stage=duplicate_existing_output_check +
    //       required keys: jobId/jobItemId/firmId/caseId/templateSource/
    //       templateId/platformDocumentId/sqlState/code/errMessageShort
    //   (b) original error is RE-THROWN (not swallowed).
    //
    // This isolated function mirrors production code verbatim for the catch
    // block body. DO NOT simplify it; if production catch block changes this
    // test must fail loudly.
    function buildDuplicateCheckCatchBody(ctx: {
      args: { jobId: number; firmId: number };
      jobItemId: number | null;
      caseId: number;
      templateSource: "firm" | "master";
      templateId: number;
      platformDocumentId: number;
      extractDbErrorInfoFn: (e: Error) => {
        sqlState?: string | null;
        sqlstate?: string | null;
        code?: string | null;
        message?: string | null;
      };
      loggerError: (...args: unknown[]) => void;
    }) {
      return function catchBody(skipErr: unknown) {
        const dbInfo = ctx.extractDbErrorInfoFn(skipErr as Error);
        const rawMsg = String(skipErr instanceof Error ? skipErr.message : String(skipErr));
        const errMessageShort =
          dbInfo.message && String(dbInfo.message).trim()
            ? String(dbInfo.message)
            : rawMsg;
        ctx.loggerError(
          {
            stage: "duplicate_existing_output_check",
            jobId: ctx.args.jobId,
            jobItemId: ctx.jobItemId,
            firmId: ctx.args.firmId,
            caseId: ctx.caseId,
            templateSource: ctx.templateSource,
            templateId: Number.isFinite(ctx.templateId) ? ctx.templateId : null,
            platformDocumentId: Number.isFinite(ctx.platformDocumentId)
              ? ctx.platformDocumentId
              : null,
            sqlState: dbInfo.sqlState ?? dbInfo.sqlstate ?? null,
            code: dbInfo.code ?? null,
            errMessageShort: errMessageShort.slice(0, 240),
          },
          "docgen.run_next.duplicate_check_failed",
        );
        throw skipErr;
      };
    }

    it("Firm template duplicate SELECT throw — original 42703 error logged + rethrown (not swallowed, no silent 25P02)", () => {
      const err = new Error(
        'column "document_template_id" does not exist — this should never hit with the fix',
      );
      (err as any).sqlState = "42703";
      (err as any).code = "UNDEFINED_COLUMN";
      (err as any).message =
        'column "document_template_id" does not exist — synthetic 42703';
      const extract = (_e: Error) => ({
        sqlstate: "42703",
        code: "42703",
        message:
          'column "document_template_id" does not exist — synthetic 42703',
      });
      const loggerError = vi.fn();
      const cb = buildDuplicateCheckCatchBody({
        args: { jobId: 88, firmId: 7 },
        jobItemId: 912,
        caseId: 55,
        templateSource: "firm",
        templateId: 13,
        platformDocumentId: NaN,
        extractDbErrorInfoFn: extract,
        loggerError,
      });
      expect(() => cb(err)).toThrow(err);
      expect(loggerError).toHaveBeenCalledTimes(1);
      const [meta, event] = loggerError.mock.calls[0];
      expect(event).toBe("docgen.run_next.duplicate_check_failed");
      expect(meta.stage).toBe("duplicate_existing_output_check");
      expect(meta.jobId).toBe(88);
      expect(meta.jobItemId).toBe(912);
      expect(meta.firmId).toBe(7);
      expect(meta.caseId).toBe(55);
      expect(meta.templateSource).toBe("firm");
      expect(meta.templateId).toBe(13);
      expect(meta.platformDocumentId).toBeNull();
      expect(meta.sqlState).toBe("42703");
      expect(meta.code).toBe("42703");
      expect(String(meta.errMessageShort ?? "")).toContain(
        "document_template_id",
      );
    });

    it("Master template duplicate SELECT throw — logs correctly with platformDocumentId + rethrows", () => {
      const err = new Error(
        "permission denied for table case_documents — synthetic 42501",
      );
      (err as any).sqlState = "42501";
      (err as any).code = "INSUFFICIENT_PRIVILEGE";
      const extract = (_e: Error) => ({
        sqlstate: "42501",
        code: "42501",
        message:
          "permission denied for table case_documents — synthetic 42501",
      });
      const loggerError = vi.fn();
      const cb = buildDuplicateCheckCatchBody({
        args: { jobId: 88, firmId: 7 },
        jobItemId: 912,
        caseId: 55,
        templateSource: "master",
        templateId: NaN,
        platformDocumentId: 77,
        extractDbErrorInfoFn: extract,
        loggerError,
      });
      expect(() => cb(err)).toThrow(err);
      expect(loggerError).toHaveBeenCalledTimes(1);
      const [meta, event] = loggerError.mock.calls[0];
      expect(event).toBe("docgen.run_next.duplicate_check_failed");
      expect(meta.stage).toBe("duplicate_existing_output_check");
      expect(meta.templateSource).toBe("master");
      expect(meta.templateId).toBeNull();
      expect(meta.platformDocumentId).toBe(77);
      expect(meta.sqlState).toBe("42501");
      expect(meta.code).toBe("42501");
    });

    it("Production routes/documents.ts file: enclosing try for templateIdWhere SELECT is wrapped with extractDbErrorInfo+rethrow catch (structural audit)", () => {
      const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
      // Locate the line `const templateIdWhere = ...`; then find the IMMEDIATE
      // outermost try block: the one that wraps templateIdWhere assignment,
      // case_documents SELECT, and the UPDATE + updateJobCounts.
      // Scan forward, parse braces by depth; find its matching `catch (skipErr) {`.
      const marker = "const templateIdWhere =";
      const markerIdx = src.indexOf(marker);
      expect(markerIdx).toBeGreaterThanOrEqual(0);
      // Walk backwards to the closest `try {` that still precedes the marker.
      let braceDepth = 0;
      let scan = markerIdx;
      // First find the outermost `try {` start: go left, count braces inside-out.
      let tryStart = -1;
      while (scan > Math.max(0, markerIdx - 2000)) {
        if (src[scan] === "}") braceDepth++;
        else if (src[scan] === "{") {
          if (braceDepth === 0) {
            // candidate — confirm it is the `try` statement before marker
            const pre = src.slice(Math.max(0, scan - 30), scan);
            if (/\btry\s*$/.test(pre)) {
              tryStart = scan;
              break;
            }
          } else {
            braceDepth--;
          }
        }
        scan--;
      }
      expect(tryStart).toBeGreaterThan(0);
      // Walk forward from try body { to find its matching `catch (skipErr)`
      let d2 = 0;
      let cursor = tryStart;
      let catchBodyStart = -1;
      while (cursor < tryStart + 6000 && cursor < src.length) {
        const c = src[cursor];
        if (c === "{") d2++;
        else if (c === "}") {
          d2--;
          if (d2 === 0) {
            // Next: look for catch clause
            const tail = src.slice(cursor + 1, cursor + 200);
            const m = tail.match(/^\s*catch\s*\(\s*(\w+)\s*\)\s*\{/);
            if (m && m[1]) {
              catchBodyStart = cursor + 1 + (m.index ?? 0) + m[0].length;
              break;
            }
          }
        }
        cursor++;
      }
      expect(catchBodyStart).toBeGreaterThan(0);
      // Extract catch body: find its closing brace via depth again
      let d3 = 1;
      let cc = catchBodyStart;
      while (cc < catchBodyStart + 5000 && cc < src.length) {
        const c = src[cc];
        if (c === "{") d3++;
        else if (c === "}") {
          d3--;
          if (d3 === 0) break;
        }
        cc++;
      }
      const catchBody = src.slice(catchBodyStart, cc);
      // Required structured keys in logger.error meta
      expect(catchBody).toContain('stage: "duplicate_existing_output_check"');
      expect(catchBody).toContain("jobId: args.jobId");
      expect(catchBody).toContain("jobItemId");
      expect(catchBody).toContain("firmId: args.firmId");
      expect(catchBody).toContain("caseId");
      expect(catchBody).toContain("templateSource");
      expect(catchBody).toContain("templateId");
      expect(catchBody).toContain("platformDocumentId");
      expect(catchBody).toContain("sqlState");
      expect(catchBody).toContain("code: dbInfo.code");
      expect(catchBody).toContain("errMessageShort");
      expect(catchBody).toContain("extractDbErrorInfo");
      expect(catchBody).toContain("docgen.run_next.duplicate_check_failed");
      // Critical: must re-throw (not swallow)
      expect(catchBody).toMatch(/\bthrow\s+\w+\b/);
      expect(catchBody.trim().length).toBeGreaterThan(30);
    });
  });

  describe("Part 3 — duplicate-existing-output UPDATE to document_generation_job_items", () => {
    it("Schema: documentGenerationJobItemsTable DOES NOT declare case_document_id column (42703 would fire if used)", () => {
      expect(fs.existsSync(SCHEMA_DOCS_PATH)).toBe(true);
      const schema = fs.readFileSync(SCHEMA_DOCS_PATH, "utf8");
      // Locate document_generation_job_items declaration
      const startIdx = schema.indexOf(
        'documentGenerationJobItemsTable = pgTable("document_generation_job_items",',
      );
      expect(startIdx).toBeGreaterThanOrEqual(0);
      // Extract the column object body up to the index-tuple start (2nd arg):
      // scan for matching outer braces.
      const objStart = schema.indexOf("{", startIdx);
      expect(objStart).toBeGreaterThan(startIdx);
      let d = 0;
      let c = objStart;
      while (c < schema.length) {
        const ch = schema[c];
        if (ch === "{") d++;
        else if (ch === "}") {
          d--;
          if (d === 0) break;
        }
        c++;
      }
      const body = schema.slice(objStart, c + 1);
      // Pull all quoted snake_case identifiers (these are the SQL column names).
      const allQuoted = [...body.matchAll(/"([a-z][a-z0-9_]*)"/g)].map(
        ([, n]) => n as string,
      );
      const sqlColNames = Array.from(new Set(allQuoted));
      expect(sqlColNames).toContain("job_id");
      expect(sqlColNames).toContain("object_path");
      expect(sqlColNames).toContain("file_name");
      expect(sqlColNames).toContain("status");
      expect(sqlColNames).toContain("finished_at");
      expect(sqlColNames).toContain("diagnostic");
      expect(sqlColNames).toContain("error_code");
      expect(sqlColNames).toContain("error_message");
      expect(sqlColNames).toContain("started_at");
      expect(sqlColNames).toContain("phase");
      expect(sqlColNames).toContain("template_version_id");
      expect(sqlColNames).not.toContain("case_document_id");
    });

    it("Firm duplicate-success UPDATE to document_generation_job_items does NOT write case_document_id", () => {
      const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
      // Locate the skip-existing-output UPDATE to document_generation_job_items
      // anchored on the UNIQUE `existingDocObjectPath.startsWith("/objects/")` gate
      // ONLY present in the case_documents duplicate branch.
      const unique = 'existingDocObjectPath.startsWith("/objects/")';
      const anchor = src.indexOf(unique);
      expect(anchor).toBeGreaterThan(0);
      const check = src.slice(anchor, anchor + 3500);
      const spIdx = check.indexOf("const setParts2:");
      expect(spIdx).toBeGreaterThan(0);
      const setStart = check.indexOf("[", spIdx);
      const setStop = (() => {
        let d = 0;
        let c = setStart;
        while (c < check.length) {
          const ch = check[c];
          if (ch === "[") d++;
          else if (ch === "]") {
            d--;
            if (d === 0) return c;
          }
          c++;
        }
        return -1;
      })();
      expect(setStop).toBeGreaterThan(setStart);
      const setBody = check.slice(setStart, setStop + 1);
      expect(setBody).not.toMatch(/case_document_id\s*=/);
    });

    it("Duplicate-success UPDATE still writes object_path, file_name, status success, finished_at", () => {
      const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
      const unique = 'existingDocObjectPath.startsWith("/objects/")';
      const anchor = src.indexOf(unique);
      expect(anchor).toBeGreaterThan(0);
      const check = src.slice(anchor, anchor + 3500);
      const spIdx = check.indexOf("const setParts2:");
      expect(spIdx).toBeGreaterThan(0);
      const setStart = check.indexOf("[", spIdx);
      const setStop = (() => {
        let d = 0;
        let c = setStart;
        while (c < check.length) {
          const ch = check[c];
          if (ch === "[") d++;
          else if (ch === "]") {
            d--;
            if (d === 0) return c;
          }
          c++;
        }
        return -1;
      })();
      expect(setStop).toBeGreaterThan(setStart);
      const setBody = check.slice(setStart, setStop + 1);
      expect(setBody).toContain("status = 'success'");
      expect(setBody).toContain("object_path =");
      expect(setBody).toContain("file_name =");
      expect(setBody).toContain("finished_at =");
      expect(setBody).toContain("error_code = NULL");
      expect(setBody).toContain("error_message = NULL");
    });

    it("Duplicate-success diagnostic JSON still contains existingCaseDocumentId key (identity preserved via JSONB, not via FK column)", () => {
      const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
      const unique = 'existingDocObjectPath.startsWith("/objects/")';
      const anchor = src.indexOf(unique);
      expect(anchor).toBeGreaterThan(0);
      const check = src.slice(anchor, anchor + 4500);
      const di = check.indexOf("'existingCaseDocumentId'");
      expect(di).toBeGreaterThan(0);
      // Walk BACK to find `diagnostic =` so we capture the entire assignment
      const diagnosticAssignIdx = check.lastIndexOf("diagnostic =", di);
      expect(diagnosticAssignIdx).toBeGreaterThan(0);
      const around = check.slice(
        diagnosticAssignIdx,
        diagnosticAssignIdx + 500,
      );
      expect(around).toMatch(/'existingCaseDocumentId',\s*\$\{Number\(existingDoc\.id\)\}/);
      expect(around).toMatch(/'skippedExisting',\s*true/);
      expect(around).toMatch(/'skipReason',\s*'case_document_generated_row_exists'/);
      expect(around).toMatch(/'existingObjectPath',\s*\$\{existingDocObjectPath\}/);
      expect(around).toContain("diagnostic =");
      expect(around).toContain("COALESCE(diagnostic, '{}'::jsonb)");
    });
  });
});
