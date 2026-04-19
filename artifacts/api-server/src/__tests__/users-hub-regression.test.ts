import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Application } from "express";

type FakeDb = {
  execute: (query?: unknown) => Promise<unknown>;
  select: (sel?: unknown) => {
    from: (table: unknown) => {
      where: (cond?: unknown) => unknown;
      orderBy: (...args: unknown[]) => unknown;
    };
  };
  insert: (table: unknown) => { values: (values: unknown) => { returning: () => Promise<unknown[]> } };
  update: (table: unknown) => { set: (values: unknown) => { where: (cond?: unknown) => Promise<void> } };
  transaction: <T>(fn: (tx: FakeDb) => Promise<T>) => Promise<T>;
};

let mode: "ok" | "missing_rls" = "ok";
var sharedDb: unknown;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function queryable(getRows: () => Promise<unknown[]>) {
  const q: any = {};
  q.then = (resolve: (v: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
    getRows().then(resolve, reject);
  q.orderBy = () => q;
  q.limit = (_n: number) => q;
  q.offset = async (_n: number) => await getRows();
  return q;
}

function makeDb(tables: {
  rolesTable: unknown;
  usersTable: unknown;
  systemFoldersTable: unknown;
  platformDocumentsTable: unknown;
  platformMessagesTable: unknown;
  platformMessageAttachmentsTable: unknown;
}): FakeDb {
  const empty = async (): Promise<unknown[]> => [];

  const db: FakeDb = {
    execute: async () => [],
    select: (sel?: unknown) => ({
      from: (table: unknown) => {
        const getRows = async (): Promise<unknown[]> => {
          if (table === tables.rolesTable) return [{ id: 7, name: "Clerk", firmId: 1, isSystemRole: true }];
          if (table === tables.usersTable) {
            const selectingPasswordHash = isRecord(sel) && "passwordHash" in sel;
            if (selectingPasswordHash) return [];
            return [];
          }
          if (table === tables.systemFoldersTable) return [];
          if (table === tables.platformDocumentsTable) return [];
          if (table === tables.platformMessagesTable) return [];
          if (table === tables.platformMessageAttachmentsTable) return [];
          return [];
        };

        const q = queryable(getRows);
        q.where = () => q;
        q.orderBy = () => q;
        q.limit = () => q;
        q.offset = async () => await getRows();
        return {
          where: () => q,
          orderBy: () => q,
        };
      },
    }),
    insert: (table: unknown) => ({
      values: (_values: unknown) => ({
        returning: async () => {
          if (table === tables.usersTable) {
            return [
              {
                id: 123,
                firmId: 1,
                email: "new@firm.com",
                name: "New User",
                roleId: 7,
                status: "active",
                lastLoginAt: null,
                createdAt: new Date(),
              },
            ];
          }
          return [];
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => undefined,
      }),
    }),
    transaction: async <T>(fn: (tx: FakeDb) => Promise<T>) => fn(db),
  };

  db.select = (sel?: unknown) => ({
    from: (table: unknown) => {
      const getRows = async (): Promise<unknown[]> => {
        if (table === tables.rolesTable) return [{ id: 7, name: "Clerk", firmId: 1, isSystemRole: true }];
        if (table === tables.usersTable) {
          const selectingEmailExists = isRecord(sel) && "id" in sel;
          if (selectingEmailExists) return [];
          return [
            {
              id: 123,
              firmId: 1,
              email: "new@firm.com",
              name: "New User",
              roleId: 7,
              department: null,
              status: "active",
            },
          ];
        }
        return [];
      };
      const q = queryable(getRows);
      q.where = () => q;
      q.orderBy = () => q;
      q.limit = () => q;
      q.offset = async () => await getRows();
      return {
        where: () => q,
        orderBy: () => q,
      };
    },
  });

  db.execute = async () => ({ rows: [] });
  db.transaction = async <T>(fn: (tx: FakeDb) => Promise<T>) => fn(db);

  return db;
}

vi.mock("@workspace/db", async (orig) => {
  const actual = await orig<typeof import("@workspace/db")>();
  const fakeDb = makeDb({
    rolesTable: actual.rolesTable,
    usersTable: actual.usersTable,
    systemFoldersTable: actual.systemFoldersTable,
    platformDocumentsTable: actual.platformDocumentsTable,
    platformMessagesTable: actual.platformMessagesTable,
    platformMessageAttachmentsTable: actual.platformMessageAttachmentsTable,
  });
  sharedDb = fakeDb;
  return { ...actual, db: fakeDb as unknown as typeof actual.db };
});

vi.mock("../lib/auth", async (orig) => {
  const actual = await orig<typeof import("../lib/auth")>();
  return {
    ...actual,
    requireAuth: (_req: any, _res: any, next: any) => next(),
    requireFirmUser: (req: any, _res: any, next: any) => {
      req.userId = 10;
      req.userType = "firm_user";
      req.firmId = 1;
      req.roleId = 7;
      if (mode === "ok") req.rlsDb = sharedDb;
      next();
    },
    requirePermission: () => (_req: any, _res: any, next: any) => next(),
    writeAuditLog: async () => undefined,
  };
});

let app: Application;

beforeAll(async () => {
  const mod = await import("../app");
  app = mod.default;
});

describe("Users + Hub regressions", () => {
  it("POST /api/users succeeds on valid input", async () => {
    mode = "ok";
    const res = await request(app).post("/api/users").send({
      email: "new@firm.com",
      name: "New User",
      password: "P@ssw0rd123!",
      roleId: 7,
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("email", "new@firm.com");
    expect(res.body).toHaveProperty("roleName");
  });

  it("GET /api/hub/documents returns 200 + [] on empty data", async () => {
    mode = "ok";
    const res = await request(app).get("/api/hub/documents");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
  });

  it("GET /api/hub/documents returns 503 when tenant context is missing (no 500)", async () => {
    mode = "missing_rls";
    const res = await request(app).get("/api/hub/documents");
    expect(res.status).toBe(503);
  });
});
