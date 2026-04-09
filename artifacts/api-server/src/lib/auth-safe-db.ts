import { makeRlsDb, pool, setFounderContext } from "@workspace/db";

export async function withAuthSafeDb<T>(
  fn: (db: ReturnType<typeof makeRlsDb>) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setFounderContext(client);
    const authDb = makeRlsDb(client);
    const result = await fn(authDb);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
    }
    throw err;
  } finally {
    client.release();
  }
}
