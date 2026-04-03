import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../app";

const FOUNDER_EMAIL = "founder@lawcaspro.com";
const FOUNDER_PASSWORD = "founder123";
const LAWYER_EMAIL = "lawyer@tan-associates.my";
const LAWYER_PASSWORD = "lawyer123";

describe("POST /api/auth/login", () => {
  it("returns 200 and token on valid credentials", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: FOUNDER_EMAIL, password: FOUNDER_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("token");
    expect(res.body.email).toBe(FOUNDER_EMAIL);
    expect(res.body.userType).toBe("founder");
    expect(res.body).toHaveProperty("totpEnabled");
    expect(res.headers["set-cookie"]).toBeDefined();
  });

  it("returns 401 on wrong password", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: FOUNDER_EMAIL, password: "wrongpassword" });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 401 on non-existent email", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "nonexistent@test.com", password: "anypassword" });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 401 on invalid email format (treated as non-existent user)", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "notanemail", password: "password" });

    expect(res.status).toBe(401);
  });
});

describe("POST /api/auth/logout", () => {
  it("clears session on logout", async () => {
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: LAWYER_EMAIL, password: LAWYER_PASSWORD });
    expect(loginRes.status).toBe(200);
    const token = loginRes.body.token;

    const logoutRes = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${token}`);
    expect(logoutRes.status).toBe(200);

    const meRes = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);
    expect(meRes.status).toBe(401);
  });
});

describe("GET /api/auth/me", () => {
  it("returns 401 without auth token", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("returns 401 with invalid token", async () => {
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", "Bearer invalidtoken123");
    expect(res.status).toBe(401);
  });

  it("returns user data with valid token", async () => {
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: FOUNDER_EMAIL, password: FOUNDER_PASSWORD });
    const token = loginRes.body.token;

    const meRes = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.email).toBe(FOUNDER_EMAIL);
    expect(meRes.body).not.toHaveProperty("passwordHash");
  });
});

describe("GET /api/auth/sessions", () => {
  it("returns active sessions for authenticated user", async () => {
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: LAWYER_EMAIL, password: LAWYER_PASSWORD });
    const token = loginRes.body.token;

    const sessionsRes = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", `Bearer ${token}`);
    expect(sessionsRes.status).toBe(200);
    expect(sessionsRes.body).toHaveProperty("data");
    expect(Array.isArray(sessionsRes.body.data)).toBe(true);

    await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${token}`);
  });
});

describe("Audit log creation on auth events", () => {
  it("records login_success in audit_logs after successful login", async () => {
    const { db, auditLogsTable } = await import("@workspace/db");
    const { desc } = await import("drizzle-orm");

    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: FOUNDER_EMAIL, password: FOUNDER_PASSWORD });
    expect(loginRes.status).toBe(200);

    const logs = await db
      .select()
      .from(auditLogsTable)
      .orderBy(desc(auditLogsTable.createdAt))
      .limit(5);

    const loginLog = logs.find(l => l.action === "auth.login_success");
    expect(loginLog).toBeDefined();

    await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${loginRes.body.token}`);
  });
});

describe("TOTP endpoints", () => {
  let lawyerToken: string;

  beforeAll(async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: LAWYER_EMAIL, password: LAWYER_PASSWORD });
    lawyerToken = res.body.token;
  });

  afterAll(async () => {
    if (lawyerToken) {
      await request(app)
        .post("/api/auth/logout")
        .set("Authorization", `Bearer ${lawyerToken}`);
    }
  });

  it("returns 401 on POST /auth/totp/setup without auth", async () => {
    const res = await request(app).post("/api/auth/totp/setup");
    expect(res.status).toBe(401);
  });

  it("returns qr code data on POST /auth/totp/setup with auth", async () => {
    const res = await request(app)
      .post("/api/auth/totp/setup")
      .set("Authorization", `Bearer ${lawyerToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("secret");
    expect(res.body).toHaveProperty("qrCodeDataUrl");
    expect(res.body.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(res.body).toHaveProperty("otpAuthUrl");
    expect(res.body.otpAuthUrl).toMatch(/^otpauth:\/\/totp\//);
  });

  it("returns 400 on confirm with wrong code", async () => {
    const res = await request(app)
      .post("/api/auth/totp/confirm")
      .set("Authorization", `Bearer ${lawyerToken}`)
      .send({ code: "000000" });

    expect(res.status).toBe(400);
  });

  it("returns 400 on disable when TOTP not enabled (with reauth token)", async () => {
    // requireReAuth is mounted on this route, so x-reauth-token is required
    // before the TOTP-enabled check can run.
    const res = await request(app)
      .post("/api/auth/totp/disable")
      .set("Authorization", `Bearer ${lawyerToken}`)
      .set("x-reauth-token", lawyerToken)
      .send({ code: "000000" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not enabled");
  });
});
