import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { db, pool, rolesTable, permissionsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { seedIfEmpty } from "../lib/seed";

let app: Express;

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);

beforeAll(async () => {
  if (!hasDatabaseUrl) return;
  process.env.SEED_DEMO_DATA = process.env.SEED_DEMO_DATA ?? "1";
  await seedIfEmpty();
  const mod = await import("../app");
  app = mod.default;
});

describe("Success path (integration)", () => {
  it.skipIf(!hasDatabaseUrl)("login -> me -> users.create -> hub.documents", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE app_user");
      await client.query("RESET ROLE");
      await client.query("COMMIT");
    } catch {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
      return;
    } finally {
      client.release();
    }

    const email = process.env.SMOKE_EMAIL ?? "partner@tan-associates.my";
    const password = process.env.SMOKE_PASSWORD ?? "partner123";
    const login = await request(app).post("/api/auth/login").send({ email, password });
    expect(login.status).toBe(200);
    const setCookieHeader = (login.headers as Record<string, unknown>)["set-cookie"];
    const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [];
    const authCookie = cookies.find((c) => typeof c === "string" && c.startsWith("auth_token="));
    expect(typeof authCookie).toBe("string");

    const cookie = String(authCookie).split(";", 1)[0];

    const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(me.status).toBe(200);
    expect(me.body).toHaveProperty("firmId");
    expect(me.body).toHaveProperty("roleId");

    const roleId = typeof me.body?.roleId === "number" ? me.body.roleId : null;
    const firmId = typeof me.body?.firmId === "number" ? me.body.firmId : null;
    expect(roleId).toBeTruthy();
    expect(firmId).toBeTruthy();

    const [role] = await db
      .select()
      .from(rolesTable)
      .where(and(eq(rolesTable.id, roleId!), eq(rolesTable.firmId, firmId!)));
    expect(role).toBeTruthy();

    const needed = [
      { module: "users", action: "create" },
      { module: "users", action: "delete" },
      { module: "documents", action: "read" },
    ];

    for (const p of needed) {
      const [existing] = await db
        .select()
        .from(permissionsTable)
        .where(and(
          eq(permissionsTable.roleId, roleId!),
          eq(permissionsTable.module, p.module),
          eq(permissionsTable.action, p.action),
        ));
      if (!existing) {
        await db.insert(permissionsTable).values({
          roleId: roleId!,
          module: p.module,
          action: p.action,
          allowed: true,
        });
      }
    }

    const createdEmail = `it+${Date.now()}@example.com`;
    const create = await request(app).post("/api/users").set("Cookie", cookie).send({
      email: createdEmail,
      name: "Integration User",
      password: "P@ssw0rd123!",
      roleId: roleId!,
    });
    expect(create.status).toBe(201);
    expect(create.body).toHaveProperty("id");

    const docs = await request(app).get("/api/hub/documents").set("Cookie", cookie);
    expect(docs.status).toBe(200);
    expect(Array.isArray(docs.body)).toBe(true);

    const newUserId = typeof create.body?.id === "number" ? create.body.id : null;
    if (newUserId) {
      await request(app).delete(`/api/users/${newUserId}`).set("Cookie", cookie);
      for (const p of needed) {
        await db
          .delete(permissionsTable)
          .where(and(
            eq(permissionsTable.roleId, roleId!),
            eq(permissionsTable.module, p.module),
            eq(permissionsTable.action, p.action),
          ));
      }
    }
  });
});
