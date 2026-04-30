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
});

