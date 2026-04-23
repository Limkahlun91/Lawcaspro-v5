import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import app from "../app";

let token: string;
let firmId: number;
let roleId: number;
const skipDb = process.env.VITEST_SKIP_DB === "1";

beforeAll(async () => {
  if (skipDb) return;
  const loginRes = await request(app)
    .post("/api/auth/login")
    .send({ email: "partner@test.com", password: "password123" });
  expect(loginRes.status).toBe(200);
  token = loginRes.body?.data?.token;
  expect(typeof token).toBe("string");

  const meRes = await request(app)
    .get("/api/auth/me")
    .set("Authorization", `Bearer ${token}`);
  expect(meRes.status).toBe(200);
  expect(meRes.body.ok).toBe(true);
  firmId = meRes.body?.data?.firmId;
  roleId = meRes.body?.data?.roleId;
  expect(typeof firmId).toBe("number");
  expect(typeof roleId).toBe("number");
});

const suite = skipDb ? describe.skip : describe;

suite("Users routes", () => {
  it("GET /api/users returns 200 for limit=50 and limit=200", async () => {
    const res50 = await request(app)
      .get("/api/users")
      .query({ page: 1, limit: 50 })
      .set("Authorization", `Bearer ${token}`);
    expect(res50.status).toBe(200);
    expect(Array.isArray(res50.body?.data)).toBe(true);

    const res200 = await request(app)
      .get("/api/users")
      .query({ page: 1, limit: 200 })
      .set("Authorization", `Bearer ${token}`);
    expect(res200.status).toBe(200);
    expect(Array.isArray(res200.body?.data)).toBe(true);
  });

  it("POST /api/users creates a user and it appears in list", async () => {
    const email = `vitest.user.${Date.now()}@test.com`;
    const createRes = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${token}`)
      .send({
        email,
        name: "Vitest User",
        password: "password123",
        roleId,
        department: "Litigation",
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body).toHaveProperty("id");
    expect(createRes.body.email).toBe(email.toLowerCase());
    expect(createRes.body.firmId).toBe(firmId);

    const listRes = await request(app)
      .get("/api/users")
      .query({ page: 1, limit: 200 })
      .set("Authorization", `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    const emails = (listRes.body?.data ?? []).map((u: { email: string }) => u.email);
    expect(emails).toContain(email.toLowerCase());
  });
});

