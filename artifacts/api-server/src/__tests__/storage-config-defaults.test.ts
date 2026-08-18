import { describe, expect, it } from "vitest";
import { SupabaseStorageService } from "../lib/objectStorage";

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

