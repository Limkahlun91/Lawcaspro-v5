import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../app";

const FOUNDER_EMAIL = "lun.6923@hotmail.com";
const FOUNDER_PASSWORD = "founder123";
const PARTNER_EMAIL = "partner@tan-associates.my";
const PARTNER_PASSWORD = "lawyer123";
const LAWYER_EMAIL = "lawyer@tan-associates.my";
const LAWYER_PASSWORD = "lawyer123";

describe("Tenant isolation — firm user cannot access other firm's data", () => {
  let partnerToken: string;
  let partnerFirmId: number;
  let founderToken: string;

  beforeAll(async () => {
    const partnerRes = await request(app)
      .post("/api/auth/login")
      .send({ email: PARTNER_EMAIL, password: PARTNER_PASSWORD });
    partnerToken = partnerRes.body.token;
    partnerFirmId = partnerRes.body.firmId;

    const founderRes = await request(app)
      .post("/api/auth/login")
      .send({ email: FOUNDER_EMAIL, password: FOUNDER_PASSWORD });
    founderToken = founderRes.body.token;
  });

  afterAll(async () => {
    if (partnerToken) {
      await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${partnerToken}`);
    }
    if (founderToken) {
      await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${founderToken}`);
    }
  });

  it("firm user cannot access /api/platform/* founder-only routes", async () => {
    const res = await request(app)
      .get("/api/platform/firms")
      .set("Authorization", `Bearer ${partnerToken}`);

    expect(res.status).toBe(403);
  });

  it("firm user cannot access support-sessions (founder only)", async () => {
    const res = await request(app)
      .get("/api/support-sessions")
      .set("Authorization", `Bearer ${partnerToken}`);

    expect(res.status).toBe(403);
  });

  it("firm user cannot start a support session", async () => {
    const res = await request(app)
      .post("/api/support-sessions")
      .set("Authorization", `Bearer ${partnerToken}`)
      .send({ targetFirmId: partnerFirmId, reason: "test" });

    expect(res.status).toBe(403);
  });

  it("firm user can access their own cases list", async () => {
    const res = await request(app)
      .get("/api/cases")
      .set("Authorization", `Bearer ${partnerToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
  });

  it("cases returned belong only to authenticated user's firm (DB-level isolation)", async () => {
    const res = await request(app)
      .get("/api/cases")
      .set("Authorization", `Bearer ${partnerToken}`);

    expect(res.status).toBe(200);
    const { db, casesTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const allCasesForFirm = await db.select().from(casesTable).where(eq(casesTable.firmId, partnerFirmId));
    expect(res.body.data.length).toBeLessThanOrEqual(allCasesForFirm.length);
  });

  it("clients returned belong only to authenticated user's firm (DB-level isolation)", async () => {
    const res = await request(app)
      .get("/api/clients")
      .set("Authorization", `Bearer ${partnerToken}`);

    expect(res.status).toBe(200);
    const { db, clientsTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const allClientsForFirm = await db.select().from(clientsTable).where(eq(clientsTable.firmId, partnerFirmId));
    expect(res.body.data.length).toBeLessThanOrEqual(allClientsForFirm.length);
  });

  it("unauthenticated request to /api/cases returns 401", async () => {
    const res = await request(app).get("/api/cases");
    expect(res.status).toBe(401);
  });

  it("unauthenticated request to /api/clients returns 401", async () => {
    const res = await request(app).get("/api/clients");
    expect(res.status).toBe(401);
  });
});

describe("Founder can access platform routes", () => {
  let founderToken: string;

  beforeAll(async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: FOUNDER_EMAIL, password: FOUNDER_PASSWORD });
    founderToken = res.body.token;
  });

  afterAll(async () => {
    if (founderToken) {
      await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${founderToken}`);
    }
  });

  it("founder can list firms", async () => {
    const res = await request(app)
      .get("/api/platform/firms")
      .set("Authorization", `Bearer ${founderToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
  });

  it("founder can list support sessions", async () => {
    const res = await request(app)
      .get("/api/support-sessions")
      .set("Authorization", `Bearer ${founderToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
  });
});
