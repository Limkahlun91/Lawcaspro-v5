import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

import type { RequestFirmRoleContext } from "../services/user-feature-access.js";
import { resolveRequestFirmRoleName } from "../services/user-feature-access.js";
import { FEATURE_REGISTRY } from "@workspace/db";

describe("Part1 §G.1: Partner role resolution FROM CACHE (_roleCache populated)", () => {
  it("Uses cached Partner role name WITHOUT querying DB when cache matches firmId+roleId", async () => {
    let dbSelectCalled = false;
    const fakeR = {
      select: () => {
        dbSelectCalled = true;
        return {
          from: () => ({ where: () => ({ limit: async () => [] }) }),
        };
      },
    } as any;

    const ctx: RequestFirmRoleContext = {
      firmId: 10,
      roleId: 5,
      _roleCache: { firmId: 10, roleId: 5, name: "PARTNER" },
    };

    const name = await resolveRequestFirmRoleName(ctx, fakeR);

    expect(name).toBe("PARTNER");
    expect(dbSelectCalled).toBe(false);
    expect(ctx._roleCache?.name).toBe("PARTNER");
  });
});

describe("Part1 §G.2: Partner role FALLBACK resolution — cache updates on valid DB fetch", () => {
  it("Fetches role name from RLS-scoped roles table (cache MISMATCH → DB hit), UPDATE existing ctx._roleCache with resolved name", async () => {
    let dbSelectInvoked = false;
    const fakeR = {
      select: (proj: any) => {
        expect(Object.keys(proj)).toContain("name");
        dbSelectInvoked = true;
        return {
          from: (_t: any) => ({
            where: (_w: any) => ({
              limit: async (_n: number) => [{ name: "PARTNER" }],
            }),
          }),
        };
      },
    } as any;

    // Helper ONLY updates cache if it was already defined (safety guard).
    // Also the cache HIT path REQUIRES cached.firmId === firmId AND cached.roleId === roleId.
    // So set cache with MISMATCHED roleId/firmId → forces MISS → DB lookup → update existing cache
    const ctx: RequestFirmRoleContext = {
      firmId: 42,
      roleId: 7,
      _roleCache: { firmId: 1, roleId: 999, name: "OLD_ROLE" }, // wrong firm+role → cache miss
    };

    const name = await resolveRequestFirmRoleName(ctx, fakeR);

    expect(dbSelectInvoked).toBe(true); // proof it fell through to DB (not cache hit)
    expect(name).toBe("PARTNER");
    expect(ctx._roleCache).toBeDefined();
    // Cache should be mutated now to the valid DB-resolved tuple
    expect(ctx._roleCache!.firmId).toBe(42);
    expect(ctx._roleCache!.roleId).toBe(7);
    expect(ctx._roleCache!.name).toBe("PARTNER");
  });
});

describe("Part1 §G.3: Wrong-firm role MUST be rejected", () => {
  it("Role belonging to firmA, ctx.firmId=firmB => returns null, cache NOT set", async () => {
    // Simulate: DB WHERE combined id + firm_id finds no match (different firm)
    const fakeR = {
      select: (_proj: any) => ({
        from: (_t: any) => ({
          where: (_w: any) => ({
            limit: async (_n: number) => [], // no rows = wrong firm for this role
          }),
        }),
      }),
    } as any;

    const ctx: RequestFirmRoleContext = {
      firmId: 777,
      roleId: 3,
      _roleCache: undefined,
    };

    const name = await resolveRequestFirmRoleName(ctx, fakeR);

    expect(name).toBeNull();
    expect(ctx._roleCache).toBeUndefined();
  });

  it("Rejects cache when roleCache.firmId does not match ctx.firmId", async () => {
    const fakeR = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    } as any;

    const ctx: RequestFirmRoleContext = {
      firmId: 999,
      roleId: 1,
      // roleCache is for a DIFFERENT firm (should be invalidated)
      _roleCache: { firmId: 111, roleId: 1, name: "PARTNER" },
    };

    const name = await resolveRequestFirmRoleName(ctx, fakeR);
    // Must NOT use stale cross-firm cache. Falls back to DB which returns empty.
    expect(name).toBeNull();
  });
});

