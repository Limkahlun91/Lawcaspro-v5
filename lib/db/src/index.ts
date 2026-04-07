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

const isSupabasePoolerDatabaseUrl = (databaseUrl: string): boolean =>
  databaseUrl.toLowerCase().includes("pooler.supabase.com");

const stripSslmodeFromDatabaseUrl = (databaseUrl: string): string => {
  const [beforeHash, hash] = databaseUrl.split("#", 2);
  const [base, query] = beforeHash.split("?", 2);
  if (!query) return databaseUrl;

  const filtered = query
    .split("&")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      const eq = part.indexOf("=");
      const key = (eq === -1 ? part : part.slice(0, eq)).toLowerCase();
      return key !== "sslmode";
    });

  const rebuilt = filtered.length ? `${base}?${filtered.join("&")}` : base;
  return hash ? `${rebuilt}#${hash}` : rebuilt;
};

const databaseUrl = process.env.DATABASE_URL;
const isPooler = isSupabasePoolerDatabaseUrl(databaseUrl);

export const pool = new Pool({
  connectionString: isPooler ? stripSslmodeFromDatabaseUrl(databaseUrl) : databaseUrl,
  connectionTimeoutMillis: connectTimeoutMs,
  ...(isPooler ? { ssl: { rejectUnauthorized: false } } : {}),
});
export const db = drizzle(pool, { schema });

export { schema };
export type AppDb = typeof db;

export * from "./schema";
export * from "./tenant-context";
