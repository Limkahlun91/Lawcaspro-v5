import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../app";
import { db, platformClausesTable, firmClausesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

let partnerToken = "";
let partnerFirmId = 0;
let platformClauseId: number | null = null;
let firmClauseId: number | null = null;

beforeAll(async () => {
  const loginRes = await request(app)
    .post("/api/auth/login")
    .send({ email: "partner@tan-associates.my", password: "lawyer123" });
  partnerToken = loginRes.body.data.token;
  partnerFirmId = loginRes.body.data.firmId;

  const [created] = await db.insert(platformClausesTable).values({
    clauseCode: "TEST_CLAUSE_001",
    title: "Test Clause 001",
    category: "General",
    language: "en",
    body: "Hello {{unknown_var}}",
    notes: null,
    tags: ["test"],
    status: "active",
    isSystem: false,
    sortOrder: 0,
    applicability: null,
    createdBy: null,
    updatedBy: null,
  }).returning();
  platformClauseId = created.id;
});

afterAll(async () => {
  if (firmClauseId) {
    await db.delete(firmClausesTable).where(eq(firmClausesTable.id, firmClauseId));
  }
  if (platformClauseId) {
    await db.delete(platformClausesTable).where(eq(platformClausesTable.id, platformClauseId));
  }
});

describe("Clause Library API", () => {
  it("copies platform clause to firm clause", async () => {
    const res = await request(app)
      .post(`/api/clauses/platform/${platformClauseId}/copy`)
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(res.status).toBe(201);
    expect(res.body.firm_id).toBe(partnerFirmId);
    expect(String(res.body.clause_code)).toBe("TEST_CLAUSE_001");
    firmClauseId = res.body.id;

    const preview = await request(app)
      .get(`/api/clauses/firm/${firmClauseId}/preview`)
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(preview.status).toBe(200);
    expect(preview.body.unknownVariables).toContain("unknown_var");

    const list = await request(app)
      .get(`/api/clauses?scope=firm&q=TEST_CLAUSE_001&includeBody=1`)
      .set("Authorization", `Bearer ${partnerToken}`);
    expect(list.status).toBe(200);
    const found = (list.body as any[]).find((x) => x.id === firmClauseId);
    expect(found).toBeTruthy();
    expect(found.body).toContain("Hello");
  });
});
