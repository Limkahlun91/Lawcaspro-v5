import { describe, it, expect, vi } from "vitest";
import {
  withDbStatementTimeout,
  runInTxWithTimeout,
  DEFAULT_TIMEOUTS,
  type StatementTimeoutCategory,
} from "../modules/db/statement-timeout";
import type { PoolClient, Pool } from "@workspace/db";

type QueryResult<T = any> = { rows: T[]; rowCount: number; command: string; oid: number; fields: any[] };

type QueryCall = { text: string; values?: any[] };

function makeMockClient() {
  const calls: QueryCall[] = [];
  let released = false;
  const client = {
    query: vi.fn(async (q: any): Promise<QueryResult<any>> => {
      const text = typeof q === "string" ? q : q.text;
      const values = typeof q === "string" ? undefined : q.values;
      calls.push({ text, values });
      return { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] } as any;
    }),
    release: vi.fn((_err?: boolean | Error) => {
      released = true;
    }),
    getCalls() {
      return calls;
    },
    isReleased() {
      return released;
    },
  } as unknown as PoolClient & { getCalls(): QueryCall[]; isReleased(): boolean };
  return client;
}

function makeMockPool(client: PoolClient & { getCalls(): QueryCall[]; isReleased(): boolean }) {
  return {
    connect: vi.fn(async () => client),
  } as unknown as Pool;
}

describe("withDbStatementTimeout (§25) — SET LOCAL enforcement", () => {
  it("emits SET LOCAL statement_timeout as the FIRST query — never plain SET", async () => {
    const client = makeMockClient();
    const result = await withDbStatementTimeout(client, 2000, async () => {
      await (client as any).query("SELECT 1");
      return 42;
    });
    expect(result).toBe(42);
    const calls = (client as any).getCalls() as QueryCall[];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const first = calls[0]!.text;
    expect(first.toUpperCase()).toMatch(/SET\s+LOCAL\s+STATEMENT_TIMEOUT/);
    expect(first.toUpperCase()).not.toMatch(/^SET\s+(?!LOCAL)/);
    for (const c of calls) {
      const up = c.text.toUpperCase().replace(/\s+/g, " ").trim();
      if (up.startsWith("SET STATEMENT_TIMEOUT") && !up.startsWith("SET LOCAL STATEMENT_TIMEOUT")) {
        throw new Error("Detected plain SET statement_timeout (leaks to next pooled request)");
      }
    }
  });

  it("resolves DEFAULT_TIMEOUTS for each category", () => {
    expect(DEFAULT_TIMEOUTS.small).toBe(1_000);
    expect(DEFAULT_TIMEOUTS.search).toBe(2_000);
    expect(DEFAULT_TIMEOUTS.aggregate).toBe(5_000);
    expect(DEFAULT_TIMEOUTS.write).toBe(8_000);
    expect(DEFAULT_TIMEOUTS.report).toBe(15_000);
  });

  it("accepts category string via runInTxWithTimeout", async () => {
    const client = makeMockClient();
    const pool = makeMockPool(client);
    const result = await runInTxWithTimeout<number>(pool, "search", async ({ client: c }) => {
      await c.query("SELECT 2");
      return 7;
    });
    expect(result).toBe(7);
    const calls = (client as any).getCalls() as QueryCall[];
    const texts = calls.map((c) => c.text.toUpperCase().replace(/\s+/g, " ").trim());
    expect(texts[0]).toBe("BEGIN");
    expect(texts[1]!).toContain("SET LOCAL STATEMENT_TIMEOUT");
    expect(texts.includes("COMMIT") || texts.includes("ROLLBACK")).toBe(true);
    expect((client as any).isReleased()).toBe(true);
  });

  it("releases client on work error via runInTxWithTimeout with ROLLBACK", async () => {
    const client = makeMockClient();
    const pool = makeMockPool(client);
    await expect(
      runInTxWithTimeout(pool, 1000, async ({ client: c }) => {
        await c.query("SELECT boom()");
        throw new Error("boom");
      }),
    ).rejects.toThrow(/boom/);
    const calls = (client as any).getCalls() as QueryCall[];
    const texts = calls.map((c) => c.text.toUpperCase().replace(/\s+/g, " ").trim());
    expect(texts[0]).toBe("BEGIN");
    expect(texts[1]!).toContain("SET LOCAL STATEMENT_TIMEOUT");
    expect(texts).toContain("ROLLBACK");
    expect(texts).not.toContain("COMMIT");
    expect((client as any).isReleased()).toBe(true);
  });
});
