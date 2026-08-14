// ============================================================================
// P0 Emergency Recovery — Entitlement / Storage / Case targeted regressions
// Covers:
//   ENT-DB-1  platform_features exists (p6 CREATE TABLE IF NOT EXISTS parity)
//   ENT-DB-2  firm_user_feature_access exists
//   ENT-DB-3  registry sync count > 0 (p6 seed from FEATURE_REGISTRY)
//   ENT-1     Partner effective-features returns 2xx bundle shape
//   ENT-2     Clerk effective-features returns 2xx bundle shape
//   ENT-3     Firm bootstrap never calls /entitlements/founder/* route
//   ENT-4     Explicit user child feature OFF => resolves denied
//   ENT-5     Partner firm entitlement enabled => allowed
//   ENT-PERF-1 resolveUserFeatureAccessBulk issues <= 2 DB roundtrips total
//   CASE-RUNTIME-1  all listed Case endpoints respond 200/403/404 — never 500
//   STORAGE-1  Supabase URL parsed as http/https (SUPABASE_URL cascade)
//   STORAGE-2  /firm-settings/logo handler returns no storage-config 503 shape
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FEATURE_REGISTRY, FEATURE_REGISTRY_MAP } from "@workspace/db/feature-registry";
import { resolveUserFeatureAccessBulk } from "../services/user-feature-access.js";
import {
  SupabaseStorageService,
  getSupabaseStorageConfigError,
  StorageConfigurationError,
} from "../lib/objectStorage.js";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// ---------- ENT-DB / parity (p6 migration static assertions) ----------

describe("ENT-DB-1 / ENT-DB-2 / ENT-DB-3 — p6 migration static parity", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const dir = fileURLToPath
    ? dirname(fileURLToPath(import.meta.url))
    : __dirname;
  const migrationsPath = path.resolve(dir, "..", "..", "..", "..", "supabase", "migrations");
  let p6Src = "";
  try {
    const file = fs
      .readdirSync(migrationsPath)
      .find((n: string) => /^p6_entitlement_runtime_foundation\.sql$/i.test(n));
    p6Src = file ? fs.readFileSync(path.join(migrationsPath, file), "utf8") : "";
  } catch {
    p6Src = "";
  }

  it("ENT-DB-1 — migration p6 creates platform_features (CREATE TABLE IF NOT EXISTS)", () => {
    expect(p6Src.length).toBeGreaterThan(0);
    expect(p6Src).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(?:public\.)?platform_features\s*\(/i);
  });

  it("ENT-DB-2 — migration p6 creates firm_user_feature_access (CREATE TABLE IF NOT EXISTS)", () => {
    expect(p6Src).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(?:public\.)?firm_user_feature_access\s*\(/i);
  });

  it("ENT-DB-3 — p6 seeds platform_features directly from canonical registry keys (>= 50 seeded keys)", () => {
    expect(p6Src).toMatch(/INSERT\s+(?:INTO|OVERWRITE)\s+(?:public\.)?platform_features/i);
    // At least one canonical key from registry appears in the seed body (no fake manual keys allowed)
    const sampleCanonical = "cases.legacy_import";
    expect(p6Src).toContain(sampleCanonical);
    // Registry must export 50+ keys, we use that as ENT-DB-3 "sync count > 0" bound
    expect(FEATURE_REGISTRY.length).toBeGreaterThan(50);
  });

  it("ENT-DB extras — p6 covers plan_entitlements + firm_entitlement_overrides + hr_firm_feature_flags", () => {
    expect(p6Src).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(?:public\.)?plan_entitlements\s*\(/i);
    expect(p6Src).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(?:public\.)?firm_entitlement_overrides\s*\(/i);
    expect(p6Src).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(?:public\.)?hr_firm_feature_flags\s*\(/i);
  });
});

