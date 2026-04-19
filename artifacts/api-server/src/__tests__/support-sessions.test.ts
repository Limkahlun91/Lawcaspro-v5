import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../app";
import { db, auditLogsTable, supportSessionsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";

const FOUNDER_EMAIL = "lun.6923@hotmail.com";
const FOUNDER_PASSWORD = "founder123";

describe("Support sessions (founder)", () => {
  let founderToken: string;
  let targetFirmId: number;
  let createdSessionId: number;

  beforeAll(async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: FOUNDER_EMAIL, password: FOUNDER_PASSWORD });
    founderToken = res.body.token;

    const firmsRes = await request(app)
      .get("/api/platform/firms")
      .set("Authorization", `Bearer ${founderToken}`);
    targetFirmId = firmsRes.body.data?.[0]?.id;
  });

  afterAll(async () => {
    if (createdSessionId) {
      await db.delete(supportSessionsTable).where(eq(supportSessionsTable.id, createdSessionId));
    }
    if (founderToken) {
      await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${founderToken}`);
    }
  });

  it("returns 400 without required fields", async () => {
    const res = await request(app)
      .post("/api/support-sessions")
      .set("Authorization", `Bearer ${founderToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent firm", async () => {
    const res = await request(app)
      .post("/api/support-sessions")
      .set("Authorization", `Bearer ${founderToken}`)
      .send({ targetFirmId: 999999, reason: "Testing" });
    expect(res.status).toBe(404);
  });

  it("creates a support session successfully", async () => {
    expect(targetFirmId).toBeDefined();
    const res = await request(app)
      .post("/api/support-sessions")
      .set("Authorization", `Bearer ${founderToken}`)
      .send({ targetFirmId, reason: "Automated test — investigating billing issue" });

    expect(res.status).toBe(201);
    expect(res.body.data).toHaveProperty("id");
    expect(res.body.data.targetFirmId).toBe(targetFirmId);
    expect(res.body.data.endedAt).toBeNull();
    createdSessionId = res.body.data.id;
  });

  it("records audit log entry when support session is created", async () => {
    expect(createdSessionId).toBeDefined();
    const logs = await db
      .select()
      .from(auditLogsTable)
      .orderBy(desc(auditLogsTable.createdAt))
      .limit(10);

    const sessionLog = logs.find(l => l.action === "support_session.started");
    expect(sessionLog).toBeDefined();
    expect(sessionLog?.entityId).toBe(targetFirmId);
  });

  it("lists active support sessions", async () => {
    const res = await request(app)
      .get("/api/support-sessions/active")
      .set("Authorization", `Bearer ${founderToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
    const found = res.body.data.find((s: any) => s.id === createdSessionId);
    expect(found).toBeDefined();
  });

  it("ends a support session and records audit log", async () => {
    expect(createdSessionId).toBeDefined();
    const res = await request(app)
      .patch(`/api/support-sessions/${createdSessionId}/end`)
      .set("Authorization", `Bearer ${founderToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.endedAt).not.toBeNull();

    const logs = await db
      .select()
      .from(auditLogsTable)
      .orderBy(desc(auditLogsTable.createdAt))
      .limit(5);
    const endLog = logs.find(l => l.action === "support_session.ended");
    expect(endLog).toBeDefined();
  });

  it("returns 400 when ending an already-ended session", async () => {
    expect(createdSessionId).toBeDefined();
    const res = await request(app)
      .patch(`/api/support-sessions/${createdSessionId}/end`)
      .set("Authorization", `Bearer ${founderToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("already ended");
  });
});
