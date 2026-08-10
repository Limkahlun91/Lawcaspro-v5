// artifacts/api-server/src/__tests__/p0-runtime-addendum-regression.test.ts
// P0 Runtime Addendum targeted regression tests (Storage contract / typed errors / graceful fallback).
// VITEST_SKIP_DB=1 compatible: all DB is mocked via module-level vi.mock or pure extractDbErrorInfo.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractDbErrorInfo } from "../lib/db-error.js";
import { SupabaseStorageService, getSupabaseStorageConfigError } from "../lib/objectStorage.js";

function fakePgError(overrides: any): any {
  const e = new Error(overrides?.message ?? "mock pg error");
  Object.assign(e, {
    code: overrides?.code ?? "42703",
    sqlState: overrides?.sqlState ?? overrides?.code ?? "42703",
    table: overrides?.table ?? undefined,
    column: overrides?.column ?? undefined,
    constraint: overrides?.constraint ?? undefined,
    detail: overrides?.detail ?? undefined,
    hint: overrides?.hint ?? undefined,
    position: overrides?.position ?? undefined,
  });
  return e;
}

describe("P0 Storage URL contract guard (Addendum §1/§4)", () => {
  const realEnv = { ...process.env };
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...realEnv };
  });
  afterEach(() => {
    process.env = { ...realEnv };
  });

  function withEnv(env: Record<string, string>, fn: () => void) {
    const prev = { ...process.env };
    try {
      for (const k of Object.keys(process.env)) {
        if (k === "NODE_ENV") continue;
        delete process.env[k];
      }
      process.env.NODE_ENV = "test";
      Object.assign(process.env, env);
      fn();
    } finally {
      process.env = prev;
    }
  }

  it("postgresql:// SUPABASE_URL → throws typed StorageConfigurationError and never leaks credentials", () => {
    withEnv(
      {
        SUPABASE_URL:
          "postgresql://postgres.abc:[YOUR-PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true",
        SUPABASE_SERVICE_ROLE_KEY: "testonly",
      },
      () => {
        const spyErr = vi
          .spyOn(console, "error")
          .mockImplementation(() => {});
        try {
          const svc = new SupabaseStorageService();
          svc.assertConfigured();
          throw new Error("expected to throw");
        } catch (err: any) {
          expect(err?.name).toBe("StorageConfigurationError");
          expect(err?.configurationErrorCode).toBe("CONFIG_INVALID_SUPABASE_HTTP_URL");
          expect(err?.variableName).toBe("SUPABASE_URL");
          expect(err?.protocol).toBe("postgresql:");
          const serialized = JSON.stringify({
            m: err?.message ?? "",
            n: err?.name ?? "",
            stk: err?.stack ?? "",
          });
          expect(serialized).not.toContain("[YOUR-PASSWORD]");
          expect(serialized).not.toContain("postgres.abc");
          expect(serialized).not.toContain("aws-0-ap-southeast-1.pooler.supabase.com");
          expect(spyErr).toHaveBeenCalled();
          const logStr = JSON.stringify(spyErr.mock.calls.flat());
          expect(logStr).toContain("CONFIG_INVALID_SUPABASE_HTTP_URL");
          expect(logStr).toContain("variableName");
          expect(logStr).toContain("protocol");
          expect(logStr).not.toContain("[YOUR-PASSWORD]");
          expect(logStr).not.toContain("postgres.abc");
        } finally {
          spyErr.mockRestore();
        }
      },
    );
  });

  it("postgres:// protocol rejected with CONFIG_INVALID_SUPABASE_HTTP_URL", () => {
    withEnv({ SUPABASE_URL: "postgres://u:p@h:5432/x", SUPABASE_SERVICE_ROLE_KEY: "k" }, () => {
      try {
        new SupabaseStorageService().assertConfigured();
        throw new Error("expected throw");
      } catch (err: any) {
        expect(err?.configurationErrorCode).toBe("CONFIG_INVALID_SUPABASE_HTTP_URL");
        expect(err?.protocol).toBe("postgres:");
      }
    });
  });

  it("https:// bepixycuulklorcbadww base URL accepted and assertConfigured does not throw", () => {
    withEnv(
      {
        SUPABASE_URL: "https://bepixycuulklorcbadww.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "eyJh_testonly_dummy_service_role",
      },
      () => {
        const svc = new SupabaseStorageService();
        expect(() => svc.assertConfigured()).not.toThrow();
      },
    );
  });

  it("getSupabaseStorageConfigError returns 503 code for StorageConfigurationError and never leaks credentials", () => {
    withEnv(
      {
        SUPABASE_URL: "postgresql://u:secret-long-password@h:5432/db?opts=1",
        SUPABASE_SERVICE_ROLE_KEY: "k",
      },
      () => {
        let thrown: unknown = null;
        try {
          new SupabaseStorageService().assertConfigured();
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeTruthy();
        const info = getSupabaseStorageConfigError(thrown);
        expect(info).toBeTruthy();
        expect(info!.statusCode).toBe(503);
        expect(info!.code).toBe("CONFIG_INVALID_SUPABASE_HTTP_URL");
        expect(info!.configurationErrorCode).toBe("CONFIG_INVALID_SUPABASE_HTTP_URL");
        expect(info!.variableName).toBe("SUPABASE_URL");
        expect(info!.protocol).toBe("postgresql:");
        const serialized = JSON.stringify(info);
        expect(serialized).not.toContain("secret-long-password");
        expect(serialized).not.toContain("postgresql://");
        expect(serialized).not.toContain("h:5432/db");
      },
    );
  });
});

describe("P0 Notifications structured DB error classification (Addendum §8)", () => {
  it("42703 undefined_column severity column captured with table", () => {
    const info = extractDbErrorInfo(fakePgError({ code: "42703", column: "severity", table: "user_notifications" }));
    expect(info.sqlState).toBe("42703");
    expect(info.column).toBe("severity");
    expect(info.table).toBe("user_notifications");
  });

  it("42P01 missing relation captured", () => {
    const info = extractDbErrorInfo(fakePgError({ code: "42P01", table: "user_notifications" }));
    expect(info.sqlState).toBe("42P01");
    expect(info.table).toBe("user_notifications");
  });

  it("42501 permission denied captured as permission path", () => {
    const info = extractDbErrorInfo(fakePgError({ code: "42501" }));
    expect(info.sqlState).toBe("42501");
  });
});

describe("P0 Case Monitor controlled 503 path (Addendum §13)", () => {
  it("57014 statement cancelled captured", () => {
    const info = extractDbErrorInfo(fakePgError({ code: "57014" }));
    expect(info.sqlState).toBe("57014");
  });
});

describe("P0 File Custody schema mismatch capture (Addendum §15)", () => {
  it("42703 status_set_at on file_custody_items captured", () => {
    const info = extractDbErrorInfo(fakePgError({ code: "42703", table: "file_custody_items", column: "status_set_at" }));
    expect(info.sqlState).toBe("42703");
    expect(info.table).toBe("file_custody_items");
    expect(info.column).toBe("status_set_at");
  });
});

describe("P0 Invoices e-Invoice optional columns (Addendum §17)", () => {
  it("42703 einvoice_status on invoices captured (schema mismatch path)", () => {
    const info = extractDbErrorInfo(fakePgError({ code: "42703", table: "invoices", column: "einvoice_status" }));
    expect(info.sqlState).toBe("42703");
    expect(info.table).toBe("invoices");
    expect(info.column).toBe("einvoice_status");
  });
});
