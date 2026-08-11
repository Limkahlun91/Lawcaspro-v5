import { and, eq, isNull, sql } from "drizzle-orm";
import { db, paymentVoucherCreateRequestsTable } from "@workspace/db";
import { logger } from "../../lib/logger.js";

/** Timeout for the single-tracking-row UPDATE (ms). Should be fast. */
export const PV_CREATE_PRELOCK_TIMEOUT_MS = 2_000;

/** Hard statement timeout for the tracking UPDATE transaction (ms). */
export const PV_CREATE_TRACKING_UPDATE_STATEMENT_TIMEOUT_MS = 2_000;

/** Hard statement timeout for the diagnostic SELECT after zero-rows UPDATE (ms). */
export const PV_CREATE_TRACKING_DIAGNOSTIC_TIMEOUT_MS = 2_000;

/** Type for an already-active tx handle: ONLY CRUD + execute, NO .transaction().
 *  Caller is responsible for BEGIN/COMMIT/ROLLBACK.
 */
export type TrackingInTxConn = Pick<
  typeof db,
  "select" | "insert" | "update" | "delete" | "execute"
>;

/** Legacy adapter (still has .transaction for standalone callers that wrap it). */
export type TrackingDbConn = TrackingInTxConn & Pick<typeof db, "transaction">;

/**
 * Pure in-transaction worker.
 *
 * INVARIANT: caller must manage BEGIN/COMMIT/ROLLBACK.
 * THIS FUNCTION MUST NEVER CALL:
 *   - .transaction() / BEGIN / COMMIT / ROLLBACK / SAVEPOINT / RELEASE
 *
 * It is allowed:
 *   - SET LOCAL lock_timeout
 *   - SET LOCAL statement_timeout
 *   - UPDATE tracking row (idempotent guards)
 *   - diagnostic SELECT
 */
export async function updatePvTrackingFailedInTx(
  tx: TrackingInTxConn,
  firmId: number,
  userId: number,
  clientRequestId: string,
  error: string,
  stage: string = "unknown",
): Promise<void> {
  await (tx as any).execute(sql.raw(`SET LOCAL lock_timeout = '${PV_CREATE_PRELOCK_TIMEOUT_MS}ms'`));
  await (tx as any).execute(sql.raw(`SET LOCAL statement_timeout = '${PV_CREATE_TRACKING_UPDATE_STATEMENT_TIMEOUT_MS}ms'`));
  const updated = await tx
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

  if (updated.length === 0) {
    try {
      await (tx as any).execute(sql.raw(`SET LOCAL statement_timeout = '${PV_CREATE_TRACKING_DIAGNOSTIC_TIMEOUT_MS}ms'`));
      const curr = await tx
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
          boundedTimeoutMs: PV_CREATE_TRACKING_DIAGNOSTIC_TIMEOUT_MS,
        },
        "diagnostic select failed after no tracking update",
      );
    }
  }
}

/**
 * Legacy standalone wrapper: acquires exactly one transaction, runs updatePvTrackingFailedInTx,
 * and commits.  Never nests .transaction inside another .transaction.
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
    await r.transaction(async (tx) => {
      await updatePvTrackingFailedInTx(tx, firmId, userId, clientRequestId, error, stage);
    });
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
        boundedLockTimeoutMs: PV_CREATE_PRELOCK_TIMEOUT_MS,
        boundedStatementTimeoutMs: PV_CREATE_TRACKING_UPDATE_STATEMENT_TIMEOUT_MS,
      },
      "tracking update DB error",
    );
  }
}