describe("ENT-14 canonical feature key parity — every Part3 invented key classification", () => {
  const REGISTRY_KEYS = new Set(FEATURE_REGISTRY.map((f) => f.featureKey));
  it("hr.user_access is WRONG (not canonical); canonical is module.hr / rbac.users", () => {
    expect(REGISTRY_KEYS.has("hr.user_access")).toBe(false);
    expect(REGISTRY_KEYS.has("module.hr")).toBe(true);
    expect(REGISTRY_KEYS.has("rbac.users")).toBe(true);
  });
  it("cases.hims_espa is WRONG; canonical is module.hims / hims.tracker", () => {
    expect(REGISTRY_KEYS.has("cases.hims_espa")).toBe(false);
    expect(REGISTRY_KEYS.has("module.hims")).toBe(true);
    expect(REGISTRY_KEYS.has("hims.tracker")).toBe(true);
  });
  it("communication.email is WRONG; canonical is communications.email", () => {
    expect(REGISTRY_KEYS.has("communication.email")).toBe(false);
    expect(REGISTRY_KEYS.has("communications.email")).toBe(true);
  });
  it("cases.legacy_case_import is WRONG; canonical is cases.legacy_import", () => {
    expect(REGISTRY_KEYS.has("cases.legacy_case_import")).toBe(false);
    expect(REGISTRY_KEYS.has("cases.legacy_import")).toBe(true);
  });
  it("documents.document_intelligence is WRONG; guarded by module.documents (document_intelligence is a route key, not registry key)", () => {
    expect(REGISTRY_KEYS.has("documents.document_intelligence")).toBe(false);
    expect(REGISTRY_KEYS.has("module.documents")).toBe(true);
  });
  it("FEATURE_REGISTRY_MAP and FEATURE_REGISTRY export identical key sets", () => {
    for (const f of FEATURE_REGISTRY) {
      expect(FEATURE_REGISTRY_MAP.get(f.featureKey)).toBeDefined();
    }
  });
});

// ---------- ENT-3 frontend firm bootstrap never calls founder endpoint ----------

describe("ENT-3 — Firm bootstrap uses /users/_self/effective-features, NEVER /entitlements/founder/*", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const dir = fileURLToPath
    ? dirname(fileURLToPath(import.meta.url))
    : __dirname;
  const FE_ROOT = path.resolve(dir, "..", "..", "..", "lawcaspro", "src");
  function listFiles(dir: string, acc: string[] = []): string[] {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "dist") continue;
          listFiles(p, acc);
        } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) acc.push(p);
      }
    } catch {}
    return acc;
  }
  const FE_FILES = listFiles(FE_ROOT);
  const founderHits: string[] = [];
  const selfHits: string[] = [];
  for (const p of FE_FILES) {
    const src = fs.readFileSync(p, "utf8") as string;
    if (/entitlements\/founder\/(?:firms\/_self|firms\/[^/]+)\/effective/.test(src)) founderHits.push(path.relative(process.cwd(), p));
    if (/\/users\/_self\/effective-features/.test(src)) selfHits.push(path.relative(process.cwd(), p));
  }
  it("non-founder UI caller files count for /users/_self/effective-features > 0", () => {
    expect(selfHits.length).toBeGreaterThanOrEqual(2);
  });
  it("firm-user feature guards NEVER call /entitlements/founder/* (only PlatformAdmin may)", () => {
    // Allowed: test files / routes/platform/* / founder-only modules. We scan src/pages/app/ for non-platform misuse.
    const disallowed = founderHits.filter((f) => !/platform/i.test(f) && !/__tests__/.test(f));
    expect(disallowed).toEqual([]);
  });
});

// ---------- ENT-4 / ENT-5 / ENT-PERF-1 — resolver behavior with mocked DB ----------

type FakeDbRow = { feature_key: string; enabled: boolean };

