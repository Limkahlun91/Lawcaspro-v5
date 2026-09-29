import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Application } from "express";
import bcrypt from "bcryptjs";
import { usersTable, sessionsTable } from "@workspace/db";

function extractAuthTokenFromSetCookie(setCookie: string[] | string | undefined): string {
  const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const entry = list.find((s) => typeof s === "string" && s.startsWith("auth_token="));
  if (!entry) return "";
  const raw = entry.slice("auth_token=".length).split(";")[0] ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

type MockDb = {
  execute: (query?: unknown) => Promise<unknown[]>;
  select: (sel?: unknown) => { from: (table: unknown) => { where: (cond?: unknown) => Promise<unknown[]> } };
  insert: (table: unknown) => { values: (values: unknown) => Promise<void> };
  update: (table: unknown) => { set: (values: unknown) => { where: (cond?: unknown) => Promise<void> } };
};

const state = {
  passwordHash: "",
};

vi.mock("@workspace/db", async (orig) => {
  const actual = await orig<typeof import("@workspace/db")>();

  const emptyRows = (): unknown[] => [];

  const dbMock: MockDb = {
    execute: async () => [{ reg: "public.audit_logs" }],
    select: () => ({
      from: (table: unknown) => ({
        where: async () => {
          if (table === actual.usersTable) {
            return [
              {
                id: 9001,
                firmId: null,
                email: "lun.6923@hotmail.com",
                name: "Founder",
                passwordHash: state.passwordHash,
                userType: "founder",
                roleId: null,
                status: "active",
                totpEnabled: false,
                totpSecret: null,
              },
            ];
          }
          return emptyRows();
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: unknown) => {
        if (table === actual.sessionsTable) {
          expect(values).toHaveProperty("tokenHash");
        }
      },
    }),
    update: () => ({
      set: () => ({
        where: async () => undefined,
      }),
    }),
  };

  return { ...actual, db: dbMock as unknown as typeof actual.db };
});

let app: Application;

beforeAll(async () => {
  state.passwordHash = await bcrypt.hash("CorrectPassword123!", 10);
  const mod = await import("../app");
  app = mod.default;
});

describe("Auth founder bcrypt regression", () => {
  it("founder user with bcrypt hash can login successfully", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "lun.6923@hotmail.com", password: "CorrectPassword123!" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const scHeader = (res.headers as Record<string, unknown>)["set-cookie"];
    const cookieToken = extractAuthTokenFromSetCookie(scHeader as string[] | string | undefined);
    expect(typeof cookieToken === "string" && cookieToken.length > 0).toBe(true);
    const sc = Array.isArray(scHeader) ? scHeader.join(";") : String(scHeader ?? "");
    expect(sc).toMatch(/auth_token=/);
  });
});

