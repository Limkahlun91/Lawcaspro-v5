import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import app from "../app";

let token: string;
const skipDb = process.env.VITEST_SKIP_DB === "1";

beforeAll(async () => {
  if (skipDb) return;
  const res = await request(app)
    .post("/api/auth/login")
    .send({ email: "partner@test.com", password: "password123" });
  expect(res.status).toBe(200);
  token = res.body?.data?.token;
  expect(typeof token).toBe("string");
});

describe("Runtime 500 regressions (no-db)", () => {
  it("auth/me unauthenticated returns 200 or 401 (not 500)", async () => {
    const res = await request(app).get("/api/auth/me");
    expect([200, 401]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body?.ok).toBe(true);
      expect(res.body?.data).toBeNull();
    }
    if (res.status === 401) {
      expect(res.body?.ok).toBe(false);
      expect(res.body?.error?.message).toBeTruthy();
      expect(res.body).not.toHaveProperty("detail");
      expect(res.body).not.toHaveProperty("stack");
      expect(res.body).not.toHaveProperty("sql");
    }
  });

  it("users create unauthenticated returns 401 (not 500)", async () => {
    const res = await request(app).post("/api/users").send({ email: "x@test.com" });
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error");
    expect(res.body).not.toHaveProperty("detail");
    expect(res.body).not.toHaveProperty("stack");
    expect(res.body).not.toHaveProperty("sql");
  });

  it("hub/documents unauthenticated returns 401 (not 500)", async () => {
    const res = await request(app).get("/api/hub/documents");
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error");
    expect(res.body).not.toHaveProperty("detail");
    expect(res.body).not.toHaveProperty("stack");
    expect(res.body).not.toHaveProperty("sql");
  });

  it("auth/login invalid body returns 400 (not 500)", async () => {
    const res = await request(app).post("/api/auth/login").send({});
    expect(res.status).toBe(400);
    expect(res.body?.ok).toBe(false);
    expect(res.body?.error?.message).toBeTruthy();
    expect(res.body).not.toHaveProperty("detail");
    expect(res.body).not.toHaveProperty("stack");
    expect(res.body).not.toHaveProperty("sql");
  });
});

const suite = skipDb ? describe.skip : describe;

suite("Runtime 500 regressions (with-db)", () => {
  it("dashboard does not 500 for valid auth", async () => {
    const res = await request(app)
      .get("/api/dashboard")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(200);
  });

  it("cases list does not 500 with milestone + overdue filters", async () => {
    const res = await request(app)
      .get("/api/cases")
      .query({
        page: 1,
        limit: 50,
        sortBy: "updatedAt",
        sortDir: "desc",
        milestone: "loan_docs_signed_date",
        milestonePresence: "missing",
        overdueDays: 7,
      })
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(200);
  });

  it("cases workbench does not 500 for valid auth", async () => {
    const res = await request(app)
      .get("/api/cases/workbench")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(200);
  });
});
