import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import type { Application } from "express";

let app: Application;

beforeAll(async () => {
  const mod = await import("../app");
  app = mod.default;
});

describe("Healthz docx-pdf", () => {
  it("returns configured=false when engine disabled", async () => {
    process.env.DOCX_TO_PDF_ENGINE = "disabled";
    delete process.env.GOTENBERG_URL;
    delete process.env.DOCX_CONVERTER_URL;
    const res = await request(app).get("/api/healthz/docx-pdf");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: false,
      engine: "disabled",
      configured: false,
      error: "DOCX_TO_PDF_ENGINE_NOT_CONFIGURED",
    });
  });

  it("returns configured=true when gotenberg url is present", async () => {
    process.env.DOCX_TO_PDF_ENGINE = "gotenberg";
    process.env.GOTENBERG_URL = "https://gotenberg.example";
    const res = await request(app).get("/api/healthz/docx-pdf");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, engine: "gotenberg", configured: true });
  });
});

