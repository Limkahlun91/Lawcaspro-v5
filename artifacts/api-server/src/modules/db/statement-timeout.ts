/**
 * statement-timeout.ts
 *
 * Safe statement-timeout helpers using PostgreSQL `SET LOCAL` so that
 * timeout configuration NEVER leaks across pooled connections.
 *
 * Background bug we prevent:
 *   Plain `SET statement_timeout = 'Xms'` (no LOCAL) changes the session-level
 *   setting. When the PoolClient is released back to the pool, the next request
 *   that inherits that connection still has the old timeout active. This can
 *   either (a) cancel long legitimate reports on a "search" pool connection or
 *   (b) let a slow report leak onto a UI pool request and block the worker for
 *   30+ seconds.  `SET LOCAL` is scoped to the current transaction and is
 *   automatically rolled back at transaction end — even if the transaction
 *   ABORTS — so the pool connection returns clean.
 *
 * Constraints:
 *   - Every `SET LOCAL statement_timeout` MUST run inside a transaction
 *     (BEGIN … COMMIT/ROLLBACK).
 *   - For read paths that already use `requireFirmUser`, the request already
 *     lives in a transaction (see requireFirmUser BEGIN in lib/auth.ts), so
 *     `SET LOCAL` works out of the box — no extra wrapper needed.
 *   - For read paths that use the global `db` (Pool-level drizzle) directly
 *     without an explicit transaction, use `runInTxWithTimeout()` which
 *     opens its own short-lived tx.
 */

import type { Pool, PoolClient } from "@workspace/db";
import { makeRlsDb, type RlsDb } from "@workspace/db";
import pino from "pino";

const logger = pino({ name: "statement-timeout" });

export type StatementTimeoutCategory =
  | "search"
  | "small"
  | "aggregate"
  | "report"
  | "write";

export const DEFAULT_TIMEOUTS: Record<StatementTimeoutCategory, number> = {
  search: 2_000,
  small: 1_000,
  aggregate: 5_000,
  report: 15_000,
  write: 8_000,
};

export function getDefaultTimeout(category: StatementTimeoutCategory): number {
  return DEFAULT_TIMEOUTS[category];
}

export function resolveTimeoutMs(
  timeoutMsOrCategory: number | StatementTimeoutCategory,
): number {
  if (typeof timeoutMsOrCategory === "number") {
    if (!Number.isFinite(timeoutMsOrCategory) || timeoutMsOrCategory <= 0) {
      throw new Error(
        `statement-timeout: invalid timeoutMs=${timeoutMsOrCategory}`,
      );
    }
    return timeoutMsOrCategory;
  }
  const t = DEFAULT_TIMEOUTS[timeoutMsOrCategory];
  if (!t) {
    throw new Error(
      `statement-timeout: unknown category "${timeoutMsOrCategory as string}"`,
    );
  }
  return t;
}

export type DbConn = PoolClient;

export async function withDbStatementTimeout<T>(
  conn: DbConn,
  timeoutMsOrCategory: number | StatementTimeoutCategory,
  work: () => Promise<T>,
  category?: StatementTimeoutCategory,
): Promise<T> {
  const timeoutMs = resolveTimeoutMs(timeoutMsOrCategory);
  const effectiveCategory =
    category ??
    (typeof timeoutMsOrCategory === "string"
      ? (timeoutMsOrCategory as StatementTimeoutCategory)
      : undefined);

  await conn.query({
    text: `SET LOCAL statement_timeout = '${Math.floor(timeoutMs)}ms'`,
  });

  try {
    return await work();
  } catch (err) {
    if (
      err instanceof Error &&
      err.message &&
      err.message.toLowerCase().includes("canceling statement due to statement timeout")
    ) {
      const msg =
        `DB statement_timeout exceeded (${timeoutMs}ms; category=${effectiveCategory ?? "explicit"}) — aborting request to protect pool.`;
      logger.warn(
        { timeoutMs, category: effectiveCategory, err: err.message },
        "statement_timeout",
      );
      const wrapped = new Error(msg);
      (wrapped as Error & { cause?: unknown }).cause = err;
      (wrapped as Error & { code?: string }).code = "STATEMENT_TIMEOUT";
      (wrapped as Error & { statusCode?: number }).statusCode = 504;
      throw wrapped;
    }
    throw err;
  }
}

export type TxWorkContext = {
  client: PoolClient;
  rlsDb: RlsDb;
};

export async function runInTxWithTimeout<T>(
  pool: Pool,
  timeoutMsOrCategory: number | StatementTimeoutCategory,
  work: (ctx: TxWorkContext) => Promise<T>,
  category?: StatementTimeoutCategory,
): Promise<T> {
  const client = await pool.connect();
  let aborted = false;
  try {
    await client.query("BEGIN");
    await withDbStatementTimeout(
      client,
      timeoutMsOrCategory,
      async () => void 0,
      category,
    );
    const rlsDb = makeRlsDb(client);
    const result = await work({ client, rlsDb });
    await client.query("COMMIT");
    return result;
  } catch (err) {
    aborted = true;
    try {
      await client.query("ROLLBACK");
    } catch {
    }
    throw err;
  } finally {
    try {
      if (aborted) {
        client.release(true);
      } else {
        client.release();
      }
    } catch {
    }
  }
}
