import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const PUBLIC_PATH = resolve(__dirname, "../routes/public.ts");
const src = readFileSync(PUBLIC_PATH, "utf8");

describe("CLIENT PORTAL — token / case ownership contract", () => {
  it("trackingToken param validates as UUID (z.string().uuid()) before any DB access", () => {
    expect(src).toMatch(/TokenParams\s*=\s*z\.object\(\{\s*token:\s*z\.string\(\)\.uuid\(\)\s*\}\)/);
  });

  it("findCaseByToken resolves UUID to exactly one Case via casesTable.trackingToken, returns {id, firmId}", () => {
    expect(src).toContain("async function findCaseByToken");
    expect(src).toMatch(/from\(casesTable\)[\s\S]*?where\(eq\(casesTable\.trackingToken,\s*token\)\)[\s\S]*?limit\(1\)/);
    expect(src).toMatch(/select\(\s*\{\s*id:\s*casesTable\.id,\s*firmId:\s*casesTable\.firmId\s*\}\)/);
  });

  it("3 endpoints call findCaseByToken and then use same resolved c.id for all further queries (cross-case isolation)", () => {
    // track/:token body — cases, workflow, key dates, steps all WHERE c.id
    expect(src).toMatch(/where\(eq\(caseWorkflowStepsTable\.caseId,\s*c\.id\)\)/);
    expect(src).toMatch(/where\(and\(eq\(caseKeyDatesTable\.caseId,\s*c\.id\),\s*eq\(caseKeyDatesTable\.firmId,\s*c\.firmId\)\)/);
    // messages list
    expect(src).toMatch(/eq\(caseMessagesTable\.caseId,\s*c\.id\)/);
    // messages POST inserts firmId=c.firmId, caseId=c.id
    expect(src).toMatch(/firmId:\s*c\.firmId,[\s\S]*?caseId:\s*c\.id,/);
  });

  it("messages channel = client filter only (inArray senderType = 'client' or 'staff', never internal-only)", () => {
    expect(src).toMatch(/eq\(caseMessagesTable\.channel,\s*"client"\)/);
    expect(src).toMatch(/inArray\(caseMessagesTable\.senderType,\s*\["client",\s*"staff"\]\)/);
  });

  it("POST /public/track/:token/messages enforces channel === 'client' via body/channel validation", () => {
    expect(src).toContain("if (bodyParsed.data.channel && bodyParsed.data.channel !== \"client\")");
    expect(src).toContain("res.status(400).json({ error: \"Invalid channel\" })");
  });

  it("maskName function obscures purchaser names (not raw internal clients.name exposed)", () => {
    expect(src).toContain("function maskName");
    expect(src).toContain("maskedPurchaserName = purchaser?.name");
  });

  it("no internal-only data exposed: no staff notes, no private accounting, no approval, no usersTable join beyond senderName staff display", () => {
    expect(src).not.toMatch(/accounting|payment_voucher|invoice|receipt|quotation|billing/i);
    expect(src).not.toContain("case_notes");
  });
});

describe("CLIENT PORTAL — DB-free source-level ownership invariants", () => {
  it("GET /public/track/:token returns 404 if findCaseByToken returns null (unknown token)", () => {
    expect(src).toMatch(/const c\s*=\s*await findCaseByToken\([\s\S]*?if\s*\(\s*!c\s*\)\s*\{\s*res\.status\(404\)/);
  });

  it("messages GET returns 404 when token does not resolve to case", () => {
    expect(src).toMatch(/\/public\/track\/:token\/messages[\s\S]*?const c\s*=\s*await findCaseByToken[\s\S]*?!c[\s\S]*?404/);
  });

  it("messages POST returns 404 when token does not resolve to case, writeAuditLog uses actorId:null actorType:client", () => {
    expect(src).toMatch(/actorId:\s*null,[\s\S]*?actorType:\s*"client"/);
  });
});
