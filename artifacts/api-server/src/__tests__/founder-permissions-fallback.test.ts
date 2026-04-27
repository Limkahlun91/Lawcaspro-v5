import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", async (orig) => {
  const actual = await orig<typeof import("@workspace/db")>();

  const buildJoinChain = (impl: () => Promise<unknown[]>) => {
    const chain: any = {};
    chain.innerJoin = () => chain;
    chain.where = impl;
    return chain;
  };

  const mockDb = {
    ...actual.db,
    select: () => ({
      from: () => buildJoinChain(async () => {
        const e = new Error('relation "platform_founder_user_roles" does not exist') as Error & { code?: string };
        e.code = "42P01";
        throw e;
      }),
    }),
  };

  return { ...actual, db: mockDb as unknown as typeof actual.db };
});

describe("Founder permissions fallback", () => {
  it("returns fallback permissions for allowlisted founder when tables missing", async () => {
    const mod = await import("../lib/auth");
    const res = await mod.loadFounderPermissions({
      userId: 1,
      userType: "founder",
      email: "lun.6923@hotmail.com",
    } as any);
    expect(res.highestLevel).toBe("super_admin");
    expect(res.permissions).toContain("founder.ops.read");
    expect(res.permissions).toContain("founder.audit.read");
    expect(res.permissions).toContain("system.documents.read");
  });

  it("returns empty permissions for non-allowlisted founder when tables missing", async () => {
    const mod = await import("../lib/auth");
    const res = await mod.loadFounderPermissions({
      userId: 2,
      userType: "founder",
      email: "not-founder@example.com",
    } as any);
    expect(res.permissions).toEqual([]);
  });
});

