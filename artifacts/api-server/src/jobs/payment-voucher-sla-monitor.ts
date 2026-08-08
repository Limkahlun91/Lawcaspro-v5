import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { tickPaymentVoucherSla } from "../routes/cron-jobs.js";

async function tryAcquireLock(): Promise<boolean> {
  const r = await db.execute(sql`SELECT pg_try_advisory_lock(hashtext('payment_voucher_sla_monitor')) as ok`);
  const rows = Array.isArray(r) ? r : ("rows" in (r as any) ? (r as any).rows : []);
  const ok = rows?.[0]?.ok;
  return ok === true || ok === "t" || ok === 1;
}

async function releaseLock(): Promise<void> {
  try {
    await db.execute(sql`SELECT pg_advisory_unlock(hashtext('payment_voucher_sla_monitor'))`);
  } catch {
  }
}

export function startPaymentVoucherSlaMonitor(): void {
  const enabled = process.env.ENABLE_PAYMENT_VOUCHER_SLA_MONITOR === "1";
  if (!enabled) return;

  const intervalMs = (() => {
    const raw = process.env.PAYMENT_VOUCHER_SLA_MONITOR_INTERVAL_MS;
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n) && n >= 30_000) return Math.floor(n);
    return 5 * 60 * 1000;
  })();

  const tick = async (): Promise<void> => {
    const lockOk = await tryAcquireLock();
    if (!lockOk) return;
    try {
      await tickPaymentVoucherSla({ channel: "monitor_interval" });
    } catch (err) {
      logger.error({ err }, "payment_voucher_sla.monitor.tick_failed");
    } finally {
      await releaseLock();
    }
  };

  setInterval(() => {
    tick().catch((err) => {
      logger.error({ err }, "payment_voucher_sla.monitor.tick_failed");
    });
  }, intervalMs);

  tick().catch((err) => logger.error({ err }, "payment_voucher_sla.monitor.first_tick_failed"));
  logger.info({ intervalMs }, "payment_voucher_sla.monitor.started");
}
