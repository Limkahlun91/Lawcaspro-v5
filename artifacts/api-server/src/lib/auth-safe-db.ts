import { makeRlsDb, pool, setFounderContext } from "@workspace/db";
import { logger } from "./logger";

function isTransientDbConnectionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  const lowered = message.toLowerCase();

  return (
    lowered.includes("connection terminated unexpectedly") ||
    lowered.includes("connection terminated due to connection timeout") ||
    lowered.includes("server closed the connection unexpectedly") ||
    lowered.includes("terminating connection due to administrator command") ||
    lowered.includes("connection ended unexpectedly") ||
    lowered.includes("socket hang up") ||
    lowered.includes("econnreset")
  );
}

async function runWithAuthSafeDbOnce<T>(
  fn: (db: ReturnType<typeof makeRlsDb>) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let destroyClient = false;

  try {
    await client.query("BEGIN");
    await setFounderContext(client);
    const authDb = makeRlsDb(client);
    const result = await fn(authDb);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    destroyClient = isTransientDbConnectionError(err);
    try {
      await client.query("ROLLBACK");
    } catch {
      destroyClient = true;
    }
    throw err;
  } finally {
    client.release(destroyClient);
  }
}

export async function withAuthSafeDb<T>(
  fn: (db: ReturnType<typeof makeRlsDb>) => Promise<T>,
): Promise<T> {
  try {
    return await runWithAuthSafeDbOnce(fn);
  } catch (err) {
    if (!isTransientDbConnectionError(err)) {
      throw err;
    }

    logger.warn({ err }, "auth-safe-db.retrying_transient_connection_error");
    return await runWithAuthSafeDbOnce(fn);
  }
}
