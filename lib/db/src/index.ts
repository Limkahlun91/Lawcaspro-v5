import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const rawConnectTimeoutMs = process.env.PG_CONNECT_TIMEOUT_MS;
const connectTimeoutMs =
  rawConnectTimeoutMs && !Number.isNaN(Number(rawConnectTimeoutMs))
    ? Number(rawConnectTimeoutMs)
    : 10_000;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: connectTimeoutMs,
});
export const db = drizzle(pool, { schema });

export { schema };
export type AppDb = typeof db;

export * from "./schema";
export * from "./tenant-context";
