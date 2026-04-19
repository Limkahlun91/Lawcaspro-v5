import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Application } from "express";

vi.mock("@workspace/db", async (orig) => {
  const actual = await orig<typeof import("@workspace/db")>();

  const client = {
    query: async (q: string) => {
      if (q.includes("select id, email, user_type, status from users")) {
        return {
          rows: [
            { id: 1, email: "lun.6923@hotmail.com", user_type: "founder", status: "active" },
            { id: 2, email: "old-founder@example.com", user_type: "founder", status: "inactive" },
          ],
        };
      }
      return { rows: [] };
    },
    release: () => undefined,
  };

  return {
    ...actual,
    pool: {
      ...actual.pool,
      connect: async () => client as unknown as Awaited<ReturnType<typeof actual.pool.connect>>,
    } as unknown as typeof actual.pool,
  };
});

let app: Application;

beforeAll(async () => {
  const mod = await import("../app");
  app = mod.default;
});

describe("Healthz founder status", () => {
  it("returns required founder-status fields", async () => {
    const res = await request(app).get("/api/healthz/founder-status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      expectedFounderEmail: "lun.6923@hotmail.com",
      expectedExists: true,
      founderCount: 2,
      activeFounderCount: 1,
    });
  });
});
