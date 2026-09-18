import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  normalizeDocGenLogAction,
  DOC_GEN_LOG_DB_ACTIONS,
  type DocGenLogAction,
  type DocGenLogDbAction,
} from "../lib/document-generation-log-action.js";

const ROUTES_DOCS_PATH = path.resolve(
  __dirname,
  "..",
  "routes",
  "documents.ts",
);

const EXPECTED_MAPPINGS: ReadonlyArray<{
  action: DocGenLogAction;
  expected: DocGenLogDbAction;
}> = [
  { action: "download", expected: "download" },
  { action: "print", expected: "print" },
  { action: "DOCUMENT_GENERATION_STARTED", expected: "download" },
  { action: "DOCUMENT_GENERATION_SUCCEEDED", expected: "download" },
  { action: "DOCUMENT_GENERATION_FAILED", expected: "download" },
  { action: "DOCUMENT_GENERATION_PARTIAL", expected: "download" },
  { action: "DOCUMENT_ZIP_CREATED", expected: "download_zip" },
  { action: "DOCUMENT_ZIP_DOWNLOAD_SUCCEEDED", expected: "download_zip" },
  { action: "DOCUMENT_ZIP_DOWNLOAD_FAILED", expected: "download_zip" },
  { action: "DOCUMENT_SYSTEM_PRINT_PREPARED", expected: "system_print" },
  { action: "DOCUMENT_SYSTEM_PRINT_FAILED", expected: "system_print" },
];

describe("docgen log action_type normalization (CHECK constraint migration 0083 compat)", () => {
  it("DOCUMENT_GENERATION_SUCCEEDED maps to download", () => {
    expect(normalizeDocGenLogAction("DOCUMENT_GENERATION_SUCCEEDED")).toBe(
      "download",
    );
  });

  it("DOCUMENT_ZIP_CREATED maps to download_zip", () => {
    expect(normalizeDocGenLogAction("DOCUMENT_ZIP_CREATED")).toBe(
      "download_zip",
    );
  });

  it("DOCUMENT_SYSTEM_PRINT_PREPARED maps to system_print", () => {
    expect(normalizeDocGenLogAction("DOCUMENT_SYSTEM_PRINT_PREPARED")).toBe(
      "system_print",
    );
  });

  it("download and print remain unchanged", () => {
    expect(normalizeDocGenLogAction("download")).toBe("download");
    expect(normalizeDocGenLogAction("print")).toBe("print");
  });

  it("exhaustive mapping: every DocGenLogAction value maps to exactly the expected DocGenLogDbAction", () => {
    for (const { action, expected } of EXPECTED_MAPPINGS) {
      expect(normalizeDocGenLogAction(action)).toBe(expected);
    }
  });

  it("every returned value is in {download, print, download_zip, system_print} (unsupported lifecycle never leaks)", () => {
    const allowed = new Set<string>(DOC_GEN_LOG_DB_ACTIONS);
    for (const { action } of EXPECTED_MAPPINGS) {
      const got = normalizeDocGenLogAction(action);
      expect(allowed.has(got)).toBe(true);
    }
  });

  it("source guard: all 3 document_generation_logs INSERT tiers bind ${dbActionType}; zero binds use ${args.actionType}", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const fnStart = src.indexOf("async function writeDocumentGenerationLog(");
    expect(fnStart).toBeGreaterThan(0);
    const nextFn = src.indexOf("function decodeStoragePath(", fnStart);
    expect(nextFn).toBeGreaterThan(fnStart);
    const body = src.slice(fnStart, nextFn);
    const inserts = [...body.matchAll(/INSERT INTO document_generation_logs/g)];
    expect(inserts.length).toBe(3);
    const rawActionBinds = [...body.matchAll(/\$\{args\.actionType\}/g)];
    expect(rawActionBinds).toHaveLength(0);
    const dbActionBinds = [...body.matchAll(/\$\{dbActionType\}/g)];
    expect(dbActionBinds).toHaveLength(3);
  });
});
