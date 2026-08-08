import { logger } from "../lib/logger.js";
import { pool, db } from "@workspace/db";
import { formatHRIdempotencyKey } from "../modules/shared/idempotency/hr-idempotency.js";
import type { HRBusinessEvent, HREventSubscriberValue } from "@workspace/api-zod";
import { HREventSubscriber } from "@workspace/api-zod";

const JOB_NAME = "hr-event-delivery-worker";
const LOCK_KEY = hashtext(`${JOB_NAME}:v1`);
const BATCH_LIMIT = Number(process.env.HR_EVENT_BATCH_LIMIT || "20");
const POLL_INTERVAL_MS = Number(process.env.HR_EVENT_POLL_INTERVAL_MS || "15000");
const MAX_RETRIES = 8;

function hashtext(s: string): bigint {
  let h = 2166136261n;
  const fnvPrime = 16777619n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = BigInt.asUintN(32, h * fnvPrime);
  }
  return BigInt.asIntN(64, h);
}

function envGate(): boolean {
  const v = String(process.env.ENABLE_HR_EVENT_DELIVERY_JOB ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export interface HRDeliveryResult {
  subscriber: HREventSubscriberValue;
  status: "success" | "failed" | "skipped";
  durationMs: number;
  error?: unknown;
  response?: unknown;
}

export async function deliverEventToSubscriber(
  event: HRBusinessEvent,
  subscriber: HREventSubscriberValue,
): Promise<HRDeliveryResult> {
  const startedAt = Date.now();
  const safeEvent = { ...event, payload: typeof event.payload === "object" ? event.payload : {} };
  try {
    switch (subscriber) {
      case HREventSubscriber.HR_ACCOUNTING_INTEGRATION:
        return {
          subscriber,
          status: "skipped",
          durationMs: Date.now() - startedAt,
          response: { note: "HR→Accounting handler implemented in Phase 5 Accounting Integration" },
        };
      case HREventSubscriber.HR_CASE_INTEGRATION:
        return {
          subscriber,
          status: "skipped",
          durationMs: Date.now() - startedAt,
          response: { note: "HR→Cases handoff handler implemented in Part 3 Phase 6 (Case Workload)" },
        };
      case HREventSubscriber.HR_NOTIFICATIONS:
      case HREventSubscriber.HR_PARTNER_ALERTS:
      case HREventSubscriber.HR_WORKFLOW_INTEGRATION:
      default:
        return {
          subscriber,
          status: "skipped",
          durationMs: Date.now() - startedAt,
          response: { note: "Subscriber handler placeholder — populated in Phase 2-6" },
        };
    }
  } catch (err) {
    return {
      subscriber,
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? { message: err.message, name: err.name } : String(err),
    };
  }
  // Note: all switch arms return; unreachable.
  void safeEvent;
  void db;
}

export async function runHRDeliveryBatchOnce(): Promise<{ processed: number; durationMs: number }> {
  const client = await pool.connect();
  const startedAt = Date.now();
  let processed = 0;
  try {
    const { rows: [lockRow] } = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [LOCK_KEY.toString()],
    );
    if (!lockRow?.acquired) {
      logger.debug({ job: JOB_NAME }, "hr-event-delivery: lock held by peer; skipping poll");
      return { processed: 0, durationMs: Date.now() - startedAt };
    }
    try {
      const { rows } = await client.query<{
        id: number; event_id: string; firm_id: number; event_type: string;
        aggregate_type: string; aggregate_id: string; occurred_at: Date; actor_user_id: number | null;
        correlation_id: string | null; payload: Record<string, unknown>; version: number;
        source_module: string; idempotency_key: string;
      }>(
        `SELECT id, event_id, firm_id, event_type, aggregate_type, aggregate_id, occurred_at,
                actor_user_id, correlation_id, payload, version, source_module, idempotency_key
         FROM public.hr_business_events
         WHERE status IN ('ready','failed')
           AND (next_retry_at IS NULL OR next_retry_at <= NOW())
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [BATCH_LIMIT],
      );
      for (const r of rows) {
        try {
          const ev: HRBusinessEvent = {
            eventId: r.event_id,
            eventType: r.event_type as HRBusinessEvent["eventType"],
            firmId: r.firm_id,
            aggregateType: r.aggregate_type as HRBusinessEvent["aggregateType"],
            aggregateId: r.aggregate_id,
            occurredAt: r.occurred_at,
            actorUserId: r.actor_user_id,
            correlationId: r.correlation_id ?? undefined,
            payload: r.payload ?? {},
            version: r.version,
            sourceModule: r.source_module as HRBusinessEvent["sourceModule"],
            idempotencyKey: r.idempotency_key,
          };
          const { rows: subRows } = await client.query<{ subscriber: string }>(
            `SELECT subscriber FROM public.hr_event_subscriptions
             WHERE firm_id = $1 AND event_type = $2 AND active = TRUE
             ORDER BY priority ASC`,
            [ev.firmId, ev.eventType],
          );
          if (subRows.length === 0) {
            await client.query(
              `UPDATE public.hr_business_events SET status = 'delivered', processed_at = NOW(), updated_at = NOW() WHERE id = $1`,
              [r.id],
            );
            processed++;
            continue;
          }
          for (const sub of subRows) {
            const subscriber = sub.subscriber as HREventSubscriberValue;
            const result = await deliverEventToSubscriber(ev, subscriber);
            await client.query(
              `INSERT INTO public.hr_event_delivery_attempts
                (event_id, subscriber, status, error_message, response_metadata, duration_ms)
               VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
              [
                r.id,
                subscriber,
                result.status,
                result.error ? JSON.stringify(result.error) : null,
                result.response ? JSON.stringify(result.response) : null,
                result.durationMs,
              ],
            );
          }
          const { rows: [attempts] } = await client.query<{ failed: number; total: number }>(
            `SELECT
               COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
               COUNT(*)::int AS total
             FROM public.hr_event_delivery_attempts WHERE event_id = $1`,
            [r.id],
          );
          if ((attempts?.failed ?? 0) > 0) {
            const retryCount = Number((r as unknown as { retry_count?: number }).retry_count ?? 0) + 1;
            const backoffSec = Math.min(60 * 60, Math.pow(2, Math.min(retryCount, 8))) * 5;
            if (retryCount >= MAX_RETRIES) {
              await client.query(
                `UPDATE public.hr_business_events
                    SET status = 'dead_letter',
                        failure_message = COALESCE(failure_message, '{}'::jsonb) || jsonb_build_object('retry_' || $2::text, 'max_retries_reached'),
                        retry_count = $2, updated_at = NOW()
                  WHERE id = $1`,
                [r.id, retryCount],
              );
            } else {
              await client.query(
                `UPDATE public.hr_business_events
                    SET status = 'failed',
                        retry_count = $2,
                        next_retry_at = NOW() + ($3::text || ' seconds')::interval,
                        updated_at = NOW()
                  WHERE id = $1`,
                [r.id, retryCount, backoffSec],
              );
            }
          } else {
            await client.query(
              `UPDATE public.hr_business_events
                  SET status = 'delivered', processed_at = NOW(), updated_at = NOW()
                WHERE id = $1`,
              [r.id],
            );
          }
          processed++;
          // unused idempotency ref silence ts
          void formatHRIdempotencyKey;
        } catch (rowErr) {
          logger.error(
            { job: JOB_NAME, eventId: r.event_id, err: rowErr instanceof Error ? rowErr.message : String(rowErr) },
            "hr-event-delivery: per-event fatal; leaving row for retry",
          );
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [LOCK_KEY.toString()]);
    }
  } finally {
    client.release();
  }
  return { processed, durationMs: Date.now() - startedAt };
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startHREventDeliveryWorker(): void {
  if (!envGate()) {
    logger.info({ job: JOB_NAME, enabled: false }, "hr-event-delivery: disabled via ENABLE_HR_EVENT_DELIVERY_JOB");
    return;
  }
  if (timer !== null) return;
  logger.info({ job: JOB_NAME, pollIntervalMs: POLL_INTERVAL_MS, batchLimit: BATCH_LIMIT }, "hr-event-delivery: starting");
  timer = setInterval(async () => {
    try {
      const res = await runHRDeliveryBatchOnce();
      if (res.processed > 0) {
        logger.info({ job: JOB_NAME, ...res }, "hr-event-delivery: batch complete");
      }
    } catch (err) {
      logger.error(
        { job: JOB_NAME, err: err instanceof Error ? err.message : String(err) },
        "hr-event-delivery: batch error",
      );
    }
  }, POLL_INTERVAL_MS);
}

export function stopHREventDeliveryWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
