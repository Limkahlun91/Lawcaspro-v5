import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../lib/db/scripts/manual-migrations/postconditions.mjs", () => {
  return {
    verifyMigrationPostconditions: vi.fn(),
  };
});

async function mkTmpMigrationsDir(files: Array<{ name: string; sql: string }>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lawcaspro-migrations-"));
  for (const f of files) fs.writeFileSync(path.join(dir, f.name), f.sql, "utf8");
  return dir;
}

describe("manual-migrations runner", () => {
  it("successful migration commits schema + tag + checksum atomically", async () => {
    const { applyOne } = await import("../../../../lib/db/scripts/manual-migrations/runner.mjs");
    const post: any = await import("../../../../lib/db/scripts/manual-migrations/postconditions.mjs");
    post.verifyMigrationPostconditions.mockResolvedValueOnce({ ok: true, issues: [] });

    const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const client: any = {
      query: vi.fn((sql: string, params?: unknown[]) => {
        calls.push({ sql: String(sql).trim(), params });
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    };

    const res = await applyOne({
      client,
      fileName: "0126_payment_voucher_create_request_tracking.sql",
      sqlText: "select 1;",
    });

    expect(res.status).toBe("applied");
    const sqls = calls.map((c) => c.sql.toLowerCase());
    expect(sqls[0]).toBe("begin");
    expect(sqls).toContain("select 1;");
    expect(sqls.some((s) => s.includes("insert into public.lawcaspro_manual_migrations"))).toBe(true);
    expect(sqls.some((s) => s.includes("insert into public.lawcaspro_manual_migration_checksums"))).toBe(true);
    expect(sqls[sqls.length - 1]).toBe("commit");
    expect(sqls).not.toContain("rollback");
  });

  it("migration SQL failure rolls back everything", async () => {
    const { applyOne } = await import("../../../../lib/db/scripts/manual-migrations/runner.mjs");
    const post: any = await import("../../../../lib/db/scripts/manual-migrations/postconditions.mjs");
    post.verifyMigrationPostconditions.mockResolvedValueOnce({ ok: true, issues: [] });

    const calls: string[] = [];
    const client: any = {
      query: vi.fn((sql: string) => {
        calls.push(String(sql).trim().toLowerCase());
        if (String(sql).includes("select 1")) throw Object.assign(new Error("sql failed"), { code: "XX000" });
        return Promise.resolve({ rows: [] });
      }),
    };

    await expect(
      applyOne({
        client,
        fileName: "0126_payment_voucher_create_request_tracking.sql",
        sqlText: "select 1;",
      }),
    ).rejects.toThrow("sql failed");

    expect(calls[0]).toBe("begin");
    expect(calls).toContain("rollback");
    expect(calls).not.toContain("commit");
    expect(calls.some((s) => s.includes("insert into public.lawcaspro_manual_migrations"))).toBe(false);
    expect(calls.some((s) => s.includes("insert into public.lawcaspro_manual_migration_checksums"))).toBe(false);
  });

  it("tag insert failure rolls back schema", async () => {
    const { applyOne } = await import("../../../../lib/db/scripts/manual-migrations/runner.mjs");
    const post: any = await import("../../../../lib/db/scripts/manual-migrations/postconditions.mjs");
    post.verifyMigrationPostconditions.mockResolvedValueOnce({ ok: true, issues: [] });

    const calls: string[] = [];
    const client: any = {
      query: vi.fn((sql: string) => {
        const s = String(sql).trim();
        calls.push(s);
        if (s.toLowerCase().includes("insert into public.lawcaspro_manual_migrations")) {
          throw Object.assign(new Error("tag insert failed"), { code: "23505" });
        }
        return Promise.resolve({ rows: [] });
      }),
    };

    await expect(
      applyOne({
        client,
        fileName: "0126_payment_voucher_create_request_tracking.sql",
        sqlText: "select 1;",
      }),
    ).rejects.toThrow("tag insert failed");

    expect(calls.map((x) => x.toLowerCase())).toContain("rollback");
    expect(calls.map((x) => x.toLowerCase())).not.toContain("commit");
    expect(calls.some((s) => s.toLowerCase().includes("insert into public.lawcaspro_manual_migration_checksums"))).toBe(false);
  });

  it("checksum insert failure rolls back schema and tag", async () => {
    const { applyOne } = await import("../../../../lib/db/scripts/manual-migrations/runner.mjs");
    const post: any = await import("../../../../lib/db/scripts/manual-migrations/postconditions.mjs");
    post.verifyMigrationPostconditions.mockResolvedValueOnce({ ok: true, issues: [] });

    const calls: string[] = [];
    const client: any = {
      query: vi.fn((sql: string) => {
        const s = String(sql).trim();
        calls.push(s);
        if (s.toLowerCase().includes("insert into public.lawcaspro_manual_migration_checksums")) {
          throw Object.assign(new Error("checksum insert failed"), { code: "23505" });
        }
        return Promise.resolve({ rows: [] });
      }),
    };

    await expect(
      applyOne({
        client,
        fileName: "0126_payment_voucher_create_request_tracking.sql",
        sqlText: "select 1;",
      }),
    ).rejects.toThrow("checksum insert failed");

    const lowered = calls.map((x) => x.toLowerCase());
    expect(lowered).toContain("rollback");
    expect(lowered).not.toContain("commit");
    expect(lowered.some((s) => s.includes("insert into public.lawcaspro_manual_migrations"))).toBe(true);
  });

  it("verify-only performs zero write statements", async () => {
    const { runMigrateSafe } = await import("../../../../lib/db/scripts/manual-migrations/runner.mjs");
    const post: any = await import("../../../../lib/db/scripts/manual-migrations/postconditions.mjs");
    post.verifyMigrationPostconditions.mockResolvedValue({ ok: false, issues: ["no_postcondition_verifier"] });

    const migrationsDir = await mkTmpMigrationsDir([
      { name: "0000_a.sql", sql: "select 1;" },
    ]);

    const sqls: string[] = [];
    const client: any = {
      query: vi.fn((sql: string) => {
        sqls.push(String(sql));
        if (String(sql).toLowerCase().includes("to_regclass")) {
          return Promise.resolve({ rows: [{ name: null }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    };

    const res = await runMigrateSafe({ client, migrationsDir, fromPrefix: "0000", mode: "verify" });
    expect(res.mode).toBe("verify");

    const lowered = sqls.map((s) => s.toLowerCase());
    expect(lowered.some((s) => s.includes("create table"))).toBe(false);
    expect(lowered.some((s) => s.includes("insert into"))).toBe(false);
    expect(lowered.some((s) => s.trim() === "begin")).toBe(false);
    expect(lowered.some((s) => s.trim() === "commit")).toBe(false);
    expect(lowered.some((s) => s.trim() === "rollback")).toBe(false);
  });

  it("checksum mismatch is a hard failure in apply mode", async () => {
    const { runMigrateSafe } = await import("../../../../lib/db/scripts/manual-migrations/runner.mjs");
    const post: any = await import("../../../../lib/db/scripts/manual-migrations/postconditions.mjs");
    post.verifyMigrationPostconditions.mockResolvedValue({ ok: true, issues: [] });

    const migrationsDir = await mkTmpMigrationsDir([
      { name: "0000_a.sql", sql: "select 1;" },
    ]);

    const client: any = {
      query: vi.fn((sql: string, params?: unknown[]) => {
        const s = String(sql).toLowerCase();
        if (s.includes("create table if not exists public.lawcaspro_manual_migrations")) return Promise.resolve({ rows: [] });
        if (s.includes("create table if not exists public.lawcaspro_manual_migration_checksums")) return Promise.resolve({ rows: [] });
        if (s.includes("select to_regclass")) return Promise.resolve({ rows: [{ name: "public.lawcaspro_manual_migrations" }], rowCount: 1 });
        if (s.includes("from public.lawcaspro_manual_migrations")) return Promise.resolve({ rows: [{ tag: params?.[0] }], rowCount: 1 });
        if (s.includes("from public.lawcaspro_manual_migration_checksums")) return Promise.resolve({ rows: [{ checksum_sha256: "different" }], rowCount: 1 });
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    };

    await expect(runMigrateSafe({ client, migrationsDir, fromPrefix: "0000", mode: "apply" })).rejects.toThrow(
      "checksum mismatch",
    );
  });

  it("legacy applied without checksum reports correctly", async () => {
    const { runMigrateSafe } = await import("../../../../lib/db/scripts/manual-migrations/runner.mjs");
    const post: any = await import("../../../../lib/db/scripts/manual-migrations/postconditions.mjs");
    post.verifyMigrationPostconditions.mockResolvedValue({ ok: true, issues: [] });

    const migrationsDir = await mkTmpMigrationsDir([
      { name: "0000_a.sql", sql: "select 1;" },
    ]);

    const client: any = {
      query: vi.fn((sql: string, params?: unknown[]) => {
        const s = String(sql).toLowerCase();
        if (s.includes("create table if not exists public.lawcaspro_manual_migrations")) return Promise.resolve({ rows: [] });
        if (s.includes("create table if not exists public.lawcaspro_manual_migration_checksums")) return Promise.resolve({ rows: [] });
        if (s.includes("select to_regclass")) return Promise.resolve({ rows: [{ name: "public.lawcaspro_manual_migrations" }], rowCount: 1 });
        if (s.includes("from public.lawcaspro_manual_migrations")) return Promise.resolve({ rows: [{ tag: params?.[0] }], rowCount: 1 });
        if (s.includes("from public.lawcaspro_manual_migration_checksums")) return Promise.resolve({ rows: [], rowCount: 0 });
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    };

    const res = await runMigrateSafe({ client, migrationsDir, fromPrefix: "0000", mode: "apply" });
    expect(res.summary[0]?.status).toBe("legacy_applied_without_checksum");
  });

  it("migration without a registered verifier fails safely after duplicate error", async () => {
    const { runMigrateSafe } = await import("../../../../lib/db/scripts/manual-migrations/runner.mjs");
    const post: any = await import("../../../../lib/db/scripts/manual-migrations/postconditions.mjs");
    post.verifyMigrationPostconditions.mockResolvedValue({ ok: false, issues: ["no_postcondition_verifier"] });

    const migrationsDir = await mkTmpMigrationsDir([
      { name: "0000_a.sql", sql: "select __DUP__;" },
    ]);

    const seen: string[] = [];
    const duplicate = Object.assign(new Error("already exists"), { code: "42P07" });
    const client: any = {
      query: vi.fn((sql: string) => {
        const s = String(sql).toLowerCase().trim();
        seen.push(s);
        if (s.includes("create table if not exists public.lawcaspro_manual_migrations")) return Promise.resolve({ rows: [] });
        if (s.includes("create table if not exists public.lawcaspro_manual_migration_checksums")) return Promise.resolve({ rows: [] });
        if (s.includes("select to_regclass")) return Promise.resolve({ rows: [{ name: "public.lawcaspro_manual_migrations" }], rowCount: 1 });
        if (s.includes("from public.lawcaspro_manual_migrations")) return Promise.resolve({ rows: [], rowCount: 0 });
        if (s === "begin") throw duplicate;
        const isControl =
          s === "begin" ||
          s === "commit" ||
          s === "rollback" ||
          s.includes("select") ||
          s.includes("insert into public.lawcaspro_manual_migrations") ||
          s.includes("insert into public.lawcaspro_manual_migration_checksums");
        if (!isControl) throw duplicate;
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    };

    await expect(runMigrateSafe({ client, migrationsDir, fromPrefix: "0000", mode: "apply" })).rejects.toThrow(
      "already exists",
    );

    expect(seen.some((s) => s.includes("insert into public.lawcaspro_manual_migrations"))).toBe(false);
  });
});
