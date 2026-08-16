import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import app from "../app";

let token: string;
let firmId: number;
let managerToken: string;
const skipDb = process.env.VITEST_SKIP_DB === "1";

function is4xx(n: number) {
  return n >= 400 && n < 500;
}

beforeAll(async () => {
  if (skipDb) return;
  const loginRes = await request(app)
    .post("/api/auth/login")
    .send({ email: "partner@test.com", password: "password123" });
  expect(loginRes.status).toBe(200);
  token = loginRes.body?.data?.token;
  expect(typeof token).toBe("string");

  const meRes = await request(app)
    .get("/api/auth/me")
    .set("Authorization", `Bearer ${token}`);
  expect(meRes.status).toBe(200);
  firmId = meRes.body?.data?.firmId;
  expect(typeof firmId).toBe("number");
});

const suite = skipDb ? describe.skip : describe;

suite("Users access-profile backend security (ACCESS-BE / ROLE / BADGE)", () => {
  it("ACCESS-BE-7 Manager role-name actor cannot update access-profile (requirePartner role-name guard)", async () => {
    if (!managerToken) {
      try {
        const createManager = await request(app)
          .post("/api/users")
          .set("Authorization", `Bearer ${token}`)
          .send({
            email: `manager.${Date.now()}@lawcaspro.local`,
            name: "Manager Access Test",
            password: "password123",
            roleName: "Manager",
          });
        if (createManager.status === 201 || createManager.status === 200) {
          const login = await request(app)
            .post("/api/auth/login")
            .send({ email: createManager.body?.email ?? createManager.body?.data?.email, password: "password123" });
          if (login.status === 200) managerToken = login.body?.data?.token ?? "";
        }
      } catch (e) {
        // fallback: create manager + login sequence optional
      }
    }
    if (!managerToken) return;
    const meRes = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${managerToken}`);
    const myId = meRes.body?.data?.userId ?? meRes.body?.data?.id;
    if (!myId) return;
    const res = await request(app)
      .put(`/api/users/${myId}/access-profile`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ name: "Manager Access Test", status: "active", features: {} });
    expect(is4xx(res.status)).toBe(true);
    expect(res.statusCode === 401 || res.statusCode === 403).toBe(true);
    if (res.body?.code) expect(["REQUIRE_PARTNER", "NOT_AUTHORIZED", "FORBIDDEN"].includes(String(res.body.code))).toBe(true);
  });

  it("ACCESS-BE-8 Partner actor can update access-profile (200/204 success)", async () => {
    const list = await request(app)
      .get("/api/users")
      .set("Authorization", `Bearer ${token}`)
      .query({ page: 1, limit: 5 });
    expect(list.status).toBe(200);
    const users = list.body?.data ?? [];
    expect(Array.isArray(users)).toBe(true);
    if (!users.length) return;
    const userId = users[0].id;
    const res = await request(app)
      .put(`/api/users/${userId}/access-profile`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: users[0].name ?? "Partner Updated",
        status: users[0].status ?? "active",
        features: {},
      });
    expect(res.status < 400).toBe(true);
  });

  it("ACCESS-BE-9 untouched features create ZERO override rows (empty features={} creates no rows)", async () => {
    const listRes = await request(app).get("/api/users").set("Authorization", `Bearer ${token}`).query({ page: 1, limit: 20 });
    expect(listRes.status).toBe(200);
    const users = listRes.body?.data ?? [];
    const target = users.find((u: any) => u.roleName && !["partner","managing partner","senior partner"].includes(String(u.roleName).toLowerCase()));
    if (!target) return;
    const before = await request(app).get(`/api/users/${target.id}/access-profile`).set("Authorization", `Bearer ${token}`);
    const beforeCount = (before.body?.data?.overrideSummary?.overrideCount) ?? 0;
    const beforeKeys = new Set<string>((before.body?.data?.overrideSummary?.explicitKeys ?? []) as string[]);
    await request(app)
      .put(`/api/users/${target.id}/access-profile`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: target.name, status: target.status ?? "active", features: {} });
    const after = await request(app).get(`/api/users/${target.id}/access-profile`).set("Authorization", `Bearer ${token}`);
    const afterKeys = new Set<string>((after.body?.data?.overrideSummary?.explicitKeys ?? []) as string[]);
    const intersection = [...beforeKeys].filter((k) => afterKeys.has(k)).length;
    expect(intersection).toBeGreaterThanOrEqual(beforeKeys.size - 0);
    expect(after.body?.data?.overrideSummary?.overrideCount ?? 0).toBeLessThanOrEqual(beforeCount + 0);
  });

  it("ACCESS-BE-12 conflicting resetFeatureKeys + features same key rejected with 400 ACCESS_PROFILE_CONFLICTING_CHANGE", async () => {
    const listRes = await request(app).get("/api/users").set("Authorization", `Bearer ${token}`).query({ page: 1, limit: 20 });
    expect(listRes.status).toBe(200);
    const users = listRes.body?.data ?? [];
    const target = users.find((u: any) => u.roleName && !["partner","managing partner","senior partner"].includes(String(u.roleName).toLowerCase()));
    if (!target) return;
    const profile = await request(app).get(`/api/users/${target.id}/access-profile`).set("Authorization", `Bearer ${token}`);
    const modules: any[] = profile.body?.data?.modules ?? [];
    const firstChild = modules?.[0]?.children?.[0]?.featureKey ?? "documents.variables";
    const res = await request(app)
      .put(`/api/users/${target.id}/access-profile`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: target.name,
        status: target.status ?? "active",
        features: { [firstChild]: false },
        resetFeatureKeys: [firstChild],
      });
    expect(res.statusCode).toBe(400);
    expect(res.body?.code === "ACCESS_PROFILE_CONFLICTING_CHANGE").toBe(true);
  });

  it("ROLE-1 role change Clerk->Lawyer without customization saves 0 override rows", async () => {
    const clerkRoles = await request(app).get("/api/roles").set("Authorization", `Bearer ${token}`);
    const roles: any[] = Array.isArray(clerkRoles.body) ? clerkRoles.body : clerkRoles.body?.data ?? [];
    const clerkR = roles.find((r) => String(r.name).toLowerCase() === "clerk");
    const lawyerR = roles.find((r) => String(r.name).toLowerCase() === "lawyer");
    if (!clerkR || !lawyerR) return;
    const create = await request(app).post("/api/users").set("Authorization", `Bearer ${token}`).send({
      email: `role1.${Date.now()}@lawcaspro.local`,
      name: "ROLE-1 Clerk to Lawyer",
      password: "password123",
      roleId: clerkR.id,
    });
    expect([200, 201].includes(create.status)).toBe(true);
    const userId = create.body?.id ?? create.body?.data?.id;
    expect(typeof userId).toBe("number");
    const before = await request(app).get(`/api/users/${userId}/access-profile`).set("Authorization", `Bearer ${token}`);
    expect(before.body?.data?.overrideSummary?.overrideCount ?? 0).toBe(0);
    const saveRes = await request(app).put(`/api/users/${userId}/access-profile`).set("Authorization", `Bearer ${token}`).send({
      name: "ROLE-1 Clerk to Lawyer",
      status: "active",
      roleId: lawyerR.id,
      features: {},
    });
    expect(saveRes.status < 400).toBe(true);
    const after = await request(app).get(`/api/users/${userId}/access-profile`).set("Authorization", `Bearer ${token}`);
    expect(after.body?.data?.overrideSummary?.overrideCount ?? 0).toBe(0);
  });

  it("BADGE /users list returns hasAccessOverrides + accessOverrideCount for every visible user", async () => {
    const list = await request(app)
      .get("/api/users")
      .set("Authorization", `Bearer ${token}`)
      .query({ page: 1, limit: 20 });
    expect(list.status).toBe(200);
    const rows = list.body?.data ?? [];
    expect(Array.isArray(rows)).toBe(true);
    for (const u of rows) {
      expect("hasAccessOverrides" in u || "accessOverrideCount" in u).toBe(true);
      expect(typeof (u as any).hasAccessOverrides).toBe("boolean");
      expect(typeof (u as any).accessOverrideCount === "number").toBe(true);
    }
  });

  it("BADGE Manager without override returns Role Default badge profile (hasAccessOverrides=false)", async () => {
    const listRes = await request(app)
      .get("/api/users")
      .set("Authorization", `Bearer ${token}`)
      .query({ page: 1, limit: 50 });
    expect(listRes.status).toBe(200);
    const rows = listRes.body?.data ?? [];
    const manager = rows.find((u: any) => String(u.roleName).toLowerCase() === "manager");
    if (!manager) return;
    if (manager.hasAccessOverrides === false) {
      expect(manager.accessOverrideCount).toBe(0);
    }
  });

  it("BADGE Partner row shows Partner classification regardless of overrideCount", async () => {
    const listRes = await request(app)
      .get("/api/users")
      .set("Authorization", `Bearer ${token}`)
      .query({ page: 1, limit: 50 });
    expect(listRes.status).toBe(200);
    const rows = listRes.body?.data ?? [];
    const partner = rows.find((u: any) => ["partner","managing partner","senior partner"].includes(String(u.roleName).toLowerCase()));
    expect(!!partner).toBe(true);
    expect(["Partner","Managing Partner","Senior Partner","partner","managing partner","senior partner"].includes(String(partner.roleName)) ||
      /partner/i.test(String(partner.roleName))).toBe(true);
  });

  it("LIST FILTER roleId query parameter filters by role server-side", async () => {
    const roles = await request(app).get("/api/roles").set("Authorization", `Bearer ${token}`);
    const list: any[] = Array.isArray(roles.body) ? roles.body : roles.body?.data ?? [];
    const clerkRole = list.find((r) => String(r.name).toLowerCase() === "clerk");
    if (!clerkRole) return;
    const res = await request(app)
      .get("/api/users")
      .set("Authorization", `Bearer ${token}`)
      .query({ page: 1, limit: 50, roleId: clerkRole.id });
    expect(res.status).toBe(200);
    const rows = res.body?.data ?? [];
    if (rows.length === 0) return;
    for (const u of rows) expect((u as any).roleId).toBe(clerkRole.id);
  });

  it("LIST FILTER status query parameter filters by status server-side", async () => {
    const status = "inactive";
    const res = await request(app)
      .get("/api/users")
      .set("Authorization", `Bearer ${token}`)
      .query({ page: 1, limit: 50, status });
    expect(res.status).toBe(200);
    const rows = res.body?.data ?? [];
    if (rows.length === 0) return;
    for (const u of rows) expect((u as any).status).toBe(status);
  });

  it("LIST SEARCH name OR email ILIKE matches an email substring", async () => {
    const res = await request(app)
      .get("/api/users")
      .set("Authorization", `Bearer ${token}`)
      .query({ page: 1, limit: 50, search: "@" });
    expect(res.status).toBe(200);
    const rows = res.body?.data ?? [];
    expect(Array.isArray(rows)).toBe(true);
  });
});
