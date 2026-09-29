import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { usersTable, sessionsTable, rolesTable, firmsTable, permissionsTable } from "@workspace/db";
import type { Application } from "express";
import crypto from "crypto";

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

function hashToken(plain: string): string {
  return crypto.createHash("sha256").update(plain).digest("hex");
}

type MockDb = {
  execute: (query?: unknown) => Promise<unknown[]>;
  select: (sel?: unknown) => { from: (table: unknown) => { where: (cond?: unknown) => Promise<unknown[]> } };
  insert: (table: unknown) => { values: (values: unknown) => Promise<void> };
  update: (table: unknown) => { set: (values: unknown) => { where: (cond?: unknown) => Promise<void> } };
};

type AuthDbState = {
  usersByEmail: Map<string, unknown>;
  usersById: Map<number, unknown>;
  sessionsByTokenHash: Map<string, unknown>;
  rolesById: Map<number, unknown>;
  firmsById: Map<number, unknown>;
  throwPermissionsSelect: boolean;
  throwSessionSelectTransient: boolean;
  sessionSelectEmptyOnce: boolean;
  sessionSelectCalls: number;
  sessionSelectDelayMs: number;
  throwUndefinedColumnOnUserLookup: boolean;
  throwSideEffects: boolean;
};

const state: AuthDbState = {
  usersByEmail: new Map(),
  usersById: new Map(),
  sessionsByTokenHash: new Map(),
  rolesById: new Map(),
  firmsById: new Map(),
  throwPermissionsSelect: false,
  throwSessionSelectTransient: false,
  sessionSelectEmptyOnce: false,
  sessionSelectCalls: 0,
  sessionSelectDelayMs: 0,
  throwUndefinedColumnOnUserLookup: false,
  throwSideEffects: false,
};

vi.mock("bcryptjs", () => ({
  default: {
    compare: async (plain: string, hash: string) => plain === "goodpw" && hash === "hash",
    hash: async () => "hash",
  },
  compare: async (plain: string, hash: string) => plain === "goodpw" && hash === "hash",
  hash: async () => "hash",
}));

