import { and, eq, isNull, sql } from "drizzle-orm";
import { db, paymentVoucherCreateRequestsTable } from "@workspace/db";
import { logger } from "../../lib/logger.js";

/** Timeout for the single-tracking-row UPDATE (ms). Should be fast. */
export const PV_CREATE_PRELOCK_TIMEOUT_MS = 2_000;

/** Type for a drizzle-like connection handle: has .transaction + CRUD + execute */
export type TrackingDbConn = Pick<
  typeof db,
  "select" | "insert" | "update" | "delete" | "transaction" | "execute"
>;

/**
 * Best-effort guarded transition of a create-request tracking row to
 * `status='failed'`.
 *
 * GUARANTEES:
 *   - Only rows currently in `status = 'processing'` with
 *     `paymentVoucherId IS NULL` are updated.
 *   - Completed rows are NEVER downgraded.
 *   - Idempotent against repeated invocations.
 *   - Catches DB errors and emits a structured WARN event (never propagates).
 *   - Zero rows updated triggers diagnostic SELECT + classification INFO/WARN.
 *
 * Used by the payment-voucher POST handler for:
 *   - idempotency/locking failure path
 *   - accounting-settings unavailability
 *   - balance-insufficiency path
 *   - main-transaction failures that left a reservation row behind.
 *
 * This function is intentionally framework-agnostic (no Express coupling) so
 * tests can invoke it directly without routing scaffolding.
 */
export async function updatePvTrackingFailed(
  r: TrackingDbConn,
  firmId: number,
  userId: number,
  clientRequestId: string,
  error: string,
  stage: string = "unknown",
): Promise<void> {
  try {
    const updated = await r.transaction(async (tx) => {
      await (tx as any).execute(sql.raw(`SET LOCAL lock_timeout = '${PV_CREATE_PRELOCK_TIMEOUT_MS}ms'`));
      return await tx
        .update(paymentVoucherCreateRequestsTable)
        .set({
          status: "failed",
          lastError: String(error ?? "").slice(0, 500),
          updatedAt: new Date(),
        })
        .where(and(
          eq(paymentVoucherCreateRequestsTable.firmId, firmId),
          eq(paymentVoucherCreateRequestsTable.createdByUserId, userId),
          eq(paymentVoucherCreateRequestsTable.clientRequestId, clientRequestId),
          eq(paymentVoucherCreateRequestsTable.status, "processing"),
          isNull(paymentVoucherCreateRequestsTable.paymentVoucherId),
        ))
        .returning({ id: paymentVoucherCreateRequestsTable.id });
    });

    if (updated.length === 0) {
      try {
        const curr = await r
          .select({
            status: paymentVoucherCreateRequestsTable.status,
            paymentVoucherId: paymentVoucherCreateRequestsTable.paymentVoucherId,
            lastError: paymentVoucherCreateRequestsTable.lastError,
          })
          .from(paymentVoucherCreateRequestsTable)
          .where(and(
            eq(paymentVoucherCreateRequestsTable.firmId, firmId),
            eq(paymentVoucherCreateRequestsTable.createdByUserId, userId),
            eq(paymentVoucherCreateRequestsTable.clientRequestId, clientRequestId),
          ))
          .limit(1);
        if (curr.length === 0) {
          logger.warn(
            {
              event: "payment_voucher.tracking_failure_update_failed",
              firmId,
              userId,
              clientRequestId,
              stage,
              reason: "row_not_found",
              code: "TRACKING_MISSING",
            },
            "payment_voucher tracking row missing on failure transition",
          );
        } else {
          const row = curr[0];
          if (row.status === "completed") {
            logger.info(
              {
                event: "payment_voucher.tracking_failure_update_skipped",
                firmId,
                userId,
                clientRequestId,
                stage,
                reason: "completed_preserved",
                paymentVoucherId: row.paymentVoucherId,
              },
              "not downgrading completed tracking to failed",
            );
          } else if (row.status === "failed") {
            // idempotent; no warning
          } else {
            logger.warn(
              {
                event: "payment_voucher.tracking_failure_update_failed",
                firmId,
                userId,
                clientRequestId,
                stage,
                currentStatus: row.status,
                paymentVoucherId: row.paymentVoucherId,
                code: "UNEXPECTED_STATE",
              },
              "unexpected state when attempting failed transition",
            );
          }
        }
      } catch (diagErr: any) {
        logger.warn(
          {
            event: "payment_voucher.tracking_failure_update_failed",
            firmId,
            userId,
            clientRequestId,
            stage,
            sqlstate: String(diagErr?.code ?? ""),
            code: "DIAGNOSTIC_SELECT_FAILED",
          },
          "diagnostic select failed after no tracking update",
        );
      }
    }
  } catch (dbErr: any) {
    logger.warn(
      {
        event: "payment_voucher.tracking_failure_update_failed",
        firmId,
        userId,
        clientRequestId,
        stage,
        sqlstate: String(dbErr?.code ?? ""),
        code: "DB_ERROR",
      },
      "tracking update DB error",
    );
  }
}
