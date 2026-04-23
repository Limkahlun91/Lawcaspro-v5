import { and, desc, eq, sql } from "drizzle-orm";
import { db, platformSnapshotsTable, type RlsDb } from "@workspace/db";
import { withAuthSafeDb } from "../lib/auth-safe-db";
import { logger } from "../lib/logger";
import { SupabaseStorageService } from "../lib/objectStorage";

async function tryAcquireLock(): Promise<boolean> {
  const r = await db.execute(sql`SELECT pg_try_advisory_lock(hashtext('platform_snapshot_retention_cleanup')) as ok`);
  const rows = Array.isArray(r) ? r : ("rows" in (r as any) ? (r as any).rows : []);
  const ok = rows?.[0]?.ok;
  return ok === true || ok === "t" || ok === 1;
}

async function releaseLock(): Promise<void> {
  try {
    await db.execute(sql`SELECT pg_advisory_unlock(hashtext('platform_snapshot_retention_cleanup'))`);
  } catch {
  }
}

async function listExpired(authDb: RlsDb, limit: number): Promise<Array<{ id: string; firmId: number; storageDriver: string | null; storagePath: string | null }>> {
  const n = Math.min(Math.max(limit, 1), 50);
  const rows = await authDb
    .select({
      id: platformSnapshotsTable.id,
      firmId: platformSnapshotsTable.firmId,
      storageDriver: platformSnapshotsTable.storageDriver,
      storagePath: platformSnapshotsTable.storagePath,
    })
    .from(platformSnapshotsTable)
    .where(and(
      eq(platformSnapshotsTable.status, "completed"),
      eq(platformSnapshotsTable.restorable, true),
      sql`${platformSnapshotsTable.pinnedAt} IS NULL`,
      sql`${platformSnapshotsTable.deletedAt} IS NULL`,
      sql`${platformSnapshotsTable.expiresAt} IS NOT NULL`,
      sql`${platformSnapshotsTable.expiresAt} < now()`
    ))
    .orderBy(desc(platformSnapshotsTable.expiresAt), desc(platformSnapshotsTable.createdAt))
    .limit(n);
  return rows as any;
}

export function startSnapshotRetentionCleanup(): void {
  const enabled = process.env.ENABLE_PLATFORM_SNAPSHOT_RETENTION_CLEANUP === "1";
  if (!enabled) return;

  const intervalMs = (() => {
    const raw = process.env.PLATFORM_SNAPSHOT_RETENTION_INTERVAL_MS;
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n) && n >= 60_000) return Math.floor(n);
    return 30 * 60 * 1000;
  })();

  const storage = new SupabaseStorageService();

  const tick = async (): Promise<void> => {
    const lockOk = await tryAcquireLock();
    if (!lockOk) return;
    try {
      await withAuthSafeDb(async (authDb) => {
        const expired = await listExpired(authDb, 25);
        if (!expired.length) return;

        for (const s of expired) {
          try {
            if (s.storageDriver === "supabase" && s.storagePath) {
              try {
                await storage.deletePrivateObject(s.storagePath);
              } catch (e) {
                logger.warn({ snapshotId: s.id, firmId: s.firmId, err: e instanceof Error ? e.message : String(e ?? "") }, "snapshot.retention.delete_payload_failed");
              }
            }

            await authDb.update(platformSnapshotsTable).set({
              status: "expired",
              restorable: false,
              restoreNotes: "Expired by retention policy (payload pruned if possible).",
              payloadJson: null,
              payloadStorageKey: null,
              storagePath: null,
              sizeBytes: null,
              checksum: null,
              integrityStatus: "invalid",
              updatedAt: new Date(),
            }).where(eq(platformSnapshotsTable.id, s.id));
          } catch (e) {
            logger.error({ snapshotId: s.id, firmId: s.firmId, err: e }, "snapshot.retention.expire_failed");
          }
        }
      }, { retry: true, allowUnsafe: true, ctx: { route: "snapshot.retention.tick" } });
    } finally {
      await releaseLock();
    }
  };

  setInterval(() => {
    tick().catch((err) => {
      logger.error({ err }, "snapshot.retention.tick_failed");
    });
  }, intervalMs);

  tick().catch((err) => logger.error({ err }, "snapshot.retention.first_tick_failed"));
  logger.info({ intervalMs }, "snapshot.retention.started");
}
