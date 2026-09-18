import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROUTES_DOCS_PATH = path.resolve(
  __dirname,
  "..",
  "routes",
  "documents.ts",
);
const AUTH_LIB_PATH = path.resolve(
  __dirname,
  "..",
  "lib",
  "auth.ts",
);

function findWriteAuditLogCallBlocks(src: string): Array<{
  full: string;
  action: string | null;
  hasDbROption: boolean;
}> {
  const results: Array<{
    full: string;
    action: string | null;
    hasDbROption: boolean;
  }> = [];
  let pos = 0;
  for (;;) {
    const start = src.indexOf("await writeAuditLog(", pos);
    if (start < 0) break;
    let depth = 0;
    let i = start;
    let started = false;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === "(") { depth++; started = true; }
      else if (ch === ")") {
        depth--;
        if (started && depth === 0) break;
      }
    }
    const block = src.slice(start, i + 1);
    const actionMatch = block.match(/action:\s*"([^"]+)"/);
    const hasDbR = /,\s*\{\s*db:\s*r\s*\}\s*\)$/.test(block.trim());
    results.push({
      full: block,
      action: actionMatch ? actionMatch[1]! : null,
      hasDbROption: hasDbR,
    });
    pos = i + 1;
  }
  return results;
}

describe("docgen audit — tenant RLS DB context passed (42501 audit_logs permission denied fix)", () => {
  it("Auth: writeAuditLog options.db widened to accept RlsDb | typeof db (allows DbConn without blind cast)", () => {
    expect(fs.existsSync(AUTH_LIB_PATH)).toBe(true);
    const src = fs.readFileSync(AUTH_LIB_PATH, "utf8");
    const sigLine = src.match(
      /\},\s*options\?\:\s*\{\s*db\?\:\s*([^;]+?);\s*strict\?\:\s*boolean\s*\}\s*\)\s*\{/,
    );
    expect(sigLine).not.toBeNull();
    const dbType = sigLine![1]!.trim();
    expect(dbType).toContain("RlsDb");
    expect(dbType).toContain("typeof db");
  });

  it("Auth: writeAuditLog uses targetDb.insert when options.db provided; falls back to global db.insert otherwise", () => {
    expect(fs.existsSync(AUTH_LIB_PATH)).toBe(true);
    const src = fs.readFileSync(AUTH_LIB_PATH, "utf8");
    const targetDbAssign = src.indexOf("const targetDb = options?.db;");
    expect(targetDbAssign).toBeGreaterThan(0);
    const ifBlock = src.indexOf("if (targetDb) {", targetDbAssign);
    expect(ifBlock).toBeGreaterThan(targetDbAssign);
    const targetInsert = src.indexOf("targetDb.insert(auditLogsTable).values(shared)", ifBlock);
    expect(targetInsert).toBeGreaterThan(ifBlock);
    const elseBlock = src.indexOf("} else {", targetInsert);
    expect(elseBlock).toBeGreaterThan(targetInsert);
    const globalInsert = src.indexOf("db.insert(auditLogsTable).values(shared)", elseBlock);
    expect(globalInsert).toBeGreaterThan(elseBlock);
  });

  it("generateFirmDocument: documents.case.generate audit (stack trace hit) passes { db: r } tenant context", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const fnStart = src.indexOf("async function generateFirmDocument(");
    expect(fnStart).toBeGreaterThan(0);
    const fnEnd = src.indexOf("async function generateMasterDocument(", fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const slice = src.slice(fnStart, fnEnd);
    const calls = findWriteAuditLogCallBlocks(slice);
    const mainSuccess = calls.find((c) => c.action === "documents.case.generate");
    expect(mainSuccess).toBeDefined();
    expect(mainSuccess!.hasDbROption).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const c of calls) {
      expect(c.hasDbROption).toBe(true);
    }
  });

  it("generateFirmDocument: applicability-blocked + checklist-blocked + binding_used audits all pass tenant rlsDb", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const fnStart = src.indexOf("async function generateFirmDocument(");
    const fnEnd = src.indexOf("async function generateMasterDocument(", fnStart);
    const slice = src.slice(fnStart, fnEnd);
    const calls = findWriteAuditLogCallBlocks(slice);
    const actions = calls.map((c) => c.action);
    expect(actions).toContain("documents.case.generate.blocked");
    expect(actions).toContain("documents.case.generate");
    expect(actions).toContain("documents.generate.binding_used");
    const blockedCount = actions.filter(
      (a) => a === "documents.case.generate.blocked",
    ).length;
    expect(blockedCount).toBeGreaterThanOrEqual(4);
    for (const c of calls) {
      expect(c.hasDbROption).toBe(true);
    }
  });

  it("generateMasterDocument: all audits (blocked, generate_from_master, binding_used) pass tenant rlsDb `r`", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const allCalls = findWriteAuditLogCallBlocks(src);
    const genFromMaster = allCalls.find(
      (c) => c.action === "documents.case.generate_from_master",
    );
    expect(genFromMaster).toBeDefined();
    expect(genFromMaster!.hasDbROption).toBe(true);
    const masterBlocked = allCalls.filter(
      (c) =>
        c.action === "documents.case.generate.blocked" &&
        c.full.includes('entityType: "platform_document"'),
    );
    expect(masterBlocked.length).toBeGreaterThanOrEqual(4);
    for (const c of masterBlocked) expect(c.hasDbROption).toBe(true);
    const masterBindings = allCalls.find(
      (c) =>
        c.action === "documents.generate.binding_used" &&
        c.full.includes("platformDocumentId="),
    );
    expect(masterBindings).toBeDefined();
    expect(masterBindings!.hasDbROption).toBe(true);
  });

  it("run-next immediate caller: documents.generation.async.succeeded audit passes tenant rlsDb `r`", () => {
    expect(fs.existsSync(ROUTES_DOCS_PATH)).toBe(true);
    const src = fs.readFileSync(ROUTES_DOCS_PATH, "utf8");
    const calls = findWriteAuditLogCallBlocks(src);
    const asyncOk = calls.find(
      (c) => c.action === "documents.generation.async.succeeded",
    );
    expect(asyncOk).toBeDefined();
    expect(asyncOk!.hasDbROption).toBe(true);
  });
});
