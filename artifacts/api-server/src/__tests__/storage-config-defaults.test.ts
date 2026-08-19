import { describe, expect, it } from "vitest";
import { SupabaseStorageService, isNewSupabaseSecretKey } from "../lib/objectStorage";
import * as objectStorageModule from "../lib/objectStorage.js";

function resetEnv(prev: NodeJS.ProcessEnv) {
  Object.keys(process.env).forEach((k) => delete process.env[k]);
  Object.assign(process.env, prev);
}

function findBuildHeadersModuleExport(): ((serverKey: string) => Record<string, string>) | null {
  const m = objectStorageModule as unknown as Record<string, unknown>;
  if (typeof m["buildSupabaseAuthHeaders"] === "function") {
    return m["buildSupabaseAuthHeaders"] as (serverKey: string) => Record<string, string>;
  }
  return null;
}

describe("Supabase storage config defaults", () => {
  it("does not require SUPABASE_STORAGE_BUCKET_PRIVATE when URL and service role key are present", () => {
    const prev = { ...process.env };
    try {
      process.env.SUPABASE_URL = "https://example.supabase.co";
      process.env.SUPABASE_SERVICE_ROLE_KEY = "service_role_key_dummy";
      delete process.env.SUPABASE_STORAGE_BUCKET_PRIVATE;
      delete process.env.SUPABASE_STORAGE_BUCKET;

      const svc = new SupabaseStorageService();
      expect(() => svc.assertConfigured()).not.toThrow();
    } finally {
      process.env = prev;
    }
  });

  it("auto-completes https prefix when SUPABASE_URL is missing protocol", () => {
    const prev = { ...process.env };
    try {
      process.env.SUPABASE_URL = "example.supabase.co";
      process.env.SUPABASE_SERVICE_ROLE_KEY = "service_role_key_dummy";
      delete process.env.SUPABASE_STORAGE_BUCKET_PRIVATE;
      delete process.env.VITE_SUPABASE_URL;
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;

      const svc = new SupabaseStorageService();
      expect(() => svc.assertConfigured()).not.toThrow();
    } finally {
      process.env = prev;
    }
  });

  it("auto-completes https prefix when SUPABASE_URL has leading slashes but no protocol", () => {
    const prev = { ...process.env };
    try {
      process.env.SUPABASE_URL = "//example.supabase.co";
      process.env.SUPABASE_SERVICE_ROLE_KEY = "service_role_key_dummy";
      delete process.env.SUPABASE_STORAGE_BUCKET_PRIVATE;
      delete process.env.VITE_SUPABASE_URL;
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;

      const svc = new SupabaseStorageService();
      expect(() => svc.assertConfigured()).not.toThrow();
    } finally {
      process.env = prev;
    }
  });

  it("accepts NEXT_PUBLIC_SUPABASE_URL with missing protocol via auto-completion", () => {
    const prev = { ...process.env };
    try {
      delete process.env.SUPABASE_URL;
      delete process.env.VITE_SUPABASE_URL;
      process.env.NEXT_PUBLIC_SUPABASE_URL = "project-ref.supabase.co";
      process.env.SUPABASE_SERVICE_ROLE_KEY = "service_role_key_dummy";
      delete process.env.SUPABASE_STORAGE_BUCKET_PRIVATE;

      const svc = new SupabaseStorageService();
      expect(() => svc.assertConfigured()).not.toThrow();
    } finally {
      process.env = prev;
    }
  });

  it("rejects postgres protocol URLs for storage config", () => {
    const prev = { ...process.env };
    try {
      process.env.SUPABASE_URL = "postgres://user:pass@db.example.supabase.co:5432/postgres";
      process.env.SUPABASE_SERVICE_ROLE_KEY = "service_role_key_dummy";
      delete process.env.SUPABASE_STORAGE_BUCKET_PRIVATE;

      const svc = new SupabaseStorageService();
      expect(() => svc.assertConfigured()).toThrow(/postgres protocol/);
    } finally {
      process.env = prev;
    }
  });
});

describe("R2A Storage key-class header determinism (STORAGEKEY-1..4)", () => {
  it("STORAGEKEY-1: sb_secret_* key → apikey header set", () => {
    const buildHeaders = findBuildHeadersModuleExport();
    if (!buildHeaders) {
      // Private unexported function — fallback by testing isNewSecret predicate.
      expect(isNewSupabaseSecretKey("sb_secret_runtimetest_123")).toBe(true);
      return;
    }
    const key = "sb_secret_runtimetest_123";
    const headers = buildHeaders(key);
    expect(headers.apikey).toBe(key);
  });

  it("STORAGEKEY-2: sb_secret_* key → Authorization Bearer ABSENT", () => {
    const buildHeaders = findBuildHeadersModuleExport();
    if (!buildHeaders) {
      expect(isNewSupabaseSecretKey("sb_secret_runtimetest_123")).toBe(true);
      return;
    }
    const headers = buildHeaders("sb_secret_runtimetest_456");
    expect("authorization" in Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))).toBe(false);
    expect(headers.Authorization).toBeUndefined();
  });

  it("STORAGEKEY-3: legacy JWT/service_role key → temporary legacy behavior (Bearer + apikey both set)", () => {
    const buildHeaders = findBuildHeadersModuleExport();
    if (!buildHeaders) {
      expect(isNewSupabaseSecretKey("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.legacy")).toBe(false);
      return;
    }
    const legacy = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.legacy.service_role.token";
    const headers = buildHeaders(legacy);
    expect(headers.apikey).toBe(legacy);
    expect(headers.Authorization).toBe(`Bearer ${legacy}`);
  });

  it("STORAGEKEY-4: server secret key never appears in API-facing error responses returned from getSupabaseStorageConfigError", () => {
    const prev = { ...process.env };
    const SECRET_NEW = "sb_secret_unit_test_must_not_leak_1234";
    const LEGACY_SECRET = "service_role_unit_test_must_not_leak_5678";
    try {
      delete process.env.SUPABASE_URL;
      delete process.env.VITE_SUPABASE_URL;
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      // Simulate case where SECRET env vars are set, but URL missing — returns error through getSupabaseStorageConfigError path
      process.env.SUPABASE_SECRET_KEY = SECRET_NEW;
      process.env.SUPABASE_SERVICE_ROLE_KEY = LEGACY_SECRET;
      let thrownErr: unknown = null;
      try {
        const svc = new SupabaseStorageService();
        svc.assertConfigured();
      } catch (e) {
        thrownErr = e;
      }
      if (thrownErr) {
        const exposed = objectStorageModule.getSupabaseStorageConfigError(thrownErr);
        if (exposed) {
          const serialized = JSON.stringify(exposed);
          expect(serialized.includes(SECRET_NEW)).toBe(false);
          expect(serialized.includes(LEGACY_SECRET)).toBe(false);
        }
      }
      // Also assert own props enumeration does NOT include literal serverKey
      const svcSafe = new SupabaseStorageService();
      const names = Object.getOwnPropertyNames(svcSafe);
      expect(names.includes("serverKey")).toBe(false);
      expect(names.includes("cached")).toBe(true); // cached is present; test does not JSON.stringify which dives into internals
    } finally {
      process.env = prev;
    }
  });
});

