import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db, firmsTable, platformSnapshotsTable, type RlsDb } from "@workspace/db";
import { withAuthSafeDb } from "../lib/auth-safe-db";
import { logger } from "../lib/logger";
import { SupabaseStorageService } from "../lib/objectStorage";
import { createSnapshot } from "../services/platform-ops";

function shouldRunWeekly(now: Date): boolean {
  return now.getUTCDay() === 0;
}

function shouldRunMonthly(now: Date): boolean {
  return now.getUTCDate() === 1;
}

async function alreadyHasRecentScheduledSnapshot(authDb: RlsDb, firmId: number, scheduleCode: "daily" | "weekly" | "monthly"): Promise<boolean> {
  const hours = scheduleCode === "daily" ? 20 : scheduleCode === "weekly" ? 6 * 24 : 20 * 24;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const [row] = await authDb
    .select({ id: platformSnapshotsTable.id })
    .from(platformSnapshotsTable)
    .where(and(
      eq(platformSnapshotsTable.firmId, firmId),
      eq(platformSnapshotsTable.triggerType, "scheduled"),
      eq(platformSnapshotsTable.snapshotType, "firm"),
      sql`${platformSnapshotsTable.createdAt} >= ${since.toISOString()}`
    ))
    .orderBy(desc(platformSnapshotsTable.createdAt))
    .limit(1);
  if (!row) return false;

  const [meta] = await authDb
    .select({ metadataJson: platformSnapshotsTable.metadataJson })
    .from(platformSnapshotsTable)
    .where(eq(platformSnapshotsTable.id, row.id));
  const code = (meta?.metadataJson as any)?.schedule_code;
  return code === scheduleCode;
}

async function tryAcquireSchedulerLock(): Promise<boolean> {
  const r = await db.execute(sql`SELECT pg_try_advisory_lock(hashtext('platform_snapshot_scheduler')) as ok`);
  const rows = Array.isArray(r) ? r : ("rows" in (r as any) ? (r as any).rows : []);
  const ok = rows?.[0]?.ok;
  return ok === true || ok === "t" || ok === 1;
}

async function releaseSchedulerLock(): Promise<void> {
  try {
    await db.execute(sql`SELECT pg_advisory_unlock(hashtext('platform_snapshot_scheduler'))`);
  } catch {
  }
}

export function startSnapshotScheduler(): void {
  const enabled = process.env.ENABLE_PLATFORM_SNAPSHOT_SCHEDULER === "1";
  if (!enabled) return;

  const intervalMs = (() => {
    const raw = process.env.PLATFORM_SNAPSHOT_SCHEDULER_INTERVAL_MS;
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n) && n >= 30_000) return Math.floor(n);
    return 10 * 60 * 1000;
  })();

  const storage = new SupabaseStorageService();

  const tick = async (): Promise<void> => {
    const now = new Date();
    const lockOk = await tryAcquireSchedulerLock();
    if (!lockOk) return;
    try {
      await withAuthSafeDb(async (authDb) => {
        const firms = await authDb.select({ id: firmsTable.id }).from(firmsTable).where(eq(firmsTable.status, "active"));
        for (const f of firms) {
          const firmId = f.id;
          const schedules: Array<{ code: "daily" | "weekly" | "monthly"; policy: string }> = [
            { code: "daily", policy: "scheduled_daily" },
            ...(shouldRunWeekly(now) ? [{ code: "weekly" as const, policy: "scheduled_weekly" }] : []),
            ...(shouldRunMonthly(now) ? [{ code: "monthly" as const, policy: "scheduled_monthly" }] : []),
          ];

          for (const s of schedules) {
            const hasRecent = await alreadyHasRecentScheduledSnapshot(authDb, firmId, s.code);
            if (hasRecent) continue;
            try {
              const created = await createSnapshot(authDb, {
                firmId,
                snapshotType: "firm",
                scopeType: "firm",
                moduleCode: null as any,
                targetEntityType: "firm",
                targetEntityId: String(firmId),
                targetLabel: `scheduled_${s.code}`,
                triggerType: "scheduled",
                triggerActionCode: "restore_snapshot",
                createdByUserId: null,
                createdByEmail: null,
                reason: `scheduled_${s.code}`,
                note: null,
                retentionPolicyCode: s.policy,
                storage,
              });
              await authDb.update(platformSnapshotsTable).set({ metadataJson: { schedule_code: s.code } as any }).where(eq(platformSnapshotsTable.id, created.snapshotId));
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err ?? "");
              logger.error({ firmId, schedule: s.code, err: msg.slice(0, 200) }, "snapshot.scheduler.failed");
            }
          }
        }
      }, { retry: true, allowUnsafe: true, ctx: { route: "snapshot.scheduler.tick" } });
    } finally {
      await releaseSchedulerLock();
    }
  };

  setInterval(() => {
    tick().catch((err) => {
      logger.error({ err }, "snapshot.scheduler.tick_failed");
    });
  }, intervalMs);

  tick().catch((err) => logger.error({ err }, "snapshot.scheduler.first_tick_failed"));
  logger.info({ intervalMs }, "snapshot.scheduler.started");
}