describe("Part1 §G.4: Firm entitlement OFF still DENIES Partner (structural source assertion)", () => {
  it("resolveUserFeatureAccessBulk checks parentFirmEnabled BEFORE isPartner partner_allow (Partner CANNOT bypass firm entitlements)", () => {
    const svcSrc = readFileSync(
      pathResolve(__dirname, "..", "services", "user-feature-access.ts"),
      "utf8"
    );
    const parentFirmEnabledIdx = svcSrc.indexOf("parentFirmEnabled(k)");
    const partnerBranchIdx = svcSrc.indexOf("if (isPartner) {");
    const partnerAllowIdx = svcSrc.indexOf('source: "partner_allow"');
    expect(parentFirmEnabledIdx).toBeGreaterThan(-1);
    expect(partnerBranchIdx).toBeGreaterThan(parentFirmEnabledIdx);
    expect(partnerAllowIdx).toBeGreaterThan(parentFirmEnabledIdx);

    // After parentFirmEnabled check, firm denial results are written with firm_entitlement_denied source
    // BEFORE partner_allow.
    const afterFirmEnabled = svcSrc.slice(parentFirmEnabledIdx);
    const firstDeniedAfter = afterFirmEnabled.indexOf('firm_entitlement_denied');
    const firstPartnerAllowAfter = afterFirmEnabled.indexOf('partner_allow');
    expect(firstDeniedAfter).toBeGreaterThan(-1);
    expect(firstPartnerAllowAfter).toBeGreaterThan(firstDeniedAfter);
  });
});

describe("Part1 §G.5: non-Partner — explicit user OFF row returns user_row_false (structural assertion)", () => {
  it("resolveUserFeatureAccessBulk maps explicit false user row to source=user_row_false + USER_OVERRIDE_OFF denialCode", () => {
    const svcSrc = readFileSync(
      pathResolve(__dirname, "..", "services", "user-feature-access.ts"),
      "utf8"
    );
    // STEP 3 block: userRows.has(k) → explicit → user_row_true / user_row_false
    const step3Marker = svcSrc.indexOf("if (userRows.has(k)) {");
    expect(step3Marker).toBeGreaterThan(-1);
    const userRowFalseSrc = svcSrc.indexOf('source: "user_row_false"');
    const denialCodeOff = svcSrc.indexOf('denialCode: "USER_OVERRIDE_OFF"');
    const userRowFalseExpl = svcSrc.indexOf("const explicit = userRows.get(k)!");
    expect(userRowFalseExpl).toBeGreaterThan(step3Marker);
    expect(userRowFalseSrc).toBeGreaterThan(step3Marker);
    expect(denialCodeOff).toBeGreaterThan(step3Marker);
  });
});

describe("Part1 §G.6: Non-Partner — role fallback (structural assertion)", () => {
  it("resolveUserFeatureAccessBulk STEP 4 calls permissionChecker → role_permission_allow / role_permission_denied", () => {
    const svcSrc = readFileSync(
      pathResolve(__dirname, "..", "services", "user-feature-access.ts"),
      "utf8"
    );
    // STEP 4 marker: permissionChecker call + two result sources
    const step4Marker = svcSrc.indexOf("// STEP 4 — Fallback role permission");
    const permChecker = svcSrc.indexOf("permissionChecker(hint.mod, hint.action)");
    const allowSrc = svcSrc.indexOf('source: "role_permission_allow"');
    const denySrc = svcSrc.indexOf('source: "role_permission_denied"');
    const denyCode = svcSrc.indexOf('denialCode: "ROLE_DENIED"');
    expect(step4Marker).toBeGreaterThan(-1);
    expect(permChecker).toBeGreaterThan(step4Marker);
    expect(allowSrc).toBeGreaterThan(step4Marker);
    expect(denySrc).toBeGreaterThan(step4Marker);
    expect(denyCode).toBeGreaterThan(step4Marker);
  });
});