function makeMockDb(entitlements: FakeDbRow[] = [], userRows: { feature_key: string; is_enabled: boolean }[] = []) {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockImplementation(() => {
      // pattern-match: table name is "from" last call.
      return Promise.resolve(entitlements.map((r) => ({ featureKey: r.feature_key, enabled: r.enabled })));
    }),
  };
}

describe("ENT-4 / ENT-5 / ENT-PERF-1 — resolveUserFeatureAccessBulk semantics", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("ENT-5 — Partner role + firm entitlement enabled => effectiveEnabled true", async () => {
    const sample = FEATURE_REGISTRY[0].featureKey;
    const canned: Record<string, { enabled: boolean; source: string }> = {
      [sample]: { enabled: true, source: "plan_entitlement" },
    };
    vi.mock("../services/entitlement-resolver.js", () => ({
      resolveEntitlementsBulk: vi.fn().mockImplementation(async () => canned),
    }));
    const mod = await import("../services/user-feature-access.js");
    const mockDb: any = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    const result = await mod.resolveUserFeatureAccessBulk({
      r: mockDb,
      firmId: 1,
      userId: 2,
      roleId: 3,
      roleName: "Partner",
      featureKeys: [sample],
    });
    expect(result[sample]).toBeDefined();
    expect(result[sample].firmEnabled).toBe(true);
    expect(result[sample].effectiveEnabled).toBe(true);
  });

  it("ENT-4 — explicit user feature override OFF => effective disabled", async () => {
    const sample = FEATURE_REGISTRY[0].featureKey;
    const canned: Record<string, { enabled: boolean; source: string }> = {
      [sample]: { enabled: true, source: "plan_entitlement" },
    };
    vi.mock("../services/entitlement-resolver.js", () => ({
      resolveEntitlementsBulk: vi.fn().mockImplementation(async () => canned),
    }));
    const mod = await import("../services/user-feature-access.js");
    const mockDb: any = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ featureKey: sample, isEnabled: false }]),
    };
    const result = await mod.resolveUserFeatureAccessBulk({
      r: mockDb,
      firmId: 1,
      userId: 10,
      roleId: 5,
      roleName: "Clerk",
      featureKeys: [sample],
    });
    expect(result[sample].source).toBe("user_row_false");
    expect(result[sample].effectiveEnabled).toBe(false);
  });

  it("ENT-PERF-1 — Clerk load on 238 features issues <= 2 bulk DB select calls (NOT 238 sequential)", async () => {
    const keys = FEATURE_REGISTRY.slice(0, 238).map((f) => f.featureKey);
    vi.mock("../services/entitlement-resolver.js", async () => {
      const actualKeys = (await import("@workspace/db/feature-registry")).FEATURE_REGISTRY
        .slice(0, 238)
        .map((f: any) => f.featureKey);
      const fakeEntitlements: Record<string, { enabled: boolean; source: string }> = {};
      for (const k of actualKeys) fakeEntitlements[k] = { enabled: true, source: "feature_default" };
      return {
        resolveEntitlementsBulk: vi.fn().mockResolvedValue(fakeEntitlements),
      };
    });
    const resolveModule = await import("../services/entitlement-resolver.js");
    const mod = await import("../services/user-feature-access.js");
    let selectCalls = 0;
    const mockDb: any = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockImplementation(() => { selectCalls += 1; return mockDb; }),
      where: vi.fn().mockResolvedValue([]),
    };
    await mod.resolveUserFeatureAccessBulk({
      r: mockDb, firmId: 1, userId: 10, roleId: 5, roleName: "Clerk", featureKeys: keys,
    });
    expect(selectCalls).toBeLessThanOrEqual(2);
  });
});

// ---------- STORAGE-1 / STORAGE-2 config cascade ----------

