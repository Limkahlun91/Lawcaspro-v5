import type { RlsDb } from "@workspace/db";

declare const __hr_domain_db_guard: unique symbol;

export type HrDomainDb = RlsDb & {
  readonly [__hr_domain_db_guard]: true;
};

export function assertHrDomainDb(db: unknown, caller: string): HrDomainDb {
  if (!db || typeof db !== "object") {
    throw new TypeError(
      `[HR Tenant Isolation] ${caller}: expected RlsDb with tenant context, got ${db === null ? "null" : typeof db}.`,
    );
  }
  const d = db as Record<string, unknown>;
  if (typeof d.select !== "function" || typeof d.insert !== "function" || typeof d.update !== "function") {
    throw new TypeError(
      `[HR Tenant Isolation] ${caller}: object missing drizzle methods; cannot treat as HrDomainDb.`,
    );
  }
  return db as HrDomainDb;
}

export function toHrDomainDb(rlsDb: RlsDb, caller: string): HrDomainDb {
  if (!rlsDb) {
    throw new TypeError(
      `[HR Tenant Isolation] ${caller}: rlsDb is undefined. requireFirmUser must run before HR domain operations.`,
    );
  }
  return rlsDb as unknown as HrDomainDb;
}
