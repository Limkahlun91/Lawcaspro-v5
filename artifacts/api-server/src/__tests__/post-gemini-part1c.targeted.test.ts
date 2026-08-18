import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  classifyDatabaseError,
  databaseErrorHttpStatus,
  databaseErrorCode,
  databaseErrorSafeMessage,
  databaseErrorRetryable,
  databaseErrorLogToken,
  extractDbErrorInfo,
} from "../lib/db-error";
import {
  ApiError,
  sendError,
  classifyErrorForLog,
  ResLike,
} from "../lib/api-response";
import { SupabaseStorageService, StorageConfigurationError } from "../lib/objectStorage";

function fakeRes(): { res: ResLike; getCaptured: () => { status: number; body: unknown } } {
  let capturedStatus = 200;
  let capturedBody: unknown = null;
  const locals: Record<string, unknown> = { requestId: "req-test-0001", startedAtMs: Date.now() - 5 };
  const res: ResLike = {
    statusCode: 200,
    statusMessage: "OK",
    locals,
    setHeader(_k: string, _v: unknown) { return res as any; },
    getHeader(_k: string) { return undefined as any; },
    removeHeader(_k: string) { return; },
    hasHeader(_k: string) { return false; },
    writeHead(s: number, _headers?: any) { res.statusCode = s; capturedStatus = s; return res as any; },
    write(_chunk: any, _cb?: any) { return true; },
    end(chunk?: any, _encoding?: any, cb?: any) {
      if (typeof chunk === "string") try { capturedBody = JSON.parse(chunk); } catch { capturedBody = chunk; }
      else capturedBody = chunk;
      if (typeof cb === "function") cb();
      return res as any;
    },
    on(_ev: string, _fn: any) { return res as any; },
    once(_ev: string, _fn: any) { return res as any; },
    emit(_ev: string, ..._a: any[]) { return true; },
    status(code: number) { capturedStatus = code; res.statusCode = code; return res; },
    json(body: unknown) { capturedBody = body; return res; },
    send(body?: unknown) { capturedBody = body ?? null; return res; },
  } as unknown as ResLike;
  return { res, getCaptured: () => ({ status: capturedStatus, body: capturedBody }) };
}

function makePgErrorLike(opts: { code?: string; sqlstate?: string; message?: string; }): Error {
  const e = new Error(opts.message ?? "") as any;
  if (opts.code) {
    e.code = opts.code;
    e.sqlstate = opts.code;
  } else if (opts.sqlstate) {
    e.code = opts.sqlstate;
    e.sqlstate = opts.sqlstate;
  }
  return e as Error;
}

describe("POST-GEMINI PART 1C — DB classification", () => {
  it("DBERR-1: sqlstate 53300 classified as DB_BUSY", () => {
    const err = makePgErrorLike({ sqlstate: "53300", message: "too_many_connections" });
    const category = classifyDatabaseError(err);
    expect(category).toBe("DB_BUSY");
    expect(databaseErrorHttpStatus(category)).toBe(503);
    expect(databaseErrorCode(category)).toBe("DB_BUSY");
    expect(databaseErrorRetryable(category)).toBe(true);
    expect(databaseErrorLogToken(category)).toBe("api.db_busy");
    const msg = databaseErrorSafeMessage(category);
    expect(msg.toLowerCase()).not.toMatch(/unavailable|restart|outage|network/);
    expect(msg.toLowerCase()).toMatch(/heavy load|try again|busy|database is currently/);
  });

  it("DBERR-2: sqlstate 08006 classified as DB_UNAVAILABLE (NOT busy)", () => {
    const err = makePgErrorLike({ sqlstate: "08006", message: "connection failure" });
    const category = classifyDatabaseError(err);
    expect(category).toBe("DB_UNAVAILABLE");
    expect(databaseErrorHttpStatus(category)).toBe(503);
    expect(databaseErrorCode(category)).toBe("DB_UNAVAILABLE");
    expect(databaseErrorRetryable(category)).toBe(true);
    expect(databaseErrorLogToken(category)).toBe("api.db_unavailable");
    const msg = databaseErrorSafeMessage(category);
    expect(msg).not.toMatch(/資料庫繁忙|heavy load/);
    expect(msg.toLowerCase()).toMatch(/unavailable|temporarily/);
  });

  it("DBERR-3: sqlstate 57P01 (admin shutdown) classified as DB_UNAVAILABLE", () => {
    const err = makePgErrorLike({ sqlstate: "57P01", message: "terminating connection due to administrator command" });
    const category = classifyDatabaseError(err);
    expect(category).toBe("DB_UNAVAILABLE");
    expect(databaseErrorCode(category)).toBe("DB_UNAVAILABLE");
    const info = extractDbErrorInfo(err);
    expect(info.sqlstate).toBe("57P01");
    const logClass = classifyErrorForLog(err);
    expect(logClass.event).toBe("api.db_unavailable");
    expect(logClass.level).toBe("warn");
    expect(logClass.retrySuggestion).toBe("DB_UNAVAILABLE");
  });

  it("DBERR-4: client response never contains raw SQL, DB url, password, NRIC, service_role token or host", () => {
    const rawMessage = [
      "failed query: SELECT id, password, service_role_token FROM users WHERE NRIC = '880808-08-8808'",
      "postgres://admin:S3cretPass%40@db.internal.svc.cluster.local:5432/pg host=db.internal user=admin password=abc123",
      "insert into \"secret_table\"(bank_account) values ('MY123456789012')",
      "eyJhbGciOiJIUzI1NiJ9.service-role-dummy.dummySig service_role:eyJ...",
    ].join(" | ");
    const leakyErr = new Error(rawMessage);
    (leakyErr as any).query = "SELECT secret FROM users WHERE id=$1";
    (leakyErr as any).params = ["NRIC-880808-08-8808"];
    (leakyErr as any).connectionString = "postgresql://leak:pw@leaked-host:5432/x";
    (leakyErr as any).host = "leaked.db.example";
    (leakyErr as any).password = "should-secret";
    (leakyErr as any).serviceRoleKey = "sb-service-role-should-not-appear";
    const { res, getCaptured } = fakeRes();
    sendError(res, leakyErr, { status: 500, code: "INTERNAL_SERVER_ERROR", message: rawMessage });
    const captured = getCaptured();
    const body = JSON.parse(JSON.stringify(captured.body)) as any;
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/insert into\s+"secret_table"/i);
    expect(serialized).not.toMatch(/failed query:/i);
    expect(serialized).not.toMatch(/postgres(?:ql)?:\/\//i);
    expect(serialized).not.toMatch(/S3cretPass|password=abc|user=admin|host=db\.internal|leaked\.db\.example|sb-service-role/);
    expect(serialized).not.toMatch(/880808-08-8808/);
    expect(serialized).not.toMatch(/MY123456789012/);
    expect(serialized).not.toMatch(/eyJhbGci/);
    const errorBlock = body?.error;
    expect(String(errorBlock?.code ?? "")).toBeTruthy();
    expect(typeof errorBlock?.retryable).toBe("boolean");
  });
});

