import { describe, expect, it, vi } from "vitest";

describe("loadFounderPermissions", () => {
  it("merges DEFAULT founder permissions even when DB returns partial permissions", async () => {
    const prev = { ...process.env };
    try {
      vi.resetModules();
      vi.doMock("@workspace/db", () => {
        const rows = [{ perm: "founder.documents.read", level: "viewer" }];
        const chain = {
          innerJoin: () => chain,
          where: async () => rows,
        };
        return {
          clearTenantContext: async () => {},
          db: { select: () => ({ from: () => chain }) },
          makeRlsDb: () => ({}),
          permissionsTable: {},
          pool: { connect: async () => { throw new Error("pool.connect not mocked"); } },
          rolesTable: {},
          sessionsTable: {},
          setTenantContextSession: async () => {},
          sql: (strings: TemplateStringsArray) => strings.join(""),
          usersTable: {},
          auditLogsTable: {},
          platformFounderRolePermissionsTable: { permissionCode: "permission_code" },
          platformFounderRolesTable: { level: "level", id: "id" },
          platformFounderUserRolesTable: { userId: "user_id", roleId: "role_id" },
        };
      });

      const { loadFounderPermissions } = await import("../lib/auth");
      const result = await loadFounderPermissions({
        userId: 1,
        userType: "founder",
        email: "someone@example.com",
      } as any);

      expect(result.permissions).toContain("founder.ops.read");
      expect(result.permissions).toContain("founder.documents.read");
    } finally {
      process.env = prev;
      vi.resetModules();
    }
  });
});
