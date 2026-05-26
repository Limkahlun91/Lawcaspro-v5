import { db, sql } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { writeAuditLog } from "../lib/auth.js";

async function tryAcquireLock(): Promise<boolean> {
  const r = await db.execute(sql`SELECT pg_try_advisory_lock(hashtext('completion_sla_monitor')) as ok`);
  const rows = Array.isArray(r) ? r : ("rows" in (r as any) ? (r as any).rows : []);
  const ok = rows?.[0]?.ok;
  return ok === true || ok === "t" || ok === 1;
}

async function releaseLock(): Promise<void> {
  try {
    await db.execute(sql`SELECT pg_advisory_unlock(hashtext('completion_sla_monitor'))`);
  } catch {
  }
}

export function startCompletionSlaMonitor(): void {
  const enabled = process.env.ENABLE_COMPLETION_SLA_MONITOR === "1";
  if (!enabled) return;

  const intervalMs = (() => {
    const raw = process.env.COMPLETION_SLA_MONITOR_INTERVAL_MS;
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n) && n >= 30_000) return Math.floor(n);
    return 15 * 60 * 1000;
  })();

  const subject = "SLA Reminder: Advice on";

  const tick = async (): Promise<void> => {
    const lockOk = await tryAcquireLock();
    if (!lockOk) return;
    try {
      const result = await db.execute(sql`
        SELECT
          kd.firm_id as firm_id,
          kd.case_id as case_id,
          c.reference_no as reference_no
        FROM case_key_dates kd
        JOIN cases c ON c.id = kd.case_id AND c.firm_id = kd.firm_id
        WHERE kd.completion_sla_activated_at IS NOT NULL
          AND kd.advice_to_bank_date IS NULL
          AND kd.completion_sla_notified_48h_at IS NULL
          AND (now() - kd.completion_sla_activated_at) >= interval '48 hours'
        ORDER BY kd.completion_sla_activated_at ASC
        LIMIT 50
      `);
      const rows = Array.isArray(result) ? result : ("rows" in (result as any) ? (result as any).rows : []);

      for (const row of rows as any[]) {
        const firmId = Number(row?.firm_id ?? 0);
        const caseId = Number(row?.case_id ?? 0);
        const referenceNo = String(row?.reference_no ?? "");
        if (!firmId || !caseId) continue;

        try {
          const existingThreadRes = await db.execute(sql`
            SELECT id
            FROM communication_threads
            WHERE firm_id = ${firmId} AND case_id = ${caseId} AND subject = ${subject}
            ORDER BY created_at DESC
            LIMIT 1
          `);
          const existingThreads = Array.isArray(existingThreadRes) ? existingThreadRes : ("rows" in (existingThreadRes as any) ? (existingThreadRes as any).rows : []);
          let threadToUse = typeof (existingThreads?.[0] as any)?.id === "number"
            ? Number((existingThreads[0] as any).id)
            : 0;
          if (!threadToUse) {
            const inserted = await db.execute(sql`
              INSERT INTO communication_threads (case_id, firm_id, subject, created_by)
              VALUES (${caseId}, ${firmId}, ${subject}, 0)
              RETURNING id
            `);
            const insertedRows = Array.isArray(inserted) ? inserted : ("rows" in (inserted as any) ? (inserted as any).rows : []);
            threadToUse = Number((insertedRows?.[0] as any)?.id ?? 0);
          }

          if (!threadToUse) continue;

          const message = `案件 ${referenceNo || `#${caseId}`} 的 Differential Sum、NOA 與 Registered POA 已確認，請於 24 小時內完成 Advice on 並送出。`;
          await db.execute(sql`
            INSERT INTO case_communications (case_id, firm_id, thread_id, type, direction, notes, logged_by)
            VALUES (${caseId}, ${firmId}, ${threadToUse}, 'message', 'internal', ${message}, 0)
          `);

          await db.execute(sql`
            UPDATE communication_threads
            SET updated_at = NOW()
            WHERE id = ${threadToUse} AND firm_id = ${firmId}
          `);

          await db.execute(sql`
            UPDATE case_key_dates
            SET completion_sla_notified_48h_at = NOW()
            WHERE firm_id = ${firmId} AND case_id = ${caseId}
          `);

          await writeAuditLog({
            firmId,
            actorId: null,
            actorType: "system",
            action: "cases.completion_sla.notify_48h",
            entityType: "case",
            entityId: caseId,
            detail: `referenceNo=${referenceNo}`,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err ?? "");
          logger.error({ err: msg.slice(0, 200), firmId, caseId }, "completion_sla.monitor.notify_failed");
        }
      }
    } finally {
      await releaseLock();
    }
  };

  setInterval(() => {
    tick().catch((err) => {
      logger.error({ err }, "completion_sla.monitor.tick_failed");
    });
  }, intervalMs);

  tick().catch((err) => logger.error({ err }, "completion_sla.monitor.first_tick_failed"));
  logger.info({ intervalMs }, "completion_sla.monitor.started");
}
