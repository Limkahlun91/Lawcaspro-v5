import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import app from "../app";

const PARTNER_EMAIL = "partner@tan-associates.my";
const PARTNER_PWD = "lawyer123";

const skipDb = process.env.VITEST_SKIP_DB === "1";
const suite = skipDb ? describe.skip : describe;

let token: string;

beforeAll(async () => {
  if (skipDb) return;
  const res = await request(app)
    .post("/api/auth/login")
    .send({ email: PARTNER_EMAIL, password: PARTNER_PWD });
  expect(res.status).toBe(200);
  token = res.body.data.token;
  expect(typeof token).toBe("string");
});

suite("Documents & Generation smoke", () => {
  it("GET /api/document-templates returns 200 (array)", async () => {
    const res = await request(app)
      .get("/api/document-templates")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("GET /api/document-templates/:id/download returns 404 for non-existent template", async () => {
    const res = await request(app)
      .get("/api/document-templates/99999999/download")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(String(res.body?.error ?? "")).toMatch(/not found/i);
  });

  it("POST /api/cases/:caseId/documents/generate returns 404 for non-existent template", async () => {
    const res = await request(app)
      .post("/api/cases/1/documents/generate")
      .set("Authorization", `Bearer ${token}`)
      .send({ templateId: 99999999, documentName: "Smoke Gen" });

    expect(res.status).toBe(404);
    expect(String(res.body?.error ?? "")).toMatch(/not found/i);
  });

  it("GET /api/document-templates/:id/versions returns 404 for non-existent template", async () => {
    const res = await request(app)
      .get("/api/document-templates/99999999/versions")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(String(res.body?.error ?? "")).toMatch(/not found/i);
  });

  it("POST /api/cases/:caseId/documents/batch-generate returns 422 for empty items", async () => {
    const res = await request(app)
      .post("/api/cases/1/documents/batch-generate")
      .set("Authorization", `Bearer ${token}`)
      .send({ items: [] });

    expect(res.status).toBe(422);
  });

  it("GET /api/cases/:caseId/document-instances returns 200 (array)", async () => {
    const res = await request(app)
      .get("/api/cases/1/document-instances")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("POST /api/cases/:caseId/documents/batch-export returns 422 for empty documentIds", async () => {
    const res = await request(app)
      .post("/api/cases/1/documents/batch-export")
      .set("Authorization", `Bearer ${token}`)
      .send({ documentIds: [] });

    expect(res.status).toBe(422);
  });

  it("GET /api/document-batch-jobs/:jobId returns 400 for invalid uuid", async () => {
    const res = await request(app)
      .get("/api/document-batch-jobs/not-a-uuid")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
  });
});