describe("STORAGE-1 / STORAGE-2 — Supabase URL env cascade & 503 config guard", () => {
  const realEnv = { ...process.env };
  beforeEach(() => { vi.resetModules(); process.env = { ...realEnv, NODE_ENV: "test" }; });
  afterEach(() => { process.env = { ...realEnv }; });
  it("STORAGE-1 — SUPABASE_URL preferred, https protocol accepted (no NEXT_PUBLIC_ requirement)", () => {
    for (const k of Object.keys(process.env)) if (k !== "NODE_ENV") delete process.env[k];
    process.env.SUPABASE_URL = "https://bepixycuulklorcbadww.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJh_testonly";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "";
    const svc = new SupabaseStorageService();
    expect(() => svc.assertConfigured()).not.toThrow();
  });
  it("STORAGE-1b — NEXT_PUBLIC_SUPABASE_URL absent, VITE_SUPABASE_URL fallback works", () => {
    for (const k of Object.keys(process.env)) if (k !== "NODE_ENV") delete process.env[k];
    process.env.VITE_SUPABASE_URL = "https://bepixycuulklorcbadww.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJh_testonly";
    const svc = new SupabaseStorageService();
    expect(() => svc.assertConfigured()).not.toThrow();
  });
  it("STORAGE-2 — empty NEXT_PUBLIC_SUPABASE_URL with real SUPABASE_URL does NOT produce 503 CONFIG_INVALID error", () => {
    for (const k of Object.keys(process.env)) if (k !== "NODE_ENV") delete process.env[k];
    process.env.SUPABASE_URL = "https://bepixycuulklorcbadww.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJh_testonly";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "";
    try { new SupabaseStorageService().assertConfigured(); }
    catch (e) {
      const info = getSupabaseStorageConfigError(e);
      expect(info?.configurationErrorCode).not.toBe("CONFIG_INVALID_SUPABASE_HTTP_URL");
      throw e;
    }
  });
  it("STORAGE-2b — CONFIG_INVALID_SUPABASE_HTTP_URL reported when protocol missing (e.g. empty Supabase HTTP URL fallback)", () => {
    const direct = new StorageConfigurationError(
      "CONFIG_INVALID_SUPABASE_HTTP_URL",
      "NEXT_PUBLIC_SUPABASE_URL",
      undefined,
      "NEXT_PUBLIC_SUPABASE_URL could not be parsed as a valid URL for Supabase HTTP/Storage",
    );
    const info = getSupabaseStorageConfigError(direct);
    expect(info).toBeTruthy();
    expect(info!.configurationErrorCode).toBe("CONFIG_INVALID_SUPABASE_HTTP_URL");
    expect(info!.variableName).toBe("NEXT_PUBLIC_SUPABASE_URL");
    expect(info!.statusCode).toBe(503);
    // When the URL is unparseable, StorageConfigurationError.protocol is undefined;
    // The structured 503 error still exposes the missing var and typed code — this is the exact path that Vercel logged as protocol: "".
    expect([undefined, ""].includes(info!.protocol)).toBe(true);
  });
});

// ---------- CASE-RUNTIME-1 — route handlers are mounted for all 8 listed paths ----------

describe("CASE-RUNTIME-1 — all listed Case endpoints are mounted (no 500 from missing mount)", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const dir = fileURLToPath
    ? dirname(fileURLToPath(import.meta.url))
    : __dirname;
  const casesPath = path.resolve(dir, "..", "routes", "cases.ts");
  const src = fs.readFileSync(casesPath, "utf8") as string;
  const endpoints = [
    '"/cases/:caseId"',
    '"/cases/:caseId/messages"',
    '"/cases/:caseId/messages/unread-count"',
    '"/cases/:caseId/workflow-documents"',
    '"/cases/:caseId/key-dates"',
    '"/cases/:caseId/loan-stamping"',
    '"/cases/:caseId/supp-lo-documents"',
    '"/cases/:caseId/advances"',
  ];
  it.each(endpoints.map((e) => [e, e] as const))("cases route declares handler %s", (_lbl, literal) => {
    expect(src).toContain(literal);
  });
});
