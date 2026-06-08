import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app";

describe("docx-pdf-worker", () => {
  it("healthz reports configured=false when token missing", async () => {
    delete process.env.DOCX_PDF_SERVICE_TOKEN;
    const app = createApp();
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: false,
      configured: false,
      checks: { tokenConfigured: false },
    });
  });

  it("convert requires bearer token", async () => {
    process.env.DOCX_PDF_SERVICE_TOKEN = "t";
    const app = createApp();
    const res = await request(app).post("/convert").send("x");
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "UNAUTHORIZED" });
  });
});