vi.mock("@workspace/db", async (orig) => {
  const actual = await orig<typeof import("@workspace/db")>();

  const emptyRows = (): unknown[] => [];
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

  const mockDb: MockDb = {
    execute: async () => [{ reg: "public.audit_logs" }],
    select: (sel?: unknown) => ({
      from: (table: unknown) => ({
        where: async () => {
          if (table === actual.sessionsTable) {
            if (state.throwSessionSelectTransient) {
              const e = new Error("connect timeout") as Error & { code?: string };
              e.code = "ETIMEDOUT";
              throw e;
            }
            if (state.sessionSelectDelayMs > 0) {
              await new Promise<void>((r) => setTimeout(r, state.sessionSelectDelayMs));
            }
            state.sessionSelectCalls += 1;
            if (state.sessionSelectEmptyOnce && state.sessionSelectCalls === 1) return emptyRows();
            const s = Array.from(state.sessionsByTokenHash.values())[0] ?? null;
            return s ? [s] : emptyRows();
          }
          if (table === actual.usersTable) {
            const wantsTotp = isRecord(sel) && ("totpSecret" in sel || "totpEnabled" in sel);
            const hasPasswordHash = isRecord(sel) && "passwordHash" in sel;
            if (wantsTotp && state.throwUndefinedColumnOnUserLookup) {
              const e = new Error('column "totp_secret" does not exist') as Error & { code?: string };
              e.code = "42703";
              throw e;
            }
            if (hasPasswordHash) {
              const u = Array.from(state.usersByEmail.values())[0] ?? null;
              return u ? [u] : emptyRows();
            }
            const u = Array.from(state.usersById.values())[0] ?? null;
            return u ? [u] : emptyRows();
          }
          if (table === actual.rolesTable) {
            const r = Array.from(state.rolesById.values())[0] ?? null;
            return r ? [r] : emptyRows();
          }
          if (table === actual.firmsTable) {
            const f = Array.from(state.firmsById.values())[0] ?? null;
            return f ? [f] : emptyRows();
          }
          if (table === actual.permissionsTable) {
            if (state.throwPermissionsSelect) throw new Error("permissions query failed");
            return [{ module: "cases", action: "read" }];
          }
          return emptyRows();
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: unknown) => {
        if (table === actual.sessionsTable) {
          const v = values as { tokenHash: string; userId: number; expiresAt: Date };
          state.sessionsByTokenHash.set(String(v.tokenHash), {
            userId: v.userId,
            expiresAt: v.expiresAt,
          });
        }
        return undefined;
      },
    }),
    update: () => ({
      set: () => ({
        where: async () => {
          if (state.throwSideEffects) throw new Error("side effects failed");
          return undefined;
        },
      }),
    }),
  };

  const findSessionByTokenHashFromState = (tokenHash: string): unknown | null => {
    return state.sessionsByTokenHash.get(String(tokenHash)) ?? null;
  };
  const findUserByIdFromState = (id: number): unknown | null => {
    return state.usersById.get(id) ?? null;
  };
  const findRoleByIdFromState = (rid: number): unknown | null => {
    return state.rolesById.get(rid) ?? null;
  };

  // ---- Diagnostics: instrument method access on client object ----
  const __clientAccessDiag = globalThis as unknown as { __clientAccessDiag?: Array<{ key: string; type: string; argShape?: string }> };
  if (!__clientAccessDiag.__clientAccessDiag) __clientAccessDiag.__clientAccessDiag = [];
  const DIAG = (key: string, type: string, argShape?: string) => {
    if ((process.env as Record<string, string>).DEBUG_MOCK_QUERY !== "1") return;
    if (["SET", "BEGIN", "COMMIT", "ROLLBACK", "PG_ROLES", "PG_BACKEND"].some(
      (k) => key.startsWith(k) || argShape?.includes(k.toLowerCase()),
    )) return;
    if (__clientAccessDiag.__clientAccessDiag!.length < 20) {
      __clientAccessDiag.__clientAccessDiag!.push({ key, type, argShape: (argShape ?? "").slice(0, 80) });
      // eslint-disable-next-line no-console
      console.log("[CLIENT-ACCESS]", key, type, (argShape ?? "").slice(0, 80));
    }
  };

  const buildMockClient = () => {
    // Base implementation object — Proxy wraps this below to detect
    // which exact method names / properties drizzle reads during execution
    // (drizzle-orm/pg driver may duck-type: if client.query exists it goes one way,
    // if it looks like pg.Pool/PoolClient with specific methods it goes another).
    const baseClient = {
      query: async (arg1?: unknown, arg2?: unknown[]) => {
        DIAG("query", "call", typeof arg1 === "string" ? `STR[${arg1.length}]`
          : arg1 && typeof arg1 === "object" && !Array.isArray(arg1)
            ? `OBJ{${Object.keys(arg1 as Record<string, unknown>).sort().join(",")}}`
            : typeof arg1);
        // Debug: capture drizzle makeRlsDb arg shapes; bounded output only
        const shape = (() => {
          const t1 = typeof arg1;
          if (t1 === "object" && arg1 !== null && !Array.isArray(arg1)) {
            const keys = Object.keys(arg1 as Record<string, unknown>).sort().join(",");
            return `OBJ{${keys}} len=${String(arg1).length}`;
          }
          if (t1 === "string") return `STR len=${(arg1 as string).length}`;
          return `${t1}`;
        })();
        // Use post-normalization sqlText for classification since drizzle OBJ form
        // stores prepared-statement NAME as alphabetically-first key (Object.values[0])
        // not the SQL itself, so probe-from-first-value silently hid all drizzle SELECTs.
        let sqlText: string = "";
        let params: unknown[] = [];
        let drizzleRowMode: string | undefined;
        let drizzleTypesLength = 0;
        if (arg1 && typeof arg1 === "object" && !Array.isArray(arg1)) {
          const o = arg1 as Record<string, unknown>;
          const maybeSql = o.text ?? o.sql ?? o.query ?? o.statement ?? "";
          sqlText = String(maybeSql ?? "");
          if (typeof (o as any).rowMode === "string") drizzleRowMode = (o as any).rowMode;
          if (Array.isArray((o as any).types)) drizzleTypesLength = (o as any).types.length;
          if (Array.isArray(arg2) && arg2.length > 0) {
            params = arg2;
          } else {
            const oParams = o.values ?? o.params ?? o.bindings ?? o.arguments;
            params = Array.isArray(oParams) ? oParams : Array.isArray(arg2) ? arg2 : [];
          }
        } else {
          sqlText = String(arg1 ?? "");
          params = Array.isArray(arg2) ? arg2 : [];
        }
        const probe = sqlText.toLowerCase().trim();
        const isInteresting = probe.includes("session") || probe.includes("\"users\"") || probe.includes("\"roles\"")
          || probe.includes(" from users") || probe.includes(" from sessions") || probe.includes(" from roles")
          || probe.includes("permission");
        if (isInteresting && (process.env as Record<string, string>).DEBUG_MOCK_QUERY === "1") {
          // eslint-disable-next-line no-console
          console.log("[DRIZZLE-QUERY-META]", "rowMode=", drizzleRowMode, "typesLen=", drizzleTypesLength);
          // eslint-disable-next-line no-console
          console.log("[MOCK-QUERY]", shape, probe.slice(0, 180), "params:",
            params.map((p) => typeof p === "string" ? `str[${p.length}]=${p.slice(0, 16)}` : typeof p === "number" ? p : String(p)));
        }
        const s = probe;
        if (s.startsWith("begin") || s.startsWith("commit")) return { rows: [], rowCount: 0 };
        if (s.startsWith("rollback")) return { rows: [], rowCount: 0 };
        // RLS configs (no-op for mock)
        if (s.startsWith("set")) return { rows: [], rowCount: 0 };
        if (s.startsWith("select pg_backend_pid()")) return { rows: [{ pg_backend_pid: 1 }], rowCount: 1 };
        // Try to match tokenHash from sessions: find sessions with WHERE token_hash = $1
        // Match users by id
        if (state.throwSessionSelectTransient) {
          const e = new Error("connect timeout") as Error & { code?: string };
          e.code = "ETIMEDOUT";
          throw e;
        }
        if (state.sessionSelectDelayMs > 0) {
          await new Promise<void>((r) => setTimeout(r, state.sessionSelectDelayMs));
        }
        // Drizzle generates double-quoted identifiers (e.g. from "sessions"), so match
        // by raw table-name substring (no "from X" spacing assumptions) — avoids false
        // negatives on dialect-specific formatting. Match order matters: each branch is
        // mutually exclusive for queries with a single primary table; JOIN queries are
        // handled in the first-matching branch (users+roles → users handler with enrich).
        const isSessionSelect = s.includes("sessions");
        if (isSessionSelect) {
          state.sessionSelectCalls += 1;
          if (state.sessionSelectEmptyOnce && state.sessionSelectCalls === 1) {
            if ((process.env as Record<string, string>).DEBUG_MOCK_QUERY === "1")
              // eslint-disable-next-line no-console
              console.log("[SESS]", "emptyOnce call#=", state.sessionSelectCalls, "→ return []");
            return { rows: [], rowCount: 0 };
          }
          // Drizzle applies column-name mapping internally: schema declares `userId: integer("user_id")`,
          // so drizzle reads raw driver result `{user_id: N, token_hash: H, expires_at: D, ...}` and
          // maps to `{userId, tokenHash, expiresAt, ...}`. State stores camelCase → convert to
          // snake_case keys here so drizzle's schema mapper recognizes each column.
          const allKeys = Array.from(state.sessionsByTokenHash.keys());
          let matchedSess: Record<string, unknown> | null = null;
          for (const p of params) {
            const hash = String(p);
            const sess = findSessionByTokenHashFromState(hash);
            if ((process.env as Record<string, string>).DEBUG_MOCK_QUERY === "1")
              // eslint-disable-next-line no-console
              console.log("[SESS]", "param hash=", hash.slice(0, 16) + "…", "state-hash-match?", !!sess,
                "state-keys-sample:", allKeys.slice(0, 3).map((k) => k.slice(0, 10) + "…"));
            if (sess) { matchedSess = sess as Record<string, unknown>; break; }
          }
          if (!matchedSess) {
            const first = Array.from(state.sessionsByTokenHash.values())[0] ?? null;
            matchedSess = first ? (first as Record<string, unknown>) : null;
          }
          if (!matchedSess) return { rows: [], rowCount: 0 };
          // The drizzle test branch uses `.select()` with NO projection (all columns).
          // Drizzle-orm/pg applies column-name mapping differently based on projection presence:
          //   • Explicit projection dict → use dict keys as result property names.
          //   • No projection → map each column's DB column name via its declared JS property.
          //
          // SAFEST COMPATIBILITY: return a proxy-friendly row with BOTH camelCase AND
          // snake_case copies of every logical property; also fill in defaults for every
          // column the drizzle sessions SELECT explicitly lists so drizzle never sees
          // `undefined` for a named column in the SELECT list.
          const camelSess = { ...matchedSess } as Record<string, unknown>;
          // Defaults for ALL 10 columns in the drizzle sessions SELECT ordered list.
          if (!("id" in camelSess) || camelSess.id === undefined || camelSess.id === null)
            camelSess.id = Number(camelSess.userId ?? 1);
          if (!("tokenHash" in camelSess)) camelSess.tokenHash = params[0] ?? "stub_hash";
          if (!("createdAt" in camelSess)) camelSess.createdAt = new Date();
          if (!("userAgent" in camelSess)) camelSess.userAgent = null;
          if (!("ipAddress" in camelSess)) camelSess.ipAddress = null;
          if (!("firmId" in camelSess)) camelSess.firmId = (camelSess as any).firm_id ?? null;
          if (!("roleId" in camelSess)) camelSess.roleId = (camelSess as any).role_id ?? null;
          if (!("userType" in camelSess)) camelSess.userType = (camelSess as any).user_type ?? "firm_user";
          const arrayRow = [
            camelSess.id,
            camelSess.userId,
            camelSess.tokenHash,
            camelSess.expiresAt,
            camelSess.userAgent,
            camelSess.ipAddress,
            camelSess.firmId,
            camelSess.roleId,
            camelSess.userType,
            camelSess.createdAt,
          ];
          const dualSess: Record<string, unknown> = { ...camelSess };
          for (const [k, v] of Object.entries(camelSess)) {
            const snake = k.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
            dualSess[snake] = v;
          }
          const rows = drizzleRowMode === "array" ? [arrayRow] : [dualSess];
          if ((process.env as Record<string, string>).DEBUG_MOCK_QUERY === "1")
            // eslint-disable-next-line no-console
            console.log("[SESS]", "mode=", drizzleRowMode, "arrayRow[1](userId)=", arrayRow[1]);
          return { rows, rowCount: 1 };
        }
        const isUserSelect = s.includes("users");
        const hasRolesJoin = isUserSelect && s.includes("roles");
        if (isUserSelect) {
          if ((process.env as Record<string, string>).DEBUG_MOCK_QUERY === "1")
            // eslint-disable-next-line no-console
            console.log("[USERS]", "params raw:", params.map((p, i) => `$${i + 1}=${typeof p}:${String(p).slice(0, 30)}`).join(" | "),
              "hasRolesJoin=", hasRolesJoin);
          let foundUser: Record<string, unknown> | null = null;
          for (const p of params) {
            if (typeof p === "number") {
              const u = findUserByIdFromState(p);
              if (u) { foundUser = u as Record<string, unknown>; break; }
            }
            if (typeof p === "string") {
              const firstEmailEntry = Array.from(state.usersByEmail.values())[0] ?? null;
              if (firstEmailEntry) { foundUser = firstEmailEntry as Record<string, unknown>; break; }
            }
          }
          if (!foundUser) {
            const u = Array.from(state.usersById.values())[0] ?? null;
            foundUser = u ? (u as Record<string, unknown>) : null;
          }
          if (!foundUser) return { rows: [], rowCount: 0 };
          const camelUser = { ...foundUser } as Record<string, unknown>;
          if (!("developerId" in camelUser) || camelUser.developerId === undefined) camelUser.developerId = null;
          let roleNameVal: unknown = null;
          const roleIdVal = Number(camelUser.roleId ?? 0);
          if (Number.isFinite(roleIdVal) && roleIdVal > 0) {
            const role = findRoleByIdFromState(roleIdVal);
            if (role && typeof role === "object") {
              const rn = (role as Record<string, unknown>).name;
              if (typeof rn === "string") roleNameVal = rn;
            }
          }
          if (!hasRolesJoin) {
            const rawDual: Record<string, unknown> = { ...camelUser };
            for (const [k, v] of Object.entries(camelUser)) {
              const snake = k.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
              rawDual[snake] = v;
            }
            if (drizzleRowMode === "array") {
              // Non-JOIN drizzle .select() uses schema-declared column order which is
              // potentially variable; safest is to return object rows (dual-format) for
              // non-projection selects since drizzle maps by column name. But if mode is
              // array we must return array; approximate order based on common schema cols.
              const guessedArr = [
                camelUser.id, camelUser.email, camelUser.name, camelUser.status,
                camelUser.passwordHash ?? null, camelUser.userType, camelUser.firmId,
                camelUser.roleId, camelUser.developerId, camelUser.department ?? null,
                camelUser.failedLoginCount ?? 0, camelUser.lockedUntil ?? null,
                camelUser.createdAt ?? new Date(), camelUser.updatedAt ?? new Date(),
              ];
              return { rows: [guessedArr], rowCount: 1 };
            }
            return { rows: [rawDual], rowCount: 1 };
          }
          const arrayRow = [
            camelUser.id,
            camelUser.email,
            camelUser.name,
            camelUser.userType,
            camelUser.firmId,
            camelUser.roleId,
            roleNameVal,
            camelUser.developerId,
            camelUser.status,
          ];
          const objRow: Record<string, unknown> = {
            id: camelUser.id,
            email: camelUser.email,
            name: camelUser.name,
            userType: camelUser.userType,
            firmId: camelUser.firmId,
            roleId: camelUser.roleId,
            roleName: roleNameVal,
            developerId: camelUser.developerId,
            status: camelUser.status,
          };
          const rows = drizzleRowMode === "array" ? [arrayRow] : [objRow];
          if ((process.env as Record<string, string>).DEBUG_MOCK_QUERY === "1")
            // eslint-disable-next-line no-console
            console.log("[USERS-JOIN]", "mode=", drizzleRowMode, "arrayRow=",
              `[0]id=${arrayRow[0]} [2]userName=${String(arrayRow[2]).slice(0, 10)} [6]roleName=${String(arrayRow[6])} [8]status=${arrayRow[8]}`);
          return { rows, rowCount: 1 };
        }
        const isRoleSelect = s.includes("roles");
        if (isRoleSelect) {
          for (const p of params) {
            if (typeof p === "number") {
              const r = findRoleByIdFromState(p);
              if (r) return { rows: [r as Record<string, unknown>], rowCount: 1 };
            }
          }
          const r = Array.from(state.rolesById.values())[0] ?? null;
          return { rows: r ? [r as Record<string, unknown>] : [], rowCount: r ? 1 : 0 };
        }
        const isPermSelect = s.includes("permissions");
        if (isPermSelect) {
          if (state.throwPermissionsSelect) throw new Error("permissions query failed");
          const arr = drizzleRowMode === "array"
            ? [["dashboard", "read", true]]
            : [{ module: "dashboard", action: "read", allowed: true }];
          return { rows: arr, rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
      // pg.PoolClient / Client simulation — additional methods & properties drizzle may
      // duck-type against. Drizzle-orm/pg detects connection type via these markers.
      connect: async () => {},
      end: async () => {},
      _connected: true,
      _ending: false,
    };
    // Wrap baseClient with Proxy so any drizzle access to unknown methods/properties
    // (e.g. driver-specific names or callback-based query variants) is logged so
    // we can detect the actual call path used.
    const proxyClient = new Proxy(baseClient as Record<string, unknown>, {
      get(target, prop, receiver) {
        const key = String(prop);
        const existing = Reflect.get(target, prop, receiver);
        if (existing !== undefined) return existing;
        // Only log non-trivial props; filter out Symbol/node internals
        if (!key.startsWith("_") && typeof prop === "string"
            && ["Symbol", "constructor", "valueOf", "toString", "toJSON", "then"].every((k) => !key.includes(k))) {
          DIAG(key, "get_missing", "(added noop stub)");
        }
        // Synthesize reasonable fallbacks for common pg internals:
        if (key === "queryCallback" || key === "native") return undefined;
        if (key === "copyFrom" || key === "copyTo") return () => Promise.resolve();
        if (key === "escape" || key === "escapeIdentifier" || key === "escapeLiteral") return (s: string) => s;
        if (key === "on" || key === "once" || key === "off" || key === "removeListener" || key === "addListener") return () => proxyClient;
        if (key === "emit") return () => true;
        return undefined;
      },
    });
    return proxyClient as unknown as ReturnType<typeof buildMockClient> extends infer _R ? any : any;
  };

  return {
    ...actual,
    db: mockDb as unknown as typeof actual.db,
    pool: {
      ...actual.pool,
      connect: async () => buildMockClient(),
      query: async () => {
        throw new Error("pool.query should not be used in these tests");
      },
    } as unknown as typeof actual.pool,
  };
});

beforeEach(async () => {
  const { __clearAuthCachesForTests } = await import("../lib/auth.js");
  __clearAuthCachesForTests();
});

let app: Application;

beforeAll(async () => {
  const mod = await import("../app");
  app = mod.default;
});

describe("Auth mocked regressions", () => {
  it("auth/permissions retries once when session is temporarily not visible", async () => {
    state.usersByEmail.clear();
    state.usersById.clear();
    state.sessionsByTokenHash.clear();
    state.rolesById.clear();
    state.firmsById.clear();
    state.throwPermissionsSelect = false;
    state.throwSessionSelectTransient = false;
    state.sessionSelectEmptyOnce = true;
    state.sessionSelectCalls = 0;
    state.throwUndefinedColumnOnUserLookup = false;
    state.throwSideEffects = false;

    const user = {
      id: 10,
      firmId: null,
      email: "founder@test.com",
      name: "Founder",
      passwordHash: "hash",
      userType: "founder",
      roleId: null,
      status: "active",
      totpSecret: null,
      totpEnabled: false,
    };
    state.usersById.set(10, user);
    state.sessionsByTokenHash.set(hashToken("any"), { userId: 10, expiresAt: new Date(Date.now() + 60_000) });

    const res = await request(app).get("/api/auth/permissions").set("Cookie", "auth_token=any");
    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
  });

  it("login succeeds even if side effects fail", async () => {
    state.usersByEmail.clear();
    state.usersById.clear();
    state.sessionsByTokenHash.clear();
    state.rolesById.clear();
    state.firmsById.clear();
    state.throwPermissionsSelect = false;
    state.throwUndefinedColumnOnUserLookup = false;
    state.throwSideEffects = true;
    state.throwSessionSelectTransient = false;
    state.sessionSelectEmptyOnce = false;
    state.sessionSelectCalls = 0;

    const user = {
      id: 10,
      firmId: 5,
      email: "user@test.com",
      name: "U",
      passwordHash: "hash",
      userType: "firm_user",
      roleId: 7,
      status: "active",
      totpSecret: null,
      totpEnabled: false,
    };
    state.usersByEmail.set("user@test.com", user);
    state.usersById.set(10, user);
    state.rolesById.set(7, { id: 7, name: "Clerk" });
    state.firmsById.set(5, { id: 5, name: "Firm" });

    const res = await request(app).post("/api/auth/login").send({ email: "user@test.com", password: "goodpw" });
    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    const cookieToken = extractAuthTokenFromSetCookie(
      (res.headers as Record<string, unknown>)["set-cookie"] as string[] | string | undefined,
    );
    expect(typeof cookieToken === "string" && cookieToken.length > 0).toBe(true);
    expect(res.headers["set-cookie"]).toBeTruthy();
  });

  it("login returns 401 when user not found even if schema mismatch triggers fallback", async () => {
    state.usersByEmail.clear();
    state.usersById.clear();
    state.sessionsByTokenHash.clear();
    state.rolesById.clear();
    state.firmsById.clear();
    state.throwPermissionsSelect = false;
    state.throwUndefinedColumnOnUserLookup = true;
    state.throwSideEffects = false;
    state.throwSessionSelectTransient = false;
    state.sessionSelectEmptyOnce = false;
    state.sessionSelectCalls = 0;

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "noone@example.com", password: "badpw" });
    expect(res.status).toBe(401);
  });

  it("auth/me no token returns 200 with null data", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    expect(res.body?.data).toBeNull();
  });

  it("auth/me transient DB error returns 503 without clearing cookie", async () => {
    state.sessionsByTokenHash.clear();
    state.throwSessionSelectTransient = true;
    const res = await request(app).get("/api/auth/me").set("Cookie", "auth_token=maybe");
    expect(res.status).toBe(503);
    expect(res.body?.ok).toBe(false);
    const scHeader = (res.headers as Record<string, unknown>)["set-cookie"];
    const sc = Array.isArray(scHeader) ? scHeader.join(";") : String(scHeader ?? "");
    expect(sc).not.toMatch(/auth_token=/);
    state.throwSessionSelectTransient = false;
  });

  it("auth/me invalid token returns 200 null and clears cookie", async () => {
    state.sessionsByTokenHash.clear();
    const res = await request(app).get("/api/auth/me").set("Cookie", "auth_token=invalid");
    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    expect(res.body?.data).toBeNull();
    const scHeader = (res.headers as Record<string, unknown>)["set-cookie"];
    const sc = Array.isArray(scHeader) ? scHeader.join(";") : String(scHeader ?? "");
    expect(sc).toMatch(/auth_token=/);
  });

  it("auth/me returns 200 and degrades when permissions query fails", async () => {
    state.usersByEmail.clear();
    state.usersById.clear();
    state.sessionsByTokenHash.clear();
    state.rolesById.clear();
    state.firmsById.clear();

    const user = {
      id: 11,
      firmId: 5,
      email: "p@test.com",
      name: "P",
      userType: "firm_user",
      roleId: 7,
      department: null,
      status: "active",
    };
    state.usersById.set(11, user);
    state.rolesById.set(7, { id: 7, name: "Clerk" });
    state.firmsById.set(5, { id: 5, name: "Firm" });

    state.sessionsByTokenHash.set(hashToken("token"), { userId: 11, expiresAt: new Date(Date.now() + 60_000) });
    state.throwPermissionsSelect = true;
    state.throwUndefinedColumnOnUserLookup = false;

    const res = await request(app).get("/api/auth/me").set("Cookie", "auth_token=token");
    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    expect(res.body?.data).toHaveProperty("permissions");
    expect(Array.isArray(res.body?.data?.permissions)).toBe(true);
  });

  it("auth/me succeeds on first verification even if session is briefly not visible", async () => {
    state.usersById.clear();
    state.sessionsByTokenHash.clear();
    state.rolesById.clear();
    state.firmsById.clear();
    state.throwPermissionsSelect = false;
    state.throwSessionSelectTransient = false;
    state.sessionSelectEmptyOnce = true;
    state.sessionSelectCalls = 0;
    state.sessionSelectDelayMs = 0;
    state.throwUndefinedColumnOnUserLookup = false;
    state.throwSideEffects = false;
    state.throwSideEffects = false;

    const user = {
      id: 12,
      firmId: 5,
      email: "u@test.com",
      name: "U",
      userType: "firm_user",
      roleId: 7,
      department: null,
      status: "active",
    };
    state.usersById.set(12, user);
    state.rolesById.set(7, { id: 7, name: "Clerk" });
    state.firmsById.set(5, { id: 5, name: "Firm" });
    state.sessionsByTokenHash.set(hashToken("any"), { userId: 12, expiresAt: new Date(Date.now() + 60_000) });

    const res = await request(app).get("/api/auth/me").set("Cookie", "auth_token=any");
    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    expect(res.body?.data?.id).toBe(12);
    expect(state.sessionSelectCalls).toBeGreaterThanOrEqual(2);
  });

  it("auth/me de-duplicates concurrent session lookups", async () => {
    state.usersById.clear();
    state.sessionsByTokenHash.clear();
    state.rolesById.clear();
    state.firmsById.clear();
    state.throwPermissionsSelect = false;
    state.throwSessionSelectTransient = false;
    state.sessionSelectEmptyOnce = false;
    state.sessionSelectCalls = 0;
    state.sessionSelectDelayMs = 0;
    state.throwUndefinedColumnOnUserLookup = false;
    state.throwSideEffects = false;
    state.throwSideEffects = false;
    state.throwSideEffects = false;

    const user = {
      id: 13,
      firmId: 5,
      email: "u2@test.com",
      name: "U2",
      userType: "firm_user",
      roleId: 7,
      department: null,
      status: "active",
    };
    state.usersById.set(13, user);
    state.rolesById.set(7, { id: 7, name: "Clerk" });
    state.firmsById.set(5, { id: 5, name: "Firm" });
    state.sessionsByTokenHash.set(hashToken("any"), { userId: 13, expiresAt: new Date(Date.now() + 60_000) });

    const { lookupSessionAndUserByTokenHash } = await import("../lib/auth.js");
    const tokenHash = crypto.createHash("sha256").update("any").digest("hex");
    const results = await Promise.all(
      Array.from({ length: 10 }).map(() => lookupSessionAndUserByTokenHash(tokenHash)),
    );
    for (const r of results) {
      expect(r?.session?.userId).toBe(13);
      expect(r?.user?.id).toBe(13);
    }
    expect(state.sessionSelectCalls).toBe(1);
    state.sessionSelectDelayMs = 0;
  });
});