describe("Part1 §G.7: Every new/active requireUserFeatureAccess key exists in feature registry source", () => {
  const routeFiles = [
    ["accounting.ts", "accounting"],
    ["quotations.ts", "quotations"],
    ["firm-settings.ts", "firmSettings"],
    ["users.ts", "users"],
  ] as const;

  const activeKeys = [
    "accounting.quotation",
    "accounting.payment_voucher",
    "accounting.bank_account",
    "accounting.bank_transaction",
    "accounting.invoice",
    "accounting.receipt",
    "accounting.dashboard",
    "accounting.reports",
    "documents.variables",
    "documents.templates",
    "documents.hub",
    "reports.accounting",
    "reports.case",
    "module.hr",
    "module.accounting",
    "module.reports",
  ];

  const registrySrc = readFileSync(
    pathResolve(__dirname, "../../../../lib/db/src/feature-registry.ts"),
    "utf8"
  );
  // Extract every featureKey: "..." value from the registry source.
  const featureKeyRe = /featureKey:\s*["'`]([^"'`]+)["'`]/g;
  let fm: RegExpExecArray | null;
  const registeredKeys = new Set<string>();
  while ((fm = featureKeyRe.exec(registrySrc)) !== null) registeredKeys.add(fm[1]);

  it.each(activeKeys)("Registry source declares feature key: %s", (key) => {
    expect(registeredKeys.has(key)).toBe(true);
  });

  it("PART1-G7-A: PLURAL accounting.bank_accounts is NOT a registry-declared feature key (canonical is SINGULAR accounting.bank_account)", () => {
    expect(registeredKeys.has("accounting.bank_accounts"), "accounting.bank_accounts (plural) must NOT be a registered feature key; canonical is accounting.bank_account").toBe(false);
    expect(registeredKeys.has("accounting.bank_account"), "accounting.bank_account (singular) MUST be registered").toBe(true);
  });

  it("PART1-G7-B: activeKeys list does NOT contain the PLURAL accounting.bank_accounts (regression guard)", () => {
    expect(activeKeys.includes("accounting.bank_accounts"), "activeKeys should NOT contain PLURAL accounting.bank_accounts").toBe(false);
  });

  it("No route in accounting.ts references an unregistered feature key", () => {
    const src = readFileSync(
      pathResolve(__dirname, "..", "routes", "accounting.ts"),
      "utf8"
    );
    const re = /requireUserFeatureAccess\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
    let m: RegExpExecArray | null;
    const found: string[] = [];
    while ((m = re.exec(src)) !== null) found.push(m[1]);

    expect(found.length).toBeGreaterThan(5);
    for (const key of found) {
      expect(registeredKeys.has(key)).toBe(true);
    }
    // Extra guard: no plural key in accounting.ts feature guards
    expect(found.includes("accounting.bank_accounts"), "accounting.ts must never use PLURAL accounting.bank_accounts as a feature key").toBe(false);
  });

  it("No route in quotations.ts references an unregistered feature key", () => {
    const src = readFileSync(
      pathResolve(__dirname, "..", "routes", "quotations.ts"),
      "utf8"
    );
    const re = /requireUserFeatureAccess\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
    let m: RegExpExecArray | null;
    const found: string[] = [];
    while ((m = re.exec(src)) !== null) found.push(m[1]);

    expect(found.length).toBeGreaterThanOrEqual(5);
    for (const key of found) {
      expect(registeredKeys.has(key)).toBe(true);
    }
  });

  it("No route in firm-settings.ts references an unregistered feature key (incl. accounting.bank_account SINGULAR, NO PLURAL)", () => {
    const src = readFileSync(
      pathResolve(__dirname, "..", "routes", "firm-settings.ts"),
      "utf8"
    );
    const re = /requireUserFeatureAccess\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
    let m: RegExpExecArray | null;
    const found: string[] = [];
    while ((m = re.exec(src)) !== null) found.push(m[1]);

    expect(found.includes("accounting.bank_account"), "firm-settings.ts must require accounting.bank_account feature for bank account mutations").toBe(true);
    for (const key of found) {
      expect(registeredKeys.has(key), `firm-settings.ts uses unregistered feature key: ${key}`).toBe(true);
    }
    expect(found.includes("accounting.bank_accounts"), "firm-settings.ts must never use PLURAL accounting.bank_accounts as a feature key").toBe(false);
  });

  it("PART1-G7-C: users.ts HUMAN_LABELS uses SINGULAR accounting.bank_account (NOT plural) for the Bank Accounts label", () => {
    const usersSrc = readFileSync(
      pathResolve(__dirname, "..", "routes", "users.ts"),
      "utf8"
    );
    expect(usersSrc).toContain('"accounting.bank_account": "Bank Accounts"');
    expect(usersSrc).not.toContain('"accounting.bank_accounts": "Bank Accounts"');
  });
});

describe("Part1 §G.8: Representative tenant routes use REQUEST-SCOPED DB (req.rlsDb)", () => {
  it("accounting.ts: NO bare `await queryRows(sql` calls remain in handler paths (all must be FromReq)", () => {
    const src = readFileSync(
      pathResolve(__dirname, "..", "routes", "accounting.ts"),
      "utf8"
    );
    // Count bare "await queryRows(" (the helper backed by global db)
    const bareMatches = src.match(/await\s+queryRows\s*\(/g) ?? [];
    expect(bareMatches.length).toBe(0);
  });

  it("accounting.ts: ALL sql calls in tenant handlers use queryRowsFromReq(req,...)", () => {
    const src = readFileSync(
      pathResolve(__dirname, "..", "routes", "accounting.ts"),
      "utf8"
    );
    const fromReqMatches = src.match(/queryRowsFromReq\s*\(\s*req/g) ?? [];
    expect(fromReqMatches.length).toBeGreaterThanOrEqual(20);
  });

  it("quotations.ts: handler-bodies drizzle `await db.` calls NOT present for tenant queries (they should be rdb(req))", () => {
    const src = readFileSync(
      pathResolve(__dirname, "..", "routes", "quotations.ts"),
      "utf8"
    );
    // Grep for `await db.` in the source. The ONLY valid calls should be inside
    // getActiveRule() helper which reads platform regulatory tables (non-firm).
    const awaitDbDot = src.match(/await\s+db\.\s*(select|insert|update|delete|transaction)\s*\(/g) ?? [];
    const lines = src.split("\n");
    const handlerAwaitDb = lines.filter((ln, idx) => {
      if (!/await\s+db\.\s*(select|insert|update|delete|transaction)\s*\(/.test(ln)) return false;
      // Exclude lines inside getActiveRule function (L700-720ish approx) — check by nearby context
      // Instead: count total `await db.` drizzle calls, there should be exactly 2 for platform regulatory.
      return true;
    });
    // Exactly 2 await db. drizzle calls allowed in quotations.ts (platform getActiveRule)
    expect(awaitDbDot.length).toBeLessThanOrEqual(2);
    expect(handlerAwaitDb.length).toBeLessThanOrEqual(2);
  });
});

describe("Part1 §G.9: Bank-accounts TENANT route does NOT use global db", () => {
  it("GET/POST/PATCH/DELETE bank-accounts handlers call queryRowsFromReq(...) and NO bare queryRows(...)", () => {
    const src = readFileSync(
      pathResolve(__dirname, "..", "routes", "accounting.ts"),
      "utf8"
    );
    const lines = src.split("\n");

    // More robustly: find each router.VERB around "/accounting/bank-accounts" and check their body.
    const handlerLocs: { line0: number; text: string }[] = [];
    lines.forEach((ln, i) => {
      if (/router\.(get|post|patch|delete)\s*\(\s*["'`]\/accounting\/bank-accounts[^"'`]*["'`]/.test(ln)) {
        handlerLocs.push({ line0: i, text: ln });
      }
    });

    expect(handlerLocs.length).toBe(4);

    // For each handler, scan the next 120 lines (covers body + closing } of async arrow)
    for (const h of handlerLocs) {
      const window = lines.slice(h.line0, h.line0 + 120).join("\n");
      const fromReq = (window.match(/queryRowsFromReq\s*\(/g) ?? []).length;
      const bare = (window.match(/await\s+queryRows\s*\(/g) ?? []).length;
      expect(fromReq).toBeGreaterThanOrEqual(1);
      expect(bare).toBe(0);
    }
  });
});