describe("POST-GEMINI PART 1C — DEP0169 warning suppressor absent", () => {
  const filesToCheck: Array<string> = [
    path.resolve(__dirname, "..", "index.ts"),
    path.resolve(__dirname, "..", "..", "..", "..", "api", "index.ts"),
    path.resolve(__dirname, "..", "..", "..", "..", "api", "[...path].ts"),
  ];

  it("DEP-1: process.on warning suppressor for DEP0169 removed from all 3 entry files", () => {
    for (const f of filesToCheck) {
      const exists = fs.existsSync(f);
      expect(exists).toBe(true);
      const content = fs.readFileSync(f, "utf8");
      expect(content).not.toMatch(/process\.on\s*\(\s*["']warning["']/);
      expect(content).not.toMatch(/DEP0169/);
      expect(content).not.toMatch(/suppressCodes/);
      expect(content).not.toMatch(/suppressMessageContains/);
      expect(content).not.toMatch(/registerDeprecationSuppressions/);
    }
  });
});

describe("POST-GEMINI PART 1C — Storage URL safety", () => {
  const withEnv = (env: Record<string, string | undefined>, fn: () => void) => {
    const prev = { ...process.env };
    try {
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fn();
    } finally {
      process.env = prev;
    }
  };

  it("STORAGE-1: valid Supabase URL accepted (https + .supabase.co)", () => {
    withEnv({
      SUPABASE_URL: "https://myproject-ref.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "sb-service-role-test",
      SUPABASE_STORAGE_BUCKET_PRIVATE: undefined,
      VITE_SUPABASE_URL: undefined,
      NEXT_PUBLIC_SUPABASE_URL: undefined,
      NODE_ENV: "test",
    }, () => {
      const svc = new SupabaseStorageService();
      expect(() => svc.assertConfigured()).not.toThrow();
    });
  });

  it("STORAGE-2: missing protocol, valid Supabase host auto-sanitized to https", () => {
    withEnv({
      SUPABASE_URL: "another-ref.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "sb-service-role-test2",
      SUPABASE_STORAGE_BUCKET_PRIVATE: undefined,
      VITE_SUPABASE_URL: undefined,
      NEXT_PUBLIC_SUPABASE_URL: undefined,
      NODE_ENV: "test",
    }, () => {
      const svc = new SupabaseStorageService();
      expect(() => svc.assertConfigured()).not.toThrow();
    });
  });

  it("STORAGE-3: arbitrary/hostile hosts rejected with CONFIG_INVALID_SUPABASE_HTTP_URL", () => {
    const cases: Array<{ label: string; url: string; expectProtocol?: boolean }> = [
      { label: "attacker.com with https", url: "https://attacker.com" },
      { label: "random host no protocol", url: "evil-phish.xyz/storage/v1" },
      { label: "supabase but different TLD", url: "https://foo.supabase.evil.io" },
    ];
    for (const c of cases) {
      withEnv({
        SUPABASE_URL: c.url,
        SUPABASE_SERVICE_ROLE_KEY: "sb-service-role-test3",
        SUPABASE_STORAGE_BUCKET_PRIVATE: undefined,
        VITE_SUPABASE_URL: undefined,
        NEXT_PUBLIC_SUPABASE_URL: undefined,
        NODE_ENV: "test",
      }, () => {
        const svc = new SupabaseStorageService();
        let threw: unknown = null;
        try { svc.assertConfigured(); } catch (e) { threw = e; }
        expect(threw).not.toBeNull();
        expect((threw as StorageConfigurationError).constructor?.name).toBeTruthy();
        const err = threw as StorageConfigurationError;
        expect(err.configurationErrorCode).toBe("CONFIG_INVALID_SUPABASE_HTTP_URL");
      });
    }
  });
});
