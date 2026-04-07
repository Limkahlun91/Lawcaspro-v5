import { makeRlsDb, pool } from "@workspace/db";

export async function withAuthSafeDb<T>(
  fn: (db: ReturnType<typeof makeRlsDb>) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL app.is_founder = 'true'");
    await client.query("SET LOCAL app.current_firm_id = ''");
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

